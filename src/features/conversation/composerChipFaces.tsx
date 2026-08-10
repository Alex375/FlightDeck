// The FACE of every composer chip — what you see in the bar, with none of the behaviour
// behind it.
//
// Why this exists: Settings shows an editable preview of the bar, and the preview has to
// be the bar, not a drawing of it. Rendering generic "icon + control name" chips there
// was a lie by omission — the real bar says "Opus 5" behind the Claude mark, "Extra",
// "Auto mode" in its permission colour. Two hand-kept renderings would drift on the
// first change.
//
// So each face lives here once. The live composer uses it as its Menu `trigger`; the
// Settings preview renders the same face with demo values. Nothing about a chip's LOOK
// can differ between the two, because there is only one copy of it.
//
// Every face forwards its extra props to the underlying button: `Menu` clones its
// trigger to inject `onClick` / `data-open`, so a face that swallowed them would render
// a chip whose menu never opens.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChipBtn, ClaudeMark, CodexMark, Ico } from "../../ui/kit";
import { modelLabel } from "./models";
import { EFFORT_LABELS } from "../../agent/subagentMeta";
import type { EffortLevel } from "./EffortGauge";
import { CODEX_PRESETS, type CodexPreset } from "./codexControls";
import type { PermissionMode } from "../../ipc/client";
import type { BackendKind } from "../../store/conversationsStore";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** Permission-mode display names. Lives with the faces because both the live chip and
 *  the Settings preview label the same button with them. */
export const PERMISSION_LABELS: Record<string, string> = {
  auto: "Auto mode",
  default: "Default",
  acceptEdits: "Auto-accept edits",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Bypass permissions",
};

/** Model picker — the backend's brand mark plus the model's short name. */
export function ModelFace({
  backend,
  modelId,
  ...rest
}: { backend: BackendKind; modelId: string } & BtnProps) {
  return (
    <ChipBtn iconNode={backend === "codex" ? <CodexMark /> : <ClaudeMark />} {...rest}>
      {modelLabel(modelId)}
    </ChipBtn>
  );
}

/** Thinking effort — the bolt plus the level, lit when above the floor, violet on Ultra
 *  code (the tier's own tint, which the slider's animation matches). */
export function EffortFace({
  level,
  lit,
  ultra,
  ...rest
}: { level: EffortLevel; lit?: boolean; ultra?: boolean } & BtnProps) {
  return (
    <ChipBtn
      icon="bolt"
      {...(lit ? { "data-eff-on": "" } : {})}
      {...(ultra ? { "data-ultra": "" } : {})}
      {...rest}
    >
      {EFFORT_LABELS[level]}
    </ChipBtn>
  );
}

/** Permission mode — colour-coded per mode via `data-perm`, like the CLI's own display. */
export function PermissionFace({
  mode,
  label,
  ...rest
}: { mode: PermissionMode | string; label: string } & BtnProps) {
  return (
    <ChipBtn icon="shield" data-perm={mode} {...rest}>
      {label}
    </ChipBtn>
  );
}

/** Codex safety preset (sandbox × approval), colour-coded like Claude's permission mode. */
export function CodexSafetyFace({ preset, ...rest }: { preset: CodexPreset } & BtnProps) {
  return (
    <ChipBtn icon="shield" data-codex-preset={preset} {...rest}>
      {CODEX_PRESETS[preset].label}
    </ChipBtn>
  );
}

/** Codex service tier — lit when a non-default (faster) tier is active. */
export function CodexSpeedFace({
  name,
  boosted,
  ...rest
}: { name: string; boosted?: boolean } & BtnProps) {
  return (
    <ChipBtn icon="bolt" data-codex-fast={boosted ? "on" : undefined} {...rest}>
      {name}
    </ChipBtn>
  );
}

/** The remaining Codex-only settings, folded into one icon-only menu. */
export function CodexOptionsFace(rest: BtnProps) {
  return <ChipBtn icon="cog" aria-label="Codex options" {...rest} />;
}

/** Artifacts index — icon plus the count published in this conversation. */
export function ArtifactsFace({ count, ...rest }: { count: number } & BtnProps) {
  return (
    <button type="button" className="wf-chip" aria-label="Artifacts" {...rest}>
      <Ico name="artifact" className="sm" />
      <span className="wf-mono">{count}</span>
    </button>
  );
}

export function ExtensionsFace(rest: BtnProps) {
  return (
    <button type="button" className="wf-chip" aria-label="Extensions" {...rest}>
      <Ico name="layers" className="sm" />
    </button>
  );
}

/** Clean output — borrows the accent when on, like the worktree tick box. */
export function CleanOutputFace({ on, ...rest }: { on: boolean } & BtnProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="wf-chip"
      aria-label="Clean output"
      style={on ? { borderColor: "var(--wf-accent)", color: "var(--wf-accent)" } : undefined}
      {...rest}
    >
      <Ico name="list" className="sm" />
    </button>
  );
}

/** Remote control — the globe, with a status dot while connecting or after a failure. */
export function RemoteFace({
  connecting,
  error,
  ...rest
}: { connecting?: boolean; error?: boolean } & BtnProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={false}
      className="wf-chip cv-rc-chip"
      aria-label="Remote control"
      {...rest}
    >
      <Ico name="globe" className="sm" />
      {connecting ? <span className="wf-dot wait pulse" aria-hidden /> : null}
      {error ? <span className="wf-dot err" aria-hidden /> : null}
    </button>
  );
}

/** Active `/goal` — a target button (only ever rendered while a goal is set). */
export function GoalFace(rest: BtnProps) {
  return <ChipBtn icon="target" className="cv-goal-chip" aria-label="Active goal" {...rest} />;
}

/** Worktree — an explicit tick box so the on/off state is unambiguous. Wider than a
 *  plain chip (52px vs 25px), which is why the slot budget charges it double. */
export function WorktreeFace({ checked, ...rest }: { checked: boolean } & BtnProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className="cv-wt-toggle"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        font: "inherit",
        fontSize: 11,
        cursor: "pointer",
        padding: "4px 9px",
        borderRadius: 7,
        border: `1px solid ${checked ? "var(--wf-accent)" : "var(--wf-line)"}`,
        background: "transparent",
        color: checked ? "var(--wf-accent)" : "var(--wf-tx-lo)",
      }}
      {...rest}
    >
      <span
        style={{
          width: 13,
          height: 13,
          flex: "0 0 auto",
          borderRadius: 3,
          border: `1.5px solid ${checked ? "var(--wf-accent)" : "var(--wf-line-2)"}`,
          background: checked ? "var(--wf-accent)" : "transparent",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#1a0f0a",
          fontSize: 10,
          lineHeight: 1,
        }}
      >
        {checked ? "✓" : ""}
      </span>
      <Ico name="branch" className="sm" />
      <span className="cv-wt-label">Worktree</span>
    </button>
  );
}

/** A user-made button's face — icon only, by design. */
export function CustomFace({
  icon,
  off,
  ...rest
}: { icon: string; off?: boolean } & BtnProps): ReactNode {
  return (
    <button type="button" className="wf-chip cv-custom-btn" data-off={off ? "" : undefined} {...rest}>
      <Ico name={icon} className="sm" />
    </button>
  );
}
