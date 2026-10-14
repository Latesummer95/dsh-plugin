/**
 * thinking-effort — browser half.
 *
 * Contributes one row to the Settings → General page: a switch that turns the
 * thinking-level augmentation on or off without restarting DSH.
 *
 * Why a row and not a panel: the plugin owns exactly one preference, and the
 * General section is documented as "the additive seat for a single setting that
 * needs no page of its own (a whole page is `settings.section`)".
 *
 * The value lives in the host plugin's volatile config, so this module only
 * renders the current value and the write path — both through the shared
 * settings transport, which persists into the profile patch.
 *
 * Hand-written bundle: no JSX and no build step, matching the shipped client
 * bundles' `window.__ModuleLoader__.load({id, factory})` shape.
 *
 * @module dsh-thinking-effort/client
 */

window.__ModuleLoader__.load({
	id: "dsh-thinking-effort",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Host entry id; also the configForms namespace for this plugin's Config. */
		const NAMESPACE = "thinking-effort";

		/** Above the other plugin rows, so the switch is findable without scrolling. */
		const ORDER = 12;

		/**
		 * The row: a switch plus the sentence that explains what turning it on does.
		 *
		 * `configForms.get(namespace)` returns the settings transport for this
		 * plugin's entry. It exposes `getSnapshot()`, `subscribe()` and `set()`, and
		 * `set()` writes through the host into the profile patch, so a value written
		 * here survives a restart and a new machine.
		 *
		 * @param props - injected faces: the transport and a locale translator.
		 * @returns the row element.
		 */
		function ThinkingEffortRow({ settings, t }) {
			const [, force] = React.useReducer((n) => n + 1, 0);
			const [pending, setPending] = React.useState(false);

			React.useEffect(() => {
				if (typeof settings?.subscribe !== "function") return undefined;
				return settings.subscribe(() => force());
			}, [settings]);

			if (typeof settings?.getSnapshot !== "function") return null;

			const enabled = settings.getSnapshot().value?.enabled !== false;
			const error = settings.getSnapshot().error ?? null;

			const onChange = async (next) => {
				setPending(true);
				try {
					await settings.set("enabled", next);
				} catch {
					// The transport already surfaces the failure through its snapshot
					// error; swallowing here keeps the switch from flipping back on a
					// rejected write while the next snapshot renders the old value.
				} finally {
					setPending(false);
				}
			};

			return React.createElement(
				"div",
				{ className: "dsw-thinking-effort-row", style: ROW_STYLE },
				React.createElement(
					"div",
					{ style: ROW_TEXT },
					React.createElement("div", { style: ROW_TITLE }, t("title")),
					React.createElement("div", { style: ROW_DESC }, t("description")),
					error !== null && React.createElement("div", { style: ROW_ERROR }, String(error))
				),
				React.createElement(primitives.Switch, {
					checked: enabled,
					// Disabled only while the write is in flight, so a rejected write
					// snaps the switch back instead of claiming a change that stuck.
					disabled: pending,
					onChange,
					label: t("title")
				})
			);
		}

		const ROW_STYLE = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			padding: "10px 0"
		};
		const ROW_TEXT = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
		const ROW_TITLE = { fontSize: 14, color: "var(--dsw-alias-label-primary)" };
		const ROW_DESC = {
			fontSize: 12.5,
			lineHeight: 1.55,
			color: "var(--dsw-alias-label-secondary)"
		};
		const ROW_ERROR = { fontSize: 11.5, color: "var(--dsw-alias-state-error-primary)" };

		/**
		 * Copy for the row.
		 *
		 * Chinese-only on purpose: the plugin ships to one user, and a locale key
		 * that nothing can translate is worse than a direct string.
		 */
		const COPY = {
			title: "启用思考强度",
			description: "打开后，Anthropic 路由的每个模型都会在设置里出现思考档位选择器（low / medium / high / xhigh / max），并对支持自适应思考的模型补上兼容标记。关闭后恢复为 profile 里自己写的配置。"
		};

		/** Required services: the slot registry and the settings transport. */
		const inject = ["slots", "configForms"];

		/**
		 * Register the row inside the Settings → General section.
		 *
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "thinking-effort-enabled",
				order: ORDER,
				inject: () => ({
					settings: ctx.configForms.get(NAMESPACE),
					t: (key) => COPY[key] ?? key
				})
			}, ThinkingEffortRow));
		}

		Object.assign(module.exports, { COPY, NAMESPACE, ORDER, ThinkingEffortRow, apply, inject });
		return module.exports;
	}
});