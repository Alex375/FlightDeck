// Global session event subscriber — registered ONCE at App mount and never torn
// down. Routing all events through a single persistent listener eliminates the
// race condition where Claude starts replaying history before a per-component
// listener has finished its async `listen()` calls.
//
// Keying: the core emits events keyed by the live session HANDLE (`session-N`),
// but the message store and the whole UI key off a conversation's STABLE id. So
// every event is first mapped handle → stable id; an event for an unknown handle
// (e.g. a just-deleted conversation) is dropped.
//
// Coalescing: text/thinking deltas are buffered per (convId, messageId) and
// flushed on a single rAF tick, keeping re-renders at one frame per token burst.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { commands, events } from "./client";
import type {
  AccountLoginEvent,
  BackgroundTask,
  ConversationItem,
  SessionCodexPlanUsageEvent,
  SessionCommandsEvent,
  SessionExtensionsChangedEvent,
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionPermissionResolvedEvent,
  SessionPermissionSettledEvent,
  SessionRemoteControlEvent,
  SessionStateEvent,
  SessionTaskEvent,
  SessionTitleEvent,
  SessionSummaryEvent,
  SessionPromptSuggestionEvent,
  SessionWorkflowProgressEvent,
  WorkflowJournalEvent,
} from "./client";
import { localSendsFrom, trailingLocalSends, useConversationStore } from "../store/conversationStore";
import { probeMachine, REACHED, useMachineHealthStore } from "../store/machineHealth";
import { isGenericThinking } from "../store/activity";
import {
  useBackgroundTasksStore,
  isBackgroundActivity,
  runningCountFor,
  runningCountsByConv,
  runningBashCountsByConv,
} from "../store/backgroundTasksStore";
import { forgetRemoteStream, markRemoteStream, markRemoteStreamReplaced } from "../store/remoteStreams";
import { useWorkflowLiveStore } from "../store/workflowLive";
import { useWorkflowJournalStore } from "../store/workflowJournal";
import { useWorkflowProgressStore } from "../store/workflowProgress";
import { useAppErrors } from "../store/appErrors";
import { convMachineId, useConversationsStore, repoName } from "../store/conversationsStore";
import { hasSeenGoal, refreshActiveGoal } from "../store/goalStore";
import { useDisplay } from "../store/display";
import { agentStatusForEntry, lastAssistantText, lastTurnResultMeta } from "../agent/useAgentStatus";
import { looksLikeQuestion } from "../agent/status";
import { serverSessionOutlives } from "../agent/sessionEnd";
import { useCommandsStore } from "../store/commandsStore";
import { conversationPlace } from "../store/commandsPlace";
import { useRemoteControlStore } from "../store/remoteControl";
import { useCodexPlanUsageStore } from "../store/codexPlanUsage";
import { useLastMessageSummaryStore } from "../store/lastMessageSummary";
import { clearPromptSuggestion, usePromptSuggestions } from "../store/promptSuggestions";
import { setCachedWindow } from "../store/contextWindowCache";
import { useAccountLoginStore } from "../store/accountLogin";
import {
  armAgentNotification,
  armedAgentNotificationKind,
  cancelAgentNotification,
  dispatchAgentNotification,
  peekInterrupt,
  clearInterrupt,
} from "../notifications/notify";
import { queueVoiceAnnouncement, attentionFields } from "../voice/announce";
import { useVoiceStore } from "../voice/voiceStore";
import {
  SETTLE_MS,
  agentEventFor,
  isNoOpTurn,
  stillWarranted,
  type AgentEventKind,
} from "../notifications/transition";
import { syncReminderFromLive } from "../agent/reminderSync";
import type { SessionStatePayload } from "./client";
import { worktreesKey } from "./useWorktrees";
import {
  gitKeysToRefreshOnTurnEnd,
  invalidateGitQueries,
  isGitRefreshEdge,
} from "../features/git/gitTurnRefresh";
import { invalidateTosseRepoLinks } from "./useTosse";
import { parseEnterWorktreePath } from "../features/git/worktree";
import { taskFailedDetail } from "../features/conversation/noticeView";
import { failureNoticeDue } from "./taskFailureDedup";
import { stopNoticeDue, taskStoppedDetail } from "../agent/bashDeadline";
import {
  cancelWaitsOf,
  installConversationWatch,
  isWaiting,
  publishSessionEnded,
  publishWatchEvent,
  type WatchEvent,
} from "../agent/conversationWatch";
import type { SessionEntry } from "../store/types";

/** The folder whose worktree list a conversation's cwd move should refresh — only for a folder
 *  on THIS Mac: a server folder's list is never fetched (this Mac's git can't read it, see
 *  `useWorktrees`), so there is nothing to invalidate. */
function localRepoPathForConv(convId: string): string | null {
  const s = useConversationsStore.getState();
  const conv = s.conversations.find((c) => c.id === convId);
  const repo = conv ? s.repos.find((r) => r.id === conv.repoId) : undefined;
  return repo && !repo.machineId ? repo.path : null;
}

/** The paired server a conversation's repo lives on (`null` for a local repo) — for
 *  triggering an ambient `probeMachine` from a live link-state edge. */
function machineIdForConv(convId: string): string | null {
  return convMachineId(useConversationsStore.getState(), convId);
}

/** Remember that a REMOTE conversation's stream is on, and whether it is at work now (a turn
 *  running, a request waiting on a human, background work going) — what the next launch, or the
 *  Mac waking, puts back (see `store/remoteStreams` and `agent/remoteResume`). Not while a replay
 *  is being applied (its `busy` is the one held from before it), and never for a local one. */
function noteRemoteStream(convId: string): void {
  if (!machineIdForConv(convId)) return;
  if (!useConversationsStore.getState().conversations.find((c) => c.id === convId)?.handle) return;
  const state = useConversationStore.getState().sessions[convId]?.state;
  if (!state || state.ended || state.replaying) return;
  const background = runningCountFor(useBackgroundTasksStore.getState().sessions, convId);
  markRemoteStream(convId, state.busy || state.awaiting_permission || background > 0);
}

interface DeltaBuf {
  text: string;
  thinking: string;
}

/**
 * The identity of a background task's failure / stop notice: the task and the RUN it ended,
 * as the CLI names it (`run_id`: the same on every re-delivery of one run, a new one for each
 * run — a sub-agent woken again re-uses its task id, and may end the same way again: that end
 * deserves its own line). A remote reattach replay re-delivering the same end then keeps one
 * notice (`detail.source_id` — see the conversation store's notice case).
 *
 * `null` when the CLI names no run (an older binary, Codex): nothing else on the wire tells two
 * runs apart — `woken_by` is empty for every run a sub-agent started, so keying on it merged
 * the second failure into the first and dropped it in silence. Without an identity the notice
 * is keyed as any other (the per-run bookkeeping of `failureNoticeDue` / `stopNoticeDue` still
 * de-dups live re-emissions); a cross-session replay may then repeat a line, never hide one.
 */
export function taskNoticeSource(task: BackgroundTask): string | null {
  return task.run_id ? `task:${task.task_id}:${task.run_id}:${task.status}` : null;
}

/** A task notice's detail, with its source identity when it has one (see {@link taskNoticeSource}). */
function withTaskNoticeSource<T extends object>(detail: T, task: BackgroundTask): T | (T & { source_id: string }) {
  const source = taskNoticeSource(task);
  return source ? { ...detail, source_id: source } : detail;
}

/** Resolve a live session handle to its conversation's stable id (null if gone). */
function convIdForHandle(handle: string): string | null {
  return (
    useConversationsStore.getState().conversations.find((c) => c.handle === handle)?.id ?? null
  );
}

/**
 * Route the meaningful session-state transitions to a notification:
 *  - awaiting_permission false→true → "attention" (a permission/question is up).
 *  - busy true→false while still alive and not waiting → "done" (turn finished).
 * Compared against the PREVIOUS state so we act on the edge, not continuously.
 * `prev` is the entry's state before this event (the neutral connecting state on
 * the very first one, whose busy/awaiting_permission are false → no false fire).
 * Reading `prev` from the already-applied store also dedupes Tauri's at-least-once
 * delivery: a duplicated state event finds `prev` already equal to `next`, so no
 * edge is seen and nothing re-fires.
 *
 * ⚠️ The edge only ARMS the notification — it does not send it. A `result` (the sole
 * thing that clears `busy`) means "the CLI is handing control back", not "the
 * conversation is over": it takes control straight back whenever something is queued
 * (a message sent mid-turn, a `<task-notification>`, a cron / `/loop` wake-up, an
 * unmet `/goal`, a Stop hook). Firing on the raw edge chimed "finished" while the
 * thread visibly kept going. So every state event re-checks what is armed against the
 * new state and cancels it the moment it stops being true — see `stillWarranted`,
 * which catches a resumed turn on `activity` within ~50 ms.
 */
function notifyTransition(
  convId: string,
  prev: SessionStatePayload,
  next: SessionStatePayload,
): void {
  // Re-check whatever is already armed BEFORE arming anything new: this event may be
  // the very one that disproves it (the turn resumed, the prompt was withdrawn, the
  // process died).
  const armed = armedAgentNotificationKind(convId);
  if (armed && !stillWarranted(armed, next)) cancelAgentNotification(convId);

  const kind = agentEventFor(prev, next);
  if (!kind) return;
  // The delivery runs on a timer, i.e. OUTSIDE the caller's try/catch — it carries its
  // own, so a notification failure can never surface as an unhandled rejection.
  armAgentNotification(convId, kind, SETTLE_MS[kind], () => {
    try {
      fireAgentNotification(convId, kind);
    } catch (e) {
      console.error("notification dispatch failed:", e);
    }
  });
}

/**
 * The watch event (conversationWatch.ts) for a settled transition of `convId`, read from its
 * entry: how the turn ended (a user interrupt is said as such, never as a completion) and its
 * last reply — or what it is blocked on. `whileAway`: learned from a reattach replay, not live.
 */
export function settledWatchEvent(
  convId: string,
  kind: AgentEventKind,
  entry: SessionEntry,
  whileAway = false,
): WatchEvent {
  const away = whileAway ? { whileAway: true } : {};
  if (kind === "done") {
    const meta = lastTurnResultMeta(entry);
    const text = lastAssistantText(entry);
    return {
      kind: "completed",
      conversationId: convId,
      outcome: peekInterrupt(convId) ? "interrupted" : meta?.isError ? "error" : "success",
      subtype: meta?.isError ? (meta.subtype ?? null) : null,
      lastAssistantText: text,
      openQuestion: looksLikeQuestion(text),
      ...away,
    };
  }
  const attention = attentionFields(entry.pendingPermissions[0] ?? null);
  return {
    kind: "needs_attention",
    conversationId: convId,
    reason: attention.reason,
    tool: attention.tool,
    prompt: attention.prompt,
    ...away,
  };
}

/**
 * Should a parked `wait_for_conversation` of this conversation be answered now, on this state
 * change? Its process ended, or its turn ended in a way the CLI no longer awaits the call: an
 * interrupt, or a plain end of turn with no background work left. NOT a permission prompt
 * (it drops `busy` too), and NOT the main turn ending while background agents run — one of them
 * may be the caller, still parked on the call. Pure, for the router and its tests.
 */
export function waitAbandoned(
  prev: SessionStatePayload,
  next: SessionStatePayload,
  backgroundRunning: number,
  interrupted: boolean,
): boolean {
  if (next.ended) return true;
  if (!prev.busy || next.busy || next.awaiting_permission) return false;
  return interrupted || backgroundRunning === 0;
}

/**
 * Deliver an armed notification, once its settle window has elapsed without the
 * conversation disproving it. Everything is re-read here rather than captured at arm
 * time, so the decision is made against the state the user is actually looking at.
 * The dispatcher then suppresses the banner/dock when the user is already watching
 * this conversation, and swallows the "done" that follows a user-initiated interrupt.
 */
function fireAgentNotification(convId: string, kind: AgentEventKind): void {
  const convs = useConversationsStore.getState();
  const conv = convs.conversations.find((c) => c.id === convId);
  // Gone, or switched off in the meantime (stopped / exited / deleted): a conversation
  // with no live process has nothing to announce.
  if (!conv || !conv.handle) return;

  const entry = useConversationStore.getState().sessions[convId];
  // Belt and braces: the cancel path above covers every state event, but a window that
  // elapses between two of them must still see the truth.
  if (!entry || !stillWarranted(kind, entry.state)) return;

  if (kind === "done") {
    // A turn that never queried the model (a local slash command the CLI answered by
    // itself) finished nothing — staying silent is the whole point of the check.
    if (isNoOpTurn(lastTurnResultMeta(entry))) return;

    // Suppress the "done" ping when the finish lands the agent in `backgrounding` — it
    // finished cleanly but a background task is still running, so there is nothing to alert
    // about yet (the work continues and the agent resumes on its own). deriveAgentStatus
    // encodes that rule, so we just check the resulting status: no extra branching here keeps
    // the visual and the notification in lock-step. An open question / error while a background
    // task runs does NOT derive to `backgrounding` (it genuinely wants the user), so those
    // still ping. The Bash-only re-alert setting makes a lone background Bash command
    // derive to `review` instead of `backgrounding` → the ping is NOT suppressed → it fires,
    // exactly the pre-`backgrounding` behaviour the setting restores. Feeding the same signals
    // to `agentStatusForEntry` keeps the ping and the visual in lock-step.
    const tasks = useBackgroundTasksStore.getState().sessions;
    const bg = runningCountsByConv(tasks)[convId] ?? 0;
    if (bg > 0) {
      const status = agentStatusForEntry(
        conv.handle,
        entry,
        conv.pendingReminder,
        bg,
        runningBashCountsByConv(tasks)[convId] ?? 0,
        useDisplay.getState().alertOnBackgroundBash,
      );
      if (status.kind === "backgrounding") return;
    }
  }

  const repo = convs.repos.find((r) => r.id === conv.repoId);

  // Feed the app-control event journal (the voice bridge's `wait_for_events`)
  // from THIS settled point — after the settle window, the no-op-turn check and
  // the backgrounding suppression, but BEFORE the "user is watching" gate below
  // (the voice agent wants the event regardless of window focus). Same single
  // transition source as the human notifications, so the two can never drift.
  // A user-INTERRUPTED turn is a non-completion: the human path swallows it a
  // step later (consumeInterrupt inside dispatchAgentNotification), so the
  // journal peeks the same flag here — the voice agent must not hear a
  // "turn_completed: success" for work the user halted themselves.
  const meta = kind === "done" ? lastTurnResultMeta(entry) : null;
  const pending = entry.pendingPermissions[0] ?? null;
  // An AskUserQuestion is itself a pending `can_use_tool`, so classify on the
  // TOOL, not on "is anything pending" — otherwise a question reads as a
  // permission prompt ("asks permission to use the AskUserQuestion tool"). Shared
  // so the OS ping and the spoken announcement can never disagree.
  const attention = attentionFields(pending);
  // Fourth consumer of the same settled event: conversations watching / waiting for this one
  // (conversationWatch.ts). Unlike the journal below it covers REMOTE conversations too, and
  // it hears a user-interrupted turn — as such, never as a completion.
  publishWatchEvent(settledWatchEvent(convId, kind, entry));
  if (kind === "done" && peekInterrupt(convId)) {
    dispatchAgentNotification({
      kind,
      convId,
      title: conv.name,
      repoName: repo ? repoName(repo.path) : null,
      activeId: convs.activeId,
    });
    return;
  }
  void commands
    .publishControlEvent(
      kind === "done" ? "turn_completed" : "needs_attention",
      convId,
      conv.name,
      kind === "done"
        ? {
            outcome: meta?.isError ? "error" : "success",
            ...(meta?.subtype ? { subtype: meta.subtype } : {}),
            // Read on the FULL text: `last_assistant_text` below is clipped from the
            // end, where the "?" would be. The remote relay files the push under
            // "Questions" instead of "Ready for review" on it (flightdeck-remote §8).
            open_question: looksLikeQuestion(lastAssistantText(entry)),
            last_assistant_text: clipForEvent(lastAssistantText(entry)),
            repository: repo ? repoName(repo.path) : null,
          }
        : {
            reason: attention.reason,
            ...(attention.tool ? { tool: attention.tool } : {}),
            prompt: clipForEvent(attention.prompt),
            repository: repo ? repoName(repo.path) : null,
          },
    )
    .catch((e) => console.error("publish_control_event failed:", e));

  // Same settled event, third consumer: the in-app voice agent's spoken
  // announcements — gated on the ARMED voice mode (the on-screen "session
  // vocale" toggle), so a disarmed feature costs nothing (the queue caps and
  // drains in src/voice, opening the mic for the user's reply). Fed HERE, not
  // from the Rust journal, so all three surfaces (OS ping, voice bridge,
  // spoken line) share one truth about "what just happened".
  if (useVoiceStore.getState().mode) {
    queueVoiceAnnouncement(
      kind === "done"
        ? {
            kind: "turn_completed",
            conversationId: convId,
            title: conv.name,
            outcome: meta?.isError ? "error" : "success",
            lastAssistantText: clipForEvent(lastAssistantText(entry)),
            repository: repo ? repoName(repo.path) : null,
          }
        : {
            kind: "needs_attention",
            conversationId: convId,
            title: conv.name,
            reason: attention.reason,
            tool: attention.tool,
            prompt: clipForEvent(attention.prompt),
            repository: repo ? repoName(repo.path) : null,
          },
    );
  }

  dispatchAgentNotification({
    kind,
    convId,
    title: conv.name,
    repoName: repo ? repoName(repo.path) : null,
    activeId: convs.activeId,
  });
}

/** Bound the free text carried by a control event (voice digests, not transcripts). */
function clipForEvent(text: string | null): string | null {
  if (!text) return null;
  return text.length <= 700 ? text : `${text.slice(0, 699)}…`;
}

let markListening: () => void = () => {};
const listening = new Promise<void>((resolve) => (markListening = resolve));

/** Resolves once the session state, permission and task listeners are attached (or failed to —
 *  a failure is surfaced on its own): before that, an event the core emits is lost. What waits on
 *  it: re-sending live sessions' state to a front that lost them (`recoverLiveSessions`). */
export function sessionListenersReady(): Promise<void> {
  return listening;
}

export function useGlobalSessionEvents(): void {
  const queryClient = useQueryClient();

  // Accrue the playful-word "Thinking…" spinner clock: once a second, for every session that
  // is busy AND in the generic thinking state, add to its cumulative thinking time. A single global
  // ticker (this hook mounts once, never torn down) so it accrues even for conversations not
  // currently rendered; `accrueThinking` is a no-op between transitions (no wasted re-renders).
  // The `state.busy` gate is essential — without it an idle empty session reads as "thinking".
  // 1 s (not 500 ms) is deliberate: the word only escalates on 40 s tier/rotation boundaries, so
  // second-resolution is ample and it halves the store churn during otherwise-quiet thinking.
  // The ticker only RUNS while at least one session is busy: an idle app has nothing to accrue,
  // and a once-a-second wakeup forever is a battery cost for nothing. It is driven by a plain
  // store subscription (not a selector) so a busy flip never re-renders the host. When the last
  // session goes idle, one final sweep seals every open spell — the seal is the ticker's job
  // (`accrueThinking(…, false)`), so stopping without it would leave a spell open.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const sweep = () => {
      const now = Date.now();
      const store = useConversationStore.getState();
      for (const session in store.sessions) {
        const entry = store.sessions[session];
        store.accrueThinking(session, entry.state.busy && isGenericThinking(entry), now);
      }
    };
    const sync = (sessions: ReturnType<typeof useConversationStore.getState>["sessions"]) => {
      let busy = false;
      for (const session in sessions) {
        if (sessions[session].state.busy) {
          busy = true;
          break;
        }
      }
      if (busy && id === null) {
        id = setInterval(sweep, 1000);
      } else if (!busy && id !== null) {
        clearInterval(id);
        id = null;
        sweep();
      }
    };
    sync(useConversationStore.getState().sessions);
    const unsubscribe = useConversationStore.subscribe((state, prev) => {
      if (state.sessions !== prev.sessions) sync(state.sessions);
    });
    return () => {
      unsubscribe();
      if (id !== null) clearInterval(id);
    };
  }, []);

  useEffect(() => {
    // Conversation watch/wait: the endings the settled point below never sees (a stop, a
    // removal) come from a store diff wired once here.
    installConversationWatch();
    // Per-(session,messageId) delta buffers.
    const pending = new Map<string, DeltaBuf>();
    // Current open message id per session (for deltas without explicit message_id).
    const currentMsgId = new Map<string, string>();
    // tool_use id → which worktree tool, for calls awaiting their result. On the
    // RESULT (worktree now exists / cwd actually moved) we update the live cwd
    // and refresh the list — not on the earlier tool_use block.
    const worktreeToolIds = new Map<string, "EnterWorktree" | "ExitWorktree">();
    // Last cwd seen per session, to invalidate the worktree list only on change.
    const lastCwd = new Map<string, string>();
    const rafIds = new Map<string, number>();
    // Sessions already ensured in the store (avoid redundant state writes).
    const ensured = new Set<string>();
    // Background-task ids already surfaced as failed (the task event re-fires on
    // every transition; surface a failure exactly once).
    const seenFailedTasks = new Set<string>();
    // …and as stopped by the CLI on its own (time limit, memory pressure), same rule.
    const seenStoppedTasks = new Set<string>();
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    function ensureOnce(session: string) {
      if (ensured.has(session)) return;
      ensured.add(session);
      useConversationStore.getState().ensureSession(session);
    }

    /** A `listen()` that rejects means a whole class of live events will never
     *  arrive — the conversation would go silent. Surface it (don't swallow): log it
     *  and, if a conversation is open, drop a visible error bubble explaining that
     *  live updates may be broken. */
    function onAttachError(name: string, e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`failed to attach ${name} listener:`, e);
      const activeId = useConversationsStore.getState().activeId;
      if (activeId) {
        useConversationStore
          .getState()
          .addErrorTurn(
            activeId,
            `The connection to the event stream (${name}) failed — live updates may not appear. Restart the app.`,
            message,
          );
      }
    }

    // A remote reattach REPLAY's items — history the daemon re-delivered (`payload.replay`) —
    // queued per conversation and applied as ONE hydrating commit per frame (`applyItems(…,
    // true)`): no tool / thinking timing stamps (a replayed tool otherwise froze at ~0 ms),
    // and one re-derive for every subscriber instead of one per item (a re-join replays the
    // server's whole ring — the same reason history loads batch). Every other event of that
    // conversation flushes the queue first, so nothing is ever applied out of order: a task
    // event, say, must find the replayed `Agent` block it refers to.
    const replayBatches = new Map<string, ConversationItem[]>();
    const replayRafIds = new Map<string, number>();

    // What one replay (from the state edge INTO `replaying` to the edge out of it) needs to know
    // about the conversation as it stood when the replay began. Only a replay of the daemon's
    // WHOLE history (`replaying_history`: an actor's first attach — a relaunch, a re-join) uses
    // them; a replay of what an outage missed is news, applied as such.
    //  - `replayTurnSeen`: whether the results it delivers count as seen. Into a conversation
    //    that already held results, a result it did not hold is new (it ended while this Mac
    //    was away) — the ordinary rule. Into one that held none (relaunched, its remote history
    //    not on this Mac), nothing tells a result seen long ago from one that is not: the
    //    persisted reminder, written while the app last watched it, is the record — without
    //    it, every re-join of an idle conversation turned it blue and persisted that.
    //  - `heldSends`: the messages the user sent right before (the send that spawned the
    //    session — they trail the timeline, history not yet in). They were written after all
    //    of that history, so they move below it: at their own replayed echo, or at the end.
    const replayTurnSeen = new Map<string, boolean>();
    // Per open replay: whether it walks the whole history (a fresh attach) or only what an
    // outage missed, and whether it carried a turn's end — read at its end for watchers.
    const replayIsHistory = new Map<string, boolean>();
    const replayEndedTurn = new Set<string>();
    const heldSends = new Map<string, string[]>();

    function flushReplay(session: string) {
      const raf = replayRafIds.get(session);
      if (raf !== undefined) {
        cancelAnimationFrame(raf);
        replayRafIds.delete(session);
      }
      const batch = replayBatches.get(session);
      if (!batch || batch.length === 0) return;
      replayBatches.delete(session);
      useConversationStore.getState().applyItems(session, batch, true, replayTurnSeen.get(session));
    }

    function beginReplay(session: string, history: boolean) {
      replayTurnSeen.delete(session);
      heldSends.delete(session);
      replayIsHistory.set(session, history);
      replayEndedTurn.delete(session);
      if (!history) return;
      // The history it walks through may already be on screen (read from the server's
      // transcript): what it adds goes where it is in that history, not at the bottom.
      useConversationStore.getState().beginReplayMerge(session);
      const entry = useConversationStore.getState().sessions[session];
      if (!entry || Object.keys(entry.turnResults).length === 0) {
        const conv = useConversationsStore.getState().conversations.find((c) => c.id === session);
        replayTurnSeen.set(session, (conv?.pendingReminder ?? null) === null);
      }
      const held = entry ? trailingLocalSends(entry) : [];
      if (held.length > 0) heldSends.set(session, held);
    }

    // A replayed echo of a message held for this replay: everything replayed before it lands
    // first, then the message moves to that point — its reply follows it. The messages sent
    // after it move with it, in order (one sent while the replay was coming in followed it).
    // What the replay brings from there on answers a message the user just sent: news, not
    // history they may have seen long ago.
    function placeEchoedSend(session: string, echoUuid: string) {
      const held = heldSends.get(session);
      if (!held) return;
      const turns = useConversationStore.getState().sessions[session]?.turns;
      const echoed = held.filter((id) => turns?.[id]?.wireUuid === echoUuid);
      if (echoed.length === 0) return;
      flushReplay(session);
      const store = useConversationStore.getState();
      store.moveTurnsToEnd(session, localSendsFrom(store.sessions[session], echoed));
      if (replayTurnSeen.has(session)) replayTurnSeen.set(session, false);
      const rest = held.filter((id) => !echoed.includes(id));
      if (rest.length > 0) heldSends.set(session, rest);
      else heldSends.delete(session);
    }

    function endReplay(session: string) {
      const held = heldSends.get(session);
      heldSends.delete(session);
      replayTurnSeen.delete(session);
      const store = useConversationStore.getState();
      store.endReplayMerge(session);
      // With every message sent after the first held one (see `placeEchoedSend`).
      if (held) store.moveTurnsToEnd(session, localSendsFrom(store.sessions[session], held));
    }

    function queueReplay(session: string, item: ConversationItem) {
      const batch = replayBatches.get(session);
      if (batch) batch.push(item);
      else replayBatches.set(session, [item]);
      if (!replayRafIds.has(session)) {
        replayRafIds.set(
          session,
          requestAnimationFrame(() => {
            replayRafIds.delete(session);
            flushReplay(session);
          }),
        );
      }
    }

    function flushKey(bufKey: string, session: string, msgId: string) {
      rafIds.delete(bufKey);
      const buf = pending.get(bufKey);
      if (!buf) return;
      pending.delete(bufKey);
      // Live deltas follow any replayed history still queued (the replay precedes them).
      flushReplay(session);
      const { appendText, appendThinking } = useConversationStore.getState();
      if (buf.text) appendText(session, msgId, buf.text);
      if (buf.thinking) appendThinking(session, msgId, buf.thinking);
    }

    function scheduleFlush(session: string, msgId: string) {
      const key = `${session}:${msgId}`;
      if (!rafIds.has(key)) {
        rafIds.set(key, requestAnimationFrame(() => flushKey(key, session, msgId)));
      }
    }

    function onMessage(payload: SessionMessageEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return; // unknown / deleted conversation
      const item = payload.item;
      ensureOnce(session);
      // History re-delivered by a remote reattach replay, not activity happening now.
      const replay = payload.replay === true;

      // Recency: only the COMPLETION of a turn counts as activity — `turn_result`
      // is the single `result` message that ends Claude's whole agentic loop for a
      // user turn. We deliberately do NOT bump on the many intermediate messages
      // (message_started / assistant_message / tool_result) it emits while working:
      // otherwise the conversation would keep jumping to the top during a run. So a
      // conversation that's drifted down floats back up exactly once, when Claude
      // finishes. Persisted since it's rare/terminal. A REPLAYED result finished some
      // time ago: a re-join re-delivering every past turn must not churn the order.
      if (item.kind === "turn_result" && !replay) {
        useConversationsStore.getState().noteActivity(session, { persist: true });
      }

      // A replayed delta joins the replay queue as an item instead (applied in order with
      // the rest of the history, never stamping a thinking start).
      if (!replay && (item.kind === "text_delta" || item.kind === "thinking_delta")) {
        const msgId = item.message_id ?? currentMsgId.get(session);
        if (!msgId) return;
        const key = `${session}:${msgId}`;
        const buf = pending.get(key) ?? { text: "", thinking: "" };
        if (item.kind === "text_delta") buf.text += item.text;
        else buf.thinking += item.text;
        pending.set(key, buf);
        scheduleFlush(session, msgId);
        return;
      }

      // A live item: the replayed history queued before it lands first.
      if (!replay) flushReplay(session);
      // The replayed echo of a message held below the history (see `heldSends`).
      else if (item.kind === "user_message") placeEchoedSend(session, item.id);

      // Non-delta: flush buffered deltas for the CURRENTLY open message first, so
      // its streamed text lands before this item is applied — and BEFORE a new
      // message_started switches currentMsgId, otherwise the old message's tail
      // would be left dangling in its buffer.
      const openMsgId = currentMsgId.get(session);
      if (openMsgId) {
        const key = `${session}:${openMsgId}`;
        const rafId = rafIds.get(key);
        if (rafId) cancelAnimationFrame(rafId);
        flushKey(key, session, openMsgId);
      }

      if (item.kind === "message_started" && item.parent_tool_use_id === null) {
        currentMsgId.set(session, item.id);
      }

      // Worktree awareness: the agent moves the session into/out of a worktree
      // with EnterWorktree/ExitWorktree. Live cwd is NOT carried by the ongoing
      // stream (only system/init has it), so we read the new worktree path from
      // the tool's RESULT — that is the reliable live signal — and set the
      // conversation's liveCwd so the indicator/badge follow the agent.
      if (item.kind === "assistant_message") {
        for (const b of item.blocks) {
          if (b.type === "tool_use" && (b.name === "EnterWorktree" || b.name === "ExitWorktree")) {
            worktreeToolIds.set(b.id, b.name);
          }
        }
      } else if (item.kind === "tool_result" && worktreeToolIds.has(item.tool_use_id)) {
        const tool = worktreeToolIds.get(item.tool_use_id)!;
        worktreeToolIds.delete(item.tool_use_id);
        const convs = useConversationsStore.getState();
        // Gate BOTH on success: a refused ExitWorktree (e.g. "Worktree has N
        // commits — confirm with the user") did NOT leave the worktree, so the
        // session is still in it and liveCwd must stay put — same as a failed
        // EnterWorktree. (Mirrors `worktreeCwdFromTranscript`.)
        if (item.is_error) {
          // no-op: the worktree op was refused/failed, cwd unchanged
        } else if (tool === "EnterWorktree") {
          const path = parseEnterWorktreePath(item.content);
          if (path) convs.setLiveCwd(session, path);
        } else if (tool === "ExitWorktree") {
          // Back to where the session was spawned (its cwd is the source of truth).
          const conv = convs.conversations.find((c) => c.id === session);
          convs.setLiveCwd(session, conv?.cwd ?? null);
        }
        const repoPath = localRepoPathForConv(session);
        if (repoPath) void queryClient.invalidateQueries({ queryKey: worktreesKey(repoPath, null) });
      }

      if (replay) queueReplay(session, item);
      else useConversationStore.getState().applyItem(session, item);

      // A terminal ssh-level failure (key refused / host identity changed, CRM
      // `c9bf1482`) just told us this MACHINE is out of reach — piggyback on the
      // ambient machine-health poll's own dedup/rate-limit (unforced: this is a
      // live trigger, not an explicit human "Diagnose" click) so the sidebar mark /
      // Flight Deck lane header / composer band pick it up promptly instead of
      // waiting for the next scheduled poll.
      if (item.kind === "notice" && item.subtype === "remote_link_blocked") {
        const detail = item.detail;
        const machineId =
          detail && typeof detail === "object" && !Array.isArray(detail)
            ? (detail as Record<string, unknown>).machine_id
            : null;
        if (typeof machineId === "string") void probeMachine(machineId);
      }

      // A finished turn settles the conversation into review / error / open-question
      // (or stays idle if interrupted). Persist that the moment the result lands so
      // the reminder survives the process dying — paired with the busy-edge in
      // onState to be robust to either event arriving first (see syncReminderFromLive).
      // A replayed one is settled once, at the replay's end (see onState).
      if (item.kind === "turn_result" && !replay) syncReminderFromLive(session);
      // …and a turn the replay shows ENDING (one that may also have started during the outage,
      // which no busy edge reveals) is what conversations watching this one are owed.
      else if (item.kind === "turn_result") replayEndedTurn.add(session);
    }

    function onState(payload: SessionStateEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      ensureOnce(session); // creates the entry (neutral state) if first seen
      flushReplay(session);
      // Read the prior state BEFORE applying the new one, to detect the edge.
      const prev = useConversationStore.getState().sessions[session]?.state;
      useConversationStore.getState().applyState(session, payload.state);
      // A remote reattach replay opening / closing (the replay queue was flushed just above).
      if (payload.state.replaying === true && prev?.replaying !== true) {
        beginReplay(session, payload.state.replaying_history === true);
      } else if (prev?.replaying === true && payload.state.replaying !== true) {
        endReplay(session);
      }
      // A remote conversation's link just entered a non-attached state (Connecting on
      // first spawn, or Reconnecting after a drop) — piggyback the ambient
      // machine-health probe's own dedup/rate-limit (unforced), same as the
      // `remote_link_blocked` trigger below, so ComposerBand/RemoteRepoMark/Flight
      // Deck react promptly to a PLAIN outage (Tailscale off, ordinary network blip)
      // too — not only to a refused key, which is the only thing `remote_link_blocked`
      // itself ever fires for.
      if (payload.state.link && (!prev || !prev.link)) {
        const machineId = machineIdForConv(session);
        if (machineId) void probeMachine(machineId);
      } else if (prev?.link && !payload.state.link && !payload.state.ended) {
        // …and the opposite edge: the link just ATTACHED (`fd_attach` landed) — an ssh
        // round trip that worked. File it, so a mark still red from the outage turns
        // back at once: the ambient poll no longer probes a machine a session is attached
        // to (see `attachedMachineIds`), so nothing else would.
        const machineId = machineIdForConv(session);
        if (machineId) useMachineHealthStore.getState().recordReachability(machineId, REACHED);
      }
      // Remember the AUTHORITATIVE context window (from the live result's modelUsage)
      // so the ring is seeded correctly next time this conversation is opened — the
      // on-disk transcript can't distinguish a 200k model from a 1M one.
      if (payload.state.context_window) {
        setCachedWindow(session, payload.state.context_window);
      }
      // A turn starting makes any pending suggestion stale, whoever started it (the
      // composer clears on its own send; this covers every other path in).
      if (payload.state.busy && !prev?.busy) {
        clearPromptSuggestion(session);
        // …and a pending interrupt mark: it was for the turn that ended before this one, which
        // must never be said "interrupted" (a message queued behind an interrupt starts it at once).
        clearInterrupt(session);
      }
      if (prev) {
        // A notification failure must never break conversation event processing.
        try {
          notifyTransition(session, prev, payload.state);
        } catch (e) {
          console.error("notification dispatch failed:", e);
        }
        // A busy / awaiting edge is exactly when a conversation settles or
        // un-settles; re-derive its persisted reminder then (the other half of the
        // turn_result arming in onMessage, robust to whichever event lands first).
        // Guarded to a real edge, and BEFORE the `ended` unbind below so the handle
        // is still live — once unbound, syncReminderFromLive would (correctly) skip.
        if (
          prev.busy !== payload.state.busy ||
          prev.awaiting_permission !== payload.state.awaiting_permission ||
          // The end of a remote reattach replay: the turns it re-delivered settled
          // nothing on the way (see onMessage) — settle the conversation once, on the
          // state the replay and the server agree on.
          (prev.replaying === true && payload.state.replaying !== true)
        ) {
          syncReminderFromLive(session);
        }
        // A `/goal` is achieved/cleared/re-evaluated at turn boundaries, and its state lives ONLY in
        // the transcript (never on the live stream) — so re-read it on a busy edge. Gated on
        // `hasSeenGoal`: ONLY conversations that have (or recently had) a goal pay this transcript
        // read; a conversation that never used `/goal` reads nothing per turn (perf). A freshly set
        // goal is armed via `markGoalSeen` on the composer send. Claude only.
        if (prev.busy !== payload.state.busy && hasSeenGoal(session)) {
          const conv = useConversationsStore.getState().conversations.find((c) => c.id === session);
          if (conv && conv.kind !== "codex")
            void refreshActiveGoal(session, payload.state.session_id ?? conv.sessionId);
        }
      }
      // The session reports its current cwd via system/init (re-sent per turn).
      // When it changes — e.g. a conversation spawned straight into a worktree —
      // refresh the repo's worktree list so the new worktree is resolvable.
      const cwd = payload.state.cwd;
      if (cwd && lastCwd.get(session) !== cwd) {
        lastCwd.set(session, cwd);
        const repoPath = localRepoPathForConv(session);
        if (repoPath) void queryClient.invalidateQueries({ queryKey: worktreesKey(repoPath, null) });
      }
      // A turn end (or the process ending) is when the agent's git work lands: its commits,
      // stages and branch switches touch only `.git`, which the fs watcher ignores — nothing
      // else would refresh the Git views, the side panel's git widget or the worktree row's
      // branch until the window regained focus. Mounted views only; see gitTurnRefresh.ts.
      if (isGitRefreshEdge(prev, payload.state)) {
        const convs = useConversationsStore.getState();
        const conv = convs.conversations.find((c) => c.id === session);
        if (conv) {
          const repo = convs.repos.find((r) => r.id === conv.repoId) ?? null;
          for (const queryKey of gitKeysToRefreshOnTurnEnd(conv, payload.state, repo))
            invalidateGitQueries(queryClient, queryKey);
        }
      }
      if (payload.state.session_id) {
        useConversationsStore.getState().noteSessionId(session, payload.state.session_id);
      }
      noteRemoteStream(session);
      // A stream that ended for good is not put back next time: its server process is gone, or
      // another client took the conversation over (re-attaching it, even at work, would take it
      // back — and that client would take it back in turn). Kept: this Mac letting go (the app
      // quitting) and a link that failed.
      const reason = payload.state.end_reason;
      if (payload.state.ended && reason === "replaced" && machineIdForConv(session)) {
        markRemoteStreamReplaced(session);
      } else if (payload.state.ended && reason !== "detached" && reason !== "link_failed") {
        forgetRemoteStream(session);
      }
      // A conversation parked in `wait_for_conversation` whose call the CLI no longer awaits
      // (see `waitAbandoned`): answer it now rather than at its deadline.
      if (
        prev &&
        isWaiting(session) &&
        waitAbandoned(
          prev,
          payload.state,
          runningCountsByConv(useBackgroundTasksStore.getState().sessions)[session] ?? 0,
          peekInterrupt(session),
        )
      ) {
        cancelWaitsOf(session, payload.state.ended ? "the waiting conversation's process ended" : "the waiting turn ended");
      }
      // The end of a reattach replay that carried a turn ending (or a prompt rising) while the
      // link was down: OS notifications stay quiet on it on purpose (it happened then, not now),
      // but a conversation WATCHING this one has no other way to learn it.
      if (prev?.replaying === true && payload.state.replaying !== true) {
        // A whole-history replay (a fresh attach) re-delivers the past: the resume pass already
        // reported what settled while away (`awayWatchEvents`). Only an outage replay's news counts.
        const news = replayIsHistory.get(session) !== true;
        const endedTurn = replayEndedTurn.delete(session);
        replayIsHistory.delete(session);
        const next = payload.state;
        const missed = agentEventFor({ ...prev, replaying: false }, { ...next, replaying: false });
        const entry = useConversationStore.getState().sessions[session];
        // A turn's end: the busy edge (it was running when the link dropped), or a turn_result
        // in the news with the conversation at rest now (it started AND ended meanwhile). Same
        // filters as the live path: a no-op turn finished nothing, and a turn that only handed
        // work to background tasks has not settled yet (its real end comes live).
        const done =
          (missed === "done" || (news && endedTurn && !next.busy && !next.awaiting_permission)) &&
          !isNoOpTurn(entry ? lastTurnResultMeta(entry) : null) &&
          (runningCountsByConv(useBackgroundTasksStore.getState().sessions)[session] ?? 0) === 0;
        if (entry && !next.ended && (missed === "attention" || done))
          publishWatchEvent(settledWatchEvent(session, done ? "done" : "attention", entry, true));
      }
      if (payload.state.ended) {
        // Watchers hear it with its reason — BEFORE the unbind below, which the watch module
        // would otherwise report a second time as a plain stop.
        publishSessionEnded(session, payload.state.end_reason ?? null);
        // The session is over HERE: unbind the live handle so the next send re-spawns
        // (or re-attaches) lazily instead of routing to a dead session.
        useConversationsStore.getState().setHandle(session, null);
        // A REMOTE session can end on this Mac while its `claude` lives on server-side
        // (another client took it over, this Mac let go, the link failed for good): its
        // background work still runs and its Remote Control bridge is still up. Claiming
        // either stopped would be false — they keep their last known state, and the next
        // attach's replay brings them up to date.
        if (!serverSessionOutlives(payload.state.end_reason)) {
          // The process is gone: reconcile any background task still flagged running
          // (its terminal task event may be missed when the whole session exits)…
          useBackgroundTasksStore.getState().endSession(session);
          // …and drop the Remote Control state: the bridge lived on that process, so it
          // is gone too. A re-spawn starts disconnected (the chip resets accordingly).
          useRemoteControlStore.getState().clear(session);
        }
      }
    }

    function onPermission(payload: SessionPermissionEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      ensureOnce(session);
      flushReplay(session);
      useConversationStore.getState().enqueuePermission(session, payload.request);
    }

    // The CLI withdrew a prompt (mode flipped mid-check, turn ended, …). Drop the
    // card: the store otherwise prunes only when the user answers, so a dead prompt
    // would sit there looking answerable.
    function onPermissionResolved(payload: SessionPermissionResolvedEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      flushReplay(session);
      useConversationStore.getState().removePermission(session, payload.request_id);
      // Remote clients rendering the prompt must drop it too — without this the
      // phone shows an answerable card that no longer exists.
      const conv = useConversationsStore.getState().conversations.find((c) => c.id === session);
      void commands.publishControlEvent("attention_cleared", session, conv?.name ?? "", {
        reason: "withdrawn",
        request_id: payload.request_id,
      });
    }

    function onTitle(payload: SessionTitleEvent) {
      const convId = convIdForHandle(payload.session);
      if (!convId) return; // unknown / deleted conversation
      // Applied only if still auto-title-eligible (not renamed since) and the seq is
      // newer than the last applied (drops out-of-order/stale title responses).
      useConversationsStore.getState().applyAutoTitle(convId, payload.title, payload.seq);
    }

    function onSummary(payload: SessionSummaryEvent) {
      const convId = convIdForHandle(payload.session);
      if (!convId) return; // unknown / deleted conversation
      // Replace the optimistic truncation with the Haiku summary — applied only if its
      // seq still matches the conversation's latest message (drops a superseded response).
      useLastMessageSummaryStore.getState().apply(convId, payload.summary, payload.seq);
    }

    // The binary's guess at the user's next message, a few seconds after a turn ended.
    // Kept only while it can still show: the feature on, and no new turn under way (the
    // core drops one that lands mid-turn; this also covers a send still in flight).
    function onPromptSuggestion(payload: SessionPromptSuggestionEvent) {
      const convId = convIdForHandle(payload.session);
      if (!convId) return;
      if (!useDisplay.getState().promptSuggestions) return;
      if (useConversationStore.getState().sessions[convId]?.state?.busy) return;
      usePromptSuggestions.getState().set(convId, payload.suggestion);
    }

    // A remote session settled its permission mode — the pick confirmed, the mode a process
    // it re-joined runs in, or one it moved to on its own (a plan approved from the phone):
    // the conversation's record follows, never pushed back, so the next session starts from it.
    function onPermissionSettled(payload: SessionPermissionSettledEvent) {
      const convId = convIdForHandle(payload.session);
      if (!convId) return;
      useConversationsStore.getState().settleConvPermission(convId, payload.mode);
    }

    // A Remote Control ("bridge") state change: the ack of a toggle, or an async
    // health downgrade (`system/bridge_state`). Routed by stable conversation id like
    // every other session event; the toggle's own optimistic write is reconciled here.
    function onRemote(payload: SessionRemoteControlEvent) {
      const convId = convIdForHandle(payload.session);
      if (!convId) return;
      const prev = useRemoteControlStore.getState().byConv[convId]?.status;
      useRemoteControlStore.getState().set(convId, payload.state);
      // An async bridge FAILURE (the remote surface errored out) must be visible in the
      // thread, not only as the chip's red dot — same no-silent-failure rule. Guarded to
      // the transition INTO "error" so a re-delivery of the same state doesn't spam.
      if (payload.state.status === "error" && prev !== "error") {
        useConversationStore
          .getState()
          .addErrorTurn(convId, `Remote control: ${payload.state.error ?? "the bridge failed"}`);
      }
    }

    // Codex subscription rate-limit % push. ACCOUNT-global: it writes the ONE shared
    // Codex plan store (never keyed by conversation, never merged with Claude's), so we
    // ignore which session surfaced it. Sparse windows are merged inside the store.
    function onCodexPlanUsage(payload: SessionCodexPlanUsageEvent) {
      useCodexPlanUsageStore.getState().set(payload.usage);
    }

    // Extensions v2: the live Codex session noticed its inventory changed
    // (skills/changed, mcpServer/startupStatus/updated, account/updated). Pure
    // INVALIDATION — the payload carries no data; the affected queries refetch through
    // the normal whitelisted read commands. Broadcast to every actor by the shared
    // server, so several sessions may re-emit the same push: invalidation is idempotent.
    function onExtensionsChanged(payload: SessionExtensionsChangedEvent) {
      switch (payload.area) {
        case "skills":
          void queryClient.invalidateQueries({ queryKey: ["codex-extensions"] });
          void queryClient.invalidateQueries({ queryKey: ["codex-plugins"] });
          void queryClient.invalidateQueries({ queryKey: ["codex-hooks"] });
          break;
        case "mcp":
          void queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
          void queryClient.invalidateQueries({ queryKey: ["codex-extensions"] });
          break;
        case "accounts":
          void queryClient.invalidateQueries({ queryKey: ["account-status"] });
          break;
      }
    }

    // An in-app account login flow finished (today: the async Codex OAuth flow).
    // Refresh the account panels; the Accounts tab (when open) also listens to show
    // the outcome inline. Stash a FAILURE reason here (always-mounted) so it survives the
    // panel being closed when the async outcome lands — otherwise the reason is lost and the
    // reopened panel only shows "Not connected".
    function onAccountLogin(payload: AccountLoginEvent) {
      useAccountLoginStore
        .getState()
        .recordOutcome(payload.backend, payload.success, payload.error);
      void queryClient.invalidateQueries({ queryKey: ["account-status"] });
      // A TOSSE sign-in also changes what the repository marks can show. Their query lives
      // under its own key, so the invalidation above does not reach it — without this, the
      // marks stay absent for a full staleTime after connecting, and the feature looks
      // broken exactly when it is first tried.
      if (payload.backend === "tosse") invalidateTosseRepoLinks(queryClient);
    }

    function onCommands(payload: SessionCommandsEvent) {
      // Cache the catalogue by folder (not by session): commands depend on the
      // working folder, and a fresh conversation in the same repo reuses them
      // even before its own process spawns. The folder includes its MACHINE: a
      // session on a server reports the server's skills, which must never land on
      // the Mac clone that happens to share its path (or vice versa). For a server's
      // folder this feed is the ONLY source — nothing can probe it from here.
      const { conversations, repos } = useConversationsStore.getState();
      const conv = conversations.find((c) => c.handle === payload.session);
      if (!conv) return;
      const place = conversationPlace(conv.cwd, conv.repoId, repos);
      if (!place) return;
      useCommandsStore.getState().setCommands(place, payload.commands);
    }

    // A background task (sub-agent / workflow / background Bash / Monitor) snapshot.
    // Two roles: (1) feed the background-task REGISTRY that drives the sub-agent cards,
    // the pinned AgentBar and the Flight Deck badge; (2) surface a terminal `failed`
    // status in the owning conversation so a sub-agent that errored out isn't silently
    // lost. `stopped` is usually user/session-driven, so it's left quiet — only genuine
    // failures are surfaced. Routed by stable conversation id like every other session event.
    function onTask(payload: SessionTaskEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      flushReplay(session);
      const task = payload.task;
      // A task snapshot produced by a remote reattach REPLAY (the core flags the session
      // `replaying` from its `fd_attach` to the replay's end): history, not news — it stamps
      // no clock and notifies no one.
      const replaying = useConversationStore.getState().sessions[session]?.state.replaying === true;
      // Terminal edge (running → done/failed/stopped), captured BEFORE the upsert
      // overwrites the previous snapshot: remote clients get a task_finished event
      // (→ phone push) exactly once per task — for background WORK only: a foreground
      // task ends inside the turn that awaited it, and housekeeping is nobody's news.
      const prev = useBackgroundTasksStore.getState().sessions[session]?.[task.task_id];
      // (1) registry: the core emits a full cumulative snapshot per task (replace by id).
      useBackgroundTasksStore.getState().applyTask(session, task, { replay: replaying });
      // Background work starting or ending changes whether a remote conversation is at work.
      noteRemoteStream(session);
      // (1a) run clock: a run lasts until the last background task it launched is done.
      // A replay never STARTS a task's clock — that edge happened at a moment this Mac never
      // saw, and the replay's moment would pin it to the wrong run. But its END is fed even
      // from a replay (a task that completed, or was retired by a server restart, while the
      // Mac was away): it is a fact, the replay's moment its best estimate, and the clock's
      // only way out — a run still holding the task would tick "Background task running"
      // forever and pull every later CLI-started turn into it.
      const running = isBackgroundActivity(task);
      if (!replaying || !running) {
        useConversationStore.getState().noteTask(session, task.task_id, running);
      }
      // (1b) the CLI's word on a sub-agent moved to the background (or detached from the
      // start without the input flag): from now on it lives in the AgentBar, not inline.
      if (task.kind === "agent" && task.backgrounded === true && !task.owned_by_subagent && task.tool_use_id) {
        useConversationStore.getState().noteBackgroundedAgent(session, task.tool_use_id);
      }
      if (!replaying && prev && isBackgroundActivity(prev) && task.status !== "running") {
        const conv = useConversationsStore.getState().conversations.find((c) => c.id === session);
        void commands.publishControlEvent("task_finished", session, conv?.name ?? "", {
          task_id: task.task_id,
          kind: task.kind,
          status: task.status,
          ...(task.label ? { label: task.label } : {}),
        });
      }
      // (1c) workflow: accumulate the per-phase agent activity from the wire's progress ticks
      // (the snapshot keeps only the latest; the live overview needs the running totals).
      useWorkflowLiveStore.getState().record(session, task);
      // (1d) a task LEAVING the running set is a settling edge too: a turn that finished
      // cleanly while background work ran shows the calm green `backgrounding` (nothing to
      // review, so nothing is persisted), and only becomes a blue `review` once the last
      // background task ends. Re-derive here so that review survives the process dying —
      // the turn_result / busy edges have long passed by then. Cheap: gated to a terminal
      // snapshot (rare) and `setReminder` is idempotent. A replay settles once, at its end.
      if (task.status !== "running" && !replaying) syncReminderFromLive(session);
      // (2a) a stop the CLI made on its OWN — a command that reached its background time
      // limit (2.1.285+: 30 min unless Claude asked for longer), memory pressure. On the wire
      // it is the same bare `stopped` as the user's Stop, and the row just left the BashBar:
      // a dev server vanishing at its 30th minute read as a crash. Same discreet weight, same
      // per-run de-dup and same housekeeping exclusion as a failure (below). Keyed by the run
      // (`taskNoticeSource`): a replay re-delivering the same stop keeps one line.
      // A notice raised from a replayed snapshot rides the replay queue: applied with the rest of
      // the replay, it lands where the replay is (see `SessionEntry.replayMerge`), not below it.
      const addTaskNotice = (item: ConversationItem) => {
        if (replaying) queueReplay(session, item);
        else useConversationStore.getState().applyItem(session, item);
      };
      if (!task.ambient && stopNoticeDue(seenStoppedTasks, task)) {
        ensureOnce(session);
        addTaskNotice({
          kind: "notice",
          subtype: "task_stopped",
          detail: withTaskNoticeSource(taskStoppedDetail(task), task),
        });
      }
      // (2) failure surfacing (de-duped per RUN — re-emitted on each transition). A sub-agent
      // woken by SendMessage re-uses its task_id for a NEW run, which may fail again: a
      // running snapshot re-arms the notice, or that second failure would pass in silence.
      // Not for housekeeping: the CLI asks hosts to keep `ambient` tasks out of the transcript.
      if (task.ambient || !failureNoticeDue(seenFailedTasks, task)) return;
      ensureOnce(session);
      // A discreet inline notice (same weight as a failed tool step), NOT an error turn: a
      // background task failing is common and benign — Claude is told via its
      // `<task-notification>` and handles it — so it must not read as the conversation
      // itself failing. Nor may it clear the queued badges the way `addErrorTurn` does: a
      // failed background task doesn't stop a queued message from being delivered. When it
      // lands AT a turn boundary it does move the remote-replay anchor, like an error turn
      // (handled in `applyItem`'s notice case), so a message sent from the phone afterwards
      // renders below the failure; one raised mid-response deliberately leaves the anchor
      // alone, so the late echo of the prompt still sits above the reply it caused.
      addTaskNotice({
        kind: "notice",
        subtype: "task_failed",
        detail: withTaskNoticeSource(taskFailedDetail(task), task),
      });
    }

    // A workflow run's per-agent snapshot, from the stream — what every workflow surface reads
    // first (a remote run has no journal on this Mac). Like every other session event it arrives
    // on the live handle, resolved here to the stable conversation id the store is keyed by.
    function onWorkflowProgress(payload: SessionWorkflowProgressEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      flushReplay(session);
      useWorkflowProgressStore.getState().apply(session, payload.progress);
    }

    // A running workflow's on-disk journal changed (the Rust watcher pushes its fresh
    // per-agent progress). Keyed by Claude's DURABLE session id — not the live handle every
    // other session event uses — because the journal is an on-disk artifact of that id.
    function onWorkflowJournal(payload: WorkflowJournalEvent) {
      const conv = useConversationsStore
        .getState()
        .conversations.find((c) => c.sessionId === payload.session_id);
      if (!conv) {
        // A watch whose conversation we can't resolve is a live watcher feeding nobody. Rare
        // (the watch is owned by a mounted conversation), but dropping it in total silence
        // would make it undiagnosable.
        console.warn("[workflow journal] no conversation for session", payload.session_id);
        return;
      }
      // A journal that EXISTS but can't be read is a real failure. Two things must happen, and
      // the banner alone is NOT enough: the watcher only re-emits on CHANGE, so a persistent IO
      // failure yields exactly one event — once the user dismisses the banner, nothing else
      // says the numbers stopped being true. Flag the run itself so every surface stops
      // presenting its last snapshot as live.
      if (payload.error) {
        useAppErrors.getState().pushError("Workflow journal unreadable", payload.error);
        useWorkflowJournalStore.getState().markError(conv.id, payload.run_id, payload.error);
        return;
      }
      useWorkflowJournalStore.getState().apply(conv.id, payload.run_id, payload.journal);
    }

    events.sessionMessageEvent
      .listen((e) => { if (!disposed) onMessage(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("messages", e));
    events.workflowJournalEvent
      .listen((e) => { if (!disposed) onWorkflowJournal(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("workflow progress", e));
    const stateListening = events.sessionStateEvent
      .listen((e) => { if (!disposed) onState(e.payload); })
      .then((un) => { unlisteners.push(un); })
      .catch((e) => onAttachError("state", e));
    const permissionListening = events.sessionPermissionEvent
      .listen((e) => { if (!disposed) onPermission(e.payload); })
      .then((un) => { unlisteners.push(un); })
      .catch((e) => onAttachError("permissions", e));
    events.sessionPermissionResolvedEvent
      .listen((e) => { if (!disposed) onPermissionResolved(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("permissions", e));
    events.sessionCommandsEvent
      .listen((e) => { if (!disposed) onCommands(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("commands", e));
    events.sessionTitleEvent
      .listen((e) => { if (!disposed) onTitle(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("titles", e));
    events.sessionSummaryEvent
      .listen((e) => { if (!disposed) onSummary(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("summaries", e));
    events.sessionPromptSuggestionEvent
      .listen((e) => { if (!disposed) onPromptSuggestion(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("prompt suggestions", e));
    events.sessionPermissionSettledEvent
      .listen((e) => { if (!disposed) onPermissionSettled(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("permission modes", e));
    const taskListening = events.sessionTaskEvent
      .listen((e) => { if (!disposed) onTask(e.payload); })
      .then((un) => { unlisteners.push(un); })
      .catch((e) => onAttachError("tasks", e));
    void Promise.allSettled([stateListening, permissionListening, taskListening]).then(() => markListening());
    events.sessionWorkflowProgressEvent
      .listen((e) => { if (!disposed) onWorkflowProgress(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("workflow snapshots", e));
    events.sessionRemoteControlEvent
      .listen((e) => { if (!disposed) onRemote(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("remote control", e));
    events.sessionCodexPlanUsageEvent
      .listen((e) => { if (!disposed) onCodexPlanUsage(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("Codex usage", e));
    events.sessionExtensionsChangedEvent
      .listen((e) => { if (!disposed) onExtensionsChanged(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("extensions", e));
    events.accountLoginEvent
      .listen((e) => { if (!disposed) onAccountLogin(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("accounts", e));

    return () => {
      disposed = true;
      rafIds.forEach((id) => cancelAnimationFrame(id));
      replayRafIds.forEach((id) => cancelAnimationFrame(id));
      unlisteners.forEach((un) => un());
    };
  }, []); // Empty deps: registers ONCE at App mount, never re-registers.
}
