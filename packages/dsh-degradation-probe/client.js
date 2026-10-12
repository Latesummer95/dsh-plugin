/**
 * degradation-probe — browser half.
 *
 * Renders a sidebar panel that runs the probe battery on demand and shows, per
 * model, whether the route looks healthy, reasoning-capped, or swapped for a
 * weaker model. All scoring happens on the Node half; this module only renders
 * what the route returns, so a bad route cannot be presented as a good one.
 *
 * Hand-written bundle: no JSX and no build step, matching the shipped client
 * bundles' `window.__ModuleLoader__.load({id, factory})` shape. Elements are
 * built with `React.createElement`.
 *
 * @module dsh-degradation-probe/client
 */

window.__ModuleLoader__.load({
	id: "dsh-degradation-probe",
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

		const PANEL_ID = "degradation-probe";
		const ROUTE = "degradation-probe/run";

		/** Verdict presentation: colour token, Chinese label, and one-line meaning. */
		const VERDICTS = {
			healthy: { tone: "#3fb950", label: "正常", note: "全部探针通过，该路由未检出降智。" },
			weak: { tone: "#d29922", label: "偏弱", note: "难题部分失败，能力低于健康基线。" },
			capped: { tone: "#db8b0b", label: "推理受限", note: "简单题全过、难题失败：推理预算可能被削减。" },
			degraded: { tone: "#f85149", label: "已降智", note: "简单题即失败：该路由疑似被换成更弱的模型。" },
			unreachable: { tone: "#8b949e", label: "不可达", note: "全部探针请求失败，无法评估。" }
		};

		/** Resolve a document-relative URL so the app works under any mount point. */
		function api(path) {
			const relative = String(path).replace(/^\/+/, "");
			if (typeof document === "undefined") return `/${relative}`;
			return new URL(relative, document.baseURI).pathname;
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
			tiers: { display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "12px", opacity: 0.8 },
			grid: { display: "grid", gridTemplateColumns: "1fr auto auto", gap: "4px 10px", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
			pass: { color: "#3fb950" },
			fail: { color: "#f85149" },
			muted: { opacity: 0.6 },
			empty: { opacity: 0.6, padding: "28px 0", textAlign: "center", fontSize: "12px" },
			err: { color: "#f85149", fontSize: "12px", lineHeight: 1.6 }
		};

		/**
		 * Sidebar rail icon.
		 *
		 * @returns the gauge glyph used by the panel list.
		 */
		function ProbeIcon(props) {
			const Glyph = primitives.IconGaugeOutlineRegular ?? primitives.IconGaugeOutline;
			if (Glyph !== undefined) return React.createElement(Glyph, { size: props?.size ?? 16 });
			return React.createElement("span", { "aria-hidden": "true" }, "\u25CE");
		}

		/**
		 * Render one probe row.
		 *
		 * @param props - the probe result record.
		 * @returns the row element.
		 */
		function ProbeRow({ row }) {
			const detail = row.error !== undefined
				? React.createElement("span", { style: styles.err }, "请求失败")
				: React.createElement("span", { style: row.ok ? styles.pass : styles.fail }, row.ok ? "通过" : "失败");
			return React.createElement(React.Fragment, null,
				React.createElement("span", { style: styles.muted }, `${row.label} · ${row.tier}`),
				React.createElement("span", null, detail),
				React.createElement("span", { style: styles.muted }, row.got === null || row.got === undefined ? "—" : String(row.got).slice(0, 14))
			);
		}

		/**
		 * Render one model's verdict card.
		 *
		 * @param props - the model report from the Node half.
		 * @returns the card element.
		 */
		function ModelCard({ model }) {
			const verdict = VERDICTS[model.score?.verdict] ?? VERDICTS.unreachable;
			const s = model.score ?? {};
			const tiers = React.createElement("div", { style: styles.tiers },
				React.createElement("span", null, `简单 ${s.easy?.passed ?? 0}/${s.easy?.total ?? 0}`),
				React.createElement("span", null, `中等 ${s.medium?.passed ?? 0}/${s.medium?.total ?? 0}`),
				React.createElement("span", null, `困难 ${s.hard?.passed ?? 0}/${s.hard?.total ?? 0}`),
				React.createElement("span", { style: styles.muted }, `得分 ${s.passed ?? 0}/${s.total ?? 0}`)
			);
			return React.createElement("section", { style: styles.card },
				React.createElement("div", { style: styles.cardHead },
					React.createElement("span", { style: styles.model }, `${model.provider}/${model.model}`),
					React.createElement("span", { style: { ...styles.verdict, color: verdict.tone } },
						React.createElement("span", { style: { ...styles.dot, background: verdict.tone } }),
						verdict.label
					)
				),
				tiers,
				React.createElement("div", { style: styles.note }, verdict.note),
				React.createElement("div", { style: styles.grid },
					(model.results ?? []).map((row) => React.createElement(ProbeRow, { key: row.id, row }))
				)
			);
		}

		/**
		 * The probe panel.
		 *
		 * @returns the panel element.
		 */
		function ProbePanel() {
			const [state, setState] = React.useState({ phase: "idle", report: null, error: null });

			const run = React.useCallback(async () => {
				setState({ phase: "running", report: null, error: null });
				try {
					const response = await fetch(api(ROUTE), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
					const payload = await response.json();
					if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
					setState({ phase: "done", report: payload, error: null });
				} catch (error) {
					setState({ phase: "error", report: null, error: error instanceof Error ? error.message : String(error) });
				}
			}, []);

			const running = state.phase === "running";
			const report = state.report;

			return React.createElement("div", { style: styles.root },
				React.createElement("header", null,
					React.createElement("div", { style: styles.header },
						React.createElement(ProbeIcon, { size: 18 }),
						React.createElement("h2", { style: styles.title }, "降智检测")
					),
					React.createElement("p", { style: styles.sub },
						"用一组答案可独立验证的题目探测模型路由。简单题失败说明模型被换弱；",
						"简单题全过而难题失败，说明推理预算被削减。"
					)
				),
				React.createElement("div", { style: styles.bar },
					React.createElement(primitives.Button, { variant: "primary", size: "sm", onClick: run, disabled: running },
						running ? "检测中…" : "开始检测"
					),
					report !== null && React.createElement("span", { style: styles.muted },
						`共 ${report.models?.length ?? 0} 个模型 · 提示词档位 ${report.reasoningEffort ?? "默认"}`
					)
				),
				state.error !== null && React.createElement("div", { style: styles.err }, `检测失败：${state.error}`),
				running && React.createElement("div", { style: styles.empty }, "正在逐个探测，网关较慢时每个模型可能需要一两分钟…"),
				!running && report === null && state.error === null && React.createElement("div", { style: styles.empty }, "点击「开始检测」运行探针。"),
				report !== null && report.models?.length === 0 && React.createElement("div", { style: styles.empty }, "没有匹配到模型。请检查插件的 provider / modelPattern 配置。"),
				(report?.models ?? []).map((model) => React.createElement(ModelCard, { key: `${model.provider}/${model.model}`, model }))
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
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, ProbePanel));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 40,
				label: () => "降智检测"
			}, ProbeIcon));
		}

		const exports_ = { PANEL_ID, ProbePanel, apply, inject };
		Object.assign(module.exports, exports_);
		return module.exports;
	}
});
