// Fleet-level aggregation of agent statuses — the counts behind the "Fleet readout"
// banner (the compact box at the bottom of the conversation sidebar and the wide bar
// at the top of the FlightDeck) and the status-ordered FlightDeck lanes. Each
// conversation's status is derived from the SAME pure model the per-card hook uses
// (agentStatusForEntry), so the banner and the cards never disagree.
//
// Perf note: this recomputes over all sessions on every message-store delta. Fine
// at the handful-of-agents scale we target; if the fleet grows large, promote a
// standing per-conversation attention flag into the store instead of re-deriving.
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "../store/conversationStore";
import { useRunningCountsByConv, useRunningBashCountsByConv } from "../store/backgroundTasksStore";
import { useDisplay } from "../store/display";
import {
  groupByRepo,
  useConversations,
  useRepos,
  type Conversation,
  type Repo,
  type RepoGroup,
} from "../store/conversationsStore";
import {
  useOrderSlot,
  slotFor,
  manualIndex,
  manualConvIndex,
  manualComparator,
  type OrderBlob,
} from "../store/manualOrder";
import { readoutBucket, statusRank, type AgentStatus } from "./status";
import { agentStatusForEntry } from "./useAgentStatus";

// ---- Fleet readout (the "N Running · N Review · …" banner) ----------------------

/**
 * The four fleet-readout stage counts, plus the fleet total. Carries `running` and
 * `idle` alongside the attention stages, so the readout banner (sidebar + FlightDeck
 * top) can render every stage, not just the ones demanding attention. Each conversation
 * lands in exactly one bucket via {@link readoutBucket},
 * so `running + review + needAttention + idle === total`.
 */
export interface FleetCounts {
  running: number;
  review: number;
  needAttention: number;
  idle: number;
  total: number;
}

const EMPTY_COUNTS: FleetCounts = { running: 0, review: 0, needAttention: 0, idle: 0, total: 0 };

/** Tally a list of statuses into the four readout stages. Pure + testable. */
export function tallyFleet(statuses: AgentStatus[]): FleetCounts {
  const t: FleetCounts = { running: 0, review: 0, needAttention: 0, idle: 0, total: 0 };
  for (const s of statuses) {
    t[readoutBucket(s)]++;
    t.total++;
  }
  return t;
}

/** A single rendered stage of the readout line: its stage key (→ colour class), the
 *  English label, and the count. */
export interface FleetSegment {
  key: "running" | "review" | "needAttention" | "idle";
  label: string;
  count: number;
}

/**
 * The stages to render, in display order (activity first: Running → Review → Need
 * Attention → Idle), with the zero stages dropped. Pure so the "hide zeros / order"
 * rule is locked in a test. Idle is included like any other stage when non-zero — the
 * calm phrasing ("Fleet rests · N Idle") is a separate presentation decision the
 * component makes via {@link isFleetCalm}, not a filtering rule here.
 */
export function fleetSegments(c: FleetCounts): FleetSegment[] {
  const all: FleetSegment[] = [
    { key: "running", label: "Running", count: c.running },
    { key: "review", label: "Review", count: c.review },
    { key: "needAttention", label: "Need Attention", count: c.needAttention },
    { key: "idle", label: "Idle", count: c.idle },
  ];
  return all.filter((s) => s.count > 0);
}

/**
 * The COMPACT stage list for the narrow conversation sidebar: only three stages, with
 * Review folded into a single "Attention" bucket (review + needAttention) so the full
 * words fit on one line even at the minimum sidebar width. Same zero-drop + activity-
 * first order as {@link fleetSegments}. The merged bucket keeps the `needAttention` key
 * so it renders in the same (orange) colour. The FlightDeck keeps the full four-stage
 * {@link fleetSegments}; only the sidebar merges.
 */
export function mergedFleetSegments(c: FleetCounts): FleetSegment[] {
  const all: FleetSegment[] = [
    { key: "running", label: "Running", count: c.running },
    { key: "needAttention", label: "Attention", count: c.review + c.needAttention },
    { key: "idle", label: "Idle", count: c.idle },
  ];
  return all.filter((s) => s.count > 0);
}

/** Whether nothing in the fleet is active — no running, review, or attention stage.
 *  In this state the banner reads "Fleet rests · N Idle" instead of listing stages. */
export function isFleetCalm(c: FleetCounts): boolean {
  return c.running === 0 && c.review === 0 && c.needAttention === 0;
}

/**
 * Live readout counts across every conversation — the same derive-per-conversation
 * path as {@link useFleetLanes}, tallied into the four stages instead. `useShallow`
 * over the counts means the banner only re-renders when a count actually moves.
 */
export function useFleetCounts(): FleetCounts {
  const convs = useConversations();
  const bg = useRunningCountsByConv();
  const bgBash = useRunningBashCountsByConv();
  const reAlertBash = useDisplay((s) => s.alertOnBackgroundBash);
  return useConversationStore(
    useShallow((s) =>
      convs.length === 0
        ? EMPTY_COUNTS
        : tallyFleet(
            convs.map((c) =>
              agentStatusForEntry(
                c.handle,
                s.sessions[c.id],
                c.pendingReminder,
                bg[c.id] ?? 0,
                bgBash[c.id] ?? 0,
                reAlertBash,
              ),
            ),
          ),
    ),
  );
}

// ---- FlightDeck lanes (one horizontal lane per repo, status-ordered) -----------

// A lane is exactly a repo group; the FlightDeck just orders it status-first. Kept
// as an alias so the two grids share one type (and one grouping skeleton).
export type FleetLane = RepoGroup;

/**
 * Order the fleet for the swimlane layout (PURE, testable): group by repo, sort
 * each repo's conversations by status (action-required/error → review → running →
 * idle → off, recency as tiebreak), then order the repos by their most urgent
 * conversation (recency as tiebreak; empty repos last). `rank` is injected so the
 * status source stays out of this pure function. Shares the grouping skeleton with
 * the sidebar's `groupConversationsByRepo` (`groupByRepo`); only the comparators
 * differ (status-first here vs recency there).
 */
export function orderLanes(
  repos: Repo[],
  conversations: Conversation[],
  rank: (c: Conversation) => number,
  // When present, a level whose `auto*` flag is FALSE uses the MANUAL drag order from
  // `order` instead of the status-first sort (new/never-dragged items go to the very
  // start, newest-first). Omitted → the historical all-automatic behaviour.
  manual?: { order: OrderBlob; autoConvs: boolean; autoRepos: boolean },
): FleetLane[] {
  const manualConvs = !!manual && !manual.autoConvs;
  const manualRepos = !!manual && !manual.autoRepos;
  const needRank = !manualConvs || !manualRepos;
  // Derive each conversation's status rank ONCE. `rank` runs a real status
  // derivation (not a cheap field read), so calling it inside the O(n log n) sort
  // comparators below would re-derive the same conversation on every compare —
  // O(n log n) derivations per recompute, replayed on every streaming delta. Cache
  // it to one derivation per conversation; the comparators read the cached value.
  // (Skipped entirely when BOTH levels are manual — no status needed then.)
  const rankById = new Map<string, number>();
  if (needRank) for (const c of conversations) rankById.set(c.id, rank(c));
  const r = (c: Conversation) => rankById.get(c.id) ?? 99;
  // After the status sort, a group's first conversation holds its lowest (most
  // urgent) rank; the lane's recency tiebreak is the max activity across it.
  const repoRank = (g: FleetLane) => (g.conversations.length ? r(g.conversations[0]) : 99);
  const repoAt = (g: FleetLane) =>
    g.conversations.length
      ? Math.max(...g.conversations.map((c) => c.lastActivityAt))
      : g.repo.addedAt;
  const sortConvs = manualConvs
    ? manualComparator<Conversation>(manualConvIndex(manual!.order.convOrder), (c) => c.id, (c) => c.createdAt)
    : (a: Conversation, b: Conversation) => r(a) - r(b) || b.lastActivityAt - a.lastActivityAt;
  const sortRepos = manualRepos
    ? manualComparator<FleetLane>(manualIndex(manual!.order.repoOrder), (g) => g.repo.id, (g) => g.repo.addedAt)
    : (a: FleetLane, b: FleetLane) => repoRank(a) - repoRank(b) || repoAt(b) - repoAt(a);
  return groupByRepo(repos, conversations, sortConvs, sortRepos);
}

/** Project lanes to a flat, shallow-stable order-token list, so `useShallow` can
 *  gate re-renders on order changes alone. Inverse of {@link rebuildLanes}. */
export function lanesToTokens(lanes: FleetLane[]): string[] {
  return lanes.flatMap((l) => ["r:" + l.repo.id, ...l.conversations.map((c) => "c:" + c.id)]);
}

/** Rebuild the lane objects from a flat order-token list (inverse of
 *  {@link lanesToTokens}). Tokens for a repo/conversation no longer present — a
 *  stale order list racing a removal — are skipped. */
export function rebuildLanes(tokens: string[], repos: Repo[], conversations: Conversation[]): FleetLane[] {
  const repoById = new Map(repos.map((r) => [r.id, r] as const));
  const convById = new Map(conversations.map((c) => [c.id, c] as const));
  const lanes: FleetLane[] = [];
  let cur: FleetLane | null = null;
  for (const t of tokens) {
    if (t[0] === "r") {
      const repo = repoById.get(t.slice(2));
      if (repo) {
        cur = { repo, conversations: [] };
        lanes.push(cur);
      } else {
        cur = null;
      }
    } else if (cur) {
      const c = convById.get(t.slice(2));
      if (c) cur.conversations.push(c);
    }
  }
  return lanes;
}

/**
 * The status-ordered repo lanes for the FlightDeck. Recomputes the order on session
 * changes but, via `useShallow` over a flat order-token list, only RE-RENDERS when
 * the order actually moves — not on every streaming delta.
 */
export function useFleetLanes(): FleetLane[] {
  const repos = useRepos();
  const conversations = useConversations();
  const bg = useRunningCountsByConv();
  const bgBash = useRunningBashCountsByConv();
  const reAlertBash = useDisplay((s) => s.alertOnBackgroundBash);
  const autoConvs = useDisplay((s) => s.autoOrderFleetConvs);
  const autoRepos = useDisplay((s) => s.autoOrderFleetRepos);
  const shared = useDisplay((s) => s.sharedManualOrder);
  const order = useOrderSlot(slotFor("flightdeck", shared));
  const tokens = useConversationStore(
    useShallow((s) => {
      const rank = (c: Conversation) =>
        statusRank(
          agentStatusForEntry(
            c.handle,
            s.sessions[c.id],
            c.pendingReminder,
            bg[c.id] ?? 0,
            bgBash[c.id] ?? 0,
            reAlertBash,
          ),
        );
      return lanesToTokens(orderLanes(repos, conversations, rank, { order, autoConvs, autoRepos }));
    }),
  );
  return useMemo(() => rebuildLanes(tokens, repos, conversations), [tokens, repos, conversations]);
}
