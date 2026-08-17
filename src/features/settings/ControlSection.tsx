// "Control" tab: the two app-hosted MCP servers through which agents pilot the
// app. Card 1 — the in-process "flightdeck" server exposed to each conversation's
// own agent (a localStorage policy read at spawn). Card 2 — the voice bridge, a
// loopback HTTP MCP server for an EXTERNAL client (a voice agent), configured in
// the Rust core so it can start with the app. Its rows follow the honest-toggle
// rule: every state shown here is the post-apply READ-BACK from the core
// (`voice_bridge_status`), so a failed bind shows as an error instead of a
// switch that lies.
import { useCallback, useEffect, useState } from "react";
import { commands, type VoiceBridgeStatus } from "../../ipc/client";
import { useAppControlPrefs } from "../../store/appControl";
import { SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function ControlSection() {
  const agentServer = useAppControlPrefs((s) => s.agentServer);
  const setPrefs = useAppControlPrefs((s) => s.set);

  const [voice, setVoice] = useState<VoiceBridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [portDraft, setPortDraft] = useState<string | null>(null);

  // Read the live status on open — never trust a cached value over the core's
  // read-back (the listener may have failed to bind since).
  useEffect(() => {
    let disposed = false;
    void commands.voiceBridgeStatus().then((s) => {
      if (!disposed) setVoice(s);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const apply = useCallback(
    async (patch: { enabled?: boolean; port?: number; regenerateToken?: boolean }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await commands.setVoiceBridge(
          patch.enabled ?? null,
          patch.port ?? null,
          patch.regenerateToken ?? false,
        );
        if (res.status === "ok") setVoice(res.data);
        else setError(res.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const copyToken = useCallback(async () => {
    if (!voice) return;
    try {
      await navigator.clipboard.writeText(voice.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — leave the button label unchanged rather than lying.
    }
  }, [voice]);

  // Commit a port edit (blur / Enter). Out-of-range values are refused in place.
  const commitPort = useCallback(() => {
    if (portDraft === null || !voice) return;
    const port = Number(portDraft);
    setPortDraft(null);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError("Port must be between 1024 and 65535.");
      return;
    }
    if (port !== voice.port) void apply({ port });
  }, [portDraft, voice, apply]);

  const url = voice?.url ?? (voice ? `http://127.0.0.1:${voice.port}/mcp` : "");

  return (
    <>
      <SettingsGroup title="Agent control of the app" icon="wand">
        <ToggleRow
          title="Let agents pilot the app"
          hint={
            <>
              New conversations expose the <span className={styles.mono}>flightdeck</span> MCP
              server to their agent: open files in the editor, switch views, create / read /
              message the other conversations, notify you. Applies to sessions started from now
              on — a live conversation keeps what it spawned with until restarted. Nothing
              destructive is ever exposed (no permission changes, no deletes, no rewind).
            </>
          }
          checked={agentServer}
          onChange={(next) => setPrefs({ agentServer: next })}
        />
      </SettingsGroup>

      <SettingsGroup title="Voice bridge" icon="bell">
        <ToggleRow
          title="Local MCP server for an external agent"
          hint={
            <>
              Lets a voice assistant (or any MCP client on this Mac) follow and drive your
              conversations: list them, read the latest exchanges, send prompts, and wait for
              "turn finished / needs input" events. Listens on 127.0.0.1 only, Bearer-token
              protected. Off by default.
              {voice?.error ? <div className={styles.dangerText}>⚠️ {voice.error}</div> : null}
              {error ? <div className={styles.dangerText}>⚠️ {error}</div> : null}
            </>
          }
          checked={!!voice?.enabled}
          onChange={(next) => void apply({ enabled: next })}
          disabled={busy || !voice}
        />
        <ToggleRow
          title="Endpoint"
          hint={
            voice?.running
              ? "Point the MCP client at this URL (streamable HTTP)."
              : "The URL the server will listen on once enabled."
          }
          control={<span className={styles.mono}>{url}</span>}
        />
        <ToggleRow
          title="Port"
          hint="Change it if another service already uses this port."
          control={
            <input
              className={styles.portInput}
              inputMode="numeric"
              value={portDraft ?? String(voice?.port ?? "")}
              onChange={(e) => setPortDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commitPort}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitPort();
              }}
              disabled={busy || !voice}
              aria-label="Voice bridge port"
            />
          }
        />
        <ToggleRow
          title="Access token"
          hint="Sent by the client as an Authorization: Bearer header. Regenerating revokes the previous one."
          control={
            <span className={styles.tokenRow}>
              <span className={styles.mono}>
                {voice ? `${voice.token.slice(0, 8)}…` : "—"}
              </span>
              <button
                className={`${styles.btn} ${styles.ghost}`}
                onClick={() => void copyToken()}
                disabled={!voice}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                className={`${styles.btn} ${styles.ghost}`}
                onClick={() => void apply({ regenerateToken: true })}
                disabled={busy || !voice}
              >
                Regenerate
              </button>
            </span>
          }
        />
      </SettingsGroup>
    </>
  );
}
