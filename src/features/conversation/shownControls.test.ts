import { describe, expect, it } from "vitest";
import type { SessionStatePayload } from "../../ipc/client";
import { shownControls, type RecordedControls } from "./shownControls";

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
