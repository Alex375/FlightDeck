// The conversation side panel's LAYOUT — which widgets it shows, in what order, which sections are
// folded — persisted to localStorage like the other pure-UI arrangements (manualOrder.ts,
// display.ts): it is how the user likes to look at things, not domain data, so it stays out of
// SQLite. One layout for every conversation.
//
// The catalogue and every rule of the arithmetic live in `features/conversation/sidePanelWidgets.ts`
// (pure, tested); this store only loads, repairs, applies and saves. Plus one TRANSIENT flag,
// `customizing`, never persisted: whether the panel is showing its customize view — so Settings
// can open it too.
import { create } from "zustand";
import { useEditorStore } from "../features/editor/editorStore";
import {
  applyPreset,
  defaultLayout,
  moveWidget,
  sanitizeLayout,
  setCollapsed,
  setWidgetOn,
  type PanelLayout,
  type PanelPreset,
  type WidgetId,
} from "../features/conversation/sidePanelWidgets";

const STORAGE_KEY = "tosse:sidepanel";
/** Where the stand-alone "Telemetry deck" switch used to live — read once, to carry it over. */
const LEGACY_DISPLAY_KEY = "tosse:display";

/** The first layout of a user who never customized: the defaults, with the telemetry deck on if
 *  they had switched it on before it became a widget. */
function legacyDefault(): PanelLayout {
  try {
    const raw = localStorage.getItem(LEGACY_DISPLAY_KEY);
    const telemetry = raw ? (JSON.parse(raw) as { conversationTelemetry?: unknown }).conversationTelemetry : false;
    return defaultLayout({ telemetry: telemetry === true });
  } catch {
    return defaultLayout();
  }
}

function load(): PanelLayout {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaultLayout();
  }
  if (raw === null) {
    // First run of the widgets: carry the old switch over and SAVE at once. ⚠️ Not lazily —
    // the display store drops the retired `conversationTelemetry` key the next time it saves,
    // so a carry-over left unsaved would be lost on the following launch.
    const first = legacyDefault();
    save(first);
    return first;
  }
  try {
    return sanitizeLayout(JSON.parse(raw), defaultLayout());
  } catch {
    return defaultLayout();
  }
}

function save(layout: PanelLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* quota / disabled storage — best-effort, the layout still applies for this run */
  }
}

interface SidePanelLayoutState {
  layout: PanelLayout;
  /** The customize view is open (transient). */
  customizing: boolean;
  setCustomizing: (on: boolean) => void;
  setOn: (id: WidgetId, on: boolean) => void;
  move: (id: WidgetId, overId: WidgetId) => void;
  setCollapsed: (id: WidgetId, collapsed: boolean) => void;
  setCollapsible: (on: boolean) => void;
  applyPreset: (preset: PanelPreset) => void;
  /** Back to the defaults: visibility, order, folds and the folding switch. */
  reset: () => void;
}

export const useSidePanelLayout = create<SidePanelLayoutState>((set) => {
  const update = (fn: (l: PanelLayout) => PanelLayout) =>
    set((s) => {
      const layout = fn(s.layout);
      if (layout === s.layout) return s;
      save(layout);
      return { layout };
    });
  return {
    layout: load(),
    customizing: false,
    setCustomizing: (customizing) => set({ customizing }),
    setOn: (id, on) => update((l) => setWidgetOn(l, id, on)),
    move: (id, overId) => update((l) => moveWidget(l, id, overId)),
    setCollapsed: (id, collapsed) => update((l) => setCollapsed(l, id, collapsed)),
    setCollapsible: (collapsible) =>
      update((l) => (l.collapsible === collapsible ? l : { ...l, collapsible })),
    applyPreset: (preset) => update((l) => applyPreset(l, preset)),
    reset: () => update(() => defaultLayout()),
  };
});

/** Whether one widget is switched on — the hook a surface outside the panel asks (Settings'
 *  telemetry switch). */
export function useWidgetOn(id: WidgetId): boolean {
  return useSidePanelLayout((s) =>
    [...s.layout.main, ...s.layout.foot].some((e) => e.id === id && e.on),
  );
}

// Closing the panel ends the customize view: it is a moment of setting up, not a mode to come
// back to days later — the panel must reopen on its widgets (whichever way it was closed: its ×,
// the chord, an artifact taking its place).
useEditorStore.subscribe((st, prev) => {
  if (prev.convPanelOpen && !st.convPanelOpen && useSidePanelLayout.getState().customizing) {
    useSidePanelLayout.getState().setCustomizing(false);
  }
});
