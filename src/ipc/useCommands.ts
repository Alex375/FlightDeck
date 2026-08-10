// TanStack Query mutation wrappers around the IPC commands. Events feed Zustand
// directly (see useSessionEvents); Query only models the imperative commands so we
// get loading/error states and never silently swallow a Result.error branch.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { commands } from "./client";
import type { PermissionDecision, Result } from "./client";
import { useConversationStore } from "../store/conversationStore";
import type { UserTurnImage } from "../store/types";
import {
  ensureConversationSession,
  liveHandle,
  useConversationsStore,
} from "../store/conversationsStore";
import { noteInterrupt } from "../notifications/notify";
import { worktreesKey } from "./useWorktrees";
import { useRemoteControlStore } from "../store/remoteControl";
import { triggerLastMessageSummary } from "../store/lastMessageSummary";
import { buildCodexControls } from "../features/conversation/codexControls";
import {
  endGoalClearing,
  refreshActiveGoal,
  scheduleGoalRefresh,
  settleGoalClearing,
} from "../store/goalStore";

// These hooks are keyed by a conversation's STABLE id, not its live session
// handle. Reads (the message store) key by the stable id; commands target the
// live `claude` session, so each one resolves the id → handle at call time. With
// the lazy policy a conversation may have no live session yet: `useSendMessage`
// spawns it on the first message, while the other commands no-op when there is
// nothing live to talk to.

/** Throw on the Result.error branch so onError fires and callers can surface it. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

/**
 * Everything a send does, WITHOUT React — so a message can also be sent from outside a
 * component (the TOSSE tasks view opens a conversation and sends its first prompt).
 *
 * {@link useSendMessage} is a thin wrapper around this, so the two paths can never
 * drift: optimistic bubble, reminder + activity, lazy spawn, auto-title and the Flight
 * Deck summary all happen here, once.
 */
export async function sendConversationMessage(
  convId: string,
  vars: SendMessageVars,
  // Called after a first send that CREATED a worktree, so the caller can refresh its
  // cached worktree list. The hook passes its query client's invalidation; a
  // programmatic caller that never asks for a worktree has nothing to do here.
  onWorktreeCreated?: (repoPath: string) => void,
) {
  const { text, worktree, queued, images, goal } = vars;
  // A goal SET shows its bubble like any message; only "plumbing" stays fully silent.
  const showBubble = goal !== "plumbing";
  // Auto-title / "last ask" summary are for real conversational content only — never a `/goal`.
  const driveTitle = goal === undefined;
  // The core does not echo user turns, so append optimistically (keyed by the
  // stable id) before sending — instant even while the session spawns.
  let bubbleTurnId = "";
  if (showBubble) {
    bubbleTurnId = useConversationStore.getState().addUserTurn(convId, text, queued, images);
    // Name a still-untitled conversation after its first message, and mark it eligible for
    // the model-generated title that replaces it.
    //
    // ⚠️ Here, NOT in the composer. It used to live there, so a conversation whose first
    // message was sent programmatically (the TOSSE tasks view opening one on a task) was
    // never armed: `triggerAutoTitle` below silently did nothing and the conversation kept
    // the "New conversation" placeholder for good. This is the single send path, so every
    // caller gets the same behaviour. Idempotent — a conversation that already has a name
    // is left alone. Skipped for a `/goal`, which is a directive, not a topic.
    if (driveTitle) useConversationsStore.getState().noteFirstMessage(convId, text);
    // Sending the next message consumes any pending reminder: the user has moved on from
    // the previous result. `addUserTurn` clears the LIVE turnSeen, so the PERSISTED reminder
    // must be cleared under the SAME condition — a "plumbing" send does neither. Otherwise it
    // would swallow an unread attention reminder (persisted side cleared) while the live side
    // still says "unread": the two halves would disagree and the reminder would vanish
    // without the user ever seeing the result it pointed at.
    useConversationsStore.getState().setReminder(convId, null);
    // Sending IS activity: float the conversation to the top now and persist the new
    // timestamp so the recency order survives a restart. Skipped for "plumbing": a `/goal
    // clear`/status is not work on this conversation, so it must not reshuffle the fleet's
    // recency order (and must not persist a write for it either).
    useConversationsStore.getState().noteActivity(convId, { persist: true });
  }
  // Lazy spawn: a conversation has no live process until its first message
  // (or its first message after being stopped/ended).
  const handle = await ensureConversationSession(convId, { worktree });
  // Map the UI's image shape to the wire's `ImageAttachment` (media_type + raw
  // base64). Empty array for a plain text turn.
  const wireImages = (images ?? []).map((i) => ({ media_type: i.mediaType, data: i.dataBase64 }));
  // For a Codex conversation, fold its composer controls (model / effort / preset /
  // network / summary / personality) into the per-turn override object; `null` for
  // Claude (which pushes each control live instead).
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  const codexControls = conv?.kind === "codex" ? buildCodexControls(conv) : null;
  const res = await unwrap(commands.sendMessage(handle, text, wireImages, codexControls));
  // Remember which message on the wire this bubble is, so it can be dropped from the
  // binary's queue for as long as it has not started running.
  if (bubbleTurnId && typeof res === "string") {
    useConversationStore.getState().setTurnWireUuid(convId, bubbleTurnId, res);
  }
  // A `/goal` command is not conversational content, so it must not drive the title or the
  // Flight Deck "last ask" peek either — otherwise a goal directive would leak into those.
  if (driveTitle) {
    // On each of the first few messages of a still-untitled conversation, ask the
    // binary to (re)generate a smart title from the accumulated intent (capped, then
    // frozen; no-op once renamed / over the cap / no live session). Like the VS Code
    // extension, but tracking the evolving topic. The title arrives via
    // SessionTitleEvent and replaces the optimistic placeholder name.
    useConversationsStore.getState().triggerAutoTitle(convId, text);
    // Also (re)generate the Flight Deck's few-word summary of THIS message (the
    // "last ask"). Instant truncation now, replaced by a ≤6-word Haiku summary that
    // arrives via SessionSummaryEvent. Regenerated on every send (unlike the title,
    // which settles). `handle` is the live session we just sent through.
    triggerLastMessageSummary(convId, handle, text);
  }
  if (goal !== undefined) {
    // A `/goal` was ACCEPTED. Refresh the target chip from the transcript on a short bounded
    // ladder: the `goal_status` write lands asynchronously, and — `/goal` being a LOCAL
    // command — it may never produce a model turn whose busy edge would otherwise refetch it.
    // (A SET also shows the card in the thread now; this still drives the chip.) The session
    // id is resolved lazily HERE because `goalStore` must not import `conversationsStore`
    // (which imports it — circular).
    scheduleGoalRefresh(
      convId,
      () =>
        useConversationsStore.getState().conversations.find((c) => c.id === convId)?.sessionId ??
        null,
    );
  }
  if (worktree) {
    // The first spawn just created a worktree — let the caller refresh the repo's list
    // so the indicator/manager show it.
    const repoPath = repoPathForConv(convId);
    if (repoPath) onWorktreeCreated?.(repoPath);
  }
  return res;
}

/** The one shape a send takes, shared by the hook and the programmatic path. */
export interface SendMessageVars {
  text: string;
  /** First send only: spawn this conversation inside a freshly created git worktree
   *  instead of the repo's main checkout. */
  worktree?: boolean;
  /** The agent was busy at send time, so the CLI injects this mid-turn — flags the
   *  optimistic turn as "pending". */
  queued?: boolean;
  /** Files joined via the composer's "+" / paste, sent as `image` blocks. */
  images?: UserTurnImage[];
  /** This send is a `/goal` command. "set" (a real condition) shows in the thread as a
   *  "Goal set" card — an optimistic bubble like any message, but WITHOUT driving the
   *  auto-title / summary (a goal is a directive, not the conversation's topic).
   *  "plumbing" (clear / bare status) is fully silent — the target chip represents it,
   *  and the Rust normalizer drops the echo + stdout on both live and reload. Either kind
   *  refreshes the goal chip. `undefined` = an ordinary message. */
  goal?: "set" | "plumbing";
}

export function useSendMessage(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: SendMessageVars) =>
      sendConversationMessage(convId, vars, (repoPath) => {
        void qc.invalidateQueries({ queryKey: worktreesKey(repoPath) });
      }),
    // The send can fail before anything streams back — most importantly when the
    // `claude` session fails to spawn (binary not found). Surface it as a visible
    // error bubble instead of leaving the optimistic user turn dangling silently.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, message);
    },
  });
}

/** Repo path of a conversation, for invalidating its cached worktree list. */
function repoPathForConv(convId: string): string | null {
  const s = useConversationsStore.getState();
  const conv = s.conversations.find((c) => c.id === convId);
  return conv ? (s.repos.find((r) => r.id === conv.repoId)?.path ?? null) : null;
}

export function useAnswerPermission(convId: string) {
  const removePermission = useConversationStore((s) => s.removePermission);
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async (args: { requestId: string; decision: PermissionDecision }) => {
      // Optimistically dismiss the card; the state event confirms awaiting=false.
      removePermission(convId, args.requestId);
      const handle = liveHandle(convId);
      // No live session: the process died while the card was on screen (crash, quit,
      // stop). Dismissing it silently is indistinguishable from a delivered answer —
      // the user believes they allowed something that was never sent. Fail loudly and
      // let onError put it in the thread.
      if (!handle) {
        throw new Error("the session ended before your answer could be sent");
      }
      return unwrap(
        commands.answerPermission(handle, args.requestId, args.decision),
      );
    },
    // The card was dismissed optimistically: if the reply never reached the session,
    // the agent stays blocked CLI-side with nothing in the thread — surface it.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Failed to answer the permission request: ${message}`);
    },
  });
}

// Model / effort / ultracode / permission are NOT TanStack mutations: they route
// through the conversations store (`setConvModel` / `setConvEffort` /
// `setConvUltracode` / `setConvPermission`), which persists the choice AND pushes
// it to the live stream. That keeps a pre-spawn pick (persisted, applied at spawn)
// and a live change on one path, and lets the core's get_settings read-back be the
// source of truth for what the indicator shows.

/** Drop ONE message that is still waiting in the binary's queue, from the pending badge
 *  on its own bubble. The bubble is removed ONLY on a confirmed cancellation: `false`
 *  means the message already started running and WILL be answered, so taking the bubble
 *  away would hide a message the agent is about to act on.
 *
 *  ⚠️ ONLY ever call this for a message that is genuinely still QUEUED — i.e. one sent
 *  while ANOTHER turn was running (the `pending` badge). VERIFIED on the wire: cancelling
 *  a message whose own turn has already STARTED answers `cancelled:false` and then WEDGES
 *  the session — the turn stops producing and never emits its `result` (control run
 *  without the cancel: same prompt completes normally). That is what made the stop button
 *  look dead when it tried to un-send first, which is why stopping is now a plain
 *  interrupt again and this call stays confined to the pending badge. */
export function useCancelQueuedMessage(convId: string) {
  const removeUserTurn = useConversationStore((s) => s.removeUserTurn);
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async (args: { turnId: string; wireUuid: string }) => {
      const handle = liveHandle(convId);
      if (!handle) return false;
      const cancelled = await unwrap(commands.cancelQueuedMessage(handle, args.wireUuid));
      if (cancelled) removeUserTurn(convId, args.turnId);
      return cancelled;
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Could not remove the pending message: ${message}`);
    },
  });
}

export function useInterrupt(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // nothing running to interrupt
      // The interrupt ends the turn (busy→false), which would otherwise fire a
      // "done" notification for a stop the user just performed — suppress it.
      noteInterrupt(convId);
      return unwrap(commands.interruptSession(handle));
    },
    // A failed interrupt is otherwise invisible (the "done" notif was already
    // suppressed) — say it didn't take so the user knows the agent is still running.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Interrupt failed: ${message}`);
    },
  });
}

/** Compact a Codex conversation's context via the native `thread/compact/start` RPC.
 *  Claude compacts via the `/compact` text turn instead, so the composer only calls this
 *  for a Codex conversation. A no-op if nothing is running (the ring is only interactive
 *  after the first turn). A failure is already surfaced as a thread notice by the actor,
 *  so here we only guard the transport path. */
export function useCodexCompact(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // no live thread → nothing to compact
      return unwrap(commands.codexCompact(handle));
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Couldn't compact: ${message}`);
    },
  });
}

/** Clear a conversation's active `/goal` (Claude Code's native goal feature). Sends the native
 *  `/goal clear` local command to the session but WITHOUT an optimistic user turn — the goal is
 *  represented by the dedicated goal UI, so clearing it must not drop `/goal clear` into the thread
 *  (the Rust normalizer also drops the wire echo + its "No goal set" stdout). The caller arms the
 *  clear guard (`beginGoalClearing`) and hides the chip optimistically; this hook settles the guard
 *  once the send is accepted, and on FAILURE rolls the chip back to the still-active goal — never
 *  leaving it wrongly hidden over a live goal. Resumes a stopped session if needed, since the goal
 *  lives in the CLI session and only `/goal clear` actually clears it. */
export function useClearGoal(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  const sessionId = () =>
    useConversationsStore.getState().conversations.find((c) => c.id === convId)?.sessionId ?? null;
  return useMutation({
    mutationFn: async () => {
      const handle = await ensureConversationSession(convId);
      // No `addUserTurn`: silent send (Claude → no per-turn codex controls).
      return unwrap(commands.sendMessage(handle, "/goal clear", [], null));
    },
    onSuccess: () => {
      // The send was accepted: switch to the post-send grace window, then refetch so a confirmed
      // "no goal" read settles the guard (the optimistic null was correct).
      settleGoalClearing(convId);
      void refreshActiveGoal(convId, sessionId());
    },
    onError: (err) => {
      // The clear never reached the CLI (e.g. spawn/resume failed): release the guard and refetch
      // the TRUE state, restoring the still-active goal — the optimistic null was wrong.
      endGoalClearing(convId);
      void refreshActiveGoal(convId, sessionId());
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Couldn't clear the goal: ${message}`);
    },
  });
}

export function useStop(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async () => {
      const handle = liveHandle(convId);
      if (!handle) return; // already off
      return unwrap(commands.stopSession(handle));
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Failed to stop the session: ${message}`);
    },
  });
}

/** Enable/disable this conversation's Remote Control bridge (native `/remote-control`).
 *  Enabling needs a LIVE `claude` process (the bridge rides the running session), so we
 *  spawn one lazily if needed — clicking the chip on an idle conversation both starts it
 *  and bridges it. Disabling only matters if something is live. The result (connected +
 *  claude.ai/code URL / disconnected / error) is written to the live remote-control store;
 *  async health downgrades then arrive via `SessionRemoteControlEvent`. */
export function useSetRemoteControl(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async ({
      enabled,
      name,
      worktree,
    }: {
      enabled: boolean;
      name?: string;
      /** On a not-yet-spawned conversation, enabling spawns the session lazily; honor a
       *  pending "start in a fresh worktree" choice so activating remote control first
       *  doesn't silently foreclose it. */
      worktree?: boolean;
    }) => {
      const rc = useRemoteControlStore.getState();
      // Disabling with nothing live: the bridge is already gone with the process.
      const handle = enabled ? await ensureConversationSession(convId, { worktree }) : liveHandle(convId);
      if (!handle) {
        rc.set(convId, { status: "disconnected", session_url: null, error: null, pairing_code: null });
        return;
      }
      // Optimistic "connecting" so the chip reacts instantly during the handshake.
      if (enabled) rc.set(convId, { status: "connecting", session_url: null, error: null, pairing_code: null });
      const state = await unwrap(commands.setRemoteControl(handle, enabled, name ?? null));
      rc.set(convId, state);
      // An IN-BAND rejection (e.g. the binary answers success-with-status:"error" — a
      // policy-disabled bridge, or a wire success that returned no session_url) does NOT
      // throw, so `onError` never runs. Surface it in the thread too (not only the chip
      // dot) — every error stays visible, per the project's no-silent-failure rule.
      if (state.status === "error") {
        addErrorTurn(convId, `Remote control failed: ${state.error ?? "unknown error"}`);
      } else if (state.error) {
        // The bridge came UP but a secondary step failed (e.g. Codex enable succeeded yet
        // the pairing-code fetch failed): still surface it — the bridge is on but a device
        // can't be paired, and the user must know rather than see a silent no-code state.
        addErrorTurn(convId, `Remote control: ${state.error}`);
      }
      return state;
    },
    // A failed bridge toggle is otherwise invisible — reflect it on the chip AND
    // surface it in the thread so the user knows remote control didn't take.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      useRemoteControlStore
        .getState()
        .set(convId, { status: "error", session_url: null, error: message, pairing_code: null });
      addErrorTurn(convId, `Remote control failed: ${message}`);
    },
  });
}

/** Stop ONE background task (a `run_in_background` Bash) by its `task_id`, without
 *  ending the turn or the session. The task settles to `stopped` via its `task_*`
 *  lifecycle (the bar reflects it). No-op if nothing is live. */
export function useStopTask(convId: string) {
  const addErrorTurn = useConversationStore((s) => s.addErrorTurn);
  return useMutation({
    mutationFn: async (taskId: string) => {
      const handle = liveHandle(convId);
      if (!handle) return; // nothing live to stop
      return unwrap(commands.stopTask(handle, taskId));
    },
    // A failed stop is otherwise invisible — say it didn't take so the user knows the
    // background command is still running.
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      addErrorTurn(convId, `Failed to stop the background task: ${message}`);
    },
  });
}
