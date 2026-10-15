/**
 * Guard settings — browser half for `dsh-llm-loop-guard` and `dsh-goal-autoresume`.
 *
 * Both plugins exist for one reason: an unattended long run must not die quietly.
 * The loop guard discards a degenerate stream so the step can be retried, and the
 * auto-resumer re-arms a goal the round driver disarmed when that happened. Both
 * are useful by default and both are worth being able to switch off, so each gets
 * one row in Settings → General.
 *
 * Two plugins, one bundle: the rows are two fields of the same switch-list, and a
 * separate bundle would mean a second `settings.general.item` registration and a
 * second entry in the profile for nothing.
 *
 * Hand-written bundle: no JSX and no build step, matching the shipped client
 * bundles' `window.__ModuleLoader__.load({id, factory})` shape.
 *
 * @module dsh-guards/client
 */

window.__ModuleLoader__.load({
	id: "dsh-llm-loop-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/**
		 * The rows, in the order they should appear in the section.
		 *
		 * `namespace` is the loader entry id, which is also the configForms
		 * namespace for that plugin's `Config`. `order` keeps them adjacent and above
		 * the built-in rows, because they are the ones a user looks for precisely
		 * because they are looking for a guard.
		 */
		const ROWS = [
			{
				id: "loop-guard-enabled",
				order: 13,
				namespace: "llm-loop-guard",
				title: "启用重复内容防护",
				description: "模型输出退化成同一段话反复循环、或单次输出失控变成长文本时，中断这次尝试并让上一步重试。关闭后不再拦截，退化的输出会直接进入对话。"
			},
			{
				id: "goal-autoresume-enabled",
				order: 14,
				namespace: "goal-autoresume",
				title: "长任务自动续跑",
				description: "当一次尝试因重复内容防护失败而结束时，自动重新武装被解除的目标，让无人看管的长任务继续跑。每个目标有次数上限，避免一直坏着的路由把任务空转下去。"
			}
		];

		/**
		 * One switch row bound to one plugin's volatile config.
		 *
		 * @param props - injected faces: the settings transport, and the row copy.
		 * @returns the row element.
		 */
		function GuardRow({ settings, title, description }) {
			const [, force] = React.useReducer((n) => n + 1, 0);
			const [pending, setPending] = React.useState(false);

			React.useEffect(() => {
				if (typeof settings?.subscribe !== "function") return undefined;
				return settings.subscribe(() => force());
			}, [settings]);

			// A plugin that is not installed, or whose entry is still loading, has no
			// form yet. Render nothing rather than a switch that writes nowhere.
			if (typeof settings?.getSnapshot !== "function") return null;

			const snapshot = settings.getSnapshot();
			const enabled = snapshot.value?.enabled !== false;
			// `ConfigFormSnapshot` has no `error` field — its states are
			// `loading | ready | unavailable`. Reading a field that does not exist made
			// this always `null`, so the warning row below could never render, and a
			// client whose preferences are process-local (memory mode) was shown a
			// switch that silently did nothing.
			const unavailable = snapshot.status === "unavailable";
			const unavailableText = "当前连接无法保存设置（可能处于内存模式），此开关不会生效。";

			const onChange = async (next) => {
				setPending(true);
				try {
					await settings.set("enabled", next);
				} catch {
					// The transport surfaces the refusal through its snapshot error;
					// swallowing here keeps the switch from flipping optimistically on a
					// write that did not land.
				} finally {
					setPending(false);
				}
			};

			return React.createElement(
				"div",
				{ style: ROW },
				React.createElement(
					"div",
					{ style: ROW_TEXT },
					React.createElement("div", { style: ROW_TITLE }, title),
					React.createElement("div", { style: ROW_DESC }, description),
					unavailable && React.createElement("div", { style: ROW_ERROR }, unavailableText)
				),
				React.createElement(primitives.Switch, {
					checked: enabled,
					disabled: pending,
					onChange,
					label: title
				})
			);
		}

		const ROW = {
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

		/** Required services: the slot registry and the settings transport. */
		const inject = ["slots", "configForms"];

		/**
		 * Register both rows inside the Settings → General section.
		 *
		 * Each row asks for its own namespace inside `inject`, so a missing plugin
		 * only takes its own row down and leaves the other one working.
		 *
		 * @param ctx - the client root context.
		 */
		function apply(ctx) {
			for (const row of ROWS) {
				ctx.slots.inject("settings.general.item", () => ctx.slots.register({
					name: "settings.general.item",
					id: row.id,
					order: row.order,
					inject: () => ({
						settings: ctx.configForms.get(row.namespace),
						title: row.title,
						description: row.description
					})
				}, GuardRow));
			}
		}

		Object.assign(module.exports, { ROWS, GuardRow, apply, inject });
		return module.exports;
	}
});