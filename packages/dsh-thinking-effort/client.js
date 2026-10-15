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

			const snapshot = settings.getSnapshot();
			const enabled = snapshot.value?.enabled !== false;
			// `ConfigFormSnapshot` has no `error` field — its states are
			// `loading | ready | unavailable`. Reading a field that does not exist
			// made this always `null`, so the warning row could never render, and a
			// client whose preferences are process-local (memory mode) or whose
			// namespace is not exposed was shown a switch that silently did nothing.
			const unavailable = snapshot.status === "unavailable";

			const onChange = async (next) => {
				setPending(true);
				try {
					await settings.set("enabled", next);
				} catch {
					// Nothing to render here: the transport reflects a rejected write
					// by leaving the snapshot's value unchanged, and the switch is
					// driven by that value.
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
			// Describes every route, because that is what the host half does: the
			// only guard left is "the route names an api", and gating on
			// `anthropic-messages` was the bug this replaced. The earlier copy said
			// "Anthropic 路由的每个模型", which described the old behaviour and made a
			// fixed plugin look unfixed.
			description: "打开后，所有路由（不只 Anthropic）里每个模型的模型选择器都会出现完整七档思考档位：off / minimal / low / medium / high / xhigh / max。已经在 profile 里自己写了 reasoningEfforts 的模型保持不动，标了不推理的模型跳过。关闭后恢复为 profile 里自己写的配置。",
			// Shown when the settings namespace is not writable from this client.
			unavailable: "当前连接无法保存设置（可能处于内存模式），此开关不会生效。"
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