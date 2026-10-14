window.__DSH_PROBE_MERGED__ = true;

window.__ModuleLoader__.load({
	id: "dsh-probe",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// Each half's client bundle IS its package's client half, so the subpath
		// and the bare name resolve to the same exports.
		const coding = require("dsh-coding-probe/client");
		const fingerprint = require("dsh-fingerprint-probe/client");

		const PANEL_ID = "probe";

		/** The tabs; `component` is the half's own panel body. */
		const TABS = [
			{ id: "coding", label: "编码能力", component: coding.ProbePanel },
			{ id: "fingerprint", label: "模型指纹", component: fingerprint.FingerprintPanel }
		];

		/**
		 * The selected tab lives at module scope, not in component state: the panel
		 * unmounts whenever the user switches conversation, and the tab they were on
		 * should survive that exactly like the probe's run does.
		 */
		let active = TABS[0].id;
		const tabListeners = new Set();

		function setActive(id) {
			active = id;
			for (const listener of tabListeners) listener();
		}

		/** The panel: a tab strip plus the active half's own body. */
		function ProbePanel() {
			const [, force] = React.useReducer((n) => n + 1, 0);
			React.useEffect(() => {
				tabListeners.add(force);
				return () => tabListeners.delete(force);
			}, []);

			const current = TABS.find((tab) => tab.id === active) ?? TABS[0];
			const Body = current.component;

			return React.createElement(
				"div",
				{ style: styles.wrap },
				React.createElement(
					"div",
					{ style: styles.tabs, role: "tablist" },
					TABS.map((tab) => React.createElement("button", {
						key: tab.id,
						type: "button",
						role: "tab",
						"aria-selected": tab.id === current.id,
						style: tab.id === current.id ? styles.tabActive : styles.tab,
						onClick: () => setActive(tab.id)
					}, tab.label))
				),
				React.createElement(Body, null)
			);
		}

		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 },
			tabs: {
				display: "flex",
				gap: 4,
				padding: 3,
				borderRadius: 9,
				background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
				flex: "0 0 auto"
			},
			tab: {
				appearance: "none",
				border: 0,
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				font: "inherit",
				fontSize: 13,
				padding: "6px 12px",
				borderRadius: 7,
				cursor: "pointer",
				flex: 1
			},
			tabActive: {
				appearance: "none",
				border: 0,
				background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.22))",
				color: "var(--dsw-alias-label-primary)",
				font: "inherit",
				fontSize: 13,
				fontWeight: 600,
				padding: "6px 12px",
				borderRadius: 7,
				cursor: "pointer",
				flex: 1
			}
		};

		/**
		 * The rail glyph.
		 *
		 * The slot takes a component, not a node: passing `null` crashes the rail
		 * (React error #130), so this falls back to a text glyph when the
		 * primitives bundle has no matching icon.
		 */
		function ProbeIcon(props) {
			const Glyph = primitives.IconGaugeOutlineRegular ?? primitives.IconGaugeOutline;
			if (Glyph !== undefined) return React.createElement(Glyph, { size: props?.size ?? 16 });
			return React.createElement("span", { "aria-hidden": "true" }, "\u2318");
		}

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * Register the sidebar button and its panel body.
		 *
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, ProbePanel));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 41,
				label: () => "能力检测"
			}, ProbeIcon));
		}

		Object.assign(module.exports, { PANEL_ID, ProbePanel, ProbeIcon, TABS, apply, inject });
		return module.exports;
	}
});