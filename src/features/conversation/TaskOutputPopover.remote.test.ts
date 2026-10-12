// A background command's output popover on a conversation running on a PAIRED SERVER. The
// output path the stream reports names a file on the server, so the popover must read it
// through the read routed by conversation (`readTaskOutput(convId, …)` — the core sends it to
// the server), incrementally, on the slower remote cadence, and only while open — never claim
// "no output yet" / "couldn't load it" because this Mac lacks a file it was never going to have.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readTaskOutput: vi.fn() }));

vi.mock("../../ipc/client", () => ({
  commands: { readTaskOutput: mocks.readTaskOutput },
  events: {},
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TaskOutputChunk } from "../../ipc/client";
import { useConversationsStore } from "../../store/conversationsStore";
import { BashOutputPopover } from "./BashOutputPopover";
import { MonitorBar } from "./MonitorBar";
import { REMOTE_POLL_MS } from "./TaskOutputPopover";
import { useBackgroundTasksStore } from "../../store/backgroundTasksStore";

const PATH = "/tmp/claude-1000/-srv-app/sid-1/tasks/b1.output";
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const chunk = (data: string, start: number, size = start + data.length): TaskOutputChunk => ({
  data,
  start,
  next_offset: start + data.length,
  size,
  eof: true,
});

let container: HTMLDivElement;
let root: Root;

function mount(props: { convId?: string; running: boolean; open?: boolean }) {
  act(() => {
    root.render(
      createElement(BashOutputPopover, {
        open: props.open ?? true,
        convId: props.convId ?? "c-remote",
        outputFile: PATH,
        sessionId: "sid-1",
        taskId: "b1",
        name: "build the app",
        command: "make build",
        running: props.running,
        summary: null,
        onClose: () => {},
      }),
    );
  });
}

const text = () => document.body.textContent ?? "";
const flush = () => act(async () => {});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // Also drop queued once-answers: one test's unconsumed answer must never feed the next.
  mocks.readTaskOutput.mockReset();
  useBackgroundTasksStore.setState({ sessions: {} } as never);
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Target" }] as never,
    repos: [
      { id: "r-remote", path: "/srv/app", machineId: "m1" },
      { id: "r-local", path: "/Users/me/app", machineId: null },
    ] as never,
    conversations: [
      { id: "c-remote", repoId: "r-remote", name: "remote", kind: "claude", sessionId: "sid-1" },
      { id: "c-local", repoId: "r-local", name: "local", kind: "claude", sessionId: "sid-2" },
    ] as never,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("TaskOutputPopover on a conversation running on a paired server", () => {
  it("reads the output through the routed read, then only the appended bytes, every 4 s", async () => {
    vi.useFakeTimers();
    mocks.readTaskOutput
      .mockResolvedValueOnce(ok(chunk("compiling…\n", 0)))
      .mockResolvedValueOnce(ok(chunk("done.\n", 11)));
    mount({ running: true });
    await flush();
    // A reported path is read as such (no locating).
    expect(mocks.readTaskOutput).toHaveBeenCalledWith("c-remote", PATH, null, null);
    expect(text()).toContain("compiling…");

    // Not on the local 1.5 s cadence: each read is an ssh round trip.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(mocks.readTaskOutput).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS - 1500);
    });
    expect(mocks.readTaskOutput).toHaveBeenCalledTimes(2);
    expect(mocks.readTaskOutput).toHaveBeenLastCalledWith("c-remote", PATH, null, 11);
    // Appended, not replaced.
    expect(text()).toContain("compiling…");
    expect(text()).toContain("done.");
  });

  it("a local conversation keeps the 1.5 s tail", async () => {
    vi.useFakeTimers();
    mocks.readTaskOutput.mockResolvedValue(ok(chunk("", 0)));
    mount({ convId: "c-local", running: true });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(mocks.readTaskOutput).toHaveBeenCalledTimes(2);
    expect(mocks.readTaskOutput).toHaveBeenCalledWith("c-local", PATH, null, null);
  });

  it("a closed popover reads nothing", async () => {
    vi.useFakeTimers();
    mount({ running: true, open: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 3);
    });
    expect(mocks.readTaskOutput).not.toHaveBeenCalled();
  });

  it("a file the server no longer has is said to be gone from THE SERVER, not 'couldn't load it'", async () => {
    mocks.readTaskOutput.mockResolvedValue(ok(null));
    mount({ running: false });
    await flush();
    expect(text()).toContain("Output unavailable — its file is no longer on Target.");
    expect(text()).not.toContain("couldn't load it");
  });

  it("an unreachable server is named, never shown as 'no output yet'", async () => {
    mocks.readTaskOutput.mockResolvedValue({
      status: "error",
      error: { kind: "unreachable", server: "Target", reason: "could not reach the server" },
    });
    mount({ running: true });
    await flush();
    expect(text()).toContain("Unreadable output: couldn't reach Target — could not reach the server");
    expect(text()).not.toContain("no output yet");
  });

  it("a tail-first read says earlier output was skipped, and where it is", async () => {
    mocks.readTaskOutput.mockResolvedValue(ok(chunk("last line\n", 5_000_000)));
    mount({ running: false });
    await flush();
    expect(text()).toContain("Showing the latest output — earlier lines are in the file on Target.");
    expect(text()).toContain("last line");
  });

  it("a still-empty running output doesn't flicker back to 'Loading…' on each poll", async () => {
    vi.useFakeTimers();
    let resolveSecond: (v: unknown) => void = () => {};
    mocks.readTaskOutput
      .mockResolvedValueOnce(ok(null))
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)));
    mount({ running: true });
    await flush();
    expect(text()).toContain("The command is running — no output yet…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    });
    // The second read is in flight: the body keeps what the first read established.
    expect(text()).toContain("The command is running — no output yet…");
    expect(text()).not.toContain("Loading output…");
    await act(async () => resolveSecond(ok(null)));
  });

  it("the task ending while a read is in flight still gets its FINAL read — the last lines are never lost", async () => {
    vi.useFakeTimers();
    let resolveSecond: (v: unknown) => void = () => {};
    mocks.readTaskOutput
      .mockResolvedValueOnce(ok(chunk("compiling…\n", 0)))
      // The poll's read: measured on the server BEFORE the command's last line was written.
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)))
      .mockResolvedValueOnce(ok(chunk("✓ built in 9.40s\n", 11)));
    mount({ running: true });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    });
    expect(mocks.readTaskOutput).toHaveBeenCalledTimes(2);
    // The command ends (task notification) while that read is still on its way back.
    mount({ running: false });
    await flush();
    expect(mocks.readTaskOutput).toHaveBeenCalledTimes(2); // one read at a time…
    await act(async () => resolveSecond(ok(chunk("", 11))));
    await flush();
    // …and the final read runs as soon as it lands, from where it left off.
    expect(mocks.readTaskOutput).toHaveBeenCalledTimes(3);
    expect(mocks.readTaskOutput).toHaveBeenLastCalledWith("c-remote", PATH, null, 11);
    expect(text()).toContain("compiling…");
    expect(text()).toContain("✓ built in 9.40s");
  });

  it("a read failing once output is shown says so, above the output it keeps", async () => {
    vi.useFakeTimers();
    mocks.readTaskOutput
      .mockResolvedValueOnce(ok(chunk("tick 1\n", 0)))
      .mockResolvedValue({
        status: "error",
        error: { kind: "unreachable", server: "Target", reason: "could not reach the server" },
      });
    mount({ running: true });
    await flush();
    expect(text()).not.toContain("latest read failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    });
    // Both: what was read before, and that it is no longer being refreshed — and why.
    expect(text()).toContain("tick 1");
    expect(text()).toContain(
      "Showing the output read before — the latest read failed: couldn't reach Target — could not reach the server.",
    );
  });
});

describe("a running Monitor's event stream (its path is only reported at its end)", () => {
  const SID = "sid-1";
  function monitorTask(over: Record<string, unknown> = {}) {
    return {
      task_id: "bk5y3rqjw",
      kind: "monitor",
      status: "running",
      label: "tick watch",
      output_file: null,
      ...over,
    };
  }

  function mountBar(task: Record<string, unknown>) {
    useBackgroundTasksStore.setState({ sessions: { "c-remote": { bk5y3rqjw: task } } } as never);
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    act(() => {
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(MonitorBar, { session: "c-remote" })));
    });
  }

  it("is found by (session, task) on the conversation's server — never 'no events yet' over a filling file", async () => {
    vi.useFakeTimers();
    mocks.readTaskOutput.mockResolvedValue(ok(chunk("tick1\ntick2\n", 0)));
    mountBar(monitorTask());
    const row = container.querySelector<HTMLButtonElement>(".cv-bashrow-main");
    expect(row).not.toBeNull();
    act(() => row!.click());
    await flush();
    expect(mocks.readTaskOutput).toHaveBeenCalledWith("c-remote", null, { session_id: SID, task_id: "bk5y3rqjw" }, null);
    expect(text()).toContain("tick2");
    expect(text()).not.toContain("no events yet");
  });

  it("once its end reports the path, the same file keeps being read by that path, from where it was", async () => {
    vi.useFakeTimers();
    mocks.readTaskOutput
      .mockResolvedValueOnce(ok(chunk("tick1\n", 0)))
      .mockResolvedValueOnce(ok(chunk("tick2\n", 6)));
    mountBar(monitorTask());
    act(() => container.querySelector<HTMLButtonElement>(".cv-bashrow-main")!.click());
    await flush();
    const path = "/tmp/claude-1000/-srv-app/sid-1/tasks/bk5y3rqjw.output";
    act(() => {
      useBackgroundTasksStore.setState({
        sessions: { "c-remote": { bk5y3rqjw: monitorTask({ status: "completed", output_file: path, summary: "Monitor \"tick watch\" stream ended" }) } },
      } as never);
    });
    await flush();
    expect(mocks.readTaskOutput).toHaveBeenLastCalledWith("c-remote", path, null, 6);
    expect(text()).toContain("tick1");
    expect(text()).toContain("tick2");
  });
});
