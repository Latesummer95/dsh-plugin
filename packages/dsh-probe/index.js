/**
 * dsh-probe — one panel for asking whether a route is really doing the work.
 *
 * ## Why one plugin
 *
 * Two probes answered the same question from different angles and shipped as two
 * sidebar entries:
 *
 *   - **encoding** asks the model to *build* something and then actually runs it.
 *     A route can pass a control task and still emit code that does not execute,
 *     which is the signature of degraded high-complexity generation. Grading reads
 *     back what ran, never the source.
 *   - **fingerprint** asks the model to *count* integers in a known-hard pattern
 *     and compares the digit-frequency distribution against a reference bank. It
 *     catches a substitution that still writes fluent code.
 *
 * They share everything except the question: the model picker, the run registry
 * that keeps a run alive while the user switches conversations, the background
 * `202` + poll protocol, and the verdict card. Two entries meant two copies of
 * that machinery and two places for the state bug to hide, so they are mounted
 * as one plugin with one panel and two tabs.
 *
 * The two halves stay separate modules — `dsh-coding-probe` and
 * `dsh-fingerprint-probe` — and this package only mounts their `apply`. That
 * keeps one source of truth for each probe: the browser battery, the grading
 * thresholds and the reference bank are unchanged, not copied.
 *
 * ## Route prefixes are unchanged
 *
 * Each half keeps its own prefix (`/coding-probe`, `/fingerprint-probe`), so an
 * old client bundle, a bookmarked panel or a run started before the merge all
 * keep working. The merge changes where the buttons live, not the API.
 *
 * @module dsh-probe
 */

import * as coding from "dsh-coding-probe";
import * as fingerprint from "dsh-fingerprint-probe";

/** Host plugin name, as referenced by the profile patch. */
export const name = "probe";

/**
 * Both halves need `llm` (to generate) and `webServer` (to expose their routes).
 * `loader` is declared so the sub-modules' own `inject` lists resolve; cordis
 * resolves each module's declared services against this fiber.
 */
export const inject = ["webServer", "llm", "loader"];

/** The two probes, in panel order. */
export const HALVES = [
	{
		id: "coding",
		label: "编码能力",
		module: coding
	},
	{
		id: "fingerprint",
		label: "模型指纹",
		module: fingerprint
	}
];

/**
 * Mount both halves.
 *
 * Each `apply` is handed the same context and a *namespaced* config slice, so
 * `coding: {complexTrials: 3}` and `fingerprint: {spacingMs: 0}` stay separately
 * configurable in the profile patch. A config written for the standalone plugins
 * (`{provider, modelPattern, …}` at the top level) is forwarded to both halves as
 * a fallback, so an existing patch keeps working after the merge.
 *
 * @param ctx - the plugin context.
 * @param config - shared settings, plus optional per-half slices keyed by half id.
 * @param halves - the halves to mount; {@link HALVES} in production. Injectable so
 * the merge behaviour can be tested without mutating frozen ESM namespaces.
 */
export function apply(ctx, config = {}, halves = HALVES) {
	const shared = config ?? {};

	for (const half of halves) {
		// A half that fails to mount must not take the other one down with it: a
		// missing reference bank should cost the fingerprint tab, not the panel.
		try {
			half.module.apply(ctx, { ...shared, ...(config[half.id] ?? {}) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.logger?.warn?.(`dsh-probe: %s half failed to mount: %s`, half.id, message);
		}
	}
}

export { coding, fingerprint };