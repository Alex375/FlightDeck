// Pure keyboard-shortcut decisions for the top-level view switch, lifted out of the
// App effect so they can be unit-tested without a DOM. We match the PHYSICAL key via
// `e.code` ("Digit1"/"Digit2"/"Digit3"), NOT the produced character (`e.key`): on AZERTY
// the digits sit on Shift positions, so under ⌘ `e.key` is "&"/"é"/'"'. ⌘/Ctrl is
// required; Alt or Shift disqualify the chord (so ⌘⇧1, ⌥⌘1, … stay free).

/** `"tosse"` is the CRM task view. Unlike the other two it is CONDITIONAL: it exists only
 *  while signed in to TOSSE (and while the display preference keeps it on), so every place
 *  that switches views has to cope with a target that may not be available — see
 *  `App.changeView`, which falls back rather than showing an empty shell. */
export type View = "conversation" | "flightdeck" | "tosse";

/** The minimal shape of the keyboard event we decide on (a DOM `KeyboardEvent`
 *  satisfies it structurally, so the App handler passes its event straight in). */
export interface ViewShortcutEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Which view a ⌘/Ctrl+digit chord selects, or null if the chord doesn't match. */
export function viewForShortcut(e: ViewShortcutEvent): View | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  if (e.code === "Digit1") return "conversation";
  if (e.code === "Digit2") return "flightdeck";
  // ⌘3 resolves to a view that may not exist right now; the caller decides what to do
  // with it (App ignores it when the TOSSE tab isn't showing), so this stays pure.
  if (e.code === "Digit3") return "tosse";
  return null;
}

/** The minimal shape we decide the undo chord on. Unlike the view chords we read the
 *  PRODUCED character `e.key`, not the physical `e.code` — see [isUndoChord]. */
export interface UndoChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether `e` is the "undo" chord: ⌘/Ctrl+Z, with neither Shift (⌘⇧Z is redo) nor Alt.
 *
 * We match the produced letter `e.key === "z"`, NOT the physical `e.code === "KeyZ"`
 * — the OPPOSITE of the view chords above, on purpose. For a DIGIT, AZERTY puts it on
 * a Shift position so its unshifted `e.key` is a symbol ("&"…) and only `e.code` is
 * stable. For a LETTER it is reversed: `e.key` is the same letter on every layout,
 * while `e.code` names the QWERTY POSITION — and AZERTY's "z" sits where QWERTY has
 * "w" (`code === "KeyW"`). So keying off `e.code === "KeyZ"` would fire undo on the
 * AZERTY user's "w" key and never on the key they read as Z. `e.key` is the
 * layout-robust choice for the undo letter.
 */
export function isUndoChord(e: UndoChordEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === "z";
}

/** The minimal shape we decide the sound-toggle chord on — a LETTER chord, so like
 *  {@link UndoChordEvent} it reads the produced `e.key`, not the physical `e.code`. */
export interface SoundToggleChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether `e` is the "toggle notification sound" chord: ⌘/Ctrl+⇧+M.
 *
 * Like {@link isUndoChord} — and for the same AZERTY reason — we match the PRODUCED
 * letter `e.key === "m"` (case-insensitive), NOT the physical `e.code === "KeyM"`:
 * on AZERTY the M key sits at QWERTY's `Semicolon` position, so keying off `e.code`
 * would fire on the wrong physical key. Shift is REQUIRED because bare ⌘M minimises
 * the window on macOS; Alt disqualifies. This chord is app-global (it never types a
 * character), so App.tsx fires it without the `isEditableTarget` guard the undo
 * chord needs.
 */
export function isSoundToggleChord(e: SoundToggleChordEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey) return false;
  return e.key.toLowerCase() === "m";
}

/** The minimal shape we decide the settings chord on. Like the LETTER chords (and
 *  unlike the digit chords) it reads the produced `e.key`, not the physical `e.code`. */
export interface SettingsChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether `e` is the "open settings" chord: ⌘/Ctrl+, — the macOS-standard Preferences
 * shortcut.
 *
 * We match the PRODUCED character `e.key === ","`, NOT the physical `e.code === "Comma"`
 * — same AZERTY reasoning as {@link isUndoChord}/{@link isSoundToggleChord}, and the
 * OPPOSITE of the digit chords. The comma is a character whose physical position moves
 * between layouts: on AZERTY the key the user reads as "," produces `e.key === ","`
 * UNSHIFTED but sits at QWERTY's `KeyM` position, while `e.code === "Comma"` there is the
 * ";" key. Keying off `e.code` would fire on the wrong physical key and never on the one
 * the user reads as comma. Because "," is unshifted on both QWERTY and AZERTY, Shift
 * disqualifies (keeps ⌘⇧, free); Alt disqualifies too. App-global like the other chords:
 * ⌘, never types a character, so it fires without the editable-target guard.
 */
export function isSettingsChord(e: SettingsChordEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return e.key === ",";
}

/**
 * Whether focus sits in a control that owns its OWN undo, so a global ⌘Z must not be
 * hijacked from it: a text input/textarea/select, any contenteditable, the Monaco
 * editor (`.monaco-editor`), the sidebar rename input, or the xterm terminal
 * (`.xterm`). Pure (takes the element) so it unit-tests under jsdom.
 */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  // A contenteditable host, or a node inside Monaco / the xterm terminal, owns its own
  // undo. `closest` catches both the focused element AND an editable ancestor; matching
  // the contenteditable ATTRIBUTE (rather than the `isContentEditable` IDL prop) keeps
  // this representable under jsdom — and covers the real-browser case just as well.
  return (
    el.closest(
      '.monaco-editor, .xterm, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) != null
  );
}

// ---- Generic ⌘/Ctrl chord table (the app-action shortcuts) ------------------
// On top of the four historical chords above (view switch / undo / sound / settings)
// we drive a small TABLE of extra bindings from one place: the global App handler
// matches an event against each spec and runs the mapped action, and the
// Settings → Shortcuts page renders the same catalogue — one source of truth so a
// wired shortcut and its documentation can never drift.

/** The full keyboard-event shape the generic matcher inspects (a DOM
 *  `KeyboardEvent` satisfies it structurally). */
export interface ChordEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * How to match one chord. ⌘/Ctrl is ALWAYS required. Match on `code` (the PHYSICAL
 * key — for digits and arrows) or on `key` (the PRODUCED character — for letters):
 * the same AZERTY reasoning as the dedicated helpers above (letters are layout-stable
 * under `key`, whereas a letter's `code` names its QWERTY position). `shift`/`alt`
 * default to false and must match EXACTLY, so ⌘L never fires on ⌘⇧L or ⌥⌘L.
 *
 * The plural `codes`/`keys` and `shift: "any"` exist for the ZOOM chords, which are the
 * first ones that genuinely live on several keys at once: ⌘+ is ⌘⇧= on a US layout and a
 * bare ⌘= elsewhere, and every layout also has the numeric keypad's own +/−/0. Matching
 * one spelling only would leave the shortcut dead on half the keyboards.
 */
export interface ChordSpec {
  key?: string;
  code?: string;
  /** Physical keys, any of which matches (superset form of {@link ChordSpec.code}). */
  codes?: readonly string[];
  /** Produced characters, any of which matches (superset form of {@link ChordSpec.key}). */
  keys?: readonly string[];
  /** `false` (default) / `true`: Shift must match exactly. `"any"`: Shift is ignored —
   *  only for a chord whose key REQUIRES Shift on some layouts and not on others. */
  shift?: boolean | "any";
  alt?: boolean;
}

/** Whether `e` matches `spec` — ⌘/Ctrl required, Alt matched exactly, Shift matched exactly
 *  unless `"any"`, and the key compared via `code`/`codes` (physical) then `key`/`keys`
 *  (produced char, case-insensitive). A spec may carry both: the two are OR'd, which is how
 *  one zoom binding covers the main row, the keypad and the layouts that shift the symbol. */
export function matchChord(e: ChordEvent, spec: ChordSpec): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  if (e.altKey !== (spec.alt ?? false)) return false;
  if (spec.shift !== "any" && e.shiftKey !== (spec.shift ?? false)) return false;
  const codes = spec.codes ?? (spec.code ? [spec.code] : []);
  if (codes.includes(e.code)) return true;
  const keys = spec.keys ?? (spec.key ? [spec.key] : []);
  return keys.some((k) => k.toLowerCase() === e.key.toLowerCase());
}

/** The extra actions dispatched by the global handler (beyond the historical
 *  view-switch / undo / sound / settings chords). */
export type ShortcutAction =
  | "toggle-editor"
  | "toggle-terminal"
  | "toggle-git"
  | "toggle-clean-output"
  | "open-extensions"
  | "new-conversation"
  | "prev-conversation"
  | "next-conversation"
  | "open-history"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset";

/** `global` fires anywhere; `conversation` only in the conversation view with an
 *  active conversation (so ⌘B/⌘J/… are inert on the Flight Deck). */
export type BindingScope = "global" | "conversation";

export interface ActionBinding {
  action: ShortcutAction;
  spec: ChordSpec;
  scope: BindingScope;
}

/**
 * The chords added on top of the historical ones. Letters use `key` (AZERTY-robust);
 * the conversation-navigation arrows use `code` (position-stable). These are GLOBAL
 * (they never type a character under ⌘, so they win over the editor's same chord —
 * the VS Code convention). The App handler matches each `spec`; Settings → Shortcuts
 * documents them via {@link SHORTCUT_GROUPS}.
 */
export const ACTION_BINDINGS: ActionBinding[] = [
  { action: "toggle-editor", spec: { key: "b" }, scope: "conversation" },
  { action: "toggle-terminal", spec: { key: "j" }, scope: "conversation" },
  { action: "toggle-git", spec: { key: "g", shift: true }, scope: "conversation" },
  { action: "toggle-clean-output", spec: { key: "l" }, scope: "conversation" },
  { action: "open-extensions", spec: { key: "e" }, scope: "conversation" },
  { action: "new-conversation", spec: { key: "n" }, scope: "global" },
  { action: "prev-conversation", spec: { code: "ArrowUp", alt: true }, scope: "global" },
  { action: "next-conversation", spec: { code: "ArrowDown", alt: true }, scope: "global" },
  { action: "open-history", spec: { key: "o", shift: true }, scope: "global" },
  // Interface zoom — the browser chords, and global on purpose: making the app readable
  // must work from wherever focus happens to be, editor and terminal included (neither
  // binds these). Each covers three spellings of the same key, because none of them is
  // written the same way on every layout:
  //   in    — `Equal` is "=" unshifted on QWERTY *and* AZERTY, and "+" with Shift on both
  //           (hence `shift: "any"`, which also lets the US "⌘+" through); `NumpadAdd` is
  //           the keypad's own +, and the `+` character covers a layout we haven't thought of.
  //   out   — `Minus` is "-" on QWERTY but ")" on AZERTY, where "-" sits on `Digit6`; the
  //           key match covers that (so an AZERTY user's ⌘) also zooms out — harmless, and
  //           preferable to the chord being dead on their "-" key).
  //   reset — `Digit0` is the key PRINTED 0 on both layouts (same reasoning as ⌘1/⌘2), and
  //           the "0" character catches AZERTY's shifted digit; `Numpad0` for the keypad.
  { action: "zoom-in", spec: { codes: ["Equal", "NumpadAdd"], keys: ["+"], shift: "any" }, scope: "global" },
  { action: "zoom-out", spec: { codes: ["Minus", "NumpadSubtract"], keys: ["-"], shift: "any" }, scope: "global" },
  { action: "zoom-reset", spec: { codes: ["Digit0", "Numpad0"], keys: ["0"], shift: "any" }, scope: "global" },
];

// ---- Display catalogue (Settings → Shortcuts) ------------------------------

export interface ShortcutDoc {
  /** Human-readable chord, e.g. "⌘ L" or "⌘⌥ ↑ / ⌘⌥ ↓". */
  keys: string;
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutDoc[];
}

/** Every shortcut the app answers to, grouped by scope, for the Settings recap page.
 *  Kept alongside the dispatch tables above so documentation and behaviour live in one
 *  file. (The historical chords are listed here by hand; the new ones mirror
 *  {@link ACTION_BINDINGS}.) */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Global",
    items: [
      { keys: "⌘ 1", label: "Conversation view" },
      { keys: "⌘ 2", label: "Flight Deck view" },
      { keys: "⌘ 3", label: "TOSSE tasks view (when signed in to TOSSE)" },
      { keys: "⌘ N", label: "New conversation" },
      { keys: "⌘⌥ ↑ / ⌘⌥ ↓", label: "Previous / next conversation" },
      { keys: "⌘⇧ O", label: "Open conversation history" },
      { keys: "⌘⇧ M", label: "Mute / unmute notification sound" },
      { keys: "⌘ ,", label: "Open Settings" },
      { keys: "⌘ Z", label: "Restore the last deleted conversation" },
      { keys: "⌘ + / ⌘ −", label: "Zoom the interface in / out" },
      { keys: "⌘ 0", label: "Reset the zoom to 100%" },
    ],
  },
  {
    title: "Conversation view",
    items: [
      { keys: "⌘ B", label: "Open / close the file editor" },
      { keys: "⌘ J", label: "Open / close the integrated terminal" },
      { keys: "⌘⇧ G", label: "Open / close the Git panel" },
      { keys: "⌘ L", label: 'Toggle the conversation\'s "clean output"' },
      { keys: "⌘ E", label: "Open Extensions (MCP, plugins, skills, sub-agents)" },
    ],
  },
  {
    title: "Composer",
    items: [
      { keys: "↵", label: "Send the message" },
      { keys: "⇧ ↵", label: "New line" },
      { keys: "⇧ ⇥", label: "Change the permission mode" },
      { keys: "↑ / ↓", label: "Recall the previous / next message (at text edge)" },
      { keys: "/", label: "Command menu — ↑↓ navigate, ↵/⇥ select, Esc close" },
    ],
  },
  {
    title: "Editor",
    items: [
      { keys: "⌘ S", label: "Save the file" },
      { keys: "⌘ W", label: "Close the active tab" },
      { keys: "↵ / Esc", label: "Rename: confirm / cancel (tree and sidebar)" },
    ],
  },
  {
    title: "Git & Review",
    items: [
      { keys: "⌘ ↵", label: "Commit (in the message field)" },
      { keys: "⌘ ↵", label: 'Mark "Seen" / send a plan note' },
    ],
  },
  {
    title: "Windows & popovers",
    items: [{ keys: "Esc", label: "Close the active window, popover, or menu" }],
  },
];
