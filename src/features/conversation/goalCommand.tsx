// Rendering of a `/goal` SET command as a dedicated card in the conversation thread.
//
// Claude Code's native `/goal <condition>` is otherwise silent plumbing — the goal is
// represented by the target chip/popover, and `is_goal_command_noise` (Rust) drops both the
// command echo and its stdout from the thread. But a goal that SETS a real condition is a
// substantive instruction the user wants to SEE, so we surface it as a small "Goal set" card
// (target glyph + the full condition). Clearing (`/goal clear`) and the bare status query stay
// silent — they are pure chip plumbing, represented by the target icon appearing/disappearing.
//
// Live/reload parity: the optimistic bubble appended on send holds the raw "/goal <condition>"
// the user typed, while the SAME turn read back from the transcript holds the CLI's
// `<command-name>/goal</command-name><command-args>…</command-args>` wrapper. `parseGoalCommand`
// reads BOTH shapes (and a multi-line condition), so the card renders identically either way.
// The Rust side keeps clear/status echoes out of the thread, so in practice only SET reaches us.

import { Ico } from "../../ui/kit";

export type GoalAction = "set" | "clear" | "status";

const GOAL_NAME_RE = /<command-name>\s*\/?goal\s*<\/command-name>/;
const ARGS_OPEN = "<command-args>";
const ARGS_CLOSE = "</command-args>";
// Bare `/goal` as typed: the word must END at `/goal` (whitespace or end-of-string), so
// "/goalpost" is NOT a goal command. A condition may span multiple lines (unlike a generic
// slash-command, whose args are single-line) — hence `[\s\S]*` rather than `[^\n]*`.
const GOAL_BARE_RE = /^\/goal(?:\s+([\s\S]*))?$/;

/** Inner text of the wrapped shape's `<command-args>…`. Mirrors Rust `command_args`
 *  (history.rs): a MISSING closing tag is tolerated — the CLI has shipped unterminated
 *  wrappers — by taking the remainder, so an unterminated SET still parses as a real condition
 *  rather than empty. This keeps the front's card in step with the Rust normalizer, which KEEPS
 *  such a line in the thread. No `<command-args>` tag at all → empty (a bare status query). */
function wrappedArgs(text: string): string {
  const start = text.indexOf(ARGS_OPEN);
  if (start < 0) return "";
  const rest = text.slice(start + ARGS_OPEN.length);
  const end = rest.indexOf(ARGS_CLOSE);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Parse a `/goal` invocation in either shape (CLI-wrapped or as typed); `null` when the text
 *  isn't a `/goal` command. `condition` is the trimmed goal text for a SET, empty otherwise. */
export function parseGoalCommand(
  text: string,
): { action: GoalAction; condition: string } | null {
  let argsRaw: string;
  if (GOAL_NAME_RE.test(text)) {
    argsRaw = wrappedArgs(text);
  } else {
    const m = GOAL_BARE_RE.exec(text.trim());
    if (!m) return null;
    argsRaw = m[1] ?? "";
  }
  const condition = argsRaw.trim();
  if (condition === "") return { action: "status", condition: "" };
  if (condition.toLowerCase() === "clear") return { action: "clear", condition: "" };
  return { action: "set", condition };
}

/** A `/goal <condition>` SET, shown as a small dedicated card (target glyph + "Goal set" + the
 *  full condition). Rendered inside the user bubble by `UserText`, so it reads as the user's own
 *  action while standing out from a plain prompt. */
export function GoalCommandCard({ condition }: { condition: string }) {
  return (
    <div className="cv-goalcard">
      <span className="cv-goalcard-head">
        <Ico name="target" className="sm" />
        Goal set
      </span>
      <div className="cv-goalcard-cond">{condition}</div>
    </div>
  );
}
