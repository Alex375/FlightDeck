import { useEffect } from "react";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { isDismissable, type AgentStatus } from "../../agent/status";
import { acknowledgeConversation } from "../../store/conversationsStore";
import { useSendMessage } from "../../ipc/useCommands";
import { useDisplay } from "../../store/display";
import { Ico } from "../../ui/kit";

/**
 * A clear, contextual acknowledge bar shown above the composer when the active
 * conversation is in a non-blocking "reminder" state — review (turn finished),
 * an error to acknowledge, or an open question the heuristic flagged. It makes
 * the "mark as seen" action discoverable: the small ✓ on the sidebar row is a
 * shortcut, but a first-time user wouldn't know it exists, so the labelled button
 * here ("Mark as seen") is the obvious way to clear the conversation back to
 * idle. Not shown for real blocks (questionnaire / permission) — those must be
 * answered in the thread, not dismissed (see `isDismissable`).
 */
function reviewLabel(s: AgentStatus): string {
  switch (s.kind) {
    case "review":
      return "Conversation ended";
    case "error":
      return s.message;
    case "needInput":
      return "Waiting for your reply";
    default:
      return "";
  }
}

function reviewTone(s: AgentStatus): "review" | "input" | "error" {
  if (s.kind === "error") return "error";
  if (s.kind === "needInput") return "input";
  return "review";
}

/**
 * ⌘/Ctrl+Enter = "Mark as seen" while a dismissable reminder (review / error / open
 * question) is on screen, whatever its tone. Captured at the window level so it wins over
 * the composer's Enter-to-send handler (same capture trick the composer uses for Escape —
 * WKWebView can swallow keys inside the textarea). Wired only while `active`; otherwise
 * ⌘Enter is left untouched (falls through to the composer). Shared by this bar and the
 * in-composer {@link ComposerStatusBand} — exactly one of the two is active at a time.
 */
export function useMarkSeenShortcut(session: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        acknowledgeConversation(session);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, session]);
}

/** Reads only the pref: when the status lives inside the composer instead (Settings →
 *  Display → Appearance), the band there renders these same states and this bar stands
 *  down entirely — nothing below is mounted, so no second status derivation or ⌘↵ handler. */
export function ReviewBar({ session }: { session: string }) {
  const inComposer = useDisplay((d) => d.composerStatusBand);
  return inComposer ? null : <ClassicReviewBar session={session} />;
}

function ClassicReviewBar({ session }: { session: string }) {
  const status = useAgentStatus(session);
  const send = useSendMessage(session);
  const dismissable = isDismissable(status);
  useMarkSeenShortcut(session, dismissable);

  // Background work still running while the main turn is done: a calm GREEN (running-family)
  // bar, NOT the blue "to review" — there is nothing to review yet, the agent resumes on its
  // own when the workflow / sub-agent finishes. Non-dismissable (no acknowledge button).
  if (status.kind === "backgrounding") {
    const n = status.count;
    return (
      <div className="cv-reviewbar" data-tone="backgrounding">
        <span className="cv-reviewbar-dot" />
        <span className="cv-reviewbar-label">
          {n > 1 ? `${n} background tasks running…` : "Background task running…"}
        </span>
      </div>
    );
  }

  if (!dismissable) return null;
  // "Continue" only makes sense after an ERROR — send a "continue" message so Claude
  // retries from where it broke. NOT on `review` (a turn that finished cleanly has
  // nothing to resume), nor on `needInput` (needs a real answer, not a blind resume).
  // Sending clears the reminder (addUserTurn), so the bar closes on its own.
  const canContinue = status.kind === "error";
  return (
    <div className="cv-reviewbar" data-tone={reviewTone(status)}>
      <span className="cv-reviewbar-dot" />
      <span className="cv-reviewbar-label">{reviewLabel(status)}</span>
      {canContinue ? (
        <button
          type="button"
          className="cv-reviewbar-btn"
          onClick={() => send.mutate({ text: "continue" })}
          title='Resend "continue" so Claude picks the work back up'
        >
          <Ico name="play" className="sm" />
          Continue
        </button>
      ) : null}
      <button
        type="button"
        className="cv-reviewbar-btn"
        onClick={() => acknowledgeConversation(session)}
        title="Move the conversation back to grey (inactive) — ⌘↵"
      >
        <Ico name="check" className="sm" />
        Mark as seen
      </button>
    </div>
  );
}
