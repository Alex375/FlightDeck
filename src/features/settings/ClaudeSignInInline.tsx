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
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, events, type LoginSession } from "../../ipc/client";
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; email: string | null; error: string | null } | null>(null);

  // Tracks the live session for the unmount-only cleanup effect below (which can't
  // close over `session` directly without re-subscribing on every change).
  const sessionRef = useRef<LoginSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let disposed = false;
    const unPrompt = events.serverLoginPromptEvent.listen((e) => {
      if (disposed || e.payload.machine_id !== machineId) return;
      setUrl(e.payload.url);
    });
    const unResult = events.serverLoginResultEvent.listen((e) => {
      if (disposed || e.payload.machine_id !== machineId) return;
      setSession(null);
      setUrl(null);
      setResult({ ok: e.payload.ok, email: e.payload.email, error: e.payload.error });
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
  // fires (empty deps), reading the live value through the ref above.
  useEffect(() => {
    return () => {
      if (sessionRef.current) void commands.cancelClaudeLogin(sessionRef.current);
    };
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    setResult(null);
    setUrl(null);
    const res = await commands.startClaudeLogin(machineId);
    setStarting(false);
    if (res.status === "ok") setSession(res.data);
    else setError(res.error);
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
    if (session) void commands.cancelClaudeLogin(session);
    setSession(null);
    setUrl(null);
    setCode("");
    setError(null);
  }, [session]);

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
      </div>
    </div>
  );
}
