import { describe, expect, it } from "vitest";
import { clusterMarkers } from "./AccountsSection";

// The Switching band places every account at its busiest usage window. Two accounts a few
// points apart printed their labels on top of each other ("Work account · 14%" over
// "Account 3 · 14%" became unreadable), so close markers are merged into one.
describe("clusterMarkers", () => {
  it("keeps accounts that are far apart as separate markers", () => {
    const out = clusterMarkers([
      { key: "default", label: "Claude", pct: 67 },
      { key: "b", label: "Work", pct: 14 },
    ]);
    expect(out.map((m) => m.labels)).toEqual([["Work"], ["Claude"]]);
  });

  it("merges accounts at the same or a nearby percentage into one marker", () => {
    const out = clusterMarkers([
      { key: "b", label: "Work", pct: 14 },
      { key: "c", label: "Account 3", pct: 14 },
      { key: "d", label: "Side", pct: 20 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].labels).toEqual(["Work", "Account 3", "Side"]);
  });

  // The merged marker sits at its HIGHEST member: that is the account the auto-switch would
  // react to first, so the marker must never look safer than the busiest account in it.
  it("places a merged marker at its busiest account", () => {
    const [m] = clusterMarkers([
      { key: "b", label: "Work", pct: 80 },
      { key: "c", label: "Other", pct: 88 },
    ]);
    expect(m.pct).toBe(88);
  });

  // Chaining must not creep: a cluster is anchored at its first point, so 10 · 20 · 30 does
  // not collapse into one marker just because each step is within reach of the previous one.
  it("does not chain an unbounded run of accounts into one marker", () => {
    const out = clusterMarkers([
      { key: "a", label: "A", pct: 10 },
      { key: "b", label: "B", pct: 20 },
      { key: "c", label: "C", pct: 30 },
    ]);
    expect(out.map((m) => m.labels)).toEqual([["A", "B"], ["C"]]);
  });

  it("returns nothing for no measured account", () => {
    expect(clusterMarkers([])).toEqual([]);
  });
});
