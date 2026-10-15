/**
 * dsh-probe — one panel for asking whether a route is really doing the work.
 *
 * ## Why one plugin
 *
 * The probes answered the same question from different angles and shipped as
 * separate sidebar entries:
 *
 *   - **encoding** asks the model to *build* something and then actually runs it.
 *     A route can pass a control task and still emit code that does not execute,
 *     which is the signature of degraded high-complexity generation. Grading reads
 *     back what ran, never the source.
 *   - **fingerprint** asks the model to *count* integers in a known-hard pattern
 *     and compares the digit-frequency distribution against a reference bank. It
 *     catches a substitution that still writes fluent code.
 *   - **levels** asks the *same* question at every thinking level the route
 *     advertises and reports which levels actually change the answer. It answers
 *     "is `max` worth turning on here", which no single-level probe can.
 *
 * They share everything except the question: the model picker, the run registry
 * that keeps a run alive while the user switches conversations, the background
 * `202` + poll protocol, and the verdict card. Separate entries meant separate
 * copies of that machinery and separate places for the state bug to hide, so the
 * halves are mounted as one panel with one tab per probe.
 *
 * ## This package is a client-side host, not a mount point
 *
 * `apply` deliberately does **nothing** on the host. The halves are mounted by
 * their own loader rows in `cordis.patch.yml`, and this module must not mount
 * them a second time.
 *
 * That is not a style preference — it was a real defect. Mounting them here
 * re-registered every route the halves had already registered, the host rejected
 * the duplicate (`webserver: duplicate exact route`), and the throw was swallowed
 * by the per-half `try`. The visible symptom was silent: the routes kept working
 * because the *first* registration survived, so the only thing the second mount
 * contributed was that the config slices written in the patch (`coding:`,
 * `fingerprint:`, `levels:`) were never applied — every half ran on its own
 * built-in defaults. A shipped `reasoningEffort: null` therefore went out as
 * `"high"`, which is exactly the kind of wrong-effort request that looks like a
 * broken model rather than a broken config.
 *
 * The halves need their own rows anyway: a package's client bundle is only served
 * when the package has a loader entry (`dsh-client-modules` resolves client
 * sources from `loader.entries()`), and `client.js` requires each half's bundle by
 * name. So the rows stay, each carrying that half's own config where it actually
 * takes effect.
 *
 * ## Route prefixes are unchanged
 *
 * Each half keeps its own prefix (`/coding-probe`, `/fingerprint-probe`,
 * `/level-probe`), so an old client bundle, a bookmarked panel or a run started
 * before the merge all keep working. The merge changes where the buttons live, not
 * the API.
 *
 * @module dsh-probe
 */

/** Host plugin name, as referenced by the profile patch. */
export const name = "probe";

/**
 * No services. This module owns no routes and no state — it exists so that
 * `dsh-probe/client.js` has a loader entry to be served from. Declaring an
 * injection here would only gate the client bundle behind a service it never uses.
 */
export const inject = [];

/**
 * The probes, in panel order.
 *
 * This is the single source of truth for the tab list: `client.js` maps over it to
 * build the tab strip, and each `id` is also the config key its half's loader row
 * uses. `module` is intentionally absent — nothing here imports the halves, because
 * nothing here mounts them.
 */
export const HALVES = [
	{ id: "coding", label: "编码能力" },
	{ id: "fingerprint", label: "模型指纹" },
	{ id: "levels", label: "档位探测" }
];

/**
 * Mount the panel.
 *
 * Intentionally empty: see the module doc for why mounting the halves from here
 * silently discarded their configuration. Kept as an exported function because a
 * loader row must resolve an `apply`, and because the absence of work here is the
 * fix — deleting the row instead would take the client bundle with it.
 */
export function apply() {}
