import { describe, it, expect } from "vitest";
import {
  activeConversationIds,
  fleetSegments,
  isFleetCalm,
  lanesToTokens,
  mergedFleetSegments,
  orderLanes,
  rebuildLanes,
  tallyFleet,
} from "./fleet";
import { statusRank, type AgentStatus } from "./status";
import type { Conversation, Repo } from "../store/conversationsStore";
import type { SessionEntry } from "../store/types";

function repo(id: string, addedAt: number): Repo {
  return { id, path: "/r/" + id, addedAt };
}
function conv(id: string, repoId: string, lastActivityAt: number): Conversation {
  return { id, repoId, lastActivityAt } as unknown as Conversation;
}

/** A conversation with a live handle (the only field `activeConversationIds`
 *  itself reads off `Conversation`, besides `id`/`pendingReminder`). */
function liveConv(id: string, repoId: string, handle = "session-1"): Conversation {
  return { id, repoId, handle, pendingReminder: null } as unknown as Conversation;
}

/** Minimal `SessionEntry` stub — only the fields `gather()`/`deriveAgentStatus`
 *  actually read for a NON-settled (busy or awaiting-permission) entry, which is
 *  all `activeConversationIds`'s test cases below need. */
function sessionEntry(opts: {
  busy?: boolean;
  awaitingPermission?: boolean;
  pendingTool?: string | null;
  turnSeen?: boolean;
}): SessionEntry {
  return {
    session: "s",
    state: {
      busy: opts.busy ?? false,
      awaiting_permission: opts.awaitingPermission ?? false,
      activity: null,
    },
    timeline: [],
    turns: {},
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: {},
    pendingPermissions: opts.pendingTool
      ? [{ request_id: "r", tool_name: opts.pendingTool, title: null, description: null }]
      : [],
    openBubble: {},
    subThreads: {},
    bgAgentIds: [],
    todos: [],
    turnSeen: opts.turnSeen ?? true,
  } as unknown as SessionEntry;
}

describe("activeConversationIds", () => {
  it("includes a conversation with a turn in flight", () => {
    const convs = [liveConv("c1", "r1")];
    const sessions = { c1: sessionEntry({ busy: true }) };
    expect(activeConversationIds(convs, sessions, {}, {}, false)).toEqual(["c1"]);
  });

  it("excludes a settled, idle conversation with no background work", () => {
    const convs = [liveConv("c1", "r1")];
    const sessions = { c1: sessionEntry({}) };
    expect(activeConversationIds(convs, sessions, {}, {}, false)).toEqual([]);
  });

  it("includes a conversation whose main loop is idle but background tools are running", () => {
    const convs = [liveConv("c1", "r1")];
    const sessions = { c1: sessionEntry({}) };
    expect(activeConversationIds(convs, sessions, { c1: 2 }, {}, false)).toEqual(["c1"]);
  });

  it("includes a masked case — a blocking permission prompt hides `backgrounding`, but the background count still counts it as active", () => {
    // needIntervention (a non-questionnaire pending tool) is not `isActivelyRunning`,
    // yet the conversation genuinely has live background work — same masking ConvRow's
    // own `busyForDelete` guards against.
    const convs = [liveConv("c1", "r1")];
    const sessions = { c1: sessionEntry({ awaitingPermission: true, pendingTool: "Bash" }) };
    expect(activeConversationIds(convs, sessions, { c1: 3 }, {}, false)).toEqual(["c1"]);
  });

  it("only returns ids for the conversations passed in — callers filter to one server first", () => {
    const convs = [liveConv("c1", "r1"), liveConv("c2", "r2")];
    const sessions = { c1: sessionEntry({ busy: true }), c2: sessionEntry({ busy: true }) };
    expect(activeConversationIds([convs[0]], sessions, {}, {}, false)).toEqual(["c1"]);
  });
});

describe("tallyFleet", () => {
  it("folds every status kind into exactly one of the four readout stages", () => {
    const statuses: AgentStatus[] = [
      { kind: "running", activity: null }, // running
      { kind: "backgrounding", count: 2 }, // running (background work still counts)
      { kind: "review" }, // review
      { kind: "needIntervention", tool: "Bash" }, // needAttention
      { kind: "needInput", via: "questionnaire", prompt: "?" }, // needAttention
      { kind: "needInput", via: "openQuestion", prompt: "?" }, // needAttention
      { kind: "error", message: "boom" }, // needAttention
      { kind: "idle" }, // idle
      { kind: "off" }, // idle (dormant, no process)
    ];
    expect(tallyFleet(statuses)).toEqual({
      running: 2,
      review: 1,
      needAttention: 4,
      idle: 2,
      total: 9,
    });
  });

  it("keeps running + review + needAttention + idle === total", () => {
    const t = tallyFleet([
      { kind: "running", activity: null },
      { kind: "review" },
      { kind: "error", message: "x" },
      { kind: "off" },
    ]);
    expect(t.running + t.review + t.needAttention + t.idle).toBe(t.total);
  });

  it("is all-zero for an empty fleet", () => {
    expect(tallyFleet([])).toEqual({
      running: 0,
      review: 0,
      needAttention: 0,
      idle: 0,
      total: 0,
    });
  });
});

describe("fleetSegments", () => {
  it("keeps only non-zero stages, in activity-first order", () => {
    const segs = fleetSegments({ running: 3, review: 0, needAttention: 2, idle: 5, total: 10 });
    expect(segs.map((s) => [s.key, s.count])).toEqual([
      ["running", 3],
      ["needAttention", 2], // review dropped (zero); order still Running → NeedAttention → Idle
      ["idle", 5],
    ]);
    expect(segs.find((s) => s.key === "needAttention")!.label).toBe("Need Attention");
  });

  it("returns nothing when every stage is zero", () => {
    expect(fleetSegments({ running: 0, review: 0, needAttention: 0, idle: 0, total: 0 })).toEqual([]);
  });
});

describe("mergedFleetSegments (compact sidebar view)", () => {
  it("folds review into a single 'Attention' bucket, keeping the orange key", () => {
    const segs = mergedFleetSegments({ running: 3, review: 1, needAttention: 2, idle: 5, total: 11 });
    expect(segs.map((s) => [s.key, s.label, s.count])).toEqual([
      ["running", "Running", 3],
      ["needAttention", "Attention", 3], // review (1) + needAttention (2)
      ["idle", "Idle", 5],
    ]);
  });

  it("drops the Attention stage when both review and needAttention are zero", () => {
    const segs = mergedFleetSegments({ running: 3, review: 0, needAttention: 0, idle: 4, total: 7 });
    expect(segs.map((s) => s.key)).toEqual(["running", "idle"]);
  });
});

describe("isFleetCalm", () => {
  it("is calm only when nothing is running, in review, or needing attention", () => {
    expect(isFleetCalm({ running: 0, review: 0, needAttention: 0, idle: 7, total: 7 })).toBe(true);
    expect(isFleetCalm({ running: 1, review: 0, needAttention: 0, idle: 6, total: 7 })).toBe(false);
    expect(isFleetCalm({ running: 0, review: 1, needAttention: 0, idle: 6, total: 7 })).toBe(false);
    expect(isFleetCalm({ running: 0, review: 0, needAttention: 1, idle: 6, total: 7 })).toBe(false);
  });
});

describe("statusRank", () => {
  it("ranks action-required/error first, then review, running, and the idle/off history", () => {
    expect(statusRank({ kind: "needIntervention", tool: "Bash" })).toBe(0);
    expect(statusRank({ kind: "needInput", via: "questionnaire", prompt: null })).toBe(0);
    expect(statusRank({ kind: "error", message: "x" })).toBe(0);
    expect(statusRank({ kind: "review" })).toBe(1);
    expect(statusRank({ kind: "running", activity: null })).toBe(2);
    expect(statusRank({ kind: "backgrounding", count: 1 })).toBe(3);
    expect(statusRank({ kind: "idle" })).toBe(4);
    expect(statusRank({ kind: "off" })).toBe(5);
  });
});

describe("orderLanes", () => {
  it("sorts cards active-first within a repo and floats repos with activity to the top", () => {
    const repos = [repo("a", 1), repo("b", 2)];
    const conversations = [
      conv("a-idle", "a", 100),
      conv("a-run", "a", 50),
      conv("b-ask", "b", 10),
    ];
    const rank = (c: Conversation) => (c.id === "a-idle" ? 3 : c.id === "a-run" ? 2 : 0);

    const lanes = orderLanes(repos, conversations, rank);

    // repo b holds the only action-required agent (rank 0) → floats above repo a.
    expect(lanes.map((l) => l.repo.id)).toEqual(["b", "a"]);
    // within repo a, the running agent (rank 2) precedes the idle one (rank 3).
    expect(lanes[1].conversations.map((c) => c.id)).toEqual(["a-run", "a-idle"]);
  });

  it("breaks rank ties by recency and sinks empty repos to the bottom", () => {
    const repos = [repo("a", 1), repo("empty", 999)];
    const conversations = [conv("c1", "a", 50), conv("c2", "a", 300)];
    const rank = () => 3; // everything idle

    const lanes = orderLanes(repos, conversations, rank);

    // a (has conversations, rank 3) outranks the empty repo (rank 99).
    expect(lanes.map((l) => l.repo.id)).toEqual(["a", "empty"]);
    expect(lanes[0].conversations.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(lanes.find((l) => l.repo.id === "empty")!.conversations).toEqual([]);
  });

  it("orders two conversation-less repos by addedAt (most recent first)", () => {
    // Both repos are empty → equal rank (99); the only signal left is the addedAt
    // tiebreak. The dedicated case for the otherwise-unexercised `repoAt` branch.
    const repos = [repo("old", 100), repo("new", 200)];

    const lanes = orderLanes(repos, [], () => 0);

    expect(lanes.map((l) => l.repo.id)).toEqual(["new", "old"]);
    expect(lanes.every((l) => l.conversations.length === 0)).toBe(true);
  });

  it("derives each conversation's rank exactly once, regardless of fleet size", () => {
    // Guards the perf contract: `rank` (a real status derivation) is cached, so the
    // O(n log n) sort can't re-derive a conversation on every comparison.
    const repos = [repo("a", 1), repo("b", 2)];
    const conversations = [
      conv("a1", "a", 10),
      conv("a2", "a", 20),
      conv("a3", "a", 30),
      conv("b1", "b", 40),
      conv("b2", "b", 50),
    ];
    const seen = new Map<string, number>();
    const rank = (c: Conversation) => {
      seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
      return 3;
    };

    orderLanes(repos, conversations, rank);

    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(seen.size).toBe(conversations.length);
  });
});

describe("rebuildLanes ↔ lanesToTokens round-trip", () => {
  it("reconstructs the exact lane structure from its order tokens", () => {
    const repos = [repo("a", 1), repo("b", 2)];
    const conversations = [conv("a1", "a", 100), conv("a2", "a", 50), conv("b1", "b", 10)];
    const lanes = orderLanes(repos, conversations, (c) => (c.id === "a2" ? 0 : 3));

    const rebuilt = rebuildLanes(lanesToTokens(lanes), repos, conversations);

    expect(rebuilt.map((l) => l.repo.id)).toEqual(lanes.map((l) => l.repo.id));
    expect(rebuilt.map((l) => l.conversations.map((c) => c.id))).toEqual(
      lanes.map((l) => l.conversations.map((c) => c.id)),
    );
  });

  it("skips tokens for repos/conversations no longer present (stale order list)", () => {
    const repos = [repo("a", 1)];
    const conversations = [conv("a1", "a", 100)];

    // Order list references a removed repo ("ghost"), a conv under it ("x"), and a
    // missing conv under a live repo ("missing") — all must be dropped cleanly.
    const rebuilt = rebuildLanes(
      ["r:ghost", "c:x", "r:a", "c:a1", "c:missing"],
      repos,
      conversations,
    );

    expect(rebuilt.map((l) => l.repo.id)).toEqual(["a"]);
    expect(rebuilt[0].conversations.map((c) => c.id)).toEqual(["a1"]);
  });
});
