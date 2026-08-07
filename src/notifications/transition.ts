// The notification policy for session-state changes, isolated as pure functions
// so it can be unit-tested without the event router, the stores, or any I/O.
//
// Two halves: `agentEventFor` ARMS an event on a state edge, and
// `stillWarranted` / `isNoOpTurn` decide, a beat later, whether that edge really
// meant what it looked like. See the SETTLE_MS doc for why the second half exists.
import type { SessionStatePayload } from "../ipc/client";
import type { TurnResultMeta } from "../store/types";

export type AgentEventKind = "done" | "attention";

/**
 * Which agent notification (if any) a state change warrants, comparing the
 * PREVIOUS session state to the NEXT one (edge-triggered, not level):
 *  - awaiting_permission false→true → "attention" (a permission/question is up).
 *  - busy true→false while still alive and not awaiting → "done" (turn finished).
 *
 * Returns null for every other change. Gating "done" on `!ended` keeps a process
 * exit/crash from reading as a completion; gating on `!awaiting_permission` keeps
 * entering a permission wait (which also drops `busy`) from double-firing as both
 * "attention" and "done". Comparing against an already-applied `prev` also means a
 * duplicated (at-least-once) event sees no edge and yields null.
 */
export function agentEventFor(
  prev: SessionStatePayload,
  next: SessionStatePayload,
): AgentEventKind | null {
  if (!prev.awaiting_permission && next.awaiting_permission) return "attention";
  if (prev.busy && !next.busy && !next.awaiting_permission && !next.ended) return "done";
  return null;
}

/**
 * How long an armed event waits for the conversation to SETTLE before it is allowed
 * to reach the user.
 *
 * The edge above is necessary but not sufficient. A `result` on the wire means "the
 * CLI is handing control back right now", NOT "the conversation is over" — and the CLI
 * takes control straight back whenever it has anything queued: a message sent
 * mid-turn (its native queue), a `<task-notification>` waking the agent, a cron /
 * `/loop` wake-up, an unmet `/goal`, a Stop hook, a deferred tool resuming. Each of
 * those opens a NEW turn (hence a new `result`) within ~1 s. Chiming on the raw edge
 * therefore said "finished" while the thread visibly kept going — the bug this fixes.
 *
 * The `done` window is a safety net, not the primary signal: {@link stillWarranted}
 * cancels on `activity`, which comes back ~50 ms after the result when the CLI starts
 * the next model call — long before `busy` flips on the first streamed token
 * (measured 0.9–1.5 s). 3 s covers the gap between the two with room to spare while
 * keeping a real completion's chime effectively immediate.
 *
 * `attention` gets a much shorter one: the CLI can WITHDRAW a permission prompt it
 * just raised (control_cancel_request), and a blocking ask must not be held back.
 */
export const SETTLE_MS: Record<AgentEventKind, number> = { done: 3_000, attention: 1_000 };

/**
 * Does an armed event still describe reality? Re-checked against the CURRENT state on
 * every subsequent state event, and once more when the settle window elapses.
 *
 * `done` survives only while the conversation is genuinely at rest: not busy, not
 * blocked on a permission, and — the early signal — with no `activity`. `activity`
 * ("requesting", …) is cleared by the `result` and set again by the `system/status`
 * the CLI emits at the start of every model call, so it flags a resumed turn almost
 * immediately. `attention` survives only while the prompt is actually still up.
 * A dead session (`ended`) warrants neither: a crash is not a completion.
 */
export function stillWarranted(kind: AgentEventKind, state: SessionStatePayload): boolean {
  if (state.ended) return false;
  if (kind === "attention") return state.awaiting_permission;
  return !state.busy && !state.awaiting_permission && state.activity === null;
}

/**
 * A finished turn that never queried the model at all. Local slash commands
 * (`/status`, `/goal clear`, an unknown command) are answered by the CLI itself, yet
 * still emit a full `result` — `subtype:"success"`, `num_turns:0`, `duration_api_ms:0`
 * — which, against the optimistic busy flip on send, reads as a completed turn.
 * Nothing ran, so there is nothing to announce.
 *
 * Deliberately strict: only a reported ZERO counts. An absent count (a missing field,
 * or the Codex backend, which has no such breakdown) is treated as real work — this
 * must never be the reason a genuine completion goes unheard.
 */
export function isNoOpTurn(meta: TurnResultMeta | null | undefined): boolean {
  return meta?.numTurns === 0;
}
