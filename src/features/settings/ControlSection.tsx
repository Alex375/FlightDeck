// "Control" tab cards for how agents & the outside world reach the app:
//  - AgentControlGroup — the in-process "flightdeck" MCP server exposed to each
//    conversation's own agent (a localStorage policy read at spawn).
//  - VoiceBridgeGroup — the loopback HTTP MCP server for an EXTERNAL local client.
//  - RemoteAccessGroup — the outbound relay that lets a PHONE drive the app from
//    anywhere (see `appmcp::relay`). The voice-agent card (VoiceAgentSection) is
//    interleaved between these by SettingsPanel.
// Every core-backed card follows the honest-toggle rule: what it shows is the
// post-apply READ-BACK from the core, so a failure shows instead of a switch that lies.
import { useCallback, useEffect, useState } from "react";
import { commands, type RemoteStatus, type VoiceBridgeStatus } from "../../ipc/client";
import { useAppControlPrefs } from "../../store/appControl";
import { useCaffeinate } from "../../store/caffeinate";
import { SettingsGroup, ToggleRow } from "./SettingsKit";
import styles from "./SettingsPanel.module.css";

export function AgentControlGroup() {
  const agentServer = useAppControlPrefs((s) => s.agentServer);
  const agentRemoveConversations = useAppControlPrefs((s) => s.agentRemoveConversations);
  const setPrefs = useAppControlPrefs((s) => s.set);
  return (
    <SettingsGroup title="Agent control of the app" icon="wand">
      <ToggleRow
        title="Let agents pilot the app"
        hint={
          <>
            New conversations expose the <span className={styles.mono}>flightdeck</span> MCP
            server to their agent: open files in the editor, switch views, create / read /
            message the other conversations, notify you. Applies to sessions started from now
            on — a live conversation keeps what it spawned with until restarted. Nothing that
            destroys data is ever exposed (no permission changes, no history deletes, no
            rewind).
          </>
        }
        checked={agentServer}
        onChange={(next) => setPrefs({ agentServer: next })}
      />
      <ToggleRow
        title="Let agents remove conversations from the list"
        hint={
          <>
            Agents — the voice agent especially — can take a conversation off the active Flight
            Deck list when you ask (&ldquo;clear that one off my board&rdquo;). It&rsquo;s not a
            delete: the history stays on disk, it reopens from the History panel, and ⌘Z brings
            it back. Turn off to keep removal a human-only action.
          </>
        }
        checked={agentRemoveConversations}
        onChange={(next) => setPrefs({ agentRemoveConversations: next })}
      />
    </SettingsGroup>
  );
}

export function VoiceBridgeGroup() {
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
            <span className={styles.mono}>{voice ? `${voice.token.slice(0, 8)}…` : "—"}</span>
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
  );
}

export function RemoteAccessGroup() {
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // Read once on open, then poll so the toggle reflects the live connection
  // (connecting → connected) without needing to reopen the panel.
  useEffect(() => {
    let disposed = false;
    const read = () =>
      void commands.remoteStatus().then((s) => {
        if (!disposed) setRemote(s);
      });
    read();
    const id = setInterval(read, 2500);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, []);

  const apply = useCallback(
    async (patch: { enabled?: boolean; relayUrl?: string; regeneratePairing?: boolean }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await commands.setRemote(
          patch.enabled ?? null,
          patch.relayUrl ?? null,
          patch.regeneratePairing ?? false,
        );
        if (res.status === "ok") setRemote(res.data);
        else setError(res.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Remote access needs the Mac awake; enabling forces Caffeinate "Hard" and
  // snapshots the prior policy so turning it off restores what the user had.
  const onToggle = useCallback(
    (next: boolean) => {
      const SNAP = "tosse:remote:caffSnapshot";
      const caff = useCaffeinate.getState();
      if (next) {
        try {
          localStorage.setItem(SNAP, JSON.stringify({ enabled: caff.enabled, mode: caff.mode }));
        } catch {
          /* storage disabled — best effort */
        }
        caff.set({ enabled: true, mode: "hard" });
      } else {
        try {
          const raw = localStorage.getItem(SNAP);
          if (raw) {
            const s = JSON.parse(raw) as { enabled?: boolean; mode?: string };
            caff.set({ enabled: !!s.enabled, mode: s.mode === "hard" ? "hard" : "light" });
          }
        } catch {
          /* ignore */
        }
      }
      void apply({ enabled: next });
    },
    [apply],
  );

  const copyPairing = useCallback(async () => {
    if (!remote?.pairing_url) return;
    try {
      await navigator.clipboard.writeText(remote.pairing_url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      /* clipboard denied */
    }
  }, [remote]);

  const statusLabel = remote?.enabled ? (remote.connected ? "connected" : "connecting…") : "off";

  return (
    <SettingsGroup title="Remote access (phone)" icon="globe">
      <ToggleRow
        title="Reach your agents from your phone"
        hint={
          <>
            Connects this Mac to a cloud relay so a phone web app can list and drive your
            conversations from anywhere — no local network, no app store. Turning this on keeps
            the Mac awake (Caffeinate) so it can answer; the Mac must stay powered on.
            {remote?.error ? <div className={styles.dangerText}>⚠️ {remote.error}</div> : null}
            {error ? <div className={styles.dangerText}>⚠️ {error}</div> : null}
          </>
        }
        checked={!!remote?.enabled}
        onChange={onToggle}
        disabled={busy || !remote}
      />
      <ToggleRow
        title="Status"
        hint="Whether this Mac is connected to the relay right now."
        control={<span className={styles.mono}>{statusLabel}</span>}
      />
      <ToggleRow
        title="Relay"
        hint="The cloud relay this Mac dials. Change it only if you host your own."
        control={<span className={styles.mono}>{remote?.relay_url ?? "—"}</span>}
      />
      {remote?.enabled ? (
        <>
          <ToggleRow
            title="Pair a phone"
            hint="Scan this QR with your phone's camera to open the app already paired. Keep it private — it grants control of your agents. Regenerating unpairs every phone."
            control={
              <span className={styles.tokenRow}>
                <button
                  className={`${styles.btn} ${styles.ghost}`}
                  onClick={() => void copyPairing()}
                  disabled={!remote.connected || !remote.pairing_url}
                >
                  {linkCopied ? "Copied" : "Copy link"}
                </button>
                <button
                  className={`${styles.btn} ${styles.ghost}`}
                  onClick={() => void apply({ regeneratePairing: true })}
                  disabled={busy}
                >
                  Regenerate
                </button>
              </span>
            }
          />
          {remote.connected && remote.pairing_qr_svg ? (
            <div
              style={{
                background: "#fff",
                padding: 12,
                borderRadius: 12,
                width: 190,
                height: 190,
                margin: "4px auto 10px",
              }}
              dangerouslySetInnerHTML={{ __html: remote.pairing_qr_svg }}
            />
          ) : (
            <ToggleRow
              title=""
              hint={
                remote.connected
                  ? "Preparing the pairing code…"
                  : "Connecting to the relay… the QR appears once connected."
              }
            />
          )}
        </>
      ) : (
        <ToggleRow
          title="Pair a phone"
          hint="Turn on remote access above to reveal the pairing QR. Scanning it before it's on would leave the phone waiting."
        />
      )}
    </SettingsGroup>
  );
}
