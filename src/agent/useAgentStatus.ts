// React binding for the pure status model (agent/status.ts). It gathers the raw
// signals from BOTH stores — the message store (live session state, pending
// permissions, finished turns) keyed by the conversation's STABLE id, and the
// conversations store (the live `handle`, the on/off source of truth) — then runs
// the pure `deriveAgentStatus`. Kept separate from status.ts so that module stays
// React-free and unit-testable; this hook is what the sidebar and the future
// fleet view both call.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "../store/conversationStore";
import { useConversationsStore } from "../store/conversationsStore";
import { useRunningTaskCount, useRunningBashTaskCount } from "../store/backgroundTasksStore";
import { useDisplay } from "../store/display";
import type { SessionEntry, TurnResultMeta } from "../store/types";
import {
  deriveAgentStatus,
  type AgentSignals,
  type AgentStatus,
  type ReminderKind,
} from "./status";

// The signals carried by the LIVE message-store entry — everything in AgentSignals
// except the ones sourced elsewhere: the live `handle` and `persistedReminder` (the
// conversations/metadata store), the background counts (`runningBackgroundTasks` /
// `runningBackgroundBashTasks`, the background-task registry) and the global
// `reAlertOnBackgroundBash` setting (the display-prefs store).
type InnerSignals = Omit<
  AgentSignals,
  | "handle"
  | "persistedReminder"
  | "runningBackgroundTasks"
  | "runningBackgroundBashTasks"
  | "reAlertOnBackgroundBash"
>;

const NEUTRAL: InnerSignals = {
  busy: false,
  awaitingPermission: false,
  pendingToolName: null,
  pendingPrompt: null,
  activity: null,
  lastTurnSubtype: null,
  lastTurnIsError: false,
  turnSeen: true,
  lastAssistantText: null,
};

/** Text of the most recent assistant turn (its joined text blocks), for the
 *  open-question heuristic. Scans the timeline tail backwards and stops at the
 *  first assistant turn, so it visits only a few entries in practice. Exported
 *  for the app-control executor (voice events + read tools) so "the last
 *  reply" always means the same thing everywhere. */
export function lastAssistantText(entry: SessionEntry): string | null {
  for (let i = entry.timeline.length - 1; i >= 0; i--) {
    const e = entry.timeline[i];
    if (e.kind !== "turn") continue;
    const turn = entry.turns[e.id];
    if (!turn || turn.role !== "assistant") continue;
    const text = turn.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // Finalized turns hold their text in `blocks`; fall back to the live buffer.
    return text || turn.streamingText.trim() || null;
  }
  return null;
}

/**
 * Metadata of the most recent finished turn (its turn_result), or null when the
 * session has none yet. Scans the timeline tail backwards, so it visits only a few
 * entries in practice. Shared with the notification router, which reads `numTurns`
 * off it to tell a real completion from a local command the CLI answered itself.
 */
export function lastTurnResultMeta(entry: SessionEntry): TurnResultMeta | null {
  for (let i = entry.timeline.length - 1; i >= 0; i--) {
    const e = entry.timeline[i];
    if (e.kind !== "turn_result") continue;
    const meta = entry.turnResults[e.id];
    if (meta) return meta;
  }
  return null;
}

/** subtype + is_error of the most recent finished turn (its turn_result). */
function lastTurnOutcome(entry: SessionEntry): { subtype: string | null; isError: boolean } {
  const meta = lastTurnResultMeta(entry);
  return { subtype: meta?.subtype ?? null, isError: meta?.isError ?? false };
}

/** Flatten a session entry into the shallow-stable signal slice. The timeline
 *  scans (last turn / last assistant text) run ONLY when the session is settled
 *  and unconsumed — i.e. when the result could actually be review/need-input. */
function gather(entry: SessionEntry | undefined): InnerSignals {
  if (!entry) return NEUTRAL;
  const st = entry.state;
  const pending = entry.pendingPermissions[0] ?? null;
  const settled = !st.busy && !st.awaiting_permission && !entry.turnSeen;
  const outcome = settled ? lastTurnOutcome(entry) : { subtype: null, isError: false };
  return {
    busy: st.busy,
    awaitingPermission: st.awaiting_permission,
    pendingToolName: pending?.tool_name ?? null,
    pendingPrompt: pending?.title ?? pending?.description ?? null,
    activity: st.activity,
    lastTurnSubtype: outcome.subtype,
    lastTurnIsError: outcome.isError,
    turnSeen: entry.turnSeen,
    lastAssistantText: settled ? lastAssistantText(entry) : null,
  };
}

/**
 * Compose the rich status for a conversation from its live `handle` + message-store
 * `entry` — the NON-hook form. The fleet aggregate uses this to derive every agent's
 * status without mounting one hook per card; `useAgentStatus` below runs the SAME
 * `gather` + `deriveAgentStatus`, so the per-card and fleet-wide views never drift.
 */
export function agentStatusForEntry(
  handle: string | null,
  entry: SessionEntry | undefined,
  persistedReminder: ReminderKind | null = null,
  runningBackgroundTasks = 0,
  runningBackgroundBashTasks = 0,
  reAlertOnBackgroundBash = false,
): AgentStatus {
  return deriveAgentStatus({
    handle,
    persistedReminder,
    runningBackgroundTasks,
    runningBackgroundBashTasks,
    reAlertOnBackgroundBash,
    ...gather(entry),
  });
}

/**
 * The rich {@link AgentStatus} for a conversation (by stable id). Subscribes to
 * both stores; `useShallow` keeps the inner slice stable across unrelated changes
 * so the memoized status is referentially stable until a real signal moves.
 */
export function useAgentStatus(convId: string): AgentStatus {
  // Both off-state inputs come from the conversations (metadata) store: the live
  // `handle` and the `persistedReminder` that re-surfaces a settled state when the
  // process is off. Read them together with a shallow-stable slice.
  const { handle, persistedReminder } = useConversationsStore(
    useShallow((s) => {
      const conv = s.conversations.find((c) => c.id === convId);
      return { handle: conv?.handle ?? null, persistedReminder: conv?.pendingReminder ?? null };
    }),
  );
  const inner = useConversationStore(useShallow((s) => gather(s.sessions[convId])));
  const runningBackgroundTasks = useRunningTaskCount(convId);
  const runningBackgroundBashTasks = useRunningBashTaskCount(convId);
  const reAlertOnBackgroundBash = useDisplay((s) => s.alertOnBackgroundBash);
  return useMemo(
    () =>
      deriveAgentStatus({
        handle,
        persistedReminder,
        runningBackgroundTasks,
        runningBackgroundBashTasks,
        reAlertOnBackgroundBash,
        ...inner,
      }),
    [
      handle,
      persistedReminder,
      runningBackgroundTasks,
      runningBackgroundBashTasks,
      reAlertOnBackgroundBash,
      inner,
    ],
  );
}
