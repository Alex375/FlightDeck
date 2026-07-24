// Read-only renderer for a `ConversationItem[]` transcript — the reusable brick for the
// sub-agent drill-in (live + disk), the history-panel preview, and the future Workflow /
// Fleet views. Pure: a function of the items handed in, no store reads.
//
// It renders the SAME "clean output" shape as the live thread: each user message is its own
// row, and every assistant turn until the next user message is concatenated into ONE
// response whose intermediate work (tool runs, thinking, in-between prose, sub-agents) folds
// behind a single "Claude's work" block, leaving only the concluding message in clear.
// Tool results arrive as their own `tool_result` items; we join them to their `tool_use` by
// id locally. The grouped sections + the fold are shared VERBATIM with the live thread
// (<ToolSection> / <StaticToolStep> / <ClaudeWorkBlock>), so disk and live never diverge.

import { useMemo, type ReactNode } from "react";
import type { ConversationItem, JsonValue, NormalizedBlock } from "../../ipc/client";
import { Avatar, ClaudeMark, Ico, UserMark } from "../../ui/kit";
import { StreamMarkdown } from "./StreamMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  countWorkSteps,
  groupBlocks,
  runHeader,
  splitFinalMessage,
  type Segment,
} from "./toolGroup";
import { ClaudeWorkBlock, StaticToolStep, ToolSection } from "./ToolSection";
import { SkillChip, UserText } from "./userText";
import { parseSpecialMessage } from "./specialMessage";
import { SpecialMessageCard } from "./SpecialMessageCard";
import { NoticeBlock } from "./noticeView";

interface JoinedResult {
  content: JsonValue;
  isError: boolean;
}

/** Render grouped segments statically (no store): prose / thinking inline, runs of tool
 *  calls coalesced into one collapsed section, a sub-agent as a single step. Shared by the
 *  folded work and the concluding message. */
function renderSegments(segments: Segment[], results: Map<string, JoinedResult>): ReactNode {
  return segments.map((seg) => {
    if (seg.kind === "text") return <StreamMarkdown key={seg.key} text={seg.text} />;
    if (seg.kind === "thinking") return <ThinkingBlock key={seg.key} text={seg.text} finalized />;
    // A nested sub-agent OR workflow OR proposed plan in a settled transcript: one step row
    // (no live card to drill into). These `.step` segments (vs the run branch's `.steps`) MUST
    // be handled here — otherwise they fall through to the run branch and crash. A sub-agent
    // proposing a plan is a non-case in practice, but the union requires the branch.
    if (seg.kind === "agent" || seg.kind === "workflow" || seg.kind === "plan" || seg.kind === "artifact")
      return <StaticToolStep key={seg.key} step={seg.step} result={results.get(seg.step.id)} />;
    // A model-invoked slash-command: the same dedicated command chip as the live thread.
    if (seg.kind === "skill") return <SkillChip key={seg.key} input={seg.step.input} />;
    // In-band markers only exist in the LIVE thread (interleaveMarkers); a disk transcript
    // has none, but the union requires the branch — render nothing.
    if (seg.kind === "marker") return null;
    const errored = seg.steps.some((s) => results.get(s.id)?.isError ?? false);
    return (
      <ToolSection key={seg.key} title={runHeader(seg.steps)} errored={errored}>
        {seg.steps.map((step) => (
          <StaticToolStep key={step.id} step={step} result={results.get(step.id)} />
        ))}
      </ToolSection>
    );
  });
}

/** One Claude response (everything between two user messages): intermediate work folds into a
 *  single "Claude's work" block, leaving only the concluding message in clear. A response
 *  that ends on tools (no concluding prose) renders unfolded, so something always stays in
 *  clear — mirrors the live thread's settled clean-output behaviour. */
function ClaudeResponse({
  blocks,
  results,
}: {
  blocks: NormalizedBlock[];
  results: Map<string, JoinedResult>;
}) {
  const segments = groupBlocks(blocks, true);
  if (segments.length === 0) return null;
  const { work, final } = splitFinalMessage(segments);
  const fold = work.length > 0 && final.length > 0;
  return (
    <div className="cv-msg cv-ai">
      <Avatar ai>
        <ClaudeMark />
      </Avatar>
      <div className="cv-aibody">
        {fold ? (
          <ClaudeWorkBlock count={countWorkSteps(work)}>
            {renderSegments(work, results)}
          </ClaudeWorkBlock>
        ) : (
          renderSegments(work, results)
        )}
        {renderSegments(final, results)}
      </div>
    </div>
  );
}

export type Row =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; blocks: NormalizedBlock[] }
  | { kind: "notice"; key: string; subtype: string; detail: JsonValue };

/** Collapse the flat item list into display rows: each user message is its own row; every
 *  assistant turn until the next user message is concatenated into ONE response (mirrors the
 *  live thread's MsgAIGroup), so the clean-output fold spans a whole multi-turn response.
 *  Exported for unit tests (the "notices are never dropped" contract). */
export function toRows(items: ConversationItem[]): Row[] {
  const rows: Row[] = [];
  let cur: NormalizedBlock[] | null = null;
  items.forEach((it, i) => {
    if (it.kind === "user_message") {
      cur = null;
      rows.push({ kind: "user", key: it.id || `u-${i}`, text: it.text });
    } else if (it.kind === "assistant_message") {
      if (it.blocks.length === 0) return;
      if (!cur) {
        cur = [];
        rows.push({ kind: "assistant", key: it.id || `a-${i}`, blocks: cur });
      }
      cur.push(...it.blocks);
    } else if (it.kind === "notice") {
      // An error notice embedded in the transcript (e.g. `history_error` from a corrupt /
      // unreadable rollout or transcript) MUST surface — the history restore emits it
      // precisely so a partial/failed load is never silent. Break the assistant run so it
      // renders in place, mirroring the live thread's NoticeRow.
      cur = null;
      rows.push({ kind: "notice", key: `n-${i}`, subtype: it.subtype, detail: it.detail });
    }
    // tool_result joins via the results map; streaming kinds aren't part of a settled view.
  });
  return rows;
}

/**
 * The instruction Claude wrote to open a sub-agent's run — rendered with its OWN
 * attribution, never the human avatar.
 *
 * It occupies the "first user turn" slot of a sub-agent transcript because that is how the
 * wire models it, but the human never wrote it: showing it under their avatar claimed they
 * had asked for something they never asked for. Same bubble geometry as a user turn (so the
 * transcript still reads as a conversation), different mark and a label that says who spoke.
 */
export function AgentInstruction({ text }: { text: string }) {
  return (
    <div className="cv-msg cv-user cv-agentprompt">
      <Avatar ai>
        <Ico name="spark" className="sm" />
      </Avatar>
      <div className="cv-bubble">
        <div className="cv-agentprompt-label">Instruction to the sub-agent</div>
        <UserText text={text} />
      </div>
    </div>
  );
}

/**
 * Render a finished transcript (sub-agent / history preview). Pure: depends only on `items`.
 *
 * `agentPrompt`: the opening turn is the instruction Claude gave the sub-agent, not a human
 * message — render it as such (see [`AgentInstruction`]). Off for the history preview, whose
 * first turn IS the human's prompt.
 */
export function SubAgentTranscript({
  items,
  agentPrompt,
}: {
  items: ConversationItem[];
  agentPrompt?: boolean;
}) {
  const results = useMemo(() => {
    const map = new Map<string, JoinedResult>();
    for (const it of items) {
      if (it.kind === "tool_result") {
        map.set(it.tool_use_id, { content: it.content, isError: it.is_error });
      }
    }
    return map;
  }, [items]);
  const rows = useMemo(() => toRows(items), [items]);

  // The first user-shaped row of a SUB-AGENT transcript is the instruction Claude wrote to
  // launch it; everything after is the sub-agent's own run.
  const promptKey = agentPrompt ? rows.find((r) => r.kind === "user")?.key : undefined;

  return (
    <div className="cv-subtranscript">
      {rows.map((r) => {
        if (r.kind === "notice")
          return <NoticeBlock key={r.key} subtype={r.subtype} detail={r.detail} />;
        if (r.kind === "assistant")
          return <ClaudeResponse key={r.key} blocks={r.blocks} results={results} />;
        // Same routing as the live thread: an injected `<task-notification>` renders as
        // the clean card, not a raw user bubble — so history matches the conversation.
        const special = parseSpecialMessage(r.text);
        if (special) return <SpecialMessageCard key={r.key} data={special} />;
        if (r.key === promptKey) return <AgentInstruction key={r.key} text={r.text} />;
        return (
          <div className="cv-msg cv-user" key={r.key}>
            <Avatar user>
              <UserMark />
            </Avatar>
            <div className="cv-bubble">
              <UserText text={r.text} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
