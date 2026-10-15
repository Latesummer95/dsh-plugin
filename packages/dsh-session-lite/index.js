/**
 * dsh-session-lite — session housekeeping that does not take over the title bar.
 *
 * ## Why this exists
 *
 * The full `dsh-session-manager` grew into a second application: annotations, AI
 * organisation, batch operations, preset migration, session moving, an update
 * checker, and a settings card. It also mounted six controls plus an overflow menu
 * into `conversation.session.header.actions`, the row that holds the conversation
 * title, so the plugin's footprint sat on top of the workspace name in every
 * conversation the user opened.
 *
 * Most of what it needed, DSH already ships. Archive, unarchive, open, rename and
 * workspace grouping are all methods on the client's `uiWorkspace` and
 * `workspaces` services, and the sidebar already renders its own archive and
 * unarchive controls. Calling those directly removes the need for eight private
 * API dependencies, a compatibility shim, and the title-bar takeover.
 *
 * What genuinely has no DSH equivalent is **deleting** a session: removing the
 * artifact from disk, tearing down a live agent, and dropping the row from every
 * connected client's store. That is all this host half does. Everything the user
 * sees is `client.js`, which renders one sidebar-footer button and a modal.
 *
 * ## The delete sequence, and why each step is there
 *
 * Deleting a session touches four separate pieces of state that can disagree:
 * the on-disk artifact, the in-memory session store, the agent that may be
 * running, and the workspace/archive bookkeeping. The order below resolves and
 * validates the target *before* mutating anything, so a bad request cannot leave
 * a half-deleted session behind, and it re-resolves the directory *after*
 * teardown, because a blank session can materialise its first artifact while the
 * teardown is flushing.
 *
 * @module dsh-session-lite
 */

import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	ARTIFACT_NAMES,
	assertSessionDirectory,
	assertSessionId,
	readSessionHeader
} from "./lib/session-files.js";

/** Host plugin name, as referenced by the profile patch. */
export const name = "session-lite";

/**
 * `webServer` serves the one route; `sessions`, `agents` and `workspaceRegistry`
 * are read during teardown; `dshHomePath` locates the artifact root. The store
 * services are optional and probed at call time — a host build that lacks one
 * should still be able to delete a session that has nothing live attached.
 */
export const inject = ["webServer", "sessions", "agents", "workspaceRegistry", "dshHomePath"];

/** Route prefix. Distinct from `dsh-session-manager`'s, so both can coexist. */
export const ROUTE_PREFIX = "/session-lite";

/** Largest request body accepted, in bytes. A session id needs nowhere near this. */
export const MAX_BODY_BYTES = 64 * 1024;

/** How long a torn-down agent's fiber gets to unwind before the delete continues. */
const DISPOSE_BUDGET_MS = 3000;

/** How long the write-behind retirement is given to settle after a detach. */
const RETIRE_SETTLE_MS = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Refuse a request whose `Origin` is not this host.
 *
 * The route takes a `POST` with a JSON body, so a cross-origin page cannot read
 * the response without a preflight — but it can still *send* the request, because
 * `fetch(..., {mode: "no-cors"})` and a plain HTML form are both "simple" and skip
 * preflight entirely. The side effect is a deleted session. Rejecting a mismatched
 * origin closes that, and costs nothing: the panel is same-origin by construction.
 *
 * A missing `Origin` is allowed. Non-browser callers (curl, a test harness) do not
 * send one, and they are not the threat this guards against — an attacker's page
 * always sends one, and it will not be this host's.
 *
 * @param req - the incoming request.
 * @param port - the listening port, used to build the expected origins.
 * @returns the rejection status, or `undefined` to proceed.
 */
export function originRejection(req, port) {
	const origin = req.headers?.origin;
	if (origin === undefined || origin === null || origin === "") return undefined;
	if (origin === "null") return 403;
	const allowed = new Set([
		`http://127.0.0.1:${port}`,
		`http://localhost:${port}`,
		`http://[::1]:${port}`
	]);
	return allowed.has(origin) ? undefined : 403;
}

/**
 * Read and parse a JSON body, refusing anything larger than {@link MAX_BODY_BYTES}.
 *
 * The size check runs on the accumulated length rather than a `Content-Length`
 * header, because that header is attacker-controlled and absent on a chunked
 * request. Going over budget destroys the socket: draining a body that has already
 * been rejected only wastes memory, and a caller that keeps sending is not one
 * whose next request is worth reading.
 *
 * @param req - the incoming request.
 * @returns the parsed body, or an error carrying a `status`.
 */
export async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			const error = new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`);
			error.status = 413;
			throw error;
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("请求体必须是 JSON 对象");
		}
		return parsed;
	} catch (error) {
		const wrapped = new Error(
			error instanceof SyntaxError ? "请求体不是合法 JSON" : error.message
		);
		wrapped.status = 400;
		throw wrapped;
	}
}

export function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("content-length", Buffer.byteLength(body));
	res.end(body);
}

/**
 * Serialise mutations per session id.
 *
 * Two deletes for the same id racing each other is not a theoretical concern: the
 * modal's confirm button can be double-clicked, and the client retries. The first
 * would resolve the directory and the second would resolve the same one before
 * either finished, so both would `rm -rf` and the loser would report a failure for
 * a delete that actually succeeded. Queueing per id makes the second call observe
 * the world the first one left.
 *
 * Keyed by id rather than global so deletes of *different* sessions still proceed
 * in parallel — the filesystem is not the bottleneck here.
 *
 * @returns a function that runs `task` after every previously queued task for the
 *   same id has settled.
 */
export function createMutateQueue() {
	const chains = new Map();
	return function mutate(id, task) {
		const previous = chains.get(id) ?? Promise.resolve();
		// `.then(task, task)` on purpose: a rejected previous task must not skip the
		// queued one, or one failed delete would wedge that id forever.
		const next = previous.then(task, task);
		const settled = next.then(
			() => undefined,
			() => undefined
		);
		chains.set(id, settled);
		settled.then(() => {
			// Drop the entry once it is the tail, so the map cannot grow without bound
			// over a long session.
			if (chains.get(id) === settled) chains.delete(id);
		});
		return next;
	};
}

/**
 * Build the adapter over the host services the delete path needs.
 *
 * Every accessor is defensive: these are optional injections, and a host build
 * that lacks one must produce a clear "cannot delete safely" rather than a
 * `TypeError` halfway through a teardown.
 *
 * @param ctx - the plugin context.
 * @returns the operations {@link deleteSession} performs.
 */
export function createStore(ctx) {
	/** Resolve the sessions root, or throw if this build cannot name it. */
	const sessionsRoot = () => {
		const homePath = ctx.dshHomePath;
		if (homePath === undefined || typeof homePath !== "function") {
			throw new Error("无法确定会话目录：宿主未提供 dshHomePath");
		}
		return homePath("sessions");
	};

	return {
		sessionsRoot,
		getSession: (id) => {
			try {
				return ctx.sessions?.get?.(id);
			} catch {
				// A cold session can throw "not found" from `get` on some builds; that is
				// the same answer as "not live", which is what the caller is asking.
				return undefined;
			}
		},
		getAgent: (id) => {
			try {
				return ctx.agents?.get?.(id);
			} catch {
				return undefined;
			}
		},
		dropAgent: (id) => {
			try {
				ctx.agents?.store?.delete?.(id);
			} catch {
				/* the agent is being discarded either way */
			}
		},
		flush: async (session) => {
			try {
				await ctx.sessions?.flush?.(session);
			} catch {
				/* a flush failure must not block the delete the user asked for */
			}
		},
		detach: (id) => {
			try {
				const entry = ctx.sessions?.store?.get?.(id);
				if (entry !== undefined && typeof entry.detach === "function") {
					entry.detach();
					return true;
				}
			} catch {
				/* fall through to the explicit emit below */
			}
			return false;
		},
		/**
		 * Tell every connected client the row is gone.
		 *
		 * `entry.detach()` normally emits this, but a session with a stored artifact
		 * and no live store row has nothing to detach — and without the event every
		 * other client keeps rendering the row until a full reload.
		 */
		emitDisposed: (id) => {
			try {
				ctx.emit("session/disposed", { id });
			} catch {
				/* best-effort notification */
			}
		},
		/**
		 * Drop workspace membership and archive membership.
		 *
		 * Leaving these behind is what makes a deleted session reappear as an orphan
		 * in the sidebar's ungrouped section, so they are not optional cleanup.
		 */
		detachFromWorkspaces: async (id) => {
			const registry = ctx.workspaceRegistry;
			for (const method of ["detachSession", "removeSession", "unarchiveSession"]) {
				const fn = registry?.[method];
				if (typeof fn !== "function") continue;
				try {
					await fn.call(registry, id);
				} catch {
					/* one bookkeeping failure must not stop the others */
				}
			}
		}
	};
}

/**
 * Locate a session's artifact directory, verifying it really is that session's.
 *
 * The tree is `<root>/<encoded-project-path>/<session-id>/<artifact>`. The middle
 * level is derived from the project's *cwd*, not from the session id, so it cannot
 * be computed from the request — the project directories are enumerated and the id
 * is looked for inside each. That count is the number of distinct working
 * directories the user has ever opened a conversation in, so the scan is small.
 *
 * The header check is what makes this safe rather than merely convenient: without
 * it a directory would be deleted because its *name* matched user input. Requiring
 * the artifact inside to name the session means the delete can only ever remove
 * something that identifies itself as the target.
 *
 * @param store - the adapter from {@link createStore}.
 * @param id - an already-validated session id.
 * @returns the directory, or `undefined` when the session has no artifact.
 */
export async function sessionDirOf(store, id) {
	const root = store.sessionsRoot();
	let projects;
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch (error) {
		// No sessions root at all means this session has nothing on disk; that is a
		// normal answer for a session that only ever lived in memory.
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	for (const project of projects) {
		// Skip symlinks: a linked project level would let a recursive delete leave
		// the tree, and `assertSessionDirectory` rejects it later anyway.
		if (!project.isDirectory() || project.isSymbolicLink()) continue;
		const candidate = join(root, project.name, id);
		for (const filename of ARTIFACT_NAMES) {
			try {
				const header = await readSessionHeader(join(candidate, filename));
				if (header?.id === id) return candidate;
			} catch {
				// Missing, unreadable, or not a plain file — try the next candidate.
			}
		}
	}
	return undefined;
}

/**
 * Delete one session end to end.
 *
 * @param ctx - the plugin context.
 * @param store - the adapter from {@link createStore}.
 * @param id - the session id, validated by {@link assertSessionId} first.
 * @returns a summary of what was torn down.
 */
export async function deleteSession(ctx, store, id) {
	assertSessionId(id);

	// Resolve before mutating: a request that cannot name a real session must fail
	// before the agent is cancelled, not after.
	let dir = await sessionDirOf(store, id);
	const session = store.getSession(id);
	const agent = store.getAgent(id);

	if (agent !== undefined) {
		// `disposed` suppresses a re-wake: the point is that this session does not
		// come back after being cancelled.
		try {
			agent.cancel?.({ kind: "disposed" });
		} catch {
			/* the agent is going away regardless */
		}
		if (typeof agent.scope?.dispose === "function") {
			// Bounded: a fiber that refuses to unwind must not hang the request.
			await Promise.race([agent.scope.dispose(), sleep(DISPOSE_BUDGET_MS)]);
		}
		store.dropAgent(id);
	}

	let detached = false;
	if (session !== undefined) {
		// Flush first so the retirement drain has nothing left to write — otherwise
		// the artifact can reappear after the delete.
		await store.flush(session);
		detached = store.detach(id);
		if (detached) await sleep(RETIRE_SETTLE_MS);
	}
	if (!detached) store.emitDisposed(id);

	// Re-resolve: a blank session can write its first artifact during the flush,
	// and that file would otherwise survive as an invisible orphan.
	dir = (await sessionDirOf(store, id)) ?? dir;

	await store.detachFromWorkspaces(id);

	let filesRemoved = false;
	if (dir !== undefined) {
		// Re-validated here, immediately before the destructive call. The earlier
		// check proved the path was inside the tree; this one proves it still is.
		await assertSessionDirectory(store.sessionsRoot(), dir, id);
		await rm(dir, { recursive: true, force: true });
		filesRemoved = true;
	}

	return {
		ok: true,
		sessionId: id,
		wasLive: session !== undefined || agent !== undefined,
		filesRemoved
	};
}

/**
 * Mount the delete route.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
	const store = createStore(ctx);
	const mutate = createMutateQueue();
	const port = ctx.webServer?.port ?? 3080;

	ctx.effect(() =>
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/delete`,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					res.statusCode = 405;
					res.setHeader("allow", "POST");
					res.end();
					return;
				}
				const rejected = originRejection(req, port);
				if (rejected !== undefined) {
					sendJson(res, rejected, { error: "请求来源不被信任" });
					return;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					sendJson(res, error.status ?? 400, { error: error.message });
					return;
				}
				let id;
				try {
					id = assertSessionId(body.sessionId);
				} catch (error) {
					sendJson(res, 400, { error: error.message });
					return;
				}
				try {
					// Queued per id so a double-click cannot race two `rm -rf`s.
					sendJson(res, 200, await mutate(id, () => deleteSession(ctx, store, id)));
				} catch (error) {
					ctx.logger?.warn?.("session-lite: 删除会话 %s 失败: %s", id, error?.message ?? error);
					sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		})
	,
		'dsh-session-lite: delete route');
}
