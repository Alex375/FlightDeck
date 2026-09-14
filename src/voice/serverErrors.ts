// What to do with an `error` event from the Realtime server.
//
// Pure and dependency-free so it can be tested — realtime.ts drags in WebRTC,
// the IPC client and the DOM.
//
// ⚠️ Two failures this module exists to stop repeating:
//
// 1. Silence. Server errors used to go to `console.error` and nowhere else, so a
//    `session.update` the server rejected was invisible while Settings showed the
//    setting as applied.
//
// 2. Noise. The first fix for (1) pushed EVERY server error into the app banner,
//    raw, prefixed "The voice agent rejected a setting:". Armand then saw "…rejected
//    a setting: Conversation already has an active response in progress:
//    resp_ENz8mbt061hUCNaoQzB5k" right after changing a setting. It was wrong
//    twice over: the error came from a `response.create`, not the setting (a
//    `session.update` never creates a response), and a response id means nothing
//    to a person. Showing it is not "zero silent error", it is a mislabelled dump.
//
// So errors are sorted by WHAT CAUSED THEM, which the server lets us know exactly:
// every client event can carry an `event_id`, and the error echoes it back.

/** The shape of `error` on a Realtime `error` server event (all fields optional —
 *  never trust a wire payload to be complete). */
export interface RealtimeErrorPayload {
  type?: string;
  code?: string;
  message?: string;
  param?: string | null;
  event_id?: string | null;
}

export type ServerErrorOutcome =
  /** One of our setting updates was refused. The user changed something and it
   *  did not take: say so in plain words, next to the settings. */
  | { kind: "setting-rejected" }
  /** A race the app already absorbs (see `isBenignRace`). Log it, show nothing. */
  | { kind: "benign" }
  /** Anything else. Surface a plain sentence; the technical text stays in the log. */
  | { kind: "unexpected" };

/** The id prefix our setting updates are tagged with. */
export const SETTING_EVENT_PREFIX = "fd_setting_";

/**
 * "A response is already running" when we ask for another.
 *
 * Benign because the app now waits for the server to be quiet before asking for a
 * response (see `requestResponse` in realtime.ts), so the only way to still hit it
 * is the server starting its OWN response in that gap — from the user speaking,
 * since turn detection creates responses automatically. That response began after
 * our tool output was already in the conversation, so it carries the output with
 * it: nothing is lost, and there is nothing to tell the user.
 *
 * Matched on the code AND the message: the docs do not publish the code for this
 * error, so the message is the one field known to be stable.
 */
export function isBenignRace(error: RealtimeErrorPayload | undefined): boolean {
  if (!error) return false;
  if (error.code === "conversation_already_has_active_response") return true;
  return (error.message ?? "").startsWith("Conversation already has an active response");
}

export function classifyServerError(
  error: RealtimeErrorPayload | undefined,
  pendingSettingEvents: ReadonlySet<string>,
): ServerErrorOutcome {
  const eventId = error?.event_id ?? null;
  if (eventId && pendingSettingEvents.has(eventId)) return { kind: "setting-rejected" };
  if (isBenignRace(error)) return { kind: "benign" };
  return { kind: "unexpected" };
}

/** The note shown under the voice settings when a live update is refused. The
 *  next session reads the stored preference on connect, so this is true. */
export const SETTING_REJECTED_NOTE =
  "This change could not be applied to the conversation in progress. It will take effect the next time the voice agent starts.";

/** The banner for an unexpected error: no ids, no server wording. */
export const UNEXPECTED_ERROR_MESSAGE =
  "The voice agent hit a problem. What it was doing may not have gone through — ask it again if nothing happened.";
