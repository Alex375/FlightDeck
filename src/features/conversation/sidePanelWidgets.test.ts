import { describe, expect, it } from "vitest";
import {
  applyPreset,
  defaultLayout,
  isCollapsed,
  matchingPreset,
  moveWidget,
  PANEL_PRESETS,
  sanitizeLayout,
  setCollapsed,
  setWidgetOn,
  WIDGETS,
} from "./sidePanelWidgets";

const ids = (entries: { id: string }[]) => entries.map((e) => e.id);
const onIds = (entries: { id: string; on: boolean }[]) => entries.filter((e) => e.on).map((e) => e.id);

describe("defaultLayout", () => {
  it("lists every widget once, in its zone, in catalogue order", () => {
    const l = defaultLayout();
    expect(ids(l.main)).toEqual(WIDGETS.filter((w) => w.zone === "main").map((w) => w.id));
    expect(ids(l.foot)).toEqual(["stream", "worktree", "machine"]);
    expect(l.collapsible).toBe(true);
    expect(l.collapsed).toEqual([]);
  });

  it("keeps the telemetry deck off unless it was switched on before it became a widget", () => {
    expect(defaultLayout().main.find((e) => e.id === "telemetry")?.on).toBe(false);
    expect(defaultLayout({ telemetry: true }).main.find((e) => e.id === "telemetry")?.on).toBe(true);
  });
});

describe("sanitizeLayout (a stored layout is repaired, never trusted)", () => {
  const fallback = defaultLayout();

  it("falls back on anything unreadable", () => {
    expect(sanitizeLayout(null, fallback)).toBe(fallback);
    expect(sanitizeLayout("nope", fallback)).toBe(fallback);
  });

  it("keeps the stored order and switches", () => {
    const stored = {
      ...fallback,
      main: [...fallback.main].reverse().map((e) => ({ ...e, on: e.id === "git" })),
    };
    const l = sanitizeLayout(JSON.parse(JSON.stringify(stored)), fallback);
    expect(ids(l.main)).toEqual(ids(stored.main));
    expect(onIds(l.main)).toEqual(["git"]);
  });

  it("drops unknown ids, duplicates and widgets stored in the wrong zone", () => {
    const l = sanitizeLayout(
      {
        main: [
          { id: "task", on: true },
          { id: "gone-widget", on: true },
          { id: "task", on: false },
          { id: "machine", on: true }, // a footer row stored among the sections
        ],
        foot: [],
      },
      fallback,
    );
    expect(ids(l.main).filter((id) => id === "task")).toHaveLength(1);
    expect(l.main.find((e) => e.id === "task")?.on).toBe(true);
    expect(ids(l.main)).not.toContain("gone-widget");
    expect(ids(l.main)).not.toContain("machine");
    expect(ids(l.foot)).toContain("machine");
  });

  it("brings a widget the store never heard of back at its default, next to its catalogue neighbours", () => {
    // Saved by a build that did not have "stats" yet, with the user's own order.
    const l = sanitizeLayout(
      {
        main: [
          { id: "context", on: true },
          { id: "task", on: true },
          { id: "linked", on: true },
        ],
      },
      fallback,
    );
    const order = ids(l.main);
    // "stats" follows "linked" in the catalogue, so it lands right after it.
    expect(order.indexOf("stats")).toBe(order.indexOf("linked") + 1);
    expect(l.main.find((e) => e.id === "stats")?.on).toBe(true);
    // Every widget is present exactly once.
    expect(new Set(order).size).toBe(WIDGETS.filter((w) => w.zone === "main").length);
  });

  it("keeps only folds of real sections", () => {
    const l = sanitizeLayout({ collapsed: ["todos", "stream", "bogus", "todos"] }, fallback);
    expect(l.collapsed).toEqual(["todos"]);
  });
});

describe("layout edits", () => {
  it("switches a widget without touching the others, and is a no-op when unchanged", () => {
    const l = defaultLayout();
    const off = setWidgetOn(l, "plan", false);
    expect(off.main.find((e) => e.id === "plan")?.on).toBe(false);
    expect(onIds(off.foot)).toEqual(onIds(l.foot));
    expect(setWidgetOn(off, "plan", false)).toBe(off);
  });

  it("moves within a zone like a drop, and refuses a move across zones", () => {
    const l = defaultLayout();
    const moved = moveWidget(l, "plan", "task");
    expect(ids(moved.main).indexOf("plan")).toBe(ids(l.main).indexOf("task"));
    expect(moveWidget(l, "machine", "task")).toBe(l);
    expect(moveWidget(l, "task", "task")).toBe(l);
    const foot = moveWidget(l, "machine", "stream");
    expect(ids(foot.foot)).toEqual(["machine", "stream", "worktree"]);
  });

  it("folds only while folding is switched on", () => {
    const folded = setCollapsed(defaultLayout(), "todos", true);
    expect(isCollapsed(folded, "todos")).toBe(true);
    expect(isCollapsed({ ...folded, collapsible: false }, "todos")).toBe(false);
    expect(isCollapsed(setCollapsed(folded, "todos", false), "todos")).toBe(false);
  });
});

describe("presets", () => {
  it("change visibility only, never the user's order", () => {
    const l = moveWidget(defaultLayout(), "plan", "task");
    const cockpit = PANEL_PRESETS.find((p) => p.id === "cockpit")!;
    const applied = applyPreset(l, cockpit);
    expect(ids(applied.main)).toEqual(ids(l.main));
    expect([...applied.main, ...applied.foot].every((e) => e.on)).toBe(true);
  });

  it("the default layout reads as the Standard preset, and a hand-made one as none", () => {
    expect(matchingPreset(defaultLayout())?.id).toBe("standard");
    const essentials = PANEL_PRESETS.find((p) => p.id === "essentials")!;
    expect(matchingPreset(applyPreset(defaultLayout(), essentials))?.id).toBe("essentials");
    expect(matchingPreset(setWidgetOn(defaultLayout(), "stats", false))).toBeNull();
  });
});
