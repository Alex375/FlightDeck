// Render-null host for the voice agent: registers the app helpers the shared
// executor needs (changeView — same injection as AppControlHost), and drains
// the announcement queue into the Realtime session, one at a time, only while
// the feature is armed. Mounted once in App.
import { useEffect, useRef } from "react";
import { commands } from "../ipc/client";
import type { AppControlHelpers } from "../agent/appControl";
import {
  clearVoiceAnnouncements,
  nextVoiceAnnouncement,
  onVoiceAnnouncement,
  pendingVoiceAnnouncements,
} from "./announce";
import { registerVoiceHelpers, sayAnnouncement } from "./realtime";
import { useVoiceStore } from "./voiceStore";
import type { View } from "../ui/shortcuts";

export function VoiceHost({
  changeView,
  tosseAvailable,
}: {
  changeView: (view: View) => void;
  tosseAvailable: boolean;
}) {
  const changeViewRef = useRef(changeView);
  changeViewRef.current = changeView;
  const tosseRef = useRef(tosseAvailable);
  tosseRef.current = tosseAvailable;

  useEffect(() => {
    const helpers: AppControlHelpers = {
      changeView: (view) => changeViewRef.current(view),
      get tosseAvailable() {
        return tosseRef.current;
      },
    };
    registerVoiceHelpers(helpers);
    // Seed the shared configured mirror once at boot — the chip's visibility,
    // ⌘⇧V's inertness and the announcement gate all read it synchronously.
    void commands
      .voiceAgentStatus()
      .then((s) => useVoiceStore.getState().setConfigured(s))
      .catch((e) => console.error("voice status read failed:", e));
    return () => registerVoiceHelpers(null);
  }, []);

  // Drain announcements sequentially: the `draining` latch guarantees one
  // spoken response at a time; each `sayAnnouncement` resolves at response end.
  const draining = useRef(false);
  useEffect(() => {
    async function drain(): Promise<void> {
      if (draining.current) return;
      draining.current = true;
      try {
        for (let a = nextVoiceAnnouncement(); a; a = nextVoiceAnnouncement()) {
          await sayAnnouncement(a);
          // A dead session means every remaining item would fail the same way
          // (or re-open a session the user just hung up on): drop the backlog
          // instead of retry-spamming session starts on every fleet event.
          if (useVoiceStore.getState().phase === "error") {
            clearVoiceAnnouncements();
            break;
          }
        }
      } catch (e) {
        console.error("voice announcement failed:", e);
      } finally {
        draining.current = false;
        // Something may have been queued while we were finishing the last one.
        if (pendingVoiceAnnouncements() > 0) void drain();
      }
    }
    const un = onVoiceAnnouncement(() => void drain());
    if (pendingVoiceAnnouncements() > 0) void drain();
    return un;
  }, []);

  return null;
}
