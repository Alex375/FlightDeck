import { describe, expect, it } from "vitest";
import type { ConversationItem, WorkflowJournalAgent } from "../../ipc/client";
import type { OrderedLabel } from "../../store/workflowLive";
import {
  agentsByPhaseKey,
  bucketOf,
  currentStepLabel,
  deriveActivity,
  exactPhaseRows,
  journalCurrentPhaseKey,
  journalNamesAgents,
  latestLabelIn,
  legacyPhaseRows,
  liveAgents,
  liveTree,
  matchQuality,
  NOSTART_KEY,
  NOSTART_TITLE,
  phaseRowView,
  toolActivityLabel,
  UNKNOWN_KEY,
  UNKNOWN_TITLE,
  UNPHASED_KEY,
  UNPHASED_TITLE,
  withOrphanRows,
  zipAgentsToLabels,
  type LiveAgent,
  type LivePhaseRow,
} from "./workflowTree";

/** An older journal's agent: id only. */
const ag = (agentId: string, done = false): WorkflowJournalAgent => ({
  key: `v2:${agentId}`,
  agentId,
  label: null,
  phase: null,
  done,
  failed: false,
  lastStarted: null,
});
/** Spawn sequence for `named` — each new agent starts after the previous one. */
let seq = 0;
/** A recent claude's journal agent: it carries its own label + phase. */
const named = (
  agentId: string | null,
  label: string | null,
  phase: string | null,
  done = false,
  failed = false,
  key = `v2:${agentId ?? label}`,
  lastStarted: number | null = agentId == null ? null : seq++,
): WorkflowJournalAgent => ({ key, agentId, label, phase, done, failed, lastStarted });
const lbl = (label: string, phase: string): OrderedLabel => ({ label, phase });
/** A live agent, for the bucketing/row helpers. */
const la = (
  key: string,
  phase: string | null,
  done = false,
  failed = false,
  lastStarted: number | null = null,
): LiveAgent => ({ key, agentId: key, label: key, phase, done, failed, lastStarted });
const ghostOf = (key: string): LiveAgent => ({
  key,
  agentId: null,
  label: null,
  phase: null,
  done: true,
  failed: true,
  lastStarted: null,
});
/** The exact path's live list (the journal names its agents). */
const exactList = (agents: WorkflowJournalAgent[]) => liveAgents(agents, [], true);

describe("journalNamesAgents", () => {
  it("trusts the journal's own flag from the first line, else any label or phase", () => {
    // A journal whose only entry so far is a call that failed before spawning has no label —
    // its `launched` header still says it names its agents.
    expect(journalNamesAgents({ agents: [], namesAgents: true })).toBe(true);
    expect(journalNamesAgents({ agents: [named("a", "x", null)] })).toBe(true);
    // Phase without label (a call with no label) still proves it.
    expect(journalNamesAgents({ agents: [named("a", null, "Review")] })).toBe(true);
    expect(journalNamesAgents({ agents: [ag("a")], namesAgents: false })).toBe(false);
  });
});

describe("zipAgentsToLabels", () => {
  it("pairs agents to labels by spawn index, keeping each agent's call key", () => {
    const rows = zipAgentsToLabels(
      [ag("a1"), ag("a2", true)],
      [lbl("review:bugs", "Review"), lbl("review:perf", "Review")],
    );
    expect(rows.map((r) => [r.key, r.agentId, r.label, r.phase, r.done])).toEqual([
      ["v2:a1", "a1", "review:bugs", "Review", false],
      ["v2:a2", "a2", "review:perf", "Review", true],
    ]);
  });

  it("keeps a null label when there are more agents than labels", () => {
    const rows = zipAgentsToLabels([ag("a1"), ag("a2")], [lbl("only", "P")]);
    expect(rows[1]).toMatchObject({ agentId: "a2", label: null, phase: null, done: false });
  });

  it("keeps a null agentId for a label whose agent hasn't registered yet (queued)", () => {
    const rows = zipAgentsToLabels([ag("a1")], [lbl("l1", "P"), lbl("l2", "P")]);
    expect(rows[1]).toMatchObject({ key: "queued:1", agentId: null, label: "l2", phase: "P" });
  });

  it("keeps a re-run call that lost its id in the pairing — it did emit a label", () => {
    // Re-executed after a resume, it died before spawning this time (no current id), but its
    // first execution started (lastStarted) and emitted the label.
    const rerun: WorkflowJournalAgent = { ...ag("a2", true), agentId: null, failed: true, lastStarted: 1 };
    const rows = zipAgentsToLabels([ag("a1"), rerun, ag("b1")], [lbl("x", "A"), lbl("y", "A"), lbl("z", "B")]);
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ["v2:a1", "x"],
      ["v2:a2", "y"],
      ["v2:b1", "z"],
    ]);
  });

  it("pairs only the spawned agents with the wire labels, so a ghost never shifts them", () => {
    const ghost: WorkflowJournalAgent = { ...ag("z", true), key: "v2:z", agentId: null, failed: true };
    const rows = zipAgentsToLabels([ghost, ag("a1"), ag("a2")], [lbl("l1", "P"), lbl("l2", "P")]);
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ["v2:a1", "l1"],
      ["v2:a2", "l2"],
      ["v2:z", null],
    ]);
  });

  it("is empty when both are empty", () => {
    expect(zipAgentsToLabels([], [])).toEqual([]);
  });
});

describe("liveAgents", () => {
  it("uses each agent's OWN label and phase on the exact path — shared labels included", () => {
    // Real 2.1.286 shape: two agents of one phase share a label. Zipped against the wire's
    // (deduped) labels, the second came out unnamed and uncounted; named, both are kept.
    const agents = [
      named("a1", "review:tests", "Review", true),
      named("a2", "verify:tests:assembler.rs", "Verify"),
      named("a3", "verify:tests:assembler.rs", "Verify", true, true),
    ];
    // Wire labels are ignored on this path, even when they disagree.
    const rows = liveAgents(agents, [lbl("something-else", "Elsewhere")], true);
    expect(rows.map((r) => [r.key, r.agentId, r.label, r.phase, r.done, r.failed])).toEqual([
      ["v2:a1", "a1", "review:tests", "Review", true, false],
      ["v2:a2", "a2", "verify:tests:assembler.rs", "Verify", false, false],
      ["v2:a3", "a3", "verify:tests:assembler.rs", "Verify", true, true],
    ]);
    expect(rows[2].lastStarted).toBe(agents[2].lastStarted);
  });

  it("carries a call that failed before spawning with NO agent id — never a made-up one", () => {
    const rows = exactList([named("a1", "x", "P"), named(null, null, null, true, true, "v2:z")]);
    expect(rows[1]).toMatchObject({ key: "v2:z", agentId: null, label: null, phase: null, failed: true });
  });

  it("falls back to the by-index zip for an older journal (ids only)", () => {
    const agents = [ag("a1"), ag("a2")];
    expect(liveAgents(agents, [lbl("l1", "P")], false)).toEqual(zipAgentsToLabels(agents, [lbl("l1", "P")]));
  });
});

describe("bucketOf / agentsByPhaseKey", () => {
  it("buckets by phase key, named phase-less agents under the fallback key", () => {
    const by = agentsByPhaseKey([la("a1", "Review"), la("a2", null), la("a3", " review ")], UNPHASED_KEY);
    expect([...by.keys()]).toEqual(["review", UNPHASED_KEY]);
    expect(by.get("review")?.map((a) => a.key)).toEqual(["a1", "a3"]);
    expect(by.get(UNPHASED_KEY)?.map((a) => a.key)).toEqual(["a2"]);
  });

  it("routes an unlabelled agent to the given phase on the by-index path", () => {
    const unnamed: LiveAgent = { ...la("a1", null), label: null };
    expect(agentsByPhaseKey([unnamed], "verify").get("verify")?.map((a) => a.key)).toEqual(["a1"]);
  });

  it("never claims 'no phase' for an agent whose phase is UNKNOWN", () => {
    // A call that failed before spawning: the CLI records no phase for it.
    const ghost = ghostOf("v2:z");
    expect(bucketOf(ghost)).toBe(NOSTART_KEY);
    expect(agentsByPhaseKey([ghost], "verify").get(NOSTART_KEY)).toEqual([ghost]);
    // A re-executed call that died before spawning keeps the phase its earlier execution had.
    expect(bucketOf({ ...ghost, phase: "Verify" })).toBe("verify");
    // A spawned agent with neither label nor phase: without a label we can't tell "no phase"
    // from "unknown" — unknown it is (on the by-index path too, once there is no wire phase).
    const unnamed: LiveAgent = { ...la("u", null), label: null };
    expect(bucketOf(unnamed)).toBe(UNKNOWN_KEY);
    expect(bucketOf(unnamed, UNKNOWN_KEY)).toBe(UNKNOWN_KEY);
  });
});

describe("journalCurrentPhaseKey / latestLabelIn", () => {
  it("is the phase of the most recently STARTED agent, only while the run lives", () => {
    const agents = [la("a", "Review", false, false, 0), la("b", "Verify", false, false, 1), la("c", null, false, false, 2)];
    expect(journalCurrentPhaseKey(agents, true)).toBe("verify");
    expect(journalCurrentPhaseKey(agents, false)).toBeNull();
    // Only agents outside any phase so far: no phase is current.
    expect(journalCurrentPhaseKey([la("a", null, false, false, 0)], true)).toBeNull();
  });

  it("follows recency, not list order: a resumed run re-running an earlier phase is THERE", () => {
    // Scout's call keeps its first-seen slot, but it was re-started after Verify's agents.
    const agents = [la("s", "Scout", false, false, 9), la("v", "Verify", true, false, 3)];
    expect(journalCurrentPhaseKey(agents, true)).toBe("scout");
    expect(latestLabelIn(agents, "scout")).toBe("s");
  });
});

describe("currentStepLabel", () => {
  const journal = (agents: WorkflowJournalAgent[], error: string | null = null) => ({
    agents,
    namesAgents: true,
    error,
  });

  it("names the journal's phase when it names its agents — never a phase-less agent's bare label", () => {
    expect(currentStepLabel(journal([named("a", "review:tests", null)]), "review:tests", true)).toBeNull();
    expect(currentStepLabel(journal([named("a", "x", "Verify")]), "Verify: x", true)).toBe("Verify");
  });

  it("falls back to the wire's word for an older journal, or one that can't be read", () => {
    expect(currentStepLabel({ agents: [ag("a")], namesAgents: false, error: null }, "Map: m", true)).toBe("Map");
    expect(currentStepLabel(journal([named("a", "x", "Review")], "boom"), "Verify: y", true)).toBe("Verify");
  });

  it("says nothing once the run is over", () => {
    expect(currentStepLabel(journal([named("a", "x", "Verify")]), "Verify: x", false)).toBeNull();
  });
});

describe("exactPhaseRows", () => {
  const phases = [{ title: "Review" }, { title: "Verify", detail: "confirm" }, { title: "Report" }];
  const rows = (agents: WorkflowJournalAgent[], running = true) => exactPhaseRows(phases, exactList(agents), running);

  it("counts every named agent in its own phase — shared labels included", () => {
    // The reported bug: Verify fanned out to 4 agents, 2 of them sharing a label. Every one of
    // them is listed AND counted.
    const out = rows([
      named("r1", "review:tests", "Review", true),
      named("r2", "review:perf", "Review", true),
      named("v1", "verify:tests:assembler.rs", "Verify", true),
      named("v2", "verify:tests:assembler.rs", "Verify"),
      named("v3", "verify:perf:a.ts", "Verify", true, true),
      named("v4", "verify:perf:b.ts", "Verify"),
    ]);
    expect(out.map((r) => [r.key, r.started, r.done, r.failed, r.state])).toEqual([
      ["review", 2, 2, 0, "done"],
      ["verify", 4, 2, 1, "cur"],
      ["report", 0, 0, 0, "todo"],
    ]);
    expect(out[1].detail).toBe("confirm");
    expect(out.every((r) => !r.synthetic)).toBe(true);
  });

  it("keeps two overlapping phases both current while each has agents in flight", () => {
    // Pipelines start verifying before the review fan-out has drained.
    const out = rows([named("r1", "r", "Review"), named("v1", "v", "Verify")]);
    expect(out.map((r) => r.state)).toEqual(["cur", "cur", "todo"]);
  });

  it("holds the current phase open while the run lives, even when its agents have all settled", () => {
    // More agents may still be spawned there — "done" would flash prematurely. Once the run is
    // over nothing can, so it settles.
    expect(rows([named("r1", "r", "Review", true)])[0].state).toBe("cur");
    expect(rows([named("r1", "r", "Review", true)], false)[0].state).toBe("done");
  });

  it("marks an empty declared phase before the last one reached as passed — live or over", () => {
    // Review was skipped (conditional script); the run went on to Verify.
    const agents = [named("v1", "v", "Verify", true)];
    for (const running of [true, false]) {
      expect(rows(agents, running).map((r) => [r.title, r.state])).toEqual([
        ["Review", "done"],
        ["Verify", running ? "cur" : "done"],
        ["Report", "todo"],
      ]);
    }
  });

  it("does not mark declared phases passed because an UNDECLARED phase is current", () => {
    // An agent with an explicit phase not in meta.phases is appended last — it says nothing
    // about which declared phases are behind the run.
    const out = rows([named("r1", "r", "Review", true), named("f1", "f", "Fix")]);
    expect(out.map((r) => [r.title, r.state])).toEqual([
      ["Review", "done"],
      ["Verify", "todo"],
      ["Report", "todo"],
      ["Fix", "cur"],
    ]);
  });

  it("surfaces undeclared and synthetic buckets after the declared phases, first-seen order", () => {
    const out = rows([
      named("n1", "n", null),
      named("x1", "x", "Extra"),
      named("v1", "v", "Verify"),
      named(null, null, null, true, true, "v2:ghost"),
    ]);
    expect(out.map((r) => [r.title, r.started, r.state, r.synthetic])).toEqual([
      ["Review", 0, "done", false],
      ["Verify", 1, "cur", false],
      ["Report", 0, "todo", false],
      [UNPHASED_TITLE, 1, "cur", true],
      ["Extra", 1, "cur", false],
      [NOSTART_TITLE, 1, "done", true],
    ]);
    expect(out[3].key).toBe(UNPHASED_KEY);
    expect(out[5].key).toBe(NOSTART_KEY);
  });

  it("takes nothing from the wire: an agent spawned outside any phase makes no phantom phase", () => {
    // The wire's progress for such an agent is its bare label ("setup", "review:tests") — read
    // as a phase, it used to add a fake current row and mark every declared phase done. The
    // journal knows it belongs to no phase, so only the phase-less bucket moves.
    const out = rows([named("s1", "setup", null), named("s2", "review:tests", null)]);
    expect(out.map((r) => [r.title, r.started, r.state])).toEqual([
      ["Review", 0, "todo"],
      ["Verify", 0, "todo"],
      ["Report", 0, "todo"],
      [UNPHASED_TITLE, 2, "cur"],
    ]);
  });

  it("follows a resumed run back to the earlier phase it re-runs", () => {
    // Scout's call (first slot) is re-started AFTER Verify's agent: Scout is current, not Verify.
    const out = rows([named("s1", "s", "Scout", false, false, "v2:s", 9), named("v1", "v", "Verify", true, false, "v2:v", 3)]);
    expect(out.find((r) => r.key === "verify")?.state).toBe("done");
  });

  it("keeps our buckets apart from a script phase of the same name", () => {
    // Keys keep counts apart; `synthetic` lets the UI render ours differently.
    const out = exactPhaseRows(
      [{ title: UNPHASED_TITLE }, { title: "Agents" }],
      exactList([named("p1", "p", UNPHASED_TITLE, true), named("n1", "n", null, true)]),
      false,
    );
    expect(out.map((r) => [r.title, r.started, r.synthetic])).toEqual([
      [UNPHASED_TITLE, 1, false],
      ["Agents", 0, false],
      [UNPHASED_TITLE, 1, true],
    ]);
    expect(new Set(out.map((r) => r.key)).size).toBe(3);
  });

  it("counts a homonym phase once, on its first slot, under its own key", () => {
    const out = exactPhaseRows(
      [{ title: "Review" }, { title: "Review" }],
      exactList([named("a", "a", "Review"), named("b", "b", "review")]),
      true,
    );
    expect(out.map((r) => r.started)).toEqual([2, 0]);
    expect(out[0].key).toBe("review");
    expect(out[1].key).not.toBe("review");
  });
});

describe("withOrphanRows", () => {
  const row = (key: string, title: string): LivePhaseRow => ({
    key,
    title,
    synthetic: false,
    detail: null,
    started: 0,
    done: 0,
    failed: 0,
    state: "todo",
  });

  it("appends a row for every agent bucket no row covers, so no agent is listed nowhere", () => {
    const unnamed: LiveAgent = { ...la("u", null), label: null };
    const by = agentsByPhaseKey(
      [la("a", "Review"), la("b", "Ghost", true, true), la("c", null), ghostOf("v2:z"), unnamed],
      UNPHASED_KEY,
    );
    const out = withOrphanRows([row("review", "Review")], by);
    expect(out.map((r) => [r.key, r.title, r.started, r.done, r.failed, r.state, r.synthetic])).toEqual([
      ["review", "Review", 0, 0, 0, "todo", false],
      ["ghost", "Ghost", 1, 1, 1, "done", false],
      [UNPHASED_KEY, UNPHASED_TITLE, 1, 0, 0, "cur", true],
      [NOSTART_KEY, NOSTART_TITLE, 1, 1, 1, "done", true],
      [UNKNOWN_KEY, UNKNOWN_TITLE, 1, 0, 0, "cur", true],
    ]);
  });

  it("returns the same rows when every bucket is covered", () => {
    const rows = [row("review", "Review")];
    expect(withOrphanRows(rows, agentsByPhaseKey([la("a", "Review")], UNPHASED_KEY))).toBe(rows);
  });
});

describe("phaseRowView", () => {
  const r = (started: number, done: number, failed: number, state: "done" | "cur" | "todo") => ({
    started,
    done,
    failed,
    state,
  });

  it("shows delivered/started and names the failures", () => {
    expect(phaseRowView(r(5, 3, 1, "cur"))).toEqual({ count: "2/5 · 1 failed", tone: "cur" });
    expect(phaseRowView(r(2, 2, 0, "done"))).toEqual({ count: "2/2", tone: "done" });
    expect(phaseRowView(r(0, 0, 0, "todo"))).toEqual({ count: "upcoming", tone: "todo" });
    expect(phaseRowView(r(0, 0, 0, "todo"), "—").count).toBe("—");
  });

  it("never shows a settled phase that lost agents as a green success", () => {
    // All failed: was "2/2" with a green dot.
    expect(phaseRowView(r(2, 2, 2, "done"))).toEqual({ count: "0/2 · 2 failed", tone: "err" });
    // Still in progress: the failure is in the count, the phase keeps its "current" look…
    expect(phaseRowView(r(3, 2, 1, "cur")).tone).toBe("cur");
    // …but once the RUN is over nothing is in progress: an aborted phase left "current" (its
    // other agents never closed) reads as the error it is, and names the one with no result.
    expect(phaseRowView(r(3, 2, 1, "cur"), "upcoming", true)).toEqual({
      count: "1/3 · 1 failed · 1 no result",
      tone: "err",
    });
  });

  it("drops the in-progress look of a settled run's incomplete phase, and names what never closed", () => {
    expect(phaseRowView(r(3, 1, 0, "cur"), "upcoming", true)).toEqual({ count: "1/3 · 2 no result", tone: "todo" });
  });

  it("words a phase nothing ran in as neutral once passed or once the run is over", () => {
    expect(phaseRowView(r(0, 0, 0, "done"))).toEqual({ count: "—", tone: "todo" });
    // A finished run has nothing "upcoming".
    expect(phaseRowView(r(0, 0, 0, "todo"), "upcoming", true)).toEqual({ count: "—", tone: "todo" });
  });
});

describe("legacyPhaseRows (older journal, by-index)", () => {
  const live = (phases: [string, string[]][]) => ({
    phases: phases.map(([title, labels]) => ({ title, labels })),
    startedAt: null,
  });
  const ids = (agents: LiveAgent[]) => agentsByPhaseKey(agents, UNKNOWN_KEY);
  const at = (key: string, phase: string, done = false, failed = false) => la(key, phase, done, failed);

  it("never passes a failure off as an earlier phase's delivery", () => {
    // Run over (no current phase): A has a1 delivered + a2 never closed; B has b1 failed + b2
    // never closed. Only ONE delivery exists — A can't read "2/2" (it used to, green).
    const by = ids([at("a1", "A", true), at("a2", "A"), at("b1", "B", true, true), at("b2", "B")]);
    const rows = legacyPhaseRows([{ title: "A" }, { title: "B" }], live([["A", ["a1", "a2"]], ["B", ["b1", "b2"]]]), 1, null, by);
    expect(rows.map((r) => [r.title, r.started, r.done, r.failed, r.state])).toEqual([
      ["A", 2, 1, 0, "cur"],
      ["B", 2, 1, 1, "cur"],
    ]);
  });

  it("counts a phase's agents even when the wire deduped their shared label", () => {
    // 5 agents labelled "review" in B, 3 failed: the wire knows ONE label for B.
    const agents = [0, 1, 2, 3, 4].map((i) => at(`b${i}`, "B", i < 3, i < 3));
    const rows = legacyPhaseRows([{ title: "B" }], live([["B", ["review"]]]), 0, "B", ids(agents));
    expect(rows[0]).toMatchObject({ started: 5, done: 3, failed: 3, state: "cur" });
  });

  it("does not mark declared phases passed because the wire's current phase is undeclared", () => {
    // An agent outside any phase shows on the wire as its bare label ("setup") — appended after
    // the declared phases, it must not make them read as passed.
    const rows = legacyPhaseRows(
      [{ title: "Review" }, { title: "Verify" }],
      live([["setup", ["setup"]]]),
      0,
      "setup",
      ids([at("s1", "setup")]),
    );
    expect(rows.map((r) => [r.title, r.state])).toEqual([
      ["Review", "todo"],
      ["Verify", "todo"],
      ["setup", "cur"],
    ]);
  });

  it("shares deliveries out sequentially up to the wire's current phase", () => {
    const by = ids([at("a1", "A", true), at("a2", "A", true), at("b1", "B", true), at("b2", "B")]);
    const rows = legacyPhaseRows([{ title: "A" }, { title: "B" }, { title: "C" }], live([["A", ["x", "y"]], ["B", ["z", "w"]]]), 3, "B", by);
    expect(rows.map((r) => [r.title, r.done, r.state])).toEqual([
      ["A", 2, "done"],
      ["B", 1, "cur"],
      ["C", 0, "todo"],
    ]);
  });
});

describe("liveTree", () => {
  const view = (agents: WorkflowJournalAgent[], error: string | null = null) => ({
    agents,
    namesAgents: true,
    delivered: agents.filter((a) => a.done && !a.failed).length,
    error,
  });
  const noLive = { phases: [], startedAt: null };

  it("names the current phase and what it is doing from the journal", () => {
    const t = liveTree(
      [{ title: "Scout" }, { title: "Verify" }],
      view([named("s1", "scout:a", "Scout", true), named("v1", "verify:b", "Verify")]),
      noLive,
      { phase: "review:tests", label: null },
      true,
    );
    expect([t.exact, t.curKey, t.curLabel]).toEqual([true, "verify", "verify:b"]);
  });

  it("never trusts an unreadable journal's last snapshot for the current phase", () => {
    // Its last state would freeze the current step; the wire's word is used instead.
    const t = liveTree(
      [{ title: "Scout" }, { title: "Verify" }, { title: "Report" }],
      view([named("s1", "s", "Scout", true), named("v1", "v", "Verify")], "io error"),
      noLive,
      { phase: "Report", label: "r:1" },
      true,
    );
    expect([t.curKey, t.curLabel]).toEqual(["report", "r:1"]);
    expect(t.rows.find((r) => r.key === "verify")?.state).toBe("cur"); // its agent is still open
  });
});

describe("matchQuality", () => {
  it("is aligned when counts match and are non-empty", () => {
    expect(matchQuality([ag("a")], [lbl("l", "P")])).toBe("aligned");
  });
  it("is partial when counts differ", () => {
    expect(matchQuality([ag("a"), ag("b")], [lbl("l", "P")])).toBe("partial");
    expect(matchQuality([], [lbl("l", "P")])).toBe("partial");
  });
  it("is none when both empty", () => {
    expect(matchQuality([], [])).toBe("none");
  });
});

describe("toolActivityLabel", () => {
  it("appends the most meaningful target field", () => {
    expect(toolActivityLabel("Read", { file_path: "src/foo.rs" })).toBe("Read src/foo.rs");
    expect(toolActivityLabel("Bash", { command: "npm test" })).toBe("Bash npm test");
    expect(toolActivityLabel("Grep", { pattern: "TODO", path: "src" })).toBe("Grep TODO");
  });
  it("falls back to the bare tool name with no known target", () => {
    expect(toolActivityLabel("Think", { thoughts: 3 })).toBe("Think");
    expect(toolActivityLabel("X", null)).toBe("X");
  });
  it("collapses whitespace and clips a long target", () => {
    const long = "a".repeat(200);
    const out = toolActivityLabel("Bash", { command: long });
    expect(out.startsWith("Bash ")).toBe(true);
    expect(out.length).toBeLessThan(70);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("deriveActivity", () => {
  const asMsg = (blocks: unknown[]): ConversationItem =>
    ({ kind: "assistant_message", id: "m", blocks, parent_tool_use_id: null }) as ConversationItem;

  it("reports the last tool call of the last assistant turn", () => {
    const items = [
      asMsg([{ type: "text", text: "let me look" }]),
      asMsg([
        { type: "text", text: "checking" },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ]),
    ];
    expect(deriveActivity(items)).toEqual({ kind: "tool", detail: "Read a.ts" });
  });

  it("falls back to the last text when the turn has no tool call", () => {
    const items = [asMsg([{ type: "text", text: "  Done   analysing\n\n" }])];
    expect(deriveActivity(items)).toEqual({ kind: "text", detail: "Done analysing" });
  });

  it("returns null when there is no assistant turn yet", () => {
    const items: ConversationItem[] = [
      { kind: "tool_result", tool_use_id: "t", content: null, is_error: false, parent_tool_use_id: null } as ConversationItem,
    ];
    expect(deriveActivity(items)).toBeNull();
    expect(deriveActivity([])).toBeNull();
  });
});
