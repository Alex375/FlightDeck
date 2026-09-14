// Applies a PENDING Claude account change to a live session — and only at a safe
// boundary.
//
// A running `claude` process cannot change identity: it reads its credentials once at
// startup. So applying a new account means stopping the process and letting the next turn
// re-spawn it (lazily, with `--resume`, so the transcript continues untouched).
//
// That stop must never land mid-turn. Both the manual picker and the auto-switch therefore
// only WRITE the choice; this host is the single place that acts on it, once the session
// is idle and no background work is still running against the account being left. Until
// then `conv.liveClaudeAccountId` keeps the composer honest — it shows the account really
// in use, marked as pending.
//
// Always mounted: a pending change is possible whether or not the auto-switch preference
// is on, and a change that quietly never applied would be the worst outcome of all.
import { useEffect, useRef } from "react";
import {
  isSpawning,
  stopConversationSession,
  useConversationsStore,
  type Conversation,
} from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import {
  runningCountFor,
  useBackgroundTasksStore,
  useRunningCountsByConv,
} from "../../store/backgroundTasksStore";
import { atAccountSwitchBoundary } from "../../store/claudeAccounts";
import { SETTLE_MS } from "../../notifications/transition";

/** How long a conversation must sit at the boundary before its process is stopped. The
 *  same window the "done" notification waits, for the same reason: a `result` is not the
 *  end of the conversation — the CLI takes control straight back for anything queued within
 *  ~1 s — and `activity` / `busy` only flag the next turn a beat after the result. */
const APPLY_SETTLE_MS = SETTLE_MS.done;

/** Conversations whose restart is in flight, so a re-render cannot fire a second stop
 *  for the same one. Module-level: it must not itself trigger a render. */
const applying = new Set<string>();

/** Whether `conv` runs a live Claude process on an account other than the one it wants. */
function needsApply(conv: Conversation): boolean {
  if (conv.kind !== "claude" || !conv.handle) return false;
  if ((conv.claudeAccountId ?? null) === (conv.liveClaudeAccountId ?? null)) return false;
  return !applying.has(conv.id);
}

/** The boundary check against FRESH store state — never a render's closure, which can be a
 *  full settle window old by the time a timer fires. */
function atBoundaryNow(convId: string): boolean {
  return atAccountSwitchBoundary(
    useConversationStore.getState().sessions[convId],
    runningCountFor(useBackgroundTasksStore.getState().sessions, convId),
    isSpawning(convId),
  );
}

/** Stop the process — if, after the settle window, the change is still pending and the
 *  conversation is still at rest. If not, nothing happens now: whatever broke the boundary
 *  (a queued turn starting, a background task) changes the stores again when it ends, and
 *  that render re-arms the settle. */
function applyIfStillSafe(convId: string) {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv || !needsApply(conv) || !atBoundaryNow(convId)) return;
  applying.add(convId);
  void stopConversationSession(convId)
    .catch((e: unknown) => {
      // Never silent: a session that refused to stop is still authenticated as the
      // OLD account, and the user has to know the change did not take.
      useConversationStore
        .getState()
        .addErrorTurn(
          convId,
          `The Claude account was changed, but this session could not be restarted, so it is still running on the previous account (${e instanceof Error ? e.message : String(e)}). Turn the stream off and on to apply it.`,
        );
    })
    .finally(() => applying.delete(convId));
}

/** Mount once, next to the other always-on hosts. Renders nothing. */
export function ClaudeAccountApplyHost() {
  const convs = useConversationsStore((s) => s.conversations);
  const sessions = useConversationStore((s) => s.sessions);
  const bg = useRunningCountsByConv();
  /** One settle timer per conversation currently waiting at the boundary. */
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const armed = timers.current;
    const waiting = new Set<string>();
    for (const conv of convs) {
      if (!needsApply(conv)) continue;
      if (!atAccountSwitchBoundary(sessions[conv.id], bg[conv.id] ?? 0, isSpawning(conv.id))) {
        continue;
      }
      waiting.add(conv.id);
      if (armed.has(conv.id)) continue; // already settling — don't restart the window
      armed.set(
        conv.id,
        setTimeout(() => {
          armed.delete(conv.id);
          applyIfStillSafe(conv.id);
        }, APPLY_SETTLE_MS),
      );
    }
    // Disarm every conversation that LEFT the boundary during its window (the CLI picked
    // up a queued message, a first turn started on a just-bound handle, the change was
    // reverted, the process went away): the stop must never fire on stale evidence.
    for (const [id, t] of armed) {
      if (waiting.has(id)) continue;
      clearTimeout(t);
      armed.delete(id);
    }
  }, [convs, sessions, bg]);

  useEffect(() => {
    const armed = timers.current;
    return () => {
      for (const t of armed.values()) clearTimeout(t);
      armed.clear();
    };
  }, []);

  return null;
}
