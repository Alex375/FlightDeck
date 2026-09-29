// The side panel's Plan usage widget: how much of the subscription this conversation is billed
// against is used, per rate-limit window, and when each window resets. The header keeps the peak
// of the 5-hour and weekly windows, so the section can stay folded all day and still answer
// « how close am I ».
//
// Zero cost by construction:
//  - NO POLLER, NO FETCH ON MOUNT. It reads the plan-usage cache the composer's ring, the Flight
//    Deck cards and the context popover already keep warm (`useConversationPlanUsage`,
//    `enabled: false`), so opening the panel on a never-run conversation reads no credentials and
//    pops no Keychain prompt. The only fetch it can cause is the user's click (Load / refresh).
//  - ONE CLOCK, IN THE BODY. The countdowns and the « Updated … ago » line need a minute tick; it
//    lives in the body, which a folded section unmounts, runs only while something on screen
//    reads relative to now (`needsClock`), and pauses while the window is hidden. The folded
//    header reads the same derivation on its own renders.
//  - ONE `now` PER RENDER. The view is derived once, in the root, and carries every
//    time-relative word (`resetText`, `updatedText`): the body never reads the clock itself, so a
//    body re-rendering on its own (a display pref, the account list) cannot pair a row the view
//    calls live with a countdown that has already run out.
//  - Every word is decided by the pure `planWidgetState` (tested); this file only draws it.

import { useReducer, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Ico, usageErrorCopy, type PlanInfo, type PlanUsageError } from "../../../ui/kit";
import { Tooltip } from "../../../ui/Tooltip";
import { motionAllowed } from "../../../ui/motion";
import { useMinuteTick } from "../../../ui/useMinuteTick";
import { useDisplay } from "../../../store/display";
import { useConversationStore } from "../../../store/conversationStore";
import { useClaudeAccountList } from "../../../store/claudeAccounts";
import { useCodexAvailable } from "../../../store/binaryAvailable";
import type { Conversation } from "../../../store/conversationsStore";
import {
  useClaudeAccountIdentity,
  useClaudeAccounts,
  useClaudeDefaultIdentity,
} from "../../../ipc/useAccounts";
import { PanelSection } from "../PanelSection";
import { useConversationPlanUsage, type ConversationPlanUsage } from "../backendUsage";
import {
  planAccountName,
  planWidgetState,
  type PlanWidgetNotice,
  type PlanWidgetRow,
  type PlanWidgetView,
} from "./planWidgetState";
import s from "../ConversationSidePanel.module.css";
import w from "./PlanUsageWidget.module.css";

/**
 * The Plan usage section for `conv`. Always renders: even with no figure there is something true
 * to say (billed to a server, Codex not heard from yet, not loaded), and the header's « — » is
 * that answer folded.
 */
export function PlanUsageWidget({ conv }: { conv: Conversation }) {
  const data = useConversationPlanUsage(conv.id);
  const plan = useCoarsePlan(conv.id);
  // The body owns the minute tick; this lets it re-render the WHOLE section, so the header's
  // peak drops a window at its reset in the same frame the row flips to « resetting… ».
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const view = planWidgetState(
    {
      backend: data.backend,
      remote: data.remote,
      usage: data.usage,
      error: data.error,
      updatedAt: data.updatedAt,
      plan,
    },
    Date.now(),
  );
  return (
    <PanelSection
      id="plan"
      icon={<Ico name="clock" className="sm" />}
      title="Plan usage"
      meta={<PeakMeta view={view} />}
    >
      <PlanBody data={data} view={view} onTick={rerender} />
    </PanelSection>
  );
}

/** The coarse stream status (`rate_limit_event`), as the popover's `PlanInfo`. Shallow-compared,
 *  so a state event that re-sends the same snapshot does not re-render the section. */
function useCoarsePlan(convId: string): PlanInfo | null {
  const rl = useConversationStore(
    useShallow((st) => st.sessions[convId]?.state?.rate_limit ?? null),
  );
  return rl
    ? {
        status: rl.status,
        resetsAt: rl.resets_at,
        limitType: rl.limit_type,
        usingOverage: rl.using_overage,
      }
    : null;
}

/** What the header's reading means, for its tooltip. */
function peakTip(view: PlanWidgetView): string {
  if (view.peak !== null) {
    return view.peakStale
      ? "Highest of the 5-hour and weekly windows — last known, the latest refresh failed"
      : "Highest of the 5-hour and weekly windows";
  }
  switch (view.body.kind) {
    case "remote":
      return "Billed to the server's own account";
    case "codex-waiting":
      return "No Codex figures yet";
    case "unloaded":
      return "Not loaded yet";
    case "error":
      return "Couldn't read the plan's usage";
    default:
      return "No current 5-hour or weekly reading";
  }
}

/** The header's reading: the peak %, amber from 80 %, or « — ». Folded, it is the section. */
function PeakMeta({ view }: { view: PlanWidgetView }) {
  const tip = peakTip(view);
  // The trigger's accessible name replaces its text, so it carries the figure too.
  const label = view.peak === null ? `No reading — ${tip}` : `${view.peak}% — ${tip}`;
  return (
    // The wrapper is the header's flex item: an inline-flex box, so the capsule inside sits on no
    // line box (a bare inline span would add a descender gap under it).
    <Tooltip className={w.peakWrap} content={tip} label={label}>
      <span
        className={`${s.meta} ${w.peak} wf-mono`}
        data-level={view.peakLevel !== "ok" ? view.peakLevel : undefined}
        data-stale={view.peakStale || undefined}
      >
        {view.peak === null ? "—" : `${view.peak}%`}
      </span>
    </Tooltip>
  );
}

function PlanBody({
  data,
  view,
  onTick,
}: {
  data: ConversationPlanUsage;
  view: PlanWidgetView;
  onTick: () => void;
}) {
  // The widget's only timer: mounted with the body, so a folded section has none.
  useMinuteTick(view.needsClock, onTick);
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));
  const codexAvailable = useCodexAvailable();
  // Two or more Claude accounts (the default + an extra one): only then is « whose figures » a
  // question worth a line. The mirror is loaded at boot — a free read.
  const multiAccount = useClaudeAccountList((st) => (st.accounts?.length ?? 0) > 0);
  const b = view.body;

  if (b.kind === "remote") {
    return (
      <p className={w.note}>
        {/* The core refuses a Codex spawn on a remote repo (Claude-only for now), so a Codex
            conversation there has no plan at all — say that rather than borrow this Mac's. */}
        {data.backend === "codex"
          ? "Remote conversations run Claude only — no Codex plan applies here."
          : "Billed to the server's own Claude account — its usage can't be read from this Mac."}
      </p>
    );
  }

  const notices = view.notices.map((n) => <NoticeLine key={n.text} notice={n} />);

  if (b.kind === "codex-waiting") {
    return (
      <>
        <p className={w.note}>Codex reports its limits once a Codex conversation runs.</p>
        {notices}
      </>
    );
  }

  // Whose figures: the account's address when there is a choice of accounts, else the backend's
  // name when both backends are installed (Max and ChatGPT are two different plans), else nothing.
  const source =
    data.backend === "claude" && multiAccount ? (
      <AccountName accountId={data.accountId} />
    ) : codexAvailable ? (
      <span className={w.source}>{data.backend === "codex" ? "Codex" : "Claude"}</span>
    ) : null;

  if (b.kind === "unloaded") {
    return (
      <>
        <div className={w.empty}>
          <span className={`${w.dash} wf-mono`} aria-hidden="true">
            —
          </span>
          <span className={w.emptyText}>
            <span className={w.emptyTitle}>{data.fetching ? "Loading…" : "Not loaded yet"}</span>
            <span className={w.emptySub}>Loads by itself once this conversation runs.</span>
          </span>
          {data.refresh ? (
            <button
              type="button"
              className={s.textBtn}
              onClick={data.refresh}
              disabled={data.fetching}
              title="Read this account's usage now"
            >
              Load
            </button>
          ) : null}
        </div>
        {notices}
        {source ? <PlanFoot status={null} source={source} /> : null}
      </>
    );
  }

  // From here the footer carries the refresh — hidden only when a retry cannot help.
  const failure = b.kind === "error" ? b.error : b.kind === "bars" ? b.staleError : null;
  const refreshable = !!data.refresh && (!failure || usageErrorCopy(failure).retry);
  const status = data.fetching
    ? failure && b.kind === "error"
      ? "Retrying…"
      : "Refreshing…"
    : view.updatedText
      ? `Updated ${view.updatedText}`
      : null;
  const foot = (
    <PlanFoot
      status={status}
      source={source}
      onRefresh={refreshable ? data.refresh : undefined}
      busy={data.fetching}
      retry={!!failure}
    />
  );

  if (b.kind === "error") {
    return (
      <>
        <UsageErrorLine error={b.error} stale={false} />
        {notices}
        {foot}
      </>
    );
  }

  if (b.kind === "none-reported") {
    return (
      <>
        <p className={w.note}>
          {data.backend === "codex"
            ? "Codex reported no 5-hour or weekly window."
            : "No usage window reported for this account."}
        </p>
        {notices}
        {foot}
      </>
    );
  }

  return (
    <>
      {b.rows.map((r) => (
        <WindowBlock key={r.key} row={r} motion={motion} />
      ))}
      {notices}
      {/* Never silent: a failed refresh keeps the bars but says they may be stale. */}
      {b.staleError ? <UsageErrorLine error={b.staleError} stale /> : null}
      {foot}
    </>
  );
}

/** One window: label and figure, the bar, the reset. */
function WindowBlock({ row, motion }: { row: PlanWidgetRow; motion: boolean }) {
  return (
    <div
      className={w.win}
      data-level={row.past || row.level === "ok" ? undefined : row.level}
      data-past={row.past || undefined}
    >
      <div className={w.winTop}>
        <span className={w.winLabel}>{row.label}</span>
        <span className={`${w.winPct} wf-mono`}>{row.pct}%</span>
      </div>
      <span
        className={w.track}
        data-motion={motion || undefined}
        role="progressbar"
        aria-label={`${row.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={row.pct}
        // A past window's figure is no reading of now: say so to assistive tech too.
        aria-valuetext={row.past ? `${row.pct}%, resetting` : undefined}
      >
        <span
          className={w.fill}
          data-level={row.level === "ok" ? undefined : row.level}
          style={{ width: `${row.pct}%` }}
        />
      </span>
      {row.resetText ? <span className={w.winReset}>{row.resetText}</span> : null}
    </div>
  );
}

/** A coarse-status line (« Limit reached · resets in 2h14 », « Overage active »). */
function NoticeLine({ notice }: { notice: PlanWidgetNotice }) {
  return (
    <div className={w.notice} data-tone={notice.tone}>
      {notice.tone === "lo" ? null : <Ico name="alert" className="sm" />}
      <span>{notice.text}</span>
      {notice.resetText ? <span className={w.noticeReset}>· {notice.resetText}</span> : null}
    </div>
  );
}

/**
 * A failed read, in the popover's words (`usageErrorCopy`), compacted for the panel:
 *  - no figures to show: the message and the next step;
 *  - figures shown above (`stale`): one line saying they may be stale, the cause behind Details.
 * An expired sign-in reads as a note, not a fault — the figure comes back by itself once a
 * session on the account refreshes the token.
 */
function UsageErrorLine({ error, stale }: { error: PlanUsageError; stale: boolean }) {
  const [open, setOpen] = useState(false);
  const c = usageErrorCopy(error);
  const note = error.kind === "token_expired";
  const compact = stale && !note;
  const tone = note ? "note" : stale ? "warn" : "err";
  // What « Details » reveals: the cause and its next step when the head only says « stale »,
  // the raw detail otherwise.
  const more = compact
    ? [c.msg, c.action, c.detail].filter(Boolean).join("\n")
    : c.detail;
  return (
    <div className={w.err} data-tone={tone}>
      <span className={w.errHead}>
        {note ? null : <Ico name="alert" className="sm" />}
        <span>{compact ? "Refresh failed — figures may be stale." : c.msg}</span>
      </span>
      {compact ? null : <span className={w.errAct}>{c.action}</span>}
      {more ? (
        <>
          <button
            type="button"
            className={w.errMore}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? "Hide details" : "Details"}
          </button>
          {open ? <pre className={w.errPre}>{more}</pre> : null}
        </>
      ) : null}
    </div>
  );
}

/** The footer: how fresh the figures are, whose they are, and the refresh (a click only). */
function PlanFoot({
  status,
  source,
  onRefresh,
  busy,
  retry,
}: {
  status: string | null;
  source: ReactNode;
  onRefresh?: () => void;
  busy?: boolean;
  retry?: boolean;
}) {
  // Nothing to date, name or retry (a failure a retry cannot fix, one account, no Codex): no
  // footer at all rather than an empty 22px row.
  if (!status && !source && !onRefresh) return null;
  const label = retry ? "Retry reading the plan's usage" : "Refresh the plan's usage";
  return (
    <div className={w.foot}>
      {status ? <span className={w.ago}>{status}</span> : null}
      {status && source ? (
        <span className={w.sep} aria-hidden="true">
          ·
        </span>
      ) : null}
      {source}
      {onRefresh ? (
        <button
          type="button"
          className={w.refresh}
          onClick={onRefresh}
          disabled={busy}
          title={label}
          aria-label={label}
        >
          <Ico name="refresh" className="sm" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The Claude account the figures belong to, named like the composer's account chip names it.
 *
 * ⚠️ Every query here is read with `enabled: false`: an identity query reads that account's token
 * (a possible Keychain prompt), so this line only shows what the chip and Settings → Accounts
 * have ALREADY read, falling back to the address captured at sign-in and then the label.
 */
function AccountName({ accountId }: { accountId: string | null }) {
  const liveEmail = useClaudeAccountIdentity(accountId, false).data?.email ?? null;
  const defaultCapturedEmail = useClaudeDefaultIdentity(false).data?.email ?? null;
  const record = useClaudeAccounts(false).data?.find((a) => a.id === accountId) ?? null;
  const mirrorLabel = useClaudeAccountList(
    (st) => st.accounts?.find((a) => a.id === accountId)?.label ?? null,
  );
  const name = planAccountName({
    accountId,
    liveEmail,
    defaultCapturedEmail,
    record,
    mirrorLabel,
  });
  const tip = `Figures of the Claude account ${name}`;
  return (
    <Tooltip className={w.source} content={tip} label={tip}>
      {name}
    </Tooltip>
  );
}
