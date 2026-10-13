/**
 * data — reference data acquisition.
 *
 * ## Why the detector is downloaded instead of vendored
 *
 * The frozen ranker (`shared_detector.bin`) is 4.1 MB, and 3.5 MB of that is the
 * per-model reference matrix. Committing it would multiply this repository's
 * size several times over for a file that is a published build artifact of an
 * upstream release. It is therefore fetched once on first use, verified against
 * a pinned SHA-256, and cached on disk.
 *
 * The model metadata (display names, families, response counts) is 8.8 KB and
 * ships in `data/bank-meta.json`, so the panel can list the reference bank and
 * report a bank/detector mismatch without any network access at all.
 *
 * ## Why the pin is a commit and not a branch
 *
 * `bank.built_at` and the artifact's `bank_built_at` must match exactly, and the
 * model order is positional. A moving branch reference could hand us a bank from
 * a different release than the metadata we ship, which would not fail loudly —
 * it would silently mislabel every candidate. Pinning the commit makes that
 * mismatch a checksum error instead.
 *
 * @module dsh-fingerprint-probe/lib/data
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeDetector, supportsDetector } from "./detector.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The upstream release this port was verified against.
 *
 * Bumping this requires re-running `node test/test-detector.mjs`, which
 * re-scores real reference samples: a new bank with the same code but a
 * different feature layout would still pass a checksum and fail calibration.
 */
export const UPSTREAM = {
	repo: "Ikaleio/lm-detector",
	commit: "b1a71db35f26c2f8e66dbc63a5aac48893d52462",
	/** sha256 of `data/shared_detector.bin` at that commit. */
	detectorSha256: "2bd3f10427337abc573ff4ce52e9354dd5e8c19b09a9671b24b5c84adef14e8e",
	/** sha256 of `data/unified_bank.json` at that commit, as recorded in the metadata. */
	bankSha256: "6f75bf0cc4d0bfbde8c78047380011fbccd06894832d17bbd2f8325099af8ed4"
};

/**
 * Mirrors, tried in order.
 *
 * jsDelivr is the primary because it is a real CDN with edge caching; raw
 * GitHub is the fallback for networks that cannot reach it.
 */
const MIRRORS = [
	(commit) => `https://cdn.jsdelivr.net/gh/${UPSTREAM.repo}@${commit}/data/shared_detector.bin`,
	(commit) => `https://raw.githubusercontent.com/${UPSTREAM.repo}/${commit}/data/shared_detector.bin`
];

/** Cached under the DSH home so it survives plugin reinstalls. */
function cacheDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "cache", "fingerprint-probe");
}

function detectorPath() {
	return join(cacheDir(), `shared_detector-${UPSTREAM.commit.slice(0, 12)}.bin`);
}

/** Model metadata shipped with the plugin. */
export function loadBankMeta() {
	return JSON.parse(readFileSync(join(HERE, "..", "data", "bank-meta.json"), "utf8"));
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function download(url, timeoutMs) {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * Read the detector bytes, downloading and caching on first use.
 *
 * A cached file is re-verified on every load rather than trusted: the cache
 * lives outside the repository, so a truncated write or a partially-flushed
 * file from an interrupted run must not be able to poison a later detection.
 *
 * @param options - `timeoutMs` per mirror, `onProgress` for byte-level status.
 * @returns the verified raw bytes.
 */
export async function loadDetectorBytes(options = {}) {
	const timeoutMs = options.timeoutMs ?? 120000;
	const path = detectorPath();

	if (existsSync(path)) {
		const cached = new Uint8Array(readFileSync(path));
		if (sha256(cached) === UPSTREAM.detectorSha256) return cached;
		options.onProgress?.(`缓存校验失败，重新下载（${cached.length} 字节）`);
	}

	const failures = [];
	for (const mirror of MIRRORS) {
		const url = mirror(UPSTREAM.commit);
		try {
			options.onProgress?.(`正在下载参考检测器…（${new URL(url).host}）`);
			const bytes = await download(url, timeoutMs);
			const digest = sha256(bytes);
			if (digest !== UPSTREAM.detectorSha256)
				throw new Error(`校验和不匹配：期望 ${UPSTREAM.detectorSha256.slice(0, 12)}…，实得 ${digest.slice(0, 12)}…`);
			mkdirSync(cacheDir(), { recursive: true });
			// Write beside the target and rename, so an interrupted download
			// cannot leave a half-written file at the cache path.
			const temporary = `${path}.${process.pid}.part`;
			writeFileSync(temporary, bytes);
			renameSync(temporary, path);
			return bytes;
		} catch (error) {
			failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(
		`参考检测器下载失败，无法进行指纹检测。已尝试 ${MIRRORS.length} 个镜像：\n${failures.join("\n")}\n` +
			`可手动下载 ${MIRRORS[0](UPSTREAM.commit)} 并放到 ${path}`
	);
}

/**
 * Load and decode the detector, then check it belongs to the shipped metadata.
 *
 * The binding check runs here rather than at analysis time so a mismatched
 * release surfaces as a startup error naming both build stamps, instead of as a
 * confident-looking wrong answer later.
 *
 * @param options - passed through to {@link loadDetectorBytes}.
 * @returns `{detector, bank, upstream}`.
 */
export async function loadReference(options = {}) {
	const bank = loadBankMeta();
	const bytes = await loadDetectorBytes(options);
	const detector = decodeDetector(bytes);
	if (!supportsDetector(bank, detector))
		throw new Error(
			`参考库与检测器版本不一致：bank.built_at=${bank.built_at}，detector.bank_built_at=${detector.bank_built_at}。` +
				`请更新插件或清除缓存 ${detectorPath()}`
		);
	return { detector, bank, upstream: UPSTREAM };
}

/** Whether a verified detector is already cached, so the panel can say so up front. */
export function cacheStatus() {
	const path = detectorPath();
	if (!existsSync(path)) return { cached: false, path, bytes: 0 };
	const bytes = new Uint8Array(readFileSync(path));
	return { cached: sha256(bytes) === UPSTREAM.detectorSha256, path, bytes: bytes.length };
}

export { detectorPath, sha256 };
