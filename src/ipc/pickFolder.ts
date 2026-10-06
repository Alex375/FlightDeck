// Open a native folder picker in the Tauri app, with a dev/browser fallback.
// The dialog plugin only exists in the real app (window.__TAURI_INTERNALS__);
// in the Vite/Playwright mock we fall back to a prompt so the flow still works.
import { isTauri } from "./provider";

/** Returns the chosen absolute folder path, or null if cancelled. `title` names what the
 *  folder is for in the dialog. */
export async function pickFolder(title = "Choose the working folder"): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      directory: true,
      multiple: false,
      title,
    });
    return typeof sel === "string" ? sel : null;
  }
  // Dev / browser mock — no native dialog available.
  const p = window.prompt("Working folder path:", "");
  return p && p.trim() ? p.trim() : null;
}
