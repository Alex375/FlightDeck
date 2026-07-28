import { describe, it, expect } from "vitest";
import { parseAnsweredResult, resultRecognized, answerChips, parseQuestions } from "./QuestionnaireAsk";

// Build a questions array the same way the card does (via parseQuestions), so the tests exercise
// the real shape rather than a hand-rolled one.
const Q = (question: string, multiSelect = false) => ({ question, header: "H", multiSelect, options: [] });
const qs = (...items: ReturnType<typeof Q>[]) => parseQuestions({ questions: items });

describe("parseAnsweredResult — CLI wording drift", () => {
  it("parses the CURRENT wording ('The user answered: … Read the answers carefully — …')", () => {
    const questions = qs(Q("What is your favorite language?"), Q("How do you take your coffee?"));
    const text =
      'The user answered: "What is your favorite language?"="Python", "How do you take your coffee?"="Black". ' +
      "Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.";
    expect(parseAnsweredResult(text, questions)).toEqual({
      "What is your favorite language?": "Python",
      "How do you take your coffee?": "Black",
    });
  });

  it("still parses the LEGACY wording ('Your questions have been answered: … You can now continue …')", () => {
    const questions = qs(Q("Q1?"), Q("Q2?"));
    const text =
      'Your questions have been answered: "Q1?"="A1", "Q2?"="A2". You can now continue with these answers in mind.';
    expect(parseAnsweredResult(text, questions)).toEqual({ "Q1?": "A1", "Q2?": "A2" });
  });

  it("keeps a multi-select answer as its ', '-joined label list", () => {
    const questions = qs(Q("Pick tools", true));
    const text = 'The user answered: "Pick tools"="JWT, OAuth". Read the answers carefully — and follow what they actually say.';
    expect(parseAnsweredResult(text, questions)).toEqual({ "Pick tools": "JWT, OAuth" });
  });

  it("keeps a free-text answer that contains a comma whole (anchored parse, not a naive regex)", () => {
    const questions = qs(Q("Scope?"));
    const text = 'The user answered: "Scope?"="Cleanup, then docs". Read the answers carefully — and follow what they actually say.';
    expect(parseAnsweredResult(text, questions)).toEqual({ "Scope?": "Cleanup, then docs" });
  });

  it("returns {} for an unknown format (a future wording we don't parse yet)", () => {
    const questions = qs(Q("Q1?"));
    expect(parseAnsweredResult('Totally new phrasing: Q1? -> A1', questions)).toEqual({});
  });

  it("returns {} for a skip notice", () => {
    const questions = qs(Q("Q1?"));
    expect(parseAnsweredResult("The user skipped the questionnaire without answering.", questions)).toEqual({});
  });
});

describe("resultRecognized — drives the raw-text fallback (zero silent error)", () => {
  it("accepts both wordings and skip/ignore notices", () => {
    expect(resultRecognized('The user answered: "Q"="A".')).toBe(true);
    expect(resultRecognized('Your questions have been answered: "Q"="A".')).toBe(true);
    expect(resultRecognized("The user skipped the questionnaire without answering.")).toBe(true);
    expect(resultRecognized("L'utilisateur a ignoré le questionnaire sans répondre.")).toBe(true);
  });

  it("rejects an unrecognized payload → the card shows it raw instead of mislabelling", () => {
    expect(resultRecognized("some raw unrelated payload with no known marker")).toBe(false);
  });
});

describe("answerChips — one chip per selection, free text stays whole", () => {
  it("splits a multi-select answer into one chip per label", () => {
    expect(answerChips("JWT, OAuth", true)).toEqual(["JWT", "OAuth"]);
  });

  it("keeps a single-select answer whole even when it contains commas (free-text 'Other')", () => {
    expect(answerChips("Cleanup, then docs", false)).toEqual(["Cleanup, then docs"]);
  });

  it("returns [] for an empty / whitespace answer", () => {
    expect(answerChips("", true)).toEqual([]);
    expect(answerChips("   ", false)).toEqual([]);
  });
});
