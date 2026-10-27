// Which OS the app runs on, for what the UI SAYS — shortcut labels above all. What the app can
// DO per OS is the core's answer (`platform_limits`, store/platformLimits.ts); this is only
// about wording, so it is read synchronously from the webview and never has to wait for IPC.
//
// macOS (WKWebView) reports "Macintosh"; Linux (WebKitGTK) "X11; Linux"; Windows (WebView2)
// "Windows". Anything unrecognised counts as a Mac: the shipped platform must never depend on
// this guess.

const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";

/** The app runs on macOS (or on something this check does not recognise). */
export const IS_MAC = !/\b(linux|x11|windows)\b/i.test(userAgent);

/**
 * The word for the machine the app runs on: "Mac" on macOS, "computer" elsewhere. Write it
 * into the sentence (`this ${MACHINE}`, `the ${MACHINE}`, `This {MACHINE}` in JSX) wherever
 * the words mean THIS machine, never "Mac" by hand. A paired server that is a Mac stays "the
 * Mac" on every OS: those words are about the server, not about this machine.
 */
export const MACHINE = IS_MAC ? "Mac" : "computer";

/**
 * The "＋" that help text uses to point at an add button. macOS fonts all carry the
 * full-width U+FF0B; a Linux system without CJK fonts has no glyph for it and draws an empty
 * box, so elsewhere it is the ASCII "+" that every font has.
 */
export const PLUS_SIGN = IS_MAC ? "＋" : "+";

/**
 * A shortcut label written the Mac way ("⌘⇧M", "⌘ B", "⌘⌥ ↑ / ⌘⌥ ↓", "⌘↵"), as this OS
 * spells it: unchanged on a Mac, "Ctrl+Shift+M", "Ctrl+B", "Ctrl+Alt+↑ / Ctrl+Alt+↓",
 * "Ctrl+Enter" elsewhere (and ⇥ → Tab). Write every visible chord through this, never "⌘"
 * by hand.
 *
 * Only the label changes: the chords themselves already match ⌘ OR Ctrl (ui/shortcuts.ts).
 */
export function chordLabel(mac: string, isMac: boolean = IS_MAC): string {
  if (isMac) return mac;
  return mac
    .replace(/⌘/g, "Ctrl+")
    .replace(/⌃/g, "Ctrl+")
    .replace(/⌥/g, "Alt+")
    .replace(/⇧/g, "Shift+")
    .replace(/[↵⏎]/g, "Enter")
    .replace(/⇥/g, "Tab")
    .replace(/(Ctrl|Alt|Shift)\+\s+/g, "$1+");
}
