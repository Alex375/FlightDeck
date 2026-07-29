import { useRef } from "react";
import { ChipBtn, Menu } from "../../ui/kit";
import { EFFORT_LABELS } from "../../agent/subagentMeta";
import { backendOfModel } from "./models";

/**
 * Claude Code reasoning-effort levels (low → max), plus the top "Ultra code" tier.
 * The CLI's runtime `effortLevel` enum is low/medium/high/xhigh/max (binary 2.1.187,
 * `gD`). `max` is the deepest pure-effort level — ABOVE xhigh, which the CLI itself
 * describes as "just below maximum". It was a phantom up to 2.1.186 (a `--effort`
 * spawn alias the runtime control swallowed), promoted to a real runtime level in
 * 2.1.187 — verified live (set it on Opus 4.8 / Sonnet 4.6, read back via
 * get_settings). `ultra` is a Codex-only pure-effort rung ABOVE `max`, reported by
 * gpt-5.6's `model/list` (do NOT confuse it with the Claude `ultracode` app tier).
 * "Ultra code" is NOT an effort value: it is xhigh + a separate `ultracode` flag,
 * handled by the composer. Which levels a model supports is per-model (see
 * effortLevelsForModel); Ultra code only on xhigh-capable Claude models.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "ultracode";

// Display labels are shared with the read-only effort surfaces (FlightDeck card,
// agent meta) via subagentMeta.EFFORT_LABELS so they can never drift.
const LABELS: Record<EffortLevel, string> = EFFORT_LABELS;
// max/ultra sit between xhigh and ultracode: `max` is the top pure-effort rung for
// Claude, `ultra` the deeper Codex-only rung above it (gpt-5.6); `ultracode` (xhigh +
// workflows) stays the app's special top step. The ordering also drives clampEffort —
// keeping max AFTER xhigh means clamping an xhigh request on a max-but-not-xhigh model
// (e.g. legacy Sonnet 4.6) lands on `high`, never jumps UP to max; ultra ranks above max so a
// Codex `ultra` clamps down to `max` on a Claude model, and `ultracode` clamps down to
// `ultra` on a gpt-5.6 Codex model.
const ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];

/** Effort levels a model supports (mirrors the binary's per-model table — `yUe`
 *  gates `max`, `eve` gates `xhigh`; both verified live against 2.1.187). `[]` = no
 *  effort. A level the model doesn't accept is silently swallowed by the CLI, so we
 *  only offer what's safe; the live `get_settings` read-back keeps the gauge honest
 *  if reality ever differs. NOTE: Sonnet 5 accepts `xhigh` (legacy Sonnet 4.6 had `max` but not `xhigh`). */
export function effortLevelsForModel(model: string | null | undefined): EffortLevel[] {
  const m = (model || "").toLowerCase();
  // Codex models: gpt-5.x top out at xhigh; the gpt-5.6 family (sol/terra/luna) adds the
  // deeper `max` + `ultra` pure-effort rungs (reported by `model/list`). `ultra` is a
  // Codex effort, NOT the Claude `ultracode` app tier.
  if (backendOfModel(model) === "codex") {
    if (m.includes("gpt-5.6")) return ["low", "medium", "high", "xhigh", "max", "ultra"];
    return ["low", "medium", "high", "xhigh"];
  }
  if (m.includes("haiku")) return []; // Haiku 4.5 has no effort support → slider hidden
  if (m.includes("opus")) return ["low", "medium", "high", "xhigh", "max"]; // xhigh + max
  if (m.includes("fable")) return ["low", "medium", "high", "xhigh", "max"]; // same tier as Opus
  if (m.includes("sonnet")) return ["low", "medium", "high", "xhigh", "max"]; // Sonnet 5 gained xhigh
  return ["low", "medium", "high"]; // safe fallback
}

/** Slider steps for a model: its levels, plus an Ultra code step if xhigh-capable —
 *  but "Ultra code" (xhigh + standing workflows) is Claude-only, never offered on Codex. */
function stepsForModel(model: string | null | undefined): EffortLevel[] {
  const levels = effortLevelsForModel(model);
  const ultraCapable = backendOfModel(model) === "claude" && levels.includes("xhigh");
  return ultraCapable ? [...levels, "ultracode"] : levels;
}

/** Clamp an effort to what a model supports (highest supported ≤ requested). `steps`
 *  overrides the derived ladder — pass a Codex model's data-driven
 *  `supportedReasoningEfforts` so the clamp matches EXACTLY what the gauge renders (a
 *  Claude-only `max`/Ultra code then clamps down to the model's real top, e.g. xhigh). */
export function clampEffort(
  effort: EffortLevel,
  model: string | null | undefined,
  explicitSteps?: EffortLevel[],
): EffortLevel {
  const steps = explicitSteps && explicitSteps.length ? explicitSteps : stepsForModel(model);
  if (steps.length === 0 || steps.includes(effort)) return effort;
  const reqIdx = ORDER.indexOf(effort);
  let best: EffortLevel | null = null;
  for (const s of steps) {
    const i = ORDER.indexOf(s);
    if (i <= reqIdx && (best === null || i > ORDER.indexOf(best))) best = s;
  }
  return best ?? steps[0];
}

// Thumb geometry — must match the .wf-eff-* CSS (--thumb-size 14px, inset 2px).
const span = "(100% - 18px)";
const posAt = (t: number) => `calc(2px + ${t} * ${span} + 7px)`;
const thumbAt = (t: number) => `calc(2px + ${t} * ${span})`;
// Fill's rounded right cap is centred on the thumb (thumb-centre + track half-height
// of 9px), so the coral wraps the thumb with a uniform 2px ring — symmetric with the
// 2px the thumb is inset on the left at the minimum step.
const fillAt = (t: number) => `calc(2px + ${t} * ${span} + 16px)`;

/**
 * A stepped effort slider modeled on Claude Code's: a pill track with a coral
 * fill, discrete notches and a thumb that snaps between rungs (click or drag).
 * Renders nothing when the model has no effort support (e.g. Haiku).
 */
export function EffortGauge({
  model,
  value,
  onChange,
  portal,
  efforts,
}: {
  model: string | null | undefined;
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  /** Render the popover in a portal — for triggers inside an `overflow`-clipping
   *  container (e.g. a FlightDeck card). See {@link Menu}. */
  portal?: boolean;
  /** Explicit effort steps (Codex: the selected model's real `supportedReasoningEfforts`
   *  from `model/list`, which for gpt-5.6 includes `max`/`ultra`). When omitted, derived
   *  from the model id (`stepsForModel`). Never gets an Ultra code (`ultracode`) step —
   *  that app tier is Claude-only. */
  efforts?: EffortLevel[];
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const steps = efforts && efforts.length ? efforts : stepsForModel(model);
  if (steps.length === 0) return null;

  const last = steps.length - 1;
  const sel = Math.max(0, steps.indexOf(value));
  const current = steps[sel];
  const isUltracode = current === "ultracode";
  // The SLIDER's ultra visual (multicolor fill + pulse + thumb glow) fires for BOTH the Claude
  // `ultracode` tier AND the Codex `ultra` effort — the same small in-slider animation. Only the
  // composer chip's violet tint / the full-screen ultracode blast stay ultracode-only
  // (`isUltracode`); those live outside this component.
  const ultraFx = current === "ultra" || isUltracode;
  const t = last === 0 ? 0 : sel / last;

  const pickFromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const idx = Math.round(frac * last);
    if (steps[idx] !== steps[sel]) onChange(steps[idx]);
  };

  const chip = (
    <ChipBtn icon="bolt" {...(sel > 0 ? { "data-eff-on": "" } : {})} {...(isUltracode ? { "data-ultra": "" } : {})}>
      {LABELS[current]}
    </ChipBtn>
  );

  return (
    <Menu up portal={portal} trigger={chip}>
      <div className="wf-eff" onClick={(e) => e.stopPropagation()}>
        <div className="wf-eff-top">
          <span className="wf-eff-lbl">Thinking effort</span>
          <span className={"wf-eff-cur" + (ultraFx ? " ultra" : "")}>{LABELS[current]}</span>
        </div>

        <div
          ref={trackRef}
          className={"wf-eff-track" + (ultraFx ? " ultra" : "")}
          role="slider"
          aria-label="Thinking effort"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={sel}
          aria-valuetext={LABELS[current]}
          tabIndex={0}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            pickFromX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) pickFromX(e.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" && sel > 0) onChange(steps[sel - 1]);
            else if (e.key === "ArrowRight" && sel < last) onChange(steps[sel + 1]);
          }}
        >
          <div className={"wf-eff-fill" + (ultraFx ? " ultra" : "")} style={{ width: fillAt(t) }} />
          {steps.map((lvl, i) => (
            <span
              key={lvl}
              className={"wf-eff-notch" + (i <= sel ? " on" : "") + (lvl === "ultracode" || lvl === "ultra" ? " ultra" : "")}
              style={{ left: posAt(i / last) }}
            />
          ))}
          <span className={"wf-eff-thumb" + (ultraFx ? " ultra" : "")} style={{ left: thumbAt(t) }} />
        </div>
      </div>
    </Menu>
  );
}
