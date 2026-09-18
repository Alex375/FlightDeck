// The inline "sign in to Claude on this server" flow — shared by ServerBootstrapWizard
// (case c: the pipeline reached ClaudeAuth and it wasn't signed in) and ServerStatusPanel
// (the "Sign in to Claude" action on a `needs_claude_sign_in` diagnosis).
//
// Deliberately NOT routed through `machine_repair`'s `SignInClaude` action even though
// ServerStatusPanel's other repairs are: that action's `RepairOutcome` only carries a
// human summary string ("sign-in session <id> started"), never the structured
// `LoginSession` handle `submit_claude_login_code`/`cancel_claude_login` need — so a
// repair-started login could show the URL (via `ServerLoginPromptEvent`, keyed by
// `machine_id`) but never let the user actually submit a code. This calls
// `start_claude_login` directly instead, exactly like the wizard, which DOES get the
// handle back synchronously. See `deviations_from_brief` in the B12 report.
//
// ⚠️ Single-flight (B-finding #4): `start()` below ATTACHES to a machine's existing
// session rather than starting a competing one (the backend's own semantics — see
// `bootstrap::server_setup::start_claude_login`'s doc) — starting a second sign-in for
// the same server used to silently kill the first, with zero UI feedback. Only the
// explicit "Restart sign-in" button (`restart()`, shown once a session is in flight)
// replaces one, via `restart_claude_login` — the session it replaces is told via a
// `ServerLoginResultEvent{ok:false, error:"superseded…"}`, rendered here exactly like
// any other failed result. `claudeLoginSessions.ts`'s shared `active` flag (set the
// instant `start`/`restart` succeeds here, cleared on a same-caller Cancel/unmount OR
// on ANY `ServerLoginResultEvent` for this machine) is what lets a SECOND surface
// (`ServerStatusPanel`) show "Sign-in in progress…" instead of its own Start button
// before ever needing to call `start()` itself.
//
// ⚠️ Ownership (follow-up review of B-finding #4): ATTACHING to a session you did not
// start is not the same as OWNING it. `LoginSession.owned` (`false` on attach, `true`
// on reserve/restart) is tracked in `ownsSessionRef` below and gates every place this
// component would otherwise tear the session down (`cancel()`, unmount cleanup): an
// attached instance's Cancel/unmount only detaches LOCALLY (clears its own `session`/
// `url` state) and never calls `cancelClaudeLogin` or flips the shared `active` flag —
// leaving the session running for whoever still owns it. Before this existed, ANY
// holder's Cancel/unmount silently killed the shared session out from under every
// other surface watching it, reproducing the exact "silently killed, zero UI feedback"
// bug class the single-flight fix was meant to close, just via teardown instead of a
// competing Start.
//
// ⚠️ Stale-event filtering (same follow-up review): both listeners below ignore an
// event whose `session_id` doesn't match the session THIS instance currently tracks
// (`sessionRef.current`) — except when it tracks none yet, so a late subscriber can
// still adopt a freshly (re-)emitted prompt/result for its own just-started/attached
// session (see `start_claude_login`'s re-emit-on-attach doc). This is what closes the
// "Restart sign-in" race: `restart()` sets `session` to the NEW session synchronously
// once its own IPC call resolves — which observed evidence shows happens BEFORE the
// OLD, just-superseded session's own belated terminal event arrives — so by the time
// that stale event is processed, its `session_id` no longer matches and it is dropped
// instead of clobbering the new session's state with a false "Sign-in failed:
// superseded…".
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, events, type LoginSession } from "../../ipc/client";
import { ensureClaudeLoginSessionsWired, useClaudeLoginSessions } from "./claudeLoginSessions";
import { isTrustedSignInUrl } from "./serverBootstrapModel";
import styles from "./SettingsPanel.module.css";

export function ClaudeSignInInline({
  machineId,
  onSignedIn,
}: {
  machineId: string;
  /** Fired once, only on a CONFIRMED successful sign-in — callers refresh whatever
   *  they show of Claude's status (the wizard's checklist detail, the status panel's
   *  diagnosis) off this rather than guessing from local state. */
  onSignedIn?: (email: string | null) => void;
}) {
  const [session, setSession] = useState<LoginSession | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; email: string | null; error: string | null } | null>(null);

  // Tracks the live session for the unmount-only cleanup effect below (which can't
  // close over `session` directly without re-subscribing on every change) AND for the
  // event listeners' stale-event filtering (see the module doc).
  const sessionRef = useRef<LoginSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Whether THIS instance owns (reserved/restarted) the current session, as opposed to
  // merely attaching to one another surface started — see `LoginSession.owned`'s own
  // doc and the module doc above. Only an owner's Cancel/unmount may actually tear the
  // session down.
  const ownsSessionRef = useRef(false);

  // The shared "is a sign-in live for this machine" flag other surfaces read (see
  // `claudeLoginSessions.ts`'s own doc) — wiring is idempotent, so every mounted
  // instance calling this is fine, not just the first.
  useEffect(() => {
    ensureClaudeLoginSessionsWired();
  }, []);

  useEffect(() => {
    let disposed = false;
    const unPrompt = events.serverLoginPromptEvent.listen((e) => {
      if (disposed || e.payload.machine_id !== machineId) return;
      // Ignore a stale event for a session we've already moved past (e.g. our own
      // just-superseded predecessor) — but adopt one when we don't yet track a
      // session ourselves, since a late subscriber attaching to (or being told about)
      // a live session has no other way to learn its id. See the module doc.
      if (sessionRef.current && sessionRef.current.session_id !== e.payload.session_id) return;
      setUrl(e.payload.url);
    });
    const unResult = events.serverLoginResultEvent.listen((e) => {
      if (disposed || e.payload.machine_id !== machineId) return;
      if (sessionRef.current && sessionRef.current.session_id !== e.payload.session_id) return;
      setSession(null);
      setUrl(null);
      setResult({ ok: e.payload.ok, email: e.payload.email, error: e.payload.error });
      ownsSessionRef.current = false;
      if (e.payload.ok) onSignedIn?.(e.payload.email);
    });
    return () => {
      disposed = true;
      void unPrompt.then((f) => f());
      void unResult.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);

  // Unmount: cancel any session still in flight rather than leaving it dangling —
  // mirrors the wizard's own cancel discipline. Intentionally the ONLY place this
  // fires (empty deps), reading the live values through the refs above. Also clears
  // the shared `active` flag: a same-caller Cancel (this IS one — the actor's own
  // `Cancel` handling stays silent, see `run_login_actor`'s doc) is the one case
  // nothing else will ever clear it for us, since no `ServerLoginResultEvent` follows.
  //
  // ⚠️ Gated on `ownsSessionRef` (see the module doc): an instance that merely
  // ATTACHED to another surface's session must NOT cancel it or clear the shared flag
  // on unmount — that would silently kill the session for whoever still owns it, with
  // no `ServerLoginResultEvent` to tell them (the actor's `Cancel` handling is silent
  // by design, on the assumption only the true owner ever sends it).
  useEffect(() => {
    return () => {
      if (sessionRef.current && ownsSessionRef.current) {
        void commands.cancelClaudeLogin(sessionRef.current);
        useClaudeLoginSessions.getState().setActive(machineId, false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    setResult(null);
    setUrl(null);
    const res = await commands.startClaudeLogin(machineId);
    setStarting(false);
    if (res.status === "ok") {
      setSession(res.data);
      ownsSessionRef.current = res.data.owned;
      useClaudeLoginSessions.getState().setActive(machineId, true, res.data.session_id);
    } else {
      setError(res.error);
    }
  }, [machineId]);

  // Explicitly REPLACES whatever session is currently live for this machine —
  // the only action in this component that supersedes rather than attaches (see the
  // module doc). Offered once a session is already in flight (waiting for the URL or
  // entering a code), for the rare case that flow is stuck.
  const restart = useCallback(async () => {
    setRestarting(true);
    setError(null);
    setResult(null);
    setUrl(null);
    setCode("");
    const res = await commands.restartClaudeLogin(machineId);
    setRestarting(false);
    if (res.status === "ok") {
      // Always `owned: true` (see `LoginSession.owned`'s own doc) — set from the
      // response rather than hardcoded here so a backend change would surface as a
      // visible behavior change instead of silently going stale.
      setSession(res.data);
      ownsSessionRef.current = res.data.owned;
      useClaudeLoginSessions.getState().setActive(machineId, true, res.data.session_id);
    } else {
      setError(res.error);
    }
  }, [machineId]);

  const openSignIn = useCallback(() => {
    if (!url) return;
    if (!isTrustedSignInUrl(url)) {
      setError("Refused to open an untrusted sign-in link — use the code field once you have it another way.");
      return;
    }
    setError(null);
    openUrl(url).catch((e: unknown) => {
      setError(`Unable to open the browser: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, [url]);

  const submit = useCallback(() => {
    if (!session || !code.trim()) return;
    const target = session;
    const submitted = code.trim();
    // Cleared the instant it's handed off to the IPC call — never lingers in state
    // past submission, success or failure alike.
    setCode("");
    setSubmitting(true);
    setError(null);
    void commands.submitClaudeLoginCode(target, submitted).then((res) => {
      setSubmitting(false);
      if (res.status !== "ok") setError(res.error);
    });
  }, [session, code]);

  const cancel = useCallback(() => {
    // ⚠️ Only the OWNER actually tears the session down — an attached instance's
    // Cancel is a local-only detach (see the module doc): it resets this component's
    // own view without touching the backend session or the shared `active` flag,
    // leaving both alone for whoever still owns it.
    if (session && ownsSessionRef.current) {
      void commands.cancelClaudeLogin(session);
      // A same-caller Cancel — the backend stays silent on it (see the module doc), so
      // this is the only place that will ever clear the shared flag for it.
      useClaudeLoginSessions.getState().setActive(machineId, false);
    }
    setSession(null);
    setUrl(null);
    setCode("");
    setError(null);
    ownsSessionRef.current = false;
  }, [session, machineId]);

  if (result) {
    return (
      <div className={styles.remoteStep}>
        {result.ok ? (
          <>Signed in{result.email ? ` as ${result.email}` : ""}.</>
        ) : (
          <span className={styles.dangerText}>Sign-in failed{result.error ? `: ${result.error}` : ""}.</span>
        )}{" "}
        <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => void start()}>
          {result.ok ? "Sign in again" : "Try again"}
        </button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.btnRow}>
        <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={starting} onClick={() => void start()}>
          {starting ? "Starting…" : "Start Claude sign-in"}
        </button>
        {error && <span className={styles.dangerText}>{error}</span>}
      </div>
    );
  }

  return (
    <div className={styles.remotePanel}>
      <div className={styles.remoteStep}>
        {url ? (
          <>
            <b>Open the sign-in page</b>, sign in, then paste the code it shows below.
          </>
        ) : (
          "Waiting for the sign-in link…"
        )}
      </div>
      {url && (
        <div className={styles.btnRow}>
          <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={openSignIn}>
            Open sign-in page
          </button>
        </div>
      )}
      <div className={styles.fieldRow}>
        <input
          className={styles.field}
          placeholder="Authorization code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          aria-label="Authorization code"
          autoComplete="off"
        />
        <button
          type="button"
          className={`${styles.btn} ${styles.primary}`}
          disabled={!code.trim() || submitting}
          onClick={submit}
        >
          {submitting ? "Connecting…" : "Submit"}
        </button>
      </div>
      {error && <div className={styles.errorMsg}>{error}</div>}
      <div className={styles.btnRow}>
        <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={cancel}>
          Cancel
        </button>
        {/* Explicit replace — the only thing that supersedes this session (see the
            module doc). Rare (a stuck sign-in), so kept secondary to Cancel. */}
        <button type="button" className={`${styles.btn} ${styles.ghost}`} disabled={restarting} onClick={() => void restart()}>
          {restarting ? "Restarting…" : "Restart sign-in"}
        </button>
      </div>
    </div>
  );
}
