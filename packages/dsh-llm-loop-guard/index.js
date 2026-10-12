/**
 * llm-loop-guard — cut off degenerate repetition in a model stream.
 *
 * Some provider routes intermittently degenerate into a short cycle repeated
 * thousands of times inside the reasoning channel (observed on one gateway: a
 * ~50-character cycle repeated 3782 times, growing a single response past
 * 189 KB, and in another client past 1.5 MB). The harness has no detection for
 * that shape: only a zero-content completion is classified as retryable, so a
 * degenerate stream simply runs until the user aborts, and the garbage is then
 * committed to the session surface and replayed on every later request.
 *
 * This listener wraps the `llm/stream` waterfall, watches the streaming text
 * deltas, and when the tail of the stream has become a short periodic cycle it
 * stops the upstream iterator and emits a terminal `error` finish instead.
 *
 * Why that fixes the session: `dsh-agent-loop` only appends the durable
 * `assistant/message` (the event that enters the conversation surface) when the
 * finish is normal. For an `error` finish it records an `assistant/attempt`
 * diagnostic and then consults `agent/request-error`. A retryable failure code
 * makes `dsh-llm-retry` replay the step, so the degenerate text is discarded
 * and the user sees at most a short delay instead of a poisoned session.
 *
 * @module dsh-llm-loop-guard
 */

const name = "llm-loop-guard";

/** Conservative defaults: trip only on unmistakable verbatim repetition. */
const DEFAULTS = {
	/** Ignore cycles shorter than this; short repeats are usually formatting. */
	minCycleChars: 8,
	/**
	 * Ignore cycles longer than this. Measured degeneration on the a1 route used
	 * a 632-character cycle, so this must sit well above a "short phrase" bound.
	 */
	maxCycleChars: 1500,
	/** Absolute floor on consecutive identical cycles before tripping. */
	minRepeats: 4,
	/**
	 * Minimum total span of verbatim repetition. This is the real trip condition:
	 * it keeps the detection point roughly constant (~2 KiB) no matter how long
	 * the cycle is, and it makes short cycles need many more repeats.
	 */
	minRepeatedChars: 2048,
	/**
	 * Probe length used to locate a previous cycle boundary. Too short a probe
	 * anchors on a spurious nearer match and misses the real period, so this is
	 * deliberately long.
	 */
	probeChars: 48,
	/** Rolling window retained for detection; must exceed minRepeatedChars. */
	bufferChars: 16384,
	/** Watch the reasoning channel (where this route degenerates). */
	watchReasoning: true,
	/** Watch the visible text channel as well. */
	watchText: false,
	/** Retryable provider-neutral code carried by the synthetic failure. */
	failureCode: "SERVER"
};

/** How many candidate cycle lengths to test before giving up on a window. */
const CANDIDATE_LIMIT = 12;
/** Upper bound on the repeat-counting walk (guards pathological short cycles). */
const REPEAT_CAP = 4096;

/**
 * Count how many consecutive `cycleChars`-sized blocks identical to the final
 * block precede it.
 *
 * @param buf - rolling text window.
 * @param cycleChars - candidate cycle length.
 * @returns the consecutive repeat count, at least 1.
 */
function countRepeats(buf, cycleChars) {
	const sample = buf.slice(buf.length - cycleChars);
	let repeats = 1;
	let end = buf.length - cycleChars;
	while (repeats < REPEAT_CAP && end - cycleChars >= 0) {
		if (!buf.startsWith(sample, end - cycleChars)) break;
		repeats += 1;
		end -= cycleChars;
	}
	return repeats;
}

/**
 * Decide whether `buf` ends with a cycle repeated enough times to be
 * degeneration rather than ordinary prose.
 *
 * Cycle lengths come from the distances back to earlier occurrences of the
 * buffer's tail, and every plausible distance is tested. Testing only the
 * nearest occurrence is not enough: a spurious nearer alignment masks the real,
 * longer period, which is exactly how a 632-character degeneration escaped an
 * earlier 16-character-probe version of this check.
 *
 * @param buf - rolling text window.
 * @param cfg - resolved guard configuration.
 * @returns the detected cycle, or `null` when the tail is not degenerate.
 */
function detectCycle(buf, cfg) {
	const probe = cfg.probeChars;
	if (buf.length < probe * 2 + cfg.minCycleChars) return null;
	const tail = buf.slice(-probe);
	// A whitespace-only probe carries no evidence of degeneration.
	if (tail.trim().length === 0) return null;
	let searchEnd = buf.length - probe - 1;
	let tried = 0;
	while (searchEnd >= 0 && tried < CANDIDATE_LIMIT) {
		const previous = buf.lastIndexOf(tail, searchEnd);
		if (previous < 0) break;
		searchEnd = previous - 1;
		const cycleChars = buf.length - probe - previous;
		if (cycleChars > cfg.maxCycleChars) break;
		if (cycleChars < cfg.minCycleChars) continue;
		tried += 1;
		const sample = buf.slice(buf.length - cycleChars);
		// Reject cycles with no informational content.
		if (sample.trim().length === 0) continue;
		const repeats = countRepeats(buf, cycleChars);
		if (repeats >= cfg.minRepeats && repeats * cycleChars >= cfg.minRepeatedChars) {
			return {
				cycleChars,
				repeats,
				sample
			};
		}
	}
	return null;
}

/**
 * Build a stateful observer for one model call.
 *
 * @param cfg - resolved guard configuration.
 * @returns a function folding one delta into the window and reporting a cycle.
 */
function createObserver(cfg) {
	let buf = "";
	return (text) => {
		buf += text;
		if (buf.length > cfg.bufferChars) buf = buf.slice(-cfg.bufferChars);
		return detectCycle(buf, cfg);
	};
}

/**
 * Wrap one chunk stream, ending it early when the text degenerates.
 *
 * @param source - the downstream adapter stream.
 * @param cfg - resolved guard configuration.
 * @param onTrip - invoked once when the guard trips, for logging.
 * @returns the guarded chunk stream.
 */
function guardStream(source, cfg, onTrip) {
	const observe = createObserver(cfg);
	const feed = (chunk) => {
		if (chunk.type === "reasoning-delta" && cfg.watchReasoning) return observe(chunk.text);
		if (chunk.type === "text-delta" && cfg.watchText) return observe(chunk.text);
		return null;
	};
	return (async function* guarded() {
		// `next()` may return the iterable directly or a promise of it.
		const resolved = await source;
		const iterator = resolved[Symbol.asyncIterator]();
		let settled = false;
		const close = async () => {
			if (settled) return;
			settled = true;
			try {
				await iterator.return?.();
			} catch {
				/* the upstream stream is already failing; nothing to salvage */
			}
		};
		try {
			for (;;) {
				const step = await iterator.next();
				if (step.done) {
					settled = true;
					return;
				}
				const chunk = step.value;
				const trip = feed(chunk);
				if (trip !== null) {
					await close();
					onTrip(trip);
					yield {
						type: "finish",
						reason: {
							kind: "error",
							failure: {
								code: cfg.failureCode,
								message: `llm-loop-guard: degenerate repetition detected (${trip.repeats} consecutive ${trip.cycleChars}-char cycles); this attempt was discarded so the step can be retried`
							}
						}
					};
					return;
				}
				yield chunk;
			}
		} finally {
			await close();
		}
	})();
}

/**
 * Register the guard on the `llm/stream` waterfall.
 *
 * @param ctx - the plugin context.
 * @param config - optional overrides for {@link DEFAULTS}.
 */
function apply(ctx, config = {}) {
	const cfg = {
		...DEFAULTS,
		...config
	};
	ctx.on("llm/stream", (_options, next) => {
		const stream = next();
		// `next()` may hand back a promise of the iterable; normalize both shapes.
		return guardStream(stream, cfg, (trip) => {
			ctx.logger?.warn(
				"llm-loop-guard: aborted a degenerate stream (%d consecutive %d-char cycles, sample %o); retrying the step",
				trip.repeats,
				trip.cycleChars,
				trip.sample.slice(0, 80)
			);
		});
	}, { global: true });
}

export { DEFAULTS, apply, detectCycle, name };
