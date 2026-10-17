import { describe, expect, it } from "vitest";
import type { RemoteLinkState } from "../ipc/client";
import { fmtWait, remoteLinkFailure, remoteLinkView } from "./remoteLink";

const NOW = new Date(2026, 9, 17, 10, 30, 0).getTime();
const link = (over: Partial<RemoteLinkState> = {}): RemoteLinkState => ({
  kind: "reconnecting",
  attempt: 1,
  since_ms: new Date(2026, 9, 17, 10, 2, 0).getTime(),
  retry_at_ms: null,
  slowed: false,
  ...over,
});

describe("remoteLinkView", () => {
  it("is null for a link that is not down — local, attached, or a session that ended", () => {
    expect(remoteLinkView(null, NOW)).toBeNull();
    expect(remoteLinkView(undefined, NOW)).toBeNull();
    expect(remoteLinkView(link(), NOW, { ended: true })).toBeNull();
  });

  it("spins only while an attempt is in flight", () => {
    const dialing = remoteLinkView(link({ attempt: 3 }), NOW, { server: "Target" })!;
    expect(dialing).toMatchObject({ phase: "dialing", active: true, canRetryNow: false, wait: null });
    expect(dialing.text).toBe("Reconnecting to Target… (attempt 3)");
    expect(dialing.short).toBe("Reconnecting… (attempt 3)");
    // The first reconnect dial needs no count.
    expect(remoteLinkView(link({ attempt: 1 }), NOW)!.text).toBe("Reconnecting to the server…");
  });

  it("counts a first connect's dials from one (its failures, plus the dial in flight)", () => {
    expect(remoteLinkView(link({ kind: "connecting", attempt: 0 }), NOW)!.text).toBe("Connecting to the server…");
    expect(remoteLinkView(link({ kind: "connecting", attempt: 2 }), NOW)!.short).toBe("Connecting… (attempt 3)");
  });

  it("says how long a wait lasts instead of pretending to retry, and offers to cut it short", () => {
    const v = remoteLinkView(link({ attempt: 2, retry_at_ms: NOW + 12_400 }), NOW, { server: "Target" })!;
    expect(v).toMatchObject({ phase: "waiting", active: false, canRetryNow: true, tickMs: 1000 });
    expect(v.text).toBe("Connection to Target lost — retrying in 13 s");
    expect(v.short).toBe("Link lost · retrying in 13 s");
    expect(v.word).toBe("Link lost");
  });

  it("names a first connect that cannot get through as such — nothing was lost", () => {
    const v = remoteLinkView(link({ kind: "connecting", attempt: 1, retry_at_ms: NOW + 3_000 }), NOW)!;
    expect(v.text).toBe("Can't reach the server — retrying in 3 s");
    expect(v.short).toBe("Can't connect · retrying in 3 s");
  });

  it("says a long outage's minutes-long wait is on purpose, since when, and ticks slowly", () => {
    const v = remoteLinkView(link({ attempt: 11, retry_at_ms: NOW + 4 * 60_000, slowed: true }), NOW, {
      server: "Target",
    })!;
    expect(v).toMatchObject({ phase: "slowed", active: false, canRetryNow: true, tickMs: 30_000 });
    expect(v.text).toBe("No connection to Target since 10:02 — next try in 4 min (spaced out to save battery)");
    expect(v.short).toBe("Unreachable since 10:02 · next try in 4 min");
    // The last two minutes count down by the second.
    expect(remoteLinkView(link({ retry_at_ms: NOW + 90_000, slowed: true }), NOW)!.tickMs).toBe(1000);
  });

  it("reads a due (or overdue, after sleep) retry as imminent, without a spinner", () => {
    const v = remoteLinkView(link({ retry_at_ms: NOW - 60_000 }), NOW)!;
    expect(v).toMatchObject({ phase: "due", active: false, canRetryNow: true });
    expect(v.text).toBe("Connection to the server lost — retrying now");
  });

  it("puts this Mac being offline above the backoff — the server is not to blame", () => {
    const v = remoteLinkView(link({ retry_at_ms: NOW + 5_000 }), NOW, { server: "Target", online: false })!;
    expect(v).toMatchObject({ phase: "offline", active: false, canRetryNow: false, tickMs: null });
    expect(v.text).toBe("This Mac is offline — it reconnects to Target as soon as the network is back");
    expect(v.word).toBe("Offline");
  });
});

describe("fmtWait", () => {
  it("rounds up, so a wait never reads shorter than it is", () => {
    expect(fmtWait(0)).toBe("1 s");
    expect(fmtWait(59_001)).toBe("1 min");
    expect(fmtWait(4 * 60_000 + 1)).toBe("5 min");
    expect(fmtWait(65 * 60_000)).toBe("1 h 5 min");
    expect(fmtWait(120 * 60_000)).toBe("2 h");
  });
});

describe("remoteLinkFailure", () => {
  it("is the core's own sentence once the last session gave up on the link", () => {
    expect(
      remoteLinkFailure({ ended: true, end_reason: "link_failed", end_detail: "This Mac's saved key was refused." }),
    ).toBe("This Mac's saved key was refused.");
    expect(remoteLinkFailure({ ended: true, end_reason: "link_failed", end_detail: null })).toBe(
      "The link to the server failed and was not retried.",
    );
  });

  it("is nothing for any other end, or a live session — those streams really are just off", () => {
    expect(remoteLinkFailure({ ended: true, end_reason: "detached", end_detail: null })).toBeNull();
    expect(remoteLinkFailure({ ended: true, end_reason: "exited", end_detail: null })).toBeNull();
    expect(remoteLinkFailure({ ended: false, end_reason: null, end_detail: null })).toBeNull();
    expect(remoteLinkFailure(undefined)).toBeNull();
  });
});
