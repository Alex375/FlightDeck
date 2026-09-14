import { describe, it, expect } from "vitest";
import {
  buildQuestionnaireAnswers,
  parseQuestions,
  questionCount,
  questionnaireUpdatedInput,
} from "./questionnaire";

const single = {
  questions: [
    {
      question: "Which database?",
      header: "DB",
      multiSelect: false,
      options: [{ label: "Postgres" }, { label: "SQLite" }, { label: "Other" }],
    },
  ],
};

const multi = {
  questions: [
    { question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }] },
    {
      question: "Which features?",
      header: "Features",
      multiSelect: true,
      options: [{ label: "Auth" }, { label: "Billing" }],
    },
  ],
};

describe("parseQuestions / questionCount", () => {
  it("reads questions and tolerates a malformed payload", () => {
    expect(questionCount(single)).toBe(1);
    expect(questionCount(multi)).toBe(2);
    expect(parseQuestions({})).toEqual([]);
    expect(parseQuestions({ questions: "nope" })).toEqual([]);
    expect(parseQuestions(null as never)).toEqual([]);
  });
});

describe("buildQuestionnaireAnswers", () => {
  it("a bare string answers a single-question ask (the dictated free-text → its question)", () => {
    const { answers, unmatched } = buildQuestionnaireAnswers(single, "MongoDB, self-hosted");
    expect(answers).toEqual({ "Which database?": "MongoDB, self-hosted" });
    expect(unmatched).toEqual([]);
  });

  it("matches an object keyed by the exact question text", () => {
    const { answers } = buildQuestionnaireAnswers(single, { "Which database?": "SQLite" });
    expect(answers).toEqual({ "Which database?": "SQLite" });
  });

  it("matches loosely — by header, and case/whitespace-insensitively", () => {
    expect(buildQuestionnaireAnswers(single, { DB: "Postgres" }).answers).toEqual({
      "Which database?": "Postgres",
    });
    expect(buildQuestionnaireAnswers(single, { "  which   DATABASE? ": "Postgres" }).answers).toEqual({
      "Which database?": "Postgres",
    });
  });

  it("lands a single lone answer on the sole question even under an unknown key", () => {
    // One question, one key, no text/header match → no ambiguity, so it lands.
    const { answers, unmatched } = buildQuestionnaireAnswers(single, { anything: "Postgres" });
    expect(answers).toEqual({ "Which database?": "Postgres" });
    expect(unmatched).toEqual([]);
  });

  it("joins a multi-select array into the comma string the CLI reads", () => {
    const { answers } = buildQuestionnaireAnswers(multi, { Features: ["Auth", "Billing"] });
    expect(answers).toEqual({ "Which features?": "Auth, Billing" });
  });

  it("reports an unmatched key rather than inventing one (no silent answer loss)", () => {
    const { answers, unmatched } = buildQuestionnaireAnswers(multi, { "Which colour?": "blue" });
    expect(answers).toEqual({});
    expect(unmatched).toEqual(["Which colour?"]);
  });

  it("drops empty values (an unanswered question is optional)", () => {
    const { answers } = buildQuestionnaireAnswers(multi, { "Which database?": "", "Which features?": "Auth" });
    expect(answers).toEqual({ "Which features?": "Auth" });
  });
});

describe("questionnaireUpdatedInput", () => {
  it("spreads the original input and attaches the coerced answers", () => {
    const { updatedInput, answers } = questionnaireUpdatedInput(single, "SQLite");
    expect(answers).toEqual({ "Which database?": "SQLite" });
    // Original questions are preserved; answers added — exactly the desktop card's shape.
    expect(updatedInput.questions).toEqual(single.questions);
    expect(updatedInput.answers).toEqual({ "Which database?": "SQLite" });
  });
});
