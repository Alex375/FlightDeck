// Dropping files from the Finder onto a conversation — the shared, DOM-light half.
//
// Tauri intercepts OS file drops (the window's `dragDropEnabled` default): they never
// reach the page as HTML5 `drop` events carrying `File`s, they arrive as native webview
// events with ABSOLUTE PATHS and a cursor position. That is what we want — paths feed the
// same routine as the "+" picker (`attachPaths`), so a non-image can still become a path
// mention. `FileDropHost` listens to those events; this module holds what it needs that
// can be tested without a webview: how a drop zone is marked in the DOM, how the event's
// position maps to CSS pixels, and which zone the cursor is over (for the highlight).
//
// A drop zone is any element carrying `data-drop-conv` (the conversation's stable id) and
// `data-drop-kind`: the conversation column ("pane" — main view, Git workspace, Flight Deck
// reply modal alike) or a Flight Deck stream card ("card", which also opens the reply
// modal so the user sees the attachments land and writes the message).
//
// These are OS drags, not the in-page pointer drags @dnd-kit uses to reorder cards and
// rows: the two never see each other's events.
import { create } from "zustand";

export type DropKind = "pane" | "card";

export interface DropTarget {
  convId: string;
  kind: DropKind;
}

/** The attributes that make an element a drop zone for one conversation. */
export function dropZoneAttrs(convId: string, kind: DropKind): Record<string, string> {
  return { "data-drop-conv": convId, "data-drop-kind": kind };
}

/** The drop zone an element sits in (the innermost one), with the zone's element — or
 *  null when the element is outside every zone. */
export function dropZoneOf(el: Element | null): (DropTarget & { el: HTMLElement }) | null {
  const zone = el?.closest<HTMLElement>("[data-drop-conv][data-drop-kind]");
  if (!zone) return null;
  const convId = zone.dataset.dropConv;
  const kind = zone.dataset.dropKind;
  if (!convId || (kind !== "pane" && kind !== "card")) return null;
  return { convId, kind, el: zone };
}

/**
 * The drop event's position in CSS pixels of the page.
 *
 * ⚠️ Despite being typed `PhysicalPosition`, on macOS the value is NOT physical: wry takes
 * AppKit's `draggingLocation` (points, y flipped against the webview frame) and Tauri
 * forwards it unscaled. So it must NOT be divided by `devicePixelRatio` there — on a Retina
 * screen that would halve it and aim at the wrong element. What does apply is the interface
 * zoom (WKWebView `pageZoom`): one CSS pixel spans `zoom` points. Elsewhere the position is
 * genuinely physical pixels, and `devicePixelRatio` covers both the screen scale and zoom.
 */
export function dropPointToCss(
  pos: { x: number; y: number },
  env: { mac: boolean; zoom: number; dpr: number },
): { x: number; y: number } {
  const div = env.mac ? env.zoom : env.dpr;
  const k = Number.isFinite(div) && div > 0 ? div : 1;
  return { x: pos.x / k, y: pos.y / k };
}

// ---- hover state (the highlight) --------------------------------------------

interface FileDropState {
  /** The zone the cursor is dragging files over right now, or null. */
  over: DropTarget | null;
  /** Set when a drop landed on a conversation: its composer takes the focus with the caret
   *  after what was appended, then CONSUMES the request — so it is honoured once, whether
   *  the composer was already mounted or mounts right after (the reply modal opening on a
   *  card drop), and never re-steals the focus on a later remount. `seq` makes two drops
   *  in a row two distinct requests. */
  focusRequest: { convId: string; seq: number } | null;
  setOver: (over: DropTarget | null) => void;
  requestFocus: (convId: string) => void;
  /** Drop the pending focus request if it is this conversation's. */
  consumeFocus: (convId: string) => void;
}

export const useFileDrop = create<FileDropState>((set) => ({
  over: null,
  focusRequest: null,
  setOver: (over) =>
    set((s) =>
      s.over?.convId === over?.convId && s.over?.kind === over?.kind ? s : { over },
    ),
  requestFocus: (convId) =>
    set((s) => ({ focusRequest: { convId, seq: (s.focusRequest?.seq ?? 0) + 1 } })),
  consumeFocus: (convId) =>
    set((s) => (s.focusRequest?.convId === convId ? { focusRequest: null } : s)),
}));

/** Reactive: whether files are being dragged over THIS zone (drives its highlight). */
export function useIsDropOver(convId: string, kind: DropKind): boolean {
  return useFileDrop((s) => s.over?.convId === convId && s.over.kind === kind);
}
