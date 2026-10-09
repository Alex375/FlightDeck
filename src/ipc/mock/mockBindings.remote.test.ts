// The browser mock and remote conversations (`?remote=1`, combinable with `?demo=…`).
//
// The real disk readers are routed by conversation: a conversation on a paired server has none of
// its files on this Mac. A mock that served its canned demo data regardless showed the OPPOSITE of
// production — a complete workflow journal, a sub-agent transcript, task output — so the whole
// class of "read this Mac's disk for a server's file" bugs could never be caught in the browser.
// `?remote=1` hosts the scenario's conversation on a paired server, and the readers answer for it
// what this Mac's disk would: nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockCommands } from "./mockBindings";
import { MOCK_SESSION_ID } from "./scenario";

function at(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}

const okData = async <T>(p: Promise<{ status: string; data?: T; error?: unknown }>): Promise<T> => {
  const r = await p;
  if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.data as T;
};

beforeEach(() => at(""));
afterEach(() => at(""));

describe("?remote=1", () => {
  it("hosts the scenario conversation in a server folder — Codex keeps this Mac's same-path clone", async () => {
    at("?remote=1&demo=workflow");
    const state = await okData(mockCommands.loadPersistedState());
    const scenario = state.repos.find((r) => r.id === "repo-demo")!;
    expect(scenario.machine_id).toBeTruthy();
    expect((state.machines ?? []).some((m) => m.id === scenario.machine_id)).toBe(true);
    const codex = state.conversations.find((c) => c.backend === "codex")!;
    const codexRepo = state.repos.find((r) => r.id === codex.repo_id)!;
    expect(codexRepo.machine_id).toBeNull();
    expect(codexRepo.path).toBe(scenario.path);
  });

  it("its disk readers answer empty for the remote conversation, as this Mac's disk would", async () => {
    at("?remote=1&demo=workflow");
    await okData(mockCommands.loadPersistedState());
    const conv = "conv-demo";
    expect(await okData(mockCommands.loadSubagentTranscript(conv, MOCK_SESSION_ID, "a1", null))).toEqual([]);
    expect(await okData(mockCommands.loadWorkflowJournal(conv, MOCK_SESSION_ID, "wf_1"))).toBeNull();
    expect(await okData(mockCommands.loadWorkflowRun(conv, MOCK_SESSION_ID, "wf_1"))).toBeNull();
    expect(await okData(mockCommands.loadWorkflowPhases(conv, MOCK_SESSION_ID, "wf_1"))).toEqual([]);
    expect(
      await okData(mockCommands.readTaskOutput(conv, "/tmp/claude-501/x/s/tasks/bash_1.output", null, null)),
    ).toBeNull();
    expect(await okData(mockCommands.loadSessionHistory(MOCK_SESSION_ID))).toEqual([]);
    // An attachment comes back as the SERVER's path.
    expect(await okData(mockCommands.uploadAttachment(conv, "/Users/dev/notes (1).md"))).toBe(
      "/home/deploy/.cache/flightdeck/uploads/conv-demo/notes__1_.md",
    );
  });

  it("without the flag, the same reader keeps serving the demo data (unchanged)", async () => {
    at("?demo=workflow");
    const state = await okData(mockCommands.loadPersistedState());
    expect(state.repos.find((r) => r.id === "repo-demo")!.machine_id).toBeNull();
    expect((await okData(mockCommands.loadSubagentTranscript("conv-demo", MOCK_SESSION_ID, "a1", null))).length).toBeGreaterThan(0);
    // A local conversation's attachment is never copied anywhere.
    expect((await mockCommands.uploadAttachment("conv-demo", "/Users/dev/notes.md")).status).toBe("error");
  });
});
