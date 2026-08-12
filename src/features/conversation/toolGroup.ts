// Grouping layer for the conversation transcript: turns a turn's flat block list
// into SEGMENTS, where every run of consecutive tool_use blocks becomes ONE
// collapsible "Ran N steps" section (the claude.ai/code shape — see memory
// `claude-app-transcript-grouped-steps`). Assistant prose / thinking break a run,
// so a turn that writes → runs 4 tools → writes → runs 2 tools yields two sections,
// exactly like the reference. Pure + framework-free so it is unit-testable and
// shared verbatim by the live thread (ConductorThread) and the off-thread
// transcript (SubAgentTranscript).

import type { BackgroundTaskStatus, JsonValue, NormalizedBlock } from "../../ipc/client";
import type { RoundMarker } from "../../store/types";
import { field } from "../../agent/ask";
import { toolActivityLabel } from "../../store/activity";
import { isRunInBackground } from "../../agent/subagentMeta";
import { parseMcpToolName, prettyMcpServer } from "../../agent/toolNames";
import { basename, toolMeta } from "./toolMeta";
import { diffCounts, lineDiff } from "./lineDiff";

/** Lucide-ish icon token per tool, resolved by the UI's <Ico>. Shared so the live
 *  step rows and the static transcript pick the same glyph for a given tool. */
export const TOOL_ICON: Record<string, string> = {
  Read: "file",
  Edit: "diff",
  MultiEdit: "diff",
  Write: "file",
  Bash: "term",
  Grep: "search",
  Glob: "search",
  // `globe` matches toolMeta's WebFetch icon and stays distinct from the run
  // section's own `layers` glyph (a WebFetch step shouldn't echo its container).
  WebFetch: "globe",
  WebSearch: "search",
  // The sub-agent tool is `Agent` on the wire (was `Task`); keep `Task` as an alias.
  Agent: "spark",
  Task: "spark",
  TodoWrite: "list",
  NotebookEdit: "diff",
  AskUserQuestion: "form",
  // A skill/command invocation gets the wand glyph (distinct from the sub-agent spark).
  Skill: "wand",
};

/** Icon token for a step's glyph. MCP tools have variable `mcp__server__tool` names that
 *  can't be table-keyed, so they all resolve to one plug glyph; everything else uses
 *  TOOL_ICON, falling back to a cog for unknown tools. */
export function stepIcon(name: string): string {
  if (parseMcpToolName(name)) return "plug";
  return TOOL_ICON[name] ?? "cog";
}

export interface ToolStep {
  /** tool_use id — joins to its result. */
  id: string;
  name: string;
  input: JsonValue;
}

/**
 * A sentinel spliced into a round's block stream (via {@link interleaveMarkers}) so an
 * in-band marker — a control-change bar or a message injected mid-work — renders inline in
 * the response flow. Its own `type` so {@link groupBlocks} routes it like a text/thinking
 * boundary (flushes the run, emits a `marker` segment) instead of a tool step.
 */
export interface BlockMarker {
  type: "marker";
  markerKind: "notice" | "user";
  /** notice id or user turn id, resolved to content at render. */
  id: string;
  key: string;
}

/** What {@link groupBlocks} consumes: real content blocks plus optional inline markers. */
export type GroupInput = NormalizedBlock | BlockMarker;

export type Segment =
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "run"; key: string; steps: ToolStep[] }
  // A sub-agent (Agent/Task) renders as its OWN inline card (rich live lifecycle +
  // drill-in transcript), NEVER grouped into a run nor hidden by the live-trailing
  // suppression — so it gets a dedicated segment that breaks the surrounding run.
  | { kind: "agent"; key: string; step: ToolStep }
  // A `Workflow` renders as its OWN persistent inline card (live overview → post-run report),
  // like a sub-agent: dedicated segment, breaks the run, never hidden.
  | { kind: "workflow"; key: string; step: ToolStep }
  // A `Skill` (a slash-command the MODEL invoked) renders as a dedicated inline command chip,
  // like a user-typed `/foo`: its own segment, breaks the run, never grouped into a step row.
  | { kind: "skill"; key: string; step: ToolStep }
  // `ExitPlanMode` — the proposed plan — renders as its OWN prominent inline card (markdown
  // plan + accept/reject decision + annotations). Like a sub-agent it gets a dedicated
  // segment that breaks the surrounding run; it is a DECISION artifact, never intermediate
  // work, so it is also peeled out of the clean-output work fold (see splitFinalMessage).
  | { kind: "plan"; key: string; step: ToolStep }
  // An `Artifact` publish (a hosted claude.ai/code page) renders as its OWN inline card, like a
  // sub-agent: dedicated segment that breaks the run, never grouped into a step row. It is a
  // DELIVERABLE, never intermediate work, so it is also peeled out of the clean-output work fold
  // (see splitFinalMessage) and shown in clear even when buried mid-round (see renderFoldedWork).
  | { kind: "artifact"; key: string; step: ToolStep }
  // `AskUserQuestion` — an interactive question to the user — is a DECISION artifact exactly
  // like a plan: it renders as its OWN inline card (question + chosen answer once settled)
  // instead of an anonymous "Question" step row buried in a collapsed run, and it is peeled
  // out of the clean-output work fold (see splitFinalMessage). Burying it made whole
  // exchanges unreadable: a round of text → tools → question showed only tool rows.
  | { kind: "question"; key: string; step: ToolStep }
  // An in-band marker (control-change bar / message injected mid-work) shown inline in the
  // flow. NOT work: it doesn't count as a step and never breaks the clean-output work fold —
  // it just renders at its chronological place (see coalesceCleanRounds / interleaveMarkers).
  | { kind: "marker"; key: string; markerKind: "notice" | "user"; id: string };

/**
 * A tool_use that is NEVER shown inline in the thread — it lives in a pinned bar or
 * elsewhere — so it must not appear as a step NOR break a run (it's invisible):
 *  - any detached `run_in_background` tool (Bash → BashBar, Agent → AgentBar),
 *  - `Monitor` (always a background watch → MonitorBar),
 *  - anything `toolMeta` marks suppressed (TodoWrite → TodoBar, ide_ RPC).
 *
 * `Workflow` is NOT hidden: it renders as a persistent inline <WorkflowCard> (its own segment),
 * so the post-run report stays reachable from the thread.
 */
export function isHiddenInline(name: string, input: JsonValue): boolean {
  if (name === "Monitor") return true;
  if (isRunInBackground(input)) return true;
  return toolMeta(name, input).suppressed;
}

/**
 * Walk a turn's blocks, coalescing consecutive (non-hidden) tool_use blocks into
 * `run` segments. Text / thinking flush the current run and render as separators;
 * hidden tools are skipped without breaking the surrounding run. Empty text/thinking
 * blocks are dropped (a streamed turn can hold empty placeholders).
 *
 * `includeBackground` keeps the normally-hidden background tools (Monitor, detached
 * `run_in_background` Bash) as inline steps. The LIVE main thread leaves it false —
 * those tools live in pinned bars (MonitorBar / BashBar). The off-thread disk
 * transcript (SubAgentTranscript) sets it true: it has NO live bar to compensate, so
 * hiding them there would silently drop the only record of those calls.
 *
 * `backgroundToolUseIds` are extra tool_use ids to hide as background even when their
 * `input` doesn't say so — a detached sub-agent recovered from its launch ack (see
 * `bgAgentIds` in the store). Ignored under `includeBackground` (the disk view shows them).
 */
export function groupBlocks(
  blocks: ReadonlyArray<GroupInput>,
  includeBackground = false,
  backgroundToolUseIds?: ReadonlySet<string>,
): Segment[] {
  const out: Segment[] = [];
  let run: ToolStep[] | null = null;

  blocks.forEach((b, i) => {
    if (b.type === "marker") {
      // An in-band marker (control-change bar / injected message): flush the run and render
      // it inline — like prose, it breaks the run but is NOT a tool step.
      run = null;
      out.push({ kind: "marker", key: b.key, markerKind: b.markerKind, id: b.id });
      return;
    }
    if (b.type === "tool_use") {
      // Live thread: hide everything `isHiddenInline` covers (a pinned bar shows the
      // background ones), PLUS any id the store flagged detached-by-ack. Disk transcript
      // (includeBackground): keep background tools as steps — no bar compensates there —
      // but `toolMeta`-suppressed tools (TodoWrite, ide_ RPC) are noise everywhere and stay
      // hidden.
      if (includeBackground) {
        if (toolMeta(b.name, b.input).suppressed) return;
      } else if (isHiddenInline(b.name, b.input) || backgroundToolUseIds?.has(b.id)) {
        return; // invisible: no step, no break
      }
      // A sub-agent is its own inline card, not a grouped step — it breaks the run.
      if (b.name === "Agent" || b.name === "Task") {
        run = null;
        out.push({ kind: "agent", key: `a-${i}`, step: { id: b.id, name: b.name, input: b.input } });
        return;
      }
      // A Workflow is its own persistent inline card — also breaks the run.
      if (b.name === "Workflow") {
        run = null;
        out.push({ kind: "workflow", key: `w-${i}`, step: { id: b.id, name: b.name, input: b.input } });
        return;
      }
      // A Skill (model-invoked slash-command) is its own inline command chip — breaks the run
      // so the invocation stands out instead of hiding in a "Ran N steps" step row.
      if (b.name === "Skill") {
        run = null;
        out.push({ kind: "skill", key: `sk-${i}`, step: { id: b.id, name: b.name, input: b.input } });
        return;
      }
      // ExitPlanMode is the proposed plan — its own prominent inline card, breaks the run.
      if (b.name === "ExitPlanMode") {
        run = null;
        out.push({ kind: "plan", key: `p-${i}`, step: { id: b.id, name: b.name, input: b.input } });
        return;
      }
      // An Artifact PUBLISH is its own inline card (a deliverable link) — breaks the run so the
      // published page stands out instead of hiding in a "Ran N steps" step row (and its .html
      // file_path never renders as an editor-opening chip pointing at a disposable temp file).
      // Only a real publish qualifies: the `Artifact` tool also does `action:"list"` (enumerate
      // the user's artifacts) and bare cross-conversation `url`-updates, which carry NO file_path
      // and are NOT a local deliverable — those fall through to the normal run/step path so their
      // result is shown like any other tool. This MUST mirror `selectArtifacts` (the chip's
      // derivation, which skips file_path-less calls) or the two surfaces disagree.
      if (b.name === "Artifact" && field(b.input, "file_path")) {
        run = null;
        out.push({ kind: "artifact", key: `art-${i}`, step: { id: b.id, name: b.name, input: b.input } });
        return;
      }
      // AskUserQuestion is a decision artifact (question + answer) — its own inline card,
      // breaks the run so the exchange stays readable in the flow.
      if (b.name === "AskUserQuestion") {
        run = null;
        out.push({ kind: "question", key: `q-${i}`, step: { id: b.id, name: b.name, input: b.input } });
        return;
      }
      if (!run) {
        run = [];
        out.push({ kind: "run", key: `run-${i}`, steps: run });
      }
      run.push({ id: b.id, name: b.name, input: b.input });
      return;
    }
    run = null; // any non-tool block ends the run
    if (b.type === "text") {
      if (b.text) out.push({ kind: "text", key: `t-${i}`, text: b.text });
    } else if (b.type === "thinking") {
      if (b.text) out.push({ kind: "thinking", key: `th-${i}`, text: b.text });
    }
    // `other` blocks (images/documents) are not rendered here.
  });

  return out;
}

/**
 * Split a grouped assistant response's segments into the intermediate WORK and the FINAL
 * message, for the "collapse work" display mode. The final message = the trailing run of
 * `text` segments (the response's CONCLUDING prose); everything before it is work to fold.
 *
 * NOTE on grouping: an assistant "response" is one OR MORE consecutive turns concatenated
 * (MsgAIGroup). So when the agent narrates between tool batches ("let me check…", then more
 * tools, then "done"), only the CONCLUDING prose stays in clear; the in-between narration
 * folds with the work. This is intentional for "clean output" — the user opted to see only
 * the response's final message, with all the mechanics (tools, thinking, interim narration)
 * tucked behind the one fold. Mirrors the user-facing copy "only show the final message of
 * each response".
 *
 *  - work + final  → fold `work` behind one block, show `final` in clear.
 *  - only final (no work)        → `work` empty: render the message bare, no block.
 *  - only work (no trailing text) → `final` empty: the caller decides (e.g. don't fold
 *    a settled response that ends on tools — see AssistantBlocks).
 */
export function splitFinalMessage(segments: Segment[]): {
  work: Segment[];
  final: Segment[];
} {
  // Peel the trailing concluding prose AND any in-band marker sitting after it (a control-change
  // bar / injected message that lands right at the end of the response) into `final`, so the
  // marker stays in clear next to the message instead of emptying `final` and defeating the fold
  // (which would render the whole settled round unfolded). A marker separated from the final text
  // by a run still stops the scan at that run — only intermediate work folds.
  //
  // A trailing `plan` (ExitPlanMode) is peeled too: the proposed plan is a decision artifact, not
  // intermediate work — it must stay in clear even under clean output, especially while it awaits
  // approval (the agent pauses right after it). A plan buried mid-response (e.g. a resumed history
  // where the approved plan is followed by more work in the same group) is NOT peeled here — the
  // scan stops at the trailing run — but it is still shown in clear: CleanBlocks splits the fold
  // at each plan (see renderFoldedWork), so a buried plan is never hidden inside the work block.
  // A trailing `question` (AskUserQuestion) is peeled like a plan: a response that closes on a
  // question — typically prose explaining the situation, then the ask — must keep BOTH the
  // question card and its preceding explanation in clear, not fold them as "work".
  let i = segments.length;
  while (
    i > 0 &&
    (segments[i - 1].kind === "text" ||
      segments[i - 1].kind === "marker" ||
      segments[i - 1].kind === "plan" ||
      // A trailing `artifact` is peeled too: a just-published artifact is a deliverable, not
      // intermediate work — it stays in clear under clean output (like a plan).
      segments[i - 1].kind === "artifact" ||
      segments[i - 1].kind === "question")
  )
    i--;
  return { work: segments.slice(0, i), final: segments.slice(i) };
}

// ---- Clean-output folding (live, running-aware) ----------------------------
// A round's work flattens to ATOMS (one per tool step / thinking / prose / sub-agent) so
// the live fold can be decided per item: settled work folds into the block, while the
// sliding window AND any still-running tool stay visible. The kept atoms reconstruct back
// into segments for rendering.

export type WorkAtom =
  | { kind: "step"; key: string; step: ToolStep }
  | { kind: "agent"; key: string; step: ToolStep }
  | { kind: "workflow"; key: string; step: ToolStep }
  // A skill chip: a non-step atom (like text/thinking) — it folds with the surrounding work
  // but never counts as a step nor holds the live window open (its ack settles instantly).
  | { kind: "skill"; key: string; step: ToolStep }
  | { kind: "plan"; key: string; step: ToolStep }
  // An artifact card: a non-step atom (like a skill chip) — folds with surrounding work but never
  // counts as a step nor holds the live window open (its publish settles quickly). It is pulled
  // back into clear by renderFoldedWork so a published artifact is never hidden.
  | { kind: "artifact"; key: string; step: ToolStep }
  // A question card: a non-step atom (like plan) — folds only when buried mid-work, never
  // counts as a step nor holds the live window open.
  | { kind: "question"; key: string; step: ToolStep }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  // An in-band marker: a non-step atom (like text/thinking) — it folds with the surrounding
  // work but never counts as a step nor forces the fold open.
  | { kind: "marker"; key: string; markerKind: "notice" | "user"; id: string };

/** Flatten work segments into per-item atoms (a run → one atom per step). */
export function flattenWork(segs: Segment[]): WorkAtom[] {
  const out: WorkAtom[] = [];
  for (const seg of segs) {
    if (seg.kind === "run") {
      for (const step of seg.steps) out.push({ kind: "step", key: `${seg.key}-${step.id}`, step });
    } else if (seg.kind === "agent") {
      out.push({ kind: "agent", key: seg.key, step: seg.step });
    } else if (seg.kind === "workflow") {
      out.push({ kind: "workflow", key: seg.key, step: seg.step });
    } else if (seg.kind === "skill") {
      out.push({ kind: "skill", key: seg.key, step: seg.step });
    } else if (seg.kind === "plan") {
      out.push({ kind: "plan", key: seg.key, step: seg.step });
    } else if (seg.kind === "artifact") {
      out.push({ kind: "artifact", key: seg.key, step: seg.step });
    } else if (seg.kind === "question") {
      out.push({ kind: "question", key: seg.key, step: seg.step });
    } else if (seg.kind === "thinking") {
      out.push({ kind: "thinking", key: seg.key, text: seg.text });
    } else if (seg.kind === "marker") {
      out.push({ kind: "marker", key: seg.key, markerKind: seg.markerKind, id: seg.id });
    } else {
      out.push({ kind: "text", key: seg.key, text: seg.text });
    }
  }
  return out;
}

/** Reconstruct segments from atoms, re-coalescing consecutive steps into runs. `keyPrefix`
 *  keeps reconstructed run keys stable per call-site (the visible vs the folded side), so a
 *  run section isn't remounted as the fold boundary slides.
 *
 *  ⚠️ The key is derived from the run's FIRST step, never from its ordinal in the slice. The
 *  slice's START moves every time the fold boundary advances, so an ordinal would renumber
 *  every following run (`vis-run-1` → `vis-run-0`) as soon as an earlier one folded away —
 *  remounting a live, untouched tool section and slamming shut whatever the user had expanded
 *  inside it. A step's tool_use id is unique, so the key stays put for the run's whole life. */
export function atomsToSegments(atoms: WorkAtom[], keyPrefix: string): Segment[] {
  const out: Segment[] = [];
  let run: ToolStep[] | null = null;
  for (const a of atoms) {
    if (a.kind === "step") {
      if (!run) {
        run = [];
        out.push({ kind: "run", key: `${keyPrefix}-run-${a.step.id}`, steps: run });
      }
      run.push(a.step);
      continue;
    }
    run = null;
    if (a.kind === "agent") out.push({ kind: "agent", key: a.key, step: a.step });
    else if (a.kind === "workflow") out.push({ kind: "workflow", key: a.key, step: a.step });
    else if (a.kind === "skill") out.push({ kind: "skill", key: a.key, step: a.step });
    else if (a.kind === "plan") out.push({ kind: "plan", key: a.key, step: a.step });
    else if (a.kind === "artifact") out.push({ kind: "artifact", key: a.key, step: a.step });
    else if (a.kind === "question") out.push({ kind: "question", key: a.key, step: a.step });
    else if (a.kind === "thinking") out.push({ kind: "thinking", key: a.key, text: a.text });
    else if (a.kind === "marker")
      out.push({ kind: "marker", key: a.key, markerKind: a.markerKind, id: a.id });
    else out.push({ kind: "text", key: a.key, text: a.text });
  }
  return out;
}

/**
 * Build a round's block stream with its in-band markers spliced back at their turn
 * boundaries. `blocksByTurn[k]` is the k-th grouped assistant turn's blocks; a marker with
 * `after: n` is emitted right after the n-th turn (n = 0 → before the first). Pure so the
 * interleaving is unit-testable and shared by the live thread. With no markers it returns the
 * turns' blocks concatenated — identical to the plain grouped stream.
 */
export function interleaveMarkers(
  blocksByTurn: ReadonlyArray<ReadonlyArray<NormalizedBlock>>,
  markers: ReadonlyArray<RoundMarker>,
): GroupInput[] {
  const at = (k: number): BlockMarker[] =>
    markers
      .filter((m) => m.after === k)
      .map((m) => ({ type: "marker", markerKind: m.markerKind, id: m.id, key: `mk-${m.id}` }));
  const out: GroupInput[] = [...at(0)];
  blocksByTurn.forEach((blocks, idx) => {
    out.push(...blocks, ...at(idx + 1));
  });
  return out;
}

/**
 * The atom index from which work stays VISIBLE in clean-output LIVE mode; everything before
 * folds into the block. The visible region is `min(firstRunning, windowStart)`:
 *  - the sliding window: the last `window` tool steps stay visible, AND
 *  - every still-running tool stays visible — we NEVER fold a tool that is still running,
 *    so the fold can't extend past the FIRST running atom.
 * In a PARALLEL batch where an early tool is still running while later ones have already
 * settled, the whole batch stays visible until that early tool finishes — a single leading
 * fold can't skip around a running tool, and a tool in progress must stay on screen. It all
 * folds normally the moment the batch settles. (So the visible region is not necessarily the
 * sliding window alone; a front-running tool can widen it.)
 */
export function liveVisibleStart(
  atoms: WorkAtom[],
  isRunning: (id: string) => boolean,
  window: number,
): number {
  let runningStart = atoms.length;
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if ((a.kind === "step" || a.kind === "agent" || a.kind === "workflow") && isRunning(a.step.id)) {
      runningStart = i;
      break;
    }
  }
  let windowStart = atoms.length;
  let steps = 0;
  for (let i = atoms.length - 1; i >= 0; i--) {
    windowStart = i;
    if (atoms[i].kind === "step") {
      steps++;
      if (steps >= window) break;
    }
  }
  return Math.min(runningStart, windowStart);
}

/**
 * Is a work atom (tool step / sub-agent) STILL RUNNING for the live fold? This is the
 * `isRunning` predicate fed to {@link liveVisibleStart}, and it must agree with what the
 * rest of the UI shows as "working" (the SubAgentCard dot, the pinned bars) — otherwise the
 * fold can hide a tool that is still visibly spinning.
 *
 * The subtlety the bare tool_result misses: a sub-agent's `Agent` tool_result can land
 * BEFORE its terminal `task_notification` flips the background task to a settled status.
 * Keying "done" on the result alone (`hasResult`) would then fold the sub-agent while its
 * card still shows the running dot — exactly the bug this guards against. So when a
 * background task exists for the atom, ITS status is authoritative; the result presence only
 * decides when there is no task (foreground tools — Bash/Read/… spawn none — or a sub-agent
 * whose task lifecycle we never saw, e.g. a resumed conversation).
 *
 * Mirrors SubAgentCard's `running = status === "running" || (status == null && !result)`
 * (the live fold only runs while the session is busy, so the card's extra `&& busy` is
 * implied here).
 */
export function atomStillRunning(opts: {
  hasResult: boolean;
  /** The atom's background task status, or null when no task was reported for it. */
  taskStatus: BackgroundTaskStatus | null;
}): boolean {
  if (opts.taskStatus === "running") return true; // task says working → still running
  if (opts.taskStatus != null) return false; // task reached a terminal status → done
  return !opts.hasResult; // no task: a missing tool_result means it is still running
}

/** How many "steps" a stretch of work represents, for the "Claude's work — N
 *  steps" header: every tool step across its runs PLUS each sub-agent (in clean-output the
 *  sub-agents fold into the block too, so they count as work). Prose and thinking are not
 *  steps and are not counted. */
export function countWorkSteps(segments: Segment[]): number {
  let n = 0;
  for (const s of segments) {
    if (s.kind === "run") n += s.steps.length;
    else if (s.kind === "agent" || s.kind === "workflow") n += 1;
  }
  return n;
}

/** The tool_use ids of a stretch of work — run steps + sub-agents, in order. Lets a fold
 *  subscribe to EXACTLY its own tools' results (running / errored) instead of the whole
 *  result map, so a settled round doesn't re-render while a later turn streams. */
export function workStepIds(segments: Segment[]): string[] {
  const ids: string[] = [];
  for (const s of segments) {
    if (s.kind === "run") for (const st of s.steps) ids.push(st.id);
    else if (s.kind === "agent" || s.kind === "workflow") ids.push(s.step.id);
  }
  return ids;
}

/** Short English verb per tool, for a run section's action summary. */
export function toolVerb(name: string): string {
  switch (name) {
    case "Read":
      return "Read";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "Edit";
    case "Write":
      return "Write";
    case "Bash":
      return "Run";
    case "Grep":
    case "WebSearch":
      return "Search";
    case "Glob":
      return "Find";
    case "WebFetch":
      return "Fetch";
    case "Agent":
    case "Task":
      return "Agent";
    case "AskUserQuestion":
      return "Question";
    case "TodoWrite":
      return "Update";
    default:
      return name;
  }
}

/**
 * A clear, DETERMINISTIC header for a run section (no LLM call): for a single step,
 * its full label ("Read App.tsx"); otherwise the groups in first-seen order. A native
 * tool groups by its action verb with a ×N when it repeats — "Read · Search · Find",
 * "Run ×3", "Edit ×2 · Run". MCP tools group by their server, shown as a count —
 * "claude ai TOSSE · 3 tools · playwright · 1 tool" — since their raw `mcp__…` names
 * are too verbose to list. Capped so it stays one line.
 */
export function runHeader(steps: ToolStep[]): string {
  if (steps.length === 1) return stepLabel(steps[0].name, steps[0].input);
  // A group is either a native action verb or one MCP server; keyed so the two never
  // collide. `display` holds the human label, `mcp` flags the count-style rendering.
  const order: string[] = [];
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  const mcpKeys = new Set<string>();
  for (const s of steps) {
    const m = parseMcpToolName(s.name);
    const key = m ? `mcp:${m.server}` : `verb:${toolVerb(s.name)}`;
    if (!counts.has(key)) {
      order.push(key);
      display.set(key, m ? prettyMcpServer(m.server) : toolVerb(s.name));
      if (m) mcpKeys.add(key);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const MAX = 4;
  const parts = order.slice(0, MAX).map((key) => {
    const n = counts.get(key) ?? 1;
    const label = display.get(key) ?? key;
    if (mcpKeys.has(key)) return `${label} · ${n} ${n === 1 ? "tool" : "tools"}`;
    return n > 1 ? `${label} ×${n}` : label;
  });
  if (order.length > MAX) parts.push(`+${order.length - MAX}`);
  return parts.join(" · ");
}

/**
 * The one-line label for a settled step. Prefers the agent-written `description`
 * for Bash/Agent (what the reference shows — "Explored backend structure"), else
 * the same English name+arg phrasing as the live activity indicator ("Edit foo.ts"),
 * so the in-flight line and the settled step read identically.
 */
export function stepLabel(name: string, input: JsonValue): string {
  if (name === "Bash" || name === "Agent" || name === "Task") {
    const desc = field(input, "description");
    if (desc && desc.trim()) return desc.trim();
  }
  return toolActivityLabel(name, input);
}

export type StepSummary =
  | { kind: "diff"; added: number; removed: number }
  | { kind: "text"; text: string }
  | null;

function countNonEmptyLines(s: string): number {
  let n = 0;
  for (const line of s.split("\n")) if (line.trim()) n++;
  return n;
}

/** Pull the `edits[]` hunks out of a MultiEdit input. */
export function multiEdits(input: JsonValue): { old: string; next: string }[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const edits = (input as Record<string, JsonValue>).edits;
  if (!Array.isArray(edits)) return [];
  return edits.map((e) => ({
    old: field(e, "old_string") ?? "",
    next: field(e, "new_string") ?? "",
  }));
}

/**
 * A compact result summary shown on the step's collapsed row, like the reference
 * ("+5 −2", "12 results"). Edits/Write derive from the INPUT alone (no result
 * needed); Grep/Glob count lines of their result text. `resultText` is the joined
 * tool_result rendered as text, or null while still running / unavailable.
 */
export function stepSummary(
  name: string,
  input: JsonValue,
  resultText: string | null,
): StepSummary {
  switch (name) {
    case "Edit": {
      const c = diffCounts(
        lineDiff(field(input, "old_string") ?? "", field(input, "new_string") ?? ""),
      );
      return { kind: "diff", added: c.added, removed: c.removed };
    }
    case "MultiEdit": {
      let added = 0;
      let removed = 0;
      for (const e of multiEdits(input)) {
        const c = diffCounts(lineDiff(e.old, e.next));
        added += c.added;
        removed += c.removed;
      }
      return { kind: "diff", added, removed };
    }
    case "Write": {
      const content = field(input, "content") ?? "";
      // Trim a single trailing newline so a file ending in "\n" (the common case)
      // isn't counted as one extra line.
      const n = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
      return { kind: "text", text: `${n} line${n === 1 ? "" : "s"}` };
    }
    case "Grep":
    case "Glob": {
      if (!resultText) return null;
      const n = countNonEmptyLines(resultText);
      return { kind: "text", text: `${n} result${n === 1 ? "" : "s"}` };
    }
    default:
      return null;
  }
}

/** Basename of the step's primary file argument (for the clickable file chip), if any. */
export function stepFilePath(input: JsonValue): string | null {
  return field(input, "file_path") ?? null;
}

export { basename };
