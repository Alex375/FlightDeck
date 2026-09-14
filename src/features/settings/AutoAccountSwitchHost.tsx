// The auto-switch controller: ONE always-mounted host that moves conversations off a
// Claude account approaching its usage limit.
//
// Why a single host rather than per-conversation logic: usage is per SUBSCRIPTION, so the
// figures are watched once per ACCOUNT (a handful of queries) instead of once per
// conversation or per Flight Deck card. The whole fleet is then evaluated against that one
// snapshot, which is also what keeps decisions consistent — two conversations armed by the
// same tick cannot scatter to different accounts.
//
// The decision itself is pure and unit-tested (`store/claudeAccounts.ts`); this file is
// only the plumbing: when to look, whether it is safe to act, and how to tell the user.
import { useEffect } from "react";
import { create } from "zustand";
import {
  accountPrefs,
  blockedNotice,
  decideSwitch,
  switchCooldownElapsed,
  switchNotice,
  useClaudeAccountPrefs,
  type AccountUsageSnapshot,
} from "../../store/claudeAccounts";
import {
  useClaudeAccount,
  useClaudeAccountIdentity,
  useClaudeAccounts,
} from "../../ipc/useAccounts";
import { usePlanUsage } from "../../store/planUsage";
import { useConversationsStore } from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import { useRunningCountsByConv } from "../../store/backgroundTasksStore";

/** What each per-account probe publishes for the evaluator to read. Held in a store rather
 *  than gathered by looping hooks: the number of accounts changes at runtime, and calling
 *  a hook per account would break the rules of hooks the moment one is added or removed. */
const useAccountSnapshots = create<{
  byAccount: Record<string, AccountUsageSnapshot>;
  publish: (key: string, snapshot: AccountUsageSnapshot) => void;
  forget: (key: string) => void;
}>((set) => ({
  byAccount: {},
  publish: (key, snapshot) =>
    set((s) => ({ byAccount: { ...s.byAccount, [key]: snapshot } })),
  forget: (key) =>
    set((s) => {
      if (!(key in s.byAccount)) return s;
      const next = { ...s.byAccount };
      delete next[key];
      return { byAccount: next };
    }),
}));

const keyOf = (id: string | null) => id ?? "default";

/** Mount once, next to the other always-on hosts. Renders nothing. */
export function AutoAccountSwitchHost() {
  const autoSwitch = useClaudeAccountPrefs((s) => s.autoSwitch);
  const accounts = useClaudeAccounts(autoSwitch);
  const rows = accounts.data ?? [];
  // A switch needs somewhere to switch TO. With only the default account the whole
  // watcher — including every usage fetch it would make — stays off, so enabling the
  // preference on a single-account setup costs nothing.
  if (!autoSwitch || rows.length === 0) return null;
  return (
    <>
      <AccountProbe accountId={null} />
      {rows.map((a) => (
        <AccountProbe
          key={a.id}
          accountId={a.id}
          label={a.email ?? a.label}
          sortIndex={a.sort_index}
        />
      ))}
      <FleetEvaluator />
    </>
  );
}

/** Keeps ONE account's usage query alive (and its sign-in status, since a signed-out
 *  account can never be a switch target) and publishes the result. Renders nothing.
 *
 *  `usePlanUsage` already polls, backs off on a 429 and stops entirely for causes a retry
 *  cannot fix, so this inherits the endpoint etiquette rather than inventing a second
 *  cadence beside it. */
function AccountProbe({
  accountId,
  label,
  sortIndex,
}: {
  accountId: string | null;
  label?: string;
  sortIndex?: number;
}) {
  const usage = usePlanUsage({ accountId });
  const status = useClaudeAccount(true, accountId);
  // The switch notices name accounts by their ADDRESS (read with the account's own token),
  // like every other surface; the passed label is only the fallback.
  const identity = useClaudeAccountIdentity(accountId, true);
  const name = identity.data?.email ?? label ?? "Claude";
  const key = keyOf(accountId);
  // A read that currently FAILS publishes no figure. React Query keeps the last successful
  // `data` across an error, and `usePlanUsage` stops polling for terminal causes — so
  // trusting `data` here would freeze the account at an old measurement forever and let
  // the policy act on it as if it were live.
  const data = usage.isError ? null : (usage.data ?? null);
  const usageError = usage.error ? usage.error.kind : null;
  const fetchedAt = usage.dataUpdatedAt || null;
  // A still-loading probe is NOT treated as signed in: an unproven target is never chosen,
  // the same rule that keeps an account with unknown usage out of the running.
  const loggedIn = status.data?.loggedIn === true;
  useEffect(() => {
    useAccountSnapshots.getState().publish(key, {
      id: accountId,
      label: name,
      loggedIn,
      usage: data,
      usageError,
      fetchedAt,
      // The default account sorts first, so it wins a tie against any added account.
      sortIndex: sortIndex ?? -1,
    });
    return () => useAccountSnapshots.getState().forget(key);
  }, [key, accountId, name, sortIndex, loggedIn, data, usageError, fetchedAt]);
  return null;
}

/**
 * Evaluates the fleet against the current usage snapshot.
 *
 * Safety boundary (the task's hard constraint): a conversation is only moved when its
 * session is NOT mid-turn and has NO background task running. The chosen policy is the
 * most reactive one — act as soon as the current turn ends — so this fires on the settle,
 * never inside a turn, a tool call, or while detached work continues against the account
 * the conversation is about to leave.
 */
function FleetEvaluator() {
  const convs = useConversationsStore((s) => s.conversations);
  const sessions = useConversationStore((s) => s.sessions);
  const bg = useRunningCountsByConv();
  const byAccount = useAccountSnapshots((s) => s.byAccount);

  useEffect(() => {
    const prefs = accountPrefs();
    if (!prefs.autoSwitch) return;
    const snapshots = Object.values(byAccount);
    if (snapshots.length < 2) return; // nowhere to switch to yet (or still loading)

    const now = Date.now();
    for (const conv of convs) {
      if (conv.kind !== "claude") continue;
      const state = sessions[conv.id];
      // Safe boundary: `busy` covers the turn in flight; the background count covers
      // detached agents and monitors, which would otherwise keep running against an
      // account the conversation has just left.
      if (state?.state.busy) continue;
      if ((bg[conv.id] ?? 0) > 0) continue;
      if (!switchCooldownElapsed(conv.lastAccountSwitchAt ?? null, now)) continue;

      const current = byAccount[keyOf(conv.claudeAccountId ?? null)];
      if (!current) continue; // its account has no measurement yet — never guess

      const verdict = decideSwitch(current, snapshots, prefs);
      if (!verdict) {
        // Below the threshold: forget any "already told you" marker so the next approach
        // to a limit is reported again.
        told.delete(conv.id);
        continue;
      }

      // One notice per conversation per situation — otherwise every unrelated store
      // update would re-report the same standing state. The key folds in the outcome, so
      // a blocked switch that later becomes possible still acts.
      const key =
        "switchTo" in verdict
          ? `to:${keyOf(verdict.switchTo.to.id)}`
          : `blocked:${verdict.blocked.reason}`;
      if (told.get(conv.id) === key) continue;
      told.set(conv.id, key);

      if ("switchTo" in verdict) {
        useConversationsStore
          .getState()
          .setConvClaudeAccount(conv.id, verdict.switchTo.to.id, { auto: true });
        // Stated in the thread, naming both accounts and the quota reason — a switch the
        // user cannot see is a switch they cannot trust.
        useConversationStore.getState().addErrorTurn(conv.id, switchNotice(verdict.switchTo));
      } else {
        // Armed but impossible. This is exactly the moment the user needs telling: their
        // account is nearly full and nothing was done about it.
        useConversationStore
          .getState()
          .addErrorTurn(conv.id, blockedNotice(current, verdict.blocked));
      }
    }
  }, [convs, sessions, bg, byAccount]);

  return null;
}

/** Which situation each conversation was last told about, so a standing state is reported
 *  once rather than on every store update. Module-level (not state): it must not itself
 *  trigger a re-render, and it is rebuilt from scratch on reload like the cooldown. */
const told = new Map<string, string>();
