// Discreet, pinned list of the conversation's RUNNING dynamic-workflow runs — the `Workflow`
// tool, which orchestrates a fleet of sub-agents across phases. A Workflow is ALWAYS a
// background task (the tool returns immediately with a run id), so — exactly like a detached
// Bash or a Monitor — it lives here in a pinned bar while it runs, and DROPS OUT the moment it
// finishes (the bar shows only what is currently running). The finished run's rich report is
// reached from the PERSISTENT inline <WorkflowCard> in the thread, not from this bar.
//
// Clicking a row opens the live overview (<WorkflowDetail>): current phase + per-phase agents
// launched/done. The run id needed to read disk is parsed from the Workflow tool_result ack.
//
// Each row states the run's REAL progress — "N running · M done", counted from the journal the
// watcher pushes — rather than only the wire's coarse "<phase>: <label>" string, which says
// nothing about how much of the fleet is still in the air.

import { useState } from "react";
import { useBackgroundWorkflowTasks, useSessionTasks } from "../../store/backgroundTasksStore";
import { useToolResult } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useWorkflowLive } from "../../store/workflowLive";
import { useWorkflowJournal } from "../../store/workflowJournal";
import { useStopTask } from "../../ipc/useCommands";
import { runIdFromResult } from "../../agent/subagentMeta";
import { Ico, RunDots } from "../../ui/kit";
import { useIsCodex } from "./ConvMark";
import { WorkflowDetail } from "./WorkflowDetail";
import { WorkflowTally } from "./WorkflowTally";

export function WorkflowBar({ session }: { session: string }) {
  // Bloc A (Phase 4.5): `Workflow` is a Claude-only background tool (no Codex equivalent
  // on the wire), so this bar is hidden on Codex — never an empty shell or false green.
  const isCodex = useIsCodex(session);
  const rows = useBackgroundWorkflowTasks(session);
  // The full task map (running + finished) — so an open modal survives the run finishing (the
  // row is gone from `rows`, but the snapshot lingers here with its status flipped to done →
  // the modal stops polling and upgrades to the rich report).
  const allTasks = useSessionTasks(session);
  const stopTask = useStopTask(session);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );
  const [openedId, setOpenedId] = useState<string | null>(null);

  const opened = openedId ? allTasks[openedId] ?? null : null;
  const openedResult = useToolResult(session, opened?.tool_use_id ?? "");
  const openedRunId = opened ? runIdFromResult(openedResult?.content) : null;
  const liveActivity = useWorkflowLive(session, openedId ?? "");
  const openedJournal = useWorkflowJournal(session, openedRunId);

  if (isCodex) return null;
  if (rows.length === 0 && !opened) return null;

  return (
    <div className="cv-bgagents">
      {rows.map((t) => (
        <div key={t.task_id} className="cv-bashrow">
          <button
            type="button"
            className="cv-bashrow-main"
            onClick={() => setOpenedId(t.task_id)}
            title="Open workflow details"
          >
            <RunDots />
            <Ico name="layers" className="sm cv-monrow-ico" />
            <span className="cv-bashrow-cmd">{t.label ?? "Workflow"}</span>
            {t.progress ? <span className="cv-bgagent-stats wf-mono">{t.progress}</span> : null}
            {/* This bar lists RUNNING runs only, so `running` is always true here — passed
                explicitly so the wording rule lives in one place, not in each caller's head. */}
            <WorkflowTally
              session={session}
              toolUseId={t.tool_use_id}
              running
              className="cv-bgagent-stats wf-mono"
            />
          </button>
          <button
            type="button"
            className="cv-bgstop"
            title="Stop workflow"
            aria-label="Stop workflow"
            onClick={() => stopTask.mutate(t.task_id)}
          >
            <Ico name="stopc" className="sm" />
          </button>
        </div>
      ))}

      <WorkflowDetail
        open={!!opened}
        sessionId={claudeSessionId}
        runId={openedRunId}
        running={opened?.status === "running"}
        workflowName={opened?.label ?? null}
        currentProgress={opened?.progress ?? null}
        liveActivity={liveActivity}
        journal={openedJournal}
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}
