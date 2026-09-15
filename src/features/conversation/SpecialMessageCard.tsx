// The clean render for an injected "special message" — today a `<task-notification>`
// emitted when a background task/agent finishes. Shown in PLACE of a raw user bubble
// (the CLI injects these AS user turns, but the human didn't type them, so no user
// avatar). Reused VERBATIM by the live thread (MsgUser), the clean-output inline marker
// and the disk transcript (SubAgentTranscript / history preview), so all surfaces stay
// identical — INCLUDING visibility: `<task-notification>` is HIDDEN by default (it's
// machine-injected noise that clutters the transcript on reload / history import). The
// one store read here (the `showTaskNotifications` pref) is the single gate for every
// surface; the render code below is kept intact so flipping the pref on brings it back.
import { Expandable } from "../../ui/Expandable";
import { Ico } from "../../ui/kit";
import { fmtDuration } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import { useDisplay } from "../../store/display";
import { StreamMarkdown } from "./StreamMarkdown";
import { taskNotificationStyle, type SpecialMessage, type TaskNotification } from "./specialMessage";
import { AgentMessageReceivedCard } from "./AgentMessageCards";

/** Shorten a task/tool id for the discreet mono chip; the full value is the title. */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}

function TaskNotificationCard({ n }: { n: TaskNotification }) {
  const st = taskNotificationStyle(n.status);
  const headline = n.summary || "Background task finished";

  const metrics: string[] = [];
  if (n.usage?.tokens != null) metrics.push(`${fmtTokens(n.usage.tokens)} tokens`);
  if (n.usage?.toolUses != null)
    metrics.push(`${n.usage.toolUses} tool${n.usage.toolUses > 1 ? "s" : ""}`);
  if (n.usage?.durationMs != null) metrics.push(fmtDuration(n.usage.durationMs));
  const metricLine = metrics.join("  ·  ");

  const rawId = n.taskId || n.toolUseId;
  const idChip = rawId ? shortId(rawId) : null;

  return (
    <div className={`cv-tasknote is-${st.tone}`} role="note">
      <div className="cv-tasknote-h">
        <span className="cv-tasknote-ico">
          <Ico name={st.icon} className="sm" />
        </span>
        <span className="cv-tasknote-title">{headline}</span>
        <span className="cv-tasknote-status">{st.label}</span>
      </div>
      {metricLine || idChip ? (
        <div className="cv-tasknote-meta">
          {metricLine ? <span>{metricLine}</span> : null}
          {idChip ? (
            <span className="cv-tasknote-id" title={rawId ?? undefined}>
              {idChip}
            </span>
          ) : null}
        </div>
      ) : null}
      {n.result ? (
        <div className="cv-tasknote-result">
          <Expandable maxHeight={200} fadeColor="var(--wf-panel)">
            <StreamMarkdown text={n.result} />
          </Expandable>
        </div>
      ) : null}
      {n.note ? <p className="cv-tasknote-note">{n.note}</p> : null}
    </div>
  );
}

/** Render a special message. Task notifications are hidden unless the user opts in
 *  (Settings → General) — the default-off gate that keeps the transcript clean on reload /
 *  history import. A message from another conversation is always shown: it is addressed to
 *  this agent, exactly like a prompt. `queued` = still pending (sent mid-turn). */
export function SpecialMessageCard({ data, queued }: { data: SpecialMessage; queued?: boolean }) {
  const showTaskNotifications = useDisplay((s) => s.showTaskNotifications);
  switch (data.type) {
    case "task-notification":
      return showTaskNotifications ? <TaskNotificationCard n={data} /> : null;
    case "agent-message":
      return <AgentMessageReceivedCard message={data} queued={queued} />;
    default:
      return null;
  }
}
