// The TELEMETRY deck: the side panel's opt-in instrument cluster (`conversationTelemetry`,
// OFF by default) — a context gauge, the run's clock and status lamp, one counter per tool
// family, a live activity histogram, a strip of totals and a feed of the latest calls.
//
// It is meant to be loud: needles overshoot, counters roll, bars scroll, lamps pulse. The rule
// that keeps it from being a screensaver is that NOTHING moves on its own — every motion is a
// real signal changing (see telemetry.ts for where each number comes from). Idle, the deck is
// still; the agent working is what animates it.
//
// Cost is kept flat on purpose: the numbers are memoised on the store references that move
// when a call lands, not on every streamed token; the only timers are a 1 Hz clock (mounted
// only while a run is live) and the histogram's 5 s bucket; every animation is CSS on
// transform/opacity. The OS "reduce motion" setting stops all of it.

import { useEffect, useRef, useState } from "react";
import { useConversationStore, useRunStartedAt, useSessionState } from "../../store/conversationStore";
import { useRunningTaskCount } from "../../store/backgroundTasksStore";
import { settledRunMs } from "../../agent/runClock";
import { useNow } from "../../ui/useNow";
import { motionAllowed } from "../../ui/motion";
import { Ico } from "../../ui/kit";
import { ContextUsageMenu } from "./ContextUsageMenu";
import {
  closeBucket,
  deckStatus,
  fmtClock,
  fmtSpan,
  HISTOGRAM_BUCKET_MS,
  HISTOGRAM_BUCKETS,
  histogramArrivals,
  TELEMETRY_DIALS,
  useTelemetry,
  type TelemetryEvent,
  type ToolFamily,
} from "./telemetry";
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
  // A call still waiting for its result only means work while the turn is live: a session that
  // died mid-call leaves one behind forever.
  const runningTool = busy ? (t.events.find((e) => e.status === "running")?.tool ?? null) : null;
  const status = deckStatus({
    busy,
    awaitingPermission: !!state?.awaiting_permission,
    retrying: !!state?.retry,
    runningTool,
    streaming,
    backgroundOps,
  });
  const histogram = useActivityHistogram(t.totalCalls);
  const motion = motionAllowed(true);
  const maxCount = Math.max(1, ...TELEMETRY_DIALS.map((f) => t.counts[f]));

  return (
    <section
      className={d.deck}
      data-status={status.key}
      data-motion={motion || undefined}
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
          <RunClock convId={convId} />
          <span className={d.status}>{status.label}</span>
        </div>
      </div>

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

/** The run's clock: ticking while a run is live, frozen on the last run's length once it is
 *  over, dashes before the first. Its own component so the 1 Hz tick re-renders only these
 *  digits, and only while there is something to count. */
function RunClock({ convId }: { convId: string }) {
  const startedAt = useRunStartedAt(convId);
  const settled = useConversationStore((s) => settledRunMs(s.sessions[convId]?.runClock));
  if (startedAt !== null) return <LiveClock startedAt={startedAt} />;
  return <span className={d.clock}>{settled === null ? "–:––" : fmtClock(settled)}</span>;
}

function LiveClock({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  return (
    <span className={d.clock} data-live="">
      {fmtClock(now - startedAt)}
    </span>
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
              <path
                d={ARC}
                className={d.gFill}
                pathLength={100}
                style={{ strokeDashoffset: 100 - pct }}
              />
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
 * Calls per 5 s over the last two minutes, the newest bucket filling live on the right.
 * Measured from ARRIVALS while the deck is open (see histogramArrivals): calls carry no time
 * in the store, so the history a conversation opens on is not drawn as a spike.
 */
function useActivityHistogram(totalCalls: number): { done: number[]; live: number } {
  const previous = useRef<number | null>(null);
  const [live, setLive] = useState(0);
  const [done, setDone] = useState<number[]>([]);
  const liveRef = useRef(0);
  liveRef.current = live;

  useEffect(() => {
    const arrived = histogramArrivals(previous.current, totalCalls);
    previous.current = totalCalls;
    if (arrived > 0) setLive((l) => l + arrived);
  }, [totalCalls]);

  useEffect(() => {
    const id = setInterval(() => {
      setDone((prev) => closeBucket(prev, liveRef.current));
      setLive(0);
    }, HISTOGRAM_BUCKET_MS);
    return () => clearInterval(id);
  }, []);

  return { done, live };
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
          {total} {total === 1 ? "call" : "calls"} · 2 min
        </span>
      </div>
      <div className={d.bars} aria-label={`${total} tool calls in the last two minutes`} role="img">
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

/** The latest calls, newest on top; a new one slides in, a running one spins, a failed one
 *  turns red. */
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
