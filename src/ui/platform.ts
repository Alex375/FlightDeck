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
