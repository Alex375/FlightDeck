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

/**
 * Shared legend. Present whenever there are two or more series — identity must never rest
 * on colour alone.
 *
 * When `onToggle` is given the entries become filter buttons: hiding the big series is the
 * only way to see the small ones, because a model with a hundredth of the spend is a
 * hairline next to one that dominates. The chart rescales to what is left.
 */
export function ChartLegend({
  series,
  hidden,
  onToggle,
}: {
  series: Array<{ key: string; label: string }>;
  hidden?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
}) {
  if (series.length < 2) return null;
  return (
    <ul className="cc-legend">
      {series.map((s) => {
        const off = hidden?.has(s.key) ?? false;
        const swatch = (
          <>
            <span
              className="cc-swatch"
              style={{ background: off ? "transparent" : hueForSeries(s.key) }}
              data-off={off ? "" : undefined}
              aria-hidden
            />
            {s.label}
          </>
        );
        return (
          <li key={s.key}>
            {onToggle ? (
              <button
                type="button"
                className="cc-legend-btn"
                data-off={off ? "" : undefined}
                aria-pressed={!off}
                onClick={() => onToggle(s.key)}
                title={off ? `Show ${s.label}` : `Hide ${s.label}`}
              >
                {swatch}
              </button>
            ) : (
              swatch
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Place a tooltip near the cursor without letting it leave the figure.
 *
 * Flips to the left of the pointer when it would otherwise run past the right edge — the
 * plain "cursor + 12px" placement puts the tooltip off-screen on the right-hand days,
 * which is exactly where a month-long chart is most often read.
 */
function tooltipPosition(
  clientX: number,
  clientY: number,
  box: DOMRect | undefined,
): { x: number; y: number } {
  const TIP_W = 172;
  const OFFSET = 12;
  if (!box) return { x: clientX + OFFSET, y: clientY - 8 };
  const local = clientX - box.left;
  const wouldOverflow = local + OFFSET + TIP_W > box.width;
  const x = wouldOverflow
    ? Math.max(0, local - OFFSET - TIP_W)
    : local + OFFSET;
  return { x, y: clientY - box.top - 8 };
}

// ---- Time series -----------------------------------------------------------

/** Sunday-first, matching `Date.getUTCDay()`. */
const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;

/** `2026-09-07` → `Mon 7 Sep` — a tooltip heading someone can place without counting. */
function longDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * Spend per day, stacked by model.
 *
 * BARS, not an area. An area chart of daily totals reads as a mountain range: the eye
 * follows the silhouette instead of comparing days, and picking out which peak is which
 * day means counting along the axis. Discrete days are discrete quantities, so they get
 * discrete marks — and a weekday initial under each one, with the date on Mondays, so the
 * reader can place themselves without counting.
 *
 * Days are continuous (see `continuousDays`), so a quiet stretch reads as quiet rather
 * than being compressed away.
 */
export function StackedBarsOverTime({
  days,
  series,
  height = 186,
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
  const [hover, setHover] = useState<number | null>(null);
  // Which models the reader switched off in the legend. Hiding the dominant model is the
  // only way to see a cheap one: at true scale a model with a hundredth of the spend is a
  // hairline on the baseline.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const shown = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);
  const totals = useMemo(
    () => days.map((_, i) => shown.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)),
    [days, shown],
  );

  const pad = { top: 10, right: 4, bottom: 28, left: 4 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  // Rescale to what is VISIBLE — that is what makes the toggles worth having.
  const max = Math.max(1, ...totals);

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // Never let the reader empty the chart: an all-off state just looks broken.
      return next.size >= series.length ? prev : next;
    });

  if (days.length === 0) return <EmptyChart title={title} />;

  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(22, slot - 2)); // 2px gap between adjacent bars

  return (
    <figure className="cc-chart" ref={ref}>
      <figcaption className="cc-chart-title">{title}</figcaption>
      <div className="cc-plot" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={title}>
            <g transform={`translate(${pad.left},${pad.top})`}>
              <line x1={0} y1={plotH} x2={plotW} y2={plotH} className="cc-axis" />
              {days.map((day, i) => {
                const x = i * slot + (slot - barW) / 2;
                let cursor = 0;
                const segments = shown
                  .map((s) => ({ s, v: s.values[i] ?? 0 }))
                  .filter(({ v }) => v > 0);
                return (
                  <g key={day}>
                    {hover === i && (
                      <rect
                        x={i * slot}
                        y={-pad.top}
                        width={slot}
                        height={plotH + pad.top}
                        className="cc-barhover"
                      />
                    )}
                    {segments.map(({ s, v }, si) => {
                      const h = (v / max) * plotH;
                      const isTop = si === segments.length - 1;
                      // 2px surface gap between stacked segments, taken off the segment so
                      // the column's height still reads as the total.
                      const drawn = Math.max(1, h - (isTop ? 0 : 2));
                      const y = plotH - cursor - h;
                      cursor += h;
                      return (
                        <rect
                          key={s.key}
                          x={x}
                          y={y}
                          width={barW}
                          height={drawn}
                          // Round the data end only — the top of the column.
                          rx={isTop ? Math.min(4, barW / 2) : 0}
                          fill={hueForSeries(s.key)}
                        />
                      );
                    })}
                    {/* Hit target is the whole slot, not the bar. */}
                    <rect
                      x={i * slot}
                      y={-pad.top}
                      width={slot}
                      height={plotH + pad.top}
                      fill="transparent"
                      onMouseEnter={(e) => {
                        setHover(i);
                        setTip({
                          ...tooltipPosition(
                            e.clientX,
                            e.clientY,
                            node.current?.getBoundingClientRect(),
                          ),
                          content: (
                            <>
                              <div className="cc-tip-head">{longDay(day)}</div>
                              {segments
                                .slice()
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
                              {segments.length === 0 && (
                                <div className="cc-tip-row">Nothing this day</div>
                              )}
                              {segments.length > 1 && (
                                <div className="cc-tip-row cc-tip-total">
                                  Total<b>{formatValue(totals[i] ?? 0)}</b>
                                </div>
                              )}
                            </>
                          ),
                        });
                      }}
                      onMouseLeave={() => {
                        setHover(null);
                        setTip(null);
                      }}
                    />
                  </g>
                );
              })}
            </g>
            {days.map((day, i) => {
              const d = new Date(`${day}T00:00:00Z`);
              const isMonday = d.getUTCDay() === 1;
              const isLast = i === days.length - 1;
              const cx = pad.left + i * slot + slot / 2;
              // When the days are packed tight, keep only the anchors rather than a smear
              // of unreadable letters.
              if (slot < 10 && !isMonday && !isLast) return null;
              return (
                <g key={day}>
                  <text x={cx} y={height - 15} textAnchor="middle" className="cc-tick">
                    {WEEKDAY_INITIALS[d.getUTCDay()]}
                  </text>
                  {(isMonday || isLast) && (
                    <text
                      x={cx}
                      y={height - 3}
                      textAnchor="middle"
                      className="cc-tick cc-tick-date"
                    >
                      {day.slice(8)}/{day.slice(5, 7)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip state={tip} />
      </div>
      <ChartLegend series={series} hidden={hidden} onToggle={toggle} />
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
                          setTip({
                            ...tooltipPosition(
                              e.clientX,
                              e.clientY,
                              node.current?.getBoundingClientRect(),
                            ),
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
