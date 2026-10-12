// Which placeholder/body a <TaskOutputPopover> shows, decided from the load state.
// Pure + unit-tested so the (null vs "") distinction — the whole point — can't
// silently regress: a background task that produced NO output writes an EMPTY file
// (`read_task_output` → ""), whereas an ABSENT/unreadable file reads back as null.
// Conflating the two is what made the popover claim "no output" when it simply
// hadn't loaded the output. So:
//   - ""   → the file is there and empty → genuinely no output.
//   - null → we don't have it (not read yet, or absent/unreadable) → "unavailable",
//            never asserted as "no output".

export type OutputView =
  /** A non-empty content string is available — render it. */
  | "output"
  /** The first read is still in flight. */
  | "loading"
  /** The read failed (surface the error). */
  | "error"
  /** The output path is unknown — a resumed conversation (task lifecycle is live-only). */
  | "unavailable"
  /** Still running, nothing written yet (null OR an empty file so far). */
  | "empty-running"
  /** Finished and the file is present but EMPTY — genuinely produced no output. */
  | "empty-done"
  /** Finished but the file is absent/unreadable (read returned null) — we don't have
   *  the output, as opposed to it being empty. Honest "unavailable", not "no output". */
  | "unloaded";

export function pickOutputView(s: {
  /** Last successful read: a non-empty string, "" (present empty file), or null
   *  (not loaded / absent / unreadable). Never coerce null → "". */
  text: string | null;
  /** A read is currently in flight. */
  loading: boolean;
  /** At least one read has COMPLETED for this output. A re-poll in flight after that is not
   *  "loading": the view keeps what the last read established, instead of flickering between
   *  "Loading…" and the placeholder on every poll of a still-empty output. */
  loaded?: boolean;
  /** The last read threw / returned an error. */
  err: string | null;
  /** The output can be read: its path is known, or the task to locate it by (a running Monitor,
   *  whose path the stream only reports at its end). */
  hasPath: boolean;
  /** The task is still running (drives live polling). */
  running: boolean;
}): OutputView {
  if (s.text) return "output"; // non-empty content wins, even mid-poll
  if (s.loading && !s.loaded && s.text === null) return "loading"; // the FIRST read only
  if (s.err) return "error";
  // A RUNNING task is "still warming up", never "unavailable" — even before its output
  // path is known (the path lands a beat after the task starts; a Monitor's start
  // tool_result may never carry the marker). Check running BEFORE !hasPath so a live
  // task never shows the "conversation rouverte" message (which means the task lifecycle
  // is gone — only true once finished and unresolvable).
  if (s.running) return "empty-running"; // running: path unknown, or null/"" so far
  if (!s.hasPath) return "unavailable"; // finished + no path → resumed conversation
  if (s.text === "") return "empty-done"; // finished + confirmed empty file
  return "unloaded"; // finished + null: absent/unreadable, NOT "no output"
}
