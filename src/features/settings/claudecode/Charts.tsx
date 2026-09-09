// Inline SVG charts for the sub-agent spend dashboard.
//
// No charting library: three small charts on one settings page do not justify a dependency
// in an app whose stated first principle is speed, and the whole corpus folds to ~50
// buckets, so everything is computed client-side from one payload.
//
// ## Colour
//
// Series identity is the MODEL, and each model keeps its hue no matter what is filtered or
// how the rows sort — colour follows the entity, never its rank, so narrowing to one repo
// never repaints the survivors. The eight hues are the validated dark-mode categorical
// palette, checked against this app's own card surface (#15151b) rather than assumed:
// lightness band, chroma floor, CVD separation (worst adjacent ΔE 8.4), normal-vision
// floor (19.3) and 3:1 contrast all pass. A ninth model is never a generated hue — it
// folds into "Other".
//
// Every chart carries a legend and a hover tooltip, and the tables beside them are the
// table view, so identity is never colour-alone.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { pricingKeyForTranscriptModel } from "./spend";

/** The app's card surface — the gap colour between stacked marks, so segments read as
 *  separated rather than as a new blended hue. */
const SURFACE = "#15151b";

/**
 * The categorical slots, in fixed order. Validated as a SET for the dark surface; the
 * ordering is the colourblind-safety mechanism, not decoration — do not re-order to make a
 * particular chart prettier without re-running the validator.
 */
const SERIES_HUES = [
  "#3987e5", // blue
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
] as const;

/** Anything past the eight slots. Neutral on purpose: "Other" is not an identity. */
const OTHER_HUE = "#6a6a76";

/**
 * Model → slot, assigned from a FIXED list rather than from the order a model happens to
 * appear in the data. Two consequences that matter: a model keeps its colour between the
 * charts and across sessions, and a filter that drops a model never shifts the others.
 */
const SLOT_ORDER = [
  "fable",
  "claude-fable-5",
  "opus",
  "claude-opus-4-8",
  "sonnet",
  "haiku",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
];

/**
 * The hue for a model, from ANY spelling of its id.
 *
 * Normalises internally rather than trusting the caller: charts hold raw transcript ids
 * (`claude-fable-5-1`) while the slot list is keyed by pricing key (`fable`), and a
 * caller that forgets to convert gets the neutral "Other" grey — which looks like a
 * styling accident, not like a bug, so it survives review. Doing it here makes every call
 * site correct by construction.
 */
export function hueForSeries(modelId: string): string {
  const i = SLOT_ORDER.indexOf(pricingKeyForTranscriptModel(modelId));
  return i >= 0 && i < SERIES_HUES.length ? SERIES_HUES[i]! : OTHER_HUE;
}

/**
 * Width of an element, tracked so the SVG can use real pixel coordinates (crisp text)
 * rather than being scaled by `preserveAspectRatio`.
 *
 * ⚠️ A CALLBACK ref, not a mount-time `useEffect`. These charts render an empty state
 * first — the spend query is still in flight — so the measured node does not exist on the
 * first render. An effect with `[]` deps would run once against a null ref, never observe
 * anything, and leave the chart permanently blank once the data arrived (the SVG is gated
 * on a non-zero width). A callback ref measures whenever the node attaches, which is
 * exactly the event we care about.
 */
function useElementWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const nodeRef = useRef<T | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    nodeRef.current = node;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    observerRef.current = observer;
    setWidth(node.getBoundingClientRect().width);
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, width, nodeRef] as const;
}

export interface Series {
  key: string;
  label: string;
  values: number[];
}

interface TooltipState {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ state }: { state: TooltipState | null }) {
  if (!state) return null;
  return (
    <div className="cc-tip" style={{ left: state.x, top: state.y }} role="presentation">
      {state.content}
    </div>
  );
}

/** Shared legend. Present whenever there are two or more series — identity must never rest
 *  on colour alone. */
export function ChartLegend({ series }: { series: Array<{ key: string; label: string }> }) {
  if (series.length < 2) return null;
  return (
    <ul className="cc-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className="cc-swatch" style={{ background: hueForSeries(s.key) }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

// ---- Stacked area over time ------------------------------------------------

/**
 * Spend per day, stacked by model — the "when did this happen" view.
 *
 * Days are continuous (see `continuousDays`), so a quiet week is drawn as a quiet week
 * rather than compressed out of existence.
 */
export function StackedAreaChart({
  days,
  series,
  height = 168,
  formatValue,
  title,
}: {
  days: string[];
  series: Series[];
  height?: number;
  formatValue: (n: number) => string;
  title: string;
}) {
  const [ref, width, node] = useElementWidth<HTMLElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const pad = { top: 8, right: 8, bottom: 18, left: 8 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;

  const totals = useMemo(
    () => days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)),
    [days, series],
  );
  const max = Math.max(1, ...totals);

  if (days.length === 0) return <EmptyChart title={title} />;

  const x = (i: number) => (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => plotH - (v / max) * plotH;

  // Cumulative bands, bottom-up.
  let running = days.map(() => 0);
  const bands = series.map((s) => {
    const lower = [...running];
    const upper = running.map((base, i) => base + (s.values[i] ?? 0));
    running = upper;
    const top = upper.map((v, i) => `${x(i)},${y(v)}`).join(" L ");
    const bottom = lower
      .map((_, i) => `${x(days.length - 1 - i)},${y(lower[days.length - 1 - i]!)}`)
      .join(" L ");
    return { key: s.key, label: s.label, d: `M ${top} L ${bottom} Z` };
  });

  return (
    <figure className="cc-chart" ref={ref}>
      <figcaption className="cc-chart-title">{title}</figcaption>
      <div className="cc-plot" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={title}>
            <g transform={`translate(${pad.left},${pad.top})`}>
              {/* Recessive baseline; no grid — the shapes carry the reading. */}
              <line x1={0} y1={plotH} x2={plotW} y2={plotH} className="cc-axis" />
              {bands.map((b) => (
                <path
                  key={b.key}
                  d={b.d}
                  fill={hueForSeries(b.key)}
                  // A 2px surface-coloured stroke IS the gap between stacked fills.
                  stroke={SURFACE}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              ))}
              {hoverDay !== null && (
                <line
                  x1={x(hoverDay)}
                  y1={0}
                  x2={x(hoverDay)}
                  y2={plotH}
                  className="cc-crosshair"
                />
              )}
              {/* One invisible hit column per day — a hit target far bigger than the mark. */}
              {days.map((day, i) => {
                const w = days.length === 1 ? plotW : plotW / days.length;
                return (
                  <rect
                    key={day}
                    x={Math.max(0, x(i) - w / 2)}
                    y={0}
                    width={w}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={(e) => {
                      setHoverDay(i);
                      const box = node.current?.getBoundingClientRect();
                      setTip({
                        x: e.clientX - (box?.left ?? 0) + 12,
                        y: e.clientY - (box?.top ?? 0) - 8,
                        content: (
                          <>
                            <div className="cc-tip-head">{day}</div>
                            {series
                              .map((s) => ({ s, v: s.values[i] ?? 0 }))
                              .filter(({ v }) => v > 0)
                              .sort((a, b) => b.v - a.v)
                              .map(({ s, v }) => (
                                <div key={s.key} className="cc-tip-row">
                                  <span
                                    className="cc-swatch"
                                    style={{ background: hueForSeries(s.key) }}
                                    aria-hidden
                                  />
                                  {s.label}
                                  <b>{formatValue(v)}</b>
                                </div>
                              ))}
                            <div className="cc-tip-row cc-tip-total">
                              Total<b>{formatValue(totals[i] ?? 0)}</b>
                            </div>
                          </>
                        ),
                      });
                    }}
                    onMouseLeave={() => {
                      setHoverDay(null);
                      setTip(null);
                    }}
                  />
                );
              })}
            </g>
            {/* Only the ends are labelled — never a number on every point. */}
            <text x={pad.left} y={height - 4} className="cc-tick">
              {days[0]}
            </text>
            {days.length > 1 && (
              <text x={width - pad.right} y={height - 4} textAnchor="end" className="cc-tick">
                {days[days.length - 1]}
              </text>
            )}
          </svg>
        )}
        <Tooltip state={tip} />
      </div>
      <ChartLegend series={series} />
    </figure>
  );
}

// ---- Horizontal stacked bars ----------------------------------------------

export interface StackedBarRow {
  key: string;
  label: string;
  total: number;
  parts: Array<{ key: string; label: string; value: number }>;
}

/**
 * One bar per repository, split by model — answers "where does the money go" and "what is
 * it being spent on" in a single figure, instead of two charts showing the same totals
 * twice.
 */
export function StackedBarChart({
  rows,
  formatValue,
  title,
  emptyNote,
}: {
  rows: StackedBarRow[];
  formatValue: (n: number) => string;
  title: string;
  emptyNote?: string;
}) {
  const [ref, width, node] = useElementWidth<HTMLElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);

  if (rows.length === 0) return <EmptyChart title={title} note={emptyNote} />;

  const labelW = 96;
  const valueW = 64;
  const barW = Math.max(0, width - labelW - valueW - 12);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const rowH = 26;
  const barH = 14;

  const allSeries = new Map<string, string>();
  for (const row of rows) for (const p of row.parts) allSeries.set(p.key, p.label);

  return (
    <figure className="cc-chart" ref={ref}>
      <figcaption className="cc-chart-title">{title}</figcaption>
      <div className="cc-plot" style={{ height: rows.length * rowH + 4 }}>
        {width > 0 && (
          <svg width={width} height={rows.length * rowH + 4} role="img" aria-label={title}>
            {rows.map((row, ri) => {
              const y = ri * rowH + 4;
              let cursor = 0;
              return (
                <g key={row.key}>
                  <text x={0} y={y + barH - 2} className="cc-barlabel">
                    {row.label}
                  </text>
                  {row.parts.map((part, pi) => {
                    const raw = (part.value / max) * barW;
                    // A 2px gap between adjacent segments, taken off the segment, so the
                    // bar's total length still reads as the total.
                    const isLast = pi === row.parts.length - 1;
                    const w = Math.max(0, raw - (isLast ? 0 : 2));
                    const x = labelW + cursor;
                    cursor += raw;
                    if (w <= 0) return null;
                    return (
                      <rect
                        key={part.key}
                        x={x}
                        y={y}
                        width={w}
                        height={barH}
                        // The outer end of the bar is the data end: round it, keep the
                        // internal joins square so the stack reads as one length.
                        rx={isLast ? 4 : 0}
                        fill={hueForSeries(part.key)}
                        onMouseEnter={(e) => {
                          const box = node.current?.getBoundingClientRect();
                          setTip({
                            x: e.clientX - (box?.left ?? 0) + 12,
                            y: e.clientY - (box?.top ?? 0) - 8,
                            content: (
                              <>
                                <div className="cc-tip-head">{row.label}</div>
                                <div className="cc-tip-row">
                                  <span
                                    className="cc-swatch"
                                    style={{ background: hueForSeries(part.key) }}
                                    aria-hidden
                                  />
                                  {part.label}
                                  <b>{formatValue(part.value)}</b>
                                </div>
                                <div className="cc-tip-row cc-tip-total">
                                  Total<b>{formatValue(row.total)}</b>
                                </div>
                              </>
                            ),
                          });
                        }}
                        onMouseLeave={() => setTip(null)}
                      />
                    );
                  })}
                  {/* Direct label on every bar: few rows, and it removes the need to
                      read a value off an axis. */}
                  <text
                    x={width}
                    y={y + barH - 2}
                    textAnchor="end"
                    className="cc-barvalue"
                  >
                    {formatValue(row.total)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip state={tip} />
      </div>
      <ChartLegend series={[...allSeries].map(([key, label]) => ({ key, label }))} />
    </figure>
  );
}

function EmptyChart({ title, note }: { title: string; note?: string }) {
  return (
    <figure className="cc-chart">
      <figcaption className="cc-chart-title">{title}</figcaption>
      <p className="cc-empty">{note ?? "Nothing in this range yet."}</p>
    </figure>
  );
}
