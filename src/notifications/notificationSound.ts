// Which sound a notification plays, and how it gets played.
//
// The user picks one sound per event (Settings → Notifications → Sounds). A sound id is
// one of three things:
//   - `flightdeck:<name>` — a Flight Deck sound, synthesized in the webview (sound.ts);
//   - `none` — that event stays silent;
//   - anything else — a macOS sound FILE, listed and played by the Rust `sound` module
//     (`list_alert_sounds` / `play_alert_sound`).
//
// A file can vanish after it was picked (the user cleans ~/Library/Sounds, a macOS update
// drops a tone). An alert must never go silent for that: a failed file play logs the error
// and falls back to the event's factory chime.
import { commands } from "../ipc/client";
import { FACTORY_SOUNDS, useNotifications } from "../store/notifications";
import { playComposed, type ChimeKind } from "./sound";

/** The id of "no sound" for one event. */
export const NO_SOUND = "none";

/** A Flight Deck (synthesized) sound id, as opposed to a sound file or `none`. */
export function isComposedSoundId(id: string): boolean {
  return id.startsWith("flightdeck:");
}

/**
 * Play the sound `id` for event `kind` at `volume`. A file that can't play (gone, or this
 * platform has no player) falls back to `kind`'s factory chime — reported on the console,
 * never thrown.
 */
export function playSound(id: string, kind: ChimeKind, volume: number): void {
  if (id === NO_SOUND) return;
  const fallback = () => playComposed(FACTORY_SOUNDS[kind], volume);
  if (isComposedSoundId(id)) {
    // An unknown Flight Deck id (a sound a later version renamed) plays the factory chime.
    if (!playComposed(id, volume)) fallback();
    return;
  }
  void commands
    .playAlertSound(id, volume)
    .then((r) => {
      if (r.status === "ok") return;
      console.error(`notification sound "${id}" failed:`, r.error);
      fallback();
    })
    .catch((e) => {
      console.error(`notification sound "${id}" threw:`, e);
      fallback();
    });
}

/**
 * Play `kind`'s chosen sound if the sound channel is on. Returns whether a sound was meant
 * to play (off, or `none` for this event, is false) — `notify_user` reports it to the agent.
 */
export function playNotificationSound(kind: ChimeKind): boolean {
  const prefs = useNotifications.getState();
  if (!prefs.sound) return false;
  const id = kind === "done" ? prefs.doneSound : prefs.attentionSound;
  if (id === NO_SOUND) return false;
  playSound(id, kind, prefs.soundVolume);
  return true;
}
