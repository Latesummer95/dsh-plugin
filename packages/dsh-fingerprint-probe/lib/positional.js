/**
 * positional — the sequence/order decision head.
 *
 * Ported from `shared/positional.ts` of Ikaleio/lm-detector (MIT). Block order,
 * weights and the RBF centres must match the exported parameters exactly, or the
 * frozen head's weights apply to a different feature space and the ranking turns
 * into noise. `test/test-detector.mjs` guards that by checking real samples.
 *
 * @module dsh-fingerprint-probe/lib/positional
 */

import { countNumbers, hellingerFeature, orderedBlockFeature } from "./fingerprint-core.js";

/** Per-block weights; the export's `weights` rows are sized against these. */
const WEIGHTS = [0.6, 0.15, 0.125, 0.125];
/** 24 RBF centres spread over the value range. */
const CENTRES = Array.from({ length: 24 }, (_, i) => 1 + (i * 354) / 23);
/** Lags used by the serial-correlation block. */
const LAGS = [1, 2, 3, 5, 8, 13, 21, 34];

const mean = (values) => values.reduce((sum, x) => sum + x, 0) / values.length;

function fraction(length, test) {
	let hits = 0;
	for (let i = 0; i < length; i++) if (test(i)) hits++;
	return hits / length;
}

function positionKernel(x) {
	const n = x.length;
	const out = Array(34 * 3).fill(0);
	x.forEach((value, position) => {
		const t = ((position + 0.5) * 2) / n - 1;
		const basis = [t, 0.5 * (3 * t * t - 1), 0.5 * (5 * t ** 3 - 3 * t)];
		const features = [
			...CENTRES.map((centre) => Math.exp(-0.5 * ((value - centre) / 20) ** 2)),
			...Array.from({ length: 10 }, (_, digit) => (digit === value % 10 ? 1 : 0))
		];
		features.forEach((weight, k) =>
			basis.forEach((b, j) => {
				out[k * 3 + j] += (weight * b) / n;
			})
		);
	});
	return out;
}

function centredTransitions(symbols, bins) {
	const joint = Array(bins * bins).fill(0.5);
	const total = symbols.length - 1 + 0.5 * bins * bins;
	for (let i = 1; i < symbols.length; i++) joint[symbols[i - 1] * bins + symbols[i]] += 1;
	for (let i = 0; i < joint.length; i++) joint[i] /= total;
	const rows = Array.from({ length: bins }, (_, a) => joint.slice(a * bins, a * bins + bins).reduce((s, v) => s + v, 0));
	const columns = Array.from({ length: bins }, (_, b) => rows.reduce((s, _, a) => s + joint[a * bins + b], 0));
	return joint.map((value, i) => value - rows[Math.floor(i / bins)] * columns[i % bins]);
}

function sequenceFeatures(x) {
	const n = x.length;
	const m = mean(x);
	const sd = Math.max(Math.sqrt(mean(x.map((v) => (v - m) ** 2))), 1);
	const s = x.map((v) => (v - m) / sd);
	const out = [];
	for (const lag of LAGS) {
		const count = n - lag;
		const d = Array.from({ length: count }, (_, i) => x[i + lag] - x[i]);
		out.push(
			mean(d.map((_, i) => s[i + lag] * s[i])),
			mean(d.map(Math.abs)) / 355,
			fraction(count, (i) => d[i] > 0),
			fraction(count, (i) => d[i] === 0),
			fraction(count, (i) => Math.abs(d[i]) <= 5),
			fraction(count, (i) => Math.abs(d[i]) <= 20)
		);
	}
	out.push(...centredTransitions(x.map((v) => Math.min(7, Math.floor(((v - 1) * 8) / 355))), 8));
	out.push(...centredTransitions(x.map((v) => v % 10), 10));
	const difference = Array.from({ length: n - 1 }, (_, i) => x[i + 1] - x[i]);
	const zStep = Array.from({ length: n - 1 }, (_, i) => Math.abs(s[i + 1] - s[i]));
	out.push(
		fraction(n - 2, (i) => Math.sign(difference[i + 1]) === Math.sign(difference[i])),
		fraction(n - 2, (i) => difference[i + 1] === difference[i]),
		fraction(n - 1, (i) => x[i] % 10 === x[i + 1] % 10),
		fraction(n - 1, (i) => zStep[i] > 1),
		fraction(n - 1, (i) => zStep[i] > 2)
	);
	const buckets = x.map((v) => Math.min(15, Math.floor(((v - 1) * 16) / 355)));
	for (const width of [4, 8, 16]) {
		let sum = 0;
		for (let i = 0; i + width <= n; i++) sum += new Set(buckets.slice(i, i + width)).size / width;
		out.push(sum / (n - width + 1));
	}
	return out;
}

/**
 * Per-answer decision values over identities.
 *
 * @param numbers - parsed values of one answer.
 * @param head - the detector's `ranker.positional` subtree.
 * @returns one decision value per model.
 */
export function positionalDecision(numbers, head) {
	const parts = [
		hellingerFeature(countNumbers(numbers)),
		orderedBlockFeature(numbers),
		positionKernel(numbers),
		sequenceFeatures(numbers)
	];
	const x = parts.flatMap((block, j) => {
		const p = head.params[j];
		const scaled = block.map((v, i) => (v - p.mean[i]) / p.scale[i]);
		const length = Math.max(
			Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0)),
			1e-12
		);
		return scaled.map((v) => (v / length) * Math.sqrt(WEIGHTS[j]));
	});
	return head.weights.map((row, k) => row.reduce((sum, w, i) => sum + w * x[i], head.bias[k]));
}
