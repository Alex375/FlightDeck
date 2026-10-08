// A sub-agent's final report, handed back to this conversation by the claude CLI.
//
// A finishing sub-agent calls `SubagentHandback({message})`; the CLI then injects the report
// into the PARENT thread as a user line flagged synthetic, framed like this (claude 2.1.293):
//
//   Another Claude session sent a message:            ← only when the report opens a turn
//   <agent-message from="<agentId>">
//   [Subagent hand-back] The text below is the final report … The report follows:
//     <the report, every line indented by two spaces>
//   </agent-message>
//
//   That "other Claude session" is an agent …        ← only when the report opens a turn
//
// The core lets exactly these lines through (keyed on the line's `origin.handback`, see
// `history::is_handback_origin`), live and on reload. This parse turns the frame back into the
// report — frame sentence dropped, indentation undone — so the thread renders a report card
// instead of a bubble the user never typed. Pure + tested; the same parse feeds the live
// thread, the clean-output inline marker and the disk transcript (via `parseSpecialMessage`).
//
// ⚠️ Unrelated to the app's own `<flightdeck-message>` envelope (agentMessage.ts): the CLI owns
// `<agent-message>`.

/** The tool a sub-agent calls to hand its report back (input `{message}`). */
export const SUBAGENT_HANDBACK_TOOL = "SubagentHandback";

export interface SubagentHandback {
  type: "subagent-handback";
  /** The sub-agent's id — also its background task id (`task_id == agentId`). */
  agentId: string | null;
  /** The report, as the sub-agent wrote it (markdown). Empty when it handed back nothing. */
  report: string;
  /** The harness's warning, when the report matched an instruction-shaped pattern and had its
   *  control tags neutralized (`<` → `<\`) — shown de-emphasised so those marks make sense. */
  note: string | null;
}

const PREAMBLE = "Another Claude session sent a message:\n";
const CLOSE = "</agent-message>";
const FRAME = "[Subagent hand-back]";
/** The harness indents every report line so a frame-like line inside it can't pass as real. */
const INDENT = "  ";
const OPEN_TAG = /^<agent-message(?:\s[^>\n]*)?>\n/;
const HARNESS_NOTE = /^\[harness:[\s\S]*\]$/;

/**
 * Detect a sub-agent hand-back inside a user message's text. `null` for anything else.
 *
 * The gate is strict on purpose (this runs on every user turn): the text must OPEN on the
 * `<agent-message …>` tag — optionally after the CLI's exact one-line preamble — and the frame
 * sentence must follow. Prose that merely mentions the tag never qualifies.
 */
export function parseSubagentHandback(text: string): SubagentHandback | null {
  let t = text.trimStart();
  if (t.startsWith(PREAMBLE)) t = t.slice(PREAMBLE.length);
  const open = OPEN_TAG.exec(t);
  if (!open) return null;
  const inner = t.slice(open[0].length);
  // The frame sentence sits at column zero; it can't be forged from inside the (indented)
  // report, so the first such line is the real one.
  const lines = inner.split("\n");
  const frameAt = lines.findIndex((l) => l.startsWith(FRAME));
  if (frameAt === -1) return null;

  // The report runs from the first indented line after the frame to the closing tag (the LAST
  // one: the report itself may quote the tag, but always indented).
  const closeAt = lastIndexOfLine(lines, CLOSE);
  const tail = lines.slice(frameAt + 1, closeAt === -1 ? lines.length : closeAt);
  const start = tail.findIndex((l) => l.startsWith(INDENT));
  const report = (start === -1 ? [] : tail.slice(start)).map((l) =>
    l.startsWith(INDENT) ? l.slice(INDENT.length) : l,
  );

  let note: string | null = null;
  if (report.length && HARNESS_NOTE.test(report[0].trim())) {
    note = report.shift()!.trim();
  }

  return {
    type: "subagent-handback",
    agentId: /\sfrom="([^"]*)"/.exec(open[0])?.[1] || null,
    report: trimBlankLines(report).join("\n"),
    note,
  };
}

function lastIndexOfLine(lines: string[], line: string): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] === line) return i;
  return -1;
}

/** Drop leading/trailing blank lines, keeping the report's inner layout untouched. */
function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}
