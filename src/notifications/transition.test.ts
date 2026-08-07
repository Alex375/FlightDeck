import { describe, it, expect } from "vitest";
import { SETTLE_MS, agentEventFor, isNoOpTurn, stillWarranted } from "./transition";
import type { SessionStatePayload } from "../ipc/client";
import type { TurnResultMeta } from "../store/types";

const base: SessionStatePayload = {
  busy: false,
  session_id: null,
  cwd: null,
  model: null,
  permission_mode: null,
  effort: null,
  ultracode: false,
  activity: null,
  awaiting_permission: false,
    retry: null,
  ended: false,
  context_tokens: null,
  context_window: null,
  rate_limit: null,
};
const s = (o: Partial<SessionStatePayload>): SessionStatePayload => ({ ...base, ...o });

describe("agentEventFor", () => {
  it("no event for two identical idle states", () => {
    expect(agentEventFor(s({}), s({}))).toBeNull();
  });

  it("attention when awaiting_permission goes false→true", () => {
    expect(agentEventFor(s({ busy: true }), s({ busy: true, awaiting_permission: true }))).toBe(
      "attention",
    );
  });

  it("done when busy goes true→false while alive, idle, not awaiting", () => {
    expect(agentEventFor(s({ busy: true }), s({ busy: false }))).toBe("done");
  });

  it("no done when the next state is ended (process exit/crash)", () => {
    expect(agentEventFor(s({ busy: true }), s({ busy: false, ended: true }))).toBeNull();
  });

  it("entering a permission wait (busy→false AND awaiting→true) is attention, not done", () => {
    expect(agentEventFor(s({ busy: true }), s({ busy: false, awaiting_permission: true }))).toBe(
      "attention",
    );
  });

  it("no event on turn start (busy false→true)", () => {
    expect(agentEventFor(s({ busy: false }), s({ busy: true }))).toBeNull();
  });

  it("no re-fire while awaiting_permission stays true", () => {
    const a = s({ awaiting_permission: true,
    retry: null, busy: true });
    expect(agentEventFor(a, a)).toBeNull();
  });

  it("no event at boot (neutral connecting state → first populated idle state)", () => {
    expect(agentEventFor(s({}), s({ session_id: "abc", model: "opus" }))).toBeNull();
  });

  it("granting a permission (awaiting true→false, busy stays true) fires nothing", () => {
    expect(
      agentEventFor(
        s({ awaiting_permission: true,
    retry: null, busy: true }),
        s({ awaiting_permission: false,
    retry: null, busy: true }),
      ),
    ).toBeNull();
  });

  it("a duplicated (at-least-once) done state yields null — prev already idle", () => {
    expect(agentEventFor(s({ busy: false }), s({ busy: false }))).toBeNull();
  });
});

describe("stillWarranted — done", () => {
  it("holds while the conversation is genuinely at rest", () => {
    expect(stillWarranted("done", s({ busy: false }))).toBe(true);
  });

  // The regression this whole settle window exists for: the CLI hands control back
  // with a `result`, then takes it straight back for a queued message / a
  // <task-notification> / a cron wake-up / an unmet /goal. Chiming "finished" there
  // announced the end of a turn the user could see was still going.
  it("drops once the CLI has resumed — activity comes back BEFORE busy does", () => {
    expect(stillWarranted("done", s({ busy: false, activity: "requesting" }))).toBe(false);
  });

  it("drops once the next turn is actually streaming", () => {
    expect(stillWarranted("done", s({ busy: true }))).toBe(false);
  });

  it("drops when a permission prompt went up during the window", () => {
    expect(stillWarranted("done", s({ busy: false, awaiting_permission: true }))).toBe(false);
  });

  it("drops when the process died during the window — a crash is not a completion", () => {
    expect(stillWarranted("done", s({ busy: false, ended: true }))).toBe(false);
  });
});

describe("stillWarranted — attention", () => {
  it("holds while the prompt is still up", () => {
    expect(stillWarranted("attention", s({ awaiting_permission: true, busy: true }))).toBe(true);
  });

  // The CLI withdraws a prompt it just raised (control_cancel_request): the card is
  // gone, so the chime announcing it must go too.
  it("drops when the prompt was withdrawn or answered", () => {
    expect(stillWarranted("attention", s({ awaiting_permission: false, busy: true }))).toBe(false);
  });

  it("drops when the process died", () => {
    expect(stillWarranted("attention", s({ awaiting_permission: true, ended: true }))).toBe(false);
  });

  it("a still-busy conversation does not disqualify an attention (unlike done)", () => {
    const blocked = s({ awaiting_permission: true, busy: true, activity: "requesting" });
    expect(stillWarranted("attention", blocked)).toBe(true);
    expect(stillWarranted("done", blocked)).toBe(false);
  });
});

describe("SETTLE_MS", () => {
  it("holds a finish back longer than a blocking ask", () => {
    expect(SETTLE_MS.done).toBeGreaterThan(SETTLE_MS.attention);
  });
});

describe("isNoOpTurn", () => {
  const meta = (numTurns: number | null): TurnResultMeta => ({
    subtype: "success",
    isError: false,
    result: null,
    apiErrorStatus: null,
    totalCostUsd: null,
    numTurns,
    durationMs: null,
    durationApiMs: null,
    ttftMs: null,
  });

  // A local slash command (/status, /goal clear, an unknown command) is answered by
  // the CLI itself and still emits a full success `result` with num_turns:0.
  it("flags a turn that never queried the model", () => {
    expect(isNoOpTurn(meta(0))).toBe(true);
  });

  it("does not flag a real turn", () => {
    expect(isNoOpTurn(meta(1))).toBe(false);
    expect(isNoOpTurn(meta(5))).toBe(false);
  });

  // Fail-safe: an unknown count must never be the reason a real completion goes
  // unheard (Codex reports no such breakdown, and the field can simply be absent).
  it("treats an unknown count as real work", () => {
    expect(isNoOpTurn(meta(null))).toBe(false);
    expect(isNoOpTurn(null)).toBe(false);
    expect(isNoOpTurn(undefined)).toBe(false);
  });
});
