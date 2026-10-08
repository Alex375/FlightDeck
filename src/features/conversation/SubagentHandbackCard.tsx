// A sub-agent's final report (its `SubagentHandback` call), handed back into this thread by
// the CLI — see handback.ts. Rendered where the CLI injected it, as the agent's answer: a light
// card headed "Report from <agent>", the report in markdown behind a fold (reports run to tens
// of KB). Without it a background agent's report appeared nowhere — only the summary Claude
// wrote of it.
//
// The agent is named after its launch (the `Agent` call's `description`): from the live task
// registry, or — on a reloaded conversation, where the registry is empty — from the launching
// call still in the thread. The name opens the sub-agent's full transcript. `session` is absent
// on the read-only disk surfaces (history preview, a sub-agent's own transcript): the card then
// shows the report alone.

import { useState } from "react";
import { field } from "../../agent/ask";
import { useBackgroundTasksStore } from "../../store/backgroundTasksStore";
import { useAgentLaunchBlock } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { Expandable } from "../../ui/Expandable";
import { Ico } from "../../ui/kit";
import { StreamMarkdown } from "./StreamMarkdown";
import { TranscriptPopover } from "./TranscriptPopover";
import type { SubagentHandback } from "./handback";

export function SubagentHandbackCard({ data, session }: { data: SubagentHandback; session?: string }) {
  const agentId = data.agentId;
  // The sub-agent's task id IS its agentId.
  const task = useBackgroundTasksStore((s) =>
    session && agentId ? s.sessions[session]?.[agentId] : undefined,
  );
  // Only scanned when the registry doesn't know it (a reloaded conversation).
  const launch = useAgentLaunchBlock(session ?? "", task ? null : agentId);
  const [open, setOpen] = useState(false);
  // Read only while the transcript is open: the popover is the one consumer.
  const claudeSessionId = useConversationsStore((s) =>
    open && session ? (s.conversations.find((c) => c.id === session)?.sessionId ?? null) : null,
  );

  const label = task?.label ?? (launch ? field(launch.input, "description") : undefined) ?? null;
  const agentType =
    task?.subagent_type ?? (launch ? field(launch.input, "subagent_type") : undefined) ?? null;
  const name = label ?? (agentId ? `sub-agent ${agentId.slice(0, 8)}` : "a sub-agent");
  const drillable = !!(session && agentId);

  return (
    <div className="cv-agentmsg cv-handback" data-handback={agentId ?? undefined} role="note">
      <div className="cv-agentmsg-h">
        <Ico name="spark" className="sm cv-handback-ico" />
        <span>Report from</span>
        {drillable ? (
          <button
            type="button"
            className="cv-agentmsg-name"
            title="Open the sub-agent's transcript"
            onClick={() => setOpen(true)}
          >
            {name}
          </button>
        ) : (
          <span className="cv-agentmsg-name" title={agentId ?? undefined}>
            {name}
          </span>
        )}
        {agentType ? <span className="cv-agentmsg-repo">{agentType}</span> : null}
      </div>
      {data.report ? (
        <div className="cv-agentmsg-body">
          <Expandable maxHeight={180} fadeColor="var(--wf-panel)">
            <StreamMarkdown text={data.report} />
          </Expandable>
        </div>
      ) : (
        <div className="cv-handback-empty">The sub-agent handed back an empty report.</div>
      )}
      {data.note ? <p className="cv-handback-note">{data.note}</p> : null}
      {drillable ? (
        <TranscriptPopover
          open={open}
          sessionId={claudeSessionId}
          agentId={agentId}
          liveSession={session}
          toolUseId={task?.tool_use_id ?? launch?.id ?? null}
          wokenBy={task?.woken_by ?? null}
          running={task?.status === "running"}
          label={name}
          subtitle={agentType ?? undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
