import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GoalState } from "../ipc/client";

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const err = (reason: string) => ({ status: "error" as const, error: { kind: "io" as const, server: null, reason } });

vi.mock("../ipc/client", () => ({
  commands: {
    loadSessionGoal: vi.fn(),
  },
}));

import { commands } from "../ipc/client";
import {
  useGoalStore,
  refreshActiveGoal,
  scheduleGoalRefresh,
  seedActiveGoalOnce,
  beginGoalClearing,
  settleGoalClearing,
  endGoalClearing,
  markGoalSeen,
  hasSeenGoal,
  isGoalCommand,
} from "./goalStore";

const GOAL: GoalState = { condition: "all tests pass", reason: "2 failing" };

/** The IPC result shape of `load_session_goal`, for hand-resolved (deferred) mock reads. */
type GoalRead = Awaited<ReturnType<typeof commands.loadSessionGoal>>;

beforeEach(() => {
  // clearAll resets byConv AND the module-level goalSeen / clearing guards.
  useGoalStore.getState().clearAll();
  vi.mocked(commands.loadSessionGoal).mockReset();
});

describe("goalStore", () => {
  it("refreshActiveGoal loads the goal and marks the conversation goalSeen", async () => {
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(commands.loadSessionGoal).toHaveBeenCalledWith("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
    expect(hasSeenGoal("c1")).toBe(true); // now worth a per-turn refetch
  });

  it("a null read records the key and drops goalSeen (no more per-turn reads)", async () => {
    markGoalSeen("c1");
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(null));
    await refreshActiveGoal("c1", "sess-1");
    expect("c1" in useGoalStore.getState().byConv).toBe(true);
    expect(useGoalStore.getState().byConv.c1).toBeNull();
    expect(hasSeenGoal("c1")).toBe(false);
  });

  it("clears the goal (no IPC) when the conversation has no session id yet", async () => {
    useGoalStore.getState().set("c1", GOAL);
    markGoalSeen("c1");
    await refreshActiveGoal("c1", null);
    expect(commands.loadSessionGoal).not.toHaveBeenCalled();
    expect(useGoalStore.getState().byConv.c1).toBeNull();
    expect(hasSeenGoal("c1")).toBe(false);
  });

  it("leaves the last known goal untouched on an IPC error", async () => {
    useGoalStore.getState().set("c1", GOAL);
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(err("boom"));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
  });

  it("set short-circuits an equal update (same object reference kept)", () => {
    useGoalStore.getState().set("c1", { condition: "x", reason: null });
    const before = useGoalStore.getState().byConv;
    useGoalStore.getState().set("c1", { condition: "x", reason: null });
    expect(useGoalStore.getState().byConv).toBe(before);
  });

  it("clear guard: while the clear send is IN FLIGHT, a stale still-active read is frozen out", async () => {
    useGoalStore.getState().set("c1", GOAL);
    beginGoalClearing("c1"); // arm at click
    useGoalStore.getState().set("c1", null); // optimistic hide
    // A busy edge fires during the (possibly cold-spawn) send: the transcript still reads active.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toBeNull(); // NOT flipped back on
  });

  it("clear guard: after settle (send accepted), a confirmed null read settles it; a new goal then shows", async () => {
    useGoalStore.getState().set("c1", GOAL);
    beginGoalClearing("c1");
    useGoalStore.getState().set("c1", null);
    settleGoalClearing("c1"); // send accepted → grace window
    // The clear landed: a null read releases the guard.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(null));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toBeNull();
    // A genuinely new goal set afterwards is shown normally.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
  });

  it("clear ROLLBACK: on send failure, endGoalClearing releases so the still-active goal is restored", async () => {
    useGoalStore.getState().set("c1", GOAL);
    beginGoalClearing("c1");
    useGoalStore.getState().set("c1", null); // optimistic hide
    endGoalClearing("c1"); // send failed → release the guard
    // The rollback refetch reads the still-active goal and restores the chip.
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    await refreshActiveGoal("c1", "sess-1");
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
  });

  it("seedActiveGoalOnce reads the transcript once, then skips (survives relaunch, no re-reads)", async () => {
    vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
    seedActiveGoalOnce("c1", "sess-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
    expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
    seedActiveGoalOnce("c1", "sess-1");
    expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
  });

  it("isGoalCommand matches /goal invocations, not prose mentions", () => {
    expect(isGoalCommand("/goal all tests pass")).toBe(true);
    expect(isGoalCommand("/goal clear")).toBe(true);
    expect(isGoalCommand("/goal")).toBe(true);
    expect(isGoalCommand("  /goal x")).toBe(true); // leading whitespace ok
    expect(isGoalCommand("/goalie save")).toBe(false); // word-bounded
    expect(isGoalCommand("please run /goal")).toBe(false); // not at the start
    expect(isGoalCommand("set a goal")).toBe(false);
  });

  it("a stale slow read never clobbers a newer one (per-conversation sequence)", async () => {
    // Two callers race (e.g. a Flight Deck card seed and the turn edge). The OLDER read is slow
    // and answers with a goal that has since been cleared; it must be dropped, not written.
    let landSlow!: (v: GoalRead) => void;
    const slow = new Promise<GoalRead>((resolve) => {
      landSlow = resolve;
    });
    vi.mocked(commands.loadSessionGoal)
      .mockImplementationOnce(() => slow)
      .mockImplementationOnce(() => Promise.resolve(ok(null)));

    const older = refreshActiveGoal("c1", "sess-1"); // in flight
    const newer = refreshActiveGoal("c1", "sess-1"); // started after → wins
    await newer;
    expect(useGoalStore.getState().byConv.c1).toBeNull();

    landSlow(ok(GOAL)); // the stale answer finally arrives
    await older;
    expect(useGoalStore.getState().byConv.c1).toBeNull(); // dropped: no resurrected goal
    expect(hasSeenGoal("c1")).toBe(false); // and its bookkeeping was dropped too
  });

  it("scheduleGoalRefresh stops as soon as the value changes (no polling)", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
      scheduleGoalRefresh("c1", () => "sess-1");
      expect(commands.loadSessionGoal).not.toHaveBeenCalled(); // first rung is delayed
      await vi.advanceTimersByTimeAsync(300);
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
      expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1); // value moved → ladder stopped
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduleGoalRefresh skips a rung with no session id yet (fresh conversation), keeping goalSeen", async () => {
    vi.useFakeTimers();
    try {
      useGoalStore.getState().set("c1", null); // already read: no goal at send time
      markGoalSeen("c1"); // the composer armed the gate on the `/goal` send
      vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
      let sessionId: string | null = null; // system/init hasn't landed yet
      scheduleGoalRefresh("c1", () => sessionId);

      await vi.advanceTimersByTimeAsync(300); // rung 1: no session id → no read AT ALL
      expect(commands.loadSessionGoal).not.toHaveBeenCalled();
      expect(hasSeenGoal("c1")).toBe(true); // not disarmed by a bogus "no session ⇒ no goal"
      expect(useGoalStore.getState().byConv.c1).toBeNull();

      sessionId = "sess-1"; // the spawn reports its session id
      await vi.advanceTimersByTimeAsync(1000); // rung 2 fires the real read
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
      expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduleGoalRefresh keeps climbing on an UNSEEDED conversation whose first read is empty", async () => {
    vi.useFakeTimers();
    try {
      // ⌘N then `/goal <condition>` as the very FIRST message: nothing ever read this conversation,
      // so its slot is absent — not `null`. Treating that `undefined → null` move as "the value
      // changed" used to settle the ladder on rung 1, on the exact case it exists for.
      expect("c1" in useGoalStore.getState().byConv).toBe(false);
      markGoalSeen("c1"); // the composer armed the gate on the `/goal` send
      vi.mocked(commands.loadSessionGoal)
        .mockResolvedValueOnce(ok(null)) // the goal_status write hasn't landed yet
        .mockResolvedValue(ok(GOAL)); // …and then it does
      scheduleGoalRefresh("c1", () => "sess-1");

      await vi.advanceTimersByTimeAsync(300); // rung 1: empty
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
      expect(hasSeenGoal("c1")).toBe(true); // an empty read mid-ladder must not disarm the fallback
      await vi.advanceTimersByTimeAsync(1000); // rung 2 finds the goal
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(2);
      expect(useGoalStore.getState().byConv.c1).toEqual(GOAL);
      expect(hasSeenGoal("c1")).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(2); // value moved → ladder stopped
    } finally {
      vi.useRealTimers();
    }
  });

  it("a /goal queued mid-turn outlives the ladder: the turn-edge gate stays armed", async () => {
    vi.useFakeTimers();
    try {
      // The CLI QUEUES a local command until the running turn yields, so every rung can honestly
      // read "no goal". The ladder must hand over to the turn edge with the gate still armed —
      // otherwise the goal is live on disk and invisible on both surfaces for the rest of the run.
      useGoalStore.getState().set("c1", null);
      markGoalSeen("c1");
      vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(null));
      scheduleGoalRefresh("c1", () => "sess-1");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(4); // the whole ladder, all empty
      expect(hasSeenGoal("c1")).toBe(true);

      // …and with no ladder left pending, a genuinely empty read disarms again: the "goalless
      // conversations read nothing per turn" perf gate self-heals within one turn.
      await refreshActiveGoal("c1", "sess-1");
      expect(hasSeenGoal("c1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduleGoalRefresh gives up after its last rung (bounded, never a poll loop)", async () => {
    vi.useFakeTimers();
    try {
      useGoalStore.getState().set("c1", null);
      vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(null)); // value never moves
      scheduleGoalRefresh("c1", () => "sess-1");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(4); // the whole ladder, then stop
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear / clearAll cancel a pending refresh ladder (no leaked timers)", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(GOAL));
      scheduleGoalRefresh("c1", () => "sess-1");
      useGoalStore.getState().clear("c1"); // conversation removed before the first rung
      await vi.advanceTimersByTimeAsync(60_000);
      expect(commands.loadSessionGoal).not.toHaveBeenCalled();
      expect("c1" in useGoalStore.getState().byConv).toBe(false); // nothing resurrected the key

      scheduleGoalRefresh("c2", () => "sess-2");
      useGoalStore.getState().clearAll(); // wipe-all
      await vi.advanceTimersByTimeAsync(60_000);
      expect(commands.loadSessionGoal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second scheduleGoalRefresh supersedes the first (one ladder per conversation)", async () => {
    vi.useFakeTimers();
    try {
      useGoalStore.getState().set("c1", null);
      vi.mocked(commands.loadSessionGoal).mockResolvedValue(ok(null));
      const stale = vi.fn((): string | null => "sess-stale");
      const fresh = vi.fn((): string | null => "sess-fresh");
      scheduleGoalRefresh("c1", stale);
      scheduleGoalRefresh("c1", fresh); // supersedes: the first ladder is cancelled
      await vi.advanceTimersByTimeAsync(300);
      expect(stale).not.toHaveBeenCalled();
      expect(commands.loadSessionGoal).toHaveBeenCalledTimes(1);
      expect(commands.loadSessionGoal).toHaveBeenCalledWith("c1", "sess-fresh");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear prunes byConv + goalSeen; clearAll wipes everything", () => {
    useGoalStore.getState().set("c1", GOAL);
    markGoalSeen("c1");
    useGoalStore.getState().set("c2", { condition: "y", reason: null });
    useGoalStore.getState().clear("c1");
    expect("c1" in useGoalStore.getState().byConv).toBe(false);
    expect(hasSeenGoal("c1")).toBe(false); // module-level slice pruned too
    expect(useGoalStore.getState().byConv.c2).toBeTruthy();
    markGoalSeen("c2");
    useGoalStore.getState().clearAll();
    expect(useGoalStore.getState().byConv).toEqual({});
    expect(hasSeenGoal("c2")).toBe(false);
  });
});
