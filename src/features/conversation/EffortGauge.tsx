import { useRef } from "react";
import { ChipBtn, Ico, Menu } from "../../ui/kit";
import { EFFORT_LABELS, ULTRACODE_LABEL } from "../../agent/subagentMeta";
import { backendOfModel, modelFamily, modelOption } from "./models";

/**
 * Claude Code reasoning-effort levels (low → max).
 * The CLI's runtime `effortLevel` enum is low/medium/high/xhigh/max (binary 2.1.187,
 * `gD`). `max` is the deepest pure-effort level — ABOVE xhigh, which the CLI itself
 * describes as "just below maximum". It was a phantom up to 2.1.186 (a `--effort`
 * spawn alias the runtime control swallowed), promoted to a real runtime level in
 * 2.1.187 — verified live (set it on Opus 4.8 / Sonnet 4.6, read back via
 * get_settings). `ultra` is a Codex-only pure-effort rung ABOVE `max`, reported by
 * `model/list` for the top Codex models (do NOT confuse it with the Claude Ultracode
 * toggle).
 * Ultracode is NOT an effort value: it is a toggle of its own (`ultracode` flag),
 * independent of the effort since CLI 2.1.284 — it no longer forces xhigh and stays on
 * at any level. It sits under the slider ({@link UltracodeSwitch}), Claude-only. Which
 * levels a model supports is per-model (see effortLevelsForModel).
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

// Display labels are shared with the read-only effort surfaces (FlightDeck card,
// agent meta) via subagentMeta.EFFORT_LABELS so they can never drift.
const LABELS: Record<EffortLevel, string> = EFFORT_LABELS;
// `max` is the top pure-effort rung for Claude, `ultra` the deeper Codex-only rung above
// it. The ordering drives clampEffort — keeping max AFTER xhigh means clamping an xhigh
// request on a max-but-not-xhigh model (e.g. legacy Sonnet 4.6) lands on `high`, never
// jumps UP to max; ultra ranks above max so a Codex `ultra` clamps down to `max` on a
// Claude model.
const ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * The effort steps each Codex model REALLY declares, transcribed verbatim from
 * `model/list`'s `supportedReasoningEfforts` (codex-cli 0.156.1). This is only the
 * STATIC fallback — `codexModels.ts` supersedes it per model with the live response.
 *
 * A table keyed by model id, NOT a family heuristic, because the ladder is per MODEL:
 * `gpt-5.6-luna` stops at `max` while its sol/terra siblings go all the way to `ultra`.
 * The old `m.includes("gpt-5.6")` shortcut both over-offered `ultra` on luna and
 * under-offered `max`/`ultra` on any model from a new family (gpt-6-astra) — a break
 * with no error to notice, since the CLI silently swallows an effort it doesn't accept.
 * A model absent from this table falls through to the conservative floor below.
 */
const CODEX_EFFORTS: Record<string, EffortLevel[]> = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
};

/** Effort levels a model supports (mirrors the binary's per-model table — `yUe`
 *  gates `max`, `eve` gates `xhigh`; both verified live against 2.1.187). `[]` = no
 *  effort. A level the model doesn't accept is silently swallowed by the CLI, so we
 *  only offer what's safe; the live `get_settings` read-back keeps the gauge honest
 *  if reality ever differs. NOTE: Sonnet 5 accepts `xhigh` (legacy Sonnet 4.6 had `max` but not `xhigh`). */
export function effortLevelsForModel(model: string | null | undefined): EffortLevel[] {
  const m = (model || "").toLowerCase();
  // Codex models: the verified per-model ladder above, matched on the exact wire id and
  // then through modelFamily (so a longer resolved id still lands on its catalogue entry).
  // `ultra` is a Codex effort, NOT the Claude Ultracode switch.
  if (backendOfModel(model) === "codex") {
    const known = CODEX_EFFORTS[m] ?? CODEX_EFFORTS[modelFamily(m) ?? ""];
    if (known) return [...known];
    // A Codex model we've never seen: offer only the rungs EVERY Codex model has
    // declared so far. Under-offering costs the user a menu step they can reach once
    // the live `model/list` lands; over-offering sends an effort the binary drops on
    // the floor, leaving the gauge claiming a depth the turn never ran at.
    return ["low", "medium", "high", "xhigh"];
  }
  // Claude: the catalogue carries each model's OWN capability tokens, transcribed from
  // the registry baked into the binary — the only way to know that Opus 4.6 / Sonnet 4.6
  // take `max` but not `xhigh`, and that 4.5-and-older have no effort control at all.
  // A resolved live id (`claude-opus-4-8[1m]`) maps back through modelFamily.
  const known = modelOption(model || "") ?? modelOption(modelFamily(model) || "");
  if (known?.caps) {
    if (!known.caps.includes("effort")) return [];
    const levels: EffortLevel[] = ["low", "medium", "high"];
    if (known.caps.includes("xhigh_effort")) levels.push("xhigh");
    if (known.caps.includes("max_effort")) levels.push("max");
    return levels;
  }
  // Unknown id (a model the catalogue doesn't carry): fall back to the family shape.
  if (m.includes("haiku")) return []; // Haiku 4.5 has no effort support → slider hidden
  if (m.includes("opus")) return ["low", "medium", "high", "xhigh", "max"]; // xhigh + max
  if (m.includes("fable")) return ["low", "medium", "high", "xhigh", "max"]; // same tier as Opus
  if (m.includes("sonnet")) return ["low", "medium", "high", "xhigh", "max"]; // Sonnet 5 gained xhigh
  return ["low", "medium", "high"]; // safe fallback
}

/** Whether Ultracode can run on `model` — the CLI's own gate (`ultracodeAvailable`): a
 *  Claude model that takes `xhigh` (Codex never), with workflows enabled. The workflows
 *  half is only known from a live read-back; this is the model half, used where there is
 *  no live session to ask (before the spawn, or on a model just picked). */
export function ultracodeSupportedFor(model: string | null | undefined): boolean {
  return backendOfModel(model) === "claude" && effortLevelsForModel(model).includes("xhigh");
}

/** Clamp an effort to what a model supports (highest supported ≤ requested). `steps`
 *  overrides the derived ladder — pass a Codex model's data-driven
 *  `supportedReasoningEfforts` so the clamp matches EXACTLY what the gauge renders (a
 *  Claude-only `max` then clamps down to the model's real top, e.g. xhigh). */
export function clampEffort(
  effort: EffortLevel,
  model: string | null | undefined,
  explicitSteps?: EffortLevel[],
): EffortLevel {
  const steps = explicitSteps && explicitSteps.length ? explicitSteps : effortLevelsForModel(model);
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

/** The Ultracode toggle under the slider (Claude only — absent for Codex). */
export interface UltracodeSwitch {
  /** Whether Ultracode is on — what RUNS, not merely what was asked for. */
  on: boolean;
  /** Whether it can be turned on here. When false the button is disabled and
   *  `unavailableReason` says why, in visible text (a setting that can't be held is not
   *  offered — and a disabled control's tooltip never renders). */
  available: boolean;
  unavailableReason?: string | null;
  onChange: (on: boolean) => void;
}

/**
 * A stepped effort slider modeled on Claude Code's: a pill track with a coral
 * fill, discrete notches and a thumb that snaps between rungs (click or drag), with the
 * Ultracode toggle button under it. The chip keeps reading the effort alone ("High") and
 * turns violet while Ultracode is on, at any effort.
 * Renders nothing when the model has no effort support (e.g. Haiku).
 */
export function EffortGauge({
  model,
  value,
  onChange,
  portal,
  efforts,
  ultracode,
}: {
  model: string | null | undefined;
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  /** Render the popover in a portal — for triggers inside an `overflow`-clipping
   *  container (e.g. a FlightDeck card). See {@link Menu}. */
  portal?: boolean;
  /** Explicit effort steps (Codex: the selected model's real `supportedReasoningEfforts`
   *  from `model/list`, which for the top models includes `max`/`ultra`). When omitted, derived
   *  from the model id (`effortLevelsForModel`). */
  efforts?: EffortLevel[];
  /** The Ultracode toggle. Omitted → no toggle (Codex has no Ultracode). */
  ultracode?: UltracodeSwitch;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const steps = efforts && efforts.length ? efforts : effortLevelsForModel(model);
  if (steps.length === 0) return null;

  const last = steps.length - 1;
  const sel = Math.max(0, steps.indexOf(value));
  const current = steps[sel];
  const ultracodeOn = !!ultracode?.on;
  // The SLIDER's ultra visual (multicolor fill + pulse + thumb glow) fires for BOTH the Codex
  // `ultra` effort AND a running Claude Ultracode — at whatever effort it runs. Only the chip's
  // violet tint and the full-screen blast stay Ultracode-only; the blast lives outside.
  const ultraFx = current === "ultra" || ultracodeOn;
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
    <ChipBtn icon="bolt" {...(sel > 0 ? { "data-eff-on": "" } : {})} {...(ultracodeOn ? { "data-ultra": "" } : {})}>
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
              className={"wf-eff-notch" + (i <= sel ? " on" : "") + (lvl === "ultra" ? " ultra" : "")}
              style={{ left: posAt(i / last) }}
            />
          ))}
          <span className={"wf-eff-thumb" + (ultraFx ? " ultra" : "")} style={{ left: thumbAt(t) }} />
        </div>

        {ultracode ? <UltracodeToggle sw={ultracode} /> : null}
      </div>
    </Menu>
  );
}

/** The Ultracode toggle: one full-width button — quiet outline when off, the slider's
 *  coral→violet gradient (drifting, with a light sweep) when on. Disabled, it says why
 *  underneath. */
function UltracodeToggle({ sw }: { sw: UltracodeSwitch }) {
  const disabled = !sw.available;
  return (
    <div className="wf-eff-uc">
      <button
        type="button"
        aria-pressed={sw.on}
        disabled={disabled}
        className="wf-eff-uc-btn"
        {...(sw.on ? { "data-on": "" } : {})}
        onClick={() => sw.onChange(!sw.on)}
      >
        <Ico name="bolt" />
        <span>{ULTRACODE_LABEL}</span>
      </button>
      {disabled ? (
        <span className="wf-eff-uc-why">{sw.unavailableReason ?? "Not available in this conversation."}</span>
      ) : null}
    </div>
  );
}
