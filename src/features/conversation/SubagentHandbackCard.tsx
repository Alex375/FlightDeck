// A sub-agent's final report (its `SubagentHandback` call), handed back into this thread by
// the CLI — see handback.ts. Kept to ONE discreet line where the CLI injected it — "Report from
// <agent>" — since the report itself reads best where it was written: at the end of the
// sub-agent's transcript, which the line opens (there the `SubagentHandback` call renders as the
// agent's closing prose). Without the line, a background agent's report surfaced nowhere — only
// the summary Claude wrote of it.
//
// The agent is named after its launch (the `Agent` call's `description`): from the live task
// registry, or — on a reloaded conversation, where the registry is empty — from the launching
// call still in the thread. `session` is absent on the read-only disk surfaces (history
// preview, a sub-agent's own transcript), which have no transcript to open: there the line
// unfolds the report in place instead, so it is never out of reach.

import { useState } from "react";
import { field } from "../../agent/ask";
import { useBackgroundTasksStore } from "../../store/backgroundTasksStore";
import { useAgentLaunchBlock } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
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
  // No transcript to open and nothing to unfold: the line just states it.
  const inert = !drillable && !data.report;

  const line = (
    <>
      <Ico name="spark" className="sm cv-handback-ico" />
      <span className="cv-handback-t">
        Report from <span className="cv-handback-name">{name}</span>
      </span>
      {agentType ? <span className="cv-handback-type">{agentType}</span> : null}
      {inert ? (
        <span className="cv-handback-type">empty</span>
      ) : (
        <Ico
          name={drillable ? "arrow" : "chev"}
          className={"sm cv-handback-go" + (!drillable && open ? " is-open" : "")}
        />
      )}
    </>
  );

  return (
    <div className="cv-handback" data-handback={agentId ?? undefined} role="note">
      {inert ? (
        <div className="cv-handback-row">{line}</div>
      ) : (
        <button
          type="button"
          className="cv-handback-row"
          title={drillable ? "Open the sub-agent's transcript — its report closes it" : "Show the report"}
          aria-expanded={drillable ? undefined : open}
          onClick={() => setOpen((o) => (drillable ? true : !o))}
        >
          {line}
        </button>
      )}
      {!drillable && open ? <HandbackReport data={data} /> : null}
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
          // The report is already in hand: if the transcript can't be shown, show it anyway.
          fallback={data.report ? <HandbackReport data={data} /> : undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** The report itself, with the harness's warning (when any) under it. */
function HandbackReport({ data }: { data: SubagentHandback }) {
  return (
    <div className="cv-handback-report">
      <StreamMarkdown text={data.report} />
      {data.note ? <p className="cv-handback-note">{data.note}</p> : null}
    </div>
  );
}
