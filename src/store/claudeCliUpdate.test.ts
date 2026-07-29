import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary: controllable status reads + auto-update writes. Same pattern as
// commandsStore.test / reminderSync.test.
vi.mock("../ipc/client", () => ({
  commands: { claudeCliStatus: vi.fn(), setClaudeCliAutoUpdate: vi.fn() },
}));

import { commands } from "../ipc/client";
import { shouldShowClaudeCliBanner, useClaudeCliUpdate } from "./claudeCliUpdate";
import { isUpdateBannerVisible, type AvailableUpdate } from "./updater";
import type { ClaudeCliStatus } from "../ipc/bindings";

const claudeCliStatus = commands.claudeCliStatus as unknown as ReturnType<typeof vi.fn>;
const setClaudeCliAutoUpdate =
  commands.setClaudeCliAutoUpdate as unknown as ReturnType<typeof vi.fn>;

const base: ClaudeCliStatus = {
  installed_version: "2.1.218",
  latest_version: "2.1.220",
  update_available: true,
  auto_update_enabled: true,
  auto_update_locked: false,
  install_method: "native",
  channel: "latest",
  config_warning: null,
};

describe("shouldShowClaudeCliBanner", () => {
  it("shows when an update is available and not dismissed", () => {
    expect(shouldShowClaudeCliBanner(base, null)).toBe(true);
  });

  it("hides once the current latest version is dismissed", () => {
    expect(shouldShowClaudeCliBanner(base, "2.1.220")).toBe(false);
  });

  it("re-shows for a version newer than the dismissed one (per-version dismissal)", () => {
    const newer = { ...base, latest_version: "2.1.221" };
    expect(shouldShowClaudeCliBanner(newer, "2.1.220")).toBe(true);
  });

  it("hides when no update is available", () => {
    expect(shouldShowClaudeCliBanner({ ...base, update_available: false }, null)).toBe(false);
  });

  it("hides when status is null or the latest version is unknown", () => {
    expect(shouldShowClaudeCliBanner(null, null)).toBe(false);
    expect(shouldShowClaudeCliBanner({ ...base, latest_version: null }, null)).toBe(false);
  });
});

// One top-of-window strip at a time: the CLI banner reads this predicate and stands down while
// the APP's banner is up (updating the app restarts it, so it outranks a CLI binary swap).
describe("isUpdateBannerVisible — the app banner's claim on the slot", () => {
  const update: AvailableUpdate = { version: "1.5.0", currentVersion: "1.4.0" };

  it("claims the slot while an update is available, downloading or installing", () => {
    for (const s of ["available", "downloading", "installing"] as const) {
      expect(isUpdateBannerVisible(s, update)).toBe(true);
    }
  });

  it("holds the slot through a re-check that still has the update in hand (no blink)", () => {
    // The 2h re-check flips the status to `checking` without retracting the offer. Releasing the
    // slot there made the app banner blink and the CLI banner flash into the gap.
    expect(isUpdateBannerVisible("checking", update)).toBe(true);
  });

  it("releases the slot when there is no update to show", () => {
    for (const s of ["idle", "uptodate", "error"] as const) {
      expect(isUpdateBannerVisible(s, update)).toBe(false);
    }
    // …and never claims it without an update object, whatever the status says — including the
    // ordinary "checking with nothing found yet".
    expect(isUpdateBannerVisible("available", null)).toBe(false);
    expect(isUpdateBannerVisible("checking", null)).toBe(false);
  });
});

describe("setAutoUpdate — the optimistic revert must not clobber a fresher read", () => {
  beforeEach(() => {
    useClaudeCliUpdate.setState({
      status: { ...base, installed_version: "2.1.218", auto_update_enabled: true },
      loading: false,
      updating: false,
      error: null,
      toggleError: null,
    });
    claudeCliStatus.mockReset();
    setClaudeCliAutoUpdate.mockReset();
  });

  it("undoes only its own field when a refresh landed mid-write", async () => {
    // A periodic refresh lands while the write is in flight and brings a NEWER installed
    // version. Reverting the whole pre-write snapshot would put the stale version back on
    // screen as a side effect of a failed switch.
    setClaudeCliAutoUpdate.mockImplementation(async () => {
      useClaudeCliUpdate.setState({
        status: { ...useClaudeCliUpdate.getState().status!, installed_version: "2.1.220" },
      });
      return { status: "error", error: "write failed" };
    });

    await useClaudeCliUpdate.getState().setAutoUpdate(false);

    const after = useClaudeCliUpdate.getState().status;
    expect(after?.auto_update_enabled).toBe(true); // our optimistic flip is undone…
    expect(after?.installed_version).toBe("2.1.220"); // …the concurrent read survives
  });
});

describe("setAutoUpdate — the switch must never lie about what the CLI will do", () => {
  beforeEach(() => {
    useClaudeCliUpdate.setState({
      status: { ...base, auto_update_enabled: false, auto_update_locked: true },
      loading: false,
      updating: false,
      error: null,
      toggleError: null,
    });
    claudeCliStatus.mockReset();
    setClaudeCliAutoUpdate.mockReset();
  });

  it("adopts the DISK truth after a successful write, not the optimistic value", async () => {
    // The write succeeds (it does clear DISABLE_AUTOUPDATER) but the OTHER gate — `autoUpdates:false`
    // in ~/.claude.json, which we never write — still holds auto-update off. Without the re-read the
    // switch would sit there looking ON while the CLI stays OFF.
    setClaudeCliAutoUpdate.mockResolvedValue({ status: "ok", data: null });
    claudeCliStatus.mockResolvedValue({ ...base, auto_update_enabled: false, auto_update_locked: true });

    await useClaudeCliUpdate.getState().setAutoUpdate(true);

    expect(setClaudeCliAutoUpdate).toHaveBeenCalledWith(true);
    expect(claudeCliStatus).toHaveBeenCalledTimes(1);
    expect(useClaudeCliUpdate.getState().status?.auto_update_enabled).toBe(false);
    expect(useClaudeCliUpdate.getState().toggleError).toBeNull();
  });

  it("re-reads even when another read is already in flight (queued, never skipped)", async () => {
    // A busy-guard would drop this read and strand the optimistic value. The reads are serialized,
    // so the post-write one still runs — and runs LAST, so its answer is the one that stands.
    // The deferred is built UP FRONT: the read only starts on a microtask, so capturing its
    // resolver from inside mockImplementationOnce would still be unset when we release it.
    let releaseFirst: (v: ClaudeCliStatus) => void = () => {};
    const firstRead = new Promise<ClaudeCliStatus>((r) => {
      releaseFirst = r;
    });
    claudeCliStatus
      .mockImplementationOnce(() => firstRead)
      .mockResolvedValue({ ...base, auto_update_enabled: false, auto_update_locked: true });
    setClaudeCliAutoUpdate.mockResolvedValue({ status: "ok", data: null });

    const inFlight = useClaudeCliUpdate.getState().refresh(); // starts and blocks
    const write = useClaudeCliUpdate.getState().setAutoUpdate(true);
    releaseFirst({ ...base, auto_update_enabled: true, auto_update_locked: false });
    await Promise.all([inFlight, write]);

    expect(claudeCliStatus).toHaveBeenCalledTimes(2);
    expect(useClaudeCliUpdate.getState().status?.auto_update_enabled).toBe(false);
    expect(useClaudeCliUpdate.getState().loading).toBe(false);
  });

  it("says so when the write took but the read-back failed (no unconfirmed value passing for settled)", async () => {
    // The re-read is the ONLY thing that turns "written" into "actually took". If it fails, the
    // switch is showing an unverified optimistic value — the user must be told, not left with a
    // confident-looking toggle.
    setClaudeCliAutoUpdate.mockResolvedValue({ status: "ok", data: null });
    claudeCliStatus.mockRejectedValue(new Error("ipc down"));

    await useClaudeCliUpdate.getState().setAutoUpdate(true);

    expect(useClaudeCliUpdate.getState().toggleError).toMatch(/could not be read back/i);
    expect(useClaudeCliUpdate.getState().error).toBeNull();
    expect(useClaudeCliUpdate.getState().loading).toBe(false);
  });

  it("reverts and reports a failed write in toggleError — never in the banner's `error`", async () => {
    // `error` drives the banner, whose retry button runs `claude update`. A failed SWITCH must not
    // render there as "Update failed" next to a retry that would run something else entirely.
    setClaudeCliAutoUpdate.mockResolvedValue({ status: "error", error: "settings.json unreadable" });
    const before = useClaudeCliUpdate.getState().status;

    await useClaudeCliUpdate.getState().setAutoUpdate(true);

    expect(useClaudeCliUpdate.getState().status).toEqual(before);
    expect(useClaudeCliUpdate.getState().toggleError).toBe("settings.json unreadable");
    expect(useClaudeCliUpdate.getState().error).toBeNull();
    expect(claudeCliStatus).not.toHaveBeenCalled();
  });

  it("reverts and reports a THROWN ipc rejection too (never vanishes)", async () => {
    setClaudeCliAutoUpdate.mockRejectedValue(new Error("ipc down"));
    const before = useClaudeCliUpdate.getState().status;

    await useClaudeCliUpdate.getState().setAutoUpdate(true);

    expect(useClaudeCliUpdate.getState().status).toEqual(before);
    expect(useClaudeCliUpdate.getState().toggleError).toBe("ipc down");
    expect(useClaudeCliUpdate.getState().error).toBeNull();
  });
});
