// Discreet, pinned list of the conversation's RUNNING background shell commands —
// `Bash` launched with `run_in_background`. The shell counterpart of <AgentBar>: one
// slim line per command, echoing the same look so the two bars read as a family. Each
// row shows the bouncing "working" dots and a Stop button. A command drops out of the
// bar the moment it finishes (mirrors AgentBar) — but if its output popover is open at
// that point, the popover stays open and shows the final output (it reads the full task
// map, which keeps the finished snapshot, not the filtered bar list).
//
// Clicking a row opens the command's captured output (tail of `tasks/<id>.output`) in a
// floating <BashOutputPopover>.
//
// Since claude 2.1.285 the CLI stops a background command at its time limit (30 min unless
// Claude asked for longer): each row can show the time left (opt-in, `showBashTimeLeft`),
// and the thread always says why once it happens (`task_stopped`).

import { useState } from "react";
import type { BackgroundTask } from "../../ipc/client";
import { useBackgroundBashTasks, useSessionTasks } from "../../store/backgroundTasksStore";
import { useStopTask } from "../../ipc/useCommands";
import { Ico, RunDots } from "../../ui/kit";
import { Tooltip } from "../../ui/Tooltip";
import { useNow } from "../../ui/useNow";
import {
  DEADLINE_NEAR_MS,
  fmtLimit,
  fmtTimeLeft,
  stopCauseText,
  timeLeftMs,
} from "../../agent/bashDeadline";
import { useDisplay } from "../../store/display";
import { useIsCodex } from "./ConvMark";
import { BashOutputPopover } from "./BashOutputPopover";

export function BashBar({ session }: { session: string }) {
  // Bloc A (Phase 4.5): background shells are a Claude-only primitive — Codex has no
  // model-facing background terminal (a "backgrounded" Codex command completes within the
  // turn; the detached OS process is invisible to the protocol). So on Codex this bar has
  // no source and is hidden, never a fake empty shell.
  const isCodex = useIsCodex(session);
  // The bar lists only RUNNING commands; a finished one drops out.
  const rows = useBackgroundBashTasks(session);
  // The full task map (running + finished) — so an open popover survives its command
  // finishing (the row is gone from `rows`, but the snapshot lingers here).
  const allTasks = useSessionTasks(session);
  const stopTask = useStopTask(session);
  // Opt-in (Settings → Display → Thread): the time left before the CLI stops each command.
  const showTimeLeft = useDisplay((s) => s.showBashTimeLeft);
  const [openedId, setOpenedId] = useState<string | null>(null);

  const opened = openedId ? allTasks[openedId] ?? null : null;

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
            title="View command output"
          >
            <RunDots />
            {t.label ? (
              // The NAME the agent gave the command ("build the app") — prose, the
              // meaningful line. The raw command is in the popover.
              <span className="cv-bashrow-cmd">{t.label}</span>
            ) : (
              // No name → fall back to the raw `$ command` (mono), better than a generic
              // "command".
              <span className="cv-bashrow-cmd wf-mono">
                <span className="cv-bashrow-p" aria-hidden="true">$</span>
                {t.command ?? "command"}
              </span>
            )}
          </button>
          {showTimeLeft && t.deadline_at_ms != null ? <DeadlineChip task={t} /> : null}
          <button
            type="button"
            className="cv-bgstop"
            title="Stop command"
            aria-label="Stop command"
            onClick={() => stopTask.mutate(t.task_id)}
          >
            <Ico name="stopc" className="sm" />
          </button>
        </div>
      ))}

      <BashOutputPopover
        open={!!opened}
        outputFile={opened?.output_file ?? null}
        name={opened?.label ?? null}
        command={opened?.command ?? null}
        running={opened?.status === "running"}
        summary={opened ? endLine(opened) : null}
        onClose={() => setOpenedId(null)}
      />
    </div>
  );
}

/** The popover's status line once the command ended: the stop's reason when the CLI
 *  stopped it on its own (its raw summary says the same, less plainly), else its summary. */
function endLine(task: BackgroundTask): string | null {
  const reason = stopCauseText(task.stop_cause, task.time_limit_ms);
  return reason ? `Stopped — ${reason}` : task.summary;
}

/** Time left before the CLI stops this command, at the end of its row — in the attention
 *  tone for the last few minutes. Its own component so only rows that HAVE a deadline run
 *  a clock (minute precision: a 15 s tick is plenty). */
function DeadlineChip({ task }: { task: BackgroundTask }) {
  const now = useNow(15_000);
  const left = timeLeftMs(task, now);
  if (left == null) return null;
  const near = left < DEADLINE_NEAR_MS;
  const at = new Date(task.deadline_at_ms!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const limit = task.time_limit_ms != null ? fmtLimit(task.time_limit_ms) : null;
  const explain =
    `Claude Code stops a background command once it has run for its time limit` +
    `${limit ? ` (${limit} for this one)` : ""}. This one stops around ${at}.`;
  return (
    <Tooltip content={explain} label={`${fmtTimeLeft(left)} left. ${explain}`} className="cv-bashrow-deadline-wrap">
      <span className={"cv-bashrow-deadline" + (near ? " near" : "")}>
        <Ico name="clock" className="sm" />
        {fmtTimeLeft(left)}
      </span>
    </Tooltip>
  );
}
