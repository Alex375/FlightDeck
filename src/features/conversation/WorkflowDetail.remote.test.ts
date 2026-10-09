// The reported bug, end to end on the modal: a workflow running in a conversation on a PAIRED
// SERVER. Its journal, script, manifest and agent transcripts are on that server, so the modal
// must never read them as this Mac's files — it shows every agent's real state from the stream
// snapshot, and reads the report and the selected agent's transcript through the reads ROUTED BY
// CONVERSATION (`conversationId` first: the core sends them to the server). Same createElement +
// react-dom/client harness as the settings tests.

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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationItem, JsonValue, WorkflowProgress, WorkflowRun } from "../../ipc/client";
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
// The transcript column renders real thread rows, some of which use queries.
const qc = new QueryClient();

function render(props: { running: boolean; status?: string | null }) {
  const progress = useWorkflowProgressStore.getState().runs.c1?.t1 ?? null;
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
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
      ),
    );
  });
}

const text = () => document.body.textContent ?? "";
/** Let the routed reads' promises settle and React commit what they set. */
const flush = () => act(async () => {});
/** A remote run's journal and script are never read (the stream carries both). */
const noJournalOrScriptRead = () => {
  expect(mocks.loadWorkflowJournal).not.toHaveBeenCalled();
  expect(mocks.loadWorkflowPhases).not.toHaveBeenCalled();
};
/** …and while it runs there is no report to read on its server either. */
const noReadWhileRunning = () => {
  noJournalOrScriptRead();
  expect(mocks.loadWorkflowRun).not.toHaveBeenCalled();
};
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const agentTranscript: ConversationItem[] = [
  {
    kind: "assistant_message",
    id: "m1",
    model: "claude-opus-5-5",
    blocks: [{ type: "text", text: "Reviewed the daemon: LGTM on the server side." }],
  } as unknown as ConversationItem,
];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.loadWorkflowRun.mockResolvedValue(ok(null));
  mocks.loadSubagentTranscript.mockResolvedValue(ok([]));
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
    noReadWhileRunning();
  });

  it("reads the selected agent's transcript through the routed read, by conversation", async () => {
    mocks.loadSubagentTranscript.mockResolvedValue(ok(agentTranscript));
    render({ running: true });
    // The default selection is a CLICKABLE agent (a queued one has nothing to read): a1.
    expect(mocks.loadSubagentTranscript).toHaveBeenCalledWith("c1", "sess-1", "a1", null);
    await flush();
    expect(text()).toContain("Reviewed the daemon: LGTM on the server side.");
    expect(text()).not.toContain("isn't read from this Mac");
    noReadWhileRunning();
  });

  it("names the server when the transcript can't be reached", async () => {
    mocks.loadSubagentTranscript.mockResolvedValue({
      status: "error",
      error: { kind: "unreachable", server: "Target", reason: "could not reach the server" },
    });
    render({ running: true });
    await flush();
    expect(text()).toContain("Transcript unreadable: couldn't reach Target — could not reach the server");
  });

  it("a running agent's transcript is re-read only on the slow remote cadence", async () => {
    vi.useFakeTimers();
    try {
      // Select the RUNNING agent (a3): click its row.
      render({ running: true });
      const row = Array.from(document.body.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes("review:pwa"),
      );
      act(() => row!.click());
      const calls = () => mocks.loadSubagentTranscript.mock.calls.filter((c) => c[2] === "a3").length;
      expect(calls()).toBe(1);
      // The modal's 1.5 s tick no longer drives a remote read…
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(calls()).toBe(1);
      // …and with the agent's stream snapshot unchanged, neither does the 5 s pacing.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(calls()).toBe(1);
      // The snapshot moves (a new tool): the next pacing tick re-reads it.
      useWorkflowProgressStore.getState().apply("c1", {
        ...running,
        entries: (running.entries as Record<string, JsonValue>[]).map((e) =>
          e.agentId === "a3" ? { ...e, lastToolName: "Read", lastToolSummary: "session.rs" } : e,
        ),
      });
      render({ running: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("once settled, renders the report from the final snapshot — never 'report not found'", async () => {
    useWorkflowProgressStore.getState().apply("c1", {
      ...running,
      settled: true,
      entries: (running.entries as Record<string, JsonValue>[]).map((e) =>
        e.type === "workflow_agent" ? { ...e, state: "done", agentId: e.agentId ?? "a4" } : e,
      ),
    });
    render({ running: false, status: "completed" });
    await flush();
    const t = text();
    expect(t).toContain("4/4");
    expect(t).not.toContain("conversation reopened");
    expect(t).not.toContain("Workflow report not found");
    // Once over, the run's report is asked of its server — by conversation.
    expect(mocks.loadWorkflowRun).toHaveBeenCalledWith("c1", "sess-1", "wf_abc");
    noJournalOrScriptRead();
  });

  it("the report read on the server upgrades the post-run view (its default model, its tally)", async () => {
    const manifest: WorkflowRun = {
      runId: "wf_abc",
      taskId: "t1",
      status: "completed",
      workflowName: "remote-hardening-review",
      defaultModel: "claude-opus-5-5",
      durationMs: 90_000,
      agentCount: 1,
      totalTokens: 4200,
      totalToolCalls: 9,
      summary: null,
      phases: [{ title: "Review", detail: null }],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Review" },
        { type: "workflow_agent", index: 1, label: "review:manifest-only", phaseIndex: 1, phaseTitle: "Review", agentId: "a1", state: "done" },
      ],
      result: null,
    };
    mocks.loadWorkflowRun.mockResolvedValue(ok(manifest));
    render({ running: false, status: "completed" });
    await flush();
    expect(text()).toContain("review:manifest-only");
    expect(text()).toContain("4.2k tk");
  });

  it("without any snapshot (an older CLI), reads the report on the server and says where it looked", async () => {
    useWorkflowProgressStore.getState().clear();
    render({ running: false, status: "completed" });
    await flush();
    expect(mocks.loadWorkflowRun).toHaveBeenCalledWith("c1", "sess-1", "wf_abc");
    expect(text()).toContain("not found on Target");
    expect(text()).not.toContain("conversation reopened");
    noJournalOrScriptRead();
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
    noReadWhileRunning();
  });

  it("offers Refresh for a remote run: it re-reads the selected transcript on the server", () => {
    render({ running: true });
    const btn = document.body.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    const before = mocks.loadSubagentTranscript.mock.calls.length;
    act(() => btn!.click());
    expect(mocks.loadSubagentTranscript.mock.calls.length).toBe(before + 1);
    // While it runs, there is no report on the server to re-read yet.
    noReadWhileRunning();
  });

  it("classic face with no agent open: Refresh would do nothing, so it isn't offered as if it would — it says why", () => {
    useDisplay.setState({ workflowAgentDetail: false });
    try {
      render({ running: true });
      const btn = document.body.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      // Dimmed but hoverable (`aria-disabled`, not `disabled`), so its reason shows.
      expect(btn!.getAttribute("aria-disabled")).toBe("true");
      expect(btn!.disabled).toBe(false);
      expect(btn!.title).toContain("Nothing to refresh yet — while the run on Target is going");
      act(() => btn!.click());
      expect(mocks.loadSubagentTranscript).not.toHaveBeenCalled();
      noReadWhileRunning();
    } finally {
      useDisplay.setState({ workflowAgentDetail: true });
    }
  });

  it("once the run is over, Refresh is offered again (it re-reads the report on the server)", async () => {
    render({ running: false, status: "completed" });
    await flush();
    const btn = document.body.querySelector('button[aria-label="Refresh"]') as HTMLButtonElement | null;
    expect(btn!.getAttribute("aria-disabled")).toBeNull();
    const before = mocks.loadWorkflowRun.mock.calls.length;
    act(() => btn!.click());
    expect(mocks.loadWorkflowRun.mock.calls.length).toBe(before + 1);
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
      noReadWhileRunning();
    } finally {
      useDisplay.setState({ workflowAgentDetail: true });
    }
  });
});
