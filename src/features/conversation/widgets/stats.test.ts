import { beforeEach, describe, expect, it } from "vitest";
import type { BackgroundTask, SessionStatePayload, SessionUsage } from "../../../ipc/client";
import {
  liveUsageSource,
  sameSessionUsage,
  useConversationStore,
} from "../../../store/conversationStore";
import {
  fmtCompactTokens,
  shortModel,
  statsMeta,
  statsMetaTip,
  statsView,
  UNKNOWN,
  workflowCalls,
  type StatsInput,
  type StatTile,
} from "./stats";

function usage(total: Partial<SessionUsage["total"]>, extra: Partial<SessionUsage> = {}): SessionUsage {
  return {
    total: { input: 0, cache_creation: 0, cache_read: 0, output: 0, ...total },
    cost_usd: null,
    per_model: [],
    ...extra,
  };
}

const T0: StatsInput["t"] = {
  turns: 0,
  timedTurns: 0,
  meanTurnMs: null,
  totalCalls: 0,
  subCalls: 0,
  replayedCalls: 0,
  filesTouched: 0,
};

function view(
  p: Omit<Partial<StatsInput>, "t"> & { t?: Partial<StatsInput["t"]> } = {},
): Record<string, StatTile> {
  const v = statsView({
    kind: "claude",
    usage: null,
    source: null,
    workflows: { calls: 0, running: 0 },
    backgroundRunning: false,
    ...p,
    t: { ...T0, ...(p.t ?? {}) },
  });
  return Object.fromEntries(v.tiles.map((tile) => [tile.key, tile]));
}

describe("fmtCompactTokens", () => {
  it("keeps three significant figures at most, like the tile has room for", () => {
    expect(fmtCompactTokens(812)).toBe("812");
    expect(fmtCompactTokens(5_069)).toBe("5.07k");
    expect(fmtCompactTokens(12_000)).toBe("12k");
    expect(fmtCompactTokens(512_400)).toBe("512k");
    expect(fmtCompactTokens(5_120_000)).toBe("5.12M");
    expect(fmtCompactTokens(592_114_302)).toBe("592M");
    expect(fmtCompactTokens(1_210_000_000)).toBe("1.21B");
  });

  it("carries a rounding into the next unit instead of reading « 1000k »", () => {
    expect(fmtCompactTokens(999_960)).toBe("1M");
    expect(fmtCompactTokens(999_960_000)).toBe("1B");
  });

  it("never prints a number for garbage", () => {
    expect(fmtCompactTokens(Number.NaN)).toBe(UNKNOWN);
    expect(fmtCompactTokens(-1)).toBe(UNKNOWN);
  });
});

describe("statsMeta (the folded header)", () => {
  it("reads the session total, or « — » — never a fake 0", () => {
    expect(statsMeta(null)).toBe(UNKNOWN);
    expect(statsMeta(usage({ cache_read: 557_154_864, cache_creation: 29_575_869, input: 9_342, output: 4_868_160 }))).toBe(
      "592M",
    );
  });
});

describe("statsMetaTip", () => {
  it("names the reach and the freshness of the header's figure", () => {
    expect(statsMetaTip("claude", null, null)).toContain("not known yet");
    expect(statsMetaTip("claude", usage({ output: 1 }), "live")).toContain("every agent");
    expect(statsMetaTip("claude", usage({ output: 1 }), "disk")).toContain("as of its last close");
    expect(statsMetaTip("claude", usage({ output: 1 }), "reopened")).toContain("since it was reopened");
    expect(statsMetaTip("codex", usage({ output: 1 }), "live")).toContain("this thread");
    // Disk was read and holds no record: said as such, not « not known yet ».
    expect(statsMetaTip("claude", null, "missing")).toContain("no spend on record");
  });
});

describe("the token tile", () => {
  it("is unknown without a total, saying why", () => {
    const fresh = view().tokens;
    expect(fresh.value).toBe(UNKNOWN);
    expect(fresh.known).toBe(false);
    expect(fresh.tip[0]).toBe("Not known yet");
    const missing = view({ source: "missing" }).tokens;
    expect(missing.value).toBe(UNKNOWN);
    expect(missing.tip[0]).toBe("No spend on record");
  });

  it("states the cached share under a live total, and its reach in the tooltip", () => {
    const tile = view({
      usage: usage(
        { cache_read: 94, input: 1, cache_creation: 3, output: 2 },
        { cost_usd: 12.345, per_model: [
          { model: "claude-opus-5[1m]", usage: { input: 1, cache_creation: 3, cache_read: 90, output: 2 }, cost_usd: 12 },
          { model: "claude-haiku-4-5-20251001", usage: { input: 0, cache_creation: 0, cache_read: 4, output: 0 }, cost_usd: 0.3 },
        ] },
      ),
      source: "live",
    }).tokens;
    expect(tile.value).toBe("100");
    expect(tile.hint).toBe("94% cached");
    expect(tile.caveat).toBe(false);
    expect(tile.tip.join("\n")).toContain("sub-agents, workflow agents");
    expect(tile.tip.join("\n")).toContain("Refreshed at each turn end.");
    expect(tile.tip.join("\n")).toContain("≈ $12.35 at API list prices");
    expect(tile.tip.join("\n")).toContain("By model: opus-5[1m] 96 · haiku-4-5 4");
  });

  it("says when background work is not in the total yet", () => {
    const tile = view({ usage: usage({ output: 5 }), source: "live", backgroundRunning: true }).tokens;
    expect(tile.tip.join("\n")).toContain("counted at the next one");
  });

  it("dates a disk seed, and flags a total that restarted on reopen", () => {
    expect(view({ usage: usage({ output: 5 }), source: "disk" }).tokens.tip.join("\n")).toContain(
      "As of the session's last close",
    );
    const reopened = view({ usage: usage({ output: 5, cache_read: 5 }), source: "reopened" }).tokens;
    expect(reopened.hint).toBe("since reopened");
    expect(reopened.caveat).toBe(true);
  });

  it("labels a Codex total as this thread only, with no cost", () => {
    const tile = view({ kind: "codex", usage: usage({ input: 10, cache_read: 90 }), source: "live" }).tokens;
    expect(tile.tip.join("\n")).toContain("This thread only");
    expect(tile.tip.join("\n")).not.toContain("API list prices");
  });

  it("never shows a fake 0% for a sliver of cache, nor a fake 100% for all but a sliver", () => {
    expect(view({ usage: usage({ input: 999, cache_read: 1 }), source: "live" }).tokens.hint).toBe("<1% cached");
    expect(view({ usage: usage({ input: 1, cache_read: 999 }), source: "live" }).tokens.hint).toBe(">99% cached");
    expect(view({ usage: usage({ cache_read: 50 }), source: "live" }).tokens.hint).toBe("100% cached");
  });

  it("never prints a fake $0.00 for a fraction of a cent", () => {
    const tip = (cost: number) =>
      view({ usage: usage({ output: 5 }, { cost_usd: cost }), source: "live" }).tokens.tip.join("\n");
    expect(tip(0.003)).toContain("≈ <$0.01 at API list prices");
    expect(tip(0.006)).toContain("≈ $0.01 at API list prices");
  });
});

describe("turns, files and calls", () => {
  it("reads the average turn only once one was measured live", () => {
    expect(view().turn.value).toBe(UNKNOWN);
    const t = view({ t: { turns: 3, timedTurns: 3, meanTurnMs: 72_000 } }).turn;
    expect(t.value).toBe("1m 12s");
    expect(t.hint).toBe("3 turns");
  });

  it("counts the turns the mean is over, not every turn that ended", () => {
    const t = view({ t: { turns: 4, timedTurns: 3, meanTurnMs: 10_000 } }).turn;
    expect(t.hint).toBe("3 turns");
    expect(t.tip.join("\n")).toContain("Over the 3 turns");
    // Turns ended but none reported a duration: unknown, and not « no turn has finished ».
    const none = view({ t: { turns: 2, timedTurns: 0, meanTurnMs: null } }).turn;
    expect(none.value).toBe(UNKNOWN);
    expect(none.tip.join("\n")).toContain("reported no duration");
  });

  it("never rounds a sub-second average down to a fake « 0s »", () => {
    expect(view({ t: { turns: 1, timedTurns: 1, meanTurnMs: 12 } }).turn.value).toBe("<1s");
    expect(view({ t: { turns: 1, timedTurns: 1, meanTurnMs: 800 } }).turn.value).toBe("1s");
  });

  it("gives Codex no « main thread » caveat — its rollout replays the whole thread", () => {
    const v = view({ kind: "codex", t: { totalCalls: 12, replayedCalls: 12, filesTouched: 2 } });
    expect(v.calls.hint).toBeNull();
    expect(v.files.hint).toBeNull();
    // …but says the count is this thread's: Codex sub-agents are threads of their own.
    expect(v.calls.tip.join("\n")).toContain("This thread only");
    expect(v.files.tip.join("\n")).toContain("This thread only");
    expect(v.calls.tip.join("\n")).not.toContain("Restored from the transcript");
  });

  it("does not claim sub-agents' calls are in a count restored from disk", () => {
    const tip = view({ t: { totalCalls: 40, replayedCalls: 40 } }).calls.tip.join("\n");
    expect(tip).toContain("Restored from the transcript");
    expect(tip).not.toContain("by the sub-agents it launched");
  });

  it("adds finished workflow runs' calls, and names the sub-agents' share", () => {
    const tile = view({ t: { totalCalls: 110, subCalls: 30 }, workflows: { calls: 8, running: 1 } }).calls;
    expect(tile.value).toBe("118");
    expect(tile.hint).toBe("38 by sub-agents");
    expect(tile.tip.join("\n")).toContain("80 on the main thread, 30 by sub-agents, 8 by workflow agents.");
    expect(tile.tip.join("\n")).toContain("1 workflow still running");
  });

  it("says the counts cover the main thread only once restored from disk", () => {
    const v = view({ t: { totalCalls: 40, replayedCalls: 40, filesTouched: 6 } });
    expect(v.calls.hint).toBe("main thread");
    expect(v.files.hint).toBe("main thread");
    expect(v.files.value).toBe("6");
    // Seen live: nothing to caveat.
    expect(view({ t: { totalCalls: 4, filesTouched: 1 } }).files.hint).toBeNull();
  });
});

describe("workflowCalls", () => {
  const task = (p: Partial<BackgroundTask>): BackgroundTask =>
    ({ task_id: Math.random().toString(), kind: "workflow", status: "completed", tool_uses: null, ...p }) as BackgroundTask;

  it("sums finished workflow runs only — never a sub-agent's roll-up (its calls stream)", () => {
    const tasks = Object.fromEntries(
      [
        task({ task_id: "w1", tool_uses: 12 }),
        task({ task_id: "w2", status: "running", tool_uses: 3 }),
        task({ task_id: "a1", kind: "agent", tool_uses: 40 }),
        task({ task_id: "w3", tool_uses: null }),
      ].map((x) => [x.task_id, x]),
    );
    expect(workflowCalls(tasks)).toEqual({ calls: 12, running: 1 });
    expect(workflowCalls(undefined)).toEqual({ calls: 0, running: 0 });
  });
});

describe("shortModel", () => {
  it("drops the vendor prefix and a snapshot date, keeps the window suffix", () => {
    expect(shortModel("claude-opus-5[1m]")).toBe("opus-5[1m]");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});

// ---- The store side: how the session total is carried and classified ----------------------

function statePush(u: SessionUsage | null): SessionStatePayload {
  return {
    busy: false,
    session_id: null,
    cwd: null,
    model: null,
    permission_mode: null,
    output_style: null,
    effort: null,
    ultracode: false,
    ultracode_available: null,
    activity: null,
    awaiting_permission: false,
    retry: null,
    link: null,
    ended: false,
    context_tokens: null,
    context_window: null,
    context_usage: null,
    rate_limit: null,
    session_usage: u,
  };
}

describe("session total in the conversation store", () => {
  const S = "stats-conv";
  const entry = () => useConversationStore.getState().sessions[S];
  beforeEach(() => useConversationStore.getState().dropSession(S));

  it("keeps the disk seed through state pushes that carry none", () => {
    const { applySessionUsageSeed, applyState } = useConversationStore.getState();
    const seed = usage({ cache_read: 1000, output: 10 });
    applySessionUsageSeed(S, seed);
    expect(entry().sessionUsageSource).toBe("disk");
    applyState(S, statePush(null)); // system/init of the resumed process: no usage yet
    expect(entry().state.session_usage).toBe(seed);
    expect(entry().sessionUsageSource).toBe("disk");
  });

  it("goes live when the resumed process carried the spend over, reopened when it restarted", () => {
    const { applySessionUsageSeed, applyState, resetSession } = useConversationStore.getState();
    applySessionUsageSeed(S, usage({ cache_read: 1000 }));
    applyState(S, statePush(usage({ cache_read: 1200 })));
    expect(entry().sessionUsageSource).toBe("live");

    resetSession(S);
    applySessionUsageSeed(S, usage({ cache_read: 1000 }));
    applyState(S, statePush(usage({ cache_read: 150 })));
    expect(entry().sessionUsageSource).toBe("reopened");
    // Sticky: later snapshots grow from the same restarted count.
    applyState(S, statePush(usage({ cache_read: 5000 })));
    expect(entry().sessionUsageSource).toBe("reopened");

    // No record on disk at all: the CLI had nothing to carry over either.
    resetSession(S);
    applySessionUsageSeed(S, null);
    expect(entry().sessionUsageSource).toBe("missing");
    expect(entry().state.session_usage ?? null).toBeNull();
    applyState(S, statePush(usage({ output: 3 })));
    expect(entry().sessionUsageSource).toBe("reopened");

    // Codex: a rollout without a token count is a thread that never spent anything — its first
    // live total covers the whole thread, no caveat.
    resetSession(S);
    applySessionUsageSeed(S, null, "codex");
    expect(entry().sessionUsageSource).toBeNull();
    applyState(S, statePush(usage({ output: 3 })));
    expect(entry().sessionUsageSource).toBe("live");
  });

  it("never lets a disk seed overwrite a live total", () => {
    const { applySessionUsageSeed, applyState } = useConversationStore.getState();
    const live = usage({ output: 42 });
    applyState(S, statePush(live));
    applySessionUsageSeed(S, usage({ output: 7 }));
    applySessionUsageSeed(S, null);
    expect(entry().state.session_usage?.total.output).toBe(42);
    expect(entry().sessionUsageSource).toBe("live");
  });

  it("keeps the SAME object while a push repeats the same value (no re-render per model call)", () => {
    const { applyState } = useConversationStore.getState();
    applyState(S, statePush(usage({ output: 42 }, { cost_usd: 1 })));
    const held = entry().state.session_usage;
    applyState(S, { ...statePush(usage({ output: 42 }, { cost_usd: 1 })), busy: true });
    expect(entry().state.session_usage).toBe(held);
    applyState(S, statePush(usage({ output: 43 }, { cost_usd: 1 })));
    expect(entry().state.session_usage).not.toBe(held);
  });

  it("survives the stream being turned off, dated from that close", () => {
    const { applyState, clearState } = useConversationStore.getState();
    applyState(S, statePush(usage({ output: 42 })));
    clearState(S);
    expect(entry().state.session_usage?.total.output).toBe(42);
    expect(entry().sessionUsageSource).toBe("disk");
    // The next process (respawned by a message — no reseed) carried it over: whole session.
    applyState(S, statePush(usage({ output: 50 })));
    expect(entry().sessionUsageSource).toBe("live");
  });

  it("flags a respawn after a crash whose count restarted from zero", () => {
    const { applyState } = useConversationStore.getState();
    applyState(S, statePush(usage({ output: 5000 })));
    // The process dies on its own (no cost-state written): every `ended` push dates the total.
    applyState(S, { ...statePush(usage({ output: 5000 })), ended: true });
    expect(entry().sessionUsageSource).toBe("disk");
    applyState(S, { ...statePush(null), ended: true });
    expect(entry().sessionUsageSource).toBe("disk");
    // A message respawns it WITHOUT a reseed; the CLI had nothing to restore → lower figure.
    applyState(S, statePush(usage({ output: 120 })));
    expect(entry().sessionUsageSource).toBe("reopened");
    expect(entry().state.session_usage?.total.output).toBe(120);
  });

  it("keeps « since reopened » through a close — the restarted count carries on", () => {
    const { applySessionUsageSeed, applyState, clearState } = useConversationStore.getState();
    applySessionUsageSeed(S, null);
    applyState(S, statePush(usage({ output: 3 })));
    clearState(S);
    expect(entry().sessionUsageSource).toBe("reopened");
  });

  it("compares totals by value, per model included", () => {
    const a = usage({ output: 1 }, { per_model: [{ model: "m", usage: { input: 0, cache_creation: 0, cache_read: 0, output: 1 }, cost_usd: null }] });
    expect(sameSessionUsage(a, structuredClone(a))).toBe(true);
    expect(sameSessionUsage(a, { ...a, per_model: [] })).toBe(false);
    expect(sameSessionUsage(a, null)).toBe(false);
    expect(liveUsageSource(null, null, a)).toBe("live");
  });
});
