/**
 * fingerprint-probe — browser half.
 *
 * Renders a sidebar panel that asks selected models for a few hundred "random"
 * integers and shows which reference model their answers most resemble. All
 * elicitation and scoring happen on the Node half; this module only renders the
 * report and the raw evidence.
 *
 * ## Why the caveat is part of the layout
 *
 * The verdict is a closed-set ranking over 58 reference models. A model outside
 * that bank still receives a nearest candidate and a confidence share, and the
 * numbers look equally authoritative either way. The scope note therefore sits
 * with the result rather than in a footnote — a fingerprint tool that is
 * believed more than it deserves is worse than no tool.
 *
 * Hand-written bundle: no JSX and no build step, matching the shipped client
 * bundles' `window.__ModuleLoader__.load({id, factory})` shape. Elements are
 * built with `React.createElement`.
 *
 * @module dsh-fingerprint-probe/client
 */

window.__ModuleLoader__.load({
	id: "dsh-fingerprint-probe",
	factory: (require) => {
		// The loader calls this factory directly, so the CommonJS shim the
		// shipped bundles declare for themselves must be declared here too.
		// Without it, `module.exports` below throws "module is not defined"
		// and the whole client entry fails to activate.
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const PANEL_ID = "fingerprint-probe";
		const ROUTE = "fingerprint-probe/run";
		const MODELS_ROUTE = "fingerprint-probe/models";

		/**
		 * Verdict presentation.
		 *
		 * `identified` deliberately does not say "confirmed": the top candidate is
		 * the closest match in a closed reference set, which is evidence about
		 * resemblance, not proof of identity.
		 */
		const VERDICTS = {
			identified: {
				tone: "#3fb950",
				label: "已识别",
				note: "三条回答都有效，候选顺序由排名分数决定。下方置信度是参考库内的相对概率。"
			},
			partial: {
				tone: "#db8b0b",
				label: "部分样本",
				note: "有效回答不足三条，只能给出排名，无法计算置信度。补齐三条有效回答后才能得到校准结果。"
			},
			unscorable: {
				tone: "#8b949e",
				label: "暂不可评分",
				note: "没有足够的有效回答。可能是模型拒绝作答、被截断，或输出的整数太少。"
			},
			unreachable: {
				tone: "#f85149",
				label: "不可达",
				note: "请求全部失败，无法评估。请检查 provider、模型名与网关状态。"
			}
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
		 * active panel whenever the session changes. React state therefore dies
		 * on every conversation switch, which used to throw away the ticked
		 * models *and* the finished report — the panel came back as though it had
		 * never run. Hoisting the state here makes the switch invisible.
		 */
		const panelState = {
			/** Ticked `provider/model` ids, or `null` until the catalog loads. */
			selected: null,
			/** `idle` | `running` | `done` | `error`. */
			phase: "idle",
			/** The last report returned by the host, or `null`. */
			report: null,
			/** A transport failure, kept apart from a detection verdict. */
			error: null,
			/** The host job id being polled, so a stale poll cannot overwrite. */
			jobId: null
		};

		/** Subscribers re-rendered when {@link panelState} changes. */
		const panelListeners = new Set();

		/** Apply a partial update and notify every mounted panel. */
		function setPanelState(patch) {
			Object.assign(panelState, patch);
			for (const listener of panelListeners) listener();
		}

		/** Inline styles keep the panel self-contained with no CSS asset to ship. */
		const styles = {
			root: { display: "flex", flexDirection: "column", gap: "14px", padding: "20px 22px", height: "100%", overflowY: "auto", fontSize: "13px" },
			header: { display: "flex", alignItems: "center", gap: "10px" },
			title: { margin: 0, fontSize: "16px", fontWeight: 600 },
			sub: { margin: "2px 0 0", opacity: 0.62, fontSize: "12px", lineHeight: 1.6 },
			bar: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			card: { border: "1px solid rgba(127,127,127,.24)", borderRadius: "10px", padding: "13px 15px", display: "flex", flexDirection: "column", gap: "9px" },
			cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" },
			model: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "13px", fontWeight: 600 },
			verdict: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" },
			dot: { width: "8px", height: "8px", borderRadius: "999px", display: "inline-block" },
			note: { fontSize: "12px", opacity: 0.66, lineHeight: 1.6 },
			prediction: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
			predictionName: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "15px", fontWeight: 600 },
			tiers: { display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "12px", opacity: 0.8 },
			row: { display: "flex", flexDirection: "column", gap: "2px", paddingTop: "7px", borderTop: "1px solid rgba(127,127,127,.14)" },
			rowHead: { display: "flex", alignItems: "center", gap: "8px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
			detail: { fontSize: "11px", opacity: 0.6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all" },
			err: { fontSize: "11px", color: "#f85149", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all" },
			pass: { color: "#3fb950" },
			fail: { color: "#f85149" },
			muted: { opacity: 0.6 },
			empty: { opacity: 0.6, padding: "28px 0", textAlign: "center", fontSize: "12px" },
			picker: { border: "1px solid rgba(127,127,127,.24)", borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "9px" },
			pickerHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" },
			pickerTitle: { fontSize: "12px", fontWeight: 600, opacity: 0.85 },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "6px 14px" },
			modelItem: { display: "flex", alignItems: "center", gap: "7px", fontSize: "12px", cursor: "pointer", minWidth: 0 },
			modelName: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			linkBtn: { background: "none", border: "none", padding: 0, color: "inherit", opacity: 0.7, cursor: "pointer", fontSize: "12px", textDecoration: "underline" },
			caveat: { border: "1px solid rgba(127,127,127,.2)", borderLeft: "3px solid rgba(127,127,127,.45)", borderRadius: "6px", padding: "9px 12px", fontSize: "11.5px", opacity: 0.72, lineHeight: 1.65 },
			rank: { display: "flex", flexDirection: "column", gap: "3px" },
			rankRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" },
			rankName: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", flex: "0 0 auto" },
			rankBar: { flex: "1 1 auto", height: "5px", borderRadius: "999px", background: "rgba(127,127,127,.2)", overflow: "hidden", minWidth: "40px" },
			rankFill: { height: "100%", borderRadius: "999px", background: "#3fb950" },
			rankValue: { flex: "0 0 auto", opacity: 0.7, fontVariantNumeric: "tabular-nums", minWidth: "46px", textAlign: "right" }
		};

		/**
		 * Sidebar rail icon.
		 *
		 * A magnifier over a sequence, to read differently from the coding probe's
		 * gauge at rail size.
		 *
		 * @param props - optional size.
		 * @returns the icon element.
		 */
		function FingerprintIcon(props) {
			const Glyph = primitives.IconSearchOutlineRegular ?? primitives.IconSearchOutline;
			if (Glyph !== undefined) return React.createElement(Glyph, { size: props?.size ?? 16 });
			return React.createElement("span", { "aria-hidden": "true" }, "\u2315");
		}

		/** Format a probability as a percentage, tolerating null. */
		function percent(value) {
			return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
		}

		/**
		 * The candidate ranking.
		 *
		 * Bars are scaled against the top candidate rather than against 100%, so
		 * the shape of the field is readable when the leader is not dominant —
		 * which is the normal case and the main thing a reader needs to see.
		 *
		 * @param props - `results` from the Node half.
		 * @returns the ranking element.
		 */
		function Ranking({ results }) {
			if (!Array.isArray(results) || results.length === 0) return null;
			const shown = results.slice(0, 5);
			const top = Math.max(...shown.map((r) => Math.abs(r.probability ?? r.score ?? 0))) || 1;
			return React.createElement("div", { style: styles.rank },
				shown.map((result, index) =>
					React.createElement("div", { key: result.model, style: styles.rankRow },
						React.createElement("span", { style: { ...styles.rankValue, minWidth: "18px", opacity: 0.5 } }, `${index + 1}.`),
						React.createElement("span", { style: styles.rankName }, result.display_name ?? result.model),
						React.createElement("span", { style: styles.rankBar },
							React.createElement("span", {
								style: {
									...styles.rankFill,
									width: `${Math.max(2, (Math.abs(result.probability ?? result.score ?? 0) / top) * 100)}%`,
									background: index === 0 ? "#3fb950" : "rgba(127,127,127,.55)"
								}
							})
						),
						React.createElement("span", { style: styles.rankValue },
							result.probability !== null && result.probability !== undefined
								? percent(result.probability)
								: `分 ${(result.score ?? 0).toFixed(2)}`
						)
					)
				)
			);
		}

		/**
		 * Render one challenge attempt.
		 *
		 * Rejected attempts keep their preview: "insufficient numbers" is a claim
		 * about the reply, and showing the reply is what lets a reader check it.
		 *
		 * @param props - the attempt record.
		 * @returns the row element.
		 */
		function AttemptRow({ attempt }) {
			const detail = [
				`要求 ${attempt.expected}`,
				`有效 ${attempt.numbers}/${attempt.minimum}`,
				attempt.outputTokens !== null && attempt.outputTokens !== undefined ? `${attempt.outputTokens} tokens` : null,
				`${(attempt.ms / 1000).toFixed(1)}s`
			].filter(Boolean).join(" · ");
			return React.createElement("div", { style: styles.row },
				React.createElement("div", { style: styles.rowHead },
					React.createElement("span", { style: attempt.accepted ? styles.pass : styles.fail }, attempt.accepted ? "有效" : "无效"),
					React.createElement("span", { style: styles.detail }, detail)
				),
				attempt.error !== null && attempt.error !== undefined &&
					React.createElement("div", { style: styles.err }, String(attempt.error).slice(0, 200)),
				!attempt.accepted && attempt.preview
					? React.createElement("div", { style: styles.detail }, `回复片段：${String(attempt.preview).replace(/\s+/g, " ").slice(0, 160)}`)
					: null
			);
		}

		/**
		 * Render one model's result card.
		 *
		 * @param props - the model report from the Node half.
		 * @returns the card element.
		 */
		function ModelCard({ model }) {
			const analysis = model.analysis;
			const decision = model.error
				? "unreachable"
				: analysis?.decision === "partial"
					? "partial"
					: analysis?.decision === "unscorable" || !analysis
						? "unscorable"
						: "identified";
			const verdict = VERDICTS[decision];
			return React.createElement("section", { style: styles.card },
				React.createElement("div", { style: styles.cardHead },
					React.createElement("span", { style: styles.model }, `${model.provider}/${model.model}`),
					React.createElement("span", { style: { ...styles.verdict, color: verdict.tone } },
						React.createElement("span", { style: { ...styles.dot, background: verdict.tone } }),
						verdict.label
					)
				),
				model.error
					? React.createElement("div", { style: styles.err }, String(model.error).slice(0, 300))
					: null,
				analysis && analysis.prediction
					? React.createElement("div", { style: styles.prediction },
							React.createElement("span", { style: styles.muted }, "最接近"),
							React.createElement("span", { style: styles.predictionName }, analysis.prediction_name ?? analysis.prediction),
							analysis.probability !== null && analysis.probability !== undefined
								? React.createElement("span", { style: styles.muted }, `置信度 ${percent(analysis.probability)}`)
								: null
						)
					: null,
				React.createElement("div", { style: styles.tiers },
					React.createElement("span", null, `有效回答 ${model.accepted}/${model.total}`),
					analysis?.calibration?.tau !== undefined
						? React.createElement("span", { style: styles.muted }, `温度 ${analysis.calibration.tau.toFixed(3)}`)
						: null
				),
				React.createElement("div", { style: styles.note }, analysis?.evidence?.reason ?? verdict.note),
				React.createElement(Ranking, { results: analysis?.results }),
				(model.attempts ?? []).map((attempt) => React.createElement(AttemptRow, { key: attempt.challengeId, attempt }))
			);
		}

		/**
		 * The model picker.
		 *
		 * Selection is the user's, not a hard-coded pattern: the panel asks the
		 * Node half for the full provider/model catalog and sends back exactly
		 * what is ticked. Grouping by provider keeps a long list readable.
		 *
		 * @param props - catalog, current selection, and change handlers.
		 * @returns the picker element.
		 */
		function ModelPicker({ catalog, selected, onToggle, onSelectAll, onSelectNone, loading, error, onReload }) {
			const models = catalog?.models ?? [];
			const byProvider = new Map();
			for (const entry of models) {
				if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
				byProvider.get(entry.provider).push(entry);
			}
			const key = (entry) => `${entry.provider}/${entry.model}`;
			const allSelected = models.length > 0 && models.every((m) => selected.has(key(m)));

			return React.createElement("section", { style: styles.picker },
				React.createElement("div", { style: styles.pickerHead },
					React.createElement("span", { style: styles.pickerTitle },
						loading ? "正在读取模型列表…" : `选择要检测的模型（已选 ${selected.size} / ${models.length}）`
					),
					React.createElement("span", { style: { display: "flex", gap: "12px", alignItems: "center" } },
						React.createElement("button", {
							type: "button", style: styles.linkBtn,
							onClick: () => (allSelected ? onSelectNone() : onSelectAll()),
							disabled: loading || models.length === 0
						}, allSelected ? "全不选" : "全选"),
						React.createElement("button", {
							type: "button", style: styles.linkBtn, onClick: onReload, disabled: loading
						}, "刷新")
					)
				),
				error !== null && React.createElement("div", { style: styles.err }, `读取模型列表失败：${error}`),
				!loading && error === null && models.length === 0 &&
					React.createElement("div", { style: styles.muted }, "没有可用的模型。"),
				(catalog?.failed ?? []).length > 0 && React.createElement("div", { style: styles.detail },
					`部分 provider 读取失败：${catalog.failed.map((f) => `${f.provider}（${f.error}）`).join("；")}`
				),
				Array.from(byProvider.entries()).map(([provider, entries]) =>
					React.createElement("div", { key: provider, style: { display: "flex", flexDirection: "column", gap: "5px" } },
						React.createElement("div", { style: { ...styles.muted, fontSize: "11px" } }, provider),
						React.createElement("div", { style: styles.grid },
							entries.map((entry) => {
								const id = key(entry);
								const checked = selected.has(id);
								return React.createElement("label", { key: id, style: styles.modelItem, title: id },
									React.createElement("input", { type: "checkbox", checked, onChange: () => onToggle(id) }),
									React.createElement("span", { style: styles.modelName }, entry.model)
								);
							})
						)
					)
				)
			);
		}

		/**
		 * The fingerprint panel.
		 *
		 * @returns the panel element.
		 */
		function FingerprintPanel() {
			// Re-render on every store change; the store outlives this component.
			const [, forceRender] = React.useState(0);
			React.useEffect(() => {
				const listener = () => forceRender((n) => n + 1);
				panelListeners.add(listener);
				return () => { panelListeners.delete(listener); };
			}, []);

			const [catalog, setCatalog] = React.useState(null);
			const [catalogError, setCatalogError] = React.useState(null);
			const [loadingModels, setLoadingModels] = React.useState(true);
			const selected = panelState.selected ?? new Set();

			const loadModels = React.useCallback(async () => {
				setLoadingModels(true);
				setCatalogError(null);
				try {
					const response = await fetch(api(MODELS_ROUTE));
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					setCatalog(payload);
					// Preselect the profile's configured targets, but never
					// overwrite a selection the user already made — reloading the
					// catalog (or remounting the panel) must not reset the ticks.
					if (panelState.selected === null) {
						setPanelState({ selected: new Set(payload.defaults ?? []) });
					}
				} catch (error) {
					setCatalogError(error instanceof Error ? error.message : String(error));
				} finally {
					setLoadingModels(false);
				}
			}, []);

			React.useEffect(() => { loadModels(); }, [loadModels]);

			// Adopt a run already in progress. This is what makes a conversation
			// switch safe: the host owns the job, so a remounted panel rejoins it
			// instead of showing an idle frame.
			const poll = React.useCallback(async () => {
				try {
					const response = await fetch(api(ROUTE));
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					if (payload.phase === "running") {
						setPanelState({ phase: "running", report: payload.models?.length ? payload : panelState.report, jobId: payload.id ?? panelState.jobId, error: null });
					} else if (payload.phase === "idle") {
						setPanelState({ phase: "idle", report: null, jobId: null, error: null });
					} else {
						setPanelState({
							phase: payload.phase === "error" ? "error" : "done",
							report: payload,
							jobId: null,
							error: payload.error ?? null
						});
					}
				} catch (error) {
					setPanelState({ phase: "error", report: null, error: error instanceof Error ? error.message : String(error) });
				}
			}, []);

			// Poll only while running, and re-check once on mount so a panel
			// opened mid-run (or after a session switch) catches up at once.
			React.useEffect(() => {
				let cancelled = false;
				let timer;
				const tick = async () => {
					if (cancelled) return;
					await poll();
					if (!cancelled && panelState.phase === "running") timer = setTimeout(tick, 3000);
				};
				if (panelState.phase === "running") tick();
				else poll();
				return () => { cancelled = true; clearTimeout(timer); };
			}, [poll, panelState.phase]);

			const toggle = React.useCallback((id) => {
				const next = new Set(panelState.selected ?? []);
				if (next.has(id)) next.delete(id); else next.add(id);
				setPanelState({ selected: next });
			}, []);
			const selectAll = React.useCallback(() => {
				setPanelState({ selected: new Set((catalog?.models ?? []).map((m) => `${m.provider}/${m.model}`)) });
			}, [catalog]);
			const selectNone = React.useCallback(() => setPanelState({ selected: new Set() }), []);

			const run = React.useCallback(async () => {
				setPanelState({ phase: "running", report: null, error: null, jobId: null });
				try {
					const response = await fetch(api(ROUTE), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ models: Array.from(panelState.selected ?? []) })
					});
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					// The POST only acknowledges the start; the poll loop above
					// carries the run to completion, so navigating away now is safe.
					setPanelState({ jobId: payload.id ?? null });
				} catch (error) {
					setPanelState({ phase: "error", report: null, error: error instanceof Error ? error.message : String(error) });
				}
			}, []);

			const running = panelState.phase === "running";
			const report = panelState.report;
			const canRun = !running && !loadingModels && selected.size > 0;
			const reference = catalog?.reference;

			return React.createElement("div", { style: styles.root },
				React.createElement("header", null,
					React.createElement("div", { style: styles.header },
						React.createElement(FingerprintIcon, { size: 18 }),
						React.createElement("h2", { style: styles.title }, "模型指纹检测")
					),
					React.createElement("p", { style: styles.sub },
						"让模型写几百个「随机」整数，再和参考库比对分布——不问它自己是谁，只看它实际怎么取值。",
						"每个模型跑 3 条挑战，条数与语言随机；三条都有效才给出校准置信度。"
					)
				),
				React.createElement(ModelPicker, {
					catalog, selected, loading: loadingModels, error: catalogError,
					onToggle: toggle, onSelectAll: selectAll, onSelectNone: selectNone, onReload: loadModels
				}),
				React.createElement("div", { style: styles.bar },
					React.createElement(primitives.Button, { variant: "primary", size: "sm", onClick: run, disabled: !canRun },
						running ? "检测中…" : "开始检测"
					),
					selected.size === 0 && !loadingModels &&
						React.createElement("span", { style: styles.muted },
							(models?.length ?? 0) > 0
								? "请至少选择一个模型"
								: "没有可用的模型"
						),
					selected.size === 0 && !loadingModels && (models?.length ?? 0) > 0 && (catalog?.modelPattern ?? null) !== null &&
						React.createElement("span", { style: styles.muted },
							`（配置的 modelPattern「${catalog.modelPattern}」没有匹配到模型，请手动勾选）`
						),
					reference
						? React.createElement("span", { style: styles.muted },
								`参考库 ${reference.models.length} 个模型` +
									(catalog?.cache?.cached === false ? "（检测器需首次下载约 4 MB）" : "")
							)
						: null
				),
				panelState.error !== null && React.createElement("div", { style: styles.err }, `检测失败：${panelState.error}`),
				running && React.createElement("div", { style: styles.empty },
					"正在逐个模型生成整数序列。每个模型 3 条挑战。",
					"检测在后台进行，可以切到别的对话或别的面板，回来时会自动接上。"
				),
				!running && report === null && panelState.error === null &&
					React.createElement("div", { style: styles.empty }, "选好模型后点击「开始检测」运行指纹检测。"),
				report !== null && (report.models?.length ?? 0) === 0 &&
					React.createElement("div", { style: styles.empty }, "没有匹配到模型。请检查插件的 provider / models 配置。"),
				report !== null && (report.models?.length ?? 0) > 0 &&
					React.createElement("div", { style: styles.caveat },
						"结果说明：这是「在参考库 58 个模型里的相对排名」，不是身份证明。",
						"库外模型同样会得到一个最接近的候选和置信度；置信度是库内闭集相对概率，不包含库外模型。",
						"因此它适合用来发现「声称 A 实际像 B」这类偏差，不适合用来断言某个模型一定是什么。"
					),
				(report?.models ?? []).map((model) =>
					React.createElement(ModelCard, { key: `${model.provider}/${model.model}`, model })
				)
			);
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * Register the sidebar button and its panel body.
		 *
		 * Both registrations must share one id: the rail renders the button from
		 * `sidebar.panellist`, and `layout.selectPanel(id)` throws unless a `main`
		 * entry with the same key exists.
		 *
		 * `order` is 42, one above the coding probe's 41, so this entry sits
		 * directly below it in the rail.
		 *
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, FingerprintPanel));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 42,
				label: () => "模型指纹检测"
			}, FingerprintIcon));
		}

		Object.assign(module.exports, { FingerprintPanel, ModelPicker, PANEL_ID, apply, inject });
		return module.exports;
	}
});
