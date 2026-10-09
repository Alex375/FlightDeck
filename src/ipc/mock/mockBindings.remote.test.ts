// The browser mock and remote conversations (`?remote=1`, combinable with `?demo=…`).
//
// A conversation on a paired server has none of its files on this Mac. `?remote=1` hosts the
// scenario's conversation on a paired server, and each reader answers for it what the core does:
// the readers routed by conversation read the SERVER (the demo data, a round trip later), the
// ones that only look at this Mac answer empty, and the journal / phase readers — never used for
// a server's run, its stream carries both — are refused. Served regardless, canned data showed
// the opposite of production for the Mac-only readers; withheld, the remote reads' success path
// could not be exercised in the browser at all.

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

  it("its readers answer the remote conversation the way the core does", async () => {
    at("?remote=1&demo=workflow");
    await okData(mockCommands.loadPersistedState());
    const conv = "conv-demo";
    // Routed by conversation: read on the server.
    expect((await okData(mockCommands.loadSubagentTranscript(conv, MOCK_SESSION_ID, "a1", null))).length).toBeGreaterThan(0);
    expect((await mockCommands.loadWorkflowRun(conv, MOCK_SESSION_ID, "wf_1")).status).toBe("ok");
    expect((await mockCommands.readTaskOutput(conv, "/tmp/claude-501/x/s/tasks/bash_1.output", null, null)).status).toBe(
      "ok",
    );
    // Never read for a server's run: refused, like the core.
    for (const r of [
      await mockCommands.loadWorkflowJournal(conv, MOCK_SESSION_ID, "wf_1"),
      await mockCommands.loadWorkflowPhases(conv, MOCK_SESSION_ID, "wf_1"),
    ]) {
      expect(r.status).toBe("error");
      if (r.status === "error") expect(r.error.kind).toBe("refused");
    }
    // Only this Mac's disk: nothing.
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
