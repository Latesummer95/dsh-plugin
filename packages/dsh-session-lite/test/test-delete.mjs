/**
 * Tests for the session-lite host half.
 *
 * The delete route is the only place this plugin touches the filesystem
 * destructively, so these tests are written against the *refusals* as much as the
 * successes: a route that deletes the right session but also deletes a directory
 * outside the sessions tree is worse than one that does nothing.
 *
 * Everything runs against a temporary sessions root, so no real conversation is
 * ever at risk.
 *
 * Run with `node test/test-delete.mjs`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSessionDirectory } from "../lib/session-files.js";
import {
	MAX_BODY_BYTES,
	createMutateQueue,
	createStore,
	deleteSession,
	originRejection,
	readJsonBody,
	sessionDirOf
} from "../index.js";

let passed = 0;
let failed = 0;

async function test(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  ✗ ${label}`);
		console.log(`      ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Build a throwaway sessions tree that mirrors the real layout:
 * `<root>/<encoded-project>/<session-id>/<artifact>`.
 *
 * The artifact is written as `session.jsonl`, the plaintext candidate name, rather
 * than the `session.v4.jsonl.zstd` a real profile uses. `readSessionHeader` treats
 * a `.zstd` name as a promise: it scans for a frame and never falls back to reading
 * the text, so a plaintext file with that name is correctly rejected as a torn
 * frame — which is a property worth having, and not what these tests are about.
 * The real compressed path was verified separately against an actual conversation.
 *
 * @param id - the session id to create.
 * @param options - `project` names the middle level.
 * @returns the root and the created directory.
 */
function makeTree(id, { project = "--proj--" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "session-lite-"));
	const dir = join(root, project, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "session.jsonl"),
		`${JSON.stringify({ id, version: 4 })}\n{"type":"message"}\n`
	);
	return { root, dir };
}

/** A store whose only real dependency is the temporary root. */
function makeStore(root, overrides = {}) {
	const emitted = [];
	const detached = [];
	const store = {
		...createStore({
			dshHomePath: (kind) => {
				assert.equal(kind, "sessions");
				return root;
			},
			emit: (event, payload) => emitted.push([event, payload]),
			...overrides.ctx
		}),
		emitted,
		detached
	};
	return store;
}

console.log("目录发现");

await test("finds a session's directory by its own header", async () => {
	const id = "11111111-2222-3333-4444-555555555555";
	const { root, dir } = makeTree(id);
	const store = makeStore(root);
	assert.equal(await sessionDirOf(store, id), dir);
	rmSync(root, { recursive: true, force: true });
});

await test("a directory whose name matches but whose header does not is refused", async () => {
	// The attack this blocks: point the route at any directory by naming it after
	// the id, and have the plugin delete it because the name matched.
	const root = mkdtempSync(join(tmpdir(), "session-lite-"));
	const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const dir = join(root, "--proj--", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.v4.jsonl.zstd"), `${JSON.stringify({ id: "someone-else" })}\n`);
	const store = makeStore(root);
	assert.equal(await sessionDirOf(store, id), undefined, "header 不匹配就不能当成目标");
	rmSync(root, { recursive: true, force: true });
});

await test("a missing sessions root is not an error", async () => {
	const root = join(tmpdir(), "session-lite-does-not-exist-xyz");
	const store = makeStore(root);
	assert.equal(await sessionDirOf(store, "no-such-id"), undefined);
});

console.log("删除");

await test("deletes the artifact directory", async () => {
	const id = "22222222-3333-4444-5555-666666666666";
	const { root, dir } = makeTree(id);
	const store = makeStore(root);
	const result = await deleteSession({ logger: { warn: () => {} } }, store, id);
	assert.equal(result.ok, true);
	assert.equal(result.filesRemoved, true);
	assert.equal(existsSync(dir), false, "目录必须被删掉");
	rmSync(root, { recursive: true, force: true });
});

await test("a session with no artifact still reports success", async () => {
	// Deleting a session whose files never materialised is not a failure; the
	// caller asked for it to be gone, and it is.
	const root = mkdtempSync(join(tmpdir(), "session-lite-"));
	const store = makeStore(root);
	const result = await deleteSession({ logger: { warn: () => {} } }, store, "ghost-session");
	assert.equal(result.ok, true);
	assert.equal(result.filesRemoved, false);
	rmSync(root, { recursive: true, force: true });
});

await test("an invalid session id is refused before anything is touched", async () => {
	const store = makeStore("/tmp/unused");
	for (const bad of ["../escape", "a/b", "..", "", "trailing."]) {
		await assert.rejects(
			() => deleteSession({ logger: { warn: () => {} } }, store, bad),
			/sessionId|会话标识/,
			`必须拒绝 ${JSON.stringify(bad)}`
		);
	}
});

await test("a symlinked project level cannot redirect the delete", async () => {
	// The escape this blocks: make `<root>/<project>` a symlink to somewhere else,
	// so a recursive delete of `<root>/<project>/<id>` removes files outside the
	// sessions tree entirely. Two independent defences are checked: discovery skips
	// a linked level, and the validator refuses one outright.
	const outside = mkdtempSync(join(tmpdir(), "session-lite-outside-"));
	const victim = join(outside, "victim");
	mkdirSync(victim, { recursive: true });
	writeFileSync(join(victim, "precious.txt"), "do not delete");

	const root = mkdtempSync(join(tmpdir(), "session-lite-"));
	const id = "33333333-4444-5555-6666-777777777777";
	// The artifact is only reachable through the link, so a naive walk would find
	// it and delete `outside/<id>`.
	const throughLink = join(outside, id);
	mkdirSync(throughLink, { recursive: true });
	writeFileSync(join(throughLink, "session.jsonl"), `${JSON.stringify({ id })}\n`);
	symlinkSync(outside, join(root, "--linked--"));

	const store = makeStore(root);
	assert.equal(await sessionDirOf(store, id), undefined, "符号链接层不应被当作项目目录");

	// The validator is the second line of defence: even handed the forged path
	// directly, it must refuse rather than delete.
	await assert.rejects(
		() => assertSessionDirectory(root, join(root, "--linked--", id), id),
		/符号链接|允许范围/,
		"经过符号链接的目录必须被拒绝"
	);

	// And the route, taking the same input, must leave the world untouched.
	const result = await deleteSession({ logger: { warn: () => {} } }, store, id);
	assert.equal(result.filesRemoved, false, "不能报告删掉了任何东西");
	assert.equal(existsSync(join(victim, "precious.txt")), true, "树外文件必须完好");
	assert.equal(existsSync(join(throughLink, "session.jsonl")), true, "树外会话文件必须完好");

	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

await test("deleting a live session cancels the agent and detaches the store", async () => {
	const id = "44444444-5555-6666-7777-888888888888";
	const { root, dir } = makeTree(id);
	const cancelled = [];
	const dropped = [];
	let flushed = false;
	let disposed = false;
	const session = { id };
	const store = makeStore(root, {
		ctx: {
			sessions: {
				get: () => session,
				flush: async () => { flushed = true; },
				store: { get: () => ({ detach: () => dropped.push(id) }) }
			},
			agents: {
				get: () => ({
					cancel: (options) => cancelled.push(options),
					scope: { dispose: async () => { disposed = true; } }
				}),
				store: { delete: () => dropped.push(`agent:${id}`) }
			}
		}
	});
	const result = await deleteSession({ logger: { warn: () => {} } }, store, id);
	assert.deepEqual(cancelled, [{ kind: "disposed" }], "必须用 disposed 取消，避免会话被唤醒");
	assert.equal(disposed, true);
	assert.equal(flushed, true, "先 flush，否则退役 drain 会把文件写回来");
	// Agent first (cancel, dispose, drop), then the store entry — the teardown
	// order matters: a live agent would otherwise keep writing to a session the
	// store has already stopped tracking.
	assert.deepEqual(dropped, [`agent:${id}`, id]);
	assert.equal(result.wasLive, true);
	assert.equal(existsSync(dir), false);
	rmSync(root, { recursive: true, force: true });
});

await test("a session with no live row still notifies connected clients", async () => {
	// Without this the row survives on every other client until a full reload,
	// because there is no store entry whose detach could emit the event.
	const id = "55555555-6666-7777-8888-999999999999";
	const { root } = makeTree(id);
	const store = makeStore(root);
	await deleteSession({ logger: { warn: () => {} } }, store, id);
	assert.deepEqual(store.emitted, [["session/disposed", { id }]]);
	rmSync(root, { recursive: true, force: true });
});

console.log("请求处理");

await test("a body over the cap is refused with 413", async () => {
	const big = { sessionId: "x".repeat(MAX_BODY_BYTES + 10) };
	async function* body() {
		yield Buffer.from(JSON.stringify(big));
	}
	await assert.rejects(
		() => readJsonBody(body()),
		(error) => error.status === 413,
		"超大请求体必须被拒绝，而不是被截断后继续"
	);
});

await test("malformed JSON is a 400, not a crash", async () => {
	async function* body() {
		yield Buffer.from("{not json");
	}
	await assert.rejects(
		() => readJsonBody(body()),
		(error) => error.status === 400
	);
});

await test("an empty body parses as an empty object", async () => {
	async function* body() {
		yield Buffer.from("   ");
	}
	assert.deepEqual(await readJsonBody(body()), {});
});

await test("a cross-origin request is refused, a local one is allowed", async () => {
	// `no-cors` and plain form posts skip preflight, so origin is the only thing
	// standing between a hostile page and a deleted session.
	assert.equal(originRejection({ headers: { origin: "https://evil.example" } }, 3080), 403);
	assert.equal(originRejection({ headers: { origin: "null" } }, 3080), 403);
	assert.equal(originRejection({ headers: { origin: "http://127.0.0.1:3080" } }, 3080), undefined);
	assert.equal(originRejection({ headers: { origin: "http://localhost:3080" } }, 3080), undefined);
	assert.equal(originRejection({ headers: { origin: "http://127.0.0.1:9999" } }, 3080), 403);
	// No Origin at all: a non-browser caller, which is not the threat model.
	assert.equal(originRejection({ headers: {} }, 3080), undefined);
});

await test("mutations for one id are serialised, different ids are not", async () => {
	// A double-clicked confirm button must not race two `rm -rf`s, and the loser
	// must not report a failure for a delete that actually succeeded.
	const mutate = createMutateQueue();
	const order = [];
	const slow = async () => {
		order.push("slow:start");
		await new Promise((resolve) => setTimeout(resolve, 30));
		order.push("slow:end");
	};
	const fast = async () => {
		order.push("fast:start");
		order.push("fast:end");
	};
	const other = async () => {
		order.push("other");
	};
	await Promise.all([
		mutate("same", slow),
		mutate("same", fast),
		mutate("different", other)
	]);
	assert.deepEqual(
		order.filter((entry) => entry.startsWith("slow") || entry.startsWith("fast")),
		["slow:start", "slow:end", "fast:start", "fast:end"],
		"同一 id 必须串行"
	);
	// The unrelated id must not have waited for the slow one.
	assert.ok(order.indexOf("other") < order.indexOf("slow:end"), "不同 id 不应互相阻塞");
});

await test("a rejected mutation does not wedge the queue for that id", async () => {
	const mutate = createMutateQueue();
	await assert.rejects(() => mutate("x", async () => { throw new Error("boom"); }), /boom/);
	// The next call must still run — otherwise one failed delete locks that id out.
	assert.equal(await mutate("x", async () => "ran"), "ran");
});

console.log("");
if (failed > 0) {
	console.log(`✗ ${failed} 项失败，${passed} 项通过`);
	process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过`);
