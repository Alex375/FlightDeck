import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatePayload } from "../../ipc/client";
import { commands } from "../../ipc/client";
import type { Machine } from "../../store/conversationsStore";
import {
  probeMachine,
  resetProbeStateForTests,
  useMachineHealthStore,
  type MachineHealth,
} from "../../store/machineHealth";
import {
  checkedPhrase,
  localMachineText,
  machineActions,
  machineIdOf,
  machineLinkKey,
  machineLinkOf,
  machineReachOf,
  machineShowsAge,
  machineSubLine,
  machineTipLines,
  machineWidgetState,
  type MachineLink,
  type MachineView,
} from "./machineWidget";

const NOW = 10_000_000;

const machine = (over: Partial<Machine> = {}): Machine => ({
  id: "m1",
  label: "Base",
  host: "base.tail",
  port: 22,
  user: "alex",
  identityFile: null,
  addedAt: 0,
  addresses: [],
  ...over,
});

const reachable = (checkedAtMs = NOW - 2 * 60_000): MachineHealth => ({
  reachable: true,
  checkedAtMs,
  lastReachedAtMs: checkedAtMs,
  reason: null,
  probeError: null,
});

const unreachable = (over: Partial<MachineHealth> = {}): MachineHealth => ({
  reachable: false,
  checkedAtMs: NOW - 30_000,
  lastReachedAtMs: NOW - 4 * 60_000,
  reason: "could not reach the server",
  probeError: null,
  ...over,
});

/** The row `recordProbeError` writes for a machine it never reached a verdict on. */
const probeErrorOnly = (error = "ipc down"): MachineHealth => ({
  reachable: true,
  checkedAtMs: 0,
  lastReachedAtMs: null,
  reason: null,
  probeError: error,
});

const remote = (health: MachineHealth | undefined, link: MachineLink = { kind: "off" }): MachineView =>
  machineWidgetState({ machineId: "m1", machines: [machine()], health, link });

const state = (over: Partial<SessionStatePayload> = {}) => ({
  ended: false,
  link: null,
  session_id: "sess",
  ...over,
});

describe("machineIdOf", () => {
  const repos = [
    { id: "r-local", machineId: null },
    { id: "r-legacy" },
    { id: "r-remote", machineId: "m1" },
  ];

  it("reads a folder with no machine as this Mac, whether the field is null or absent", () => {
    expect(machineIdOf(repos, "r-local")).toBeNull();
    expect(machineIdOf(repos, "r-legacy")).toBeNull();
  });

  it("names the server of a remote folder", () => {
    expect(machineIdOf(repos, "r-remote")).toBe("m1");
  });

  // No repo is no answer — the row renders nothing rather than guessing "This Mac".
  it("has no answer at all when the repo is not in the store", () => {
    expect(machineIdOf(repos, "gone")).toBeUndefined();
  });

  // Every other surface (`remoteMarkFor`'s `!machineId`, the health host's `!!id`) reads an
  // empty id as local; the row must not take the remote branch and title it "Unknown server".
  it("reads an empty machine id as this Mac, like the remote mark does", () => {
    expect(machineIdOf([{ id: "r", machineId: "" }], "r")).toBeNull();
  });
});

describe("machineLinkOf", () => {
  it("is off while the stream is off, whatever the last state said", () => {
    expect(machineLinkOf(null, state())).toEqual({ kind: "off" });
    expect(machineLinkOf(undefined, undefined)).toEqual({ kind: "off" });
  });

  it("reads connecting and reconnecting straight off the live link", () => {
    expect(machineLinkOf("session-1", state({ link: { kind: "connecting" } }))).toEqual({ kind: "connecting" });
    expect(machineLinkOf("session-1", state({ link: { kind: "reconnecting", attempt: 3 } }))).toEqual({
      kind: "reconnecting",
      attempt: 3,
    });
  });

  it("is attached only once a real state event proved the link is up", () => {
    expect(machineLinkOf("session-1", state())).toEqual({ kind: "attached" });
  });

  // ⚠️ The neutral entry a fresh spawn starts from also has `link: null` — without the session
  // id guard it would read "Connected" before the first byte ever crossed the wire.
  it("does not read the neutral pre-first-event entry as attached", () => {
    expect(machineLinkOf("session-1", state({ session_id: null }))).toEqual({ kind: "starting" });
    expect(machineLinkOf("session-1", undefined)).toEqual({ kind: "starting" });
  });

  it("reads an ended session as ended, not attached (ending clears the link)", () => {
    expect(machineLinkOf("session-1", state({ ended: true }))).toEqual({ kind: "ended" });
  });

  // A local Codex session reports `link: null` with a session id — exactly an attached remote
  // one. It must never say "Connected" to a server it cannot even run on.
  it("never gives a Codex conversation a remote link", () => {
    expect(machineLinkOf("session-1", state(), "codex")).toEqual({ kind: "unsupported" });
  });

  // Nor "off", which promises a connection with the next message: the spawn REFUSES a Codex
  // conversation in a server's folder.
  it("reads a Codex conversation as unsupported even with its stream off", () => {
    expect(machineLinkOf(null, undefined, "codex")).toEqual({ kind: "unsupported" });
  });
});

describe("machineReachOf", () => {
  it("is unknown with no row", () => {
    expect(machineReachOf(undefined)).toEqual({ kind: "unknown", probeError: null });
  });

  // ⚠️ `recordProbeError` writes `reachable: true` with `checkedAtMs: 0` on a never-checked
  // machine. Reading `reachable` alone would call it "Reachable" on the strength of a failure.
  it("is unknown — not reachable — for a row that only ever recorded a probe error", () => {
    expect(machineReachOf(probeErrorOnly("boom"))).toEqual({ kind: "unknown", probeError: "boom" });
  });

  it("files a checked verdict either way", () => {
    expect(machineReachOf(reachable()).kind).toBe("reachable");
    expect(machineReachOf(unreachable()).kind).toBe("unreachable");
  });
});

describe("machineWidgetState", () => {
  it("is local for a folder on this Mac", () => {
    expect(machineWidgetState({ machineId: null, machines: [machine()], health: undefined, link: { kind: "off" } })).toEqual({
      kind: "local",
    });
  });

  it("names the server with its paired address", () => {
    const v = remote(reachable());
    expect(v).toMatchObject({ kind: "remote", machineId: "m1", label: "Base", target: "alex@base.tail:22" });
  });

  // The regression the remote mark exists to prevent, held here too.
  it("reads an unpaired machine as an unknown server, never as this Mac", () => {
    expect(machineWidgetState({ machineId: "gone", machines: [machine()], health: undefined, link: { kind: "off" } })).toEqual({
      kind: "unknown",
    });
    expect(machineWidgetState({ machineId: "m1", machines: [], health: reachable(), link: { kind: "attached" } })).toEqual({
      kind: "unknown",
    });
  });
});

describe("localMachineText", () => {
  it("shows the Mac's name with 'This Mac' under it", () => {
    expect(localMachineText("MacBook Pro")).toEqual({ title: "MacBook Pro", sub: "This Mac" });
  });

  it("falls back to 'This Mac' / 'Local' — never the same words twice", () => {
    expect(localMachineText(null)).toEqual({ title: "This Mac", sub: "Local" });
    expect(localMachineText(undefined)).toEqual({ title: "This Mac", sub: "Local" });
    expect(localMachineText("   ")).toEqual({ title: "This Mac", sub: "Local" });
  });
});

describe("machineSubLine", () => {
  const sub = (v: MachineView, opts: { probing?: boolean; reconnectError?: string | null } = {}) =>
    machineSubLine(v, { nowMs: NOW, ...opts });

  it("puts a reconnecting link first, in amber, with its attempt", () => {
    expect(sub(remote(unreachable(), { kind: "reconnecting", attempt: 4 }))).toEqual({
      text: "Reconnecting… attempt 4",
      tone: "att",
    });
    expect(sub(remote(reachable(), { kind: "reconnecting", attempt: 0 })).text).toBe("Reconnecting…");
  });

  it("says connecting, quietly — every spawn goes through it", () => {
    expect(sub(remote(reachable(), { kind: "connecting" }))).toEqual({ text: "Connecting…", tone: "lo" });
  });

  it("shows an unreachable server in red with the backend's reason, verbatim", () => {
    expect(sub(remote(unreachable()))).toEqual({ text: "could not reach the server", tone: "err" });
    expect(sub(remote(unreachable({ reason: null })))).toEqual({ text: "Unreachable", tone: "err" });
  });

  it("says Connected while the link is up — quietly, no green at rest", () => {
    expect(sub(remote(reachable(), { kind: "attached" }))).toEqual({ text: "Connected", tone: "lo" });
    expect(sub(remote(undefined, { kind: "attached" }))).toEqual({ text: "Connected", tone: "lo" });
  });

  it("otherwise gives the verdict with its age", () => {
    expect(sub(remote(reachable(NOW - 2 * 60_000)))).toEqual({ text: "Reachable · checked 2 min ago", tone: "lo" });
    expect(sub(remote(reachable(NOW - 5_000))).text).toBe("Reachable · checked just now");
  });

  it("reads an em dash with no verdict — never a fake 'Reachable'", () => {
    expect(sub(remote(undefined))).toEqual({ text: "—", tone: "lo" });
  });

  it("says Checking… while a probe is out and there is nothing better to show", () => {
    expect(sub(remote(undefined), { probing: true }).text).toBe("Checking…");
    // A real reading is never blanked by a re-check.
    expect(sub(remote(reachable()), { probing: true }).text).toBe("Reachable · checked 2 min ago");
  });

  // Not the server's fault, so quiet — but said: a check the user asked for must not end in
  // a silent dash.
  it("says why a check could not run, without accusing the server", () => {
    expect(sub(remote(probeErrorOnly("ipc down")))).toEqual({ text: "Could not check · ipc down", tone: "lo" });
  });

  // A "Check now" that failed to run must not leave the row exactly as it was: the older
  // "Reachable" verdict moves to the tooltip until a check completes again.
  it("says a check could not run over an older reachable verdict", () => {
    const failed = { ...reachable(), probeError: "ssh not found" };
    expect(sub(remote(failed))).toEqual({ text: "Could not check · ssh not found", tone: "lo" });
    // A re-check in flight is about to replace the error: the verdict shows meanwhile.
    expect(sub(remote(failed), { probing: true }).text).toBe("Reachable · checked 2 min ago");
    // …and the same error never outranks the red, or the live link.
    expect(sub(remote(unreachable({ probeError: "ssh not found" })))).toEqual({
      text: "could not reach the server",
      tone: "err",
    });
    expect(sub(remote(failed, { kind: "attached" })).text).toBe("Connected");
  });

  it("says a Codex conversation can't run on the server, whatever its health", () => {
    expect(sub(remote(reachable(), { kind: "unsupported" }))).toEqual({
      text: "Codex can't run on a server",
      tone: "att",
    });
    expect(sub(remote(unreachable(), { kind: "unsupported" })).text).toBe("Codex can't run on a server");
  });

  it("puts the user's own failed reconnect above everything", () => {
    expect(sub(remote(reachable(), { kind: "reconnecting", attempt: 2 }), { reconnectError: "no route" })).toEqual({
      text: "Reconnect failed · no route",
      tone: "err",
    });
  });

  it("covers the unknown server and the local Mac", () => {
    const unknown = machineWidgetState({ machineId: "gone", machines: [], health: undefined, link: { kind: "off" } });
    expect(sub(unknown)).toEqual({ text: "No longer paired", tone: "lo" });
    expect(machineSubLine({ kind: "local" }, { nowMs: NOW, localName: "MacBook Pro" }).text).toBe("This Mac");
    expect(machineSubLine({ kind: "local" }, { nowMs: NOW }).text).toBe("Local");
  });
});

describe("machineTipLines", () => {
  it("heads with the machine's name and gives the paired address", () => {
    const lines = machineTipLines(remote(reachable()), NOW);
    expect(lines[0]).toBe("Base");
    expect(lines).toContain("Paired as alex@base.tail:22");
    expect(lines).toContain("Stream off — connects with your next message");
    expect(lines).toContain("Reachable · checked 2 min ago");
  });

  it("carries every fact the sub-line had to leave out", () => {
    const lines = machineTipLines(remote(unreachable(), { kind: "reconnecting", attempt: 2 }), NOW);
    expect(lines).toContain("Connection lost — reconnecting (attempt 2)");
    expect(lines).toContain("Unreachable · checked just now");
    expect(lines).toContain("could not reach the server");
    expect(lines).toContain("Last reached 4 min ago");
  });

  it("says a server that never answered was not reached since launch, rather than inventing an age", () => {
    const lines = machineTipLines(remote(unreachable({ lastReachedAtMs: null })), NOW);
    expect(lines).toContain("Not reached since the app started");
  });

  it("never promises a Codex conversation a connection", () => {
    const lines = machineTipLines(remote(reachable(), { kind: "unsupported" }), NOW);
    expect(lines).toContain("Remote conversations are Claude-only — a Codex one can't run on this server");
    expect(lines).not.toContain("Stream off — connects with your next message");
  });

  it("never drops a probe error", () => {
    expect(machineTipLines(remote(probeErrorOnly("ipc down")), NOW)).toContain("Could not check it: ipc down");
    expect(machineTipLines(remote({ ...reachable(), probeError: "timeout" }), NOW)).toContain(
      "Last check could not run: timeout",
    );
  });
});

describe("machineActions", () => {
  it("offers nothing for this Mac", () => {
    expect(machineActions({ kind: "local" })).toEqual({ check: false, reconnect: false, server: false });
  });

  it("offers only the server panel for an unpaired server — there is no address left to dial", () => {
    expect(machineActions({ kind: "unknown" })).toEqual({ check: false, reconnect: false, server: true });
  });

  it("offers Reconnect only while the link is down", () => {
    const at = (link: MachineLink) => machineActions(remote(reachable(), link)).reconnect;
    expect(at({ kind: "connecting" })).toBe(true);
    expect(at({ kind: "reconnecting", attempt: 1 })).toBe(true);
    expect(at({ kind: "attached" })).toBe(false);
    expect(at({ kind: "off" })).toBe(false);
    expect(at({ kind: "starting" })).toBe(false);
    expect(at({ kind: "ended" })).toBe(false);
    expect(at({ kind: "unsupported" })).toBe(false);
  });

  it("always offers Check now for a paired server", () => {
    expect(machineActions(remote(undefined)).check).toBe(true);
  });
});

describe("machineShowsAge / machineLinkKey / checkedPhrase", () => {
  it("keeps a clock only while an age is on screen", () => {
    expect(machineShowsAge({ kind: "local" })).toBe(false);
    expect(machineShowsAge({ kind: "unknown" })).toBe(false);
    expect(machineShowsAge(remote(undefined))).toBe(false);
    expect(machineShowsAge(remote(probeErrorOnly()))).toBe(false);
    expect(machineShowsAge(remote(reachable()))).toBe(true);
    expect(machineShowsAge(remote(unreachable()))).toBe(true);
  });

  it("changes the link key with every new attempt, so a failed reconnect never outlives it", () => {
    expect(machineLinkKey({ kind: "reconnecting", attempt: 1 })).not.toBe(
      machineLinkKey({ kind: "reconnecting", attempt: 2 }),
    );
    expect(machineLinkKey({ kind: "attached" })).toBe("attached");
  });

  it("ages a verdict by when it was CHECKED, and never negatively", () => {
    expect(checkedPhrase(unreachable({ checkedAtMs: NOW - 3 * 60_000 }), NOW)).toBe("3 min ago");
    expect(checkedPhrase(reachable(NOW + 60_000), NOW)).toBe("just now");
  });
});

// The store's `probing` mirror is what lets "Check now" keep spinning when its click landed on
// a probe that was already in flight (the dedup returns at once).
describe("probing mirror", () => {
  beforeEach(() => {
    useMachineHealthStore.setState({ byMachine: {} });
    resetProbeStateForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("is set for the whole round trip, whoever fired it, and cleared after", async () => {
    let answer: (v: Awaited<ReturnType<typeof commands.machineReachability>>) => void = () => {};
    vi.spyOn(commands, "machineReachability").mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const ambient = probeMachine("m1");
    expect(useMachineHealthStore.getState().probing).toEqual({ m1: true });
    // A forced click on top is deduped — and the mirror still says a check is out.
    await probeMachine("m1", true);
    expect(useMachineHealthStore.getState().probing).toEqual({ m1: true });
    answer({ status: "ok", data: { reachable: true, reason: null } });
    await ambient;
    expect(useMachineHealthStore.getState().probing).toEqual({});
    expect(useMachineHealthStore.getState().byMachine.m1?.reachable).toBe(true);
  });

  it("is cleared when the probe command fails", async () => {
    vi.spyOn(commands, "machineReachability").mockRejectedValue(new Error("ipc down"));
    await probeMachine("m1", true);
    expect(useMachineHealthStore.getState().probing).toEqual({});
    expect(useMachineHealthStore.getState().byMachine.m1?.probeError).toBe("ipc down");
  });
});
