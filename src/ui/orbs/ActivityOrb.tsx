// The React face of the activity orbs (engine: `orbEngine.ts`, geometry: `orbMotion.ts`).
// `<ActivityOrb>` is a canvas following a conversation's shape channel; `useHeldUntilSwap` keeps
// the words beside it on the previous activity until the orb swaps shape, so text and shape
// change at the same instant (the validated design), not 0.36 s apart. `<StaticOrb>` is a
// fixed-shape orb for the background work (sub-agents, shells, monitors, workflows…).
// No store import here on purpose: `ui/kit`-level surfaces can use it without a cycle — the
// conversation-derived shape lives in `useOrbStateOf.ts`.
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { OrbSize, OrbState } from "thinking-orbs";
import {
  acquireOrbChannel,
  registerOrbView,
  requestOrbState,
  shownOrbState,
  subscribeOrbChannel,
  updateOrbView,
} from "./orbEngine";

/**
 * The value to render beside an orb: `value` once the orb shows `state`, else the value it had
 * when the orb last showed what it shows now.
 */
export function useHeldUntilSwap<T>(channel: string, state: OrbState, value: T): T {
  const subscribe = useCallback((fn: () => void) => subscribeOrbChannel(channel, fn), [channel]);
  const shown = useSyncExternalStore(subscribe, () => shownOrbState(channel));
  const held = useRef(value);
  if (shown === null || shown === state) held.current = value;
  return held.current;
}

export function ActivityOrb({
  channel,
  state,
  tone,
  display = 20,
  size = 20,
  frozen = false,
  follow = true,
  className,
}: {
  /** The shape channel this orb follows — a conversation id, shared with that conversation's
   *  other orbs so they morph together. */
  channel: string;
  /** The shape asked for now; the channel decides when it actually shows (minimum hold). */
  state: OrbState;
  /** A CSS custom property (`--wf-run`) or `currentColor`. */
  tone: string;
  /** On-screen size in CSS px (the 20 px preset scaled down for 18 / 16 / 14). */
  display?: number;
  size?: OrbSize;
  /** A still image (nothing in flight). It still swaps to the shape asked for — unless
   *  `follow` is false. */
  frozen?: boolean;
  /** Ask the channel for `state` (default). False: just show the channel's shape as it is —
   *  a row whose agent stopped keeps the shape it last had. */
  follow?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Declared first: the channel must exist before the canvas draws from it.
  useLayoutEffect(
    () => acquireOrbChannel(channel, state),
    // The initial shape only seeds a NEW channel; later shapes go through requestOrbState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel],
  );
  useEffect(() => {
    if (follow) requestOrbState(channel, state);
  }, [channel, state, follow]);

  const cfg = { channel, size, display, tone, frozen };
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    return registerOrbView(c, cfgRef.current);
  }, [channel]);
  useLayoutEffect(() => {
    const c = ref.current;
    if (c) updateOrbView(c, cfgRef.current);
  }, [size, display, tone, frozen]);

  return (
    // No width/height props: the engine sizes the bitmap (display × device pixel ratio).
    <canvas
      ref={ref}
      className={"wf-orb" + (className ? " " + className : "")}
      style={{ width: display, height: display }}
      aria-hidden="true"
    />
  );
}

/**
 * A fixed-shape orb — "this background thing is running" (a sub-agent, a shell, a monitor, a
 * workflow and its agents). Every orb of one shape shares one channel that never transitions.
 * Coral by default, like the three dots it replaces; 14 px fits their slot in the bars and rows.
 */
export function StaticOrb({
  state,
  tone = "--wf-accent",
  display = 14,
  className,
}: {
  state: OrbState;
  tone?: string;
  display?: number;
  className?: string;
}) {
  return <ActivityOrb channel={`static:${state}`} state={state} tone={tone} display={display} className={className} />;
}
