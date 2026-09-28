// The TELEMETRY deck: the side panel's opt-in instrument cluster (`conversationTelemetry`,
// OFF by default) — millisecond clocks, needles, an oscilloscope, a board timing every call in
// flight, counters, a histogram and a feed.
//
// It is meant to be loud, and it is allowed to be only because NOTHING on it moves on its own:
// every figure is a real signal at its current value (telemetry.ts derives the counts,
// telemetryLive.ts the per-frame arithmetic). Idle, the deck settles and stops; the agent
// working is what animates it.
//
// ⚠️ How it stays cheap at 60 fps. React renders the deck only when its FACTS change (a call
// lands or settles, a turn ends, the status changes) — the memoised telemetry and a few
// scalar store selectors. Everything that moves every frame (the ms clocks, the needles, the
// in-flight timers and latency bars, the oscilloscope) is written straight into DOM nodes by
// ONE requestAnimationFrame loop reading the store with getState(): no React render per frame.
// The loop runs while there is something live (a turn, a call in flight, text streaming) and
// until the needles have settled after it, then stops itself. Under the OS "reduce motion"
// setting it ticks once a second instead, with no easing.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useConversationStore, useRunStartedAt, useSessionState } from "../../store/conversationStore";
import { useRunningTaskCount } from "../../store/backgroundTasksStore";
import { liveRunStart, settledRunMs } from "../../agent/runClock";
import { motionAllowed } from "../../ui/motion";
import { Ico } from "../../ui/kit";
import type { SessionEntry } from "../../store/types";
import { ContextUsageMenu } from "./ContextUsageMenu";
import {
  closeBucket,
  deckStatus,
  fmtSpan,
  HISTOGRAM_BUCKET_MS,
  HISTOGRAM_BUCKETS,
  histogramArrivals,
  liveInFlight,
  TELEMETRY_DIALS,
  useTelemetry,
  type DeckStatusKey,
  type Telemetry,
  type TelemetryEvent,
  type ToolFamily,
} from "./telemetry";
import {
  approach,
  estTokensPerSec,
  fmtClockMs,
  fmtSecs,
  gaugeFraction,
  latency,
  pushSample,
  streamGrowth,
  turnLoad,
} from "./telemetryLive";
import d from "./TelemetryDeck.module.css";

const FAMILY_LABEL: Record<ToolFamily, string> = {
  read: "Read",
  edit: "Edit",
  shell: "Shell",
  search: "Search",
  agent: "Agent",
  web: "Web",
  other: "Tool",
};

/** The four live gauges: what each reads, and its full scale. */
const GAUGES = [
  { key: "tps", label: "≈ Tok/s", max: 150, title: "Streaming rate — estimated from characters (÷4)" },
  { key: "cpm", label: "Calls/min", max: 60, title: "Tool calls over the last minute" },
  { key: "par", label: "In flight", max: 8, title: "Tool calls running in parallel right now" },
  { key: "load", label: "Turn load", max: 2, title: "This turn's length against the median turn" },
] as const;
type GaugeKey = (typeof GAUGES)[number]["key"];

/** Oscilloscope: one sample every 80 ms, fifteen seconds of history. */
const SCOPE_SAMPLE_MS = 80;
const SCOPE_SAMPLES = Math.round(15_000 / SCOPE_SAMPLE_MS);

export function TelemetryDeck({ convId }: { convId: string }) {
  const t = useTelemetry(convId);
  const state = useSessionState(convId);
  const backgroundOps = useRunningTaskCount(convId);
  // TEXT streaming on the main thread — a thinking block streaming is "thinking", not output.
  const streaming = useConversationStore((s) => {
    const e = s.sessions[convId];
    const open = e?.openBubble.root;
    return !!open && e.turns[open]?.status === "streaming" && e.thinkingStartedAt === null;
  });
  const busy = !!state?.busy;
  // Only while the session does something: a session that died mid-call leaves its call "in
  // flight" forever (see liveInFlight).
  const inFlight = liveInFlight(t.inFlight, { busy, backgroundOps, streaming });
  const running = inFlight[inFlight.length - 1] ?? null;
  const status = deckStatus({
    busy,
    awaitingPermission: !!state?.awaiting_permission,
    retrying: !!state?.retry,
    runningTool: running?.tool ?? null,
    streaming,
    backgroundOps,
  });
  const histogram = useActivityHistogram(t.totalCalls);
  const motion = motionAllowed(true);
  // The deck is live for as long as the RUN is — a run spans the background work it launched,
  // so its clock keeps counting through it — or while anything else visibly happens.
  const runLive = useRunStartedAt(convId) !== null;
  const live = runLive || busy || inFlight.length > 0 || streaming || backgroundOps > 0;
  const nodes = useLiveEngine(convId, {
    telemetry: t,
    inFlight,
    status: status.key,
    running,
    callsLastMinute: histogram.done.slice(-(HISTOGRAM_BUCKETS - 1)).reduce((a, b) => a + b, 0) + histogram.live,
    live,
    motion,
  });
  const maxCount = Math.max(1, ...TELEMETRY_DIALS.map((f) => t.counts[f]));

  return (
    <section
      className={d.deck}
      data-status={status.key}
      data-motion={motion || undefined}
      data-live={live || undefined}
      aria-label="Conversation telemetry"
    >
      <div className={d.head}>
        <span className={d.lamp} aria-hidden="true" />
        <span className={d.title}>Telemetry</span>
        <span className={d.live} data-on={status.key !== "standby" || undefined}>
          Live
        </span>
      </div>

      <div className={d.top}>
        <ContextGauge convId={convId} working={busy} />
        <div className={d.clockCol}>
          <span className={d.kicker}>Run</span>
          <span ref={nodes.bind("run")} className={d.clock} />
          <span className={d.status}>{status.label}</span>
          <span ref={nodes.bind("stateTimer")} className={d.stateTimer} />
        </div>
      </div>

      <div className={d.gauges}>
        {GAUGES.map((g) => (
          <div key={g.key} className={d.mini} title={g.title} data-gauge={g.key}>
            <svg viewBox="0 0 100 58" aria-hidden="true">
              <path d="M10 52 A40 40 0 0 1 90 52" className={d.mTrack} />
              <path d="M10 52 L14 52 M21.7 23.7 L24.5 26.5 M50 12 L50 16 M78.3 23.7 L75.5 26.5 M90 52 L86 52" className={d.mTicks} />
              <g ref={nodes.bind(`needle:${g.key}`)} className={d.mNeedle}>
                <path d="M50 52 L16 52" />
              </g>
              <circle cx="50" cy="52" r="3.5" className={d.mHub} />
            </svg>
            <span ref={nodes.bind(`value:${g.key}`)} className={d.mValue}>
              0
            </span>
            <span className={d.mLabel}>{g.label}</span>
          </div>
        ))}
      </div>

      <div className={d.scope}>
        <div className={d.scopeHead}>
          <span className={d.kicker}>Stream</span>
          <span ref={nodes.bind("scopePeak")} className={d.scopeMeta} />
        </div>
        <canvas ref={nodes.bindCanvas} className={d.scopeCanvas} aria-label="Streaming rate over the last 15 seconds" />
      </div>

      <InFlight events={inFlight} medians={t.familyMedianMs} bind={nodes.bind} />

      <div className={d.dials}>
        {TELEMETRY_DIALS.map((f) => (
          <div key={f} className={d.dial} data-family={f}>
            <span className={d.dialVal}>
              {/* Keyed by the value: each new count REMOUNTS the digits, which is what rolls
                  them in — a counter that ticks up is the one motion this dial makes. */}
              <span key={t.counts[f]} className={d.roll}>
                {t.counts[f]}
              </span>
            </span>
            <span className={d.dialLabel}>
              {FAMILY_LABEL[f]}
              {t.errors[f] > 0 ? <span className={d.dialErr}>{t.errors[f]} err</span> : null}
            </span>
            <span className={d.dialBar} aria-hidden="true">
              <span style={{ width: `${(t.counts[f] / maxCount) * 100}%` }} />
            </span>
          </div>
        ))}
      </div>

      <Histogram done={histogram.done} live={histogram.live} />

      <dl className={d.stats}>
        <div>
          <dt>Calls</dt>
          <dd>{t.totalCalls}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{t.filesTouched}</dd>
        </div>
        <div>
          <dt>Turns</dt>
          <dd>{t.turns}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd title="API-equivalent, as reported by the CLI">
            {t.costUsd == null ? "—" : `$${t.costUsd.toFixed(2)}`}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{t.modelMs == null ? "—" : fmtSpan(t.modelMs)}</dd>
        </div>
        <div>
          <dt>Think</dt>
          <dd ref={nodes.bind("think")} title="Time the agent spent thinking in this conversation" />
        </div>
        <div>
          <dt>Bg ops</dt>
          <dd data-hot={backgroundOps > 0 || undefined}>{backgroundOps}</dd>
        </div>
        <div>
          {/* Not the Agent dial: that one counts every orchestration call (a workflow, a
              message to another agent…); this is the sub-agents actually launched. */}
          <dt>Sub-agents</dt>
          <dd>{t.subAgents}</dd>
        </div>
      </dl>

      <Feed events={t.events} />
    </section>
  );
}

// ---- The frame loop -------------------------------------------------------------------------

interface EngineInputs {
  telemetry: Telemetry;
  /** The calls to time — {@link liveInFlight}'s, never the raw list. */
  inFlight: TelemetryEvent[];
  status: DeckStatusKey;
  running: TelemetryEvent | null;
  callsLastMinute: number;
  live: boolean;
  motion: boolean;
}

/** The DOM nodes the loop writes into, by name, and the canvas it draws on. */
interface LiveNodes {
  bind: (name: string) => (el: Element | null) => void;
  bindCanvas: (el: HTMLCanvasElement | null) => void;
}

/**
 * The deck's single frame loop. Everything it reads per frame comes from `getState()` or from
 * refs React keeps up to date — so the loop never causes a render, and a render never restarts
 * the loop.
 */
function useLiveEngine(convId: string, inputs: EngineInputs): LiveNodes {
  const els = useRef(new Map<string, Element>());
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef(inputs);
  latest.current = inputs;

  // When the current STATE began, as the deck observed it — the fallback for the states the
  // store does not stamp itself (streaming, background work). Stamped in an effect, never
  // during render: a ref written in render is what once made a StrictMode double-render lose
  // an edge (see ConductorConversation's hand-off timing).
  const stateSeen = useRef<{ key: DeckStatusKey; since: number }>({ key: inputs.status, since: Date.now() });
  useLayoutEffect(() => {
    if (stateSeen.current.key !== inputs.status) stateSeen.current = { key: inputs.status, since: Date.now() };
  }, [inputs.status]);

  const sim = useRef({
    lastFrame: 0,
    lastSampleAt: 0,
    streamLens: new Map<string, number>(),
    tps: 0,
    needles: { tps: 0, cpm: 0, par: 0, load: 0 } as Record<GaugeKey, number>,
    samples: [] as number[],
  });
  const raf = useRef<number | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  const bind = useCallback(
    (name: string) => (el: Element | null) => {
      if (el) els.current.set(name, el);
      else els.current.delete(name);
    },
    [],
  );
  const bindCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvas.current = el;
  }, []);

  /** One frame. Returns whether another is needed (something live, or a needle still moving). */
  const frame = useCallback((): boolean => {
    const { telemetry: t, inFlight, running, callsLastMinute, live, motion } = latest.current;
    const e = useConversationStore.getState().sessions[convId];
    const now = Date.now();
    const perf = performance.now();
    const s = sim.current;
    const dt = s.lastFrame ? Math.min(250, perf - s.lastFrame) : 16;
    s.lastFrame = perf;
    const ease = motion ? 140 : 0;
    const text = (name: string, value: string) => {
      const el = els.current.get(name);
      if (el && el.textContent !== value) el.textContent = value;
    };

    // Clocks.
    const runStart = e ? (liveRunStart(e.runClock) ?? e.turnStartedAt) : null;
    const settled = e ? settledRunMs(e.runClock) : null;
    text("run", runStart !== null ? fmtClockMs(now - runStart) : settled !== null ? fmtClockMs(settled) : "–:––.–––");
    text("stateTimer", fmtSecs(now - stateSince(latest.current.status, e, running, stateSeen.current.since)));
    if (e) text("think", fmtSpan(e.thinkingMs + (e.thinkingSince !== null ? now - e.thinkingSince : 0)));

    // Streaming rate: characters gained by every open bubble this frame.
    const open: Array<[string, number]> = [];
    if (e) {
      for (const id of Object.values(e.openBubble)) {
        const turn = id ? e.turns[id] : undefined;
        if (turn && turn.status === "streaming") {
          open.push([id!, turn.streamingText.length + turn.streamingThinking.length]);
        }
      }
    }
    const grown = streamGrowth(s.streamLens, open);
    s.streamLens = grown.next;
    const instant = estTokensPerSec(grown.chars / (dt / 1000));
    s.tps = motion ? approach(s.tps, instant, dt, 450) : instant;
    if (s.tps < 0.05) s.tps = 0;

    // Oscilloscope.
    if (perf - s.lastSampleAt >= SCOPE_SAMPLE_MS || !motion) {
      s.lastSampleAt = perf;
      s.samples = pushSample(s.samples, s.tps, SCOPE_SAMPLES);
      const peak = drawScope(canvas.current, s.samples);
      text("scopePeak", peak > 0 ? `peak ${Math.round(peak)} ≈ tok/s` : "idle");
    }

    // Gauges: targets, eased needles, readouts.
    const load = e && e.turnStartedAt !== null ? turnLoad(now - e.turnStartedAt, t.medianTurnMs) : null;
    const targets: Record<GaugeKey, number> = {
      tps: gaugeFraction(s.tps, GAUGES[0].max),
      cpm: gaugeFraction(callsLastMinute, GAUGES[1].max),
      par: gaugeFraction(inFlight.length, GAUGES[2].max),
      load: gaugeFraction(load ?? 0, GAUGES[3].max),
    };
    let moving = false;
    for (const g of GAUGES) {
      const next = approach(s.needles[g.key], targets[g.key], dt, ease);
      if (Math.abs(next - targets[g.key]) > 0.002) moving = true;
      s.needles[g.key] = next;
      const needle = els.current.get(`needle:${g.key}`) as SVGGElement | undefined;
      if (needle) needle.style.transform = `rotate(${next * 180}deg)`;
    }
    text("value:tps", String(Math.round(s.tps)));
    text("value:cpm", String(callsLastMinute));
    text("value:par", String(inFlight.length));
    text("value:load", load === null ? "—" : `${Math.round(load * 100)}%`);

    // In-flight board: each running call's timer and its latency bar.
    for (const ev of inFlight) {
      if (ev.startedAt === null) continue;
      const elapsed = now - ev.startedAt;
      text(`flight:${ev.id}`, fmtSecs(elapsed));
      const bar = els.current.get(`bar:${ev.id}`) as HTMLElement | undefined;
      if (bar) {
        const l = latency(elapsed, t.familyMedianMs[ev.family]);
        bar.style.width = `${l.fill * 100}%`;
        if (bar.dataset.level !== l.level) bar.dataset.level = l.level;
      }
    }

    return live || moving || s.tps > 0;
  }, [convId]);

  // Drive the loop: rAF while something moves (motion allowed), a 1 Hz tick otherwise. It
  // (re)starts whenever the deck goes live and stops itself once everything has settled.
  useEffect(() => {
    const { live, motion } = inputs;
    const stop = () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      if (tick.current !== null) clearInterval(tick.current);
      tick.current = null;
    };
    if (!motion) {
      frame();
      if (live) tick.current = setInterval(frame, 1000);
      return stop;
    }
    const loop = () => {
      raf.current = frame() ? requestAnimationFrame(loop) : null;
    };
    if (raf.current === null) {
      sim.current.lastFrame = 0;
      raf.current = requestAnimationFrame(loop);
    }
    return stop;
    // `frame` reads everything else through refs; these two decide whether a loop runs.
  }, [inputs.live, inputs.motion, frame]); // eslint-disable-line react-hooks/exhaustive-deps

  // A settled deck still shows its facts: one frame whenever they change while nothing runs.
  useEffect(() => {
    if (!inputs.live && raf.current === null) frame();
  }, [inputs.telemetry, inputs.inFlight, inputs.status, inputs.callsLastMinute, inputs.live, frame]);

  return { bind, bindCanvas };
}

/**
 * When the current state began, from the store's own stamps where it has one — the running
 * call's start, the thinking spell's start, the moment it started waiting on the user — and
 * otherwise from when the deck saw the state change.
 */
function stateSince(
  status: DeckStatusKey,
  e: SessionEntry | undefined,
  running: TelemetryEvent | null,
  seen: number,
): number {
  if (status === "tool" && running?.startedAt != null) return running.startedAt;
  if (status === "thinking" && e?.thinkingSince != null) return e.thinkingSince;
  if (status === "permission" && e?.awaitingSince != null) return e.awaitingSince;
  return seen;
}

/** Draw the rate trace (auto-scaled, never under 40 tok/s full scale); returns the peak. */
function drawScope(c: HTMLCanvasElement | null, samples: readonly number[]): number {
  if (!c) return 0;
  const ctx = c.getContext("2d");
  if (!ctx) return 0;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const styles = getComputedStyle(c);
  const trace = styles.getPropertyValue("--trace").trim() || "#7aa2e3";
  const grid = styles.getPropertyValue("--grid").trim() || "rgba(255,255,255,0.06)";
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = Math.round((h * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  let peak = 0;
  for (const v of samples) if (v > peak) peak = v;
  if (samples.length < 2) return peak;
  const scale = Math.max(40, peak * 1.2);
  const step = w / (SCOPE_SAMPLES - 1);
  const x0 = w - (samples.length - 1) * step;
  ctx.beginPath();
  samples.forEach((v, i) => {
    const x = x0 + i * step;
    const y = h - 1 - (v / scale) * (h - 3);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = trace;
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(x0, h);
  ctx.closePath();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = trace;
  ctx.fill();
  ctx.globalAlpha = 1;
  return peak;
}

// ---- The React-rendered instruments -------------------------------------------------------

/** Every call running right now, each with its own millisecond timer and a latency bar against
 *  the usual length of its kind in this conversation (the tick marks that median). */
function InFlight({
  events,
  medians,
  bind,
}: {
  events: TelemetryEvent[];
  medians: Telemetry["familyMedianMs"];
  bind: LiveNodes["bind"];
}) {
  return (
    <div className={d.flight}>
      <div className={d.flightHead}>
        <span className={d.kicker}>In flight</span>
        <span className={d.flightMeta}>{events.length}</span>
      </div>
      {events.length === 0 ? (
        <span className={d.flightEmpty}>Nothing in flight.</span>
      ) : (
        <ol className={d.flightList}>
          {events.map((e) => (
            <li key={e.id} className={d.flightRow} data-family={e.family}>
              <span className={d.feedTag}>{FAMILY_LABEL[e.family]}</span>
              <span className={d.flightTarget} title={e.target ?? e.tool}>
                {e.target ?? e.tool}
              </span>
              <span ref={bind(`flight:${e.id}`)} className={d.flightTimer} />
              <span
                className={d.flightTrack}
                title={
                  medians[e.family] === null
                    ? "No finished call of this kind yet to compare with"
                    : `Usual ${FAMILY_LABEL[e.family].toLowerCase()} call here: ${fmtSecs(medians[e.family]!)}`
                }
              >
                <span ref={bind(`bar:${e.id}`)} className={d.flightBar} data-level="unknown" />
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Semicircle, centre (90,90), radius 70: left end (0%) to right end (100%). */
const ARC = "M20 90 A70 70 0 0 1 160 90";
/** The warning band, from the 70% the other context readings turn on (see ContextUsageMenu). */
const REDLINE = "M131.14 33.37 A70 70 0 0 1 160 90";
/** Ticks at 0 / 25 / 50 / 75 / 100 %, just outside the arc. */
const TICKS = "M10 90 L16 90 M33.43 33.43 L37.67 37.67 M90 10 L90 16 M146.57 33.43 L142.33 37.67 M170 90 L164 90";

/**
 * The context window as a gauge — the same reading as the plain panel's bar, and the same
 * popover behind it. The needle swings to the fill (with an overshoot: it is meant to feel like
 * an instrument); a sweep circles the dial only while a turn is in flight.
 */
function ContextGauge({ convId, working }: { convId: string; working: boolean }) {
  return (
    <ContextUsageMenu
      convId={convId}
      trigger={(ctx, warn) => {
        const pct = ctx.windowKnown ? ctx.pct : 0;
        return (
          <button
            type="button"
            className={d.gauge}
            data-warn={warn || undefined}
            data-known={ctx.windowKnown || undefined}
            title={
              ctx.windowKnown
                ? `Context ${ctx.used} / ${ctx.max}`
                : "The context window is only known once a turn ends"
            }
          >
            <svg viewBox="0 0 180 104" aria-hidden="true">
              <path d={ARC} className={d.gTrack} />
              <path d={REDLINE} className={d.gRed} />
              <path d={ARC} className={d.gFill} pathLength={100} style={{ strokeDashoffset: 100 - pct }} />
              <path d={TICKS} className={d.gTicks} />
              {working ? (
                <g className={d.gSweep}>
                  <path d="M90 14 L90 24" />
                </g>
              ) : null}
              <g className={d.gNeedle} style={{ transform: `rotate(${(pct / 100) * 180}deg)` }}>
                <path d="M90 90 L32 90" />
              </g>
              <circle cx="90" cy="90" r="4.5" className={d.gHub} />
            </svg>
            <span className={d.gValue}>{ctx.windowKnown ? `${ctx.pct}%` : "—"}</span>
            <span className={d.gSub}>
              {ctx.used} / {ctx.max}
            </span>
          </button>
        );
      }}
    />
  );
}

/**
 * Calls per second over the last minute, the newest bucket filling live on the right.
 * Measured from ARRIVALS while the deck is open (see histogramArrivals): calls carry no time
 * in the store, so the history a conversation opens on is not drawn as a spike.
 */
function useActivityHistogram(totalCalls: number): { done: number[]; live: number } {
  const previous = useRef<number | null>(null);
  // ONE state, so closing the live bucket is a single pure transition.
  // ⚠️ It used to be two states closed by `setDone(p => closeBucket(p, liveRef.current))` +
  // `setLive(0)`: a ref read inside an updater, which React is free to run at a moment the ref no
  // longer holds the value it was meant to — measured in the browser: a call counted "1 call",
  // then vanished from the window a second later when its bucket closed.
  const [h, setH] = useState<{ done: number[]; live: number }>({ done: [], live: 0 });

  useEffect(() => {
    const arrived = histogramArrivals(previous.current, totalCalls);
    previous.current = totalCalls;
    if (arrived > 0) setH((s) => ({ done: s.done, live: s.live + arrived }));
  }, [totalCalls]);

  useEffect(() => {
    const id = setInterval(() => {
      setH((s) => ({ done: closeBucket(s.done, s.live), live: 0 }));
    }, HISTOGRAM_BUCKET_MS);
    return () => clearInterval(id);
  }, []);

  return h;
}

function Histogram({ done, live }: { done: number[]; live: number }) {
  const pad = Math.max(0, HISTOGRAM_BUCKETS - 1 - done.length);
  const bars = [...Array<number>(pad).fill(0), ...done, live];
  // Never scaled below 3 calls: a single call must not fill the whole height.
  const max = Math.max(3, ...bars);
  const total = bars.reduce((a, b) => a + b, 0);
  return (
    <div className={d.histo}>
      <div className={d.histoHead}>
        <span className={d.kicker}>Activity</span>
        <span className={d.histoMeta}>
          {total} {total === 1 ? "call" : "calls"} · 60 s
        </span>
      </div>
      <div className={d.bars} aria-label={`${total} tool calls in the last minute`} role="img">
        {bars.map((v, i) => (
          <span
            key={i}
            className={d.bar}
            data-live={i === bars.length - 1 || undefined}
            data-zero={v === 0 || undefined}
            style={{ height: `${Math.max(v === 0 ? 0 : 8, (v / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** The latest calls, newest on top, each with how long it took; a running one spins (its
 *  timer is on the in-flight board), a failed one turns red. */
function Feed({ events }: { events: TelemetryEvent[] }) {
  return (
    <div className={d.feedWrap}>
      <span className={d.kicker}>Feed</span>
      {events.length === 0 ? (
        <span className={d.feedEmpty}>No tool call yet.</span>
      ) : (
        <ol className={d.feed}>
          {events.map((e) => (
            <li key={e.id} className={d.feedRow} data-family={e.family} data-status={e.status}>
              <span className={d.feedTag}>{FAMILY_LABEL[e.family]}</span>
              <span className={d.feedTarget} title={e.target ?? e.tool}>
                {e.target ?? e.tool}
              </span>
              {e.sub ? <span className={d.feedSub}>sub</span> : null}
              <span className={d.feedDur}>{e.durationMs !== null ? fmtSecs(e.durationMs) : ""}</span>
              <span className={d.feedState} aria-label={e.status}>
                {e.status === "running" ? (
                  <span className={d.spin} />
                ) : e.status === "error" ? (
                  <Ico name="x" />
                ) : (
                  <Ico name="check" />
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
