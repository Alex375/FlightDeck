// Settings → Accounts: the in-app sign-in, status and rate limits for BOTH agent backends.
// The flows drive the OFFICIAL mechanisms only — `claude auth login|logout` for Claude (URL +
// pasted code, bound to the account that started it) and the app-server's `account/login/*`
// for Codex (URL + async `account_login` completion event). The app never touches a
// credential store itself, and every failure surfaces inline, on the tile it concerns.
//
// Layout: Claude accounts as a grid of tiles, each with a ring gauge per usage window; the
// Switching group underneath, where a band plots every account against the auto-switch
// thresholds; then Codex. (The TOSSE tab keeps `ConnectionCard`; only its sign-in helpers
// are shared.)
import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { events } from "../../ipc/client";
import type { PlanUsage, UsageError } from "../../ipc/client";
import {
  useClaudeAccount,
  useClaudeAccountActions,
  useClaudeAccountAdmin,
  useClaudeAccountIdentity,
  useClaudeAccountNames,
  useClaudeAccounts,
  useClaudeDefaultIdentity,
  useClaudeLoginInFlight,
  useCodexAccount,
  useCodexAccountActions,
} from "../../ipc/useAccounts";
import { useBackendAvailabilityState } from "../../store/binaryAvailable";
import { useAccountLoginStore } from "../../store/accountLogin";
import {
  DEFAULT_ACCOUNT_ID,
  peakUsagePercent,
  useClaudeAccountPrefs,
} from "../../store/claudeAccounts";
import { planUsageKey, usePlanUsage } from "../../store/planUsage";
import { ClaudeMark, CodexMark, Menu, MenuItem } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import { OpenUrlFallback, useAuthUrlOpener } from "./ConnectionCard";
import a from "./AccountsSection.module.css";

/** The key `useClaudeAccountNames` files the default account under. */
const DEFAULT_ACCOUNT_KEY = DEFAULT_ACCOUNT_ID;

/** Usage at or above this reads as "nearly full" — the same line the context ring draws. */
const WARN_PERCENT = 80;

export function AccountsSection() {
  // Tri-state (null while the one-shot probe is in flight): show the "CLI not found" tile
  // ONLY on a DEFINITIVE `false`. While still checking, render the normal tiles — they have
  // their own "Checking…" state — so a user with the CLI never sees a false alarm flash.
  const claude = useBackendAvailabilityState("claude");
  const codex = useBackendAvailabilityState("codex");
  return (
    <div>
      <PageHead title="Accounts" subtitle="The accounts your agents sign in with." />
      <div className={a.page}>
        {claude === false ? <UnavailableTile backend="claude" /> : <ClaudeAccounts />}
        {codex === false ? <UnavailableTile backend="codex" /> : <CodexAccount />}
      </div>
    </div>
  );
}

// ─── Claude ────────────────────────────────────────────────────────────────────────────

/** The Claude side: one tile per account (the default one, then those the user added), the
 *  add tile, and the Switching group. */
function ClaudeAccounts() {
  const accounts = useClaudeAccounts(true);
  const admin = useClaudeAccountAdmin();
  const prefs = useClaudeAccountPrefs();
  const rows = accounts.data ?? [];
  const addErr = (admin.create.error as Error | null)?.message ?? null;
  const listErr = (accounts.error as Error | null)?.message ?? null;
  // Removal outcomes, per account. A REFUSED removal (the CLI sign-out failed) keeps the
  // account and offers "Remove anyway"; a forced removal that went through still reports the
  // Keychain item left behind. Neither is dropped: the credential store may still hold a
  // session the user believes they revoked.
  const [removal, setRemoval] = useState<
    { accountId: string; kind: "refused" | "warning"; message: string } | null
  >(null);
  // The default account's address cannot be read live once a second account exists (the CLI's
  // profile cache is shared, so it would name whichever signed in last). This is the one
  // captured at its OWN sign-in; absent until it was signed in from the app.
  const defaultIdentity = useClaudeDefaultIdentity(true).data ?? null;
  const defaultEmail = defaultIdentity?.email ?? null;
  // Every account's display name — its address, read with its own token.
  const names = useClaudeAccountNames([
    { id: null, capturedEmail: defaultEmail, fallback: "Claude" },
    ...rows.map((r) => ({ id: r.id, capturedEmail: r.email, fallback: r.label })),
  ]);

  const remove = (accountId: string, force: boolean) =>
    admin.remove.mutate(
      { accountId, force },
      {
        onSuccess: (warning) =>
          setRemoval(warning ? { accountId, kind: "warning", message: warning } : null),
        onError: (e: unknown) =>
          setRemoval({ accountId, kind: "refused", message: errText(e) }),
      },
    );

  return (
    <>
      <section>
        <div className={a.provBar} data-backend="claude">
          <ClaudeMark />
          <span className={a.provName}>Claude accounts</span>
        </div>
        <div className={a.grid}>
          {/* With extra accounts signed in, `claude auth status` reports whichever account
              signed in LAST as the email/org, so the default tile must not show them. */}
          <ClaudeTile
            accountId={null}
            capturedEmail={defaultEmail}
            orgName={defaultIdentity?.orgName ?? null}
            subscriptionType={defaultIdentity?.subscriptionType ?? null}
            fallbackName="Claude"
            hideSharedIdentity={rows.length > 0}
            isDefault={prefs.defaultAccountId === null}
            canMakeDefault={rows.length > 0}
            onMakeDefault={() => prefs.set({ defaultAccountId: null })}
          />
          {rows.map((r) => (
            <ClaudeTile
              key={r.id}
              accountId={r.id}
              capturedEmail={r.email}
              orgName={r.org_name}
              subscriptionType={r.subscription_type}
              fallbackName={r.label}
              isDefault={prefs.defaultAccountId === r.id}
              canMakeDefault
              onMakeDefault={() => prefs.set({ defaultAccountId: r.id })}
              onRemove={() => remove(r.id, false)}
              removing={admin.remove.isPending && admin.remove.variables?.accountId === r.id}
              removal={
                removal?.accountId === r.id
                  ? {
                      ...removal,
                      onForce: () => remove(r.id, true),
                      onDismiss: () => setRemoval(null),
                    }
                  : null
              }
            />
          ))}
          <button
            type="button"
            className={a.add}
            disabled={admin.create.isPending}
            onClick={() => admin.create.mutate("")}
          >
            <span className={a.plus} aria-hidden="true">
              +
            </span>
            {admin.create.isPending ? "Adding…" : "Add another Claude account"}
          </button>
        </div>
        {addErr || listErr ? (
          <div className={a.page} style={{ gap: 8, marginTop: 10 }}>
            {addErr ? <p className={a.err}>Could not add the account: {addErr}</p> : null}
            {/* A failed list read is NOT "no extra accounts": say so instead of an empty
                grid that reads as if they had been deleted. */}
            {listErr ? <p className={a.err}>Could not load your Claude accounts: {listErr}</p> : null}
          </div>
        ) : null}
      </section>
      {/* Accounts are named by their address everywhere — read with each account's own
          token; the label is only the fallback while no address can be read. */}
      <Switching
        options={[
          { id: null, label: names[DEFAULT_ACCOUNT_KEY] },
          ...rows.map((r) => ({ id: r.id, label: names[r.id] })),
        ]}
      />
    </>
  );
}

/** One Claude account: identity, status, its rate limits as ring gauges, the numbered
 *  sign-in, and every notice about it. Rename / make default / sign out / remove live in the
 *  ⋯ menu; the two destructive ones ask first. */
function ClaudeTile({
  accountId,
  capturedEmail,
  orgName,
  subscriptionType,
  fallbackName,
  hideSharedIdentity,
  isDefault,
  canMakeDefault,
  onMakeDefault,
  onRemove,
  removing,
  removal,
}: {
  /** `null` = the default, un-scoped account (the one that always exists). */
  accountId: string | null;
  /** The address captured at THIS account's own sign-in — what names the account. `null`
   *  until it was signed in from the app (or while it is signed out). */
  capturedEmail?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
  /** Shown only until an address is known: the generated label, or "Claude" for the default
   *  account. An account is identified by its address, never by a name nobody chose. */
  fallbackName: string;
  /** Suppress the email/org read from `claude auth status` (default tile only): with several
   *  accounts that shared profile cache names another account. */
  hideSharedIdentity?: boolean;
  isDefault: boolean;
  /** "Make default" only means something once there is a choice. */
  canMakeDefault: boolean;
  onMakeDefault: () => void;
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
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const [identityWarning, setIdentityWarning] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"signout" | "remove" | null>(null);
  const opener = useAuthUrlOpener();

  // There is ONE in-flight sign-in for the whole app. If another tile started one after this
  // tile opened its code box, this tile's flow is gone: close the box rather than offer an
  // input that would submit into someone else's login.
  const inFlight = useClaudeLoginInFlight(step === "code");
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
      // On failure the CLI child has exited: back to idle so "Sign in" restarts a fresh flow
      // (the error stays visible below).
      onError: () => setStep("idle"),
    });
  };
  const cancelLogin = () => loginCancel.mutate(undefined, { onSettled: () => setStep("idle") });

  const logged = status.data?.loggedIn === true;
  const signingIn = step === "code";

  // An account IS its address, read with THIS account's own token — never from
  // `claude auth status`, whose profile cache every account shares. The address captured at
  // sign-in, then the live status (only when it can be trusted: the default account, alone),
  // are fallbacks for when the profile cannot be read.
  const identity = useClaudeAccountIdentity(accountId, logged);
  const shownEmail =
    identity.data?.email ??
    capturedEmail ??
    (hideSharedIdentity ? null : (status.data?.email ?? null));
  const shownOrg =
    identity.data?.orgName ?? orgName ?? (hideSharedIdentity ? null : (status.data?.orgName ?? null));
  const shownPlan =
    identity.data?.subscriptionType ?? subscriptionType ?? status.data?.subscriptionType ?? null;
  const title = logged ? (shownEmail ?? fallbackName) : fallbackName;
  const subLine = logged
    ? [shownPlan ? `${capitalize(shownPlan)} plan` : null, shownOrg].filter(Boolean).join(" · ") ||
      "Connected"
    : status.isLoading
      ? "Checking…"
      : "Not connected";

  const notices = !!identityWarning || superseded || !!removal || !!err || status.isError;
  const hasMenu = logged || !!onRemove;

  return (
    <div className={a.tile} data-span={signingIn || notices ? "" : undefined}>
      <div className={a.head}>
        <span className={a.av} data-tone={logged ? "claude" : undefined}>
          <ClaudeMark />
        </span>
        <div className={a.who}>
          <div className={a.name} title={title}>
            <span className={a.nameText}>{title}</span>
            {isDefault && canMakeDefault ? <span className={a.tag}>Default</span> : null}
          </div>
          <div className={a.sub}>{subLine}</div>
        </div>
        {signingIn ? (
          <span className={a.pill} data-tone="wait">
            Signing in…
          </span>
        ) : status.isError ? (
          <span className={a.pill} data-tone="err">
            Unavailable
          </span>
        ) : logged ? (
          <span className={a.dot} title="Connected">
            <span className={a.srOnly}>Connected</span>
          </span>
        ) : null}
        {hasMenu ? (
          <Menu
            portal
            align="right"
            trigger={
              <button type="button" className={a.kebab} aria-label={`Actions for ${title}`}>
                ⋯
              </button>
            }
          >
            {canMakeDefault && !isDefault ? (
              <MenuItem onClick={onMakeDefault}>Make default</MenuItem>
            ) : null}
            {logged ? <MenuItem onClick={() => setConfirm("signout")}>Sign out</MenuItem> : null}
            {onRemove ? (
              <MenuItem disabled={removing} onClick={() => setConfirm("remove")}>
                {removing ? "Removing…" : "Remove account…"}
              </MenuItem>
            ) : null}
          </Menu>
        ) : null}
      </div>

      {status.isLoading ? (
        <div>
          <div className={a.skel} style={{ width: "55%" }} />
          <div className={a.skel} style={{ width: "32%", marginTop: 8, height: 10 }} />
        </div>
      ) : status.isError ? (
        <p className={a.err}>Status unavailable: {(status.error as Error).message}</p>
      ) : logged ? (
        <UsageRings accountId={accountId} />
      ) : signingIn ? (
        <div className={a.signin}>
          <ol className={a.steps}>
            {/* Step one is only DONE once the browser really opened; if the opener failed,
                the fallback below hands over the link instead. */}
            <li data-done={opener.error ? undefined : ""} data-current={opener.error ? "" : undefined}>
              Authorize in the browser
            </li>
            <li data-current={opener.error ? undefined : ""}>Paste the code it shows</li>
          </ol>
          <div className={a.row}>
            <input
              id={`claude-code-${accountId ?? "default"}`}
              className={a.input}
              data-mono=""
              value={code}
              autoFocus
              aria-label="Authorization code"
              placeholder="Authorization code"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCode();
              }}
            />
            <button
              type="button"
              className={`${a.btn} ${a.primary}`}
              disabled={!code.trim() || loginCode.isPending}
              onClick={submitCode}
            >
              {loginCode.isPending ? "Connecting…" : "Connect"}
            </button>
            <button
              type="button"
              className={`${a.btn} ${a.quiet}`}
              disabled={loginCode.isPending}
              onClick={cancelLogin}
            >
              Cancel
            </button>
          </div>
          {opener.error && opener.url ? (
            <OpenUrlFallback error={opener.error} url={opener.url} onRetry={() => opener.open(opener.url!)} />
          ) : null}
        </div>
      ) : (
        <div className={a.row}>
          <p className={a.note} style={{ flex: 1 }}>
            Sign in to the Anthropic account this slot should use.
          </p>
          <button
            type="button"
            className={`${a.btn} ${a.primary}`}
            disabled={loginStart.isPending}
            onClick={startLogin}
          >
            <ClaudeMark /> {loginStart.isPending ? "Opening…" : "Sign in"}
          </button>
        </div>
      )}

      {identityWarning ? <p className={a.warn}>{identityWarning}</p> : null}
      {superseded ? (
        <p className={a.warn}>
          This sign-in was replaced by one started for another account. Click “Sign in” again.
        </p>
      ) : null}
      {removal ? (
        <div className={removal.kind === "refused" ? a.err : a.warn}>
          {removal.message}
          <div className={a.errActions}>
            {removal.kind === "refused" ? (
              <button type="button" className={`${a.btn} ${a.danger}`} onClick={removal.onForce}>
                Remove anyway
              </button>
            ) : null}
            <button type="button" className={`${a.btn} ${a.ghost}`} onClick={removal.onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {err ? <p className={a.err}>{err}</p> : null}

      <ConfirmDialog
        open={confirm === "signout"}
        title={`Sign out of ${title}?`}
        confirmLabel="Sign out"
        danger
        busy={logout.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => logout.mutate(undefined, { onSettled: () => setConfirm(null) })}
      >
        Conversations on this account can't start a turn until it is signed in again.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "remove"}
        title={`Remove ${title}?`}
        confirmLabel="Remove"
        danger
        busy={removing}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          onRemove?.();
        }}
      >
        Signs the account out and forgets it. Conversations that ran on it move to the default
        account.
      </ConfirmDialog>
    </div>
  );
}

/** One account's rate limits as ring gauges — per SUBSCRIPTION, so each account is its own
 *  query. A failure is stated, never an empty space that reads like "no limits": an account
 *  whose usage cannot be read is also one the auto-switch refuses to pick. */
function UsageRings({ accountId }: { accountId: string | null }) {
  const usage = usePlanUsage({ accountId });
  if (usage.isPending) {
    return (
      <div className={a.rings} aria-busy="true">
        <p className={a.note}>Reading usage…</p>
      </div>
    );
  }
  if (usage.error) return <p className={a.err}>{usageErrorText(usage.error)}</p>;
  const u: PlanUsage = usage.data;
  const scoped = u.scoped ?? [];
  if (!u.five_hour && !u.seven_day && scoped.length === 0) {
    return <p className={a.note}>No usage window reported for this account.</p>;
  }
  return (
    <>
      <div className={a.rings}>
        {u.five_hour ? <Ring label="5h" pct={u.five_hour.used_percentage} resetsAt={u.five_hour.resets_at} /> : null}
        {u.seven_day ? <Ring label="7d" pct={u.seven_day.used_percentage} resetsAt={u.seven_day.resets_at} /> : null}
      </div>
      {scoped.length ? (
        <div className={a.scoped}>
          {scoped.map((s) => (
            <span key={`${s.label}:${s.group ?? ""}`}>
              {s.label}
              {s.group === "weekly" ? " · 7d" : s.group === "session" ? " · 5h" : ""}{" "}
              <b>{Math.round(s.window.used_percentage)}%</b>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

function Ring({ label, pct, resetsAt }: { label: string; pct: number; resetsAt: string | null }) {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  const reset = fmtReset(resetsAt);
  return (
    <div className={a.ring}>
      <svg viewBox="0 0 54 54" role="img" aria-label={`${label} window: ${clamped}% used`}>
        <circle className={a.ringTrack} cx="27" cy="27" r={RING_R} />
        <circle
          className={a.ringValue}
          data-warn={clamped >= WARN_PERCENT ? "" : undefined}
          cx="27"
          cy="27"
          r={RING_R}
          strokeDasharray={`${(RING_C * clamped) / 100} ${RING_C}`}
        />
      </svg>
      <div>
        <span className={a.ringPct}>{clamped}%</span>
        <span className={a.ringLabel}>
          {label}
          {reset ? ` · ${reset}` : ""}
        </span>
      </div>
    </div>
  );
}

// ─── Switching ─────────────────────────────────────────────────────────────────────────

/** Where new conversations start, and the auto-switch policy — with the band that shows, for
 *  each account, how close it is to the thresholds. The auto-switch toggle is DISABLED, with
 *  the reason in its visible hint, while there is nowhere to switch to. */
function Switching({ options }: { options: { id: string | null; label: string }[] }) {
  const prefs = useClaudeAccountPrefs();
  const enough = options.length >= 2;
  // A stale default (its account removed) degrades to the default account, visibly.
  const selected = options.some((o) => o.id === prefs.defaultAccountId) ? prefs.defaultAccountId : null;

  return (
    <SettingsGroup title="Switching" icon="users">
      <ToggleRow
        title="Default account for new conversations"
        hint="Existing conversations keep the account they run on."
        control={
          <div className={a.seg} role="radiogroup" aria-label="Default account for new conversations">
            {options.map((o) => (
              <button
                key={o.id ?? "default"}
                type="button"
                role="radio"
                aria-checked={selected === o.id}
                className={a.segOpt}
                title={o.label}
                onClick={() => prefs.set({ defaultAccountId: o.id })}
              >
                {o.label}
              </button>
            ))}
          </div>
        }
      />
      <ToggleRow
        title="Auto-switch account near usage limit"
        hint={
          enough
            ? "Only between turns — never mid-turn or while background tasks run."
            : "Add a second Claude account to enable this — there is nowhere to switch to with only one."
        }
        checked={prefs.autoSwitch && enough}
        disabled={!enough}
        onChange={(next) => prefs.set({ autoSwitch: next })}
      />
      {prefs.autoSwitch && enough ? <ThresholdBand accounts={options} /> : null}
    </SettingsGroup>
  );
}

/** The two thresholds on a 0–100 % track: the hatched zone between them is the gap that stops
 *  the policy bouncing, amber past the trigger is "switch now", and every account sits at the
 *  peak of its 5h/7d windows. */
function ThresholdBand({ accounts }: { accounts: { id: string | null; label: string }[] }) {
  const prefs = useClaudeAccountPrefs();
  const at = prefs.switchAtPercent;
  const below = prefs.targetBelowPercent;
  // Read the usage every tile already fetched (same query keys, never fetching here), so the
  // band costs no extra request. An account whose usage cannot be read gets no marker rather
  // than a fake 0 %.
  const usages = useQueries({
    queries: accounts.map((acc) => ({
      queryKey: planUsageKey(acc.id),
      enabled: false,
    })),
  });
  const markers = clusterMarkers(
    accounts.flatMap((acc, i) => {
      const q = usages[i];
      const peak = q?.isError ? null : peakUsagePercent((q?.data as PlanUsage | undefined) ?? null);
      return peak === null
        ? []
        : [{ key: acc.id ?? "default", label: acc.label, pct: Math.min(100, Math.max(0, Math.round(peak))) }];
    }),
  );
  return (
    <div className={a.band}>
      <div className={a.track}>
        <div className={a.line} />
        <div className={a.gap} style={{ left: `${below}%`, width: `${at - below}%` }} />
        <div className={a.full} style={{ left: `${at}%` }} />
        {/* Two labels closer than this would collide; the steppers below carry the numbers
            anyway, so the nearer one simply goes quiet. */}
        {at - below >= 8 ? (
          <span className={a.tick} style={{ left: `${below}%` }}>
            {below}%
          </span>
        ) : null}
        <span className={a.tick} style={{ left: `${at}%` }}>
          {at}%
        </span>
        {markers.map((m) => (
          <span
            key={m.key}
            className={a.account}
            style={{ left: `${m.pct}%` }}
            data-over={m.pct >= at ? "" : undefined}
            data-edge={m.pct < 18 ? "start" : m.pct > 82 ? "end" : undefined}
            title={m.labels.join(", ")}
          >
            {m.labels.length === 1 ? m.labels[0] : `${m.labels.length} accounts`} · {m.pct}%
          </span>
        ))}
      </div>
      <div className={a.legend}>
        <span>0%</span>
        <span>Busiest 5h or 7d window</span>
        <span>100%</span>
      </div>
      <div className={a.controls}>
        <label className={a.control}>
          Switch at
          <Stepper
            id="auto-switch-at"
            value={at}
            min={50}
            max={99}
            onCommit={(next) =>
              // Keep the ceiling strictly below the trigger, but never RATCHET it: raising
              // the trigger back leaves the ceiling where the user put it.
              prefs.set({ switchAtPercent: next, targetBelowPercent: Math.min(below, next - 1) })
            }
          />
        </label>
        <label className={a.control}>
          Target below
          <Stepper
            id="auto-switch-below"
            value={below}
            min={1}
            max={at - 1}
            onCommit={(next) => prefs.set({ targetBelowPercent: next })}
          />
        </label>
      </div>
    </div>
  );
}

/** Accounts closer than this on the band share one marker: two labels a few points apart
 *  print on top of each other and neither can be read. */
const MARKER_MERGE_POINTS = 12;

/** Merge band markers that would collide into one, placed at the highest member (the one the
 *  auto-switch would react to first). Pure, so the grouping is testable on its own. */
export function clusterMarkers(
  points: { key: string; label: string; pct: number }[],
): { key: string; labels: string[]; pct: number }[] {
  const sorted = [...points].sort((x, y) => x.pct - y.pct);
  const out: { key: string; labels: string[]; pct: number; start: number }[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.pct - last.start < MARKER_MERGE_POINTS) {
      last.labels.push(p.label);
      last.key = `${last.key}+${p.key}`;
      last.pct = Math.max(last.pct, p.pct);
    } else {
      out.push({ key: p.key, labels: [p.label], pct: p.pct, start: p.pct });
    }
  }
  return out.map(({ key, labels, pct }) => ({ key, labels, pct }));
}

/** A percentage stepper: −/+ commit at once; typing commits on blur or Enter, never per
 *  keystroke (intermediate values like "" or "9" would otherwise reach the policy). An empty
 *  or out-of-range entry snaps back to the stored value. */
function Stepper({
  id,
  value,
  min,
  max,
  onCommit,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commitDraft = () => {
    const n = Number(draft.trim());
    if (draft.trim() === "" || !Number.isInteger(n) || n < min || n > max) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <span className={a.stepper}>
      <button
        type="button"
        className={a.stepBtn}
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onCommit(Math.max(min, value - 1))}
      >
        −
      </button>
      <input
        id={id}
        className={a.stepInput}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitDraft();
        }}
      />
      <button
        type="button"
        className={a.stepBtn}
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onCommit(Math.min(max, value + 1))}
      >
        +
      </button>
    </span>
  );
}

// ─── Codex ─────────────────────────────────────────────────────────────────────────────

function CodexAccount() {
  const status = useCodexAccount(true);
  const { loginStart, loginCancel, logout } = useCodexAccountActions();
  // "waiting" = URL opened; the dedicated app-server holds the OAuth callback and the
  // outcome arrives as the app-global `account_login` event.
  const [waiting, setWaiting] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const opener = useAuthUrlOpener();

  useEffect(() => {
    let disposed = false;
    const un = events.accountLoginEvent.listen((e) => {
      if (disposed || e.payload.backend !== "codex") return;
      setWaiting(false);
      setLoginErr(e.payload.success ? null : (e.payload.error ?? "sign-in failed"));
      // The panel surfaced this outcome live — consume the stash the always-mounted global
      // handler wrote for the panel-CLOSED case, so it isn't replayed on the next mount.
      useAccountLoginStore.getState().clear("codex");
    });
    return () => {
      disposed = true;
      void un.then((f) => f()).catch(() => {});
    };
  }, []);

  // A failure that landed while this panel was CLOSED (the async login can complete minutes
  // later): read the stashed reason on mount and consume it.
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
  // Codex reads its own account, not a cache shared with anything else, so its address is
  // always trustworthy — it names the tile like the Claude ones.
  const codexTitle = (logged && status.data?.email) || "Codex";
  const subLine = logged
    ? status.data?.planType
      ? `ChatGPT ${capitalize(status.data.planType)}`
      : "Connected"
    : status.isLoading
      ? "Checking…"
      : "Not connected";

  return (
    <section>
      <div className={a.provBar} data-backend="codex">
        <CodexMark />
        <span className={a.provName}>Codex</span>
      </div>
      <div className={a.tile}>
        <div className={a.head}>
          <span className={a.av} data-tone={logged ? "codex" : undefined}>
            <CodexMark />
          </span>
          <div className={a.who}>
            <div className={a.name} title={codexTitle}>
              <span className={a.nameText}>{codexTitle}</span>
            </div>
            <div className={a.sub}>{subLine}</div>
          </div>
          {waiting ? (
            <span className={a.pill} data-tone="wait">
              Signing in…
            </span>
          ) : status.isError ? (
            <span className={a.pill} data-tone="err">
              Unavailable
            </span>
          ) : logged ? (
            <>
              <span className={a.dot} title="Connected">
                <span className={a.srOnly}>Connected</span>
              </span>
              <Menu
                portal
                align="right"
                trigger={
                  <button type="button" className={a.kebab} aria-label="Actions for Codex">
                    ⋯
                  </button>
                }
              >
                <MenuItem onClick={() => setConfirmSignOut(true)}>Sign out</MenuItem>
              </Menu>
            </>
          ) : null}
        </div>

        {status.isLoading ? (
          <div className={a.skel} style={{ width: "45%" }} />
        ) : status.isError ? (
          <p className={a.err}>Status unavailable: {(status.error as Error).message}</p>
        ) : logged ? (
          <p className={a.note}>Codex reports its usage while a session runs — see a Codex conversation's context ring.</p>
        ) : waiting ? (
          <div className={a.signin}>
            <ol className={a.steps}>
              <li data-current="">Authorize in the browser — this finishes on its own</li>
            </ol>
            <div className={a.row}>
              <button type="button" className={`${a.btn} ${a.quiet}`} onClick={cancelLogin}>
                Cancel
              </button>
            </div>
            {opener.error && opener.url ? (
              <OpenUrlFallback error={opener.error} url={opener.url} onRetry={() => opener.open(opener.url!)} />
            ) : null}
          </div>
        ) : (
          <div className={a.row}>
            <p className={a.note} style={{ flex: 1 }}>
              Sign in to the ChatGPT account the codex CLI will use.
            </p>
            <button
              type="button"
              className={`${a.btn} ${a.primary}`}
              data-backend="codex"
              disabled={loginStart.isPending}
              onClick={startLogin}
            >
              <CodexMark /> {loginStart.isPending ? "Opening…" : "Sign in"}
            </button>
          </div>
        )}
        {err ? <p className={a.err}>{err}</p> : null}
      </div>
      <ConfirmDialog
        open={confirmSignOut}
        title="Sign out of Codex?"
        confirmLabel="Sign out"
        danger
        busy={logout.isPending}
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => logout.mutate(undefined, { onSettled: () => setConfirmSignOut(false) })}
      >
        Codex conversations can't start a turn until you sign in again.
      </ConfirmDialog>
    </section>
  );
}

// ─── CLI absent ────────────────────────────────────────────────────────────────────────

/** The binary is not installed: a muted tile pointing at the install command instead of a
 *  dead "Sign in" (signing in is impossible without the CLI). */
function UnavailableTile({ backend }: { backend: "claude" | "codex" }) {
  const claude = backend === "claude";
  return (
    <section>
      <div className={a.provBar} data-backend={backend}>
        {claude ? <ClaudeMark /> : <CodexMark />}
        <span className={a.provName}>{claude ? "Claude accounts" : "Codex"}</span>
      </div>
      <div className={a.tile}>
        <div className={a.head}>
          <span className={a.av}>{claude ? <ClaudeMark /> : <CodexMark />}</span>
          <div className={a.who}>
            <div className={a.name}>
              <span className={a.nameText}>{claude ? "Claude" : "Codex"}</span>
            </div>
            <div className={a.sub}>CLI not found</div>
          </div>
          <span className={a.pill} data-tone="idle">
            Not installed
          </span>
        </div>
        <p className={a.note}>
          {claude
            ? "Install Claude Code (npm i -g @anthropic-ai/claude-code) to connect an account."
            : "Install the Codex CLI (npm i -g @openai/codex) to connect an account."}
        </p>
      </div>
    </section>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────────────────

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "2h00" / "43min" / "3d" / "now" until a reset, from the endpoint's ISO timestamp (or
 *  epoch-seconds digits). `null` when unknown, so no reset is invented. */
function fmtReset(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const ms = /^\d+$/.test(resetsAt) ? Number(resetsAt) * 1000 : Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const secs = Math.floor((ms - Date.now()) / 1000);
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  }
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

/** A usage failure as one actionable sentence — never reduced to "unavailable", which would
 *  leave the user with nothing to do. */
function usageErrorText(e: UsageError): string {
  switch (e.kind) {
    case "no_token":
      return "No credentials for this account yet — sign it in.";
    case "keychain_denied":
      return `macOS refused access to this account's Keychain item (${e.detail}). Retry and choose “Always Allow”.`;
    case "unauthorized":
      return `The stored credentials were rejected (HTTP ${e.status}) — sign this account in again.`;
    case "rate_limited":
      return `The usage endpoint is rate-limiting requests${e.retry_after ? ` — retry in ${e.retry_after}s` : ""}.`;
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
