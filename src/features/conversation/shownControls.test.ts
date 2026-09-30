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
  // Armand's report: Ultra code picked on a conversation that wasn't running yet — the
  // placeholder's `ultracode: false` hid the record, so the gauge fell back to Extra.
  it("shows the recorded Ultra code on a conversation with no live process", () => {
    const shown = shownControls(placeholder, rec(), defaults);
    expect(shown.gauge).toBe("ultracode");
    expect(shown.model).toBe("fable");
  });

  it("follows the live session while its process runs", () => {
    const live = { ...placeholder, model: "claude-opus-5-5", effort: "high", ultracode: false };
    const shown = shownControls(live, rec({ live: true }), defaults);
    expect(shown.model).toBe("claude-opus-5-5");
    expect(shown.gauge).toBe("high");
  });

  it("falls back to the record for a field the live session doesn't know yet", () => {
    const shown = shownControls(placeholder, rec({ live: true, ultracode: false, effort: "max" }), defaults);
    expect(shown.model).toBe("fable");
    expect(shown.gauge).toBe("max");
  });

  // The last state of an exited process must not hide a pick made since.
  it("ignores the state of a process that has ended", () => {
    const ended = { ...placeholder, ended: true, model: "claude-opus-5-5", effort: "low" };
    const shown = shownControls(ended, rec({ live: true, ultracode: false }), defaults);
    expect(shown.model).toBe("fable");
    expect(shown.gauge).toBe("xhigh");
  });

  it("uses the product defaults when neither source knows", () => {
    const shown = shownControls(undefined, rec({ model: null, effort: null, ultracode: false }), defaults);
    expect(shown.model).toBe("opus");
    expect(shown.gauge).toBe("xhigh");
  });
});
