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
  atAccountSwitchBoundary,
  autoSwitchSuspended,
  blockedNotice,
  decideSwitch,
  manualAccountPick,
  switchCooldownElapsed,
  switchNotice,
  usageForPolicy,
  useClaudeAccountPrefs,
  type AccountUsageSnapshot,
  type SwitchBlocked,
} from "../../store/claudeAccounts";
import {
  useClaudeAccount,
  useClaudeAccountIdentity,
  useClaudeAccounts,
} from "../../ipc/useAccounts";
import { usePlanUsage } from "../../store/planUsage";
import { isSpawning, useConversationsStore } from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import { useRunningCountsByConv } from "../../store/backgroundTasksStore";

/** One probe's published result. `settled` = both its sign-in status and its usage have
 *  answered at least once: a probe still loading reads as signed out with no figure, and
 *  must not be mistaken for "no other account is signed in" at launch. */
interface ProbeResult {
  snapshot: AccountUsageSnapshot;
  settled: boolean;
}

/** What each per-account probe publishes for the evaluator to read. Held in a store rather
 *  than gathered by looping hooks: the number of accounts changes at runtime, and calling
 *  a hook per account would break the rules of hooks the moment one is added or removed. */
const useAccountSnapshots = create<{
  byAccount: Record<string, ProbeResult>;
  publish: (key: string, result: ProbeResult) => void;
  forget: (key: string) => void;
}>((set) => ({
  byAccount: {},
  publish: (key, result) =>
    set((s) => ({ byAccount: { ...s.byAccount, [key]: result } })),
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
      {/* The default account + every registered one. */}
      <FleetEvaluator expected={rows.length + 1} />
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
  // What the policy may act on: a blip keeps the last good figure, a terminal cause drops it
  // and is reported (see `usageForPolicy`).
  const { usage: data, usageError } = usageForPolicy({
    data: usage.data ?? null,
    error: usage.error ?? null,
  });
  const fetchedAt = usage.dataUpdatedAt || null;
  // A still-loading probe is NOT treated as signed in: an unproven target is never chosen,
  // the same rule that keeps an account with unknown usage out of the running.
  const loggedIn = status.data?.loggedIn === true;
  const settled = usage.isFetched && status.isFetched;
  useEffect(() => {
    useAccountSnapshots.getState().publish(key, {
      snapshot: {
        id: accountId,
        label: name,
        loggedIn,
        usage: data,
        usageError,
        fetchedAt,
        // The default account sorts first, so it wins a tie against any added account.
        sortIndex: sortIndex ?? -1,
      },
      settled,
    });
  }, [key, accountId, name, sortIndex, loggedIn, data, usageError, fetchedAt, settled]);
  useEffect(() => () => useAccountSnapshots.getState().forget(key), [key]);
  return null;
}

/**
 * Evaluates the fleet against the current usage snapshot.
 *
 * Scope: only LIVE Claude conversations (a process running) in LOCAL repos. A dormant
 * conversation has nothing billed to it right now — moving it would rewrite a choice the
 * user made and leave it moved even after auto-switch is turned off. Once it spawns it has
 * a handle and is evaluated like any other. A remote conversation runs on the server's own
 * account and cannot be moved at all.
 *
 * Safety boundary (the task's hard constraint): a conversation is only considered when its
 * session shows no pending work at all — see `atAccountSwitchBoundary`. The restart itself
 * is `ClaudeAccountApplyHost`'s, which additionally waits for the session to settle.
 */
function FleetEvaluator({ expected }: { expected: number }) {
  const convs = useConversationsStore((s) => s.conversations);
  const repos = useConversationsStore((s) => s.repos);
  const sessions = useConversationStore((s) => s.sessions);
  const bg = useRunningCountsByConv();
  const byAccount = useAccountSnapshots((s) => s.byAccount);

  // The notice ledgers describe what THIS watch has said. Turning auto-switch off unmounts
  // the evaluator; turning it back on must report a still-standing situation again rather
  // than stay silent because an earlier watch mentioned it.
  useEffect(
    () => () => {
      told.clear();
      toldUnreadable.clear();
    },
    [],
  );

  useEffect(() => {
    const prefs = accountPrefs();
    if (!prefs.autoSwitch) return;
    const probes = Object.values(byAccount);
    // Launch guard: decide nothing until EVERY account has answered once. A half-loaded
    // fleet reads as "no other account is signed in" or "usage could not be read" — a
    // false notice, followed by a switch a moment later.
    if (probes.length < expected || probes.some((p) => !p.settled)) return;
    const snapshots = probes.map((p) => p.snapshot);
    if (snapshots.length < 2) return; // nowhere to switch to

    const remoteRepos = new Set(repos.filter((r) => r.machineId).map((r) => r.id));
    // Unreadable CURRENT accounts, reported once per ACCOUNT after the pass (see below).
    const unreadable = new Map<
      string,
      { current: AccountUsageSnapshot; blocked: SwitchBlocked & { reason: "unknown_current_usage" }; convIds: string[] }
    >();

    const now = Date.now();
    for (const conv of convs) {
      if (conv.kind !== "claude" || !conv.handle) continue;
      if (remoteRepos.has(conv.repoId)) continue;
      const accountId = conv.claudeAccountId ?? null;
      const accountKey = keyOf(accountId);

      // A marker describes the account it was recorded against. Any change of account since
      // (a manual pick, an auto-switch landing) voids it — otherwise a "to:B" marker left
      // by an earlier switch silently swallowed the same decision once the user moved back.
      const marker = told.get(conv.id);
      if (marker && marker.account !== accountKey) told.delete(conv.id);

      // The user chose this conversation's account: never overrule them.
      if (autoSwitchSuspended(manualAccountPick(conv.id), accountId)) continue;
      if (!atAccountSwitchBoundary(sessions[conv.id], bg[conv.id] ?? 0, isSpawning(conv.id))) {
        continue;
      }
      if (!switchCooldownElapsed(conv.lastAccountSwitchAt ?? null, now)) continue;

      const current = byAccount[accountKey]?.snapshot;
      if (!current) continue; // its account has no measurement yet — never guess

      const verdict = decideSwitch(current, snapshots, prefs);
      if (!verdict) {
        // Below the threshold: forget any "already told you" marker so the next approach
        // to a limit is reported again.
        told.delete(conv.id);
        continue;
      }

      if ("blocked" in verdict && verdict.blocked.reason === "unknown_current_usage") {
        const group = unreadable.get(accountKey) ?? {
          current,
          blocked: verdict.blocked,
          convIds: [],
        };
        group.convIds.push(conv.id);
        unreadable.set(accountKey, group);
        continue;
      }

      // One notice per conversation per situation — otherwise every unrelated store
      // update would re-report the same standing state. The key folds in the outcome, so
      // a blocked switch that later becomes possible still acts.
      const key =
        "switchTo" in verdict
          ? `to:${keyOf(verdict.switchTo.to.id)}`
          : `blocked:${verdict.blocked.reason}`;
      if (told.get(conv.id)?.key === key) continue;

      if ("switchTo" in verdict) {
        // Recorded against the account the conversation now WANTS, so the switch's own
        // write does not void the marker it just set.
        told.set(conv.id, { account: keyOf(verdict.switchTo.to.id), key });
        useConversationsStore
          .getState()
          .setConvClaudeAccount(conv.id, verdict.switchTo.to.id, { auto: true });
        // Stated in the thread, naming both accounts and the quota reason — a switch the
        // user cannot see is a switch they cannot trust.
        useConversationStore.getState().addErrorTurn(conv.id, switchNotice(verdict.switchTo));
      } else {
        told.set(conv.id, { account: accountKey, key });
        // Armed but impossible. This is exactly the moment the user needs telling: their
        // account is nearly full and nothing was done about it.
        useConversationStore
          .getState()
          .addErrorTurn(conv.id, blockedNotice(current, verdict.blocked));
      }
    }

    // An account whose usage cannot be read is ONE problem, not one per conversation: it is
    // reported once per account (into the live conversations running on it right now), and
    // not again — not even after a recovery — unless the cause itself changes. Only
    // terminal causes reach here (`usageForPolicy` keeps blips quiet).
    for (const [accountKey, group] of unreadable) {
      const cause = group.blocked.detail ?? "unknown";
      if (toldUnreadable.get(accountKey) === cause) continue;
      toldUnreadable.set(accountKey, cause);
      const text = blockedNotice(group.current, group.blocked);
      for (const convId of group.convIds) {
        useConversationStore.getState().addErrorTurn(convId, text);
      }
    }
  }, [convs, repos, sessions, bg, byAccount, expected]);

  return null;
}

/** Which situation each conversation was last told about — and on which account — so a
 *  standing state is reported once rather than on every store update. Module-level (not
 *  state): it must not itself trigger a re-render, and it is rebuilt from scratch on reload
 *  like the cooldown. */
const told = new Map<string, { account: string; key: string }>();

/** The last unreadable-usage cause reported per ACCOUNT. Deliberately not cleared when the
 *  account reads again: an error/recovery cycle must not re-post into every thread. */
const toldUnreadable = new Map<string, string>();
