import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauri } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import { useConversationsStore } from "../../store/conversationsStore";
import { useDisplay } from "../../store/display";
import { useFlightdeckModal } from "../flightdeck/flightdeckModalStore";
import { boxOf } from "../flightdeck/modalZoom";
import { attachPaths } from "./composerAttachments";
import { dropPointToCss, dropZoneOf, useFileDrop, type DropTarget } from "./fileDrop";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** The drop zone under a drop event's cursor position, or null. */
function zoneAt(pos: { x: number; y: number }) {
  const p = dropPointToCss(pos, {
    mac: IS_MAC,
    zoom: useDisplay.getState().uiZoom,
    dpr: window.devicePixelRatio,
  });
  return dropZoneOf(document.elementFromPoint(p.x, p.y));
}

/** Hand dropped paths to the conversation the zone belongs to — the same routine as the
 *  composer's "+" button. A card first opens the reply modal (growing out of that card),
 *  so the user watches the attachments land and writes the message. */
export async function deliverDrop(zone: DropTarget & { el: HTMLElement }, paths: string[]) {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === zone.convId);
  if (!conv) return;
  if (zone.kind === "card") useFlightdeckModal.getState().open(conv.id, boxOf(zone.el));
  const { mentions } = await attachPaths(conv.id, paths, conv.cwd ?? null);
  // The reply modal focuses its own composer on open; a column already on screen is
  // asked to, with the caret after any mention just appended.
  if (zone.kind === "pane" || mentions > 0) useFileDrop.getState().requestFocus(conv.id);
}

/**
 * Receives files dropped from the Finder (mounted once, globally; render-null). Tauri
 * delivers OS drops as native webview events — paths + a cursor position — never as HTML5
 * `drop` events, so this is the ONLY place a drop is seen. While files hover, the zone
 * under the cursor is published for its highlight; on release they go to that zone's
 * conversation. Anywhere else, the drop does nothing. See `fileDrop.ts`.
 */
export function FileDropHost() {
  useEffect(() => {
    if (!isTauri) return;
    const { setOver } = useFileDrop.getState();
    // Only a drag that carries FILES is ours: `over` events have no paths, so remember
    // what `enter` said. (An in-page drag of an image or a text selection has none.)
    let carriesFiles = false;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "leave") {
          carriesFiles = false;
          setOver(null);
          return;
        }
        if (p.type === "enter") carriesFiles = p.paths.length > 0;
        if (!carriesFiles) return;
        const zone = zoneAt(p.position);
        if (p.type === "drop") {
          carriesFiles = false;
          setOver(null);
          if (zone) void deliverDrop(zone, p.paths);
          return;
        }
        setOver(zone ? { convId: zone.convId, kind: zone.kind } : null);
      })
      .then(
        (un) => {
          if (disposed) un();
          else unlisten = un;
        },
        (err) => {
          useAppErrors
            .getState()
            .pushError("Dropping files onto a conversation is unavailable.", String(err));
        },
      );
    return () => {
      disposed = true;
      unlisten?.();
      setOver(null);
    };
  }, []);

  return null;
}
