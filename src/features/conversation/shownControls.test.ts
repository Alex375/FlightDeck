import { describe, expect, it } from "vitest";
import type { SessionStatePayload } from "../../ipc/client";
import { bypassBlockedReason } from "../../store/permissions";
import {
  sessionAllowsBypass,
  shownControls,
  shownPermissionMode,
  type RecordedControls,
} from "./shownControls";

const defaults = { model: () => "opus", effort: () => "xhigh" as const };

/** The neutral placeholder every loaded conversation gets before its process runs. */
const placeholder: SessionStatePayload = {
  busy: false,
  session_id: null,
  cwd: null,
  model: null,
  permission_mode: null,
  output_style: null,
  effort: null,
  ultracode: false,
  ultracode_available: null,
  activity: null,
  awaiting_permission: false,
  retry: null,
  link: null,
  ended: false,
  context_tokens: null,
  context_window: null,
  context_usage: null,
  rate_limit: null,
};

const rec = (over: Partial<RecordedControls> = {}): RecordedControls => ({
  model: "fable",
  effort: "xhigh",
  ultracode: true,
  kind: "claude",
  live: false,
  ...over,
});

describe("shownControls", () => {
  // Armand's report: Ultracode picked on a conversation that wasn't running yet — the
  // placeholder's `ultracode: false` hid the record, so the gauge lost it.
  it("shows the recorded Ultracode on a conversation with no live process", () => {
    const shown = shownControls(placeholder, rec({ effort: "high" }), defaults);
    expect(shown.ultracode).toBe(true);
    expect(shown.effort).toBe("high"); // independent: Ultracode no longer means xhigh
    expect(shown.ultracodeAvailable).toBe(true);
    expect(shown.model).toBe("fable");
  });

  it("follows the live session while its process runs", () => {
    const live = { ...placeholder, model: "claude-opus-5-5", effort: "high", ultracode: false };
    const shown = shownControls(live, rec({ live: true }), defaults);
    expect(shown.model).toBe("claude-opus-5-5");
    expect(shown.effort).toBe("high");
    expect(shown.ultracode).toBe(false);
  });

  it("falls back to the record for a field the live session doesn't know yet", () => {
    const shown = shownControls(placeholder, rec({ live: true, ultracode: false, effort: "max" }), defaults);
    expect(shown.model).toBe("fable");
    expect(shown.effort).toBe("max");
  });

  // The last state of an exited process must not hide a pick made since.
  it("ignores the state of a process that has ended", () => {
    const ended = { ...placeholder, ended: true, model: "claude-opus-5-5", effort: "low" };
    const shown = shownControls(ended, rec({ live: true, ultracode: false }), defaults);
    expect(shown.model).toBe("fable");
    expect(shown.effort).toBe("xhigh");
  });

  it("uses the product defaults when neither source knows", () => {
    const shown = shownControls(undefined, rec({ model: null, effort: null, ultracode: false }), defaults);
    expect(shown.model).toBe("opus");
    expect(shown.effort).toBe("xhigh");
  });

  it("disables Ultracode on a model that can't run it, saying which", () => {
    const shown = shownControls(undefined, rec({ model: "haiku" }), defaults);
    expect(shown.ultracode).toBe(false); // a recorded request it can't run isn't shown as on
    expect(shown.ultracodeAvailable).toBe(false);
    expect(shown.ultracodeUnavailableReason).toMatch(/Haiku/);
  });

  // The CLI's other gate: workflows turned off. Only the live read-back knows it.
  it("trusts the live availability over the model, and blames workflows", () => {
    const live = { ...placeholder, model: "claude-opus-5-5", effort: "high", ultracode_available: false };
    const shown = shownControls(live, rec({ live: true }), defaults);
    expect(shown.ultracodeAvailable).toBe(false);
    expect(shown.ultracodeUnavailableReason).toMatch(/workflows/);
  });

  it("never offers Ultracode on Codex", () => {
    const shown = shownControls(undefined, rec({ kind: "codex", model: "gpt-5.5" }), defaults);
    expect(shown.ultracode).toBe(false);
    expect(shown.ultracodeAvailable).toBe(false);
    expect(shown.ultracodeUnavailableReason).toBeNull();
  });
});

describe("shownPermissionMode", () => {
  const running = (mode: string | null) => ({ ...placeholder, permission_mode: mode });

  // The remote bug: the composer said "Auto mode" while the process it re-joined (a
  // phone's) ran in bypass. While a process runs, ITS reported mode is what shows.
  it("shows the mode the running process reports, whatever the record says", () => {
    for (const mode of ["auto", "default", "acceptEdits", "plan", "bypassPermissions"]) {
      expect(shownPermissionMode(running(mode), true, "auto", false, "auto")).toBe(mode);
    }
  });

  it("shows the mode the next spawn will start in when nothing runs", () => {
    expect(shownPermissionMode(undefined, false, "plan", false, "auto")).toBe("plan");
    expect(shownPermissionMode(undefined, false, null, false, "auto")).toBe("auto");
    // A process not yet reporting: same.
    expect(shownPermissionMode(running(null), true, "acceptEdits", false, "auto")).toBe("acceptEdits");
  });

  // The spawn demotes bypass without the opt-in (`permission_mode_for_spawn`): the
  // composer must not promise a bypass the next process won't run.
  it("gates a recorded bypass by the opt-in, like the spawn does", () => {
    expect(shownPermissionMode(undefined, false, "bypassPermissions", false, "auto")).toBe("default");
    expect(shownPermissionMode(undefined, false, "bypassPermissions", true, "auto")).toBe("bypassPermissions");
  });

  // The last word of an exited process must not hide what will run next.
  it("ignores the mode of a process that has ended", () => {
    const ended = { ...running("plan"), ended: true };
    expect(shownPermissionMode(ended, true, "auto", false, "auto")).toBe("auto");
    expect(shownPermissionMode(running("plan"), false, "auto", false, "auto")).toBe("auto");
  });
});

describe("sessionAllowsBypass", () => {
  const withBypass = (v: boolean | null) => ({ ...placeholder, bypass_available: v });

  it("trusts what is known of THIS process over the spawn-time opt-in", () => {
    // A remote process this Mac did not start (a phone's): the daemon says it can't.
    expect(sessionAllowsBypass(withBypass(false), true, true)).toBe(false);
    // One that runs in bypass already can.
    expect(sessionAllowsBypass(withBypass(true), true, false)).toBe(true);
  });

  it("falls back to the opt-in the process was spawned with when unknown", () => {
    expect(sessionAllowsBypass(withBypass(null), true, true)).toBe(true);
    expect(sessionAllowsBypass(placeholder, true, false)).toBe(false); // older daemon: no field
    expect(sessionAllowsBypass(undefined, false, true)).toBe(true);
  });

  // End to end with the menu's reason: opt-in on, but the re-joined process can't run
  // bypass → the composer says to restart, instead of offering a pick the CLI refuses.
  it("makes the bypass menu say why on a process that can't run it", () => {
    expect(bypassBlockedReason(true, true, sessionAllowsBypass(withBypass(false), true, true))).toMatch(/[Rr]estart/);
    expect(bypassBlockedReason(true, true, sessionAllowsBypass(withBypass(true), true, false))).toBeNull();
    expect(bypassBlockedReason(false, true, sessionAllowsBypass(withBypass(true), true, true))).toMatch(/Settings/);
  });
});
