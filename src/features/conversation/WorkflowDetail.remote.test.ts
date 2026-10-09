// The reported bug, end to end on the modal: a workflow running in a conversation on a PAIRED
// SERVER. Its journal, script, manifest and agent transcripts are on that server, so the modal
// must never read this Mac's disk for it — and must still show every agent's real state, from
// the stream snapshot. Same createElement + react-dom/client harness as the settings tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadWorkflowRun: vi.fn(),
  loadWorkflowJournal: vi.fn(),
  loadWorkflowPhases: vi.fn(),
  loadSubagentTranscript: vi.fn(),
}));

vi.mock("../../ipc/client", () => ({
  commands: {
    loadWorkflowRun: mocks.loadWorkflowRun,
    loadWorkflowJournal: mocks.loadWorkflowJournal,
    loadWorkflowPhases: mocks.loadWorkflowPhases,
    loadSubagentTranscript: mocks.loadSubagentTranscript,
  },
  events: {},
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { JsonValue, WorkflowProgress } from "../../ipc/client";
import { useConversationsStore } from "../../store/conversationsStore";
import { useDisplay } from "../../store/display";
import { useWorkflowProgressStore } from "../../store/workflowProgress";
import { streamJournalView } from "./workflowStream";
import { WorkflowDetail } from "./WorkflowDetail";

const agent = (o: Record<string, JsonValue>) => ({ type: "workflow_agent", ...o });

/** Mid-run: Review has 2 delivered + 1 running agent, plus one QUEUED behind the gate. */
const running: WorkflowProgress = {
  task_id: "t1",
  tool_use_id: "toolu_wf",
  declared_phases: [
    { title: "Review", detail: "one reviewer per subsystem" },
    { title: "Report", detail: null },
  ],
  entries: [
    { type: "workflow_phase", index: 1, title: "Review" },
    { type: "workflow_phase", index: 2, title: "Report" },
    agent({ index: 1, label: "review:daemon", phaseIndex: 1, phaseTitle: "Review", agentId: "a1", state: "done", model: "claude-opus-5-5", tokens: 1200, resultPreview: "LGTM" }),
    agent({ index: 2, label: "review:relay", phaseIndex: 1, phaseTitle: "Review", agentId: "a2", state: "done" }),
    agent({ index: 3, label: "review:pwa", phaseIndex: 1, phaseTitle: "Review", agentId: "a3", state: "start", lastToolName: "Grep", lastToolSummary: "fd_attach" }),
    agent({ index: 4, label: "review:infra", phaseIndex: 1, phaseTitle: "Review", state: "start" }),
  ],
  elapsed_ms: 60_000,
  tokens: 5000,
  tool_uses: 12,
  settled: false,
};

let container: HTMLDivElement;
let root: Root;

function render(props: { running: boolean; status?: string | null }) {
  const progress = useWorkflowProgressStore.getState().runs.c1?.t1 ?? null;
  act(() => {
    root.render(
      createElement(WorkflowDetail, {
        open: true,
        convId: "c1",
        sessionId: "sess-1",
        runId: "wf_abc",
        taskId: "t1",
        status: props.status ?? null,
        running: props.running,
        workflowName: "remote-hardening-review",
        currentProgress: "Review: review:pwa",
        liveActivity: { phases: [], startedAt: null },
        journal: progress ? streamJournalView(progress) : undefined,
        onClose: () => {},
      }),
    );
  });
}

const text = () => document.body.textContent ?? "";
const noDiskRead = () => {
  expect(mocks.loadWorkflowRun).not.toHaveBeenCalled();
  expect(mocks.loadWorkflowJournal).not.toHaveBeenCalled();
  expect(mocks.loadWorkflowPhases).not.toHaveBeenCalled();
  expect(mocks.loadSubagentTranscript).not.toHaveBeenCalled();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [{ id: "r1", path: "/Users/admin/Projects/FlightDeck", machineId: "m1" }] as never,
    conversations: [{ id: "c1", repoId: "r1", name: "remote", kind: "claude", sessionId: "sess-1" }] as never,
  });
  useWorkflowProgressStore.getState().clear();
  useWorkflowProgressStore.getState().apply("c1", running);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkflowDetail on a conversation running on a paired server", () => {
  it("shows each agent's REAL state from the stream — not every one 'queued'", () => {
    render({ running: true });
    const t = text();
    for (const label of ["review:daemon", "review:relay", "review:pwa", "review:infra"]) {
      expect(t).toContain(label);
    }
    // The phase row counts what was delivered, with the queued agent in the total.
    expect(t).toContain("2/4");
    // The upcoming phase is listed (from the script's declared phases, streamed at t=0).
    expect(t).toContain("Report");
    expect(t).toContain("one reviewer per subsystem");
    // Only the agent behind the concurrency gate is queued; the running one shows its last tool.
    // (textContent runs sibling nodes together — count the word, not a word boundary.)
    expect(t.split("queued").length - 1).toBe(1);
    expect(t).toContain("Grep fd_attach");
    expect(t).toContain("Live view — from the session's stream.");
    expect(t).not.toContain("doesn't name agents");
    noDiskRead();
  });

  it("names the server instead of reading an absent transcript", () => {
    render({ running: true });
    // The default selection is a CLICKABLE agent (a queued one has nothing to read).
    expect(text()).toContain("lives on Target");
    noDiskRead();
  });

  it("once settled, renders the report from the final snapshot — never 'report not found'", () => {
    useWorkflowProgressStore.getState().apply("c1", {
      ...running,
      settled: true,
      entries: (running.entries as Record<string, JsonValue>[]).map((e) =>
        e.type === "workflow_agent" ? { ...e, state: "done", agentId: e.agentId ?? "a4" } : e,
      ),
    });
    render({ running: false, status: "completed" });
    const t = text();
    expect(t).toContain("4/4");
    expect(t).not.toContain("conversation reopened");
    expect(t).not.toContain("Workflow report not found");
    noDiskRead();
  });

  it("without any snapshot (an older CLI), says where the report is", () => {
    useWorkflowProgressStore.getState().clear();
    render({ running: false, status: "completed" });
    expect(text()).toContain("lives on Target");
    expect(text()).not.toContain("conversation reopened");
    noDiskRead();
  });

  it("without a snapshot while running, never claims an agent is queued — its state is unknown here", () => {
    useWorkflowProgressStore.getState().clear();
    act(() => {
      root.render(
        createElement(WorkflowDetail, {
          open: true,
          convId: "c1",
          sessionId: "sess-1",
          runId: "wf_abc",
          taskId: "t1",
          running: true,
          workflowName: "remote-hardening-review",
          currentProgress: "Review: review:pwa",
          // What an older CLI's wire gives: coarse "<phase>: <label>" ticks only.
          liveActivity: { phases: [{ title: "Review", labels: ["review:daemon", "review:pwa"] }], startedAt: null },
          onClose: () => {},
        }),
      );
    });
    const t = text();
    expect(t).toContain("review:pwa");
    expect(t).toContain("state unknown");
    expect(t).toContain("this Claude Code version doesn't stream per-agent progress");
    expect(t).not.toContain("Queued —");
    noDiskRead();
  });

  it("offers no Refresh for a remote run (nothing on this Mac to re-read)", () => {
    render({ running: true });
    expect(document.body.querySelector('button[aria-label="Refresh"]')).toBeNull();
  });

  it("classic face: queued agents are counted apart, never as launched", () => {
    useDisplay.setState({ workflowAgentDetail: false });
    try {
      render({ running: true });
      const boxes = Array.from(document.body.querySelectorAll("[class*=statBox]")).map((b) =>
        (b.textContent ?? "").replace(/\s+/g, " ").trim(),
      );
      // 3 spawned (2 done, 1 running) + 1 queued.
      expect(boxes).toContain("3launched");
      expect(boxes).toContain("1running");
      expect(boxes).toContain("1queued");
      expect(boxes).toContain("2done");
      noDiskRead();
    } finally {
      useDisplay.setState({ workflowAgentDetail: true });
    }
  });
});
