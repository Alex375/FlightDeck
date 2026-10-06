// ⌘F over a panel's rendered text — the engine behind the find bar on every DOM surface (the
// conversation thread, a markdown preview, the Flight Deck, the TOSSE board).
//
// A surface calls `useDomFind` with the zone it covers and renders what it returns inside that
// zone (which must be `position: relative`): nothing while closed, the anchored bar while open.
// The session indexes the zone's VISIBLE text (textIndex.ts), paints every hit with the CSS
// Highlight API (highlights.ts) and scrolls the current one into view. It keeps up with a live
// panel — a streaming answer, a fold opening — through a throttled MutationObserver, and
// re-anchors on the hit the user was on rather than jumping back to the first one.
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useWorkFold } from "../../store/workFold";
import { compileFindQuery, findAll, initialMatchIndex, pickByHint, stepIndex, type TextMatch } from "./findQuery";
import { FindBar, Toggle, type FindScope } from "./FindBar";
import { registerFindHost, useFindStore } from "./findStore";
import { useFoldReveal } from "./foldReveal";
import { clearHighlights, paintHighlights } from "./highlights";
import { buildTextIndex, rangeFor, scrollRangeIntoView, type TextIndex } from "./textIndex";
import { Ico } from "../../ui/kit";
import styles from "./FindBar.module.css";

export interface DomFindConfig {
  /** Stable name of the surface (made unique per mount internally). */
  id: string;
  /** The zone: what ⌘F routing tests focus against, and where the bar is anchored. */
  zoneRef: RefObject<HTMLElement | null>;
  /** What is searched, when narrower than the zone (the thread, not the composer under it). */
  root?: () => HTMLElement | null;
  /** What gets the "being searched" outline. Defaults to the searched root. */
  ring?: () => HTMLElement | null;
  scope: FindScope;
  /** See FindHost.fallbackRank. */
  fallbackRank?: number;
  /** False → not searchable right now (⌘F routes elsewhere). Default true. */
  enabled?: boolean;
  /** Called right before scrolling to a hit (the thread lets go of its stick-to-bottom). */
  onReveal?: () => void;
  /** A conversation shown in clean output: offer to search the work folded away too. */
  foldConv?: string | null;
}

/** Live rebuilds are throttled: a streaming answer mutates the thread many times a second. */
const LIVE_REBUILD_MS = 300;
/** How long a search that found nothing keeps watching for its first hit to scroll to. */
const REVEAL_WAIT_MS = 6000;
/** How long a find requested for a surface not yet on screen stays valid. */
const PENDING_TTL_MS = 10_000;

export function useDomFind(cfg: DomFindConfig): ReactNode {
  const uid = useId();
  const hostId = `${cfg.id}#${uid}`;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(
    () =>
      registerFindHost({
        id: hostId,
        el: () => cfgRef.current.zoneRef.current,
        open: (seed) => {
          const c = cfgRef.current;
          if (c.enabled === false) return false;
          if (!(c.root ?? (() => c.zoneRef.current))()) return false;
          useFindStore.getState().openBar(hostId, seed);
          return true;
        },
        fallbackRank: cfg.fallbackRank,
      }),
    [hostId, cfg.fallbackRank],
  );
  // The surface went away (conversation switched, panel closed): its bar goes with it.
  useEffect(() => () => useFindStore.getState().closeBar(hostId), [hostId]);

  // A find requested for this surface before it was on screen (a global-search hit opening
  // its conversation): open it now. A request nobody picked up for long is dropped, so it can
  // never ambush a later, unrelated visit.
  const pending = useFindStore((s) => (s.pending?.surfaceId === cfg.id ? s.pending : null));
  useEffect(() => {
    if (!pending) return;
    const store = useFindStore.getState();
    if (Date.now() - pending.at > PENDING_TTL_MS) {
      store.clearPending();
      return;
    }
    const c = cfgRef.current;
    if (c.enabled === false || !(c.root ?? (() => c.zoneRef.current))()) return;
    store.clearPending();
    store.openBar(hostId, null, { hint: pending.hint, autoFold: pending.autoFold });
  }, [pending, hostId]);

  const nonce = useFindStore((s) => (s.active?.hostId === hostId ? s.active.nonce : null));
  if (nonce === null || cfg.enabled === false) return null;
  return <DomFindSession hostId={hostId} cfgRef={cfgRef} nonce={nonce} />;
}

interface Engine {
  index: TextIndex | null;
  matches: TextMatch[];
  ranges: (Range | null)[];
  current: number;
}

interface View {
  count: number;
  index: number;
  capped: boolean;
  error: string | null;
}

const EMPTY_VIEW: View = { count: 0, index: -1, capped: false, error: null };

function DomFindSession({
  hostId,
  cfgRef,
  nonce,
}: {
  hostId: string;
  cfgRef: RefObject<DomFindConfig>;
  nonce: number;
}) {
  const query = useFindStore((s) => s.query);
  const isRegex = useFindStore((s) => s.isRegex);
  const matchCase = useFindStore((s) => s.matchCase);
  const wholeWord = useFindStore((s) => s.wholeWord);
  const includeFolded = useFindStore((s) => s.includeFolded);
  const setQuery = useFindStore((s) => s.setQuery);
  const setOptions = useFindStore((s) => s.setOptions);
  const closeBar = useFindStore((s) => s.closeBar);
  const [view, setView] = useState<View>(EMPTY_VIEW);
  const engine = useRef<Engine>({ index: null, matches: [], ranges: [], current: -1 });
  // Whatever had focus before ⌘F — handed back on close (the composer, a terminal…).
  const restoreFocus = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);
  // A live rebuild is scheduled: navigation flushes it first, so ↵ never steps over stale ranges.
  const pending = useRef<number | null>(null);
  // A search found nothing YET and the content may still be arriving (a conversation's history
  // loading, folds mounting after "search folded work"): the first live rebuild that finds a
  // hit within this deadline scrolls to it, as the search itself would have. 0 = not waiting.
  const revealDeadline = useRef(0);
  const foldConv = cfgRef.current!.foldConv ?? null;
  // Opened for a global-search hit: land on THAT occurrence (one-shot, dropped once revealed),
  // and open the folded work by itself if nothing visible matches.
  const extras = useFindStore((s) => (s.active?.hostId === hostId ? s.active : null));
  const hint = useRef(extras?.hint ?? null);
  const autoFold = !!extras?.autoFold;
  const [autoFolded, setAutoFolded] = useState(false);
  const foldedOn = includeFolded || autoFolded;

  const root = () => {
    const c = cfgRef.current!;
    return (c.root ?? (() => c.zoneRef.current))();
  };

  const reveal = (i: number) => {
    const r = engine.current.ranges[i];
    if (!r || !r.startContainer.isConnected) return;
    cfgRef.current!.onReveal?.();
    scrollRangeIntoView(r, cfgRef.current!.zoneRef.current);
  };

  /** Rebuild the index and the hits. `query` mode (the query or a toggle changed) lands on the
   *  hit nearest to where the user is and scrolls to it; `live` mode (the panel re-rendered)
   *  keeps the current hit and never scrolls. */
  const recompute = (mode: "query" | "live") => {
    if (pending.current !== null) {
      window.clearTimeout(pending.current);
      pending.current = null;
    }
    const el = root();
    const opts = { isRegex, matchCase, wholeWord };
    const compiled = compileFindQuery(query, opts);
    if (!el || !compiled || "error" in compiled) {
      engine.current = { index: null, matches: [], ranges: [], current: -1 };
      clearHighlights();
      setView(compiled && "error" in compiled ? { ...EMPTY_VIEW, error: compiled.error } : EMPTY_VIEW);
      return;
    }
    const index = buildTextIndex(el);
    const { matches, capped } = findAll(index.text, compiled.re);
    const ranges = matches.map((m) => rangeFor(index, m.start, m.end));
    const prev = engine.current.ranges[engine.current.current] ?? null;
    let current = reanchor(ranges, prev);
    if (current === -2) {
      const byHint = hint.current ? pickByHint(index.text, matches, hint.current) : -1;
      current = byHint >= 0 ? byHint : initialMatchIndex(matches, viewportAnchor(index, el));
    } else if (current === -1 && matches.length) {
      current = Math.min(engine.current.current, matches.length - 1);
    }
    engine.current = { index, matches, ranges, current };
    paintHighlights(ranges.filter((r): r is Range => r !== null), current >= 0 ? ranges[current] : null);
    setView({ count: matches.length, index: current, capped, error: null });
    // Nothing visible, but the panel has content and the hit came from folded-away work: open
    // the folds (the rebuild that follows finds it). Waits for SOME text, so a conversation
    // whose history is still loading does not get its folds thrown open for nothing.
    if (autoFold && !foldedOn && matches.length === 0 && index.text.trim() !== "") setAutoFolded(true);
    const waiting = revealDeadline.current > 0 && performance.now() < revealDeadline.current;
    if ((mode === "query" || waiting) && current >= 0) {
      revealDeadline.current = 0;
      hint.current = null;
      reveal(current);
    } else if (mode === "query") {
      revealDeadline.current = performance.now() + REVEAL_WAIT_MS;
    }
  };
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  // Query or toggle changed (and on open).
  useEffect(() => {
    recomputeRef.current("query");
  }, [query, isRegex, matchCase, wholeWord, foldedOn]);

  // Re-targeted while open — ⌘F pressed again, or another global-search hit in this same
  // conversation: pick up what changed meanwhile, and land on the new hit when there is one.
  const firstNonce = useRef(nonce);
  useEffect(() => {
    if (nonce === firstNonce.current) return;
    hint.current = extras?.hint ?? null;
    if (hint.current) {
      engine.current.current = -1;
      recomputeRef.current("query");
    } else {
      recomputeRef.current("live");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  // Follow the panel as it re-renders (streaming, folds opening, history landing).
  useEffect(() => {
    const el = root();
    if (!el || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver((records) => {
      // The bar's own counter updating is not the panel changing.
      if (records.every((r) => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest("[data-find-bar]"))) return;
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        recomputeRef.current("live");
      }, LIVE_REBUILD_MS);
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outline the zone being searched.
  useEffect(() => {
    const c = cfgRef.current!;
    const el = (c.ring ?? c.root ?? (() => c.zoneRef.current))();
    if (!el) return;
    el.setAttribute("data-find-zone", "");
    return () => el.removeAttribute("data-find-zone");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Search folded work": open every fold of this conversation for as long as it is on. On the
  // way out, the fold holding the hit the user stopped on is opened FOR REAL — closing the bar
  // must not fold away the very line they were looking for.
  useEffect(() => {
    if (!foldConv) return;
    useFoldReveal.getState().set(foldConv, foldedOn);
    return () => {
      if (foldedOn) {
        const r = engine.current.ranges[engine.current.current];
        const fold = r?.startContainer.parentElement?.closest<HTMLElement>("[data-work-fold]");
        const key = fold?.dataset.workFold;
        if (key) useWorkFold.getState().setOpen(foldConv, key, true);
      }
      useFoldReveal.getState().set(foldConv, false);
    };
  }, [foldConv, foldedOn]);

  // Closing: drop the paint, give focus back.
  useEffect(
    () => () => {
      clearHighlights();
      const active = document.activeElement;
      const prev = restoreFocus.current;
      if ((!active || active === document.body || !active.isConnected) && prev instanceof HTMLElement && prev.isConnected) {
        prev.focus({ preventScroll: true });
      }
    },
    [],
  );

  const step = (delta: number) => {
    if (pending.current !== null) recompute("live");
    const e = engine.current;
    if (e.matches.length === 0) return;
    revealDeadline.current = 0;
    const current = stepIndex(e.current, delta, e.matches.length);
    e.current = current;
    paintHighlights(e.ranges.filter((r): r is Range => r !== null), e.ranges[current] ?? null);
    setView((v) => ({ ...v, index: current }));
    reveal(current);
  };

  const cfg = cfgRef.current!;
  const foldedHint =
    foldConv && !foldedOn && query && !view.error && view.count === 0 ? (
      <>
        No visible match.
        <button type="button" className={styles.hintBtn} onClick={() => setOptions({ includeFolded: true })}>
          Search folded work
        </button>
      </>
    ) : null;
  const toggleFolded = () => {
    if (foldedOn) {
      setAutoFolded(false);
      setOptions({ includeFolded: false });
    } else {
      setOptions({ includeFolded: true });
    }
  };

  return (
    <FindBar
      scope={cfg.scope}
      focusNonce={nonce}
      query={query}
      onQuery={setQuery}
      options={{ isRegex, matchCase, wholeWord }}
      onOptions={setOptions}
      count={view.count}
      index={view.index}
      capped={view.capped}
      error={view.error}
      onNext={() => step(1)}
      onPrev={() => step(-1)}
      onClose={() => closeBar(hostId)}
      extra={
        foldConv ? (
          <Toggle on={foldedOn} title="Also search the work folded by clean output" onClick={toggleFolded}>
            <Ico name="layers" />
          </Toggle>
        ) : null
      }
      hint={foldedHint}
    />
  );
}

/**
 * The hit to keep after a rebuild: the first one at or after where the previous current hit
 * started. -2 = there was no previous hit to anchor on (pick by viewport instead); -1 = the
 * previous hit's node is gone (fall back to its old index).
 */
function reanchor(ranges: (Range | null)[], prev: Range | null): number {
  if (!prev) return -2;
  if (!prev.startContainer.isConnected) return -1;
  let last = -1;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (!r) continue;
    last = i;
    try {
      if (r.compareBoundaryPoints(Range.START_TO_START, prev) >= 0) return i;
    } catch {
      return -1;
    }
  }
  return last;
}

/** Flat offset of the first text visible at the top of the panel's scroller — where "the hit
 *  nearest to the user" is measured from. Binary search: text nodes come in reading order. */
function viewportAnchor(index: TextIndex, root: HTMLElement): number {
  if (index.nodes.length === 0) return 0;
  let scroller: HTMLElement | null = root;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) {
    scroller = scroller.parentElement;
  }
  if (!scroller) return 0;
  const top = scroller.getBoundingClientRect().top;
  let lo = 0;
  let hi = index.nodes.length - 1;
  let ans = index.nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const parent = index.nodes[mid].parentElement;
    const bottom = parent ? parent.getBoundingClientRect().bottom : -Infinity;
    if (bottom >= top) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return index.starts[ans];
}
