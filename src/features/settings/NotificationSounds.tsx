// The "Sounds" card of Settings → Notifications: which sound each of the two events plays
// (ready for review / questions & errors) and how loud. The choices live in the
// notifications store; notificationSound.ts routes them to the Web Audio chimes or to the
// Rust player for the macOS sound files listed here.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands, type AlertSoundLibrary } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import { SOUND_VOLUME_MAX, SOUND_VOLUME_MIN, useNotifications } from "../../store/notifications";
import { COMPOSED_SOUNDS, type ChimeKind } from "../../notifications/sound";
import { NO_SOUND, isComposedSoundId } from "../../notifications/notificationSound";
import { testSound } from "../../notifications/notify";
import { SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";
import { MACHINE } from "../../ui/platform";

async function fetchLibrary(): Promise<AlertSoundLibrary> {
  const r = await commands.listAlertSounds();
  if (r.status !== "ok") throw new Error(r.error);
  return r.data;
}

/** Where a sound id stands against the listed library. */
type Presence = "listed" | "missing" | "unknown";

/**
 * Whether `id` is a sound this Mac offers: a Flight Deck sound or `none` always is; a file is
 * `missing` once the library has loaded without it (deleted since it was picked — it then plays
 * the factory chime), and `unknown` while the library hasn't loaded.
 */
export function soundPresence(id: string, library: AlertSoundLibrary | undefined): Presence {
  if (id === NO_SOUND) return "listed";
  if (isComposedSoundId(id)) return COMPOSED_SOUNDS.some((s) => s.id === id) ? "listed" : "missing";
  if (!library) return "unknown";
  return library.groups.some((g) => g.sounds.some((s) => s.id === id)) ? "listed" : "missing";
}

/** A readable name for an id the picker can't list: the file name without its extension. */
export function fallbackLabel(id: string): string {
  const path = id.slice(id.indexOf(":") + 1);
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function SoundPicker({
  kind,
  value,
  library,
  label,
}: {
  kind: ChimeKind;
  value: string;
  library: AlertSoundLibrary | undefined;
  label: string;
}) {
  const set = useNotifications((s) => s.set);
  const presence = soundPresence(value, library);
  const pick = (id: string) => {
    set(kind === "done" ? { doneSound: id } : { attentionSound: id });
    // Hear it on pick, like the system's own sound pickers.
    if (id !== NO_SOUND) testSound(kind, id);
  };
  return (
    <span className={styles.tokenRow}>
      <select
        className={styles.mono}
        value={value}
        onChange={(e) => pick(e.target.value)}
        aria-label={label}
      >
        {/* A chosen sound the lists don't carry still shows its own name, or the select would
            silently display the first row instead of the truth. */}
        {presence !== "listed" ? (
          <option value={value}>
            {fallbackLabel(value)}
            {presence === "missing" ? " (missing)" : ""}
          </option>
        ) : null}
        <option value={NO_SOUND}>None</option>
        <optgroup label="Flight Deck">
          {COMPOSED_SOUNDS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </optgroup>
        {(library?.groups ?? []).map((g) => (
          <optgroup key={g.id} label={g.label}>
            {g.sounds.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        className={`${styles.btn} ${styles.ghost}`}
        onClick={() => testSound(kind)}
        disabled={value === NO_SOUND}
        aria-label={`Play the ${label.toLowerCase()}`}
      >
        Test
      </button>
    </span>
  );
}

/** The warning under a picker whose file is gone, or null. */
function MissingNote({ id, library }: { id: string; library: AlertSoundLibrary | undefined }) {
  if (soundPresence(id, library) !== "missing") return null;
  return (
    <div className={styles.dangerText}>
      &#9888;&#65039; &ldquo;{fallbackLabel(id)}&rdquo; is no longer on this {MACHINE}, so the default
      sound plays instead. Pick another one.
    </div>
  );
}

export function NotificationSounds() {
  const sound = useNotifications((s) => s.sound);
  const doneSound = useNotifications((s) => s.doneSound);
  const attentionSound = useNotifications((s) => s.attentionSound);
  const volume = useNotifications((s) => s.soundVolume);
  const set = useNotifications((s) => s.set);
  const { data: library, error, refetch } = useQuery({
    queryKey: ["alertSounds"],
    queryFn: fetchLibrary,
  });
  // Re-list when the window comes back: the user may have just dropped a sound into
  // ~/Library/Sounds from Finder (the query's own focus refetch only follows tab visibility).
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  const openFolder = () => {
    const fail = (detail: string) =>
      useAppErrors.getState().pushError("Could not open ~/Library/Sounds", detail);
    void commands
      .openUserSoundsDir()
      .then((r) => {
        if (r.status !== "ok") fail(r.error);
      })
      .catch((e) => fail(String(e)));
  };

  return (
    <SettingsGroup title="Sounds" icon="volume">
      <ToggleRow
        title="Ready for review sound"
        hint={
          <>
            A turn finished cleanly.
            {!sound ? (
              <div className={styles.thintInline}>
                Sound is off above — these play once you turn it back on.
              </div>
            ) : null}
            <MissingNote id={doneSound} library={library} />
          </>
        }
        control={
          <SoundPicker
            kind="done"
            value={doneSound}
            library={library}
            label="Ready for review sound"
          />
        }
      />
      <ToggleRow
        title="Questions & errors sound"
        hint={
          <>
            A question or a permission is waiting, or a turn ended on an open question or an
            error.
            <MissingNote id={attentionSound} library={library} />
          </>
        }
        control={
          <SoundPicker
            kind="attention"
            value={attentionSound}
            library={library}
            label="Questions & errors sound"
          />
        }
      />
      <ToggleRow
        title="Sound volume"
        hint="Both sounds, relative to the default level."
        control={
          <span className={styles.tokenRow}>
            <input
              type="range"
              min={SOUND_VOLUME_MIN}
              max={SOUND_VOLUME_MAX}
              step={0.05}
              value={volume}
              onChange={(e) => set({ soundVolume: Number(e.target.value) })}
              // Hear the new level once the drag ends, not on every step of it.
              onPointerUp={() => testSound("done")}
              onKeyUp={() => testSound("done")}
              aria-label="Sound volume"
            />
            <span className={styles.mono}>{Math.round(volume * 100)}%</span>
          </span>
        }
      />
      {library?.unavailable ? (
        <ToggleRow title="macOS sounds" hint={library.unavailable} />
      ) : error ? (
        <ToggleRow
          title="macOS sounds"
          hint={
            <div className={styles.dangerText}>
              The sounds on this {MACHINE} could not be listed: {String((error as Error).message ?? error)}
            </div>
          }
        />
      ) : (
        <ToggleRow
          title="Your own sounds"
          hint={
            <>
              Drop .aiff, .wav, .m4a, .caf or .mp3 files in{" "}
              <span className={styles.mono}>~/Library/Sounds</span> — they appear in both lists
              under &ldquo;Your sounds&rdquo;.
            </>
          }
          action={
            <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={openFolder}>
              Open folder
            </button>
          }
        />
      )}
    </SettingsGroup>
  );
}
