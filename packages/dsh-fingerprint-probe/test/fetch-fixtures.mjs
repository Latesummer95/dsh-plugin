/**
 * Fixture fetcher.
 *
 * The calibration check in `test-detector.mjs` needs the upstream reference
 * answers (16 MB) to prove that the ported ranker still identifies each model
 * from its own answers. That file is far too large to keep in this repository,
 * so it is fetched on demand, verified against a pinned checksum, and cached in
 * `test/fixtures/` — which `.gitignore` excludes.
 *
 * The detector binary is fetched by the plugin itself at first use; this script
 * warms that cache too so a fresh clone can run the whole suite offline
 * afterwards.
 *
 * Run: node test/fetch-fixtures.mjs
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UPSTREAM } from "../lib/data.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/** `data/unified_reference.jsonl` at the pinned commit, with its digest. */
const REFERENCE = {
	file: join(FIXTURES, "unified_reference.jsonl"),
	url: `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.commit}/data/unified_reference.jsonl`,
	sha256: "47c1dc1ba7977226ad86619ad382177d54122040a3b2f7e5fda21ea47b9fcc7e"
};

async function fetchVerified(url, path, expected, label) {
	if (existsSync(path)) {
		const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
		if (digest === expected) {
			console.log(`  ✓ ${label} 已缓存且校验通过`);
			return;
		}
		console.log(`  ! ${label} 缓存校验失败，重新下载`);
	}
	console.log(`  ↓ ${label} …`);
	const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300000) });
	if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== expected)
		throw new Error(
			`${label}: 校验和不匹配\n  期望 ${expected}\n  实得 ${digest}\n` +
				`上游数据可能已更新；请核对 lib/data.js 中的 UPSTREAM 固定版本。`
		);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.part`;
	writeFileSync(temporary, bytes);
	renameSync(temporary, path);
	console.log(`  ✓ ${label}（${(bytes.length / 1024 / 1024).toFixed(1)} MB）`);
}

console.log("获取测试夹具");
await fetchVerified(REFERENCE.url, REFERENCE.file, REFERENCE.sha256, "参考回答 unified_reference.jsonl");

// Warm the plugin's own detector cache so the suite runs offline afterwards.
const home = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
const detector = join(home, "cache", "fingerprint-probe", `shared_detector-${UPSTREAM.commit.slice(0, 12)}.bin`);
const { loadDetectorBytes } = await import("../lib/data.js");
await loadDetectorBytes({ onProgress: (message) => console.log(`  · ${message}`) });
console.log(`  ✓ 参考检测器（${existsSync(detector) ? detector : "已加载"}）`);

console.log("\n夹具就绪，现在可以运行：node test/test-detector.mjs");
