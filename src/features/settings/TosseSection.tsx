// Settings → TOSSE: connect Flight Deck to the TOSSE CRM.
//
// A THIRD kind of connection, deliberately kept off the "Accounts" tab: those sign an
// AGENT in to a model provider, this signs the HUMAN in to their own CRM. It powers the
// upcoming tasks view; nothing else in the app depends on it, and the app is fully usable
// signed out (the card just invites).
//
// The flow is an RFC 8252 native-app OAuth sign-in run by `src-tauri/src/tosse`: we hand
// back an authorization URL, open it, and the browser lands on a loopback callback the core
// is listening on. So, like the Codex login, completion is ASYNCHRONOUS and arrives as the
// app-global `account_login` event — which means it can land while this panel is closed,
// hence the same stash-and-replay handling.
import { useEffect, useState } from "react";
import { events } from "../../ipc/client";
import { useTosseConnection, useTosseConnectionActions } from "../../ipc/useTosse";
import { useAccountLoginStore } from "../../store/accountLogin";
import { Ico } from "../../ui/kit";
import { PageHead } from "./SettingsKit";
import {
  ConnectionCard,
  LogoutControl,
  OpenUrlFallback,
  connectionStyles as s,
  useAuthUrlOpener,
  type CardState,
} from "./ConnectionCard";

/** Which backend name this card owns on the shared `account_login` event / failure stash. */
const BACKEND = "tosse";

export function TosseSection() {
  return (
    <div>
      <PageHead
        title="TOSSE"
        subtitle="Connect Flight Deck to your TOSSE CRM to work from your clients, projects and tasks."
      />
      <div className={s.cards}>
        <TosseConnectionGroup />
      </div>
    </div>
  );
}

function TosseConnectionGroup() {
  const status = useTosseConnection(true);
  const { loginStart, loginCancel, logout, refresh } = useTosseConnectionActions();
  // "waiting" = the URL was opened and the core is holding the loopback callback; the
  // outcome arrives as the app-global `account_login` event.
  const [waiting, setWaiting] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const opener = useAuthUrlOpener();

  useEffect(() => {
    let disposed = false;
    const un = events.accountLoginEvent.listen((e) => {
      if (disposed || e.payload.backend !== BACKEND) return;
      setWaiting(false);
      setLoginErr(e.payload.success ? null : (e.payload.error ?? "sign-in failed"));
      // Surfaced live here, so consume the stash the always-mounted global handler wrote
      // for the panel-CLOSED case — otherwise this same failure replays on the next mount.
      useAccountLoginStore.getState().clear(BACKEND);
    });
    return () => {
      disposed = true;
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  // A sign-in can complete minutes after the user navigated away, so the listener above
  // misses outcomes that land while this panel is unmounted. Read (and consume) whatever
  // the global handler stashed, so a reopened panel explains the failure instead of showing
  // a bare "Not connected".
  useEffect(() => {
    const stashed = useAccountLoginStore.getState().failures[BACKEND];
    if (stashed) {
      setLoginErr(stashed.error ?? "sign-in failed");
      useAccountLoginStore.getState().clear(BACKEND);
    }
  }, []);

  const connected = status.data?.connected === true;
  const state: CardState = status.isLoading
    ? "loading"
    : status.isError
      ? "error"
      : connected
        ? "connected"
        : "disconnected";

  // Every way this card can be failing, in priority order — the freshest cause wins, and
  // none is ever swallowed. `signedOutReason` explains a session that STOPPED working
  // (revoked or expired refresh token), which is a different story from never having
  // connected — the invite below says which.
  //
  // ⚠️ A sign-out failure is only shown while we are actually signed OUT. `logout.error`
  // is a partial success ("signed out here, but TOSSE could not be told"), and a mutation's
  // error sticks until the next call: left unfiltered it would still be pinned under a
  // freshly CONNECTED card minutes later, describing a session that no longer exists.
  const err =
    loginErr ??
    (loginStart.error as Error | null)?.message ??
    (connected ? null : (logout.error as Error | null)?.message) ??
    status.data?.signedOutReason ??
    null;

  const startLogin = () => {
    setLoginErr(null);
    logout.reset(); // a new attempt supersedes the previous sign-out's outcome
    useAccountLoginStore.getState().clear(BACKEND); // …and any stashed failure
    loginStart.mutate(undefined, {
      onSuccess: (url) => {
        setWaiting(true);
        opener.open(url);
      },
    });
  };
  // Cancelling only stops us WAITING. If the browser round-trip had already completed, the
  // core has the tokens and we are connected — so refetch instead of leaving the card
  // asserting "Not connected" until its 30 s staleTime lapses.
  const cancelLogin = () =>
    loginCancel.mutate(undefined, {
      onSettled: () => {
        setWaiting(false);
        void refresh();
      },
    });

  const actions = connected ? (
    <LogoutControl pending={logout.isPending} onConfirm={() => logout.mutate()} label="Disconnect…" />
  ) : waiting ? (
    <>
      <span className={s.waiting}>
        <span className={s.waitingDot} />
        Authorize in the browser…
      </span>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.ghost}`} onClick={cancelLogin}>
        Cancel
      </button>
    </>
  ) : (
    <>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.connect}`} disabled={loginStart.isPending} onClick={startLogin}>
        <Ico name="link" className="sm" /> {loginStart.isPending ? "Opening…" : "Connect"}
      </button>
    </>
  );

  return (
    <ConnectionCard
      accent="var(--wf-tosse-accent)"
      mark={<Ico name="list" />}
      name="TOSSE"
      provider="Internal CRM"
      state={state}
      // The identity probe needs the network; offline we still know we hold a session,
      // so fall back to a truthful label rather than an empty line.
      identity={status.data?.email ?? status.data?.name ?? "Connected"}
      pills={
        status.data?.name && status.data?.email ? [{ label: status.data.name }] : undefined
      }
      invite={
        status.isError
          ? `Status unavailable: ${(status.error as Error).message}`
          : status.data?.signedOutReason
            ? "Your TOSSE session is no longer valid. Connect again to restore access."
            : "Connect your TOSSE account to work from your clients, projects and tasks inside Flight Deck. Everything else works without it."
      }
      actions={actions}
    >
      {waiting ? (
        <div className={s.subRow}>
          <span className={s.subLabel}>
            A browser tab opened on TOSSE. Sign in there if needed, approve the request, and this
            card connects on its own.
          </span>
        </div>
      ) : null}
      {waiting && opener.error && opener.url ? (
        <OpenUrlFallback error={opener.error} url={opener.url} onRetry={() => opener.open(opener.url!)} />
      ) : null}
      {/* Connected, but the identity call did not go through (offline, or the server does
          not accept our token on /api/v1 yet). Shown as a note, NOT as a broken connection:
          the session itself is fine. */}
      {connected && status.data?.identityError ? (
        <div className={s.subRow}>
          <span className={s.subLabel}>Connected, but your TOSSE profile could not be read: {status.data.identityError}</span>
        </div>
      ) : null}
      {err ? <div className={s.err}>{err}</div> : null}
    </ConnectionCard>
  );
}
