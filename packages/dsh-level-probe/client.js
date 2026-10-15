/**
 * level-probe — the client half.
 *
 * One tab in the merged capability panel. It answers a single question per
 * model: *do this route's thinking levels actually differ from each other?*
 *
 * The panel is deliberately a table rather than a verdict card. A verdict would
 * have to collapse four columns (reasoning tokens, latency, accuracy, and
 * whether the level was answered at all) into one word, and the whole point of
 * the probe is that those columns disagree — a level can cost twice the tokens
 * and score the same, which is the case the user is looking for.
 */
window.__ModuleLoader__.load({
	id: "dsh-level-probe",
	factory: (require) => {
		// The loader hands a factory a `require` and nothing else. Every symbol the
		// shipped bundles declare for themselves must be declared here too.
		// Without it, `module.exports` below throws "module is not defined"
		// and the whole client entry fails to activate.
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const PANEL_ID = "level-probe";
		const RUN_ROUTE = "level-probe/run";
		const CATALOG_ROUTE = "level-probe/catalog";

		/**
		 * Verdict presentation.
		 *
		 * `same-as-previous` is the finding the probe exists for, and it is amber
		 * rather than red: nothing is broken — the user is overpaying for a level
		 * the route folds into the one below it.
		 */
		const STATUS = {
			baseline: { tone: "#8b949e", label: "基准", note: "最低的可用档位，后面每一档都与它比较" },
			distinct: { tone: "#3fb950", label: "有区别", note: "这一档的推理投入确实高于上一档" },
			"same-as-previous": { tone: "#db8b0b", label: "与上一档相同", note: "与上一档没有可测量的区别——开这一档是白花钱" },
			unavailable: { tone: "#f85149", label: "不可用", note: "这一档的请求全部失败，中转不接受它" },
			unknown: { tone: "#8b949e", label: "无法判断", note: "该中转没有暴露推理 token 或推理文本，无法比较" }
		};

		const SIGNAL_LABELS = {
			"reasoning-tokens": "推理 token 数（中转直接报告）",
			"reasoning-text": "推理文本长度（中转不报 token，用文本长度代替）",
			latency: "响应耗时（唯一可用的信号，受负载影响，仅供参考）"
		};

		/**
		 * Resolve a document-relative URL so the app works under any mount point.
		 *
		 * @param path - the route-relative path.
		 * @returns the resolved pathname.
		 */
		function api(path) {
			const relative = String(path).replace(/^\/+/, "");
			if (typeof document === "undefined") return `/${relative}`;
			return new URL(relative, document.baseURI).pathname;
		}

		/**
		 * Module-scoped panel state, kept outside React on purpose.
		 *
		 * The main slot renders one panel at a time, and the workspace clears the
		 * active panel whenever the session changes. React state therefore dies on
		 * every conversation switch, which would throw away the ticked models and
		 * the results of a run that is still going.
		 */
		const panelState = {
			selected: null,
			catalog: null,
			run: null,
			phase: "idle",
			error: null
		};
		const listeners = new Set();
		function setPanelState(patch) {
			Object.assign(panelState, patch);
			for (const listener of listeners) listener();
		}

		/** A labelled number, or a dash when the probe had nothing to report. */
		function num(value, digits = 0) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return value.toFixed(digits);
		}

		/**
		 * One model's result block.
		 *
		 * @param props - `{entry}` where `entry` is a model record from the report.
		 */
		function ModelCard(props) {
			const { entry } = props;
			const signal = entry.signal;
			const verdictByLevel = new Map((entry.verdicts ?? []).map((v) => [v.level, v]));

			return React.createElement(
				"div",
				{ style: styles.card },
				React.createElement(
					"div",
					{ style: styles.cardHead },
					React.createElement("span", { style: styles.modelName }, `${entry.provider}/${entry.model}`),
					entry.recommendation !== null && entry.recommendation !== undefined
						? React.createElement("span", { style: styles.reco }, entry.recommendation.note)
						: null
				),
				entry.error !== undefined && entry.error !== null
					? React.createElement("div", { style: styles.errorLine }, entry.error)
					: null,
				React.createElement("div", { style: styles.signalLine }, `比较依据：${SIGNAL_LABELS[signal] ?? "无"}`),
				React.createElement(
					"table",
					{ style: styles.table },
					React.createElement(
						"thead",
						null,
						React.createElement(
							"tr",
							null,
							["档位", "结论", "推理 token", "输出 token", "耗时(s)", "正确率", "失败", "说明"].map((h) =>
								React.createElement("th", { key: h, style: styles.th }, h)
							)
						)
					),
					React.createElement(
						"tbody",
						null,
						(entry.levels ?? []).map((row) => {
							const verdict = verdictByLevel.get(row.level) ?? { status: "unknown", note: "" };
							const look = STATUS[verdict.status] ?? STATUS.unknown;
							return React.createElement(
								"tr",
								{ key: row.level },
								React.createElement("td", { style: styles.td }, row.level),
								React.createElement(
									"td",
									{ style: { ...styles.td, color: look.tone, fontWeight: 600 } },
									look.label
								),
								React.createElement("td", { style: styles.tdNum }, num(row.reasoningTokens)),
								React.createElement("td", { style: styles.tdNum }, num(row.outputTokens)),
								React.createElement("td", { style: styles.tdNum }, num(row.latencyMs / 1000, 1)),
								React.createElement(
									"td",
									{ style: styles.tdNum },
									row.accuracy === null ? "—" : `${row.correct}/${row.attempts}`
								),
								React.createElement("td", { style: styles.tdNum }, row.failed > 0 ? String(row.failed) : "—"),
								React.createElement("td", { style: styles.tdNote }, verdict.note)
							);
						})
					)
				)
			);
		}

		/** The panel body. */
		function LevelPanel() {
			const [, force] = React.useReducer((n) => n + 1, 0);
			React.useEffect(() => {
				listeners.add(force);
				return () => listeners.delete(force);
			}, []);

			const [loading, setLoading] = React.useState(false);
			const [catalogError, setCatalogError] = React.useState(null);
			const catalog = panelState.catalog;
			const selected = panelState.selected ?? new Set();

			const loadCatalog = React.useCallback(async () => {
				setLoading(true);
				setCatalogError(null);
				try {
					const response = await fetch(api(CATALOG_ROUTE));
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					const patch = { catalog: payload };
					// Preselect everything that advertises more than one level: a model
					// with a single level has nothing to compare, and including it would
					// spend requests to print one row of "baseline".
					if (panelState.selected === null) {
						patch.selected = new Set(
							(payload.models ?? [])
								.filter((m) => (m.levels ?? []).length > 1)
								.map((m) => `${m.provider}/${m.model}`)
						);
					}
					setPanelState(patch);
				} catch (error) {
					setCatalogError(error instanceof Error ? error.message : String(error));
				} finally {
					setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				loadCatalog();
			}, [loadCatalog]);

			// Poll while a run is in flight. The run lives on the host and outlives
			// this component, so the interval is the only thing tying them together.
			React.useEffect(() => {
				let cancelled = false;
				let timer = null;
				const tick = async () => {
					try {
						const response = await fetch(api(RUN_ROUTE));
						const payload = await response.json();
						if (cancelled) return;
						setPanelState({ run: payload, phase: payload.phase ?? "idle" });
						if (payload.phase === "running") timer = setTimeout(tick, 2000);
					} catch (error) {
						if (cancelled) return;
						setPanelState({ error: error instanceof Error ? error.message : String(error) });
					}
				};
				tick();
				return () => {
					cancelled = true;
					if (timer !== null) clearTimeout(timer);
				};
			}, [panelState.phase === "running"]);

			const toggle = (key) => {
				const next = new Set(selected);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				setPanelState({ selected: next });
			};

			const start = async () => {
				setPanelState({ error: null, phase: "running", run: null });
				try {
					const response = await fetch(api(RUN_ROUTE), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ models: [...selected] })
					});
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					setPanelState({ run: payload, phase: payload.phase ?? "running" });
				} catch (error) {
					setPanelState({ error: error instanceof Error ? error.message : String(error), phase: "error" });
				}
			};

			const models = catalog?.models ?? [];
			const byProvider = new Map();
			for (const entry of models) {
				if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
				byProvider.get(entry.provider).push(entry);
			}

			const report = panelState.run?.report;
			const running = panelState.phase === "running";

			return React.createElement(
				"div",
				{ style: styles.wrap },
				React.createElement(
					"div",
					{ style: styles.intro },
					"对同一个问题分别用每个思考档位问一遍，比较推理 token、耗时和正确率。",
					"如果某一档和它下面那一档没有可测量的区别，那一档在这个中转上就是白开的。"
				),
				panelState.error !== null
					? React.createElement("div", { style: styles.errorLine }, panelState.error)
					: null,
				catalogError !== null
					? React.createElement("div", { style: styles.errorLine }, catalogError)
					: null,
				React.createElement(
					"div",
					{ style: styles.row },
					React.createElement(
						"button",
						{ type: "button", style: running ? styles.buttonOff : styles.button, disabled: running || selected.size === 0, onClick: start },
						running ? "探测中…" : `开始探测（${selected.size} 个模型）`
					),
					React.createElement(
						"button",
						{ type: "button", style: styles.buttonGhost, disabled: loading || running, onClick: loadCatalog },
						loading ? "读取中…" : "重新读取模型"
					)
				),
				React.createElement(
					"div",
					{ style: styles.picker },
					[...byProvider.entries()].map(([provider, entries]) =>
						React.createElement(
							"div",
							{ key: provider, style: styles.group },
							React.createElement("div", { style: styles.groupName }, provider),
							entries.map((entry) => {
								const key = `${entry.provider}/${entry.model}`;
								const levels = entry.levels ?? [];
								const usable = levels.length > 1;
								return React.createElement(
									"label",
									{ key, style: usable ? styles.item : styles.itemMuted },
									React.createElement("input", {
										type: "checkbox",
										checked: selected.has(key),
										disabled: !usable || running,
										onChange: () => toggle(key)
									}),
									React.createElement("span", null, entry.model),
									React.createElement(
										"span",
										{ style: styles.itemLevels },
										usable ? `${levels.length} 档：${levels.join("/")}` : "没有声明思考档位"
									)
								);
							})
						)
					)
				),
				running && panelState.run?.progress !== null && panelState.run?.progress !== undefined
					? React.createElement("div", { style: styles.progress }, panelState.run.progress)
					: null,
				report !== undefined && report !== null && (report.models ?? []).length > 0
					? React.createElement(
							"div",
							{ style: styles.results },
							report.models.map((entry) =>
								React.createElement(ModelCard, { key: `${entry.provider}/${entry.model}`, entry })
							)
						)
					: null
			);
		}

		/** The rail glyph; a component, never `null` (that crashes the rail). */
		function LevelIcon(props) {
			const Glyph = primitives.IconGaugeOutlineRegular ?? primitives.IconGaugeOutline;
			if (Glyph !== undefined) return React.createElement(Glyph, { size: props?.size ?? 16 });
			return React.createElement("span", { "aria-hidden": "true" }, "\u2261");
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * Register nothing.
		 *
		 * This half is only ever a tab of the merged `dsh-probe` panel: it ships no
		 * `dsh.bundle` and is absent from the profile's bundle list, so that panel's
		 * patch is the only thing that loads it. The panel owns the rail entry and
		 * the `main` seat; a half claiming either would add a second, unreachable
		 * button to the sidebar.
		 *
		 * An earlier version tried to detect the merge with a
		 * `window.__DSH_PROBE_MERGED__` flag set by the panel's bundle. That could
		 * never work: the panel *requires* this bundle, so the module graph places
		 * this bundle first and this `apply` runs before the flag is assigned. The
		 * guard was always false. Owning nothing does not depend on load order.
		 *
		 * @param _ctx - the client root context; unused.
		 */
		function apply(_ctx) {}

		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0, overflow: "auto" },
			intro: { fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" },
			row: { display: "flex", gap: 8, flex: "0 0 auto" },
			button: {
				appearance: "none",
				border: 0,
				borderRadius: 8,
				background: "var(--dsw-alias-brand-primary, #4493f8)",
				color: "#fff",
				font: "inherit",
				fontSize: 13,
				fontWeight: 600,
				padding: "8px 14px",
				cursor: "pointer"
			},
			buttonOff: {
				appearance: "none",
				border: 0,
				borderRadius: 8,
				background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.22))",
				color: "var(--dsw-alias-label-secondary)",
				font: "inherit",
				fontSize: 13,
				padding: "8px 14px",
				cursor: "default"
			},
			buttonGhost: {
				appearance: "none",
				border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))",
				borderRadius: 8,
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				font: "inherit",
				fontSize: 13,
				padding: "8px 14px",
				cursor: "pointer"
			},
			picker: { display: "flex", flexWrap: "wrap", gap: 16, flex: "0 0 auto" },
			group: { display: "flex", flexDirection: "column", gap: 4, minWidth: 200 },
			groupName: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			item: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" },
			itemMuted: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, opacity: 0.45, cursor: "not-allowed" },
			itemLevels: { color: "var(--dsw-alias-label-secondary)", fontSize: 11 },
			progress: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
			results: { display: "flex", flexDirection: "column", gap: 16 },
			card: {
				border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))",
				borderRadius: 10,
				padding: 12,
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			cardHead: { display: "flex", flexDirection: "column", gap: 4 },
			modelName: { fontSize: 13, fontWeight: 600 },
			reco: { fontSize: 12, color: "#3fb950" },
			signalLine: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
			errorLine: {
				fontSize: 12,
				color: "#f85149",
				background: "rgba(248,81,73,.1)",
				borderRadius: 6,
				padding: "6px 8px"
			},
			table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
			th: {
				textAlign: "left",
				padding: "4px 6px",
				borderBottom: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))",
				color: "var(--dsw-alias-label-secondary)",
				fontWeight: 600
			},
			td: { padding: "4px 6px", borderBottom: "1px solid rgba(127,127,127,.12)" },
			tdNum: { padding: "4px 6px", borderBottom: "1px solid rgba(127,127,127,.12)", textAlign: "right" },
			tdNote: { padding: "4px 6px", borderBottom: "1px solid rgba(127,127,127,.12)", color: "var(--dsw-alias-label-secondary)" }
		};

		Object.assign(module.exports, { PANEL_ID, LevelPanel, LevelIcon, apply, inject });
		return module.exports;
	}
});
