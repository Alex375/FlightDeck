// "N running · M done" for one workflow run — the compact form of its live journal.
//
// The wire only ever says `"<phase>: <label>"` for a whole run, so before this every pinned
// surface showed a phase name and nothing about the fleet behind it: a 17-agent run and a
// 1-agent run read identically. The counts here come from the run's journal (pushed from disk
// by the app-wide watcher), so they are exact, not inferred.
//
// A component rather than a helper because reaching the run id means a hook (`useToolResult`)
// and these render inside `.map()`s. It renders nothing until the run has an agent — the first
// seconds of a run, and every non-workflow caller, cost nothing.

import { runIdFromResult } from "../../agent/subagentMeta";
import { useToolResult } from "../../store/conversationStore";
import { journalTally, useWorkflowJournal } from "../../store/workflowJournal";

export function WorkflowTally({
  session,
  toolUseId,
  running,
  className,
}: {
  session: string;
  /** The `Workflow` tool_use whose ack carries the run id. */
  toolUseId: string | null | undefined;
  /** Whether the TASK is still going — gates the "N running" half (an unclosed journal entry
   *  means "still working" only while the run lasts). */
  running: boolean;
  className?: string;
}) {
  const result = useToolResult(session, toolUseId ?? "");
  const runId = runIdFromResult(result?.content);
  const journal = useWorkflowJournal(session, runId);
  const tally = journalTally(journal, running);

  if (!tally) return null;
  return (
    <span
      className={className}
      title={journal.error ?? "Agents of this workflow run"}
    >
      {tally}
    </span>
  );
}
