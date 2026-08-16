// Equipping a folder with the TOSSE plugin — and, above all, what it says when it could
// not.
//
// The whole point of this module is that a conversation opening WITHOUT the skills must
// never look like one that got them. So these tests are less about the happy path (one
// write, then quiet) than about the four ways it can fall short, and the fact that each of
// them still reaches the user.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/client", () => ({
  commands: { listExtensions: vi.fn(), setPluginEnabled: vi.fn() },
}));
vi.mock("../../store/commandsStore", () => ({ refetchSlashCommands: vi.fn(async () => {}) }));
vi.mock("./taskPrompts", () => ({ pickupCommandName: vi.fn(() => "tosse-workflow:pickup") }));

import { activationProblem, ensurePickupPlugin, findPickupPlugin } from "./pickupPlugin";
import { commands } from "../../ipc/client";
import { pickupCommandName } from "./taskPrompts";

const listExtensions = commands.listExtensions as unknown as ReturnType<typeof vi.fn>;
const setPluginEnabled = commands.setPluginEnabled as unknown as ReturnType<typeof vi.fn>;
const commandName = pickupCommandName as unknown as ReturnType<typeof vi.fn>;

/** A snapshot where `tosse-workflow` ships the pickup skill, on or off. `trusted: false`
 *  is the corrupt-`settings.json` case: the scan then reports EVERY plugin as enabled
 *  whatever the user set, so that `enabled` is an assumption, not a reading. */
function snapshot(enabled: boolean, trusted = true) {
  return {
    status: "ok" as const,
    data: {
      mcp_servers: [],
      plugins: [{ id: "tosse-workflow@tosse-plugins", name: "tosse-workflow", enabled }],
      skills: [{ name: "tosse-workflow:pickup", source: "tosse-workflow@tosse-plugins" }],
      agents: [],
      warnings: trusted ? [] : ["/home/x/.claude/settings.json corrupt: expected value"],
      plugin_state_trusted: trusted,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  commandName.mockReturnValue("tosse-workflow:pickup");
});

describe("findPickupPlugin", () => {
  // "We looked and found nothing" and "we could not look" lead to opposite conclusions, so
  // they must not share a return value: reporting a failed scan as a missing plugin would
  // tell the user to install something they already have.
  it("throws when the extensions cannot be read, rather than answering 'none installed'", async () => {
    listExtensions.mockResolvedValue({ status: "error", error: "config unreadable" });
    await expect(findPickupPlugin("/repo")).rejects.toThrow("config unreadable");
  });

  // Found by what it PROVIDES: a plugin under any name qualifies as long as it ships the
  // skill, which is what keeps this working when the plugin is renamed or forked.
  it("finds the provider by the skill it ships, disabled included", async () => {
    listExtensions.mockResolvedValue(snapshot(false));
    expect(await findPickupPlugin("/repo")).toEqual({
      id: "tosse-workflow@tosse-plugins",
      name: "tosse-workflow",
      enabled: false,
      enabledTrusted: true,
    });
  });

  // A corrupt `settings.json` makes the scan report every plugin as ON (it is the file that
  // holds `enabledPlugins`, and its absence means "no overrides"). Carrying that flag is
  // what keeps a fabricated `enabled: true` from reading like a state anyone chose.
  it("marks the enabled state untrusted when the settings file could not be read", async () => {
    listExtensions.mockResolvedValue(snapshot(true, false));
    expect(await findPickupPlugin("/repo")).toMatchObject({ enabled: true, enabledTrusted: false });
  });
});

describe("ensurePickupPlugin", () => {
  it("switches a dormant plugin on and reports the name the folder now publishes", async () => {
    listExtensions.mockResolvedValue(snapshot(false));
    setPluginEnabled.mockResolvedValue({ status: "ok", data: null });

    const got = await ensurePickupPlugin("/repo");

    expect(setPluginEnabled).toHaveBeenCalledWith("tosse-workflow@tosse-plugins", true);
    expect(got).toEqual({
      kind: "enabled",
      plugin: "tosse-workflow",
      pickup: "tosse-workflow:pickup",
    });
    // Nothing to say: this is the nominal path, and it is meant to be silent.
    expect(activationProblem(got)).toBeNull();
  });

  // The one write we make is in the user's own config — making it twice, on every launch,
  // would be a side effect nobody asked for.
  it("writes nothing when the plugin is already on", async () => {
    listExtensions.mockResolvedValue(snapshot(true));

    const got = await ensurePickupPlugin("/repo");

    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(got).toEqual({ kind: "present", plugin: "tosse-workflow" });
    expect(activationProblem(got)).toBeNull();
  });

  // ⚠️ The hole this closes: a corrupt `settings.json` reports the plugin as already on, so
  // the launch used to conclude "present", write nothing and say nothing — while the CLI
  // read the same broken file and spawned a conversation with no TOSSE skills at all. An
  // untrusted state is not acted on: the write is attempted, and the file that could not be
  // parsed makes it fail loudly rather than silently.
  it("does not take a fabricated 'already on' at face value", async () => {
    listExtensions.mockResolvedValue(snapshot(true, false));
    setPluginEnabled.mockResolvedValue({
      status: "error",
      error: "settings.json unreadable: expected value at line 3",
    });

    const got = await ensurePickupPlugin("/repo");

    expect(setPluginEnabled).toHaveBeenCalledWith("tosse-workflow@tosse-plugins", true);
    expect(got.kind).toBe("failed");
    expect(activationProblem(got)).toContain("settings.json unreadable");
  });

  // The dialog scans this folder before the button is even pressed. Handing that answer in
  // is what keeps ONE launch from reading the same config files twice.
  it("uses the caller's scan instead of running its own", async () => {
    const got = await ensurePickupPlugin("/repo", {
      id: "tosse-workflow@tosse-plugins",
      name: "tosse-workflow",
      enabled: true,
      enabledTrusted: true,
    });

    expect(listExtensions).not.toHaveBeenCalled();
    expect(got).toEqual({ kind: "present", plugin: "tosse-workflow" });
  });

  // `null` is an ANSWER ("we looked, nothing provides it"), not the absence of one — it must
  // not send the launch scanning again.
  it("accepts a caller's 'none installed' without rescanning", async () => {
    const got = await ensurePickupPlugin("/repo", null);

    expect(listExtensions).not.toHaveBeenCalled();
    expect(got).toEqual({ kind: "missing" });
  });

  it("reports a refused write instead of opening an unequipped conversation in silence", async () => {
    listExtensions.mockResolvedValue(snapshot(false));
    setPluginEnabled.mockResolvedValue({ status: "error", error: "settings.json is read-only" });

    const got = await ensurePickupPlugin("/repo");

    expect(got).toEqual({
      kind: "failed",
      plugin: "tosse-workflow",
      error: "settings.json is read-only",
    });
    expect(activationProblem(got)).toContain("settings.json is read-only");
  });

  // The write went through and the skill STILL is not advertised. Half a success is not a
  // success: said out loud, because "Start" would otherwise fall back to written
  // instructions with no explanation.
  it("says so when enabling worked but the skill is still not published", async () => {
    listExtensions.mockResolvedValue(snapshot(false));
    setPluginEnabled.mockResolvedValue({ status: "ok", data: null });
    commandName.mockReturnValue(null);

    const got = await ensurePickupPlugin("/repo");

    expect(got).toEqual({ kind: "enabled", plugin: "tosse-workflow", pickup: null });
    expect(activationProblem(got)).toContain("still does not offer");
  });

  it("concludes nothing from a scan that failed, and says that too", async () => {
    listExtensions.mockResolvedValue({ status: "error", error: "config unreadable" });

    const got = await ensurePickupPlugin("/repo");

    expect(got).toEqual({ kind: "unknown", error: "config unreadable" });
    expect(activationProblem(got)).toContain("config unreadable");
  });

  // Nothing installed provides the skill: there is nothing to switch on, and nothing to
  // report from the launch either — the dialog states that fact BEFORE launching.
  it("stays quiet when no plugin provides the skill", async () => {
    listExtensions.mockResolvedValue({
      status: "ok",
      data: { mcp_servers: [], plugins: [], skills: [], agents: [], warnings: [], plugin_state_trusted: true },
    });

    const got = await ensurePickupPlugin("/repo");

    expect(got).toEqual({ kind: "missing" });
    expect(setPluginEnabled).not.toHaveBeenCalled();
    expect(activationProblem(got)).toBeNull();
  });
});
