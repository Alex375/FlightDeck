import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  clampRestoreTop,
  initialTarget,
  nextFollowing,
  readScrollMemo,
  writeScrollMemo,
} from "./scrollMemory";
import { verticalScaleOfEl } from "../../ui/visualScale";

// After a send, follow new content smoothly for this long (the user message + the
// "thinking" indicator land in this window), then snap instantly so fast token
// streaming tracks the bottom without lag.
const SMOOTH_SEND_MS = 700;
// The initial position is applied across a settle window, not in one jump: a
// conversation's transcript loads into the store asynchronously (disk read + IPC) and
// its height then keeps growing for several frames. We re-apply the target until the
// height has grown past the empty mount value AND then stayed stable for a few frames,
// bounded by a hard cap. Reading the REAL DOM height makes this work on a plain
// history view, where no streaming re-render would otherwise re-pin.
const SETTLE_STABLE_FRAMES = 5;
const SETTLE_MAX_MS = 5000;

export interface StickToBottom {
  /** Attach to the scroll container (the element with `overflow-y: auto`). */
  scrollRef: (node: HTMLDivElement | null) => void;
  /**
   * Call before paint on every thread render (see StreamFollow in ConductorThread).
   * While the open is still settling it applies the remembered/initial position;
   * afterwards it keeps the bottom pinned while the user is following (streaming).
   */
  onRender: () => void;
  /** Engage following and smooth-scroll to the bottom — used on send. */
  scrollToBottom: () => void;
}

/**
 * `preserveKey`: when this value changes (e.g. the user toggles the "clean output"
 * display, which folds/unfolds every round and so changes the thread height a lot), the
 * scroll is re-anchored so the user stays on the SAME content instead of jumping. If
 * pinned to the bottom we stay pinned; otherwise we keep the element at the top of the
 * viewport in place (falling back to the distance from the bottom).
 */
export function useStickToBottom(convId: string, preserveKey?: unknown): StickToBottom {
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const smoothUntil = useRef(0);

  // --- scroll-preservation anchor (for `preserveKey` changes) ---
  // The element at the top of the viewport + its offset from the viewport top, captured
  // (coalesced) on user scroll. Its DOM node survives the re-render (stable keys), so after
  // a height-changing toggle we restore scrollTop to keep that element at the same offset.
  const anchor = useRef<{ node: HTMLElement; gap: number } | null>(null);
  const distFromBottom = useRef(0);
  const captureQueued = useRef(false);

  const captureAnchor = useCallback(() => {
    captureQueued.current = false;
    const el = scrollEl.current;
    if (!el) return;
    distFromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    anchor.current = null;
    const inner = el.querySelector(".cv-thread-inner");
    if (!inner) return;
    const top = el.getBoundingClientRect().top;
    // ⚠️ The SELECTION below compares rects, which are VISUAL — so the 8px threshold, a
    // layout figure, is projected into that space. Under the Flight Deck modal's opening
    // zoom (an ancestor transform) a raw 8 would mean ~40 layout px and could latch onto a
    // different row than at rest.
    const minVisible = 8 * verticalScaleOfEl(el);
    for (const child of Array.from(inner.children) as HTMLElement[]) {
      const r = child.getBoundingClientRect();
      // First element whose bottom is below the viewport top = the topmost visible row.
      if (r.bottom - top > minVisible) {
        // ⚠️ …and the GAP itself is taken in LAYOUT space (`offsetTop` − `scrollTop`), never
        // from rects. It is cached here and spent much later against `scrollTop`, which is
        // always layout pixels; a visual gap captured under the modal's zoom would be off by
        // that scale and send the thread hundreds of pixels away from what the user was
        // reading — the very jump this anchor exists to prevent. Layout metrics cannot be
        // scaled by a transform, so this needs no correction rather than the right one.
        anchor.current = { node: child, gap: child.offsetTop - el.scrollTop };
        break;
      }
    }
  }, []);

  // --- initial-restore state (one window per mount, i.e. per conversation) ---
  const restoring = useRef(true);
  const restoreTop = useRef<number | null>(null); // null → bottom
  const programmaticTop = useRef(0);
  const settleStart = useRef(0);
  const baseHeight = useRef(-1);
  const lastHeight = useRef(-1);
  const stableFrames = useRef(0);
  const grew = useRef(false);
  const inited = useRef(false);

  // Seed following + restore target from this conversation's memory, synchronously on
  // the first render, so the very first layout-effect already positions correctly.
  if (!inited.current) {
    inited.current = true;
    const target = initialTarget(readScrollMemo(convId));
    following.current = target.following;
    restoreTop.current = target.restoreTop;
    restoring.current = true;
    settleStart.current = performance.now();
  }

  const onScroll = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    const top = el.scrollTop;
    // A scroll position we did not just set ourselves = the user took control →
    // abandon the initial restore so we never fight their scrolling.
    if (restoring.current && Math.abs(top - programmaticTop.current) > 2) {
      restoring.current = false;
    }
    following.current = nextFollowing(
      following.current,
      lastTop.current,
      top,
      el.scrollHeight,
      el.clientHeight,
    );
    lastTop.current = top;
    // Remember where this conversation is, so reopening it returns here.
    writeScrollMemo(convId, { top, atBottom: following.current });
    // Refresh the preservation anchor (coalesced to one capture per frame) so a later
    // `preserveKey` toggle re-anchors on what the user is currently looking at.
    if (!captureQueued.current) {
      captureQueued.current = true;
      requestAnimationFrame(captureAnchor);
    }
  }, [convId, captureAnchor]);

  const scrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollEl.current?.removeEventListener("scroll", onScroll);
      scrollEl.current = node;
      if (node) {
        node.addEventListener("scroll", onScroll, { passive: true });
        lastTop.current = node.scrollTop;
      }
    },
    [onScroll],
  );

  // Apply the remembered/initial position and track when the async load has settled.
  const applyRestore = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    if (baseHeight.current < 0) {
      baseHeight.current = el.scrollHeight;
      // Content already present at mount (re-opening a loaded conversation) overflows
      // immediately — treat it as arrived so we settle quickly instead of at the cap.
      if (el.scrollHeight > el.clientHeight + 4) grew.current = true;
    }
    el.scrollTop =
      restoreTop.current == null
        ? el.scrollHeight
        : clampRestoreTop(restoreTop.current, el.scrollHeight, el.clientHeight);
    programmaticTop.current = el.scrollTop;

    const h = el.scrollHeight;
    if (h > baseHeight.current + 4) grew.current = true; // real content has arrived
    if (h === lastHeight.current) {
      stableFrames.current += 1;
    } else {
      stableFrames.current = 0;
      lastHeight.current = h;
    }
    const settled = grew.current && stableFrames.current >= SETTLE_STABLE_FRAMES;
    if (settled || performance.now() - settleStart.current > SETTLE_MAX_MS) {
      restoring.current = false;
      // Seed the preservation anchor from the just-restored position. Otherwise, a conversation
      // restored mid-thread that the user never scrolled has no anchor (onScroll is the only
      // other capture point) and `distFromBottom` stays 0 — so a "clean output" toggle would
      // fall through to `scrollHeight - clientHeight` and snap to the bottom. Seeding here keeps
      // the user on the same content even when they toggle before scrolling.
      captureAnchor();
    }
  }, [captureAnchor]);

  const followIfPinned = useCallback(() => {
    const el = scrollEl.current;
    if (!el || !following.current) return;
    if (performance.now() < smoothUntil.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Runs before paint on every thread render: position during the restore window,
  // then keep the bottom pinned while following (streaming).
  const onRender = useCallback(() => {
    if (restoring.current) applyRestore();
    else followIfPinned();
  }, [applyRestore, followIfPinned]);

  const scrollToBottom = useCallback(() => {
    const el = scrollEl.current;
    if (!el) return;
    restoring.current = false; // a send overrides any in-flight restore
    following.current = true;
    smoothUntil.current = performance.now() + SMOOTH_SEND_MS;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Drive the restore for frames where nothing re-renders the thread (the async load
  // settling after first paint). `onRender` covers render-triggered frames before
  // paint; this rAF covers the gaps. Both stop the moment the restore is done.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled || !restoring.current) return;
      applyRestore();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [applyRestore]);

  // Keep the bottom pinned when the SCROLL VIEWPORT shrinks/grows on its own — a
  // background-task bar (AgentBar / BashBar / MonitorBar) appearing or disappearing
  // below the thread, the composer growing to several lines, the window resizing. These
  // shrink `.cv-thread` (flex:1) without re-rendering it: the bars are sibling components
  // fed by a different store, so `StreamFollow` never fires `onRender`. Without this,
  // the now-shorter viewport clips the tail of the last message behind the bar instead
  // of riding up above it. Only acts while following + done restoring, so it never fights
  // a user reading mid-thread nor the initial-position restore. (Guarded for jsdom, which
  // has no ResizeObserver.)
  useEffect(() => {
    const el = scrollEl.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const node = scrollEl.current;
      if (!node) return;
      const h = node.clientHeight;
      if (h === lastH) return; // width-only change (RO also fires on those) → ignore
      lastH = h;
      if (following.current && !restoring.current) node.scrollTop = node.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-anchor when `preserveKey` flips (a toggle that changes the thread height a lot).
  // Runs as a layout effect AFTER the new layout is committed but before paint, so the
  // jump is never visible. Skips the initial mount (no toggle yet).
  const preserveInited = useRef(false);
  useLayoutEffect(() => {
    if (!preserveInited.current) {
      preserveInited.current = true;
      return;
    }
    const el = scrollEl.current;
    if (!el || restoring.current) return;
    if (following.current) {
      el.scrollTop = el.scrollHeight; // stay pinned to the bottom
    } else {
      const a = anchor.current;
      if (a && a.node.isConnected) {
        // Restore so the anchored row keeps the same offset from the viewport top. Layout
        // space at both ends (see captureAnchor): `offsetTop` is where the row sits in the
        // scrolled content, so putting `scrollTop` that same distance behind it reproduces
        // the offset exactly — whatever transform happened to be painting either end.
        el.scrollTop = a.node.offsetTop - a.gap;
      } else {
        // No usable anchor → keep the same distance from the bottom.
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - distFromBottom.current);
      }
    }
    lastTop.current = el.scrollTop;
    programmaticTop.current = el.scrollTop;
  }, [preserveKey]);

  return { scrollRef, onRender, scrollToBottom };
}
