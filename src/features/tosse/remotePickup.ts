// "Start" on a folder that lives on a SERVER, when nothing can say whether it has the skill.
//
// This Mac cannot read a server's plugins (see `pickupPlugin`), and the server's catalogue
// is only known once a session has run in that folder there (`commandsStore`, keyed by
// machine). With neither, the pickup support is "unknown".
//
// ⚠️ PRODUCT DECISION (Alexandre, 2026-10-08): in that case the TOSSE plugin is ASSUMED to
// be on — the usual state of a server we work on — and its skill goes in one click. The
// alternative (written instructions whenever no conversation has run in the folder yet)
// would downgrade nearly every remote Start. A catalogue that says the skill is ABSENT is
// still believed.
//
// The assumption is never left silent: the new session reports the skills it loaded as soon
// as it starts (`system/init.skills` → `SessionStatePayload.loaded_skills`), and
// {@link watchSentPickup} says so in the thread when the name we sent is not among them.
// The same check covers a name read from a remote catalogue, which may date from a session
// long gone — nothing on this Mac can vouch for a server's config as it is NOW.

import { useConversationStore } from "../../store/conversationStore";

/** The name sent on the assumption — the TOSSE plugin's skill, as the CLI publishes it. */
export const ASSUMED_PICKUP = "tosse-workflow:pickup";

/** How long a launched session gets to report its skills before the check stands down. A
 *  remote spawn goes over SSH and may first wait on a reconnect — generous on purpose. */
export const PICKUP_CHECK_MS = 3 * 60_000;

const skillsIn = (convId: string) =>
  useConversationStore.getState().sessions[convId]?.state?.loaded_skills;

/**
 * Check a slash command sent to a server's folder once the conversation reports its skills,
 * and call `onMissing` if the name is not among them — it then reached the agent as plain
 * text, which would otherwise look exactly like a pickup that worked.
 *
 * One-shot: it settles on the session's FIRST report and unsubscribes. A session that never
 * reports within {@link PICKUP_CHECK_MS} leaves nothing to conclude (a spawn that failed
 * outright is already reported by the send). Returns the cancel function.
 */
export function watchSentPickup(convId: string, name: string, onMissing: () => void): () => void {
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const stop = () => {
    settled = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
  const check = (): void => {
    if (settled) return;
    const skills = skillsIn(convId);
    if (skills == null) return;
    stop();
    if (!skills.includes(name)) onMissing();
  };
  unsubscribe = useConversationStore.subscribe(check);
  timer = setTimeout(stop, PICKUP_CHECK_MS);
  // It may already have reported (a fast spawn between the send and this line).
  check();
  return stop;
}

/** What the thread says when the check fails. */
export function missingPickupMessage(name: string, server: string): string {
  return `« /${name} » is not among the skills this conversation loaded on ${server}, so it reached the agent as plain text and the task may not have been picked up. Enable the tosse-workflow plugin on that machine, or ask the agent to start the task by hand.`;
}
