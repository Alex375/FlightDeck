// "Voice agent" card of the Control tab: the in-app voice assistant (OpenAI
// Realtime). Strictly optional — the whole card revolves around whether an
// OpenAI key is stored (Keychain, via the Rust `voice` module): without one,
// the talk/announcement features stay locked with the reason spelled out, and
// the rest of the app never touches the module. Key handling is honest: save
// verifies by read-back Rust-side, and the UI only ever shows the masked hint.
import { useCallback, useEffect, useState } from "react";
import { commands, type VoiceAgentStatus, type WakeStatus } from "../../ipc/client";
import { useVoiceStore } from "../../voice/voiceStore";
import { useWakeStore } from "../../voice/wakeStore";
import { clampAutoClose, useVoicePrefs } from "../../voice/voicePrefs";
import { applyVadSettings } from "../../voice/realtime";
import { VadMeter } from "../../voice/VadMeter";
import { describePtt, shortcutFromEvent, isModifierCode } from "../../voice/pttShortcut";
import { SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function VoiceAgentSection() {
  const autoCloseSeconds = useVoicePrefs((s) => s.autoCloseSeconds);
  const pttShortcut = useVoicePrefs((s) => s.pttShortcut);
  const vadThreshold = useVoicePrefs((s) => s.vadThreshold);
  const setPrefs = useVoicePrefs((s) => s.set);

  const [status, setStatus] = useState<VoiceAgentStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeDraft, setCloseDraft] = useState<string | null>(null);
  const [wake, setWake] = useState<WakeStatus | null>(null);
  const [wakeBusy, setWakeBusy] = useState(false);

  // Every status learned here also lands in the SHARED voiceStore mirror, so
  // the title-bar chip (and ⌘⇧V / the announcement gate) update immediately —
  // never "save the key, chip appears after an app refocus".
  const publish = useCallback((s: VoiceAgentStatus) => {
    setStatus(s);
    useVoiceStore.getState().setConfigured(s);
  }, []);

  useEffect(() => {
    let disposed = false;
    void commands.voiceAgentStatus().then((res) => {
      if (!disposed && res.status === "ok") publish(res.data);
    });
    return () => {
      disposed = true;
    };
  }, [publish]);

  // Wake-word status: seed here and mirror to the shared store (VoiceHost's
  // trigger gate reads it), so enabling from Settings takes effect immediately.
  useEffect(() => {
    let disposed = false;
    void commands.wakeWordStatus().then((s) => {
      if (disposed) return;
      setWake(s);
      useWakeStore.getState().setStatus(s);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const applyWake = useCallback(
    async (patch: { enabled?: boolean; phrase?: string; sensitivity?: number }) => {
      setWakeBusy(true);
      setError(null);
      try {
        const res = await commands.setWakeWordConfig(
          patch.enabled ?? null,
          patch.phrase ?? null,
          patch.sensitivity ?? null,
        );
        if (res.status === "ok") {
          setWake(res.data);
          useWakeStore.getState().setStatus(res.data);
        } else {
          setError(res.error);
        }
      } finally {
        setWakeBusy(false);
      }
    },
    [],
  );

  const saveKey = useCallback(async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const res = await commands.setVoiceAgentKey(key);
      if (res.status === "ok") {
        publish(res.data);
        setKeyDraft("");
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  }, [keyDraft, publish]);

  const removeKey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await commands.clearVoiceAgentKey();
      if (res.status === "ok") publish(res.data);
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }, [publish]);

  // Shortcut recorder: while recording, the NEXT clean key gesture becomes the
  // push-to-talk shortcut — a lone modifier tap (captured on its keyup, only if
  // nothing else was pressed while it was held) or a regular key chord
  // (captured on keydown). Escape cancels.
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    let modifierArmed: string | null = null;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecording(false);
        return;
      }
      if (isModifierCode(e.code)) {
        modifierArmed = modifierArmed === null ? e.code : null;
        return;
      }
      modifierArmed = null;
      const next = shortcutFromEvent(e);
      if (next) {
        setPrefs({ pttShortcut: next });
        setRecording(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isModifierCode(e.code) && modifierArmed === e.code) {
        setPrefs({ pttShortcut: { code: e.code, tap: true } });
        setRecording(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [recording, setPrefs]);

  const commitAutoClose = useCallback(() => {
    if (closeDraft === null) return;
    const seconds = Number(closeDraft);
    setCloseDraft(null);
    if (Number.isFinite(seconds)) setPrefs({ autoCloseSeconds: clampAutoClose(seconds) });
  }, [closeDraft, setPrefs]);

  const configured = !!status?.configured;

  return (
    <SettingsGroup title="Voice agent" icon="mic">
      <ToggleRow
        title="OpenAI API key"
        hint={
          <>
            The voice agent runs on OpenAI Realtime (speech in, speech out, billed by OpenAI
            per audio minute). The key is stored in the macOS Keychain and never leaves this
            Mac — sessions use short-lived tokens. Flight Deck works fully without one; only
            the voice features need it.
            {error ? <div className={styles.dangerText}>⚠️ {error}</div> : null}
          </>
        }
        control={
          configured ? (
            <span className={styles.tokenRow}>
              <span className={styles.mono}>{status?.key_hint ?? "configured"}</span>
              <button
                className={`${styles.btn} ${styles.ghost}`}
                onClick={() => void removeKey()}
                disabled={busy}
              >
                Remove
              </button>
            </span>
          ) : (
            <span className={styles.tokenRow}>
              <input
                className={styles.keyInput}
                type="password"
                placeholder="sk-…"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveKey();
                }}
                disabled={busy}
                aria-label="OpenAI API key"
              />
              <button
                className={`${styles.btn} ${styles.primary}`}
                onClick={() => void saveKey()}
                disabled={busy || !keyDraft.trim()}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </span>
          )
        }
      />
      <ToggleRow
        title="Voice session & announcements"
        hint={
          configured
            ? "Arm the voice session with the headset button in the title bar. While armed, fleet events (a turn finished, an agent waits on you) are announced aloud and the microphone opens for your reply; the mic button (or the key below) opens and closes the mic at any time. Telling the agent you're done closes the mic — the session stays armed."
            : "Add an OpenAI key above to enable the voice agent."
        }
      />
      <ToggleRow
        title="Push-to-talk key"
        hint="Opens / closes the microphone (arms the session first if needed). A lone modifier works as a tap — press and release it by itself. Click Change, then press the key you want; Escape cancels."
        control={
          <span className={styles.tokenRow}>
            <span className={styles.mono}>{recording ? "Press a key…" : describePtt(pttShortcut)}</span>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              onClick={() => setRecording((r) => !r)}
              disabled={!configured}
            >
              {recording ? "Cancel" : "Change"}
            </button>
          </span>
        }
      />
      <ToggleRow
        title="Close the mic after silence"
        hint="The microphone closes by itself after this many seconds without speech — the cost and privacy guard. The armed session stays up (it exchanges no audio while the mic is closed)."
        control={
          <span className={styles.tokenRow}>
            <input
              className={styles.portInput}
              inputMode="numeric"
              value={closeDraft ?? String(autoCloseSeconds)}
              onChange={(e) => setCloseDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commitAutoClose}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAutoClose();
              }}
              disabled={!configured}
              aria-label="Seconds of silence before hanging up"
            />
            <span className={styles.thintInline}>s</span>
          </span>
        }
      />
      <ToggleRow
        title="Voice detection threshold"
        hint={
          <>
            How loud speech must be before the agent starts listening. Drag the handle right to
            make it less sensitive — it then ignores background noise and faint sounds, so it
            won&rsquo;t cut in or interrupt on stray sound. Drag left to pick up quieter speech.
            You can still interrupt the agent by speaking.
            <VadMeter
              threshold={vadThreshold}
              onThresholdChange={(v) => {
                setPrefs({ vadThreshold: v });
                applyVadSettings();
              }}
              valueClassName={styles.mono}
              buttonClassName={`${styles.btn} ${styles.ghost}`}
              disabled={!configured}
            />
          </>
        }
      />
      <ToggleRow
        title="Wake word"
        hint={
          configured ? (
            <>
              Say the wake word to open the microphone hands-free (like “OK Google”). It runs
              fully on-device — the audio never leaves this Mac, nothing is sent anywhere. Off by
              default; while on, the microphone listens continuously (the macOS mic indicator stays
              lit).
              {wake?.error ? <div className={styles.dangerText}>⚠️ {wake.error}</div> : null}
            </>
          ) : (
            "Add an OpenAI key above first — the wake word opens the voice agent."
          )
        }
        checked={!!wake?.enabled}
        onChange={(next) => void applyWake({ enabled: next })}
        disabled={!configured || !wake || wakeBusy}
      />
      <ToggleRow
        title="Wake phrase"
        hint="What you say to trigger it. “Alexa” is the most robust to a French accent; switch to “Hey Jarvis” if an Amazon Echo nearby keeps waking."
        control={
          <select
            className={styles.mono}
            value={wake?.phrase ?? "alexa"}
            onChange={(e) => void applyWake({ phrase: e.target.value })}
            disabled={!configured || !wake || !wake.enabled || wakeBusy}
            aria-label="Wake phrase"
          >
            {(wake?.phrases ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        }
      />
      <ToggleRow
        title="Sensitivity"
        hint="Higher catches the phrase more easily but risks false triggers; lower is stricter. A false trigger is harmless — it just opens the mic, which closes itself on silence."
        control={
          <span className={styles.tokenRow}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={wake?.sensitivity ?? 0.5}
              onChange={(e) => void applyWake({ sensitivity: Number(e.target.value) })}
              disabled={!configured || !wake || !wake.enabled || wakeBusy}
              aria-label="Wake word sensitivity"
            />
            <span className={styles.thintInline}>
              {Math.round((wake?.sensitivity ?? 0.5) * 100)}%
            </span>
          </span>
        }
      />
    </SettingsGroup>
  );
}
