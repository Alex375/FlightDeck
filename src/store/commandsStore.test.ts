import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary: a controllable fetchSlashCommands. Same pattern as
// reminderSync.test / mentionCache.test.
vi.mock("../ipc/client", () => ({
  commands: { fetchSlashCommands: vi.fn() },
}));

import { commands } from "../ipc/client";
import type { SlashCommand } from "../ipc/client";
import {
  cachedCommands,
  prefetchSlashCommands,
  refetchSlashCommands,
  useCommandsStore,
} from "./commandsStore";
import { commandsKey, conversationPlace } from "./commandsPlace";

const fetchSlashCommands = commands.fetchSlashCommands as unknown as ReturnType<typeof vi.fn>;

const cmd = (name: string): SlashCommand => ({ name, description: "", argument_hint: "" });
const LOCAL = { cwd: "/repo", machineId: null };
/** The SAME path, on a paired server — a different folder. */
const REMOTE = { cwd: "/repo", machineId: "machine-base" };
const OLD = [cmd("old")];
const NEW = [cmd("new-a"), cmd("new-b")];

const names = (list: SlashCommand[] | undefined) => (list ?? []).map((c) => c.name);

beforeEach(() => {
  localStorage.clear();
  useCommandsStore.setState({ byPlace: {}, lastSeen: {} });
  fetchSlashCommands.mockReset();
});

describe("refetchSlashCommands", () => {
  it("OVERWRITES an already-cached catalogue (bypasses the prefetch guards)", async () => {
    useCommandsStore.getState().setCommands(LOCAL, OLD);
    fetchSlashCommands.mockResolvedValue({ status: "ok", data: NEW });

    await refetchSlashCommands(LOCAL);

    expect(fetchSlashCommands).toHaveBeenCalledWith("/repo");
    expect(names(cachedCommands(LOCAL))).toEqual(["new-a", "new-b"]);
  });

  it("keeps the old cache when the fetch returns an EMPTY list (spawn failure)", async () => {
    useCommandsStore.getState().setCommands(LOCAL, OLD);
    fetchSlashCommands.mockResolvedValue({ status: "ok", data: [] });

    await refetchSlashCommands(LOCAL);

    // The invariant: a transient failure must never blank the menu.
    expect(names(cachedCommands(LOCAL))).toEqual(["old"]);
  });

  it("keeps the old cache on an error status", async () => {
    useCommandsStore.getState().setCommands(LOCAL, OLD);
    fetchSlashCommands.mockResolvedValue({ status: "error", error: "boom" });

    await refetchSlashCommands(LOCAL);

    expect(names(cachedCommands(LOCAL))).toEqual(["old"]);
  });

  it("keeps the old cache when the fetch throws", async () => {
    useCommandsStore.getState().setCommands(LOCAL, OLD);
    fetchSlashCommands.mockRejectedValue(new Error("transport died"));

    await refetchSlashCommands(LOCAL);

    expect(names(cachedCommands(LOCAL))).toEqual(["old"]);
  });

  it("is a no-op for a null/empty cwd (never spawns)", async () => {
    await refetchSlashCommands(null);
    await refetchSlashCommands({ cwd: "" });
    expect(fetchSlashCommands).not.toHaveBeenCalled();
  });

  it("never probes a SERVER's folder — the probe would run on this Mac", async () => {
    useCommandsStore.getState().setCommands(REMOTE, OLD);
    fetchSlashCommands.mockResolvedValue({ status: "ok", data: NEW });

    await refetchSlashCommands(REMOTE);

    expect(fetchSlashCommands).not.toHaveBeenCalled();
    expect(names(cachedCommands(REMOTE))).toEqual(["old"]);
  });
});

describe("prefetchSlashCommands", () => {
  it("probes a never-seen LOCAL folder once", async () => {
    fetchSlashCommands.mockResolvedValue({ status: "ok", data: NEW });

    await prefetchSlashCommands({ cwd: "/fresh", machineId: null });
    await prefetchSlashCommands({ cwd: "/fresh", machineId: null });

    expect(fetchSlashCommands).toHaveBeenCalledTimes(1);
    expect(names(cachedCommands({ cwd: "/fresh" }))).toEqual(["new-a", "new-b"]);
  });

  it("never probes a SERVER's folder, even one never seen", async () => {
    fetchSlashCommands.mockResolvedValue({ status: "ok", data: NEW });

    await prefetchSlashCommands({ cwd: "/fresh", machineId: "machine-base" });

    expect(fetchSlashCommands).not.toHaveBeenCalled();
    expect(cachedCommands({ cwd: "/fresh", machineId: "machine-base" })).toBeUndefined();
  });

  it("a local catalogue at the same path does not make a server's folder look known", async () => {
    useCommandsStore.getState().setCommands(LOCAL, NEW);
    // The remote folder stays unknown — and the local probe dedupe does not leak either.
    expect(cachedCommands(REMOTE)).toBeUndefined();
  });
});

describe("setCommands — the machine is part of the folder", () => {
  it("a Mac clone and a server clone at the SAME path keep separate catalogues", () => {
    useCommandsStore.getState().setCommands(LOCAL, [cmd("tosse-workflow:pickup")]);
    useCommandsStore.getState().setCommands(REMOTE, [cmd("help")]);

    // The bug this key fixes: the second write used to overwrite the first, and the TOSSE
    // launch then sent the Mac's `/tosse-workflow:pickup` to a server without the plugin.
    expect(names(cachedCommands(LOCAL))).toEqual(["tosse-workflow:pickup"]);
    expect(names(cachedCommands(REMOTE))).toEqual(["help"]);
  });

  it("keeps the never-seen fallback PER MACHINE", () => {
    useCommandsStore.getState().setCommands(LOCAL, [cmd("mac-skill")]);
    useCommandsStore.getState().setCommands(REMOTE, [cmd("server-skill")]);

    const { lastSeen } = useCommandsStore.getState();
    expect(names(lastSeen.local)).toEqual(["mac-skill"]);
    expect(names(lastSeen["machine-base"])).toEqual(["server-skill"]);
  });

  it("persists under the place key", () => {
    useCommandsStore.getState().setCommands(REMOTE, NEW);
    const stored = JSON.parse(localStorage.getItem("tosse:slash-commands-by-place") ?? "{}");
    expect(Object.keys(stored)).toEqual([commandsKey(REMOTE)]);
  });
});

describe("conversationPlace", () => {
  const repos = [
    { id: "r-mac", path: "/repo", machineId: null },
    { id: "r-base", path: "/repo", machineId: "machine-base" },
  ];

  it("takes the machine from the conversation's repository", () => {
    expect(conversationPlace("/repo", "r-base", repos)).toEqual(REMOTE);
    expect(conversationPlace("/repo", "r-mac", repos)).toEqual(LOCAL);
  });

  it("refuses to attribute a conversation whose repository is gone", () => {
    expect(conversationPlace("/repo", "r-gone", repos)).toBeNull();
  });
});
