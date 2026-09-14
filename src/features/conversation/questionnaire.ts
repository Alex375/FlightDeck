// AskUserQuestion questionnaire — the PURE, framework-free half.
//
// Lives apart from QuestionnaireAsk.tsx (the React card) on purpose: the shape
// of a questionnaire and how you turn answers into the tool's updated input is
// needed in three non-React places too — the app-control executor (`answerRequest`,
// so a voice/remote caller can answer a question), the event hub
// (`useGlobalSessionEvents`, to read the question text into an announcement), and
// the Flight Deck state blocks (`questionCount`). Keeping these helpers React-free
// lets all of them import the logic without dragging in the component tree, and
// makes the answer-coercion unit-testable on its own.

import type { JsonValue } from "../../ipc/client";

/** The sentinel option label that reveals a free-text field — "Other…". A
 *  free-text answer is submitted in its place (see `buildQuestionnaireAnswers`). */
export const OTHER = "Other";

export interface QOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QOption[];
}

/** A JsonValue narrowed to a plain object, or `{}` for anything else. */
export function asObject(v: JsonValue): Record<string, JsonValue> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
}

/** Parse the `questions` array out of an AskUserQuestion tool input. Tolerant of
 *  a malformed payload (returns `[]`) — callers must never trap on it. */
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

/** Number of questions in an AskUserQuestion tool input (0 if malformed). */
export function questionCount(input: JsonValue): number {
  return parseQuestions(input).length;
}

/** Normalize a key/label for loose matching: trimmed, lowercased, whitespace collapsed. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Coerce one supplied answer value into the single string the CLI reads: an
 *  array of labels is joined (the multi-select shape the desktop card produces),
 *  anything else is stringified and trimmed. */
function valueToText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean).join(", ");
  return String(v ?? "").trim();
}

/**
 * Resolve a caller-supplied answers payload onto the questionnaire's REAL
 * questions, returning the canonical `{ [questionText]: "answer" }` map the CLI
 * reads (keyed by exact question text; a free-text answer rides in as the
 * question's "Other" choice) plus any entries that matched nothing.
 *
 * A voice/remote caller cannot be trusted to key answers by the exact question
 * text, so we match each supplied entry back to a question by, in order:
 *   1. exact (normalized) question-text match,
 *   2. the short `header` label,
 *   3. for a single-question ask, a lone supplied value lands on that question.
 * An entry that matches nothing is reported in `unmatched` rather than written
 * under an invented key — the CLI would silently ignore an unknown key and lose
 * the answer, so the caller must see the miss instead of a false success.
 *
 * `provided` accepts the loose shapes a model emits: a `{ key: answer }` object,
 * or a bare string/number (the answer to a single-question ask).
 */
export function buildQuestionnaireAnswers(
  input: JsonValue,
  provided: unknown,
): { answers: Record<string, string>; unmatched: string[] } {
  const questions = parseQuestions(input);
  const answers: Record<string, string> = {};
  const unmatched: string[] = [];

  const assign = (q: Question, text: string) => {
    if (text) answers[q.question] = text;
  };

  // A bare value is the answer to a single-question ask.
  if (typeof provided === "string" || typeof provided === "number") {
    const text = valueToText(provided);
    if (questions.length === 1) assign(questions[0], text);
    else if (text) unmatched.push(text);
    return { answers, unmatched };
  }

  const map = asObject((provided ?? null) as JsonValue);
  const keys = Object.keys(map);
  for (const key of keys) {
    const text = valueToText(map[key]);
    if (!text) continue; // an empty value leaves the question unanswered (optional)
    const k = norm(key);
    const target =
      questions.find((q) => norm(q.question) === k) ??
      questions.find((q) => norm(q.header) === k) ??
      // Only fall back to "the one question" when there is genuinely no ambiguity.
      (questions.length === 1 && keys.length === 1 ? questions[0] : undefined);
    if (target) assign(target, text);
    else unmatched.push(key);
  }
  return { answers, unmatched };
}

/**
 * Build the `updated_input` an AskUserQuestion "allow" answer ships back:
 * `{ ...input, answers }` — exactly the shape QuestionnaireAsk submits and the
 * CLI reads. Returns the coerced `answers` and any `unmatched` entries so the
 * caller can refuse an answer that landed on nothing.
 */
export function questionnaireUpdatedInput(
  input: JsonValue,
  provided: unknown,
): { updatedInput: Record<string, JsonValue>; answers: Record<string, string>; unmatched: string[] } {
  const { answers, unmatched } = buildQuestionnaireAnswers(input, provided);
  return { updatedInput: { ...asObject(input), answers }, answers, unmatched };
}
