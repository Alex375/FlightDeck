// The plan-usage wording shared by the context popover and the side panel's Plan usage widget.
// Lifted out of ui/kit.tsx with its behaviour unchanged — these pin that behaviour, boundaries
// first, so the next surface to reuse it cannot drift from the popover.

import { describe, expect, it } from "vitest";
import {
  accountWindowLabel,
  fmtAgo,
  fmtReset,
  resetToEpochSeconds,
  scopedUsageLabel,
} from "./planUsageFormat";

const NOW = 1_800_000_000; // epoch seconds

describe("fmtReset", () => {
  it("reads an unknown reset as an em dash, never a fake time", () => {
    expect(fmtReset(null, NOW)).toBe("—");
    expect(fmtReset(0, NOW)).toBe("—");
  });

  it("says « imminent » once the reset has passed", () => {
    expect(fmtReset(NOW, NOW)).toBe("imminent");
    expect(fmtReset(NOW - 90, NOW)).toBe("imminent");
  });

  it("counts minutes under an hour", () => {
    expect(fmtReset(NOW + 59, NOW)).toBe("in 0min");
    expect(fmtReset(NOW + 43 * 60 + 20, NOW)).toBe("in 43min");
  });

  it("counts hours and zero-padded minutes under a day", () => {
    expect(fmtReset(NOW + 2 * 3600 + 14 * 60, NOW)).toBe("in 2h14");
    expect(fmtReset(NOW + 3600 + 5 * 60, NOW)).toBe("in 1h05");
    expect(fmtReset(NOW + 24 * 3600 - 1, NOW)).toBe("in 23h59");
  });

  it("switches to days + hours at exactly 24 h", () => {
    expect(fmtReset(NOW + 24 * 3600, NOW)).toBe("in 1d");
    expect(fmtReset(NOW + 3 * 86400 + 4 * 3600 + 30 * 60, NOW)).toBe("in 3d 4h");
  });
});

describe("resetToEpochSeconds", () => {
  it("reads a digits-only value as SECONDS (the Codex push / legacy shape)", () => {
    expect(resetToEpochSeconds("1800000000")).toBe(1_800_000_000);
  });

  it("parses ISO 8601 (the live Claude endpoint)", () => {
    expect(resetToEpochSeconds("2027-01-15T08:00:00Z")).toBe(
      Math.floor(Date.UTC(2027, 0, 15, 8) / 1000),
    );
    expect(resetToEpochSeconds("2027-01-15T08:00:00.999+00:00")).toBe(
      Math.floor(Date.UTC(2027, 0, 15, 8) / 1000),
    );
  });

  it("gives null for an absent or unparseable value", () => {
    expect(resetToEpochSeconds(null)).toBeNull();
    expect(resetToEpochSeconds("")).toBeNull();
    expect(resetToEpochSeconds("soon")).toBeNull();
  });
});

describe("fmtAgo", () => {
  const T = 1_800_000_000_000; // ms

  it("hides the line for a figure never fetched — TanStack's 0 as much as null", () => {
    expect(fmtAgo(0, T)).toBeNull();
    expect(fmtAgo(null, T)).toBeNull();
    expect(fmtAgo(undefined, T)).toBeNull();
  });

  it("reads under 30 s as « just now », then under a minute as less than one", () => {
    expect(fmtAgo(T - 29_000, T)).toBe("just now");
    expect(fmtAgo(T - 45_000, T)).toBe("less than 1 min ago");
  });

  it("counts minutes, hours, then days", () => {
    expect(fmtAgo(T - 3 * 60_000, T)).toBe("3 min ago");
    expect(fmtAgo(T - 59 * 60_000, T)).toBe("59 min ago");
    expect(fmtAgo(T - 2 * 3_600_000, T)).toBe("2 h ago");
    expect(fmtAgo(T - 26 * 3_600_000, T)).toBe("1 d ago");
  });
});

describe("window labels", () => {
  it("keeps the popover's terse labels by default", () => {
    expect(accountWindowLabel("five_hour")).toBe("5h");
    expect(accountWindowLabel("seven_day")).toBe("7d");
    expect(scopedUsageLabel({ label: "Fable", group: "weekly" })).toBe("Fable · 7d");
    expect(scopedUsageLabel({ label: "Fable", group: "session" })).toBe("Fable · 5h");
  });

  it("spells them out for the panel", () => {
    expect(accountWindowLabel("five_hour", "long")).toBe("5-hour");
    expect(accountWindowLabel("seven_day", "long")).toBe("Weekly");
    expect(scopedUsageLabel({ label: "Fable", group: "weekly" }, "long")).toBe("Fable · weekly");
    expect(scopedUsageLabel({ label: "Fable", group: "session" }, "long")).toBe("Fable · 5-hour");
  });

  it("never guesses a duration it was not given", () => {
    expect(scopedUsageLabel({ label: "Fable", group: null })).toBe("Fable");
    expect(scopedUsageLabel({ label: "Fable", group: "monthly" }, "long")).toBe("Fable");
  });
});
