// Pure, store-free rendering of core `Notice` items — the shared visual language for the
// "zero silent error" contract. Split out of ConductorThread so BOTH the live thread
// (`NoticeRow`, store-keyed) AND the read-only transcript preview (`SubAgentTranscript`,
// used by the history panel + sub-agent drill-in) render an error notice the SAME way.
// Extracting it here (rather than importing from ConductorThread) avoids an import cycle:
// ConductorThread already imports SubAgentTranscript.
import { useState, type ReactNode } from "react";
import type { BackgroundTask, JsonValue } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import { Tooltip } from "../../ui/Tooltip";
import { fmtTokens } from "../../store/contextData";
import { fmtDuration } from "../../agent/subagentMeta";
import styles from "./ConductorThread.module.css";

/** An error bubble with an optional heading and a collapsed "technical detail" disclosure.
 *  Pure presentational — no store, no side effects. */
export function ErrorBlock({
  heading,
  children,
  detail,
}: {
  heading?: ReactNode;
  children?: ReactNode;
  /** Raw technical detail, hidden behind a disclosure (collapsed by default). */
  detail?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.errorBubble} role="alert">
      <Ico name="alert" className={"sm " + styles.errorBubbleIco} />
      <div className={styles.errorBody}>
        {heading ? <div className={styles.errorHeading}>{heading}</div> : null}
        {children ? <div className={styles.errorText}>{children}</div> : null}
        {detail ? (
          <>
            <button
              type="button"
              className={styles.errorToggle}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "Hide details" : "Technical details"}
            </button>
            {open ? <pre className={styles.errorDetail}>{detail}</pre> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Heading for each error-bearing notice subtype the core can emit. Any subtype
 *  listed here (plus the generic `error`) renders as a visible error bubble; subtypes
 *  absent from this map stay quiet (e.g. `control_change`). This is the front half of the
 *  "zero silent error" contract: a layer surfaces an error by emitting
 *  `Notice{subtype, detail:{message, detail?}}` and it shows up here with no extra plumbing. */
export const NOTICE_ERROR_HEADINGS: Record<string, string> = {
  process_exited: "The Claude Code session stopped unexpectedly",
  session_crashed: "The Claude Code session crashed",
  send_failed: "Message not delivered to Claude Code",
  protocol_error: "Protocol error",
  session_budget_exceeded: "Codex session budget exceeded",
  permission_error: "Unreadable permission request",
  history_error: "Problem restoring history",
  // The CLI's summarization failed (`system/status` `compact_result:"failed"`): the context
  // was NOT freed, so the next turn may hit the window's limit.
  compact_failed: "Compaction failed",
  // A terminal ssh-level failure (key refused / host identity changed) — see
  // `ssh_link::classify_transport_close` (Rust). Falls through to the generic
  // heading-lookup path below; `detail.message` already carries the specific
  // wording (which of the two, and what to do about it).
  remote_link_blocked: "Can't reach this server",
};

/** The `detail` payload of a `task_failed` notice, built from the failed background task's
 *  snapshot. The producer (`onTask`) and the renderer (`NoticeBlock`) share this one shape:
 *  `message` is the plain-text line (also what `read_conversation` hands other agents),
 *  `label` the task's name, `detail` the collapsed technical detail. */
export function taskFailedDetail(task: BackgroundTask): Record<string, JsonValue> {
  const label = task.label?.trim() || null;
  const parts: string[] = [];
  if (task.summary) parts.push(task.summary);
  if (task.output_file) parts.push(`output: ${task.output_file}`);
  return {
    message: label ? `Background task failed: ${label}` : "Background task failed",
    label,
    detail: parts.length ? parts.join("\n") : null,
  };
}

/** A failed background task: a discreet inline line — the same weight as a failed tool step
 *  (small alert glyph, muted text), NOT an error bubble. Such a failure is common and benign
 *  (Claude gets it via its `<task-notification>` and handles it), so it must not read as the
 *  conversation itself failing — but it stays visible, with its detail one click away. */
function TaskFailedLine({ label, detail }: { label: string | null; detail: string | null }) {
  return (
    <TaskEndLine
      icon="alert"
      iconClass={styles.taskFailedIco}
      heading="Background task failed"
      label={label}
      reason={null}
      detail={detail}
    />
  );
}

/** A background task the CLI stopped on its OWN (its time limit, memory pressure, a worker
 *  restart): the same discreet line as a failure, with the reason spelled out. On the wire
 *  such a stop is a bare `stopped` — the user's own Stop looks the same — so without this
 *  line a dev server simply vanished from the bar at its 30th minute, read as a crash. */
function TaskStoppedLine({
  heading,
  label,
  reason,
  detail,
}: {
  heading: string;
  label: string | null;
  reason: string | null;
  detail: string | null;
}) {
  return (
    <TaskEndLine
      icon="stopc"
      iconClass={styles.taskStoppedIco}
      heading={heading}
      label={label}
      reason={reason}
      detail={detail}
    />
  );
}

/** The shared shape of a background task's end line: glyph, heading, the task's name, an
 *  optional reason, and the technical detail one click away. */
function TaskEndLine({
  icon,
  iconClass,
  heading,
  label,
  reason,
  detail,
}: {
  icon: string;
  iconClass: string;
  heading: string;
  label: string | null;
  reason: string | null;
  detail: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.taskFailed}>
      <div className={styles.controlChange}>
        <Ico name={icon} className={"sm " + iconClass} />
        <span>
          {heading}
          {label ? ": " : ""}
          {label ? <b>{label}</b> : null}
          {reason ? ` — ${reason}` : null}
        </span>
        {detail ? (
          <button
            type="button"
            className={styles.taskFailedToggle}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide details" : "Details"}
          </button>
        ) : null}
      </div>
      {open && detail ? <pre className={styles.taskFailedDetail}>{detail}</pre> : null}
    </div>
  );
}

/** The facts line under a compaction separator — "auto · 970k → 25k tokens · 1m 49s" — from a
 *  `compact_boundary` notice's detail. Each part shows only when the backend reported it (Codex
 *  reports none, an older `claude` no `post_tokens`), so `null` = nothing known beyond the
 *  fact itself. Shared with `read_conversation`, which hands the same line to other agents. */
export function compactSummary(d: Record<string, JsonValue> | null): string | null {
  const num = (k: string): number | null => {
    const v = d?.[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  };
  const parts: string[] = [];
  const trigger = d?.trigger;
  if (typeof trigger === "string" && trigger.trim()) parts.push(trigger.trim());
  const pre = num("pre_tokens");
  const post = num("post_tokens");
  if (pre != null && post != null) parts.push(`${fmtTokens(pre)} → ${fmtTokens(post)} tokens`);
  else if (pre != null) parts.push(`${fmtTokens(pre)} tokens summarized`);
  const ms = num("duration_ms");
  // Whole seconds: "13s" reads better than "13.3s" on a one-off fact.
  if (ms != null && ms > 0) parts.push(fmtDuration(ms < 1000 ? ms : Math.round(ms / 1000) * 1000));
  return parts.length ? parts.join(" · ") : null;
}

/** A compaction: a full-width separator, since everything above it now reaches the model only
 *  as a summary. The facts line rides under it when the backend reported any. */
function CompactSeparator({ detail }: { detail: Record<string, JsonValue> | null }) {
  const summary = compactSummary(detail);
  const explain =
    "Earlier messages were summarized to free up context. They stay visible here, but the model now works from that summary.";
  return (
    <div className={styles.compactSep} role="separator" aria-label="Conversation compacted">
      <div className={styles.compactSepRule}>
        <Tooltip content={explain} label={explain} className={styles.compactSepLabel}>
          <Ico name="layers" className="sm" />
          Conversation compacted
        </Tooltip>
      </div>
      {summary ? <div className={styles.compactSepMeta + " wf-mono"}>{summary}</div> : null}
    </div>
  );
}

/** Pull a human-readable detail string out of a notice's raw `detail` payload, for the
 *  collapsed "Technical details" disclosure. Prefers explicit `detail`, then any technical
 *  fields (stderr / exit code), else nothing. */
export function noticeDetailText(d: Record<string, JsonValue> | null): string | null {
  if (!d) return null;
  if (typeof d.detail === "string" && d.detail.trim()) return d.detail;
  const lines: string[] = [];
  if (typeof d.stderr === "string" && d.stderr.trim()) lines.push(d.stderr.trimEnd());
  if (d.exit_code != null) lines.push(`exit code: ${String(d.exit_code)}`);
  if (typeof d.signal === "string" && d.signal) lines.push(`signal: ${d.signal}`);
  if (lines.length) return lines.join("\n");
  return null;
}

/** Render ONE notice from its `subtype` + raw `detail` — store-free, so it works both for a
 *  live notice (read from the store by `NoticeRow`) and one embedded in a settled transcript
 *  (the history preview). Mirrors the live thread's routing exactly:
 *   - `control_change`: a subtle inline "control: from → to" line.
 *   - `task_failed`: a discreet inline line (failed background task) with a detail toggle.
 *   - `compact_boundary`: a full-width "Conversation compacted" separator.
 *   - `control_error` + every subtype in NOTICE_ERROR_HEADINGS (and the generic `error`):
 *     a visible red error bubble — never silent.
 *   - any other subtype: nothing (stays quiet). */
export function NoticeBlock({ subtype, detail }: { subtype: string; detail: JsonValue }) {
  const d = (detail ?? null) as Record<string, JsonValue> | null;
  const get = (k: string): string | undefined => {
    const v = d?.[k];
    return typeof v === "string" ? v : undefined;
  };

  if (subtype === "control_change") {
    return (
      <div className={styles.controlChange}>
        <Ico name={get("icon") ?? "spark"} className="sm" />
        <span>
          {get("control")}: <b>{get("from")}</b> → <b>{get("to")}</b>
        </span>
      </div>
    );
  }

  // Informational, NOT errors: content the CLI injected into the transcript as a `user`
  // line that the human never typed. These used to render as full user bubbles with the
  // human's avatar ("[Request interrupted by user]", another slash command's stdout) —
  // they are real information, so they stay visible, but attributed to the system rather
  // than to the user. Same subtle inline treatment as `control_change`.
  if (subtype === "interrupted" || subtype === "command_output") {
    return (
      <div className={styles.controlChange}>
        <Ico name={subtype === "interrupted" ? "stop" : "term"} className="sm" />
        <span>{get("message")}</span>
      </div>
    );
  }

  // Remote-session link lifecycle (flightdeckd attach): connection lost /
  // reconnected / remote exit / takeover / resend hint. Informational, not an
  // error bubble — a cut is self-healing (the daemon keeps the session and
  // replays on reattach) — but it must be VISIBLE so the user knows a gap
  // happened and whether their last message needs resending.
  if (subtype === "remote_link") {
    return (
      <div className={styles.controlChange}>
        <Ico name="globe" className="sm" />
        <span>{get("message")}</span>
      </div>
    );
  }

  if (subtype === "compact_boundary") return <CompactSeparator detail={d} />;

  if (subtype === "task_failed") {
    const detailText = get("detail");
    return <TaskFailedLine label={get("label") ?? null} detail={detailText?.trim() ? detailText : null} />;
  }

  if (subtype === "task_stopped") {
    const detailText = get("detail");
    return (
      <TaskStoppedLine
        heading={get("heading") ?? "Background task stopped"}
        label={get("label") ?? null}
        reason={get("reason") ?? null}
        detail={detailText?.trim() ? detailText : null}
      />
    );
  }

  if (subtype === "control_error") {
    return (
      <ErrorBlock detail={noticeDetailText(d)}>
        Setting "{get("control") ?? "control"}" rejected by Claude Code
        {get("message") ? `: ${get("message")}` : ""}.
      </ErrorBlock>
    );
  }

  const heading = NOTICE_ERROR_HEADINGS[subtype] ?? (subtype === "error" ? "Error" : null);
  if (heading) {
    return (
      <ErrorBlock heading={heading} detail={noticeDetailText(d)}>
        {get("message") ?? null}
      </ErrorBlock>
    );
  }
  return null;
}
