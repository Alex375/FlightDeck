import { useEffect } from "react";
import { commands } from "../ipc/client";
import { useAppErrors } from "../store/appErrors";
import { useDisplay } from "../store/display";
import { formatZoom } from "./zoom";

// Serialize every `set_ui_zoom` IPC so the calls apply in ISSUE ORDER. Holding ⌘+ fires a
// burst of them, and Tauri does not guarantee that concurrent invokes complete in the order
// they were issued — an earlier, smaller factor landing last would leave the window at a
// zoom that matches neither the preference nor what Settings shows. Chaining makes the
// last-issued intent the one the webview ends on. Same discipline as CaffeinateHost.
let zoomChain: Promise<unknown> = Promise.resolve();
function setZoomSerialized(factor: number) {
  const call = zoomChain.then(() => commands.setUiZoom(factor));
  zoomChain = call.catch(() => {}); // keep the chain alive past a rejection
  return call;
}

/**
 * The interface-zoom APPLIER, mounted once globally (render-null). The preference lives in
 * the display prefs (localStorage); the actual scaling is done by the OS webview, which does
 * NOT remember it across launches — so this pushes the stored factor on mount and on every
 * change. A brief 100 % frame at startup is expected: the window is already on screen by the
 * time the first IPC round-trip returns.
 *
 * A failure is surfaced in the app error banner rather than swallowed: otherwise Settings
 * would keep reading "150%" while the window stayed at 100 %, and the user would be left
 * pressing ⌘+ at an interface that never grows.
 */
export function ZoomHost() {
  const zoom = useDisplay((s) => s.uiZoom);

  useEffect(() => {
    void (async () => {
      const res = await setZoomSerialized(zoom);
      if (res.status === "error") {
        useAppErrors
          .getState()
          .pushError(`Couldn't zoom the interface to ${formatZoom(zoom)}.`, res.error);
      }
    })();
  }, [zoom]);

  return null;
}
