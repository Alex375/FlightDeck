// "Voice agent" card of the Control tab: the in-app voice assistant (OpenAI
// Realtime). Strictly optional — the whole card revolves around whether an
// OpenAI key is stored (Keychain, via the Rust `voice` module): without one,
// the talk/announcement features stay locked with the reason spelled out, and
// the rest of the app never touches the module. Key handling is honest: save
// verifies by read-back Rust-side, and the UI only ever shows the masked hint.
import { useCallback, useEffect, useState } from "react";
import { commands, type VoiceAgentStatus } from "../../ipc/client";
import { useVoiceStore } from "../../voice/voiceStore";
import { clampAutoClose, useVoicePrefs } from "../../voice/voicePrefs";
import { SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function VoiceAgentSection() {
  const announcements = useVoicePrefs((s) => s.announcements);
  const autoCloseSeconds = useVoicePrefs((s) => s.autoCloseSeconds);
  const setPrefs = useVoicePrefs((s) => s.set);

  const [status, setStatus] = useState<VoiceAgentStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeDraft, setCloseDraft] = useState<string | null>(null);

  // Every status learned here also lands in the SHARED voiceStore mirror, so
  // the title-bar chip (and ⌘⇧V / the announcement gate) update immediately —
  // never "save the key, chip appears after an app refocus".
  const publish = useCallback((s: VoiceAgentStatus) => {
    setStatus(s);
    useVoiceStore.getState().setConfigured(s);
  }, []);

  useEffect(() => {
    let disposed = false;
    void commands.voiceAgentStatus().then((s) => {
      if (!disposed) publish(s);
    });
    return () => {
      disposed = true;
    };
  }, [publish]);

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
        title="Push-to-talk"
        hint={
          configured
            ? "Click the mic in the title bar (or press ⌘⇧V) to talk to the fleet: statuses, reading replies, sending prompts. The mic is live only during a session."
            : "Add an OpenAI key above to enable the voice agent."
        }
        control={<span className={styles.mono}>⌘⇧V</span>}
      />
      <ToggleRow
        title="Spoken announcements"
        hint="Speak fleet events aloud (a turn finished, an agent waits on you) even without an open session. Announcement sessions are output-only: the microphone stays off."
        checked={announcements}
        onChange={(next) => setPrefs({ announcements: next })}
        disabled={!configured}
      />
      <ToggleRow
        title="Hang up after silence"
        hint="Close an idle voice session after this many seconds — the cost guard (Realtime bills per audio minute)."
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
    </SettingsGroup>
  );
}
