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
import { useEffect } from "react";
import {
  stopConversationSession,
  useConversationsStore,
} from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import { useRunningCountsByConv } from "../../store/backgroundTasksStore";

/** Conversations whose restart is in flight, so a re-render cannot fire a second stop
 *  for the same one. Module-level: it must not itself trigger a render. */
const applying = new Set<string>();

/** Mount once, next to the other always-on hosts. Renders nothing. */
export function ClaudeAccountApplyHost() {
  const convs = useConversationsStore((s) => s.conversations);
  const sessions = useConversationStore((s) => s.sessions);
  const bg = useRunningCountsByConv();

  useEffect(() => {
    for (const conv of convs) {
      if (conv.kind !== "claude" || !conv.handle) continue;
      const wanted = conv.claudeAccountId ?? null;
      const live = conv.liveClaudeAccountId ?? null;
      if (wanted === live) continue; // already running on the right account
      if (applying.has(conv.id)) continue;

      // The safe boundary: no turn in flight, and no background task still working
      // against the account this conversation is leaving.
      if (sessions[conv.id]?.state.busy) continue;
      if ((bg[conv.id] ?? 0) > 0) continue;

      applying.add(conv.id);
      void stopConversationSession(conv.id)
        .catch((e: unknown) => {
          // Never silent: a session that refused to stop is still authenticated as the
          // OLD account, and the user has to know the change did not take.
          useConversationStore
            .getState()
            .addErrorTurn(
              conv.id,
              `The Claude account was changed, but this session could not be restarted, so it is still running on the previous account (${e instanceof Error ? e.message : String(e)}). Turn the stream off and on to apply it.`,
            );
        })
        .finally(() => applying.delete(conv.id));
    }
  }, [convs, sessions, bg]);

  return null;
}
