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
import {
  commands,
  type AddressCandidate,
  type MachineProvisionStatus,
  type MachineRevokeStatus,
  type RemoteStatus,
  type VoiceBridgeStatus,
} from "../../ipc/client";
import { useAppControlPrefs } from "../../store/appControl";
import { useCaffeinate } from "../../store/caffeinate";
import {
  createConversationInRepo,
  useConversationsStore,
  useMachines,
} from "../../store/conversationsStore";
import { useSettingsUi } from "../../store/settingsUi";
import { useNow } from "../../ui/useNow";
import { describeProvisionStatus, describeRevokeStatus } from "./provisionStatus";
import { RemoteFolderPicker } from "./RemoteFolderPicker";
import { ServerBootstrapWizard } from "./ServerBootstrapWizard";
import { ServerStatusPanel } from "./ServerStatusPanel";
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

/** A ticket's decoded address candidates, plus the pre-fill fields carried
 *  alongside them. `addresses` is always non-empty: an old-format ticket (no
 *  `addresses` field) synthesizes a single "manual" candidate from `host`. */
interface ParsedTicket {
  label: string;
  host: string;
  port: string;
  user: string;
  addresses: AddressCandidate[];
}

/** Decode a `fdpair:<base64-json>` ticket a server printed, tolerating surrounding
 *  quotes/whitespace. Returns the pre-fill fields, or null if it isn't a valid ticket.
 *  Exported for the regression test on the addresses/back-compat shape. */
export function parseTicket(raw: string): ParsedTicket | null {
  try {
    let s = raw.trim();
    const i = s.indexOf("fdpair:");
    if (i >= 0) s = s.slice(i + "fdpair:".length).trim();
    s = s.replace(/[`'"]/g, "");
    const t = JSON.parse(atob(s));
    const host = String(t.host ?? "");
    // Old tickets (printed before address discovery existed) carry no `addresses`
    // field at all — tolerate that by synthesizing a single manual candidate from
    // `host`, so the confirm screen always has at least one to show.
    const rawAddresses: unknown[] = Array.isArray(t.addresses) ? t.addresses : [];
    const addresses: AddressCandidate[] = rawAddresses
      .filter((a: unknown): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .map((a) => {
        const kind = a.kind;
        const value = String(a.value ?? "");
        const validKind: AddressCandidate["kind"] = kind === "tailscale" || kind === "lan" ? kind : "manual";
        return { kind: validKind, value };
      })
      .filter((a) => a.value !== "");
    return {
      label: String(t.label ?? ""),
      host,
      port: String(t.port ?? "22"),
      user: String(t.user ?? ""),
      addresses: addresses.length > 0 ? addresses : [{ kind: "manual", value: host }],
    };
  } catch {
    return null;
  }
}

/** Builds the one-line command the user runs ON the server to authorize Flight
 *  Deck's key, note Claude/flightdeckd presence, discover reachable addresses, and
 *  print a paste-back ticket. Exported (pure — takes only the public key) for the
 *  no-real-newlines regression test.
 *
 *  Deliberately single-quote-free so it survives any shell wrapper, and joined with
 *  `"; "` rather than `"\n"`: a serial paste target that submits each line on its own
 *  Enter can leave an unterminated quote/subshell open across a REAL newline,
 *  silently swallowing everything after it — one line (every statement already
 *  self-terminated with `;`/`&&`/`||`) survives that intact. The `\\n` sequences
 *  inside `printf` format strings are or must stay LITERAL two-character
 *  backslash-n — printf itself turns those into real newlines in ITS output; they
 *  must never collapse into a real newline in the script's own source text. */
export function buildServerCommand(publicKey: string): string {
  return [
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh`,
    `printf "%s\\n" "${publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
    // (B14) The official command pipes to `bash`, not `sh` — see
    // `bootstrap::server_setup::install_claude`'s own doc for the citation. This is a
    // best-effort, non-blocking NOTE only (unlike our own ssh probes' hard pairing
    // gate) — it runs in the user's OWN interactive terminal, not a non-interactive
    // ssh batch call, so `command -v claude` is left as-is here.
    `command -v claude >/dev/null 2>&1 || printf "NOTE: install Claude Code (curl -fsSL https://claude.ai/install.sh | bash) then run: claude\\n" >&2`,
    `command -v flightdeckd >/dev/null 2>&1 || printf "NOTE: flightdeckd not found on PATH, ~/.local/bin or /usr/local/bin (needed for persistent sessions)\\n" >&2`,
    `U=$(id -un); P=$(sshd -T 2>/dev/null | sed -n "s/^port //p" | head -1); [ -n "$P" ] || P=22`,
    `if [ -n "$SSH_CONNECTION" ]; then set -- $SSH_CONNECTION; LAN_H=$3; else LAN_H=$(hostname -I 2>/dev/null | cut -d" " -f1); fi`,
    `TS_H=""; if command -v tailscale >/dev/null 2>&1; then TS_H=$(tailscale status --json 2>/dev/null | grep -o '"DNSName":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\\.$//'); fi`,
    `ADDR=""; SEP=""; H=""`,
    `if [ -n "$TS_H" ]; then ADDR="$ADDR$SEP{\\"kind\\":\\"tailscale\\",\\"value\\":\\"$TS_H\\"}"; SEP=","; H="$TS_H"; fi`,
    `if [ -n "$LAN_H" ]; then ADDR="$ADDR$SEP{\\"kind\\":\\"lan\\",\\"value\\":\\"$LAN_H\\"}"; SEP=","; [ -n "$H" ] || H="$LAN_H"; fi`,
    `if [ -z "$H" ]; then MH=$(hostname); ADDR="$ADDR$SEP{\\"kind\\":\\"manual\\",\\"value\\":\\"$MH\\"}"; H="$MH"; fi`,
    `T=$(printf "{\\"label\\":\\"%s\\",\\"host\\":\\"%s\\",\\"port\\":%s,\\"user\\":\\"%s\\",\\"addresses\\":[%s]}" "$(hostname)" "$H" "$P" "$U" "$ADDR" | base64 | tr -d "\\n")`,
    `printf "\\n=== Flight Deck pairing ticket — copy the next line ===\\nfdpair:%s\\n" "$T"`,
  ].join("; ");
}

/** Pair remote SSH servers and open conversations that run on them (the alpha
 *  "machine boundary"). Primary flow (B12): `ServerBootstrapWizard` — type the
 *  connection details once, Flight Deck installs and configures everything else, no
 *  terminal required. Its own secondary link keeps the OLD ticket/command flow
 *  reachable for a server this Mac can only reach with a pre-authorized key.
 *  Each paired server renders as a `ServerStatusPanel` (live diagnosis + repairs). */
export function RemoteServersGroup() {
  const machines = useMachines();

  // ---- Per-server phone-provisioning status (C10/C11) ----
  const [provisionStatuses, setProvisionStatuses] = useState<Map<string, MachineProvisionStatus>>(new Map());
  // ---- Per-server phone-REVOCATION status (C10's critical fix) — whether the
  // OLD token from the last "regenerate pairing" was actually forgotten here. ----
  const [revokeStatuses, setRevokeStatuses] = useState<Map<string, MachineRevokeStatus>>(new Map());
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const now = useNow(30_000);

  // Poll both registries so a background provisioning/revocation attempt
  // (triggered elsewhere — pairing a server, enabling remote access,
  // regenerating pairing) shows up here without the user having to leave and
  // reopen Settings.
  useEffect(() => {
    let disposed = false;
    const read = () => {
      void commands.phoneProvisioningStatus().then((rows) => {
        if (!disposed) setProvisionStatuses(new Map(rows.map((r) => [r.machine_id, r])));
      });
      void commands.phoneRevocationStatus().then((rows) => {
        if (!disposed) setRevokeStatuses(new Map(rows.map((r) => [r.machine_id, r])));
      });
    };
    read();
    const id = setInterval(read, 4000);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, []);

  const retryProvisioning = useCallback((machineId: string) => {
    setRetrying((cur) => new Set(cur).add(machineId));
    void commands
      .retryPhoneProvisioning(machineId)
      .then((res) => {
        if (res.status === "ok") {
          setProvisionStatuses((cur) => new Map(cur).set(machineId, res.data));
        }
        // A command-level error (not a provisioning outcome — e.g. the machine
        // was deleted mid-flight) is transient here: the next poll simply keeps
        // showing whatever the registry already had, never a silent no-op.
      })
      .finally(() => {
        setRetrying((cur) => {
          const next = new Set(cur);
          next.delete(machineId);
          return next;
        });
      });
  }, []);

  // ---- Add-a-server (B12 wizard) ----
  const [wizardOpen, setWizardOpen] = useState(false);

  // ---- New-conversation-on-a-server flow (inline under a row) ----
  const [convFor, setConvFor] = useState<string | null>(null);

  const toggleConv = useCallback((machineId: string) => {
    setWizardOpen(false);
    setConvFor((cur) => (cur === machineId ? null : machineId));
  }, []);

  // When the picker hands back a chosen (existing-or-created) remote folder: register
  // the remote repo, open a conversation in it, and get out of Settings to it.
  const openConv = useCallback((machineId: string, path: string) => {
    useConversationsStore.getState().addRemoteRepo(machineId, path);
    const id = createConversationInRepo(path, "claude");
    useConversationsStore.getState().selectConversation(id);
    useSettingsUi.getState().closeSettings();
  }, []);

  return (
    <SettingsGroup title="Remote servers (SSH)" icon="server">
      {machines.length === 0 && !wizardOpen && (
        <div className={styles.remoteEmpty}>
          No remote server yet. Pair a Linux box and run conversations on it, over SSH.
        </div>
      )}

      {machines.map((m) => (
        <ServerStatusPanel
          key={m.id}
          machine={m}
          provisionLabel={describeProvisionStatus(provisionStatuses.get(m.id), now)}
          revokeLabel={describeRevokeStatus(revokeStatuses.get(m.id), now)}
          isRetrying={retrying.has(m.id)}
          onRetryProvisioning={() => retryProvisioning(m.id)}
          onNewConversation={() => toggleConv(m.id)}
          onRemove={() => useConversationsStore.getState().removeMachine(m.id)}
        >
          {convFor === m.id && (
            <div className={styles.remotePanel}>
              <RemoteFolderPicker
                key={m.id}
                machineId={m.id}
                machineLabel={m.label}
                onOpen={(path) => openConv(m.id, path)}
              />
              <div className={styles.btnRow}>
                <button className={`${styles.btn} ${styles.ghost}`} onClick={() => setConvFor(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </ServerStatusPanel>
      ))}

      {!wizardOpen ? (
        <div className={styles.remoteFooter}>
          <button
            className={`${styles.btn} ${styles.primary}`}
            onClick={() => {
              setConvFor(null);
              setWizardOpen(true);
            }}
          >
            + Add a server
          </button>
        </div>
      ) : (
        <ServerBootstrapWizard onClose={() => setWizardOpen(false)} />
      )}
    </SettingsGroup>
  );
}

export function RemoteAccessGroup() {
  const remoteAnswers = useAppControlPrefs((s) => s.remoteAnswers);
  const setPrefs = useAppControlPrefs((s) => s.set);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // C11: "This Mac's name" — a draft while the user is typing (committed on
  // blur/Enter), the same pattern as the voice bridge's port field above.
  const [labelDraft, setLabelDraft] = useState<string | null>(null);

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
    async (patch: { enabled?: boolean; relayUrl?: string; regeneratePairing?: boolean; macLabel?: string }) => {
      setBusy(true);
      setError(null);
      try {
        const res = await commands.setRemote(
          patch.enabled ?? null,
          patch.relayUrl ?? null,
          patch.regeneratePairing ?? false,
          patch.macLabel ?? null,
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

  // Commit a label edit (blur / Enter). An all-whitespace edit is refused in
  // place — the core treats an empty string as "leave it unchanged", never as
  // "clear the label" (see `set_remote`'s doc), so an empty field must not
  // silently keep showing the OLD label as if nothing happened.
  const commitLabel = useCallback(() => {
    if (labelDraft === null || !remote) return;
    const label = labelDraft.trim();
    setLabelDraft(null);
    if (!label) {
      setError("This Mac's name cannot be empty.");
      return;
    }
    if (label !== remote.mac_label) void apply({ macLabel: label });
  }, [labelDraft, remote, apply]);

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
        title="Answer permission requests remotely"
        hint={
          <>
            Lets a paired phone see the full pending request — tool, command, plan — and answer
            Allow / Deny (questionnaires and plan approvals included). Off: remote clients see
            that something is waiting, but only this Mac can answer. Changing the permission
            MODE stays impossible from remote either way.
          </>
        }
        checked={remoteAnswers}
        onChange={(next) => setPrefs({ remoteAnswers: next })}
      />
      <ToggleRow
        title="This Mac's name"
        hint={`Shown in a paired phone's node list, alongside any paired servers (e.g. "MacBook Pro").`}
        control={
          <input
            className={styles.field}
            style={{ width: 200 }}
            value={labelDraft ?? remote?.mac_label ?? ""}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLabel();
            }}
            disabled={busy || !remote}
            aria-label="This Mac's name"
          />
        }
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
