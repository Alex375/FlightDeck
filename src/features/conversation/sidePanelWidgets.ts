// The conversation side panel as a set of WIDGETS the user chooses, orders and folds.
//
// This module is the catalogue and the layout arithmetic — pure, no React, no storage — so the
// rules are pinned by tests: which widgets exist, where they live (the scrolling sections or the
// rows pinned at the bottom), what shows by default, and how a stored layout written by an older
// or newer build is repaired rather than trusted (an unknown id is dropped, a missing one comes
// back at its default, a duplicate is kept once). The store (`store/sidePanelWidgetsStore.ts`) persists
// it; the panel renders it.
//
// ⚠️ A widget switched on is not a widget shown: most of them only appear when there is something
// to show (a task, a goal, a todo list…). Being ON means "show it when it has something".
// A widget switched OFF is not mounted at all — hidden must cost nothing.

/** Every widget the panel knows. */
export type WidgetId =
  | "telemetry"
  | "task"
  | "goal"
  | "todos"
  | "artifacts"
  | "linked"
  | "stats"
  | "context"
  | "git"
  | "plan"
  | "stream"
  | "worktree"
  | "machine";

/** Where a widget lives: the scrolling SECTIONS, or the compact ROWS pinned at the bottom. A
 *  widget never changes zone — a footer row and a section are drawn differently. */
export type WidgetZone = "main" | "foot";

export interface WidgetDef {
  id: WidgetId;
  zone: WidgetZone;
  title: string;
  /** One line for the customize view: what the widget shows. */
  blurb: string;
  /** A kit icon name (see `Ico`), for the section header and the customize card. */
  icon: string;
  /** Shown by a fresh layout. */
  defaultOn: boolean;
}

/** The catalogue, in DEFAULT order within each zone. */
export const WIDGETS: readonly WidgetDef[] = [
  {
    id: "telemetry",
    zone: "main",
    title: "Telemetry deck",
    blurb: "Gauges, clocks and live signals from the running agent",
    icon: "bolt",
    defaultOn: false,
  },
  {
    id: "task",
    zone: "main",
    title: "TOSSE task",
    blurb: "The CRM task this conversation carries",
    icon: "diamond",
    defaultOn: true,
  },
  {
    id: "goal",
    zone: "main",
    title: "Goal",
    blurb: "The active /goal and whether it was checked",
    icon: "target",
    defaultOn: true,
  },
  {
    id: "todos",
    zone: "main",
    title: "Todo",
    blurb: "The agent's todo list and its progress",
    icon: "list",
    defaultOn: true,
  },
  {
    id: "artifacts",
    zone: "main",
    title: "Artifacts",
    blurb: "Pages the agent published, with their versions",
    icon: "artifact",
    defaultOn: true,
  },
  {
    id: "linked",
    zone: "main",
    title: "Linked conversations",
    blurb: "Conversations this one messaged or created",
    icon: "link",
    defaultOn: true,
  },
  {
    id: "stats",
    zone: "main",
    title: "Stats",
    blurb: "Turn time, files touched, tool calls, total tokens",
    icon: "pulse",
    defaultOn: true,
  },
  {
    id: "context",
    zone: "main",
    title: "Context",
    blurb: "How full the context window is",
    icon: "gauge",
    defaultOn: true,
  },
  {
    id: "git",
    zone: "main",
    title: "Git status",
    blurb: "Uncommitted changes, ahead and behind",
    icon: "diff",
    defaultOn: true,
  },
  {
    id: "plan",
    zone: "main",
    title: "Plan usage",
    blurb: "Your plan's usage windows and when they reset",
    icon: "clock",
    defaultOn: true,
  },
  {
    id: "stream",
    zone: "foot",
    title: "Stream",
    blurb: "The session: turn it on, restart it, turn it off",
    icon: "power",
    defaultOn: true,
  },
  {
    id: "worktree",
    zone: "foot",
    title: "Worktree",
    blurb: "Where the agent works right now",
    icon: "branch",
    defaultOn: true,
  },
  {
    id: "machine",
    zone: "foot",
    title: "Machine",
    blurb: "This Mac, or the server the conversation runs on",
    icon: "server",
    defaultOn: true,
  },
];

const BY_ID = new Map<string, WidgetDef>(WIDGETS.map((w) => [w.id, w]));

export function widgetDef(id: WidgetId): WidgetDef {
  return BY_ID.get(id)!;
}

export function isWidgetId(v: unknown): v is WidgetId {
  return typeof v === "string" && BY_ID.has(v);
}

/** One slot of a zone: which widget, and whether it is switched on. */
export interface LayoutEntry {
  id: WidgetId;
  on: boolean;
}

export interface PanelLayout {
  /** The scrolling sections, in order. */
  main: LayoutEntry[];
  /** The rows pinned at the bottom, in order. */
  foot: LayoutEntry[];
  /** Sections folded to their header (only read while `collapsible` is on). */
  collapsed: WidgetId[];
  /** Whether a section header folds its section. ON by default. */
  collapsible: boolean;
}

function zoneDefaults(zone: WidgetZone): LayoutEntry[] {
  return WIDGETS.filter((w) => w.zone === zone).map((w) => ({ id: w.id, on: w.defaultOn }));
}

/** A fresh layout. `telemetry` carries over the old stand-alone "Telemetry deck" preference. */
export function defaultLayout(opts: { telemetry?: boolean } = {}): PanelLayout {
  const main = zoneDefaults("main").map((e) =>
    e.id === "telemetry" && opts.telemetry ? { ...e, on: true } : e,
  );
  return { main, foot: zoneDefaults("foot"), collapsed: [], collapsible: true };
}

/** One zone of a stored layout, repaired: known ids of THIS zone only, each once, in the stored
 *  order; every widget the store does not mention (added by a newer build than the one that
 *  saved it) comes back at its default visibility, in its catalogue position. */
function sanitizeZone(raw: unknown, zone: WidgetZone): LayoutEntry[] {
  const seen = new Set<WidgetId>();
  const kept: LayoutEntry[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const o = (item ?? {}) as { id?: unknown; on?: unknown };
      if (!isWidgetId(o.id) || seen.has(o.id) || widgetDef(o.id).zone !== zone) continue;
      seen.add(o.id);
      kept.push({ id: o.id, on: typeof o.on === "boolean" ? o.on : widgetDef(o.id).defaultOn });
    }
  }
  // Missing widgets go back where the catalogue puts them: after the last kept widget that
  // precedes them in the catalogue, so a new widget lands near its neighbours, not at the end.
  const catalogue = WIDGETS.filter((w) => w.zone === zone);
  for (const w of catalogue) {
    if (seen.has(w.id)) continue;
    const before = catalogue.slice(0, catalogue.indexOf(w)).map((c) => c.id);
    let at = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (before.includes(kept[i].id)) {
        at = i + 1;
        break;
      }
    }
    kept.splice(at, 0, { id: w.id, on: w.defaultOn });
    seen.add(w.id);
  }
  return kept;
}

/** A stored layout, repaired against the catalogue (see sanitizeZone); anything unreadable
 *  falls back to `fallback`. */
export function sanitizeLayout(raw: unknown, fallback: PanelLayout): PanelLayout {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Partial<Record<keyof PanelLayout, unknown>>;
  const collapsed = Array.isArray(o.collapsed)
    ? [...new Set(o.collapsed.filter(isWidgetId))].filter((id) => widgetDef(id).zone === "main")
    : [];
  return {
    main: sanitizeZone(o.main, "main"),
    foot: sanitizeZone(o.foot, "foot"),
    collapsed,
    collapsible: typeof o.collapsible === "boolean" ? o.collapsible : fallback.collapsible,
  };
}

function zoneOf(id: WidgetId): WidgetZone {
  return widgetDef(id).zone;
}

/** Switch one widget on or off. */
export function setWidgetOn(layout: PanelLayout, id: WidgetId, on: boolean): PanelLayout {
  const zone = zoneOf(id);
  const entries = layout[zone];
  if (entries.find((e) => e.id === id)?.on === on) return layout;
  return { ...layout, [zone]: entries.map((e) => (e.id === id ? { ...e, on } : e)) };
}

/** Move `id` to where `overId` is (the drag-and-drop drop), within their shared zone. A move
 *  across zones, or onto itself, changes nothing. */
export function moveWidget(layout: PanelLayout, id: WidgetId, overId: WidgetId): PanelLayout {
  if (id === overId) return layout;
  const zone = zoneOf(id);
  if (zoneOf(overId) !== zone) return layout;
  const entries = layout[zone].slice();
  const from = entries.findIndex((e) => e.id === id);
  const to = entries.findIndex((e) => e.id === overId);
  if (from < 0 || to < 0) return layout;
  const [moved] = entries.splice(from, 1);
  entries.splice(to, 0, moved);
  return { ...layout, [zone]: entries };
}

/** Fold or unfold a section. */
export function setCollapsed(layout: PanelLayout, id: WidgetId, collapsed: boolean): PanelLayout {
  const has = layout.collapsed.includes(id);
  if (has === collapsed) return layout;
  return {
    ...layout,
    collapsed: collapsed ? [...layout.collapsed, id] : layout.collapsed.filter((c) => c !== id),
  };
}

/** Whether a section is folded right now — never while folding is switched off. */
export function isCollapsed(layout: PanelLayout, id: WidgetId): boolean {
  return layout.collapsible && layout.collapsed.includes(id);
}

/** A starting point in the customize view: which widgets it switches ON (all others off). It
 *  changes visibility only, never the user's order. */
export interface PanelPreset {
  id: "essentials" | "standard" | "developer" | "cockpit";
  label: string;
  blurb: string;
  on: readonly WidgetId[];
}

export const PANEL_PRESETS: readonly PanelPreset[] = [
  {
    id: "essentials",
    label: "Essentials",
    blurb: "What the conversation is about",
    on: ["task", "goal", "todos", "artifacts", "stream"],
  },
  {
    id: "standard",
    label: "Standard",
    blurb: "The default set",
    on: WIDGETS.filter((w) => w.defaultOn).map((w) => w.id),
  },
  {
    id: "developer",
    label: "Developer",
    blurb: "Code, context and the machine it runs on",
    on: ["task", "goal", "todos", "artifacts", "linked", "stats", "context", "git", "stream", "worktree", "machine"],
  },
  {
    id: "cockpit",
    label: "Cockpit",
    blurb: "Everything, telemetry included",
    on: WIDGETS.map((w) => w.id),
  },
];

export function applyPreset(layout: PanelLayout, preset: PanelPreset): PanelLayout {
  const on = new Set<WidgetId>(preset.on);
  const flip = (entries: LayoutEntry[]) => entries.map((e) => ({ ...e, on: on.has(e.id) }));
  return { ...layout, main: flip(layout.main), foot: flip(layout.foot) };
}

/** The preset the layout's visibility matches exactly, if any — the customize view lights it. */
export function matchingPreset(layout: PanelLayout): PanelPreset | null {
  const on = new Set([...layout.main, ...layout.foot].filter((e) => e.on).map((e) => e.id));
  return (
    PANEL_PRESETS.find((p) => p.on.length === on.size && p.on.every((id) => on.has(id))) ?? null
  );
}
