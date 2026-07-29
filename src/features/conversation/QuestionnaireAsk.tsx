import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { JsonValue, PermissionRequestPayload } from "../../ipc/client";
import { useAnswerPermission } from "../../ipc/useCommands";
import { useToolResult } from "../../store/conversationStore";
import { Ico } from "../../ui/kit";
import { AiAvatar } from "./ConvMark";
import { resultContentText } from "./resultText";
import { ToolResultBody } from "./ToolResultBody";

// AskUserQuestion questionnaire — reproduces the Claude Code terminal UX:
// you move through the questions one at a time with an explicit "Next
// question" button (NO auto-advance), questions are optional (you may skip any),
// and after the last one you land on a dedicated recap/"Send" step where a
// single "Send" button submits. A lone question skips the recap and shows
// "Send" directly. The answer is shipped back as the tool's updated input —
// `{ ...input, answers: { [question]: "label1, label2" } }` — exactly the shape
// the CLI reads (Other replaced by its text; unanswered questions omitted).

const OTHER = "Other";

interface QOption {
  label: string;
  description?: string;
}
interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QOption[];
}

export function asObject(v: JsonValue): Record<string, JsonValue> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
}

export function parseQuestions(input: JsonValue): Question[] {
  const raw = asObject(input).questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q, i) => {
    const o = asObject(q);
    const opts = Array.isArray(o.options) ? o.options : [];
    return {
      question: typeof o.question === "string" ? o.question : `Question ${i + 1}`,
      header: typeof o.header === "string" && o.header ? o.header : `Q${i + 1}`,
      multiSelect: o.multiSelect === true,
      options: opts.map((op) => {
        const oo = asObject(op);
        return {
          label: typeof oo.label === "string" ? oo.label : String(op),
          description: typeof oo.description === "string" ? oo.description : undefined,
        };
      }),
    };
  });
}

export function QuestionnaireAsk({
  session,
  request,
}: {
  session: string;
  request: PermissionRequestPayload;
}) {
  const answer = useAnswerPermission(session);
  const questions = useMemo(() => parseQuestions(request.input), [request.input]);
  const multi = questions.length > 1;
  // Step index: 0..n-1 are questions; step n is the recap/submit page (multi only).
  const recapStep = questions.length;
  const maxStep = multi ? recapStep : 0;

  const [cur, setCur] = useState(0);
  // Selected option labels per question index (may include OTHER).
  const [sel, setSel] = useState<Record<number, Set<string>>>({});
  // Free-text typed for the OTHER option, per question index.
  const [other, setOther] = useState<Record<number, string>>({});
  const otherRef = useRef<HTMLInputElement>(null);

  if (questions.length === 0) {
    // Malformed payload: never trap the session — let the user skip.
    return (
      <AskShell session={session}>
        <div className="cv-q">
          <div className="cv-q-head">
            <Ico name="form" className="sm" />
            <span>Empty or unreadable questionnaire.</span>
          </div>
          <div className="cv-q-foot">
            <button
              className="wf-btn ghost sm"
              onClick={() =>
                answer.mutate({
                  requestId: request.request_id,
                  decision: { behavior: "deny", message: "Questionnaire unreadable, skipped." },
                })
              }
            >
              Skip
            </button>
            <span />
          </div>
        </div>
      </AskShell>
    );
  }

  const onRecap = multi && cur >= recapStep;
  const q = questions[Math.min(cur, questions.length - 1)];
  const isSel = (label: string) => sel[cur]?.has(label) ?? false;

  // The effective answer string for question `i`: selected labels joined by ", ",
  // with OTHER swapped for its typed text (dropped if empty).
  const answerFor = (i: number): string => {
    const labels = Array.from(sel[i] ?? []);
    const text = (other[i] ?? "").trim();
    const parts = labels.flatMap((l) => (l === OTHER ? (text ? [text] : []) : [l]));
    return parts.join(", ");
  };
  const answered = (i: number) => answerFor(i) !== "";

  const toggle = (label: string) => {
    setSel((prev) => {
      const next = { ...prev };
      const set = new Set(next[cur] ?? []);
      if (q.multiSelect) {
        if (set.has(label)) set.delete(label);
        else set.add(label);
      } else {
        set.clear();
        set.add(label);
      }
      next[cur] = set;
      return next;
    });
    // Reveal + focus the free-text field when Other is picked. No auto-advance:
    // the user moves on with the explicit "Next question" button.
    if (label === OTHER) setTimeout(() => otherRef.current?.focus(), 0);
  };

  const goNext = () => setCur((c) => Math.min(c + 1, maxStep));

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((qq, i) => {
      const a = answerFor(i);
      if (a) answers[qq.question] = a; // skip unanswered — they are optional
    });
    answer.mutate({
      requestId: request.request_id,
      decision: { behavior: "allow", updated_input: { ...asObject(request.input), answers } },
    });
  };

  const skip = () =>
    answer.mutate({
      requestId: request.request_id,
      decision: {
        behavior: "deny",
        message: "The user skipped the questionnaire without answering.",
      },
    });

  // Bottom-right action: submit on a lone question or on the recap step;
  // otherwise advance to the next step.
  const rightIsSubmit = !multi || onRecap;
  const rightLabel = rightIsSubmit
    ? "Send"
    : cur < questions.length - 1
      ? "Next question"
      : "Finish";
  const onRight = rightIsSubmit ? submit : goNext;

  const onKeyNav = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" && cur > 0) {
      setCur((c) => c - 1);
      e.stopPropagation();
    } else if (e.key === "ArrowRight" && cur < maxStep) {
      setCur((c) => c + 1);
      e.stopPropagation();
    }
  };

  const renderOption = (label: string, description?: string) => {
    const selected = isSel(label);
    return (
      <div
        key={label}
        className={"cv-q-opt" + (selected ? " is-sel" : "")}
        role={q.multiSelect ? "checkbox" : "radio"}
        aria-checked={selected}
        tabIndex={0}
        onClick={() => toggle(label)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(label);
          }
        }}
      >
        <span className={"cv-q-box" + (q.multiSelect ? " cb" : " rd") + (selected ? " on" : "")}>
          {selected && (q.multiSelect ? <Ico name="check" className="sm" /> : <span className="cv-q-dot" />)}
        </span>
        <span className="cv-q-opt-main">
          <span className="cv-q-opt-label">{label === OTHER ? "Other…" : label}</span>
          {description && <span className="cv-q-opt-desc">{description}</span>}
          {label === OTHER && selected && (
            <input
              ref={otherRef}
              className="cv-q-other"
              placeholder="Type your answer…"
              value={other[cur] ?? ""}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                // Keep typing keys local; only block thread-level shortcuts.
                if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
              }}
              onChange={(e) => setOther((prev) => ({ ...prev, [cur]: e.target.value }))}
            />
          )}
        </span>
      </div>
    );
  };

  return (
    <AskShell session={session}>
      <div className="cv-q" onKeyDown={onKeyNav}>
        {/* Tabs: one per question (its header) + a final "Send" step. */}
        {multi && (
          <div className="cv-q-tabs">
            {questions.map((qq, i) => (
              <button
                key={i}
                className={"cv-q-tab" + (i === cur ? " is-active" : "") + (answered(i) ? " is-done" : "")}
                onClick={() => setCur(i)}
              >
                {answered(i) && <Ico name="check" className="sm" />}
                {qq.header}
              </button>
            ))}
            <button
              className={"cv-q-tab" + (onRecap ? " is-active" : "")}
              onClick={() => setCur(recapStep)}
            >
              <Ico name="send" className="sm" />
              Send
            </button>
          </div>
        )}

        {onRecap ? (
          <div className="cv-q-recap">
            <div className="cv-q-recap-h">
              <Ico name="check" className="sm" />
              Ready to send — check your answers
            </div>
            {questions.map((qq, i) => (
              <button key={i} className="cv-q-recap-row" onClick={() => setCur(i)} title="Edit">
                <span className="cv-q-recap-q">{qq.header}</span>
                <span className={"cv-q-recap-a" + (answered(i) ? "" : " empty")}>
                  {answered(i) ? answerFor(i) : "Not answered"}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="cv-q-head">
              <Ico name="form" className="sm" />
              <span>{q.question}</span>
              {multi && (
                <span className="cv-q-count">
                  {cur + 1} / {questions.length}
                </span>
              )}
            </div>
            <div className="cv-q-opts">
              {q.options.map((o) => renderOption(o.label, o.description))}
              {renderOption(OTHER)}
            </div>
          </>
        )}

        <div className="cv-q-foot">
          <button className="wf-btn ghost sm" onClick={skip}>
            Skip
          </button>
          <button className="wf-btn prim sm" onClick={onRight}>
            <Ico name={rightIsSubmit ? "check" : "arrow"} className="sm" />
            {rightLabel}
          </button>
        </div>
      </div>
    </AskShell>
  );
}

/** Assistant-side bubble wrapper, shared with the rest of the thread. Backend-aware avatar
 *  so a Codex questionnaire shows the OpenAI mark, not Claude's. */
function AskShell({ session, children }: { session: string; children: ReactNode }) {
  return (
    <div className="cv-msg cv-ai">
      <AiAvatar session={session} />
      <div className="cv-aibody">{children}</div>
    </div>
  );
}

/** Number of questions in an AskUserQuestion tool input (0 if malformed). */
export function questionCount(input: JsonValue): number {
  return parseQuestions(input).length;
}

// The CLI returns the chosen answers in the tool_result as a single string of
// `"<question>"="<answer>"` pairs. The WRAPPING sentence has changed across
// `claude` binary versions and BOTH wordings still occur in the wild (verified
// on disk — even within a single session), so we anchor on a SET of known
// prefixes/suffixes rather than one:
//   - current : `The user answered: … Read the answers carefully — …`
//   - legacy  : `Your questions have been answered: … You can now continue …`
// The pair list between them is identical in both. ⚠️ Keep BOTH forever: old
// transcripts reload with the legacy wording, new sessions emit the current one.
const ANSWER_PREFIXES = ["The user answered:", "Your questions have been answered:"];
const ANSWER_SUFFIXES = [
  "Read the answers carefully",
  "You can now continue with these answers in mind.",
];

/**
 * True when the result text is a shape we understand: a recognized answer recap
 * OR a skip/ignore notice (even if a given question ends up unanswered). A
 * non-empty result that is NOT recognized (e.g. a future CLI wording we don't
 * parse yet) must never be mislabelled "Not answered" — the card shows it RAW
 * instead, so an answer is never silently hidden.
 */
export function resultRecognized(text: string): boolean {
  return ANSWER_PREFIXES.some((p) => text.includes(p)) || /skip|ignor/i.test(text);
}

/**
 * Parse the `"<question>"="<answer>"` recap from the tool_result text (already
 * flattened to a string via resultContentText). We know each question's exact
 * text from `input.questions`, so we anchor on `"<question>"="` and read each
 * answer up to the next question's anchor — robust to commas, quotes, accents
 * and punctuation INSIDE an answer (a naive `"q"="a"` regex truncates a
 * free-text "Other" answer that contains a `"`). Returns {} when no known prefix
 * is present (unknown format / skip notice).
 */
export function parseAnsweredResult(text: string, questions: Question[]): Record<string, string> {
  // First matching prefix wins (both wordings never coexist in one result).
  let at = -1;
  let plen = 0;
  for (const p of ANSWER_PREFIXES) {
    const i = text.indexOf(p);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      plen = p.length;
    }
  }
  if (at < 0) return {};
  let body = text.slice(at + plen).trim();
  for (const s of ANSWER_SUFFIXES) {
    const sfx = body.lastIndexOf(s);
    if (sfx >= 0) {
      body = body.slice(0, sfx).trim();
      break;
    }
  }
  if (body.endsWith(".")) body = body.slice(0, -1).trim();

  const out: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const anchor = `"${questions[i].question}"="`;
    const start = body.indexOf(anchor);
    if (start < 0) continue;
    const valStart = start + anchor.length;
    // End the value at the next question's anchor (`, "<next>"="`), if any.
    let end = body.length;
    for (let j = i + 1; j < questions.length; j++) {
      const next = body.indexOf(`, "${questions[j].question}"="`, valStart);
      if (next >= 0) {
        end = next;
        break;
      }
    }
    let value = body.slice(valStart, end);
    if (value.endsWith('"')) value = value.slice(0, -1); // drop the closing quote
    out[questions[i].question] = value;
  }
  return out;
}

/**
 * Split a stored answer into chips: a multi-select answer is a ", "-joined list
 * of labels → one chip each; a single answer (possibly a free-text "Other" that
 * contains commas) stays whole. Mirrors the CLI's join and the historical recap.
 */
export function answerChips(answer: string, multiSelect: boolean): string[] {
  const a = answer.trim();
  if (!a) return [];
  return multiSelect ? a.split(", ").filter(Boolean) : [a];
}

// ---- Unified answered-questionnaire card -----------------------------------
// The single settled face of an AskUserQuestion. Two surfaces render it: the main
// thread flow (via the `QuestionCard` wrapper below, reading the live store) and
// settled sub-agent transcripts (SubAgentTranscript, results handed in from disk)
// — both peel `AskUserQuestion` into its own
// `question` segment, so it never reaches a tool row. ToolDetail keeps a branch
// for it as a fall-through safety net only (unreachable while groupBlocks peels
// the tool; kept so a step row could never render an ask as raw JSON). It
// renders each question with its chosen answer(s) as chips — a human view of
// exactly what was sent back to Claude. Answers come from `input.answers` first
// (the shape the official extension reads), else parsed from the tool_result.
// ⚠️ Zero silent error: when the result is present but in a shape we DON'T
// recognize (e.g. a future CLI wording), the RAW text is shown under the
// questions so an answer is never hidden — that exact failure mode (a changed
// CLI wording) is what once made the whole recap read as raw text.

/** Answers for a card: `input.answers` (keyed by question text) wins; else parse the result. */
function resolveAnswers(input: JsonValue, resultText: string, questions: Question[]): Record<string, string> {
  const fromInput = asObject(asObject(input).answers);
  if (Object.keys(fromInput).length > 0) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fromInput)) if (typeof v === "string") out[k] = v;
    return out;
  }
  return parseAnsweredResult(resultText, questions);
}

/** Label for a question left without a parsed answer (chips empty) when NOT in the raw-fallback
 *  case: pending (no result yet), skipped, declined/interrupted, or an optional blank answer. */
function emptyStateLabel(result: { isError: boolean } | undefined, resultText: string): string {
  if (!result) return "Waiting for the answer…";
  if (/skip|ignor/i.test(resultText)) return "Not answered";
  if (result.isError) return "Question declined or interrupted.";
  return "Not answered";
}

export function QuestionnaireCard({
  input,
  result,
}: {
  input: JsonValue;
  result?: { content: JsonValue; isError: boolean };
}) {
  const questions = parseQuestions(input);
  const resultText = result ? resultContentText(result.content) ?? "" : "";
  if (questions.length === 0)
    // Malformed input: never hide the payload — show the raw result if there is one.
    return result ? <ToolResultBody content={result.content} isError={result.isError} /> : null;

  const answers = resolveAnswers(input, resultText, questions);
  const anyAnswer = questions.some((q) => (answers[q.question] ?? "").trim() !== "");
  // Present, non-empty result that yielded no answers and isn't a shape we know → show it RAW
  // (once, under the questions) rather than mislabelling every question "Not answered".
  const rawFallback = !anyAnswer && !!result && resultText.trim() !== "" && !resultRecognized(resultText);

  return (
    <div className="cv-q cv-qcard">
      {questions.map((q, i) => {
        const chips = answerChips(answers[q.question] ?? "", q.multiSelect);
        return (
          <div key={i} className="cv-qa">
            <span className={`cv-qa-hdr${chips.length ? " is-done" : ""}`}>
              <Ico name="form" className="sm" />
              {q.header}
            </span>
            <div className="cv-qa-body">
              <div className="cv-qa-question">{q.question}</div>
              {chips.length > 0 ? (
                <div className="cv-qa-answer">
                  <Ico name="check" className="sm" />
                  <div className="cv-qa-chips">
                    {chips.map((c, j) => (
                      <span key={j} className="cv-qa-chip">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              ) : rawFallback ? null : (
                <div className="cv-qa-answer cv-qa-pending">{emptyStateLabel(result, resultText)}</div>
              )}
            </div>
          </div>
        );
      })}
      {rawFallback && (
        <div className="cv-qa-raw">
          <ToolResultBody content={result!.content} isError={result!.isError} />
        </div>
      )}
    </div>
  );
}

// ---- Inline question card (live main-thread flow) --------------------------
// The flow-anchored face of an AskUserQuestion: the run-breaking `question`
// segment (see toolGroup.ts) renders THIS card instead of an anonymous
// "Question" step row lost inside a collapsed run. While the ask is pending the
// interactive questionnaire still lives in the bottom AskTurn — this thin
// wrapper just reads the tool_result from the store by id (through the shared
// `useToolResult` selector) and delegates to the shared QuestionnaireCard, so the
// thread and sub-agent-transcript surfaces stay identical.
export function QuestionCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const result = useToolResult(session, toolUseId);
  return <QuestionnaireCard input={input} result={result} />;
}
