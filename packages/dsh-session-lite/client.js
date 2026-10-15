/**
 * dsh-session-lite client half — one sidebar-footer button and a modal.
 *
 * ## Footprint
 *
 * The full manager mounted six controls and an overflow menu into
 * `conversation.session.header.actions`, the title row of every conversation. This
 * half registers **only** `sidebar.footer.action`, which renders at the bottom of
 * the sidebar next to the other footer entries. Nothing is added to the title bar,
 * so the conversation header goes back to showing just the title and workspace.
 *
 * ## What it does not implement
 *
 * Archiving, unarchiving, opening and renaming are DSH features, not plugin
 * features. They live on the injected `uiWorkspace` service, which this half calls
 * directly. The full manager reimplemented them behind a compatibility shim and
 * eight private-API dependencies; calling the shipped methods removes all of that
 * and keeps the behaviour identical to the sidebar's own controls.
 *
 * Deleting is the exception: it has no DSH equivalent, so it is the one operation
 * that goes back to the host, over `POST /session-lite/delete`.
 *
 * ## Size
 *
 * The full manager's client bundle is 281 KB, 60 KB of which is hand-written CSS.
 * This half renders with `Button`, `Input` and `Modal` from
 * `dsh-client-ui-primitives` and carries no stylesheet at all, so its appearance
 * follows the user's theme automatically instead of hard-coding colours.
 *
 * @module dsh-session-lite/client
 */

window.__ModuleLoader__.load({
	id: "dsh-session-lite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const P = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Slot id, and the key the panel's open state is stored under. */
		const PANEL_ID = "session-lite";

		/** Route the host half exposes; it owns the only operation DSH lacks. */
		const DELETE_ROUTE = "/session-lite/delete";

		/**
		 * The last search term, kept at module scope.
		 *
		 * The footer component unmounts whenever the sidebar collapses or the user
		 * switches conversation, and losing the filter on every remount makes the
		 * search box feel broken. The value is a view preference, not session state,
		 * so module scope is the right lifetime.
		 */
		let lastQuery = "";

		/** Which slice of the list is showing. See {@link FILTERS}. */
		let lastFilter = "active";

		/**
		 * Filter definitions, in menu order.
		 *
		 * "active" is the default because archived sessions are already reachable
		 * from DSH's own archive view; a management panel that opens on everything
		 * makes the user filter before they can act.
		 */
		const FILTERS = [
			{ id: "active", label: "未归档" },
			{ id: "archived", label: "已归档" },
			{ id: "all", label: "全部" }
		];

		/**
		 * Format a timestamp the way a session list wants it: relative when recent,
		 * absolute when not. A list of full timestamps is unreadable at a glance.
		 *
		 * @param value - epoch milliseconds, or anything else for "unknown".
		 * @returns a short human-readable age.
		 */
		function ageText(value) {
			const ms = Number(value);
			if (!Number.isFinite(ms) || ms <= 0) return "";
			const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
			if (seconds < 60) return "刚刚";
			if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
			if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
			if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
			return new Date(ms).toLocaleDateString();
		}

		/**
		 * The title to show for one session.
		 *
		 * `displayTitle` is what the sidebar shows, and is absent for a session that
		 * has never been named; the id is a poor but honest fallback, and `blank`
		 * marks a session with no messages at all.
		 *
		 * @param session - one entry from the sessions store.
		 * @returns the display title.
		 */
		function titleOf(session) {
			const title = typeof session?.displayTitle === "string" ? session.displayTitle.trim() : "";
			if (title !== "") return title;
			if (session?.blank === true) return "（空会话）";
			return String(session?.id ?? "");
		}

		/**
		 * Whether a session matches the search box.
		 *
		 * Matching the id as well as the title is deliberate: users paste ids out of
		 * logs and bug reports, and a title-only search silently finds nothing.
		 *
		 * @param session - one entry from the sessions store.
		 * @param query - the raw search text.
		 * @returns whether the row should be listed.
		 */
		function matches(session, query) {
			const needle = query.trim().toLowerCase();
			if (needle === "") return true;
			return (
				titleOf(session).toLowerCase().includes(needle) ||
				String(session?.id ?? "").toLowerCase().includes(needle) ||
				String(session?.cwd ?? "").toLowerCase().includes(needle)
			);
		}

		/**
		 * Call the host's delete route.
		 *
		 * The error is surfaced rather than swallowed: a delete that fails silently
		 * leaves the user clicking a button that appears to do nothing.
		 *
		 * @param sessionId - the session to delete.
		 */
		async function requestDelete(sessionId) {
			const response = await fetch(DELETE_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
			return payload;
		}

		/**
		 * The management modal.
		 *
		 * Everything it needs comes in as props from the footer component, which is
		 * where the slot framework injects the stores and the navigation callbacks.
		 *
		 * @param props.sessionList - the live list of sessions.
		 * @param props.archivedIds - ids currently in the archive set.
		 * @param props.actions - the injected navigation callbacks.
		 * @param props.onClose - close the modal.
		 */
		function Panel(props) {
			const { sessionList, archivedIds, actions, onClose } = props;
			const [query, setQuery] = React.useState(lastQuery);
			const [filter, setFilter] = React.useState(lastFilter);
			const [busyId, setBusyId] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [confirmId, setConfirmId] = React.useState(null);

			// Persisted so a remount does not silently reset what the user typed.
			React.useEffect(() => {
				lastQuery = query;
			}, [query]);
			React.useEffect(() => {
				lastFilter = filter;
			}, [filter]);

			const archived = React.useMemo(() => new Set(archivedIds ?? []), [archivedIds]);

			const rows = React.useMemo(() => {
				const all = Array.isArray(sessionList) ? sessionList : [];
				return all
					.filter((session) => {
						const isArchived = archived.has(session.id);
						if (filter === "active" && isArchived) return false;
						if (filter === "archived" && !isArchived) return false;
						return matches(session, query);
					})
					// Most recent first: a session list is read to find what you were
					// just working on, not to browse history chronologically.
					.sort((a, b) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0));
			}, [sessionList, archived, filter, query]);

			/**
			 * Run one action against one session, holding the row busy and reporting a
			 * failure inline rather than letting it reject unhandled.
			 */
			const run = async (id, task) => {
				setBusyId(id);
				setError(null);
				try {
					await task();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusyId(null);
					setConfirmId(null);
				}
			};

			const footer = React.createElement(
				"div",
				{ style: { display: "flex", gap: 8, alignItems: "center", width: "100%" } },
				React.createElement(P.Button, { size: "sm", onClick: onClose }, "关闭"),
				React.createElement("span", { style: { flex: 1 } }),
				React.createElement(
					"span",
					{ style: { fontSize: 12, opacity: 0.7 } },
					`${rows.length} 个会话`
				)
			);

			return React.createElement(
				P.Modal,
				{
					open: true,
					onClose,
					title: "会话管理",
					closeLabel: "关闭",
					description: "搜索、归档或删除本地会话。",
					footer,
					contentClassName: undefined
				},
				React.createElement(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 } },
					React.createElement(P.Input, {
						value: query,
						placeholder: "搜索标题、ID 或目录",
						"aria-label": "搜索会话",
						onChange: (event) => setQuery(event?.target?.value ?? "")
					}),
					// The filters get their own row rather than sharing one with the
					// search box: `Input` renders full-width, so side by side the last
					// filter is clipped at the modal's edge and becomes unclickable.
					React.createElement(
						"div",
						{ style: { display: "flex", gap: 4, flexWrap: "wrap" } },
						FILTERS.map((option) =>
							React.createElement(
								P.Button,
								{
									key: option.id,
									size: "sm",
									variant: filter === option.id ? "primary" : "ghost",
									onClick: () => setFilter(option.id)
								},
								option.label
							)
						)
					)
				),
				error !== null
					? React.createElement(
							"div",
							{ role: "alert", style: { color: "var(--dsw-alias-label-error, #d33)", fontSize: 12, marginBottom: 8 } },
							error
						)
					: null,
				React.createElement(
					"div",
					{
						// Bounded height with its own scrollbar. Without this the list
						// grows the modal past the viewport, which pushes the search box
						// and the action row off-screen — the two controls the panel
						// exists to provide.
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 6,
							maxHeight: "52vh",
							overflowY: "auto",
							overflowX: "hidden"
						}
					},
					rows.length === 0
						? React.createElement(
								"div",
								{ style: { padding: "24px 0", textAlign: "center", opacity: 0.7, fontSize: 13 } },
								"没有匹配的会话"
							)
						: rows.map((session) => {
								const id = session.id;
								const isArchived = archived.has(id);
								const busy = busyId === id;
								return React.createElement(
									"div",
									{
										key: id,
										style: {
											display: "flex",
											alignItems: "center",
											gap: 8,
											padding: "8px 10px",
											borderRadius: 8,
											background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.10))",
											opacity: busy ? 0.6 : 1
										}
									},
									React.createElement("div", { style: { flex: 1, minWidth: 0 } },
										React.createElement(
											"div",
											{
												style: {
													fontSize: 13,
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap"
												},
												title: titleOf(session)
											},
											titleOf(session)
										),
										React.createElement(
											"div",
											{ style: { fontSize: 11, opacity: 0.65, marginTop: 2 } },
											`${ageText(session.updatedAt)}${isArchived ? " · 已归档" : ""}`
										)
									),
									React.createElement(P.Button, {
										size: "sm",
										variant: "ghost",
										disabled: busy,
										onClick: () => actions.onOpen(id)
									}, "打开"),
									React.createElement(P.Button, {
										size: "sm",
										variant: "ghost",
										disabled: busy,
										onClick: () =>
											run(id, () =>
												isArchived ? actions.onUnarchive(id) : actions.onArchive(id)
											)
									}, isArchived ? "取消归档" : "归档"),
									confirmId === id
										? React.createElement(
												React.Fragment,
												null,
												React.createElement(P.Button, {
													size: "sm",
													// The primitives' variants are primary/ghost/outline/
													// toolbar — there is no destructive one, so the safety
													// here comes from the second click, not from colour.
													variant: "primary",
													disabled: busy,
													// Irreversible, so it takes a second click; the first
													// swaps this button in and nothing else.
													onClick: () => run(id, () => requestDelete(id))
												}, "确认删除"),
												React.createElement(P.Button, {
													size: "sm",
													variant: "ghost",
													disabled: busy,
													onClick: () => setConfirmId(null)
												}, "取消")
											)
										: React.createElement(P.Button, {
												size: "sm",
												variant: "ghost",
												disabled: busy,
												onClick: () => setConfirmId(id)
											}, "删除")
								);
							})
				)
			);
		}

		/**
		 * The sidebar-footer button and the modal it opens.
		 *
		 * @param props - the slot framework's props: `wide` when the sidebar is
		 *   expanded, `useSessions`/`useWorkspaces` store selectors, and the injected
		 *   navigation callbacks.
		 */
		function FooterAction(props) {
			const [open, setOpen] = React.useState(false);

			// The slot framework spreads the inject factory's return value into
			// top-level props, so the callbacks are not nested under `.actions`.
			const actionProps = props;
			const useSessions = props.useSessions;
			const useWorkspaces = props.useWorkspaces;

			// Selectors, not whole-store reads: the footer must not re-render on every
			// unrelated store change, and it re-renders on exactly the two slices it
			// shows. `useSessions` may be absent on a minimal sidebar, hence the guard.
			//
			// The sessions store is normalised — `{byId, ids}` — not an array. Reading
			// it as an array is silent: `Array.isArray` fails, the list renders empty,
			// and the panel looks like it lost every conversation rather than like it
			// was handed the wrong shape.
			const snapshot = useSessions !== undefined ? useSessions((state) => state) : null;
			const sessionList = React.useMemo(() => {
				if (snapshot === null || snapshot === undefined) return [];
				if (Array.isArray(snapshot)) return snapshot;
				const ids = Array.isArray(snapshot.ids) ? snapshot.ids : [];
				const byId = snapshot.byId ?? {};
				return ids.map((id) => byId[id]).filter((session) => session !== undefined);
			}, [snapshot]);
			const archivedIds =
				useWorkspaces !== undefined
					? useWorkspaces((state) => state?.archivedSessionIds) ?? []
					: [];

			const label = "会话管理";
			const wide = props.wide === true;

			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"button",
					{
						type: "button",
						"aria-label": label,
						title: wide ? undefined : label,
						onClick: () => setOpen(true),
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							width: wide ? "100%" : 36,
							height: 36,
							padding: wide ? "0 10px" : 0,
							justifyContent: wide ? "flex-start" : "center",
							border: 0,
							borderRadius: 8,
							background: "transparent",
							color: "inherit",
							cursor: "pointer",
							font: "inherit",
							fontSize: 13
						}
					},
					React.createElement(P.IconFlatListOutlineRegular, { size: wide ? 14 : 18 }),
					wide ? React.createElement("span", null, label) : null
				),
				open
					? React.createElement(Panel, {
							sessionList,
							archivedIds,
							actions: actionProps,
							onClose: () => setOpen(false)
						})
					: null
			);
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots", "sessions", "workspaces", "uiWorkspace"];

		/**
		 * Register the single sidebar-footer entry.
		 *
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: `${PANEL_ID}-footer`,
						order: 30,
						inject: () => ({
							// Navigation is DSH's own; passing the service through keeps
							// this component free of private-API fallbacks.
							onOpen: (id) => ctx.uiWorkspace?.openSession?.(id),
							onArchive: (id) => ctx.uiWorkspace?.archiveSession?.(id),
							onUnarchive: (id) => ctx.uiWorkspace?.unarchiveSession?.(id)
						})
					},
					FooterAction
				)
			);
		}

		Object.assign(module.exports, { PANEL_ID, FooterAction, Panel, apply, inject });
		return module.exports;
	}
});
