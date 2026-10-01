// "What is the agent doing right now?" — derived from the live stream, so it
// always says something concrete even when the agent doesn't use TodoWrite. We
// read the most recent main-thread tool_use ("Read App.tsx", "Run pnpm test"),
// fall back to the current to-do, then to "writing"/"thinking". Pure + testable;
// the React hook `useActivityLabel` renders it (and swaps the generic "Thinking…"
// for the playful word). Shared by the conversation thread's working indicator and
// the FlightDeck card, so they never describe the agent differently.
import type { JsonValue, SessionEntry } from "./types";
import { todoSummary } from "./todos";
import { field } from "../agent/ask";
import { mcpStepLabel } from "../agent/toolNames";
import { hostOf } from "../features/conversation/webResults";
import { useConversationStore } from "./conversationStore";
import { useNow } from "../ui/useNow";
import { thinkingWord, THINKING_ACCRUAL_CAP_MS } from "./thinkingWords";

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * A human phrase for a tool_use: short English verb + its most telling argument
 * ("Read App.tsx", "Run pnpm test"). English by request — the tool action names
 * read like the claude.ai/code transcript, and the in-flight indicator and the
 * settled step row share this label so they stay identical. (The generic working
 * states — "Thinking…", "Writing a reply…" — live in describeActivity.)
 */
export function toolActivityLabel(name: string, input: JsonValue): string {
  const fp = field(input, "file_path");
  const base = fp ? basename(fp) : null;
  switch (name) {
    case "Read":
      return base ? `Read ${base}` : "Read a file";
    case "Edit":
    case "MultiEdit":
      return base ? `Edit ${base}` : "Edit a file";
    case "Write":
      return base ? `Write ${base}` : "Write a file";
    case "NotebookEdit": {
      const nb = field(input, "notebook_path");
      return nb ? `Edit ${basename(nb)}` : "Edit a notebook";
    }
    case "Bash": {
      const c = field(input, "command");
      return c ? `Run ${truncate(c, 38)}` : "Run a command";
    }
    case "Grep": {
      const p = field(input, "pattern");
      return p ? `Search "${truncate(p, 28)}"` : "Search the code";
    }
    case "Glob": {
      const p = field(input, "pattern");
      return p ? `Find ${truncate(p, 28)}` : "Find files";
    }
    // `Agent` is the wire name of the sub-agent tool (was `Task`); keep `Task` as an
    // alias so resumed/old transcripts still label correctly.
    case "Agent":
    case "Task": {
      const d = field(input, "description");
      return d ? `Sub-agent: ${truncate(d, 28)}` : "Delegate to a sub-agent";
    }
    case "WebFetch": {
      const u = field(input, "url");
      // hostOf returns the raw input verbatim on a parse failure (scheme-less url),
      // so truncate like every other arg-bearing label to avoid a long leak.
      return u ? `Fetch ${truncate(hostOf(u), 28)}` : "Fetch a web page";
    }
    case "WebSearch": {
      const q = field(input, "query");
      return q ? `Search "${truncate(q, 26)}"` : "Search the web";
    }
    case "TodoWrite":
      return "Update the plan";
    case "AskUserQuestion": {
      const qs =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, JsonValue>).questions
          : undefined;
      const n = Array.isArray(qs) ? qs.length : 0;
      return n ? `Ask ${n} question${n > 1 ? "s" : ""}` : "Ask a question";
    }
    // A skill/command invocation: name it directly so the step reads "Skill : code-review"
    // without having to expand the box.
    case "Skill": {
      const s = field(input, "skill");
      return s && s.trim() ? `Skill : ${s.trim()}` : "Skill";
    }
    default: {
      // MCP tools arrive as `mcp__<server>__<tool>` — show "<server> : <tool>" instead
      // of the raw wire name. Falls through to the generic "<name>…" otherwise.
      const mcp = mcpStepLabel(name);
      return mcp ?? `${name}…`;
    }
  }
}

interface ToolUseRef {
  id: string;
  name: string;
  input: JsonValue;
}

/**
 * The tool the agent is running RIGHT NOW: the most-recent UNRESOLVED tool_use of
 * the CURRENT main-thread turn. We stop at the first main turn we hit (scanning
 * newest-first): if it's the user's just-sent message — or an assistant turn with
 * no unresolved tool — nothing is in flight. We never fall through to an older
 * turn, so a finished (or interrupted, result-less) tool from a previous turn can't
 * leak into the next turn's activity line. Scanning the current turn's blocks
 * newest-first also surfaces a slow Read still running when a later parallel tool
 * (batched in the same message) already returned.
 */
function lastInFlightMainToolUse(entry: SessionEntry): ToolUseRef | null {
  for (let i = entry.timeline.length - 1; i >= 0; i--) {
    const e = entry.timeline[i];
    if (e.kind !== "turn") continue;
    const turn = entry.turns[e.id];
    if (!turn || turn.parentToolUseId !== null) continue; // skip sub-agent turns
    // The latest MAIN turn. If it's the user's message, the agent hasn't acted yet.
    if (turn.role !== "assistant") return null;
    for (let b = turn.blocks.length - 1; b >= 0; b--) {
      const blk = turn.blocks[b];
      if (blk.type === "tool_use" && !entry.toolResults[blk.id])
        return { id: blk.id, name: blk.name, input: blk.input };
    }
    return null; // current turn has nothing in flight — don't look at older turns
  }
  return null;
}

/** Is a main-thread assistant turn currently streaming visible text? */
function isStreamingText(entry: SessionEntry): boolean {
  for (const id in entry.turns) {
    const t = entry.turns[id];
    if (
      t.role === "assistant" &&
      t.parentToolUseId === null &&
      t.status === "streaming" &&
      t.streamingText.trim() !== ""
    )
      return true;
  }
  return false;
}

/** The working line while the CLI compacts the conversation. */
export const COMPACTING_LABEL = "Compacting conversation…";

/**
 * Single classification of "what's happening now", so describeActivity and isGenericThinking
 * never disagree. Priority: a compaction in progress → a tool in flight (most concrete) → the
 * current to-do's active phrasing → writing a reply → the generic "thinking" state (nothing
 * else in flight). Never the raw protocol hint ("requesting"). `generic` marks the last-resort thinking state — the
 * ONLY case the playful word ladder substitutes.
 */
function classifyActivity(entry: SessionEntry): { generic: boolean; label: string } {
  // The CLI is summarizing the conversation (`system/status` "compacting"): it says so itself,
  // and it trumps everything else — no tool or reply makes progress until it ends.
  if (entry.state.activity === "compacting") return { generic: false, label: COMPACTING_LABEL };

  const tool = lastInFlightMainToolUse(entry);
  if (tool) return { generic: false, label: toolActivityLabel(tool.name, tool.input) };

  const current = todoSummary(entry.todos).current;
  if (current?.activeForm) return { generic: false, label: current.activeForm };

  if (isStreamingText(entry)) return { generic: false, label: "Writing a reply…" };

  return { generic: true, label: "Thinking…" };
}

/**
 * A live, human "what's happening now" line — the raw activity WITHOUT the playful word
 * substitution (that lives in `useActivityLabel`, which needs live time). Pure + testable.
 */
export function describeActivity(entry: SessionEntry | undefined): string {
  if (!entry) return "Working…";
  return classifyActivity(entry).label;
}

/** True when the activity is the generic "Thinking…" state — where the playful word applies. */
export function isGenericThinking(entry: SessionEntry | undefined): boolean {
  return !!entry && classifyActivity(entry).generic;
}

/**
 * Cumulative time (ms) the generic "Thinking…" spinner has been shown across the whole
 * discussion: the sealed total plus the open spell in flight (`now - thinkingSince`). This is
 * what the user actually watches — NOT internal reasoning-block time, which is often ~0 and left
 * the word stuck on the anchor. Accrued by the global ticker (see `accrueThinking`); in-memory →
 * resets on reload. `now` is passed in so callers can tick it via `useNow`.
 */
export function cumulativeThinkingMs(entry: SessionEntry, now: number): number {
  // Cap the live open spell like the ticker does, so a render right after wake (before the next
  // tick advances thinkingSince) can't briefly spike the tier.
  const live =
    entry.thinkingSince != null
      ? Math.min(Math.max(0, now - entry.thinkingSince), THINKING_ACCRUAL_CAP_MS)
      : 0;
  return entry.thinkingMs + live;
}

/**
 * The activity label to render: the concrete action (tool/to-do/writing) verbatim, or — in the
 * generic "Thinking…" state — the playful word for the discussion's cumulative thinking time.
 * `useNow` re-renders once a second so live cumulative time (and thus the tier / the 40 s word
 * rotation) advances; it's cheap because the working indicator is mounted only while active.
 */
export function useActivityLabel(convId: string): string {
  const entry = useConversationStore((s) => s.sessions[convId]);
  const now = useNow(1000);
  if (!entry) return "Working…";
  const { generic, label } = classifyActivity(entry);
  if (!generic) return label;
  return thinkingWord(cumulativeThinkingMs(entry, now), entry.turnCount, convId) + "…";
}

/**
 * The FOREGROUND shell command running RIGHT NOW (the in-flight main-thread Bash) —
 * the live "$ command…" terminal indicator. `null` when the live tool isn't a Bash.
 * A `run_in_background: true` Bash gets its tool_result immediately, so it is never
 * "in flight" here — those are surfaced in the pinned <BashBar> instead. Returns the
 * full command (the indicator truncates for display). Pure for testing.
 */
export function liveBashCommand(entry: SessionEntry | undefined): string | null {
  if (!entry) return null;
  const tool = lastInFlightMainToolUse(entry);
  if (!tool || tool.name !== "Bash") return null;
  const c = field(tool.input, "command");
  return c && c.trim() ? c.trim() : null;
}

/** Reactive live foreground shell command for a conversation (by stable id). */
export function useLiveBashCommand(convId: string): string | null {
  return useConversationStore((s) => liveBashCommand(s.sessions[convId]));
}
