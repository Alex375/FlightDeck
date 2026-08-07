// Settings → Accounts: the in-app login/logout/status for BOTH agent backends, as
// graphical per-backend cards. The flows drive the OFFICIAL mechanisms only —
// `claude auth login|logout` for Claude (URL + pasted code) and the app-server's
// `account/login/*` for Codex (URL + async `account_login` completion event) — the app
// never touches a credential store itself. Every failure surfaces inline.
//
// The card shell and its satellites live in `ConnectionCard.tsx`, shared with the TOSSE
// tab (a third connection, with its own flow but the same visual language).
import { useEffect, useState } from "react";
import { events } from "../../ipc/client";
import {
  useClaudeAccount,
  useClaudeAccountActions,
  useCodexAccount,
  useCodexAccountActions,
} from "../../ipc/useAccounts";
import { useBackendAvailabilityState } from "../../store/binaryAvailable";
import { useAccountLoginStore } from "../../store/accountLogin";
import { ClaudeMark, CodexMark } from "../../ui/kit";
import { PageHead } from "./SettingsKit";
import {
  ConnectionCard,
  LogoutControl,
  OpenUrlFallback,
  connectionStyles as s,
  useAuthUrlOpener,
  type CardState,
} from "./ConnectionCard";

// The brand accent each card is themed with (drives the glow, tile, plan pill, CTA).
// Shared design tokens (conductor-wirekit.css), never raw hex — so a brand tweak is
// one edit and the Accounts card / Extensions tab / Plan pill never diverge.
const BRAND: Record<"claude" | "codex", string> = {
  claude: "var(--wf-accent)", // coral
  codex: "var(--wf-codex-accent)", // OpenAI green
};

export function AccountsSection() {
  // Tri-state (null while the one-shot probe is in flight): show the alarming
  // "CLI not found" card ONLY on a DEFINITIVE `false`. While still checking (null), render
  // the normal account group — it has its own "Checking…" skeleton — so a user who has
  // the CLI installed never sees a scary "not found" flash before the check resolves.
  const claude = useBackendAvailabilityState("claude");
  const codex = useBackendAvailabilityState("codex");
  return (
    <div>
      <PageHead
        title="Accounts"
        subtitle="Sign in to the Claude and Codex accounts used by the agents."
      />
      <div className={s.cards}>
        {claude === false ? <ClaudeUnavailableCard /> : <ClaudeAccountGroup />}
        {codex === false ? <CodexUnavailableCard /> : <CodexAccountGroup />}
      </div>
    </div>
  );
}

function ClaudeAccountGroup() {
  const status = useClaudeAccount(true);
  const { loginStart, loginCode, loginCancel, logout } = useClaudeAccountActions();
  // The two-step login: null = idle; "code" = URL opened, waiting for the pasted code.
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const opener = useAuthUrlOpener();
  const err =
    (loginStart.error as Error | null)?.message ??
    (loginCode.error as Error | null)?.message ??
    (logout.error as Error | null)?.message ??
    null;

  const startLogin = () => {
    loginStart.mutate(undefined, {
      onSuccess: (url) => {
        setStep("code");
        setCode("");
        opener.open(url);
      },
    });
  };
  const submitCode = () => {
    if (!code.trim()) return;
    loginCode.mutate(code, {
      onSuccess: () => {
        setStep("idle");
        setCode("");
      },
      // On failure the CLI child has exited: back to idle so "Sign in" restarts
      // a fresh flow (the error stays visible below).
      onError: () => setStep("idle"),
    });
  };
  const cancelLogin = () => loginCancel.mutate(undefined, { onSettled: () => setStep("idle") });

  const logged = status.data?.loggedIn === true;
  const state: CardState = status.isLoading
    ? "loading"
    : status.isError
      ? "error"
      : logged
        ? "connected"
        : "disconnected";

  const actions = logged ? (
    <LogoutControl
      pending={logout.isPending}
      onConfirm={() => logout.mutate()}
    />
  ) : step === "idle" ? (
    <>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.connect}`} disabled={loginStart.isPending} onClick={startLogin}>
        <ClaudeMark /> {loginStart.isPending ? "Opening…" : "Sign in"}
      </button>
    </>
  ) : (
    <span className={s.provider}>Signing in…</span>
  );

  return (
    <ConnectionCard
      accent={BRAND.claude}
      mark={<ClaudeMark />}
      name="Claude"
      provider="Anthropic · claude.ai"
      state={state}
      identity={status.data?.email}
      pills={[
        status.data?.subscriptionType
          ? { label: `Plan ${status.data.subscriptionType}`, plan: true }
          : null,
        status.data?.orgName ? { label: status.data.orgName } : null,
      ].filter(Boolean) as { label: string; plan?: boolean }[]}
      invite={
        status.isError
          ? `Status unavailable: ${(status.error as Error).message}`
          : "Sign in to the Anthropic account the claude CLI will use for your conversations."
      }
      actions={actions}
    >
      {step === "code" ? (
        <div className={s.subRow}>
          <span className={s.subLabel}>
            Authorize in the browser, copy the code shown, then paste it here.
          </span>
          <input
            className={s.codeInput}
            value={code}
            autoFocus
            placeholder="Authorization code…"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCode();
            }}
          />
          <button
            className={`${s.btn} ${s.connect}`}
            disabled={!code.trim() || loginCode.isPending}
            onClick={submitCode}
          >
            {loginCode.isPending ? "Validating…" : "Submit"}
          </button>
          <button className={`${s.btn} ${s.ghost}`} disabled={loginCode.isPending} onClick={cancelLogin}>
            Cancel
          </button>
        </div>
      ) : null}
      {step === "code" && opener.error && opener.url ? (
        <OpenUrlFallback error={opener.error} url={opener.url} onRetry={() => opener.open(opener.url!)} />
      ) : null}
      {err ? <div className={s.err}>{err}</div> : null}
    </ConnectionCard>
  );
}

function CodexAccountGroup() {
  const status = useCodexAccount(true);
  const { loginStart, loginCancel, logout } = useCodexAccountActions();
  // "waiting" = URL opened, the dedicated app-server is holding the OAuth callback;
  // the outcome arrives as the app-global `account_login` event.
  const [waiting, setWaiting] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const opener = useAuthUrlOpener();

  useEffect(() => {
    let disposed = false;
    const un = events.accountLoginEvent.listen((e) => {
      if (disposed || e.payload.backend !== "codex") return;
      setWaiting(false);
      setLoginErr(e.payload.success ? null : (e.payload.error ?? "sign-in failed"));
      // The panel is open and has just surfaced this outcome live — consume the stash the
      // always-mounted global handler writes for the panel-CLOSED case, so this same failure
      // isn't replayed the next time the panel mounts (the mount effect below reads it). The
      // global handler registers first, so its stash write has already landed here.
      useAccountLoginStore.getState().clear("codex");
    });
    return () => {
      disposed = true;
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  // Surface a failure that landed while this panel was CLOSED: the async Codex login can
  // complete minutes after the user navigated away, so the in-panel listener above misses
  // it. The always-mounted global handler stashed the reason — read it on mount and consume
  // it, so the reopened panel explains the failure instead of a bare "Not connected".
  useEffect(() => {
    const stashed = useAccountLoginStore.getState().failures.codex;
    if (stashed) {
      setLoginErr(stashed.error ?? "sign-in failed");
      useAccountLoginStore.getState().clear("codex");
    }
  }, []);

  const err =
    loginErr ??
    (loginStart.error as Error | null)?.message ??
    (logout.error as Error | null)?.message ??
    null;
  const startLogin = () => {
    setLoginErr(null);
    useAccountLoginStore.getState().clear("codex"); // a new attempt supersedes any stashed failure
    loginStart.mutate(undefined, {
      onSuccess: (res) => {
        setWaiting(true);
        opener.open(res.authUrl);
      },
    });
  };
  const cancelLogin = () => loginCancel.mutate(undefined, { onSettled: () => setWaiting(false) });

  const logged = status.data?.loggedIn === true;
  const state: CardState = status.isLoading
    ? "loading"
    : status.isError
      ? "error"
      : logged
        ? "connected"
        : "disconnected";

  const actions = logged ? (
    <LogoutControl pending={logout.isPending} onConfirm={() => logout.mutate()} />
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
        <CodexMark /> {loginStart.isPending ? "Opening…" : "Sign in"}
      </button>
    </>
  );

  return (
    <ConnectionCard
      accent={BRAND.codex}
      mark={<CodexMark />}
      name="Codex"
      provider="OpenAI · ChatGPT"
      state={state}
      identity={status.data?.email}
      pills={[
        status.data?.planType ? { label: `Plan ${status.data.planType}`, plan: true } : null,
        status.data?.authMethod === "chatgpt" ? { label: "ChatGPT account" } : null,
      ].filter(Boolean) as { label: string; plan?: boolean }[]}
      invite={
        status.isError
          ? `Status unavailable: ${(status.error as Error).message}`
          : "Sign in to the ChatGPT account the codex CLI will use for your conversations."
      }
      actions={actions}
    >
      {waiting && opener.error && opener.url ? (
        <OpenUrlFallback error={opener.error} url={opener.url} onRetry={() => opener.open(opener.url!)} />
      ) : null}
      {err ? <div className={s.err}>{err}</div> : null}
    </ConnectionCard>
  );
}

/** Claude binary absent: a muted card that points at the install command instead of a
 *  dead "Sign in" (login — `claude auth login` — is impossible without the CLI).
 *  Replaces the confusing "Status unavailable: <error>" the live card would otherwise
 *  show when the `claude auth status` probe fails for want of the binary. */
function ClaudeUnavailableCard() {
  return (
    <ConnectionCard
      accent={BRAND.claude}
      mark={<ClaudeMark />}
      name="Claude"
      provider="Anthropic · claude.ai"
      state="disconnected"
      invite="Claude CLI not found. Install Claude Code (npm i -g @anthropic-ai/claude-code) to connect an account."
      actions={<span className={s.spacer} />}
    />
  );
}

/** Codex binary absent: a muted card that points at the install command instead of a
 *  dead "Sign in" (login is impossible without the CLI). */
function CodexUnavailableCard() {
  return (
    <ConnectionCard
      accent={BRAND.codex}
      mark={<CodexMark />}
      name="Codex"
      provider="OpenAI · ChatGPT"
      state="disconnected"
      invite="Codex CLI not found. Install the binary (npm i -g @openai/codex) to connect an account."
      actions={<span className={s.spacer} />}
    />
  );
}
