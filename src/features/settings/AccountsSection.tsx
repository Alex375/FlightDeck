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
import type { UsageError } from "../../ipc/client";
import {
  useClaudeAccount,
  useClaudeAccountActions,
  useClaudeAccountAdmin,
  useClaudeAccounts,
  useClaudeLoginInFlight,
  useCodexAccount,
  useCodexAccountActions,
} from "../../ipc/useAccounts";
import { useBackendAvailabilityState } from "../../store/binaryAvailable";
import { useAccountLoginStore } from "../../store/accountLogin";
import { DEFAULT_ACCOUNT_ID, useClaudeAccountPrefs } from "../../store/claudeAccounts";
import { usePlanUsage } from "../../store/planUsage";
import { ClaudeMark, CodexMark, PlanUsageBars } from "../../ui/kit";
import { PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
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

/** The Claude side of the panel: the default account, every extra account the user added,
 *  a way to add one more, and the auto-switch policy. Each card carries that account's OWN
 *  rate limits — the same 5h / 7d bars the context ring shows, rendered by the same
 *  component, so "the limits of all my accounts in one place" is literally one glance. */
function ClaudeAccountGroup() {
  const accounts = useClaudeAccounts(true);
  const admin = useClaudeAccountAdmin();
  const prefs = useClaudeAccountPrefs();
  const rows = accounts.data ?? [];
  const addErr = (admin.create.error as Error | null)?.message ?? null;
  const listErr = (accounts.error as Error | null)?.message ?? null;
  // Removal outcomes, per account. A REFUSED removal (the CLI sign-out failed) keeps the
  // account and offers "Remove anyway"; a forced removal that went through still reports
  // the Keychain item left behind. Neither is ever dropped: the credential store may still
  // hold a session the user believes they revoked.
  const [removal, setRemoval] = useState<
    { accountId: string; kind: "refused" | "warning"; message: string } | null
  >(null);
  const [renameErr, setRenameErr] = useState<{ accountId: string; message: string } | null>(
    null,
  );

  const remove = (accountId: string, force: boolean) =>
    admin.remove.mutate(
      { accountId, force },
      {
        onSuccess: (warning) =>
          setRemoval(warning ? { accountId, kind: "warning", message: warning } : null),
        onError: (e: unknown) =>
          setRemoval({
            accountId,
            kind: "refused",
            message: e instanceof Error ? e.message : String(e),
          }),
      },
    );

  return (
    <>
      {/* With extra accounts signed in, `claude auth status` reports whichever account
          signed in LAST as the email/org, so the default card must not show them. */}
      <ClaudeAccountCard accountId={null} label="Claude" hideSharedIdentity={rows.length > 0} />
      {rows.map((a) => (
        <ClaudeAccountCard
          key={a.id}
          accountId={a.id}
          label={a.label}
          email={a.email}
          orgName={a.org_name}
          subscriptionType={a.subscription_type}
          onRename={(label) =>
            admin.rename.mutate(
              { accountId: a.id, label },
              {
                onSuccess: () => setRenameErr(null),
                onError: (e: unknown) =>
                  setRenameErr({
                    accountId: a.id,
                    message: e instanceof Error ? e.message : String(e),
                  }),
              },
            )
          }
          renameError={renameErr?.accountId === a.id ? renameErr.message : null}
          onRemove={() => remove(a.id, false)}
          removing={admin.remove.isPending && admin.remove.variables?.accountId === a.id}
          removal={
            removal?.accountId === a.id
              ? {
                  ...removal,
                  onForce: () => remove(a.id, true),
                  onDismiss: () => setRemoval(null),
                }
              : null
          }
        />
      ))}
      <SettingsGroup title="Claude accounts" icon="users">
        <ToggleRow
          title="Add another Claude account"
          hint="Each account keeps its own credentials. Conversations, settings, plugins, skills and MCP servers stay shared — only the sign-in differs."
          action={
            <button
              className={`${s.btn} ${s.connect}`}
              disabled={admin.create.isPending}
              onClick={() => admin.create.mutate("")}
            >
              {admin.create.isPending ? "Adding…" : "Add account"}
            </button>
          }
        />
        {addErr ? <div className={s.err}>{addErr}</div> : null}
        {/* A failed list read is NOT "no extra accounts": say so instead of rendering an
            empty panel that reads as if they had been deleted. */}
        {listErr ? (
          <div className={s.err}>Could not load your Claude accounts: {listErr}</div>
        ) : null}
        <ToggleRow
          title="Default account for new conversations"
          hint="Existing conversations keep the account they already run on."
          control={
            <select
              className={s.codeInput}
              value={prefs.defaultAccountId ?? DEFAULT_ACCOUNT_ID}
              onChange={(e) =>
                prefs.set({
                  defaultAccountId:
                    e.target.value === DEFAULT_ACCOUNT_ID ? null : e.target.value,
                })
              }
            >
              <option value={DEFAULT_ACCOUNT_ID}>Claude (default)</option>
              {rows.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          }
        />
        <AutoSwitchRows accountCount={rows.length + 1} />
      </SettingsGroup>
    </>
  );
}

/** The auto-switch policy rows. The toggle is DISABLED — with the reason shown in the
 *  hint, not in a `title` a disabled control never renders — while fewer than two accounts
 *  exist: offering a switch with nowhere to switch to would be a setting the app cannot
 *  honour. */
function AutoSwitchRows({ accountCount }: { accountCount: number }) {
  const prefs = useClaudeAccountPrefs();
  const enoughAccounts = accountCount >= 2;
  return (
    <>
      <ToggleRow
        title="Auto-switch account near usage limit"
        hint={
          enoughAccounts
            ? `When the account a conversation runs on passes ${prefs.switchAtPercent}% of its 5h or 7d window, move it to an account below ${prefs.targetBelowPercent}%. Only ever between turns, never mid-turn or while background tasks are running.`
            : "Add a second Claude account to enable this — there is nowhere to switch to with only one."
        }
        checked={prefs.autoSwitch && enoughAccounts}
        disabled={!enoughAccounts}
        onChange={(next) => prefs.set({ autoSwitch: next })}
      />
      {prefs.autoSwitch && enoughAccounts ? (
        <>
          <ToggleRow
            title="Switch when an account reaches"
            hint="Percentage of its 5h or 7d window (50–99)."
            control={
              <PercentInput
                value={prefs.switchAtPercent}
                min={50}
                max={99}
                onCommit={(at) =>
                  // Keep the ceiling strictly below the new trigger, but never RATCHET it:
                  // raising the trigger back leaves the ceiling where the user put it.
                  prefs.set({
                    switchAtPercent: at,
                    targetBelowPercent: Math.min(prefs.targetBelowPercent, at - 1),
                  })
                }
              />
            }
          />
          <ToggleRow
            title="Only switch to an account below"
            hint={`Must stay under the trigger (${prefs.switchAtPercent}%). The gap is what stops it bouncing back and forth.`}
            control={
              <PercentInput
                value={prefs.targetBelowPercent}
                min={1}
                max={prefs.switchAtPercent - 1}
                onCommit={(below) => prefs.set({ targetBelowPercent: below })}
              />
            }
          />
        </>
      ) : null}
    </>
  );
}

/** A percentage field that COMMITS on blur / Enter, never per keystroke. Committing on
 *  every keystroke fed intermediate values ("" → 0, "9" while retyping "95") straight into
 *  the policy, where they were silently clamped to 1%. An out-of-range or empty entry is
 *  refused and the field snaps back to the stored value, visibly. */
function PercentInput({
  value,
  min,
  max,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    const n = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(n) || n < min || n > max) {
      setInvalid(true);
      setDraft(String(value));
      return;
    }
    setInvalid(false);
    if (n !== value) onCommit(n);
  };
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end" }}>
      <input
        className={s.codeInput}
        type="number"
        min={min}
        max={max}
        value={draft}
        aria-invalid={invalid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {invalid ? <span className={s.err}>{`Enter a whole number from ${min} to ${max}.`}</span> : null}
    </span>
  );
}

/** One account's card: sign-in flow, identity, and that account's own rate limits. */
function ClaudeAccountCard({
  accountId,
  label,
  email,
  orgName,
  subscriptionType,
  hideSharedIdentity,
  onRename,
  renameError,
  onRemove,
  removing,
  removal,
}: {
  /** `null` = the default, un-scoped account (the one that always exists). */
  accountId: string | null;
  label: string;
  email?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
  /** Suppress the email/org read from `claude auth status` (default card only), because
   *  with several accounts that shared profile cache names another account. */
  hideSharedIdentity?: boolean;
  onRename?: (label: string) => void;
  renameError?: string | null;
  onRemove?: () => void;
  removing?: boolean;
  removal?: {
    kind: "refused" | "warning";
    message: string;
    onForce: () => void;
    onDismiss: () => void;
  } | null;
}) {
  const status = useClaudeAccount(true, accountId);
  const { loginStart, loginCode, loginCancel, logout } = useClaudeAccountActions(accountId);
  // The two-step login: null = idle; "code" = URL opened, waiting for the pasted code.
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const [identityWarning, setIdentityWarning] = useState<string | null>(null);
  const opener = useAuthUrlOpener();
  // There is ONE in-flight sign-in for the whole app. If another card started one after
  // this card opened its code box, this card's flow is gone: close the box rather than
  // offer an input that would submit into someone else's login.
  const inFlight = useClaudeLoginInFlight(step === "code");
  // Set when THIS card's code box was closed because its flow was replaced — cleared the
  // next time this card starts a sign-in. Explicit state rather than a value derived from
  // the (by then disabled) poll, so the notice cannot linger or flicker.
  const [superseded, setSuperseded] = useState(false);
  useEffect(() => {
    if (step !== "code" || !inFlight.isFetchedAfterMount || loginCode.isPending) return;
    const f = inFlight.data;
    if (!f || f.accountId !== accountId) {
      setStep("idle");
      setCode("");
      // Another account's login replaced ours; no login at all means it was cancelled
      // elsewhere — both close the box, only the first needs explaining.
      setSuperseded(!!f);
    }
  }, [step, inFlight.isFetchedAfterMount, inFlight.data, accountId, loginCode.isPending]);
  const err =
    (loginStart.error as Error | null)?.message ??
    (loginCode.error as Error | null)?.message ??
    (logout.error as Error | null)?.message ??
    null;

  const startLogin = () => {
    setSuperseded(false);
    setIdentityWarning(null);
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
      onSuccess: (warning) => {
        setStep("idle");
        setCode("");
        setIdentityWarning(warning);
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

  const actions = (
    <>
      {logged ? (
        <LogoutControl pending={logout.isPending} onConfirm={() => logout.mutate()} />
      ) : step === "idle" ? (
        <>
          <span className={s.spacer} />
          <button
            className={`${s.btn} ${s.connect}`}
            disabled={loginStart.isPending}
            onClick={startLogin}
          >
            <ClaudeMark /> {loginStart.isPending ? "Opening…" : "Sign in"}
          </button>
        </>
      ) : (
        <span className={s.provider}>Signing in…</span>
      )}
      {/* Removing is only offered for an account the app added: the default one is the
          CLI's own store and is not ours to delete. */}
      {onRemove ? (
        <button className={`${s.btn} ${s.danger}`} disabled={removing} onClick={onRemove}>
          {removing ? "Removing…" : "Remove"}
        </button>
      ) : null}
    </>
  );

  // The identity shown on an EXTRA account is the one captured at its own sign-in, not
  // whatever `claude auth status` reports: that reads a profile cache all accounts share,
  // so it names whichever signed in last. The default card has no such record and falls
  // back to the live status, which is correct for it whenever it is the only account.
  const shownEmail = accountId
    ? (email ?? null)
    : hideSharedIdentity
      ? null
      : (status.data?.email ?? null);
  const shownOrg = accountId
    ? (orgName ?? null)
    : hideSharedIdentity
      ? null
      : (status.data?.orgName ?? null);
  const shownPlan = accountId
    ? (subscriptionType ?? status.data?.subscriptionType ?? null)
    : (status.data?.subscriptionType ?? null);

  return (
    <ConnectionCard
      accent={BRAND.claude}
      mark={<ClaudeMark />}
      name={label}
      provider="Anthropic · claude.ai"
      state={state}
      identity={shownEmail}
      pills={[
        shownPlan ? { label: `Plan ${shownPlan}`, plan: true } : null,
        shownOrg ? { label: shownOrg } : null,
      ].filter(Boolean) as { label: string; plan?: boolean }[]}
      invite={
        status.isError
          ? `Status unavailable: ${(status.error as Error).message}`
          : "Sign in to the Anthropic account the claude CLI will use for your conversations."
      }
      actions={actions}
    >
      {logged ? <AccountUsage accountId={accountId} /> : null}
      {onRename ? (
        <NameField label={label} onRename={onRename} error={renameError ?? null} />
      ) : null}
      {identityWarning ? <div className={s.err}>{identityWarning}</div> : null}
      {superseded ? (
        <div className={s.err}>
          This sign-in was replaced by one started for another account. Click “Sign in” again.
        </div>
      ) : null}
      {removal ? (
        <div className={s.err}>
          {removal.message}{" "}
          {removal.kind === "refused" ? (
            <button className={`${s.btn} ${s.danger}`} onClick={removal.onForce}>
              Remove anyway
            </button>
          ) : null}{" "}
          <button className={`${s.btn} ${s.ghost}`} onClick={removal.onDismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
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

/** The account name field. CONTROLLED and re-seeded whenever the stored label changes:
 *  the uncontrolled version kept its first `defaultValue`, so after the identity capture
 *  renamed the account the stale DOM text was compared against the fresh label on the next
 *  blur and silently written back. A failed rename is shown and the field reverts to the
 *  name that is actually stored. */
function NameField({
  label,
  onRename,
  error,
}: {
  label: string;
  onRename: (label: string) => void;
  error: string | null;
}) {
  const [draft, setDraft] = useState(label);
  useEffect(() => {
    setDraft(label);
  }, [label, error]);
  const commit = () => {
    const next = draft.trim();
    if (!next) {
      setDraft(label);
      return;
    }
    if (next !== label) onRename(next);
  };
  return (
    <>
      <div className={s.subRow}>
        <span className={s.subLabel}>Name</span>
        <input
          className={s.codeInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      </div>
      {error ? <div className={s.err}>Could not rename this account: {error}</div> : null}
    </>
  );
}

/** One account's rate limits, inside its card — the SAME bars as the context ring's
 *  popover, from the same component, so the two can never drift apart.
 *
 *  The figures are per SUBSCRIPTION, so each account is a separate query keyed by its id.
 *  A failure is stated, never left as an empty space that reads like "no limits": an
 *  account whose usage cannot be read is also one the auto-switch will refuse to pick, and
 *  the user needs to know which of the two they are looking at. */
function AccountUsage({ accountId }: { accountId: string | null }) {
  const usage = usePlanUsage({ accountId });
  const err = usage.error;
  const empty =
    !!usage.data && !usage.data.five_hour && !usage.data.seven_day && !usage.data.scoped?.length;
  return (
    <div className={s.subRow} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
      <span className={s.subLabel}>Usage</span>
      {usage.isPending ? (
        <span className={s.provider}>Reading usage…</span>
      ) : err ? (
        <div className={s.err}>{usageErrorText(err)}</div>
      ) : empty ? (
        <span className={s.provider}>No usage window reported for this account.</span>
      ) : (
        <PlanUsageBars usage={usage.data} />
      )}
    </div>
  );
}

/** A usage failure as one actionable sentence. Mirrors the ring popover's guidance, kept
 *  short here because the card has no room for a full card — but never reduced to
 *  "unavailable", which would leave the user with nothing to do about it. */
function usageErrorText(e: UsageError): string {
  switch (e.kind) {
    case "no_token":
      return "No credentials for this account yet — sign in above.";
    case "keychain_denied":
      return `macOS refused access to this account's Keychain item (${e.detail}). Retry and choose “Always Allow”.`;
    case "unauthorized":
      return `The stored credentials were rejected (HTTP ${e.status}) — sign this account in again.`;
    case "rate_limited":
      return `The usage endpoint is rate-limiting us${e.retry_after ? ` — retry in ${e.retry_after}s` : ""}.`;
    case "http":
      return `The usage endpoint answered HTTP ${e.status}.`;
    case "network":
      return `Could not reach the usage endpoint: ${e.detail}`;
    case "parse":
      return "The usage endpoint answered in an unexpected shape.";
    case "unknown_account":
      return "This account no longer exists.";
  }
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
