// Render-null host for the voice agent: registers the app helpers the shared
// executor needs (changeView — same injection as AppControlHost), and drains
// the announcement queue into the Realtime session, one at a time, only while
// the feature is armed. Mounted once in App.
import { useEffect, useRef } from "react";
import type { AppControlHelpers } from "../agent/appControl";
import { nextVoiceAnnouncement, onVoiceAnnouncement, pendingVoiceAnnouncements } from "./announce";
import { registerVoiceHelpers, sayAnnouncement } from "./realtime";
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
