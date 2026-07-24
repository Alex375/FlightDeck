// Pure, store-free rendering of core `Notice` items — the shared visual language for the
// "zero silent error" contract. Split out of ConductorThread so BOTH the live thread
// (`NoticeRow`, store-keyed) AND the read-only transcript preview (`SubAgentTranscript`,
// used by the history panel + sub-agent drill-in) render an error notice the SAME way.
// Extracting it here (rather than importing from ConductorThread) avoids an import cycle:
// ConductorThread already imports SubAgentTranscript.
import { useState, type ReactNode } from "react";
import type { JsonValue } from "../../ipc/client";
import { Ico } from "../../ui/kit";
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
  task_failed: "A background task failed",
  history_error: "Problem restoring history",
};

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
