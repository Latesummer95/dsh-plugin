/**
 * coding-probe — browser half.
 *
 * Renders a sidebar panel that runs the executable coding battery on demand and
 * shows, per model, which probes produced a working program. All execution and
 * grading happen on the Node half; this module only renders the report and the
 * raw evidence, so a model that ships code which does not run cannot be
 * presented as healthy.
 *
 * Hand-written bundle: no JSX and no build step, matching the shipped client
 * bundles' `window.__ModuleLoader__.load({id, factory})` shape. Elements are
 * built with `React.createElement`.
 *
 * @module dsh-coding-probe/client
 */

window.__ModuleLoader__.load({
	id: "dsh-coding-probe",
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

		const PANEL_ID = "coding-probe";
		const ROUTE = "coding-probe/run";

		/**
		 * Verdict presentation: colour, Chinese label, and what it means.
		 *
		 * `broken-code` and `timeout-bound` look the same on the surface but have
		 * different causes and different fixes, so they are kept apart.
		 */
		const VERDICTS = {
			healthy: { tone: "#3fb950", label: "正常", note: "对照组与复杂任务全部通过，复杂代码生成能力完整。" },
			unstable: { tone: "#db8b0b", label: "不稳定", note: "复杂任务只有部分次数成功。同一提示词重复跑结果不一致，说明生成质量在边界上波动。" },
			"broken-code": { tone: "#f85149", label: "复杂代码生成退化", note: "简单任务能过，复杂任务也能生成完，但产出的代码跑不起来或渲染不出内容。这正是降智的特征。" },
			"timeout-bound": { tone: "#f85149", label: "复杂任务全部失败", note: "简单任务能过，但复杂任务每次都生成失败（网关超时/中断），从未产出可用结果。" },
			degraded: { tone: "#db8b0b", label: "基础能力退化", note: "连对照组（基础 WebGL、事件循环）都失败，能力整体下降。" },
			unreachable: { tone: "#8b949e", label: "不可达", note: "全部请求失败，无法评估。" }
		};

		/** Per-probe kind labels, so the evidence reads without a legend. */
		const KINDS = {
			node: "执行 JS",
			render: "浏览器渲染",
			complex: "复杂任务×N"
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
			row: { display: "flex", flexDirection: "column", gap: "2px", paddingTop: "7px", borderTop: "1px solid rgba(127,127,127,.14)" },
			rowHead: { display: "flex", alignItems: "center", gap: "8px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
			detail: { fontSize: "11px", opacity: 0.6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all" },
			err: { fontSize: "11px", color: "#f85149", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all" },
			pass: { color: "#3fb950" },
			fail: { color: "#f85149" },
			muted: { opacity: 0.6 },
			empty: { opacity: 0.6, padding: "28px 0", textAlign: "center", fontSize: "12px" }
		};

		/**
		 * Sidebar rail icon.
		 *
		 * @param props - optional size.
		 * @returns the terminal glyph used by the panel list.
		 */
		function ProbeIcon(props) {
			const Glyph = primitives.IconGaugeOutlineRegular ?? primitives.IconGaugeOutline;
			if (Glyph !== undefined) return React.createElement(Glyph, { size: props?.size ?? 16 });
			return React.createElement("span", { "aria-hidden": "true" }, "\u2318");
		}

		/**
		 * Render one probe result with its raw evidence.
		 *
		 * The evidence line is the point: it shows what the program actually did,
		 * so a verdict can be audited instead of trusted.
		 *
		 * @param props - the probe result record.
		 * @returns the row element.
		 */
		function ProbeRow({ row }) {
			const evidence = row.evidence ?? {};
			const parts = [];
			if (row.kind === "render" && evidence.greenRatio !== undefined) parts.push(`绿色像素 ${Math.round(evidence.greenRatio * 100)}%`);
			if (row.kind !== "node" && evidence.nonblackRatio !== undefined) parts.push(`非黑像素 ${Math.round(evidence.nonblackRatio * 100)}%`);
			if (evidence.distinctColors !== undefined && row.kind !== "node") parts.push(`颜色数 ${evidence.distinctColors}`);
			if (evidence.canvasW) parts.push(`画布 ${evidence.canvasW}×${evidence.canvasH}`);
			if (evidence.stdout) parts.push(`stdout ${String(evidence.stdout).replace(/\s+/g, " ").slice(0, 60)}`);
			const message = row.error !== undefined
				? `生成失败：${row.error}`
				: (evidence.error ?? evidence.consoleErrors?.[0] ?? parts.join(" · ") ?? "");
			return React.createElement("div", { style: styles.row },
				React.createElement("div", { style: styles.rowHead },
					React.createElement("span", { style: row.ok ? styles.pass : styles.fail }, row.ok ? "通过" : "失败"),
					React.createElement("span", null, row.label),
					React.createElement("span", { style: styles.muted }, KINDS[row.kind] ?? row.kind)
				),
				React.createElement("div", { style: styles.detail }, row.detail ?? ""),
				message.length > 0 && React.createElement("div", { style: row.ok ? styles.detail : styles.err }, String(message).slice(0, 240)),
				(row.trials ?? []).map((trial) => React.createElement("div", {
					key: trial.attempt,
					style: { ...styles.detail, paddingLeft: "14px" }
				}, `第 ${trial.attempt} 次：${trial.generated ? (trial.ok ? "✓ 渲染成功" : `✗ ${trial.detail ?? "未渲染"}`) : `✗ 生成失败（${trial.error ?? "超时"}）`}`))
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
				React.createElement("span", null, `对照组 ${s.control?.passed ?? 0}/${s.control?.total ?? 0}`),
				React.createElement("span", null, `复杂任务 ${s.target?.passed ?? 0}/${s.target?.total ?? 0}`),
				(s.target?.generated ?? 0) < (s.target?.total ?? 0) &&
					React.createElement("span", { style: styles.muted }, `其中生成成功 ${s.target?.generated ?? 0} 次`)
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
				(model.results ?? []).map((row) => React.createElement(ProbeRow, { key: row.id, row }))
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
						React.createElement("h2", { style: styles.title }, "编码能力检测")
					),
					React.createElement("p", { style: styles.sub },
						"让模型生成代码，然后真的执行它、读回渲染结果来判分——不看源码，只看跑不跑得起来。",
						"对照组是基础任务（WebGL 三角形、事件循环），复杂任务用真实的完整 brief，重复多次以暴露间歇性失败。",
						"对照组能过、复杂任务跑不起来，就是复杂代码生成退化。"
					)
				),
				React.createElement("div", { style: styles.bar },
					React.createElement(primitives.Button, { variant: "primary", size: "sm", onClick: run, disabled: running },
						running ? "检测中…" : "开始检测"
					),
					report !== null && React.createElement("span", { style: styles.muted },
						`共 ${report.models?.length ?? 0} 个模型 · 复杂任务 ${report.complexTrials ?? 1} 次/模型 · 推理档位 ${report.reasoningEffort ?? "默认"}`
					)
				),
				state.error !== null && React.createElement("div", { style: styles.err }, `检测失败：${state.error}`),
				running && React.createElement("div", { style: styles.empty }, "正在逐个生成并执行代码。复杂任务每次生成可能需要 1–2 分钟，请耐心等待…"),
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
				order: 41,
				label: () => "编码能力检测"
			}, ProbeIcon));
		}

		Object.assign(module.exports, { PANEL_ID, ProbePanel, apply, inject });
		return module.exports;
	}
});
