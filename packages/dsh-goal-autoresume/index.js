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

const name = "goal-autoresume";

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
	const cfg = {
		...DEFAULTS,
		...config
	};
	const markers = Array.isArray(cfg.markers) && cfg.markers.length > 0 ? cfg.markers : DEFAULT_MARKERS;
	const maxAutoResumes = Number.isFinite(cfg.maxAutoResumes) && cfg.maxAutoResumes > 0 ? Math.floor(cfg.maxAutoResumes) : DEFAULTS.maxAutoResumes;
	/** Per-agent auto-resume budget, keyed by the goal it was issued for. */
	const budgets = new WeakMap();
	ctx.on("agent/error", ({ agent, error }) => {
		const text = renderError(error);
		if (!markers.some((marker) => text.includes(marker))) return;
		const goals = ctx.goals;
		if (goals === void 0) return;
		const goal = goals.get(agent);
		if (goal === void 0) return;
		let budget = budgets.get(agent);
		if (budget === void 0 || budget.goalId !== goal.id) {
			budget = {
				goalId: goal.id,
				used: 0
			};
			budgets.set(agent, budget);
		}
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
