// The adaptive body of a FlightDeck card — exactly the conversation view's status
// vocabulary, laid out for a card. Driven by the shared AgentStatus + the pending
// permission, so the card and the thread always agree on what an agent is asking.
import { Ico } from "../../ui/kit";
import { backgroundCount, type AgentStatus } from "../../agent/status";
import { classifyAsk } from "../../agent/ask";
import { isElicitation } from "../../agent/elicitation";
import { usePendingPermissions } from "../../store/conversationStore";
import { questionCount } from "../conversation/QuestionnaireAsk";
import { ActivityLine } from "./ActivityLine";

/** The violet "still working in the background" chip appended to a settled alert's
 *  header when the finished agent has background tools running (bg > 0). */
function BgChip({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="wf-bgchip">
      <span className="sp" />
      {n} in background
    </span>
  );
}

export function StateBlock({ convId, status }: { convId: string; status: AgentStatus }) {
  const pending = usePendingPermissions(convId);
  const bg = backgroundCount(status);

  if (status.kind === "running") {
    // A live "what it's doing now" line derived from the stream (see useActivityLabel).
    return <ActivityLine convId={convId} />;
  }

  if (status.kind === "needIntervention") {
    // The status can flip to needIntervention a beat BEFORE the permission request
    // actually lands (or linger a beat AFTER the user answered, until the state
    // event clears awaiting_permission). With no real request queued there's nothing
    // to show — stay quiet instead of flashing a generic "Allow tool?".
    const req = pending[0];
    if (!req) return null;
    const ask = classifyAsk(req);
    // An MCP server asking for input (a form / a browser step) is not a permission.
    const input = isElicitation(req);
    return (
      <div className="wf-ask compact">
        <div className="wf-ask-h">
          <Ico name={input ? "form" : "key"} className="sm" />
          {input ? "Input requested" : "Requesting permission"}
        </div>
        <div className="wf-ask-t">{ask.text}</div>
        {ask.cmd ? <code className="wf-ask-cmd wf-mono">$ {ask.cmd}</code> : null}
      </div>
    );
  }

  if (status.kind === "needInput") {
    if (status.via === "questionnaire") {
      const req = pending[0];
      if (!req) return null;
      const n = questionCount(req.input);
      return (
        <div className="wf-ask compact">
          <div className="wf-ask-h">
            <Ico name="form" className="sm" />
            {n > 0 ? `${n} questions to answer` : "Questionnaire"}
          </div>
        </div>
      );
    }
    // Heuristic open question — show the question text the agent is waiting on.
    return (
      <div className="wf-ask compact">
        <div className="wf-ask-h">
          <Ico name="ask" className="sm" />
          Asking a question
          <BgChip n={bg} />
        </div>
        {status.prompt ? <div className="wf-ask-t">{status.prompt}</div> : null}
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="wf-ask err compact">
        <div className="wf-ask-h">
          <Ico name="alert" className="sm" />
          Error
          <BgChip n={bg} />
        </div>
        <div className="wf-ask-t">{status.message}</div>
      </div>
    );
  }

  if (status.kind === "review") {
    // A clean finish with background work still running is NOT `review` (it routes to
    // `backgrounding` below), so `review` always means "genuinely ready to review" — no bg.
    return (
      <div className="wf-review compact">
        <div className="wf-review-h">
          <Ico name="check" className="sm" />
          To review
        </div>
        <div className="wf-review-t">Conversation ended — ready to review.</div>
      </div>
    );
  }

  if (status.kind === "backgrounding") {
    // Main turn done, a background task (workflow / sub-agent) still running. GREEN, calm —
    // work continues, nothing to review yet (the agent resumes on its own).
    const n = status.count;
    return (
      <div className="wf-review bg compact">
        <div className="wf-review-h">
          <Ico name="layers" className="sm" />
          Background task
        </div>
        <div className="wf-review-t">
          {n > 1 ? `${n} background tasks running…` : "Background task running…"}
        </div>
      </div>
    );
  }

  // idle / off — a quiet grey card, no body.
  return null;
}
