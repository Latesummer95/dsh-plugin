/**
 * dsh-goal-autoresume — keep an armed goal alive across loop-guard failures.
 *
 * `dsh-goal-round-driver` disarms the goal on *every* `agent/error`:
 *
 *   ctx.on("agent/error", ({ agent }) => { disarm(stateFor(agent)); })
 *
 * That is the right default, but it means an unattended long run stops dead the
 * first time a step exhausts its retry budget. The `a1` route degenerates
 * intermittently in its reasoning channel, so `llm-loop-guard` will occasionally
 * burn all attempts on one step and fail the turn — and a human who is not
 * watching never learns that the goal was disarmed.
 *
 * This listener re-arms the goal, but only for the specific failure the loop
 * guard produces, and only a bounded number of times per goal revision. Other
 * errors keep the upstream behaviour untouched, and a persistently broken route
 * still stops instead of looping forever.
 *
 * Listener order matters: this plugin is inserted after the bundles, so its
 * `agent/error` listener is registered after the round driver's and therefore
 * runs after the disarm it is compensating for.
 *
 * @module dsh-goal-autoresume
 */

import z from "@deepseek-ai/schemastery";

const name = "goal-autoresume";

/**
 * The plugin's own settings, surfaced in the Settings page.
 *
 * `enabled` is the field the toggle row writes. It is `volatile` so flipping it
 * does not restart the plugin, which would clear the per-goal auto-resume budget
 * and hand back a goal the user had deliberately left disarmed. The flag is read
 * per event instead, so the next failure already honours it.
 */
export const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	maxAutoResumes: z.number().step(1).min(0).default(3).volatile()
});

/** Default markers identifying a loop-guard failure. */
const DEFAULT_MARKERS = ["llm-loop-guard"];

const DEFAULTS = {
	/**
	 * How many times one goal may be re-armed. A bound is required: if the route
	 * is persistently broken, unbounded re-arming would spin forever and hide it.
	 */
	maxAutoResumes: 3,
	/** Substrings that identify the guard's synthetic failure message. */
	markers: DEFAULT_MARKERS
};

/** Read the human-readable text of an unknown thrown value. */
function renderError(error) {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : String(error ?? "");
}

/**
 * Re-arm a disarmed goal when a loop-guard failure ended the turn.
 *
 * @param ctx - the plugin context.
 * @param config - optional overrides for {@link DEFAULTS}.
 */
function apply(ctx, config = {}) {
	// Re-read on every error so the Settings switch takes effect immediately.
	// A boot-time snapshot would need a plugin restart, which would clear the
	// per-goal budget and re-arm goals the user had deliberately left disarmed.
	const readConfig = () => {
		try {
			const entry = ctx.loader?.entries?.().find?.(
				(candidate) => candidate?.fiber?.runtime?.name === name,
			);
			return { ...DEFAULTS, ...(entry?.options?.config ?? config) };
		} catch {
			return { ...DEFAULTS, ...config };
		}
	};

	/**
	 * Per-agent auto-resume budget.
	 *
	 * Keyed by goal id **and revision**, not by id alone. A revision bump means the
	 * user edited the objective, which is a new instruction to keep going — keying on
	 * the id would leave a goal that already spent its budget disarmed forever, even
	 * after being redefined. It is also the pair actually passed to `resume`, so the
	 * budget now counts attempts at the same objective rather than at the same id.
	 */
	const budgets = new WeakMap();
	ctx.on("agent/error", ({ agent, error }) => {
		const cfg = readConfig();
		// Absent means on; any explicitly falsy value means off, for the same
		// reason as the loop guard: the config is not always schema-validated.
		if (cfg.enabled !== undefined && !cfg.enabled) return;
		// Derived per event, not once at mount: `readConfig()` re-reads on every
		// error precisely so a profile edit takes effect without a restart, and
		// freezing the markers here would silently ignore the very reload the
		// config read exists to support.
		const markers = Array.isArray(cfg.markers) && cfg.markers.length > 0 ? cfg.markers : DEFAULT_MARKERS;
		const text = renderError(error);
		if (!markers.some((marker) => text.includes(marker))) return;
		const goals = ctx.goals;
		if (goals === void 0) return;
		const goal = goals.get(agent);
		if (goal === void 0) return;
		const goalRevision = goal.revision ?? null;
		let budget = budgets.get(agent);
		if (budget === void 0 || budget.goalId !== goal.id || budget.revision !== goalRevision) {
			budget = {
				goalId: goal.id,
				revision: goalRevision,
				used: 0
			};
			budgets.set(agent, budget);
		}
		const maxAutoResumes = Number.isFinite(cfg.maxAutoResumes) && cfg.maxAutoResumes > 0 ? Math.floor(cfg.maxAutoResumes) : DEFAULTS.maxAutoResumes;
		if (budget.used >= maxAutoResumes) {
			ctx.logger?.warn("goal-autoresume: goal \"%s\" already used %d auto-resumes; leaving it disarmed", goal.id, budget.used);
			return;
		}
		budget.used += 1;
		try {
			goals.resume(agent, {
				id: goal.id,
				revision: goal.revision
			});
			ctx.logger?.warn("goal-autoresume: re-armed goal \"%s\" after a loop-guard failure (%d/%d)", goal.id, budget.used, maxAutoResumes);
		} catch (resumeError) {
			ctx.logger?.warn("goal-autoresume: could not re-arm goal \"%s\": %s", goal.id, renderError(resumeError));
		}
	}, { global: true });
}

export { DEFAULTS, apply, name };
