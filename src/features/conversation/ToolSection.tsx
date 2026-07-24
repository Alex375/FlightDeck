// Shared rendering for the grouped-steps transcript: a collapsible "Executed N
// steps" section (<ToolSection>) holding compact, individually-expandable step
// rows (<ToolStepRow>), plus the per-tool detail body (<ToolDetail>). Used VERBATIM
// by the live thread (ConductorThread) and the off-thread transcript
// (SubAgentTranscript) so the two never diverge — the live side feeds <LiveToolStep>
// (subscribes to the store for its result), the disk side feeds <StaticToolStep>
// (result handed in). Collapsed by default; an error is flagged ONLY by a small alert glyph
// on the row / section — no auto-expand, no red text (the user opens it on purpose).

import { useEffect, useState, type ReactNode } from "react";
import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import {
  useSessionState,
  useToolResult,
  useToolDuration,
  useToolStartedAt,
} from "../../store/conversationStore";
import { useDisplay } from "../../store/display";
import { fmtDuration } from "../../agent/subagentMeta";
import { useNow } from "../../ui/useNow";
import { useWorkFold } from "../../store/workFold";
import { Ico } from "../../ui/kit";
import { DiffView } from "./DiffView";
import { applyPatchChanges, parseUnifiedDiff } from "./unifiedDiff";
import { MentionPathChip } from "./FileMention";
import { QuestionnaireSummary } from "./QuestionnaireAsk";
import { resultContentText } from "./resultText";
import { StreamMarkdown } from "./StreamMarkdown";
import { ToolResultBody } from "./ToolResultBody";
import { toolMeta } from "./toolMeta";
import { WebToolDetail } from "./WebSources";
import {
  basename,
  multiEdits,
  stepFilePath,
  stepIcon,
  stepLabel,
  stepSummary,
  type StepSummary,
  type ToolStep,
} from "./toolGroup";

export interface StepResult {
  content: JsonValue;
  isError: boolean;
}

// Re-exported for callers that historically imported it from here (the implementation now
// lives in the framework-free ./resultText so planStatus can share it without pulling React).
export { resultContentText };

/** Does this tool have an expandable detail body (diff / output / questionnaire / plan)? */
function hasDetailFor(name: string, input: JsonValue, result: StepResult | undefined): boolean {
  const kind = toolMeta(name, input).kind;
  return (
    kind === "edit" ||
    kind === "write" ||
    kind === "bash" ||
    name === "AskUserQuestion" ||
    name === "ExitPlanMode" ||
    !!result
  );
}

/** The expanded detail of a step: a diff (Edit/Write), the command + output (Bash),
 *  the questionnaire recap (AskUserQuestion), or the raw result body. */
export function ToolDetail({
  name,
  input,
  result,
}: {
  name: string;
  input: JsonValue;
  result: StepResult | undefined;
}) {
  const meta = toolMeta(name, input);

  if (name === "AskUserQuestion") return <QuestionnaireSummary input={input} result={result?.content} />;

  // Codex's file-edit tool: `changes: [{path, kind, diff}]`, each `diff` a per-file unified
  // diff. Parse each into DiffView's line model (the result is authoritative — the input can
  // be frozen empty). No structured changes yet (still running) → fall through to the raw body.
  if (name === "ApplyPatch") {
    const changes = applyPatchChanges(input, result?.content);
    if (changes.length > 0)
      return (
        <>
          {changes.map((c, k) => (
            <DiffView key={k} path={c.path || undefined} lines={parseUnifiedDiff(c.diff)} kind={c.kind} />
          ))}
        </>
      );
    return result ? <ToolResultBody content={result.content} isError={result.isError} /> : null;
  }

  // The proposed plan (rare in a settled/sub-agent transcript, where the rich <PlanCard> is not
  // used): render the plan markdown so an expanded row isn't empty.
  if (name === "ExitPlanMode") return <StreamMarkdown text={field(input, "plan") ?? ""} />;

  if (meta.kind === "edit") {
    if (name === "MultiEdit")
      return (
        <>
          {multiEdits(input).map((e, k) => (
            <DiffView key={k} path={field(input, "file_path")} oldText={e.old} newText={e.next} />
          ))}
        </>
      );
    return (
      <DiffView
        path={field(input, "file_path")}
        oldText={field(input, "old_string") ?? ""}
        newText={field(input, "new_string") ?? ""}
      />
    );
  }

  if (meta.kind === "write")
    return <DiffView path={field(input, "file_path")} newText={field(input, "content") ?? ""} />;

  // Web research: render sources as clickable chips + the summary/page markdown,
  // instead of the raw <pre> dump. Only on a SUCCESSFUL result — an errored fetch
  // (404/timeout/blocked) falls through to ToolResultBody, which renders the error
  // body with its error styling (a source chip would falsely imply success).
  if ((name === "WebSearch" || name === "WebFetch") && result && !result.isError)
    return <WebToolDetail name={name} input={input} text={resultContentText(result.content) ?? ""} />;

  if (meta.kind === "bash")
    return (
      <>
        {meta.primaryArg ? <pre className="cv-tool-cmd wf-mono">{meta.primaryArg}</pre> : null}
        {result ? <ToolResultBody content={result.content} isError={result.isError} /> : null}
      </>
    );

  return result ? <ToolResultBody content={result.content} isError={result.isError} /> : null;
}

function SummaryBadge({ summary }: { summary: StepSummary }) {
  if (!summary) return null;
  if (summary.kind === "diff")
    return (
      <span className="cv-step-sum wf-mono">
        <span className="cv-step-add">+{summary.added}</span>{" "}
        <span className="cv-step-del">−{summary.removed}</span>
      </span>
    );
  return <span className="cv-step-sum">{summary.text}</span>;
}

/** One compact, expandable row inside a section. Presentational: the live and disk
 *  wrappers resolve the result and hand the body in as `children`. */
export function ToolStepRow({
  icon,
  label,
  filePath,
  summary,
  isError,
  running,
  hasDetail,
  time,
  children,
}: {
  icon: string;
  label: string;
  /** When the step's primary argument is a file, the label opens it in the editor. */
  filePath: string | null;
  summary: StepSummary;
  isError: boolean;
  running: boolean;
  hasDetail: boolean;
  /** Optional timing chip (live counter while running, frozen once done) shown at the row's
   *  right, before the status glyph. Omitted on disk transcripts / when the pref is off. */
  time?: ReactNode;
  children: ReactNode;
}) {
  // An error is NOT auto-expanded and NOT reddened — it's flagged only by the small alert
  // glyph (cv-step-errico) on the right. The user opens the row on purpose to inspect it.
  const [open, setOpen] = useState(false);
  const toggle = hasDetail ? () => setOpen((o) => !o) : undefined;

  return (
    <div className="cv-step">
      <div
        className="cv-step-h"
        onClick={toggle}
        role={toggle ? "button" : undefined}
        aria-expanded={hasDetail ? open : undefined}
        style={toggle ? { cursor: "pointer" } : undefined}
      >
        <Ico name={icon} className="sm cv-step-ico" />
        {(() => {
          // The whole row toggles the detail; only the file NAME is a clickable mention
          // that opens the file. Split "Edit foo.ts" → "Edit " (toggles) + chip("foo.ts")
          // (the chip stops propagation, so it opens instead of toggling).
          // `stepRow` marks this as the surface the "clickable file paths (Read/Write
          // tools)" pref governs: off → the whole row is a plain expander, and the file
          // is still reachable from the filename in the expanded diff/snippet header.
          const base = filePath ? basename(filePath) : null;
          if (filePath && base && label.endsWith(base)) {
            return (
              <span className="cv-step-t" title={label}>
                {label.slice(0, label.length - base.length)}
                <MentionPathChip path={filePath} display={base} stepRow />
              </span>
            );
          }
          return (
            <span className="cv-step-t" title={label}>
              {label}
            </span>
          );
        })()}
        <SummaryBadge summary={summary} />
        <span className="cv-step-end">
          {time}
          {running ? (
            <span className="cv-step-run" aria-label="running" />
          ) : isError ? (
            <Ico name="alert" className="sm cv-step-errico" />
          ) : (
            <Ico name="check" className="sm cv-step-okico" />
          )}
          {hasDetail ? (
            <span className="cv-step-chev" data-open={open ? "1" : undefined}>
              <Ico name="chev" className="sm" />
            </span>
          ) : null}
        </span>
      </div>
      {open && hasDetail ? <div className="cv-step-b">{children}</div> : null}
    </div>
  );
}

/** The live counter on a RUNNING tool row (its own leaf so the 1 Hz tick doesn't re-render
 *  the row). Ticks once past ~1s (floored) so fast tools don't flash a 0s. */
function RunningToolTime({ session, toolUseId }: { session: string; toolUseId: string }) {
  const startedAt = useToolStartedAt(session, toolUseId);
  const now = useNow(1000);
  if (startedAt == null) return null;
  const elapsed = now - startedAt;
  if (elapsed < 1000) return null;
  return (
    <span className="cv-step-time wf-mono">{fmtDuration(Math.floor(elapsed / 1000) * 1000)}</span>
  );
}

/**
 * A step in the LIVE thread: subscribes to its own result + the session's busy flag.
 * `active` marks a step that belongs to the actively streaming turn; only then may a
 * resultless step show the running spinner. Without it, a resultless step in a PAST
 * turn (e.g. a tool_use left without a tool_result by an interrupt) would falsely spin
 * whenever the session goes busy on a later turn — the session busy flag is global.
 */
export function LiveToolStep({
  session,
  step,
  active = false,
}: {
  session: string;
  step: ToolStep;
  active?: boolean;
}) {
  const result = useToolResult(session, step.id);
  const state = useSessionState(session);
  const showToolTime = useDisplay((s) => s.showToolTime);
  const frozen = useToolDuration(session, step.id);
  const joined: StepResult | undefined = result
    ? { content: result.content, isError: result.isError }
    : undefined;
  const running = active && !result && (state?.busy ?? false);
  const isError = result?.isError ?? false;
  const summary = stepSummary(step.name, step.input, joined ? resultContentText(joined.content) : null);
  // Timing chip: live counter while running, frozen value once the result lands. Gated on
  // the pref; nothing for a resultless past step (no result, not running → unknown).
  const time = !showToolTime ? null : running ? (
    <RunningToolTime session={session} toolUseId={step.id} />
  ) : frozen != null ? (
    <span className="cv-step-time wf-mono">{fmtDuration(frozen)}</span>
  ) : null;
  return (
    <ToolStepRow
      icon={stepIcon(step.name)}
      label={stepLabel(step.name, step.input)}
      filePath={stepFilePath(step.input)}
      summary={summary}
      isError={isError}
      running={running}
      hasDetail={hasDetailFor(step.name, step.input, joined)}
      time={time}
    >
      <ToolDetail name={step.name} input={step.input} result={joined} />
    </ToolStepRow>
  );
}

/** A step in a settled transcript (disk): result handed in, never running. */
export function StaticToolStep({ step, result }: { step: ToolStep; result: StepResult | undefined }) {
  const isError = result?.isError ?? false;
  const summary = stepSummary(step.name, step.input, result ? resultContentText(result.content) : null);
  return (
    <ToolStepRow
      icon={stepIcon(step.name)}
      label={stepLabel(step.name, step.input)}
      filePath={stepFilePath(step.input)}
      summary={summary}
      isError={isError}
      running={false}
      hasDetail={hasDetailFor(step.name, step.input, result)}
    >
      <ToolDetail name={step.name} input={step.input} result={result} />
    </ToolStepRow>
  );
}

/** The collapsible run container. Collapsed by default; auto-opens only while the run is
 *  actively running (`live`) — so its steps appear live with their spinner — then collapses
 *  to the header once the run settles. A contained error does NOT auto-open it: it's flagged
 *  by the small alert glyph on the header (no red title). */
export function ToolSection({
  title,
  errored,
  live,
  children,
}: {
  title: string;
  errored: boolean;
  /** True while this is the actively-running trailing run of the live turn: the section
   *  stays expanded so steps appear live (spinner → result), then collapses on settle. */
  live?: boolean;
  children: ReactNode;
}) {
  // Expanded only while actively running (`live`); collapses once the run settles. An error
  // does NOT auto-expand the section nor redden its title — it's flagged only by the small
  // alert glyph (rendered below off `errored`) on the right.
  const [open, setOpen] = useState(Boolean(live));
  useEffect(() => {
    setOpen(Boolean(live));
  }, [live]);

  return (
    <div className="cv-steps">
      <button
        type="button"
        className="cv-steps-h"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Ico name="layers" className="sm cv-steps-ico" />
        <span className="cv-steps-t">{title}</span>
        {errored ? <Ico name="alert" className="sm cv-steps-errico" /> : null}
        <span className="cv-steps-chev" data-open={open ? "1" : undefined}>
          <Ico name="chev" className="sm" />
        </span>
      </button>
      {open ? <div className="cv-steps-b">{children}</div> : null}
    </div>
  );
}

/**
 * The "clean output" fold: one collapsible block holding a response's intermediate work
 * (tool runs, thinking, in-between prose, sub-agents), so only the response's concluding
 * message stays in clear. Collapsed by default. Shared by the live thread (ConductorThread's
 * CleanBlocks) and the disk transcript (SubAgentTranscript) so the fold looks identical in
 * both — the live side spans the live→settled transition, the disk side is always settled.
 */
export function ClaudeWorkBlock({
  count,
  children,
  foldConv,
  foldKey,
}: {
  count: number;
  children: ReactNode;
  /** When BOTH are set, the open/collapsed state is remembered per conversation across
   *  switches (and app restarts) via the workFold store — the live thread passes them.
   *  Omitted in the sub-agent disk transcript (drill-down), which keeps ephemeral local
   *  state: the clean-output memory applies to the main thread only. */
  foldConv?: string;
  foldKey?: string;
}) {
  const persisted = Boolean(foldConv && foldKey);
  // Hooks run unconditionally (persisted or not); we just pick which state drives the UI.
  const storeOpen = useWorkFold((s) =>
    persisted ? (s.open[foldConv!]?.[foldKey!] ?? false) : false,
  );
  const toggleStore = useWorkFold((s) => s.toggle);
  const [localOpen, setLocalOpen] = useState(false);
  const open = persisted ? storeOpen : localOpen;
  const onToggle = persisted
    ? () => toggleStore(foldConv!, foldKey!)
    : () => setLocalOpen((o) => !o);
  // Backend-neutral label (the fold serves both Claude and Codex conversations),
  // matching the neighbouring labels ("Executed N steps").
  const label = count > 0 ? `Work · ${count} step${count > 1 ? "s" : ""}` : "Work";
  return (
    <div className="cv-work">
      <button type="button" className="cv-work-h" onClick={onToggle} aria-expanded={open}>
        <Ico name="spark" className="sm cv-work-ico" />
        <span className="cv-work-t">{label}</span>
        <span className="cv-work-chev" data-open={open ? "1" : undefined}>
          <Ico name="chev" className="sm" />
        </span>
      </button>
      {open ? <div className="cv-work-b">{children}</div> : null}
    </div>
  );
}
