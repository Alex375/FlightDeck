import { describe, it, expect } from "vitest";
import { agentEventFor } from "./transition";
import type { SessionStatePayload } from "../ipc/client";

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
