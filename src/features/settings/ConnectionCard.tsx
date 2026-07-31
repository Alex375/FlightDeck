// The "connection to a service" card and its satellites, shared by every sign-in surface
// in Settings: Accounts (Claude, Codex) and TOSSE. Purely presentational — every flow
// (which command to call, what a failure means) stays in the calling section.
//
// Extracted rather than duplicated: the three services differ only in brand accent, mark
// and copy, so a second copy of ~350 lines of CSS would have drifted the moment one card
// was restyled.
import { useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import s from "./ConnectionCard.module.css";

export { s as connectionStyles };

/** What the card shows: a live probe, an established session, none, or a broken probe. */
export type CardState = "loading" | "connected" | "disconnected" | "error";

/** A small badge under the identity line (plan, org, account type…). */
export interface CardPill {
  label: string;
  /** Renders in the brand accent — reserve it for the ONE headline fact (the plan). */
  plan?: boolean;
}

/**
 * The card shell: brand-themed frame with a mark tile, a live status chip, an
 * identity-or-invitation body, an actions row, and free-form sub-content (login sub-rows,
 * inline errors).
 *
 * `accent` is a CSS colour — pass a shared design token (`var(--wf-accent)`), never a raw
 * hex, so a brand tweak stays a single edit.
 */
export function ConnectionCard({
  accent,
  mark,
  name,
  provider,
  state,
  identity,
  pills,
  invite,
  actions,
  children,
}: {
  accent: string;
  mark: ReactNode;
  name: string;
  provider: string;
  state: CardState;
  /** The signed-in identity (email, or a name) — shown only in the connected state. */
  identity?: string | null;
  pills?: CardPill[];
  invite?: string;
  actions: ReactNode;
  children?: ReactNode;
}) {
  const chip =
    state === "connected"
      ? { tone: "ok", label: "Connected" }
      : state === "loading"
        ? { tone: "idle", label: "Checking…" }
        : state === "error"
          ? { tone: "off", label: "Unavailable" }
          : { tone: "off", label: "Not connected" };
  return (
    <section className={s.card} data-state={state} style={{ ["--brand" as string]: accent }}>
      <div className={s.head}>
        <span className={s.tile}>{mark}</span>
        <div className={s.headText}>
          <span className={s.brandName}>{name}</span>
          <span className={s.provider}>{provider}</span>
        </div>
        <span className={s.chip} data-tone={chip.tone}>
          <span className={s.chipDot} />
          {chip.label}
        </span>
      </div>

      <div className={s.body}>
        {state === "loading" ? (
          <>
            <div className={s.skelLine} style={{ width: "45%" }} />
            <div className={s.skelLine} style={{ width: "28%", marginTop: 10, height: 10 }} />
          </>
        ) : state === "connected" ? (
          <>
            <div className={s.email}>{identity ?? "Connected"}</div>
            {pills && pills.length ? (
              <div className={s.pills}>
                {pills.map((p) => (
                  <span key={p.label} className={p.plan ? `${s.pill} ${s.pillPlan}` : s.pill}>
                    {p.label}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className={s.invite}>{invite}</p>
        )}
      </div>

      <div className={s.actions}>{actions}</div>
      {children}
    </section>
  );
}

/** Inline fallback when the browser open failed: the error plus the auth URL itself,
 *  clickable (retries the opener) and selectable (copy by hand). */
export function OpenUrlFallback({
  error,
  url,
  onRetry,
}: {
  error: string;
  url: string;
  onRetry: () => void;
}) {
  return (
    <div className={s.err}>
      {error}
      {" — open this link manually: "}
      <span
        role="link"
        tabIndex={0}
        className={s.errLink}
        title="Retry opening in the browser — the text stays selectable so you can copy it"
        onClick={onRetry}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRetry();
        }}
      >
        {url}
      </span>
    </div>
  );
}

/** The browser-open step of a login flow. `openUrl`'s rejection is NEVER swallowed
 *  (zero-silent-error): it lands in `error`, and `url` keeps the auth link around so
 *  the UI can offer the manual fallback (clickable retry + copyable text) — the flow
 *  must stay completable even when the opener is broken (no default browser…). */
export function useAuthUrlOpener() {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (u: string) => {
    setUrl(u);
    setError(null);
    openUrl(u).catch((e: unknown) => {
      setError(`Unable to open the browser: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  return { url, error, open };
}

/** Sign-out button with an inline two-step confirmation (signing out is cheap to undo,
 *  so this stays lighter than a modal — but never a single stray click). */
export function LogoutControl({
  pending,
  onConfirm,
  label = "Sign out…",
}: {
  pending: boolean;
  onConfirm: () => void;
  label?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <>
        <span className={s.spacer} />
        <button className={`${s.btn} ${s.ghost}`} onClick={() => setConfirming(true)}>
          {label}
        </button>
      </>
    );
  }
  return (
    <>
      <span className={s.spacer} />
      <button className={`${s.btn} ${s.danger}`} disabled={pending} onClick={() => onConfirm()}>
        {pending ? "Signing out…" : "Confirm sign-out"}
      </button>
      <button className={`${s.btn} ${s.ghost}`} disabled={pending} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </>
  );
}
