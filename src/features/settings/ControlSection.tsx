// "Control" tab cards for how agents & the outside world reach the app:
//  - AgentControlGroup — the in-process "flightdeck" MCP server exposed to each
//    conversation's own agent (a localStorage policy read at spawn).
//  - VoiceBridgeGroup — the loopback HTTP MCP server for an EXTERNAL local client.
//  - RemoteAccessGroup — the outbound relay that lets a PHONE drive the app from
//    anywhere (see `appmcp::relay`). The voice-agent card (VoiceAgentSection) is
//    interleaved between these by SettingsPanel.
// Every core-backed card follows the honest-toggle rule: what it shows is the
// post-apply READ-BACK from the core, so a failure shows instead of a switch that lies.
import { Fragment, useCallback, useEffect, useState } from "react";
import { commands, type RemoteStatus, type VoiceBridgeStatus } from "../../ipc/client";
import { useAppControlPrefs } from "../../store/appControl";
import { useCaffeinate } from "../../store/caffeinate";
import {
  createConversationInRepo,
  useConversationsStore,
  useMachines,
} from "../../store/conversationsStore";
import { useSettingsUi } from "../../store/settingsUi";
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

type PairStage = "command" | "confirm" | "manual";

/** Decode a `fdpair:<base64-json>` ticket a server printed, tolerating surrounding
 *  quotes/whitespace. Returns the pre-fill fields, or null if it isn't a valid ticket. */
function parseTicket(raw: string): { label: string; host: string; port: string; user: string } | null {
  try {
    let s = raw.trim();
    const i = s.indexOf("fdpair:");
    if (i >= 0) s = s.slice(i + "fdpair:".length).trim();
    s = s.replace(/[`'"]/g, "");
    const t = JSON.parse(atob(s));
    return {
      label: String(t.label ?? ""),
      host: String(t.host ?? ""),
      port: String(t.port ?? "22"),
      user: String(t.user ?? ""),
    };
  } catch {
    return null;
  }
}

/** The parent of a POSIX path, or null at the root. */
function parentDir(p: string): string | null {
  if (!p || p === "/") return null;
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

/** Join a directory and a child name into a POSIX path. */
function joinDir(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name}`;
}

/** Pair remote SSH servers and open conversations that run on them (the alpha
 *  "machine boundary"). Primary flow: run one command on the server — it authorizes a
 *  Flight-Deck-generated key, checks Claude, and prints a ticket that carries the
 *  connection details back, so the user never has to recall a hostname/user/port.
 *  Typing the details by hand is the last-resort fallback. */
export function RemoteServersGroup() {
  const machines = useMachines();

  // ---- Add-a-server (pairing) flow ----
  const [adding, setAdding] = useState(false);
  const [stage, setStage] = useState<PairStage>("command");
  const [genKey, setGenKey] = useState<{ identityFile: string; publicKey: string } | null>(null);
  const [ticket, setTicket] = useState("");
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- New-conversation-on-a-server flow (inline under a row) ----
  const [convFor, setConvFor] = useState<string | null>(null);
  const [convRepos, setConvRepos] = useState<string[] | null>(null);
  const [convPath, setConvPath] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [browseDirs, setBrowseDirs] = useState<string[] | null>(null);
  const [convError, setConvError] = useState<string | null>(null);

  const resetAdd = useCallback(() => {
    setAdding(false);
    setStage("command");
    setGenKey(null);
    setTicket("");
    setLabel("");
    setHost("");
    setPort("22");
    setUser("");
    setCopied(false);
    setBusy(false);
    setError(null);
  }, []);

  const startAdd = useCallback(async () => {
    setConvFor(null);
    setAdding(true);
    setStage("command");
    setError(null);
    setGenKey(null);
    setTicket("");
    // Generate Flight Deck's dedicated key up front so the command (which embeds its
    // PUBLIC key) is ready immediately — nothing to fill in first.
    const res = await useConversationsStore.getState().generateMachineKey("server");
    if (res.ok) setGenKey({ identityFile: res.key.identity_file, publicKey: res.key.public_key });
    else setError(res.error);
  }, []);

  // The command the user runs ON the server: authorize Flight Deck's key, check Claude,
  // DISCOVER the coords (user / port / a reachable host / label), and print a paste-back
  // ticket. Deliberately single-quote-free so it survives any shell wrapper.
  const serverCommand = genKey
    ? [
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh`,
        `printf "%s\\n" "${genKey.publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
        `command -v claude >/dev/null 2>&1 || printf "NOTE: install Claude Code (curl -fsSL https://claude.ai/install.sh | sh) then run: claude\\n" >&2`,
        `U=$(id -un); P=$(sshd -T 2>/dev/null | sed -n "s/^port //p" | head -1); [ -n "$P" ] || P=22`,
        `if [ -n "$SSH_CONNECTION" ]; then set -- $SSH_CONNECTION; H=$3; else H=$(hostname -I 2>/dev/null | cut -d" " -f1); fi; [ -n "$H" ] || H=$(hostname)`,
        `T=$(printf "{\\"label\\":\\"%s\\",\\"host\\":\\"%s\\",\\"port\\":%s,\\"user\\":\\"%s\\"}" "$(hostname)" "$H" "$P" "$U" | base64 | tr -d "\\n")`,
        `printf "\\n=== Flight Deck pairing ticket — copy the next line ===\\nfdpair:%s\\n" "$T"`,
      ].join("\n")
    : "";

  const copyCmd = useCallback(() => {
    void navigator.clipboard.writeText(serverCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [serverCommand]);

  const continueFromTicket = useCallback(() => {
    const t = parseTicket(ticket);
    if (!t) {
      setError("Couldn't read that ticket — copy the whole fdpair:… line the command printed.");
      return;
    }
    setLabel(t.label);
    setHost(t.host);
    setPort(t.port || "22");
    setUser(t.user);
    setError(null);
    setStage("confirm");
  }, [ticket]);

  const pair = useCallback(async () => {
    setBusy(true);
    setError(null);
    const res = await useConversationsStore.getState().addMachine({
      label: label.trim() || host.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      user: user.trim(),
      identityFile: genKey?.identityFile ?? null,
    });
    setBusy(false);
    if (res.ok) resetAdd();
    else setError(res.error);
  }, [label, host, port, user, genKey, resetAdd]);

  const browseTo = useCallback(async (machineId: string, path: string) => {
    setBrowseDirs(null);
    const listing = await useConversationsStore.getState().listRemoteDir(machineId, path);
    if (!listing) return;
    setBrowsePath(listing.path);
    setBrowseDirs(listing.dirs);
    setConvPath(listing.path); // the path field tracks the browsed folder → "Open here"
  }, []);

  const toggleConv = useCallback(
    async (machineId: string) => {
      if (convFor === machineId) { setConvFor(null); return; }
      setAdding(false);
      setConvFor(machineId);
      setConvRepos(null);
      setConvPath("");
      setConvError(null);
      setBrowsePath("");
      setBrowseDirs(null);
      setDetecting(true);
      // In parallel: detect git repos AND open the browser at the real $HOME (so the
      // path field starts from a folder that actually exists, not a made-up example).
      const store = useConversationsStore.getState();
      const [repos] = await Promise.all([
        store.listRemoteRepos(machineId),
        browseTo(machineId, ""),
      ]);
      setDetecting(false);
      setConvRepos(repos);
    },
    [convFor, browseTo],
  );

  const openConv = useCallback(async (machineId: string, path: string) => {
    const p = path.trim();
    if (!p) return;
    setConvError(null);
    // Create the LEAF folder if it doesn't exist AND its parent does (mkdir, not -p);
    // a wrong parent chain fails here instead of running claude in a bogus directory.
    const prep = await useConversationsStore.getState().prepareRemoteDir(machineId, p);
    if (!prep.ok) { setConvError(prep.error); return; }
    useConversationsStore.getState().addRemoteRepo(machineId, p);
    const id = createConversationInRepo(p, "claude");
    useConversationsStore.getState().selectConversation(id);
    useSettingsUi.getState().closeSettings();
  }, []);

  return (
    <SettingsGroup title="Remote servers (SSH)" icon="globe">
      {machines.length === 0 && !adding && (
        <div className={styles.remoteEmpty}>
          No remote server yet. Pair a Linux box and run conversations on it, over SSH.
        </div>
      )}

      {machines.map((m) => (
        <Fragment key={m.id}>
          <div className={styles.remoteRow}>
            <div className={styles.remoteMain}>
              <span className={styles.remoteName}>{m.label}</span>
              <span className={styles.mono}>
                {m.user}@{m.host}:{m.port}
              </span>
            </div>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              onClick={() => void toggleConv(m.id)}
            >
              New conversation…
            </button>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              onClick={() => useConversationsStore.getState().removeMachine(m.id)}
            >
              Remove
            </button>
          </div>

          {convFor === m.id && (
            <div className={styles.remotePanel}>
              {detecting && (
                <div className={styles.remoteStep}>
                  Looking at <b>{m.label}</b>…
                </div>
              )}

              {convRepos && convRepos.length > 0 && (
                <>
                  <div className={styles.remoteStep}>
                    Repositories detected on <b>{m.label}</b>:
                  </div>
                  <div className={styles.repoList}>
                    {convRepos.map((p) => (
                      <button
                        key={p}
                        className={styles.repoOption}
                        onClick={() => void openConv(m.id, p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Folder browser — the remote stand-in for the native folder picker. */}
              <div className={styles.remoteStep}>
                Or browse <b>{m.label}</b>
                {browsePath ? <> — {browsePath}</> : null}:
              </div>
              <div className={styles.repoList}>
                {parentDir(browsePath) && (
                  <button
                    className={styles.repoOption}
                    onClick={() => void browseTo(m.id, parentDir(browsePath)!)}
                  >
                    ../
                  </button>
                )}
                {browseDirs === null ? (
                  <div className={styles.remoteStep}>…</div>
                ) : browseDirs.length === 0 ? (
                  <div className={styles.remoteStep}>(no sub-folders here)</div>
                ) : (
                  browseDirs.map((d) => (
                    <button
                      key={d}
                      className={styles.repoOption}
                      onClick={() => void browseTo(m.id, joinDir(browsePath, d))}
                    >
                      {d}/
                    </button>
                  ))
                )}
              </div>

              <div className={styles.remoteStep}>
                Folder for the conversation (created if it doesn't exist yet — only the last
                folder, so the parent must be right):
              </div>
              <div className={styles.fieldRow}>
                <input
                  className={styles.field}
                  placeholder="/home/you/project"
                  value={convPath}
                  onChange={(e) => setConvPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void openConv(m.id, convPath);
                  }}
                />
                <button
                  className={`${styles.btn} ${styles.primary}`}
                  disabled={!convPath.trim()}
                  onClick={() => void openConv(m.id, convPath)}
                >
                  Open here
                </button>
              </div>
              {convError && <div className={styles.errorMsg}>{convError}</div>}
              <div className={styles.btnRow}>
                <button className={`${styles.btn} ${styles.ghost}`} onClick={() => setConvFor(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Fragment>
      ))}

      {!adding ? (
        <div className={styles.remoteFooter}>
          <button className={`${styles.btn} ${styles.primary}`} onClick={() => void startAdd()}>
            + Add a server
          </button>
        </div>
      ) : (
        <div className={styles.remotePanel}>
          {stage === "command" && (
            <>
              <div className={styles.remoteStep}>
                <b>1 · Run this once on your server.</b> Open a shell on it (over SSH, or on the
                machine itself) and paste. It authorizes Flight Deck, checks Claude, and prints a
                pairing ticket. Nothing to type here — Flight Deck already made a dedicated key.
              </div>
              {serverCommand ? (
                <>
                  <pre className={styles.codeBlock}>{serverCommand}</pre>
                  <div className={styles.btnRow}>
                    <button className={`${styles.btn} ${styles.ghost}`} onClick={copyCmd}>
                      {copied ? "Copied" : "Copy command"}
                    </button>
                  </div>
                </>
              ) : (
                <div className={styles.remoteStep}>{error ? "" : "Preparing the command…"}</div>
              )}
              <div className={styles.remoteStep}>
                <b>2 · Paste the ticket</b> it printed (the <b>fdpair:…</b> line):
              </div>
              <input
                className={styles.field}
                placeholder="fdpair:…"
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") continueFromTicket();
                }}
              />
              {error && <div className={styles.errorMsg}>{error}</div>}
              <div className={styles.btnRow}>
                <button
                  className={`${styles.btn} ${styles.primary}`}
                  disabled={!ticket.trim()}
                  onClick={continueFromTicket}
                >
                  Continue
                </button>
                <button
                  className={`${styles.btn} ${styles.ghost}`}
                  onClick={() => {
                    setError(null);
                    setStage("manual");
                  }}
                >
                  Enter details manually
                </button>
                <span className={styles.spacer} />
                <button className={`${styles.btn} ${styles.ghost}`} onClick={resetAdd}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {(stage === "confirm" || stage === "manual") && (
            <>
              <div className={styles.remoteStep}>
                {stage === "confirm" ? (
                  <>
                    <b>3 · Confirm the connection</b> — the server filled these in. Fix anything that
                    looks off (e.g. the host/port if it's behind a NAT or a port mapping).
                  </>
                ) : (
                  <>
                    <b>Enter the server's details.</b> A last resort — prefer the pairing command
                    above when you can.
                  </>
                )}
              </div>
              <input
                className={styles.field}
                placeholder="Name (e.g. my-vps)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <input
                className={styles.field}
                placeholder="Host or IP (reachable from this Mac)"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
              <div className={styles.fieldRow}>
                <input
                  className={styles.field}
                  style={{ flex: "0 0 96px" }}
                  inputMode="numeric"
                  placeholder="Port"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                />
                <input
                  className={styles.field}
                  placeholder="User (e.g. root)"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </div>
              {error && <div className={styles.errorMsg}>{error}</div>}
              <div className={styles.btnRow}>
                <button
                  className={`${styles.btn} ${styles.primary}`}
                  disabled={busy || !host.trim() || !user.trim()}
                  onClick={() => void pair()}
                >
                  {busy ? "Testing…" : "Test & pair"}
                </button>
                {stage === "confirm" && (
                  <button
                    className={`${styles.btn} ${styles.ghost}`}
                    onClick={() => {
                      setError(null);
                      setStage("command");
                    }}
                  >
                    Back
                  </button>
                )}
                <span className={styles.spacer} />
                <button className={`${styles.btn} ${styles.ghost}`} onClick={resetAdd}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
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
