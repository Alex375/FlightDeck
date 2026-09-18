// The live half of "drag the panel to the bottom or to the right": one press on the dock's
// grip (or on the header's own empty background) tracked to a drop zone.
//
// Plain pointer events with pointer capture, exactly like the editor's `Splitter` — there
// are TWO fixed targets, so a sortable library would be scaffolding around a coin flip.
// Everything the live drag needs sits in a ref latch; React state carries only what the UI
// paints (the overlay is up / this zone is hot), so a pointermove never waits for a render.
//
// Every exit path — a drop, a release in the neutral middle, Escape, `pointercancel`, the
// window losing focus, or the component unmounting mid-drag — runs the SAME teardown, and
// the listeners are removed through removers recorded when they were added, so none can be
// forgotten as the set grows.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { dockZoneAt, exceedsDragThreshold, type DockZone } from "./dockDrag";

/** The whole page wears the drag: `grabbing` wherever the pointer goes, and no text
 *  selection dragged out of the header on the way. Cleared by restoring the empty inline
 *  value — nothing else in the app writes these, so the body carries none of its own.
 *  Module scope: it closes over nothing, and the drag's stable callbacks must not end up
 *  holding a stale copy of it. */
function paintDragging(on: boolean): void {
  const s = document.body.style;
  s.cursor = on ? "grabbing" : "";
  s.userSelect = on ? "none" : "";
  s.webkitUserSelect = on ? "none" : "";
}

/** What a dock header needs to offer the drag, and what the overlay needs to draw it. */
export interface DockDrag {
  /** True once the press has passed the threshold: the overlay is up and the cursor is
   *  `grabbing`. A press that never moved stays false — it was a click. */
  active: boolean;
  /** The zone under the pointer right now, or null over the neutral middle. */
  hot: DockZone | null;
  /** Wire to `onPointerDown` of every surface that may START a drag. The element it is
   *  fired on is the one that captures the pointer. */
  start: (e: ReactPointerEvent) => void;
}

/**
 * Drag-to-move for the IDE dock.
 *
 * `areaRef` is the box the zones are measured in — the editor + dock container, which keeps
 * its full size even while the editor is hidden behind a maximized dock. `onDrop` is called
 * with the zone the pointer was released over, and NOT called at all when the drag was
 * cancelled (so "nothing happened" really is nothing, not a move back and forth).
 */
export function useDockDrag(
  areaRef: RefObject<HTMLElement | null>,
  onDrop: (zone: DockZone) => void,
): DockDrag {
  const [active, setActive] = useState(false);
  const [hot, setHot] = useState<DockZone | null>(null);

  const drag = useRef<{
    pointerId: number;
    /** The element holding the pointer capture, so the release can go to the right one. */
    target: Element;
    /** Whether that capture was actually taken — see `start`. */
    captured: boolean;
    /** Where the press started — the threshold is measured from here. */
    x: number;
    y: number;
    /** Has it passed the threshold? Until then it is still a click. */
    moved: boolean;
  } | null>(null);
  /** One remover per listener added, recorded at the moment it is added. */
  const listeners = useRef<Array<() => void>>([]);
  // The drop callback through a ref: the window listeners are installed once per drag and
  // must still call the CURRENT handler if the component re-renders mid-drag.
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const zoneFor = useCallback(
    (x: number, y: number): DockZone | null => {
      const rect = areaRef.current?.getBoundingClientRect();
      return rect ? dockZoneAt(rect, x, y) : null;
    },
    [areaRef],
  );

  const end = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    for (const off of listeners.current) off();
    listeners.current = [];
    if (d?.captured) {
      try {
        d.target.releasePointerCapture(d.pointerId);
      } catch {
        /* already released — the pointer was cancelled, or the element is gone */
      }
    }
    // Only undo what this drag actually painted: a press that never passed the threshold
    // never touched the page, and `end` also runs on unmount with no drag at all.
    if (d?.moved) paintDragging(false);
    setActive(false);
    setHot(null);
  }, []);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved) {
        if (!exceedsDragThreshold(e.clientX - d.x, e.clientY - d.y)) return;
        d.moved = true;
        paintDragging(true);
        setActive(true);
      }
      setHot(zoneFor(e.clientX, e.clientY));
    },
    [zoneFor],
  );

  const onUp = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      // A press that never passed the threshold was a click on the header: it moves nothing.
      const zone = d.moved ? zoneFor(e.clientX, e.clientY) : null;
      end();
      if (zone) dropRef.current(zone);
    },
    [end, zoneFor],
  );

  /** `pointercancel` (the OS took the pointer) and the window losing focus both mean the
   *  gesture is over and the user never said where. Cancel, change nothing. */
  const onAbort = useCallback(() => end(), [end]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // While a drag is in flight, Escape belongs to it and to nothing else: the app's
      // capture-phase full-screen guard and any open popover must not also act on it.
      e.preventDefault();
      e.stopPropagation();
      end();
    },
    [end],
  );

  const start = useCallback(
    (e: ReactPointerEvent) => {
      // Primary button only, and never a second drag on top of one already running.
      if (e.button !== 0 || drag.current) return;
      const target = e.currentTarget;
      let captured = false;
      try {
        target.setPointerCapture(e.pointerId);
        captured = true;
      } catch {
        // Capture is what keeps the drag tracking once the pointer leaves the header. When
        // it cannot be taken (the pointer vanished between the event and here), the window
        // listeners below still follow the pointer INSIDE the window — which is where both
        // drop zones are — so degrade rather than refuse: a grip that answers a press with
        // nothing at all would be a dead affordance.
      }
      drag.current = { pointerId: e.pointerId, target, captured, x: e.clientX, y: e.clientY, moved: false };
      // No text selection dragged out of the header, and no focus stolen from the editor.
      e.preventDefault();

      const add = <K extends keyof WindowEventMap>(
        type: K,
        fn: (ev: WindowEventMap[K]) => void,
        capture?: boolean,
      ): void => {
        window.addEventListener(type, fn, capture);
        listeners.current.push(() => window.removeEventListener(type, fn, capture));
      };
      // On window rather than on the element: pointer capture retargets the events to the
      // grip, but they still bubble up here — and this keeps working if the grip itself is
      // unmounted mid-drag.
      add("pointermove", onMove);
      add("pointerup", onUp);
      add("pointercancel", onAbort);
      add("blur", onAbort);
      add("keydown", onKey, true);
    },
    [onMove, onUp, onAbort, onKey],
  );

  // Unmounting mid-drag (the dock closes, the workspace is closed) must not leave the page
  // with a `grabbing` cursor and a live listener set. `end` is stable, so this runs once.
  useEffect(() => () => end(), [end]);

  return { active, hot, start };
}
