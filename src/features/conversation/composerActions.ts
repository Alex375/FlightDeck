// What a user-made composer button can DO.
//
// Deliberately built on the app's existing action registry rather than beside it: the
// panel-opening actions are dispatched through `runAppAction` (the very function the
// ⌘B/⌘J/⌘L chords use), so a button and a shortcut can never mean two different things,
// and Settings → Shortcuts keeps documenting the truth.
//
// The availability rules are PURE and live here, apart from the side effects, because
// they are the zero-silent-error guarantee: a button whose action can't run HERE has to
// say why (greyed out, with a reason), never click into the void or — worse — send a
// slash command that reaches the agent as plain prose while looking like it worked.
import type { BackendKind } from "../../store/conversationsStore";
import type { PermissionMode } from "../../ipc/client";
import { runAppAction } from "../../ui/appActions";
import { backendOfModel, modelLabel } from "./models";
import type { CustomButton } from "./composerLayout";
import type { ShortcutAction } from "../../ui/shortcuts";

export type ComposerActionId =
  | "insert-text"
  | "send-text"
  | "run-command"
  | "apply-config"
  | "toggle-clean-output"
  | "compact"
  | "interrupt"
  | "open-editor"
  | "open-terminal"
  | "open-git"
  | "open-extensions"
  | "open-history"
  | "new-conversation";

/** What the button's `arg` holds, and therefore which editor Settings shows for it. */
export type ArgKind = "none" | "text" | "command" | "config";

export interface ComposerActionDescriptor {
  id: ComposerActionId;
  /** Group heading in the action picker. */
  group: "Write" | "Settings" | "Turn" | "Open";
  label: string;
  hint: string;
  arg: ArgKind;
  /** The shared app action this delegates to, when it is one. */
  appAction?: ShortcutAction;
}

/** Marker for where the caret should land after an insert (dropped from the text). */
export const CARET_MARK = "$|";

export const COMPOSER_ACTIONS: readonly ComposerActionDescriptor[] = [
  {
    id: "insert-text",
    group: "Write",
    label: "Insert text",
    hint: `Type text into the composer without sending. Use ${CARET_MARK} to place the caret.`,
    arg: "text",
  },
  {
    id: "send-text",
    group: "Write",
    label: "Insert and send",
    hint: "Send the text straight away. Your current draft is left untouched.",
    arg: "text",
  },
  {
    id: "run-command",
    group: "Write",
    label: "Run a slash command",
    hint: "Pick from the commands this repository actually offers.",
    arg: "command",
  },
  {
    id: "apply-config",
    group: "Settings",
    label: "Apply a configuration",
    hint: "Set the model, the thinking effort, the permission mode — any combination.",
    arg: "config",
  },
  {
    id: "toggle-clean-output",
    group: "Settings",
    label: "Toggle clean output",
    hint: "Fold or unfold this conversation's intermediate work.",
    arg: "none",
    appAction: "toggle-clean-output",
  },
  { id: "compact", group: "Turn", label: "Compact the conversation", hint: "Send /compact.", arg: "none" },
  { id: "interrupt", group: "Turn", label: "Interrupt", hint: "Stop the turn in progress.", arg: "none" },
  { id: "open-editor", group: "Open", label: "File editor", hint: "Same as ⌘B.", arg: "none", appAction: "toggle-editor" },
  { id: "open-terminal", group: "Open", label: "Terminal", hint: "Same as ⌘J.", arg: "none", appAction: "toggle-terminal" },
  { id: "open-git", group: "Open", label: "Git panel", hint: "Same as ⌘⇧G.", arg: "none", appAction: "toggle-git" },
  { id: "open-extensions", group: "Open", label: "Extensions", hint: "Same as ⌘E.", arg: "none", appAction: "open-extensions" },
  { id: "open-history", group: "Open", label: "History", hint: "Same as ⌘⇧O.", arg: "none", appAction: "open-history" },
  { id: "new-conversation", group: "Open", label: "New conversation", hint: "Same as ⌘N.", arg: "none", appAction: "new-conversation" },
] as const;

const ACTION_BY_ID = new Map<string, ComposerActionDescriptor>(COMPOSER_ACTIONS.map((a) => [a.id, a]));

export function actionById(id: string): ComposerActionDescriptor | null {
  return ACTION_BY_ID.get(id) ?? null;
}

// ---- The "apply a configuration" argument ------------------------------------------

/** Every field optional on purpose: this one action covers "Opus 5 + Extra High" and
 *  "just switch to plan mode" alike, which is why it replaces three narrower ones. */
export interface ConfigArg {
  model?: string;
  effort?: string;
  permission?: PermissionMode;
}

/** Tolerant parse — a hand-edited or truncated blob yields an empty config (the button
 *  then reports "nothing to apply") rather than throwing inside a render. */
export function parseConfigArg(arg: string | undefined): ConfigArg {
  if (!arg) return {};
  try {
    const o = JSON.parse(arg) as Record<string, unknown>;
    const out: ConfigArg = {};
    if (typeof o.model === "string" && o.model) out.model = o.model;
    if (typeof o.effort === "string" && o.effort) out.effort = o.effort;
    if (typeof o.permission === "string" && o.permission) out.permission = o.permission as PermissionMode;
    return out;
  } catch {
    return {};
  }
}

export function serializeConfigArg(cfg: ConfigArg): string {
  return JSON.stringify(cfg);
}

/** One-line recap for the button tooltip and the Settings row. */
export function configSummary(cfg: ConfigArg, permLabel: (m: PermissionMode) => string): string {
  const bits: string[] = [];
  if (cfg.model) bits.push(modelLabel(cfg.model));
  if (cfg.effort) bits.push(cfg.effort);
  if (cfg.permission) bits.push(permLabel(cfg.permission));
  return bits.join(" · ");
}

// ---- Availability (pure) ------------------------------------------------------------

/** Everything the rules need, as DATA — no callbacks, so this stays testable. */
export interface ActionEnv {
  backend: BackendKind;
  /** The backend is frozen (a message has been sent). */
  locked: boolean;
  /** A process is running for this conversation. */
  live: boolean;
  /**
   * Slash-command names available in this cwd, without the leading slash.
   * ⚠️ `null` means NOT KNOWN YET (catalogue still loading) — which must never be read
   * as "the command is missing". Refusing on an empty answer we never received would
   * grey out a perfectly good button every cold start.
   */
  commands: readonly string[] | null;
  /**
   * Whether this composer's host actually has the side panels (editor / terminal / Git).
   * False in the Flight Deck reply modal, which mounts a bare `ConversationPane`.
   * ⚠️ Without this, those buttons looked available there and silently flipped the
   * app-wide, localStorage-persisted layout flags with no visible effect — the same dead
   * click the modal already avoids for file mentions.
   */
  hostHasPanels: boolean;
  /** Effort rungs a given model offers (injected so this file stays pure). */
  effortsFor: (model: string) => readonly string[];
  /** The conversation's current model, for validating an effort-only config. */
  currentModel: string;
  /** Why bypass is refused right now, if it is (see permissions store). */
  bypassBlocked: string | null;
}

export interface Availability {
  ok: boolean;
  /** Shown to the user on a disabled button. Present iff `ok` is false. */
  reason?: string;
}

const OK: Availability = { ok: true };

export function availability(button: CustomButton, env: ActionEnv): Availability {
  const desc = actionById(button.action);
  if (!desc) return { ok: false, reason: "This button's action no longer exists." };

  switch (desc.arg) {
    case "text": {
      // Judge what will actually be inserted, i.e. AFTER the caret marker is stripped.
      // A template of just "$|" passes a raw non-empty check but produces nothing —
      // an enabled button that does nothing when clicked.
      const { text } = splitCaret(button.arg ?? "");
      if (!text.trim()) return { ok: false, reason: "This button has no text to send." };
      break;
    }
    case "command": {
      const name = (button.arg ?? "").trim().replace(/^\//, "");
      if (!name) return { ok: false, reason: "This button has no command." };
      // Unknown catalogue → allow. A command absent from a KNOWN catalogue is refused:
      // sent anyway it would reach the agent as prose, the task would not move, and the
      // failure would look exactly like success.
      if (env.commands && !env.commands.includes(name))
        return { ok: false, reason: `/${name} isn't available in this repository.` };
      break;
    }
    case "config": {
      const cfg = parseConfigArg(button.arg);
      if (!cfg.model && !cfg.effort && !cfg.permission)
        return { ok: false, reason: "This button has nothing to apply." };
      if (cfg.model) {
        const target = backendOfModel(cfg.model);
        if (env.locked && target !== env.backend)
          return {
            ok: false,
            reason: `This conversation is locked to ${env.backend === "codex" ? "Codex" : "Claude"}.`,
          };
      }
      if (cfg.effort) {
        const model = cfg.model ?? env.currentModel;
        const rungs = env.effortsFor(model);
        if (rungs.length && !rungs.includes(cfg.effort))
          return { ok: false, reason: `${modelLabel(model)} has no "${cfg.effort}" effort.` };
      }
      if (cfg.permission) {
        // Judge the permission against the backend this config LANDS on, not the one the
        // conversation happens to be on now: a still-fresh Codex conversation that the
        // same button switches to a Claude model ends up on Claude, where the mode is
        // perfectly valid. Refusing there would reject a button that works.
        const landsOn = cfg.model && !env.locked ? backendOfModel(cfg.model) : env.backend;
        if (landsOn === "codex")
          return { ok: false, reason: "Permission modes are a Claude setting." };
        if (cfg.permission === "bypassPermissions" && env.bypassBlocked)
          return { ok: false, reason: env.bypassBlocked };
      }
      break;
    }
    case "none":
      break;
  }

  if ((desc.id === "compact" || desc.id === "interrupt") && !env.live)
    return { ok: false, reason: "This conversation isn't running." };

  if (PANEL_ACTIONS.has(desc.id) && !env.hostHasPanels)
    return { ok: false, reason: "This view has no side panel — open the conversation in full." };

  return OK;
}

/** Actions that need the host to actually own the side-panel region. */
const PANEL_ACTIONS = new Set<string>(["open-editor", "open-terminal", "open-git"]);

// ---- Execution ---------------------------------------------------------------------

/** The side effects the composer lends to an action. */
export interface ActionHandlers {
  /** Insert at the caret; `caretOffset` is where to leave the caret inside `text`. */
  insert: (text: string, caretOffset: number | null) => void;
  send: (text: string) => void;
  compact: () => void;
  interrupt: () => void;
}

/** Split a template on the caret marker: the text to insert, and where the caret goes
 *  (null when the template has no marker). Only the FIRST marker counts. */
export function splitCaret(template: string): { text: string; caret: number | null } {
  const at = template.indexOf(CARET_MARK);
  if (at < 0) return { text: template, caret: null };
  return { text: template.slice(0, at) + template.slice(at + CARET_MARK.length), caret: at };
}

/**
 * Run a button. Assumes {@link availability} already said yes — the UI disables the
 * button otherwise, so reaching here with a bad config means a bug, not a user error.
 * Returns false when nothing was done, and the caller MUST NOT drop that: a discarded
 * false is a click that reports success while having done nothing.
 *
 * `convId` is the conversation THIS composer belongs to, and is passed through to
 * `runAppAction` rather than letting it fall back to the app's active conversation —
 * see AppActionOptions.convId for why that fallback is wrong here.
 */
export function runComposerAction(
  button: CustomButton,
  convId: string,
  h: ActionHandlers,
  applyConfig: (cfg: ConfigArg) => void,
): boolean {
  const desc = actionById(button.action);
  if (!desc) return false;

  if (desc.appAction) return runAppAction(desc.appAction, { convId });

  switch (desc.id) {
    case "insert-text": {
      const { text, caret } = splitCaret(button.arg ?? "");
      if (!text) return false;
      h.insert(text, caret);
      return true;
    }
    case "send-text": {
      // The marker is meaningless for a straight send — strip it rather than shipping
      // a stray "$|" to the agent.
      const { text } = splitCaret(button.arg ?? "");
      if (!text.trim()) return false;
      h.send(text);
      return true;
    }
    case "run-command": {
      const name = (button.arg ?? "").trim().replace(/^\//, "");
      if (!name) return false;
      h.send("/" + name);
      return true;
    }
    case "apply-config":
      applyConfig(parseConfigArg(button.arg));
      return true;
    case "compact":
      h.compact();
      return true;
    case "interrupt":
      h.interrupt();
      return true;
    default:
      return false;
  }
}
