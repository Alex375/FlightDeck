import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { JsonValue, PermissionRequestPayload } from "../../ipc/client";
import { useAnswerPermission } from "../../ipc/useCommands";
import { useConversationStore } from "../../store/conversationStore";
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

const ANSWER_PREFIX = "Your questions have been answered:";
const ANSWER_SUFFIX = "You can now continue with these answers in mind.";

/**
 * The CLI does NOT echo answers on the tool input — it returns them in the
 * tool_result as a single string:
 *   Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now …
 * (multi-select answers are the labels joined by ", "). We already know every
 * question's exact text from `input.questions`, so we anchor on `"<question>"="`
 * and read each answer up to the next question's anchor — robust to commas,
 * accents and punctuation inside the answers. Returns {} if the format is not
 * recognized (e.g. a skip notice).
 */
function parseAnsweredResult(content: JsonValue, questions: Question[]): Record<string, string> {
  if (typeof content !== "string") return {};
  const at = content.indexOf(ANSWER_PREFIX);
  if (at < 0) return {};
  let body = content.slice(at + ANSWER_PREFIX.length).trim();
  const sfx = body.lastIndexOf(ANSWER_SUFFIX);
  if (sfx >= 0) body = body.slice(0, sfx).trim();
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
 * Read-only recap of an answered questionnaire, shown when the AskUserQuestion
 * tool card is expanded in the thread. Renders each question with its chosen
 * answer(s) as chips — a human view of exactly what was sent back to Claude. The
 * answers live on the tool input (`input.answers`, keyed by question text, the
 * same shape the official extension reads). If they are absent, we fall back to
 * the raw tool_result text so nothing is ever hidden.
 */
export function QuestionnaireSummary({
  input,
  result,
}: {
  input: JsonValue;
  result?: JsonValue;
}) {
  const questions = parseQuestions(input);
  if (questions.length === 0) {
    return <ToolResultBody content={result ?? null} isError={false} />;
  }

  // Answers come from the tool_result string (CLI format); a future CLI that
  // echoes them on the input is honored first.
  const fromInput = asObject(asObject(input).answers);
  const answers = Object.keys(fromInput).length > 0 ? fromInput : parseAnsweredResult(result ?? null, questions);

  const resultStr = typeof result === "string" ? result : "";
  const recognized = resultStr.includes(ANSWER_PREFIX) || /skip|ignor/i.test(resultStr);
  // Unknown result shape and nothing parsed → show the raw text rather than
  // mislabelling every question "Not answered".
  if (Object.keys(answers).length === 0 && resultStr && !recognized) {
    return <ToolResultBody content={result ?? null} isError={false} />;
  }

  return (
    <div className="cv-qs">
      {questions.map((q, i) => {
        const raw = answers[q.question];
        const answer = typeof raw === "string" ? raw.trim() : "";
        // Multi-select answers are a comma-joined list → one chip each; a single
        // answer (possibly free text with commas) stays whole.
        const chips = answer ? (q.multiSelect ? answer.split(", ").filter(Boolean) : [answer]) : [];
        return (
          <div key={i} className="cv-qs-row">
            <div className="cv-qs-q">{q.question}</div>
            {chips.length > 0 ? (
              <div className="cv-qs-a">
                {chips.map((c, j) => (
                  <span key={j} className="cv-qs-chip">
                    {c}
                  </span>
                ))}
              </div>
            ) : (
              <div className="cv-qs-a empty">Not answered</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Inline question card (transcript flow) --------------------------------
// The flow-anchored face of an AskUserQuestion: the run-breaking `question`
// segment (see toolGroup.ts) renders THIS card instead of an anonymous
// "Question" step row lost inside a collapsed run. While the ask is pending
// the interactive questionnaire still lives in the bottom AskTurn — this card
// marks the exchange in place and shows the chosen answers once the
// tool_result lands, so a settled round reads as question → decision.

/** Parse the CLI's answer recap — `"Question"="Answer"` pairs — from the tool_result text. */
export function parseAnswerPairs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/"([^"]+)"="([^"]*)"/g)) out.set(m[1], m[2]);
  return out;
}

export function QuestionCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const questions = useMemo(() => parseQuestions(input), [input]);
  const result = useConversationStore((s) => s.sessions[session]?.toolResults[toolUseId]);
  const answers = useMemo(
    () => (result ? parseAnswerPairs(resultContentText(result.content) ?? "") : null),
    [result],
  );
  if (questions.length === 0) return null;
  return (
    <div className="cv-q cv-qcard">
      {questions.map((q, i) => {
        const a = answers?.get(q.question) ?? null;
        return (
          <div key={i} className="cv-qa">
            <span className={`cv-q-tab${a ? " is-done" : ""}`}>
              <Ico name="form" className="sm" />
              {q.header}
            </span>
            <div className="cv-qa-body">
              <div className="cv-qa-question">{q.question}</div>
              {a ? (
                <div className="cv-qa-answer">
                  <Ico name="check" className="sm" />
                  <span>{a}</span>
                </div>
              ) : (
                <div className="cv-qa-answer cv-qa-pending">
                  {result
                    ? result.isError
                      ? "Question declined or interrupted."
                      : "Free-form answer — see the thread."
                    : "Waiting for the answer…"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
