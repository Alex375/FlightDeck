// What a session's end means for what it leaves behind. Pure.
import type { SessionEndReason } from "../ipc/client";

/**
 * Does the session's `claude` live on after it ENDED here? Only a remote one can: another
 * client took the conversation over (`replaced`), this Mac let go without stopping it
 * (`detached`), or the link failed for good before the daemon could be asked (`link_failed` —
 * nothing says the process died; a Stop that could not reach the server ends this way too).
 * Its background work and Remote Control bridge then outlive this Mac's session. Everything
 * else — a local process, a remote exit or stop, the daemon refusing the attach
 * (`attach_failed`: it does so only when it has no process to join), a reason the core did not
 * give (Codex, an older build) — took the process with it.
 */
export function serverSessionOutlives(reason: SessionEndReason | null | undefined): boolean {
  return reason === "replaced" || reason === "detached" || reason === "link_failed";
}
