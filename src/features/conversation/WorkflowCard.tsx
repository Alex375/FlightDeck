// The PERSISTENT inline card for a `Workflow` tool call, rendered in the conversation thread
// where the agent launched it (its own segment — never grouped, never hidden). Unlike the
// transient <WorkflowBar> (running-only), this card stays in the thread after the run ends,
// so the rich post-run report is always reachable — and, since the Workflow tool_use is in the
// persisted transcript and the manifest is on disk, it survives a resume too.
//
// Clicking it opens the full <WorkflowDetail> (live overview while running → rich 3-panel
// report once finished). The run id is parsed from the Workflow tool_result ack; the live
// status/phase from the background task; the per-phase agent activity from the accumulated wire.

import { useState } from "react";
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { runIdFromResult, taskIdFromResult, taskStatusDot } from "../../agent/subagentMeta";
import { currentStepLabel } from "./workflowTree";
import { useBackgroundWorkflowTasks, useTaskByToolUse } from "../../store/backgroundTasksStore";
import { useConversationStore, useToolResult } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useWorkflowLive } from "../../store/workflowLive";
import { journalTally, useWorkflowJournal } from "../../store/workflowJournal";
import { Dot, Ico, RunDots } from "../../ui/kit";
import { useIsCodex } from "./ConvMark";
import { WorkflowDetail } from "./WorkflowDetail";

export function WorkflowCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const task = useTaskByToolUse(session, toolUseId);
  const result = useToolResult(session, toolUseId);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );
  const liveActivity = useWorkflowLive(session, task?.task_id ?? "");
  // Live per-agent progress, pushed from the run's journal. Keyed by the run id parsed from the
  // tool_result, so it is available whether or not the detail modal has ever been opened.
  const journal = useWorkflowJournal(session, runIdFromResult(result?.content));
  const [open, setOpen] = useState(false);
  // Whether ANOTHER execution of this run id (a resume, i.e. a later Workflow call) is running
  // right now: the run's journal is shared, so it then describes that execution, not this card's.
  // Cheap — only the conversation's running workflows are looked at (a handful at most).
  const runningWorkflows = useBackgroundWorkflowTasks(session);
  const ownTaskId = task?.task_id ?? taskIdFromResult(result?.content);
  const ownRunId = runIdFromResult(result?.content);
  const superseded = useConversationStore((s) => {
    if (!ownRunId || task?.status === "running") return false;
    const results = s.sessions[session]?.toolResults;
    return runningWorkflows.some(
      (t) =>
        t.task_id !== ownTaskId &&
        t.tool_use_id != null &&
        runIdFromResult(results?.[t.tool_use_id]?.content) === ownRunId,
    );
  });
  // Bloc A (Phase 4.5): defensive — `Workflow` is a Claude-only tool, so a Codex thread
  // never yields a workflow segment; guard anyway so a drifting classification can never
  // render a Claude-only workflow card on Codex.
  const isCodex = useIsCodex(session);
  if (isCodex) return null;

  const name = field(input, "description") ?? task?.label ?? "Workflow";
  const runId = runIdFromResult(result?.content);
  const running = task?.status === "running";
  // Current step (running): the journal's own phase when it names its agents, else the wire's —
  // the same rule as the Flight Deck peek, so the two never name different phases.
  const phase = currentStepLabel(journal, task?.progress, running);
  // Which EXECUTION this card is: the live task when it is in memory, else the id its ack
  // carries (the task registry is empty after a restart) — so a later resume's report, written
  // under the same run id, is never shown as this card's.
  const taskId = ownTaskId;
  // The fleet behind that phase, worded exactly as the pinned bar words it (null until the run
  // has an agent). `running` is passed because this card OUTLIVES the run: once settled, an
  // unclosed journal entry no longer means "an agent is working" — the CLI does not guarantee
  // a `result` line per agent, and a real run on disk ends 38-started / 0-result.
  // A resume running elsewhere owns the shared journal: its in-flight agents are not this card's
  // missing results — say where the run went instead of tallying another execution.
  const tally = superseded ? "resumed by another execution" : journalTally(journal, running);

  return (
    <div className="cv-tool">
      <div
        className="cv-tool-h"
        onClick={() => setOpen(true)}
        role="button"
        style={{ cursor: "pointer" }}
        title="Open workflow details"
      >
        <Ico name="layers" className="sm" />
        <span className="cv-tool-t">Workflow</span>
        <span className="cv-tool-m" title={name}>
          {name}
          {phase ? ` · ${phase}` : null}
          {tally ? ` · ${tally}` : null}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
          {/* No task in memory (after a restart): its outcome is unknown here — a neutral dot,
              never a made-up green "completed". */}
          {running ? <RunDots /> : <Dot s={task ? taskStatusDot(task.status) : "off"} />}
          <Ico name="arrow" className="sm" />
        </span>
      </div>

      <WorkflowDetail
        open={open}
        sessionId={claudeSessionId}
        runId={runId}
        taskId={taskId}
        status={task?.status ?? null}
        superseded={superseded}
        running={running}
        workflowName={name}
        currentProgress={task?.progress ?? null}
        liveActivity={liveActivity}
        journal={journal}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
