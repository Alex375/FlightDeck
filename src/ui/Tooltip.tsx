// A real hover tooltip — the app's own, not the OS one.
//
// `title="…"` is the browser's native tooltip: it waits about a second before appearing,
// it cannot be styled, it renders in the OS's own font, and on a control that is
// `aria-disabled` it never shows at all (see [[disabled-control-tooltip-never-shows]]).
// That is fine for a rarely-needed hint and wrong for information the UI deliberately
// hides at rest and expects you to reveal by pointing at it — there the delay reads as
// "nothing happened".
//
// This one appears immediately, is portaled to <body> so an ancestor's `overflow:hidden`
// cannot clip it (the Flight Deck swimlane clips its cards — the same reason `Menu` has a
// portal mode), and is placed by the pure `tooltipPlacement`.
//
// Deliberately NOT a click/focus popover: it holds nothing you must act on, so there is
// nothing to trap focus for. It still reaches the keyboard and assistive tech, through
// `aria-label`/`aria-describedby` on the trigger — see `label` below.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { tooltipPlacement, type TooltipPos } from "./tooltipPlacement";

export function Tooltip({
  content,
  label,
  children,
  className,
}: {
  /** The tooltip body. Rich content is allowed — it is presentation, never a control. */
  content: ReactNode;
  /** The same information as one flat string, put on the trigger for assistive tech. A
   *  pointer-only tooltip would otherwise be invisible to anyone not using a pointer. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [pos, setPos] = useState<TooltipPos | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const id = useId();
  // Mounted-but-unplaced on the first frame: the tooltip has to exist for its size to be
  // measurable, and `pos` is what makes it visible, so it never paints at 0,0 first.
  const [open, setOpen] = useState(false);

  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!t || !tip) return;
    setPos(
      tooltipPlacement(t, { width: tip.width, height: tip.height }, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, []);

  // Measure and place BEFORE the browser paints, so the tooltip's first visible frame is
  // already in the right spot (a `useEffect` here shows one frame in the wrong place).
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // A portaled box is positioned in VIEWPORT coordinates, so any scroll leaves it floating
  // away from the thing it describes. Close on scroll rather than chase it: the pointer has
  // left the trigger in every case where that matters. `capture` catches scrolls in inner
  // panes (the sidebar, the deck), which do not bubble.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    // Escape dismisses it like every other transient layer in the app. Not in the capture
    // phase: a tooltip must never take an Escape away from a dialog or the full-screen guard.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const show = () => setOpen(true);
  const hide = () => {
    setOpen(false);
    setPos(null);
  };

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        // Pointer events rather than mouse events: one pair covers mouse and trackpad, and
        // a touch tap raises them too (where a `title` shows nothing at all).
        onPointerEnter={show}
        onPointerLeave={hide}
        // A pointer that goes down (a drag starting on the row, a click) is no longer
        // hovering in any useful sense — the tooltip would sit over what is being dragged.
        onPointerDown={hide}
        aria-label={label}
        aria-describedby={open ? id : undefined}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className={"wf-tip" + (pos ? " placed" : "")}
              data-side={pos?.side}
              style={pos ? { left: pos.left, top: pos.top } : undefined}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
