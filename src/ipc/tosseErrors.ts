// Reading a TOSSE failure: is the SESSION gone, or did one request merely go wrong?
//
// The two call for opposite reactions. A dead session must pull the whole feature back —
// the tasks view withdraws, the Settings card explains, and the user signs in again. A
// transient failure (a 502 from a Railway redeploy, a lost Wi-Fi, a payload we could not
// parse) must change nothing: the session is still valid and the next attempt will work.
//
// ⚠️ Why this is string matching, and why it lives in its own file. Every TOSSE command is
// `Result<T, String>` on the wire, so an error reaches us as prose with no code attached —
// the text IS the signal. That makes it a CONTRACT with `src-tauri/src/tosse/mod.rs`
// (`SESSION_GONE_MARKERS` there, identical), and contracts deserve a test, which is why
// this is a pure module rather than a helper buried in `useTosse.ts`.
//
// The Rust side carries the same constant and a test that fails LOUDLY if either message is
// reworded — see `session_gone_errors_keep_the_wording_the_front_matches_on`. Without it the
// break would be silent: the view would keep retrying a board it can never load.

/**
 * The substrings that mean "there is no usable TOSSE session any more".
 *
 * Kept identical to `SESSION_GONE_MARKERS` in `src-tauri/src/tosse/mod.rs`:
 *  - `TosseError::NotConnected` → "not connected to TOSSE" (nothing stored at all);
 *  - the revoked/expired grant, whose reason ends in "connect again", surfaced as
 *    `TosseError::Denied` after the stored tokens have been cleared.
 *
 * Matched case-insensitively, because these travel through `e.to_string()` and get wrapped
 * ("authorization refused: …") on the way.
 */
export const SESSION_GONE_MARKERS = ["not connected to tosse", "connect again"] as const;

/**
 * Whether a failure means the SESSION is gone, as opposed to a request going wrong.
 *
 * Deliberately NARROW: a false positive tells a user with a perfectly valid session to sign
 * in again over a passing outage, which is worse than missing one — a genuinely dead
 * session announces itself on every subsequent call anyway.
 */
export function isSessionGone(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error ?? "").toLowerCase();
  if (!message) return false;
  return SESSION_GONE_MARKERS.some((marker) => message.includes(marker));
}
