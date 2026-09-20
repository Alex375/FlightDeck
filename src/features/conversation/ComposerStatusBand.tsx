// The conversation's settled status, carried INSIDE the composer card: a header band on
// top of the card (icon · label · detail · actions), and — via `.cv-composer:has(...)` in
// the stylesheet — the card's own border tinted in the state colour, with a soft halo
// (breathing for a question). It replaces the full-width ReviewBar above the composer when
// the `composerStatusBand` display pref is on (the default); exactly one of the two renders.
//
// Same states and actions as the ReviewBar: review / open question / error are dismissable
// ("Mark as seen", ⌘↵), an error also offers "Continue", and background work still running
// after the turn is a calm, non-dismissable band. Blocking states (permission, questionnaire)
// render nothing — they are answered in the thread.

import { lastTurnResultMeta, useAgentStatus } from "../../agent/useAgentStatus";
import { backgroundCount, isDismissable, questionExcerpt } from "../../agent/status";
import { acknowledgeConversation } from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import { useSendMessage } from "../../ipc/useCommands";
import { useDisplay } from "../../store/display";
import { fmtDuration } from "../../agent/subagentMeta";
import { Ico } from "../../ui/kit";
import { useMarkSeenShortcut } from "./ReviewBar";

/** The finished turn's wall-clock, next to "Conversation ended". Its own leaf, mounted only
 *  in the review state. Live-only: a conversation restored from disk has no `turn_result`
 *  (and is already marked seen), so it shows nothing — and the timeline scan is gated on
 *  the same "settled and unseen" condition as `gather` in useAgentStatus, so it never walks
 *  a restored timeline on every store update. */
function EndedAfter({ session }: { session: string }) {
  const ms = useConversationStore((s) => {
    const entry = s.sessions[session];
    if (!entry || entry.turnSeen || entry.state.busy) return null;
    return lastTurnResultMeta(entry)?.durationMs ?? null;
  });
  if (ms == null) return null;
  return (
    <>
      <span className="cv-sband-sep">·</span>
      <span className="cv-sband-detail cv-sband-num">{fmtDuration(ms)}</span>
    </>
  );
}

/** Reads only the pref: when the classic bar is chosen, nothing below is mounted — no
 *  second status derivation, no second ⌘↵ handler. */
export function ComposerStatusBand({ session }: { session: string }) {
  const enabled = useDisplay((d) => d.composerStatusBand);
  return enabled ? <StatusBand session={session} /> : null;
}

function StatusBand({ session }: { session: string }) {
  const status = useAgentStatus(session);
  const send = useSendMessage(session);
  const dismissable = isDismissable(status);
  useMarkSeenShortcut(session, dismissable);

  // Turn done, background work still running: calm and neutral — nothing to review yet,
  // the agent resumes on its own when the work lands. No action to offer.
  if (status.kind === "backgrounding") {
    const n = status.count;
    return (
      <div className="cv-sband" data-tone="bg" role="status">
        <span className="cv-sband-dot" aria-hidden="true" />
        <span className="cv-sband-label">
          {n > 1 ? `${n} background tasks running` : "Background task running"}
        </span>
        <span className="cv-sband-sep">·</span>
        <span className="cv-sband-detail">
          {n > 1 ? "the agent resumes when they finish" : "the agent resumes when it finishes"}
        </span>
      </div>
    );
  }

  if (!dismissable) return null;

  const tone = status.kind === "error" ? "error" : status.kind === "needInput" ? "need" : "review";
  const bg = backgroundCount(status);
  // The open question's `prompt` is the WHOLE last assistant message; show the question.
  const question = status.kind === "needInput" ? questionExcerpt(status.prompt) : null;
  return (
    <div className="cv-sband" data-tone={tone} role="status">
      <Ico name={tone === "error" ? "alert" : tone === "need" ? "chat" : "check"} className="cv-sband-ico" />
      {status.kind === "error" ? (
        <>
          <span className="cv-sband-label">Error</span>
          <span className="cv-sband-sep">·</span>
          <span className="cv-sband-detail" title={status.message}>
            {status.message}
          </span>
        </>
      ) : status.kind === "needInput" ? (
        <>
          <span className="cv-sband-label">Waiting for your reply</span>
          {question ? (
            <>
              <span className="cv-sband-sep">·</span>
              <span className="cv-sband-detail" title={question}>
                {question}
              </span>
            </>
          ) : null}
        </>
      ) : (
        <>
          <span className="cv-sband-label">Conversation ended</span>
          <EndedAfter session={session} />
        </>
      )}
      <span className="cv-sband-fill" />
      {bg > 0 ? (
        <span className="cv-sband-bgchip" title="Background work is still running">
          <i aria-hidden="true" />
          {bg > 1 ? `${bg} background tasks still running` : "1 background task still running"}
        </span>
      ) : null}
      {/* "Continue" only after an ERROR — resend "continue" so Claude picks the work back
          up. Sending clears the reminder, so the band closes on its own. */}
      {status.kind === "error" ? (
        <button
          type="button"
          className="cv-sband-btn"
          onClick={() => send.mutate({ text: "continue" })}
          title='Resend "continue" so Claude picks the work back up'
        >
          <Ico name="play" className="sm" />
          Continue
        </button>
      ) : null}
      <button
        type="button"
        className="cv-sband-btn seen"
        onClick={() => acknowledgeConversation(session)}
        title="Move the conversation back to grey (inactive) — ⌘↵"
      >
        <Ico name="check" className="sm" />
        Mark as seen
        <kbd>⌘↵</kbd>
      </button>
    </div>
  );
}
