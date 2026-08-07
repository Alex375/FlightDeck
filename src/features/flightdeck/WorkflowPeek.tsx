// The live workflow readout on a Flight Deck card: what a running multi-agent run is actually
// doing, without opening anything.
//
// Why it exists: a workflow is ONE aggregated task on the wire, so the card previously showed
// it as a single "⚙ 1" — a 17-agent fan-out and a one-agent run looked identical, and the only
// other clue was a phase name buried in a popover. The run's journal (pushed from disk by the
// app-wide watcher) has the real numbers, so the card can carry them: the current phase, how
// many agents are in the air, and how many have finished.
//
// Clicking opens the same <WorkflowDetail> every other surface opens — portalled, because a
// card lives inside the swimlane's `overflow` clip. Renders nothing when no workflow is
// running, so a card that isn't orchestrating anything is untouched.
//
// ⚠️ The open modal is owned HERE, not by a row — mirroring <WorkflowBar> and for the same
// reason: the rows list only RUNNING runs, so a modal mounted inside a row is torn out from
// under the user at the exact moment the run finishes and the rich report would have loaded.

import { useState } from "react";
import { Ico, RunDots } from "../../ui/kit";
import { runIdFromResult } from "../../agent/subagentMeta";
import { useBackgroundWorkflowTasks, useSessionTasks } from "../../store/backgroundTasksStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useToolResult } from "../../store/conversationStore";
import { useDisplay } from "../../store/display";
import { JOURNAL_UNAVAILABLE, useWorkflowJournal } from "../../store/workflowJournal";
import { useWorkflowLive } from "../../store/workflowLive";
import { WorkflowDetail } from "../conversation/WorkflowDetail";
import type { BackgroundTask } from "../../ipc/client";

export function WorkflowPeek({ convId }: { convId: string }) {
  const show = useDisplay((d) => d.workflowLiveCard);
  const runs = useBackgroundWorkflowTasks(convId);
  // The FULL task map (running + finished): an open modal must survive its run finishing, when
  // the row itself drops out of `runs`. Same invariant as <WorkflowBar>.
  const allTasks = useSessionTasks(convId);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.sessionId ?? null,
  );
  const [openedId, setOpenedId] = useState<string | null>(null);

  const opened = openedId ? allTasks[openedId] ?? null : null;
  const openedResult = useToolResult(convId, opened?.tool_use_id ?? "");
  const openedRunId = opened ? runIdFromResult(openedResult?.content) : null;
  const openedJournal = useWorkflowJournal(convId, openedRunId);
  const openedLiveActivity = useWorkflowLive(convId, openedId ?? "");

  // The preference gates the CARD readout. An already-open modal is left alone — closing a
  // panel the user is reading because a toggle flipped elsewhere would be its own surprise.
  if (!show && !opened) return null;
  if (runs.length === 0 && !opened) return null;

  return (
    <>
      {show ? (
        <div className="ag-wfpeek-list">
          {/* No cap: a conversation orchestrates one run at a time in practice, and silently
              hiding a second one would misreport what the agent is doing. */}
          {runs.map((t) => (
            <WorkflowPeekRow
              key={t.task_id}
              convId={convId}
              task={t}
              onOpen={() => setOpenedId(t.task_id)}
            />
          ))}
        </div>
      ) : null}

      <WorkflowDetail
        open={!!opened}
        sessionId={claudeSessionId}
        runId={openedRunId}
        running={opened?.status === "running"}
        workflowName={opened?.label ?? null}
        currentProgress={opened?.progress ?? null}
        liveActivity={openedLiveActivity}
        journal={openedJournal}
        onClose={() => setOpenedId(null)}
      />
    </>
  );
}

function WorkflowPeekRow({
  convId,
  task,
  onOpen,
}: {
  convId: string;
  task: BackgroundTask;
  onOpen: () => void;
}) {
  const result = useToolResult(convId, task.tool_use_id ?? "");
  const journal = useWorkflowJournal(convId, runIdFromResult(result?.content));

  const phase = task.progress ? task.progress.split(":")[0]?.trim() : null;
  // Deliberately NOT a completion bar. `started` counts agents spawned SO FAR, so a multi-phase
  // run is momentarily balanced at every phase boundary — a ratio would show a full bar and
  // "12/12" a third of the way through a run, then drop back. The counts alone are honest;
  // pretending to know the run's total is not.
  const agents = journal.started > 0 ? `${journal.done}/${journal.started} agents` : null;

  return (
    <button
      type="button"
      className="ag-wfpeek"
      onClick={onOpen}
      title="Open the workflow's live detail"
    >
      <span className="ag-wfpeek-top">
        <RunDots />
        <span className="ag-wfpeek-name">{task.label ?? "Workflow"}</span>
        {journal.error ? null : agents ? (
          <span className="ag-wfpeek-count wf-mono">{agents}</span>
        ) : null}
        <Ico name="arrow" className="sm ag-wfpeek-chev" />
      </span>
      <span className="ag-wfpeek-sub">
        {/* The phase is the wire's word for the current step; the in-flight count is the
            journal's. When the journal can no longer be read, say so — the numbers we last had
            would otherwise keep animating as if they were live. */}
        {phase ? <span className="ag-wfpeek-phase">{phase}</span> : null}
        <span className="ag-wfpeek-agents wf-mono" title={journal.error ?? undefined}>
          {journal.error
            ? JOURNAL_UNAVAILABLE
            : journal.started === 0
              ? "starting…"
              : journal.running > 0
                ? `${journal.running} agent${journal.running > 1 ? "s" : ""} running`
                : "between steps…"}
        </span>
      </span>
    </button>
  );
}
