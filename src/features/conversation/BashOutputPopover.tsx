// A floating viewer for a background Bash command's captured output (the file at the
// task's `output_file` path), opened from the pinned <BashBar>. A thin Bash-flavoured
// wrapper over the shared <TaskOutputPopover> (the live tailing engine) — it injects the
// command-shell wording, and shows BOTH the name the agent gave the task AND the raw
// shell command (the name says what, the command says how).

import { TaskOutputPopover } from "./TaskOutputPopover";

export function BashOutputPopover({
  open,
  convId,
  outputFile,
  sessionId = null,
  taskId = null,
  name,
  command,
  running,
  summary,
  onClose,
}: {
  open: boolean;
  /** The conversation's stable id — the output is read where the conversation runs. */
  convId: string;
  /** ABSOLUTE path of the task's output file (`BackgroundTask.output_file`). */
  outputFile: string | null;
  /** Claude's session id and the task's id — where the output is found until its path is
   *  reported (see <TaskOutputPopover>). */
  sessionId?: string | null;
  taskId?: string | null;
  /** The NAME the agent gave the command (its `description`), or null. */
  name: string | null;
  /** The raw shell command, or null when not captured yet. */
  command: string | null;
  /** Whether the command is still running — drives the live polling + a status line. */
  running: boolean;
  /** End-of-run summary from the core (e.g. "… completed (exit code 0)"). */
  summary?: string | null;
  onClose: () => void;
}) {
  // The name is the heading (it's what makes sense — "build the app"). With no name, the
  // command itself becomes the heading (mono), and we don't repeat it on its own line.
  const named = !!name;
  return (
    <TaskOutputPopover
      open={open}
      convId={convId}
      outputFile={outputFile}
      sessionId={sessionId}
      taskId={taskId}
      running={running}
      icon="term"
      title={named ? name : <>$ {command ?? "command"}</>}
      titleMono={!named}
      commandLine={named && command ? command : undefined}
      subtitle={running ? "Running…" : summary ?? "Completed"}
      loadingText="Loading output…"
      unreadableText={(e) => `Unreadable output: ${e}`}
      unavailableText="Output unavailable (conversation reopened)."
      emptyRunningText="The command is running — no output yet…"
      emptyDoneText="This command produced no output."
      unloadedText={(server) =>
        server ? `Output unavailable — its file is no longer on ${server}.` : "Output unavailable (couldn't load it)."
      }
      onClose={onClose}
    />
  );
}
