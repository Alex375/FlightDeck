// The push-to-talk shortcut — user-customizable, so it lives as DATA in the
// voice prefs rather than in the static ACTION_BINDINGS table (that registry is
// a fixed catalogue; this one key is the user's choice).
//
// Two shapes, one type:
// - A MODIFIER TAP (the default: Right ⌘): pressing and releasing the modifier
//   ALONE toggles the session. The tap must not fire when the modifier was used
//   as part of a chord (⌘C with the right thumb…), so the detector arms on
//   keydown and DISARMS the moment any other key goes down while it is held —
//   only a clean press-and-release counts.
// - A regular KEY CHORD (e.g. ⌘⇧V, F13): matched on keydown with exact
//   modifiers, consuming the event.
//
// Pure helpers here (unit-tested); the listener lives in VoiceHost.

export interface PttShortcut {
  /** `KeyboardEvent.code` — physical key, AZERTY-safe for letters-with-shift
   *  and the only way to distinguish Right from Left modifiers. */
  code: string;
  /** Modifier-tap mode (code names a modifier key; press-and-release alone). */
  tap?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/** The default: a clean tap of the RIGHT command key. */
export const DEFAULT_PTT: PttShortcut = { code: "MetaRight", tap: true };

const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** Human label for the Settings row and tooltips ("Right ⌘", "⌘⇧ V", "F13"). */
export function describePtt(p: PttShortcut): string {
  const names: Record<string, string> = {
    MetaLeft: "Left ⌘",
    MetaRight: "Right ⌘",
    ShiftLeft: "Left ⇧",
    ShiftRight: "Right ⇧",
    AltLeft: "Left ⌥",
    AltRight: "Right ⌥",
    ControlLeft: "Left ⌃",
    ControlRight: "Right ⌃",
  };
  if (p.tap) return names[p.code] ?? p.code;
  const mods = `${p.ctrl ? "⌃" : ""}${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${p.meta ? "⌘" : ""}`;
  const key = p.code.replace(/^Key/, "").replace(/^Digit/, "");
  return mods ? `${mods} ${key}` : key;
}

/** Does this keydown MATCH a chord-mode shortcut (exact modifiers)? Never used
 *  for tap mode — the tap needs the down/up protocol below. */
export function matchesChord(p: PttShortcut, e: KeyboardEvent): boolean {
  if (p.tap) return false;
  return (
    e.code === p.code &&
    e.metaKey === !!p.meta &&
    e.shiftKey === !!p.shift &&
    e.altKey === !!p.alt &&
    e.ctrlKey === !!p.ctrl
  );
}

/**
 * Stateful tap detector for modifier-tap shortcuts. Feed it every keydown and
 * keyup; it invokes `fire` on a clean press-and-release of the configured
 * modifier with NO other key pressed in between.
 */
export function makeTapDetector(getShortcut: () => PttShortcut, fire: () => void) {
  let armed = false;
  return {
    keydown(e: KeyboardEvent): void {
      const p = getShortcut();
      if (!p.tap) return;
      if (e.code === p.code) {
        armed = true;
      } else if (armed) {
        // The modifier is being used as part of a chord — not a tap.
        armed = false;
      }
    },
    keyup(e: KeyboardEvent): void {
      const p = getShortcut();
      if (!p.tap) return;
      if (e.code === p.code) {
        if (armed) fire();
        armed = false;
      }
    },
  };
}

/**
 * Turn a recorded key event into a shortcut, or null when it cannot be one.
 * A modifier key alone → tap shortcut. Any other key → chord with the held
 * modifiers. Escape is reserved (it cancels the recording).
 */
export function shortcutFromEvent(e: KeyboardEvent): PttShortcut | null {
  if (e.code === "Escape") return null;
  if (isModifierCode(e.code)) return { code: e.code, tap: true };
  if (!e.code) return null;
  return {
    code: e.code,
    meta: e.metaKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
    ctrl: e.ctrlKey || undefined,
  };
}
