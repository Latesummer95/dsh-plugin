/**
 * detector — the frozen ranker: decode, rank, calibrate.
 *
 * Ported from `shared/detector-codec.ts` and `shared/shared-detector.ts` of
 * Ikaleio/lm-detector (MIT). The reference bank is fitted offline in Python and
 * shipped as a frozen binary; this module only replays it, so the maths must
 * stay bit-compatible with the export. The calibration test re-scores real
 * reference samples and asserts they land on their own model, which is what
 * makes a silent porting error visible instead of merely plausible.
 *
 * @module dsh-fingerprint-probe/lib/detector
 */

import { countNumbers, hellingerFeature, orderedBlockFeature, parseNumbers } from "./fingerprint-core.js";
import { positionalDecision } from "./positional.js";

// Re-exported so callers can parse a reply without reaching into the feature
// module; the two are always used together.
export { parseNumbers };

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const mean = (a) => a.reduce((sum, x) => sum + x, 0) / a.length;
const norm = (a) => {
	const n = Math.max(Math.sqrt(dot(a, a)), 1e-12);
	return a.map((x) => x / n);
};
const z = (a) => {
	const m = mean(a);
	const s = Math.max(Math.sqrt(mean(a.map((x) => (x - m) ** 2))), 1e-12);
	return a.map((x) => (x - m) / s);
};
const columnMean = (a) => a[0].map((_, i) => mean(a.map((r) => r[i])));
const median = (a) => {
	const v = [...a].sort((x, y) => x - y);
	const i = Math.floor(v.length / 2);
	return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
const blocks = (n) => [hellingerFeature(countNumbers(n)), orderedBlockFeature(n)];
const transform = (b, p) =>
	b.flatMap((v, j) =>
		norm(v.map((x, i) => (x - p[j].mean[i]) / p[j].scale[i])).map((x) => x * Math.sqrt(j === 0 ? 0.75 : 0.25))
	);
const centered = (v, p) => v.map((x, i) => (x - p.feature_mean[i]) / p.feature_scale[i]);
const subtract = (v, b) => {
	const coefficients = b.map((row) => dot(v, row));
	return v.map((x, i) => x - b.reduce((sum, row, j) => sum + coefficients[j] * row[i], 0));
};

/** Squared-distance norms are cached per reference matrix; ranking walks them repeatedly. */
const referenceNorms = new WeakMap();

function nearest(x, references) {
	let norms = referenceNorms.get(references);
	if (!norms) {
		norms = references.map((r) => dot(r, r));
		referenceNorms.set(references, norms);
	}
	const xx = dot(x, x);
	return mean(
		references
			.map((r, i) => Math.max(0, xx + norms[i] - 2 * dot(x, r)))
			.sort((a, b) => a - b)
			.slice(0, 7)
	);
}

function baseline(b, bank) {
	const h = bank.hellinger;
	const o = bank.ordered_blocks;
	const hUnit = norm(subtract(centered(b[0], h), h.nuisance_basis));
	const marginal = h.centroids.map((row) => dot(hUnit, row));
	const oCentered = centered(b[1], o);
	const raw = norm(oCentered);
	const projected = norm(subtract(oCentered, o.nuisance_basis));
	const templates = o.centroids.map((_, i) => Math.max(...o.environment_centroids.map((rows) => dot(raw, rows[i]))));
	const nuisance = o.centroids.map((row) => dot(projected, row));
	const tz = z(templates);
	const nz = z(nuisance);
	const ordered = z(tz.map((v, i) => 0.5 * v + 0.5 * nz[i]));
	const mz = z(marginal);
	return mz.map((v, i) => 0.5 * v + 0.5 * ordered[i]);
}

/**
 * Decode `shared_detector.bin`.
 *
 * Layout: a little-endian u32 header length, the UTF-8 JSON header padded to a
 * 4-byte boundary, then float32 values grouped byte-plane by byte-plane (all
 * first bytes, then all second bytes, ...). The grouping exists purely so the
 * file compresses; it has to be undone before the floats mean anything.
 *
 * @param data - the raw file bytes.
 * @returns the decoded detector artifact.
 */
export function decodeDetector(data) {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const headerLength = view.getUint32(0, true);
	const start = Math.ceil((4 + headerLength) / 4) * 4;
	const count = (data.length - start) / 4;
	const raw = new Uint8Array(count * 4);
	for (let i = 0; i < count; i++) for (let b = 0; b < 4; b++) raw[i * 4 + b] = data[start + b * count + i];
	const little = new DataView(raw.buffer);
	const floats = new Float32Array(count);
	for (let i = 0; i < count; i++) floats[i] = little.getFloat32(i * 4, true);
	return JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLength)), (_, value) =>
		value && typeof value === "object" && "$f32" in value
			? Array.from(floats.subarray(value.$f32, value.$f32 + value.n))
			: value
	);
}

/**
 * Whether a bank belongs to a detector.
 *
 * The bank's build stamp, model order and per-model response counts are all
 * bound into the artifact; a mismatch means the centroids and the identities no
 * longer line up, and any verdict would be fiction.
 *
 * @param bank - the bank metadata.
 * @param artifact - the decoded detector.
 * @returns true when the two are the same release.
 */
export function supportsDetector(bank, artifact) {
	return (
		artifact.schema === "shared-detector-v2" &&
		bank.built_at === artifact.bank_built_at &&
		bank.models.length === artifact.model_ids.length &&
		bank.models.every((m, i) => m.id === artifact.model_ids[i] && m.response_count === artifact.response_counts[i])
	);
}

/**
 * Closed-set probabilities from the calibration bound to this ranker.
 *
 * A temperature softmax over the ranking scores. It is a relative share among
 * the reference models only: an out-of-bank model still receives one, so this is
 * not a probability that the identity claim is true.
 *
 * @param ranking - per-model ranking scores.
 * @param artifact - the decoded detector.
 * @returns probabilities, or null when no calibration matches this ranker.
 */
export function calibrateRanking(ranking, artifact) {
	const head = artifact.calibration;
	const binding = head?.binding;
	if (
		!head ||
		!binding ||
		head.schema !== "shared-confidence-v2" ||
		head.method !== "ranking-temperature" ||
		!Number.isFinite(head.tau) ||
		head.tau < 0.001 ||
		head.tau > 1000 ||
		binding.base_sha256 !== artifact.base_sha256 ||
		binding.reference_sha256 !== artifact.source_reference_sha256 ||
		binding.model_ids.length !== ranking.length ||
		ranking.length !== artifact.model_ids.length ||
		!ranking.every(Number.isFinite) ||
		!binding.model_ids.every((id, i) => id === artifact.model_ids[i])
	)
		return null;
	const logits = ranking.map((score) => head.tau * score);
	const maximum = Math.max(...logits);
	const weights = logits.map((value) => Math.exp(value - maximum));
	const sum = weights.reduce((a, b) => a + b, 0);
	return weights.map((value) => value / sum);
}

function rankNumbers(numbers, artifact) {
	const a = artifact.ranker;
	const full = numbers.map(blocks);
	const ax = full.map((b) => transform(b, a.full_params));
	const lda = numbers.map((n) => {
		const x = transform(blocks(n.slice(0, 128)), a.head_params);
		return z(a.lda_weights.map((row, i) => dot(row, x) + a.lda_bias[i]));
	});
	const l = z(columnMean(lda));
	const near = z(a.references.map((ref) => median(ax.map((x) => -nearest(x, ref)))));
	const base = z(columnMean(full.map((b) => baseline(b, a.bank))));
	const frequency = z(l.map((x, i) => 0.5 * x + 0.25 * near[i] + 0.25 * base[i]));
	const positional = z(columnMean(numbers.map((n) => z(positionalDecision(n, a.positional)))));
	const ranking = frequency.map((x, i) => a.blend.frequency * x + a.blend.positional * positional[i]);
	if (!ranking.every(Number.isFinite)) throw new Error("排名计算产生无效数值");
	return ranking;
}

/** The three-answer requirement is the detector's own rule, not a UI preference. */
export const REQUIRED_OUTPUTS = 3;

/**
 * Score a detection's answers against the reference bank.
 *
 * Three valid answers are required for a full verdict. Fewer yields an explicit
 * `unscorable`/`partial` decision rather than a confident-looking guess, because
 * the calibrated confidence is only defined for the complete case.
 *
 * @param outputs - one `{text, expected_count}` per challenge.
 * @param bank - the bank metadata.
 * @param artifact - the decoded detector.
 * @param options - `allowPartial` returns a ranking from 1–2 valid answers.
 * @returns the analysis result.
 */
export function analyzeOutputs(outputs, bank, artifact, options = {}) {
	if (!supportsDetector(bank, artifact))
		throw new Error("参考库与检测器不匹配：bank.built_at / 模型顺序与 detector 不一致。");

	const parsed = outputs.map((o) => parseNumbers(o.text));
	const diagnostics = outputs.map((o, index) => {
		const minimum = Math.max(80, Math.ceil((o.expected_count || 0) * 0.55));
		const raw = Array.from(String(o.text).matchAll(/-?\d+/g), (m) => Number(m[0]));
		return {
			index,
			parsed_numbers: parsed[index].length,
			minimum_numbers: minimum,
			accepted: parsed[index].length >= minimum,
			raw_out_of_range_count: raw.filter((n) => n < 1 || n > 355).length
		};
	});
	const used = diagnostics.filter((d) => d.accepted).length;
	const common = {
		probability: null,
		probability_status: "unavailable",
		used_outputs: used,
		diagnostics,
		method: "shared-detector-v2",
		model_version: { base_sha256: artifact.base_sha256 }
	};

	if (options.allowPartial && used > 0 && used < REQUIRED_OUTPUTS && outputs.length <= REQUIRED_OUTPUTS) {
		const ranking = rankNumbers(
			parsed.filter((_, i) => diagnostics[i].accepted),
			artifact
		);
		const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
		const results = order.map((i) => ({
			model: artifact.model_ids[i],
			display_name: bank.models[i].display_name,
			family: bank.models[i].family,
			family_name: bank.models[i].family_name,
			score: ranking[i],
			probability: null
		}));
		const first = order[0];
		return {
			...common,
			method: "shared-ranker-partial-v1",
			decision: "partial",
			prediction: results[0].model,
			prediction_name: results[0].display_name,
			family_prediction: bank.models[first].family,
			family_prediction_name: bank.models[first].family_name,
			results,
			ranking_score: ranking[first],
			calibration: null,
			evidence: {
				insufficient: true,
				label: "部分样本排名",
				reason: `使用 ${used}/${REQUIRED_OUTPUTS} 条有效回答生成排名。补齐三条有效回答后才能计算置信度。`,
				threshold: null,
				method: "partial-sample-ranking"
			}
		};
	}

	if (outputs.length !== REQUIRED_OUTPUTS || used !== REQUIRED_OUTPUTS)
		return {
			...common,
			prediction: "",
			prediction_name: "暂不可评分",
			family_prediction_name: "",
			results: [],
			decision: "unscorable",
			evidence: {
				insufficient: true,
				label: "需要三条完整回答",
				reason: `当前有 ${used}/${outputs.length} 条有效回答。请补齐原来的三条回答后重新检测。`,
				threshold: null,
				method: "complete-three-answers"
			}
		};

	const ranking = rankNumbers(parsed, artifact);
	const probabilities = calibrateRanking(ranking, artifact);
	const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
	const results = order.map((i) => ({
		model: artifact.model_ids[i],
		display_name: bank.models[i].display_name,
		family: bank.models[i].family,
		family_name: bank.models[i].family_name,
		score: ranking[i],
		probability: probabilities?.[i] ?? null
	}));
	const first = order[0];
	return {
		...common,
		prediction: results[0].model,
		prediction_name: results[0].display_name,
		family_prediction: bank.models[first].family,
		family_prediction_name: bank.models[first].family_name,
		results,
		ranking_score: ranking[first],
		probability: results[0].probability,
		probability_status: probabilities ? "reference_calibrated" : "unavailable",
		probability_scope: probabilities ? "reference-closed-set" : null,
		calibration: probabilities
			? {
					method: artifact.calibration.method,
					run: artifact.calibration.calibration_run,
					tau: artifact.calibration.tau,
					sha256: artifact.calibration_sha256 ?? null
				}
			: null,
		evidence: {
			insufficient: false,
			label: probabilities ? "库内校准排名" : "未校准排名",
			reason: probabilities
				? "置信度是参考库内的闭集相对概率，不包含库外模型。"
				: "校准参数与当前检测器不匹配，置信度不可用。候选顺序由排名分数决定。",
			threshold: null,
			method: probabilities ? "reference-calibrated-ranking" : "uncalibrated-ranking"
		}
	};
}
