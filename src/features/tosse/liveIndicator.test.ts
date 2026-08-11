import { describe, expect, it } from "vitest";
import { liveIndicatorView } from "./liveIndicator";
import type { TosseLiveStatus } from "../../ipc/client";

const status = (p: Partial<TosseLiveStatus>): TosseLiveStatus => ({
  state: "off",
  detail: null,
  attempts: 0,
  connections: 0,
  ...p,
});

describe("liveIndicatorView", () => {
  // The channel is only off when there is no session — and the view is already withdrawn
  // then, so the toolbar must not complain about a connection nobody asked for.
  it("shows nothing when the channel is off", () => {
    expect(liveIndicatorView(status({ state: "off" }))).toBeNull();
  });

  it("is green and quiet while live", () => {
    const v = liveIndicatorView(status({ state: "live" }));
    expect(v?.tone).toBe("on");
    expect(v?.label).toBe("Live");
    expect(v?.retry).toBe(false);
  });

  // A first connection and a recovery are both amber, but they do not say the same thing:
  // the second explains a delay the user may already have noticed.
  it("tells a first connection from a reconnection", () => {
    expect(liveIndicatorView(status({ state: "connecting" }))?.label).toBe("Connecting…");
    expect(liveIndicatorView(status({ state: "connecting", attempts: 2 }))?.label).toBe(
      "Reconnecting…",
    );
  });

  it("does not offer a manual retry while it is already retrying", () => {
    expect(liveIndicatorView(status({ state: "connecting", attempts: 2 }))?.retry).toBe(false);
  });

  it("goes red and offers a retry once the channel gave up", () => {
    const v = liveIndicatorView(status({ state: "error", attempts: 5 }));
    expect(v?.tone).toBe("err");
    expect(v?.retry).toBe(true);
  });

  // The point of the whole indicator: never let the view read as up to date when it isn't,
  // and never degrade without saying why.
  it("carries the core's reason into the hover text", () => {
    const v = liveIndicatorView(
      status({ state: "error", detail: "TOSSE is unreachable: dns error", attempts: 3 }),
    );
    expect(v?.title).toContain("TOSSE is unreachable: dns error");
    // …and still says what the user can do meanwhile.
    expect(v?.title).toContain("Refresh");
  });

  it("says what still works when there is no reason to give", () => {
    const v = liveIndicatorView(status({ state: "error", attempts: 3 }));
    expect(v?.title).toContain("focus the window");
  });
});
