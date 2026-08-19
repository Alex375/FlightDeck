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
  SessionCodexPlanUsageEvent,
  SessionCommandsEvent,
  SessionExtensionsChangedEvent,
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionPermissionResolvedEvent,
  SessionRemoteControlEvent,
  SessionStateEvent,
  SessionTaskEvent,
  SessionTitleEvent,
  SessionSummaryEvent,
  WorkflowJournalEvent,
} from "./client";
import { useConversationStore } from "../store/conversationStore";
import { isGenericThinking } from "../store/activity";
import {
  useBackgroundTasksStore,
  runningCountsByConv,
  runningBashCountsByConv,
} from "../store/backgroundTasksStore";
import { useWorkflowLiveStore } from "../store/workflowLive";
import { useWorkflowJournalStore } from "../store/workflowJournal";
import { useAppErrors } from "../store/appErrors";
import { useConversationsStore, repoName } from "../store/conversationsStore";
import { hasSeenGoal, refreshActiveGoal } from "../store/goalStore";
import { useDisplay } from "../store/display";
import { agentStatusForEntry, lastAssistantText, lastTurnResultMeta } from "../agent/useAgentStatus";
import { useCommandsStore } from "../store/commandsStore";
import { useRemoteControlStore } from "../store/remoteControl";
import { useCodexPlanUsageStore } from "../store/codexPlanUsage";
import { useLastMessageSummaryStore } from "../store/lastMessageSummary";
import { setCachedWindow } from "../store/contextWindowCache";
import { useAccountLoginStore } from "../store/accountLogin";
import {
  armAgentNotification,
  armedAgentNotificationKind,
  cancelAgentNotification,
  dispatchAgentNotification,
  peekInterrupt,
} from "../notifications/notify";
import { queueVoiceAnnouncement } from "../voice/announce";
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
import { invalidateTosseRepoLinks } from "./useTosse";
import { parseEnterWorktreePath } from "../features/git/worktree";

/** Repo path of a conversation (for invalidating its cached worktree list). */
function repoPathForConv(convId: string): string | null {
  const s = useConversationsStore.getState();
  const conv = s.conversations.find((c) => c.id === convId);
  return conv ? (s.repos.find((r) => r.id === conv.repoId)?.path ?? null) : null;
}

interface DeltaBuf {
  text: string;
  thinking: string;
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
            last_assistant_text: clipForEvent(lastAssistantText(entry)),
            repository: repo ? repoName(repo.path) : null,
          }
        : {
            reason: pending ? "permission" : "question",
            ...(pending ? { tool: pending.tool_name } : {}),
            prompt: clipForEvent(pending?.title ?? pending?.description ?? null),
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
            reason: pending ? "permission" : "question",
            tool: pending?.tool_name ?? null,
            prompt: clipForEvent(pending?.title ?? pending?.description ?? null),
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

export function useGlobalSessionEvents(): void {
  const queryClient = useQueryClient();

  // Accrue the playful-word "Thinking…" spinner clock: once a second, for every session that
  // is busy AND in the generic thinking state, add to its cumulative thinking time. A single global
  // ticker (this hook mounts once, never torn down) so it accrues even for conversations not
  // currently rendered; `accrueThinking` is a no-op between transitions (no wasted re-renders).
  // The `state.busy` gate is essential — without it an idle empty session reads as "thinking".
  // 1 s (not 500 ms) is deliberate: the word only escalates on 40 s tier/rotation boundaries, so
  // second-resolution is ample and it halves the store churn during otherwise-quiet thinking.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const store = useConversationStore.getState();
      for (const session in store.sessions) {
        const entry = store.sessions[session];
        store.accrueThinking(session, entry.state.busy && isGenericThinking(entry), now);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
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

    function flushKey(bufKey: string, session: string, msgId: string) {
      rafIds.delete(bufKey);
      const buf = pending.get(bufKey);
      if (!buf) return;
      pending.delete(bufKey);
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

      // Recency: only the COMPLETION of a turn counts as activity — `turn_result`
      // is the single `result` message that ends Claude's whole agentic loop for a
      // user turn. We deliberately do NOT bump on the many intermediate messages
      // (message_started / assistant_message / tool_result) it emits while working:
      // otherwise the conversation would keep jumping to the top during a run. So a
      // conversation that's drifted down floats back up exactly once, when Claude
      // finishes. Persisted since it's rare/terminal.
      if (item.kind === "turn_result") {
        useConversationsStore.getState().noteActivity(session, { persist: true });
      }

      if (item.kind === "text_delta" || item.kind === "thinking_delta") {
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
        const repoPath = repoPathForConv(session);
        if (repoPath) void queryClient.invalidateQueries({ queryKey: worktreesKey(repoPath) });
      }

      useConversationStore.getState().applyItem(session, item);

      // A finished turn settles the conversation into review / error / open-question
      // (or stays idle if interrupted). Persist that the moment the result lands so
      // the reminder survives the process dying — paired with the busy-edge in
      // onState to be robust to either event arriving first (see syncReminderFromLive).
      if (item.kind === "turn_result") syncReminderFromLive(session);
    }

    function onState(payload: SessionStateEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      ensureOnce(session); // creates the entry (neutral state) if first seen
      // Read the prior state BEFORE applying the new one, to detect the edge.
      const prev = useConversationStore.getState().sessions[session]?.state;
      useConversationStore.getState().applyState(session, payload.state);
      // Remember the AUTHORITATIVE context window (from the live result's modelUsage)
      // so the ring is seeded correctly next time this conversation is opened — the
      // on-disk transcript can't distinguish a 200k model from a 1M one.
      if (payload.state.context_window) {
        setCachedWindow(session, payload.state.context_window);
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
          prev.awaiting_permission !== payload.state.awaiting_permission
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
        const repoPath = repoPathForConv(session);
        if (repoPath) void queryClient.invalidateQueries({ queryKey: worktreesKey(repoPath) });
      }
      if (payload.state.session_id) {
        useConversationsStore.getState().noteSessionId(session, payload.state.session_id);
      }
      if (payload.state.ended) {
        // The process is gone: unbind the live handle so the next send re-spawns
        // lazily instead of routing to a dead session.
        useConversationsStore.getState().setHandle(session, null);
        // …and reconcile any background task still flagged running: the whole session
        // exited, so it can't be live anymore (the terminal task event may be missed).
        useBackgroundTasksStore.getState().endSession(session);
        // …and drop the Remote Control state: the bridge lived on that process, so it
        // is gone too. A re-spawn starts disconnected (the chip resets accordingly).
        useRemoteControlStore.getState().clear(session);
      }
    }

    function onPermission(payload: SessionPermissionEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      ensureOnce(session);
      useConversationStore.getState().enqueuePermission(session, payload.request);
    }

    // The CLI withdrew a prompt (mode flipped mid-check, turn ended, …). Drop the
    // card: the store otherwise prunes only when the user answers, so a dead prompt
    // would sit there looking answerable.
    function onPermissionResolved(payload: SessionPermissionResolvedEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
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
      // Cache the catalogue by cwd (not by session): commands depend on the
      // working folder, and a fresh conversation in the same repo reuses them
      // even before its own process spawns.
      const conv = useConversationsStore
        .getState()
        .conversations.find((c) => c.handle === payload.session);
      if (!conv) return;
      useCommandsStore.getState().setCommands(conv.cwd, payload.commands);
    }

    // A background task (sub-agent / workflow / background Bash / Monitor) snapshot.
    // Two roles: (1) feed the background-task REGISTRY that drives the sub-agent cards,
    // the pinned AgentBar and the Flight Deck badge; (2) surface a terminal `failed`
    // status in the owning conversation so a sub-agent that errored out isn't silently
    // lost. `stopped` is usually user/session-driven, so it's left quiet — only genuine
    // failures alert. Routed by stable conversation id like every other session event.
    function onTask(payload: SessionTaskEvent) {
      const session = convIdForHandle(payload.session);
      if (!session) return;
      const task = payload.task;
      // Terminal edge (running → done/failed/stopped), captured BEFORE the upsert
      // overwrites the previous snapshot: remote clients get a task_finished event
      // (→ phone push) exactly once per task.
      const prevStatus =
        useBackgroundTasksStore.getState().sessions[session]?.[task.task_id]?.status;
      // (1) registry: the core emits a full cumulative snapshot per task (replace by id).
      useBackgroundTasksStore.getState().applyTask(session, task);
      if (prevStatus === "running" && task.status !== "running") {
        const conv = useConversationsStore.getState().conversations.find((c) => c.id === session);
        void commands.publishControlEvent("task_finished", session, conv?.name ?? "", {
          task_id: task.task_id,
          kind: task.kind,
          status: task.status,
          ...(task.label ? { label: task.label } : {}),
        });
      }
      // (1b) workflow: accumulate the per-phase agent activity from the wire's progress ticks
      // (the snapshot keeps only the latest; the live overview needs the running totals).
      useWorkflowLiveStore.getState().record(session, task);
      // (1c) a task LEAVING the running set is a settling edge too: a turn that finished
      // cleanly while background work ran shows the calm green `backgrounding` (nothing to
      // review, so nothing is persisted), and only becomes a blue `review` once the last
      // background task ends. Re-derive here so that review survives the process dying —
      // the turn_result / busy edges have long passed by then. Cheap: gated to a terminal
      // snapshot (rare) and `setReminder` is idempotent.
      if (task.status !== "running") syncReminderFromLive(session);
      // (2) failure surfacing (de-duped per task — re-emitted on each transition).
      if (task.status !== "failed") return;
      if (seenFailedTasks.has(task.task_id)) return; // re-emitted per transition
      seenFailedTasks.add(task.task_id);
      ensureOnce(session);
      const label = task.label ? `: ${task.label}` : "";
      const detailParts: string[] = [];
      if (task.summary) detailParts.push(task.summary);
      if (task.output_file) detailParts.push(`output: ${task.output_file}`);
      useConversationStore
        .getState()
        .addErrorTurn(
          session,
          `A background task failed${label}.`,
          detailParts.length ? detailParts.join("\n") : null,
        );
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
    events.sessionStateEvent
      .listen((e) => { if (!disposed) onState(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("state", e));
    events.sessionPermissionEvent
      .listen((e) => { if (!disposed) onPermission(e.payload); })
      .then((un) => unlisteners.push(un))
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
    events.sessionTaskEvent
      .listen((e) => { if (!disposed) onTask(e.payload); })
      .then((un) => unlisteners.push(un))
      .catch((e) => onAttachError("tasks", e));
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
      unlisteners.forEach((un) => un());
    };
  }, []); // Empty deps: registers ONCE at App mount, never re-registers.
}
