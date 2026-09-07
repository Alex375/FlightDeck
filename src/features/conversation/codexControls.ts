// The Codex-only composer controls, per conversation, persisted to localStorage (pure
// UI state → out of the SQLite metadata store, like workFold/display). The MODEL and
// EFFORT live in the conversation record (shared with Claude, driven by the model
// picker + effort gauge); THIS store holds the axes that only exist for Codex: the
// sandbox/approval PRESET, the network toggle, the reasoning-summary verbosity, and the
// personality. They are folded into a `CodexControls` wire object sent with each user
// message (the app-server applies them as per-turn overrides — there is no settings
// channel; see `supervisor/codex/protocol.rs`).
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { CodexControls } from "../../ipc/bindings";
import type { Conversation } from "../../store/conversationsStore";
import { DEFAULT_CODEX_MODEL, backendOfModel } from "./models";
import { loadJson, saveJson } from "../../store/persist";

const STORAGE_KEY = "tosse:codexcontrols";

export type CodexSandbox = "readOnly" | "workspaceWrite" | "dangerFullAccess";
// `on-failure` was removed from the wire `AskForApproval` enum in codex-cli 0.144.1
// (remaining string variants: `untrusted` | `on-request` | `never`; a `granular` object
// variant also exists but no preset uses it). Our presets only ever send on-request/never.
export type CodexApproval = "untrusted" | "on-request" | "never";
export type CodexSummary = "auto" | "concise" | "detailed" | "none";
export type CodexPersonality = "none" | "friendly" | "pragmatic";

/**
 * The permission PRESET a Codex conversation runs under — the two independent axes
 * (sandbox × approval) collapsed into the four meaningful combinations, mirroring
 * OpenAI's own VS Code dropdown (Read only / Auto / Agent / Full access). ⇧Tab cycles
 * the SAFE ones in the composer (`PRESET_CYCLE`), the analogue of Claude's
 * permission-mode cycle; "Full access" is menu-only (see `PRESET_CYCLE`).
 */
export type CodexPreset = "prudent" | "standard" | "auto" | "danger";

export interface CodexPresetDef {
  label: string;
  hint: string;
  sandbox: CodexSandbox;
  approval: CodexApproval;
  /** CSS accent token, reusing the Claude permission palette (green→red severity). */
  tone: string;
}

// Order = increasing autonomy / decreasing safety. The menu renders `PRESET_ORDER` in
// full; ⇧Tab walks the restricted `PRESET_CYCLE` (both below).
export const CODEX_PRESETS: Record<CodexPreset, CodexPresetDef> = {
  prudent: {
    label: "Cautious",
    hint: "Read-only · asks before acting",
    sandbox: "readOnly",
    approval: "on-request",
    tone: "var(--wf-perm-plan)",
  },
  standard: {
    label: "Standard",
    hint: "Writes in the workspace · asks for the rest",
    sandbox: "workspaceWrite",
    approval: "on-request",
    tone: "var(--wf-perm-default)",
  },
  auto: {
    label: "Auto",
    hint: "Writes in the workspace · without asking",
    sandbox: "workspaceWrite",
    approval: "never",
    tone: "var(--wf-perm-accept)",
  },
  danger: {
    label: "Full access",
    hint: "No sandbox · no approvals",
    sandbox: "dangerFullAccess",
    approval: "never",
    tone: "var(--wf-perm-bypass)",
  },
};
export const PRESET_ORDER: CodexPreset[] = ["prudent", "standard", "auto", "danger"];
// The presets ⇧Tab cycles blindly. "Full access" (no sandbox, no approvals, persisted
// per conversation) is EXCLUDED — mirroring how Claude keeps bypassPermissions out of
// PERM_CYCLE — so one stray keystroke can never disarm the sandbox; it stays reachable
// only through a deliberate menu pick (whose hint spells out the risk). Cycling FROM
// danger (indexOf → -1) lands on the safest preset: ⇧Tab always steps back to safety.
export const PRESET_CYCLE: CodexPreset[] = PRESET_ORDER.filter((p) => p !== "danger");
export const DEFAULT_CODEX_PRESET: CodexPreset = "auto";
export const DEFAULT_CODEX_SUMMARY: CodexSummary = "auto";
export const DEFAULT_CODEX_PERSONALITY: CodexPersonality = "none";

/** The default Codex reasoning effort. The available steps per model are data-driven
 *  (`effortLevelsForModel` / `VALID_EFFORTS`, from `model/list`): older gpt-5.x expose
 *  low/medium/high/xhigh, while the top models (gpt-6-astra, gpt-5.6 sol/terra) add
 *  `max` + the Codex-only `ultra` rung. Never "ultracode" — that app tier is Claude-only. */
export const DEFAULT_CODEX_EFFORT = "xhigh";

/** The per-conversation Codex control state held HERE (model + effort live on the conv
 *  record). Absent fields fall back to the product defaults. */
export interface CodexConvControls {
  preset: CodexPreset;
  /** Network access inside the sandbox (folded into the SandboxPolicy). */
  network: boolean;
  summary: CodexSummary;
  personality: CodexPersonality;
  /** Chosen service tier id (`serviceTiers[].id`, e.g. `priority` = the "Fast" 1.5× tier).
   *  Absent → the model's default tier (the backend picks `defaultServiceTier`). Only
   *  meaningful for models that expose more than one tier. */
  serviceTier?: string;
}

const DEFAULTS: CodexConvControls = {
  preset: DEFAULT_CODEX_PRESET,
  // Network ON by default: Codex can reach the internet from its sandbox (install deps,
  // clone, hit APIs) without the user flipping it each time. Toggle OFF per conversation
  // for a fully offline sandbox.
  network: true,
  summary: DEFAULT_CODEX_SUMMARY,
  personality: DEFAULT_CODEX_PERSONALITY,
};

type ControlsMap = Record<string, Partial<CodexConvControls>>;

const load = (): ControlsMap => loadJson<ControlsMap>(STORAGE_KEY, {});
const save = (m: ControlsMap): void => saveJson(STORAGE_KEY, m);

interface CodexControlsState {
  byConv: ControlsMap;
  /** Patch one conversation's Codex controls (persisted). */
  set: (conv: string, patch: Partial<CodexConvControls>) => void;
  clearConversation: (conv: string) => void;
  clearAll: () => void;
}

export const useCodexControls = create<CodexControlsState>((set) => ({
  byConv: load(),
  set: (conv, patch) =>
    set((s) => {
      const next: ControlsMap = { ...s.byConv, [conv]: { ...s.byConv[conv], ...patch } };
      save(next);
      return { byConv: next };
    }),
  clearConversation: (conv) =>
    set((s) => {
      if (!(conv in s.byConv)) return s;
      const next = { ...s.byConv };
      delete next[conv];
      save(next);
      return { byConv: next };
    }),
  clearAll: () =>
    set(() => {
      save({});
      return { byConv: {} };
    }),
}));

/** This conversation's effective Codex controls (stored patch over the defaults). */
export function codexConvControls(conv: string): CodexConvControls {
  return { ...DEFAULTS, ...(useCodexControls.getState().byConv[conv] ?? {}) };
}

/** Reactive selector for the composer. `useShallow` is REQUIRED: the selector builds a
 *  fresh `{...DEFAULTS, ...patch}` object each call, and without shallow-equality memoization
 *  `useSyncExternalStore` would see a new snapshot every render → infinite re-render loop
 *  ("Maximum update depth exceeded") that crashes the whole conversation view. */
export function useCodexConvControls(conv: string): CodexConvControls {
  return useCodexControls(useShallow((s) => ({ ...DEFAULTS, ...(s.byConv[conv] ?? {}) })));
}

/**
 * Fold a Codex conversation's controls into the `CodexControls` wire object sent with
 * each message: MODEL + EFFORT from the conversation record (the shared picker/gauge),
 * the sandbox/approval from its PRESET, plus network/summary/personality. Returns the
 * exact IPC shape (`bindings.ts`).
 */
export function buildCodexControls(conv: Conversation): CodexControls {
  const cc = codexConvControls(conv.id);
  const preset = CODEX_PRESETS[cc.preset];
  // Guard the model: a Codex conversation must send a Codex model id as the turn
  // override — never a Claude alias (which the binary would reject, failing the turn).
  // Legacy Codex conversations (seeded before the kind-aware default) can carry a Claude
  // alias; fall back to the Codex default for those.
  const model =
    conv.model && backendOfModel(conv.model) === "codex" ? conv.model : DEFAULT_CODEX_MODEL;
  return {
    model,
    effort: conv.effort ?? DEFAULT_CODEX_EFFORT,
    sandbox: preset.sandbox,
    networkAccess: cc.network,
    approvalPolicy: preset.approval,
    summary: cc.summary,
    personality: cc.personality,
    // Unset → null → the backend keeps the model's default tier (Rust `apply_to` skips a
    // `None` service tier). A chosen tier (e.g. `priority`) overrides it for this turn onward.
    serviceTier: cc.serviceTier ?? null,
  };
}

/** Imperative clears for non-React callers (conversation removal / wipe). */
export function clearCodexControls(conv: string): void {
  useCodexControls.getState().clearConversation(conv);
}
export function clearAllCodexControls(): void {
  useCodexControls.getState().clearAll();
}
