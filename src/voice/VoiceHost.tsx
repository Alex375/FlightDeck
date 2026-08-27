// Render-null host for the voice agent: registers the app helpers the shared
// executor needs (changeView — same injection as AppControlHost), and drains
// the announcement queue into the Realtime session, one at a time, only while
// the feature is armed. Mounted once in App.
import { useEffect, useRef } from "react";
import { commands, events } from "../ipc/client";
import type { AppControlHelpers } from "../agent/appControl";
import {
  clearVoiceAnnouncements,
  nextVoiceAnnouncement,
  onVoiceAnnouncement,
  pendingVoiceAnnouncements,
} from "./announce";
import { registerVoiceHelpers, sayAnnouncement, toggleMic } from "./realtime";
import { useVoiceStore } from "./voiceStore";
import { useVoicePrefs } from "./voicePrefs";
import { makeTapDetector, matchesChord } from "./pttShortcut";
import { wakeTrigger } from "./wake";
import { useWakeStore, wakeEnabled } from "./wakeStore";
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
      .then((res) => {
        if (res.status === "ok") useVoiceStore.getState().setConfigured(res.data);
        else console.error("voice status read failed:", res.error);
      })
      .catch((e) => console.error("voice status read failed:", e));
    return () => registerVoiceHelpers(null);
  }, []);

  // The push-to-talk key — customizable, so matched from the pref (live read,
  // no re-subscribe) rather than the static ACTION_BINDINGS table. It toggles
  // the MICROPHONE (arming the session first from cold). A modifier TAP (the
  // Right ⌘ default) fires on a clean press-and-release only — using the same
  // key inside a chord (⌘C with the right thumb) never triggers it. Inert
  // without a configured key: the event is left untouched.
  useEffect(() => {
    const fire = () => {
      if (useVoiceStore.getState().configured === true) void toggleMic();
    };
    const tap = makeTapDetector(() => useVoicePrefs.getState().pttShortcut, fire);
    const onKeyDown = (e: KeyboardEvent) => {
      tap.keydown(e);
      const p = useVoicePrefs.getState().pttShortcut;
      if (!p.tap && matchesChord(p, e) && useVoiceStore.getState().configured === true) {
        e.preventDefault();
        fire();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => tap.keyup(e);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Wake word: seed the status mirror, then react to a detected phrase exactly
  // like a spoken push-to-talk — open the microphone. The whole gate (a key is
  // configured, the wake word is enabled, and the agent isn't mid-sentence) lives
  // in wakeTrigger/shouldFireWake. The Rust detector only emits while enabled, so
  // this listener is inert until the user opts in.
  useEffect(() => {
    let disposed = false;
    void commands
      .wakeWordStatus()
      .then((s) => {
        if (!disposed) useWakeStore.getState().setStatus(s);
      })
      .catch((e) => console.error("wake status read failed:", e));
    const un = events.wakeWordEvent.listen(() => {
      if (!disposed) void wakeTrigger(wakeEnabled());
    });
    return () => {
      disposed = true;
      void un.then((f) => f()).catch(() => {});
    };
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
          // The mode was disarmed or the session died: every remaining item
          // is stale (announcements only exist while armed) — drop the backlog
          // instead of retry-spamming or resurrecting a session.
          const st = useVoiceStore.getState();
          if (!st.mode || st.phase === "error") {
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
