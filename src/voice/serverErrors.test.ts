import { describe, it, expect } from "vitest";
import {
  SETTING_EVENT_PREFIX,
  SETTING_REJECTED_NOTE,
  UNEXPECTED_ERROR_MESSAGE,
  classifyServerError,
  isBenignRace,
} from "./serverErrors";

// The exact error Armand saw, word for word, response id included.
const ACTIVE_RESPONSE = {
  type: "invalid_request_error",
  code: "conversation_already_has_active_response",
  message:
    "Conversation already has an active response in progress: resp_ENz8mbt061hUCNaoQzB5k. Wait until the response is finished before creating a new one.",
  event_id: null,
};

describe("classifyServerError", () => {
  // The bug: this error was shown as "rejected a setting". It came from a
  // response.create; a session.update never creates a response.
  it("does not blame a setting for the active-response race", () => {
    const pending = new Set([`${SETTING_EVENT_PREFIX}1`]);
    expect(classifyServerError(ACTIVE_RESPONSE, pending)).toEqual({ kind: "benign" });
  });

  it("attributes an error to a setting only when it echoes that setting's event id", () => {
    const id = `${SETTING_EVENT_PREFIX}7`;
    const refused = { code: "invalid_value", message: "bad eagerness", event_id: id };
    expect(classifyServerError(refused, new Set([id]))).toEqual({ kind: "setting-rejected" });
    // Same error, but not one of ours: never guessed to be a setting.
    expect(classifyServerError(refused, new Set())).toEqual({ kind: "unexpected" });
  });

  it("treats anything unrecognised as unexpected", () => {
    expect(classifyServerError({ code: "server_error", message: "boom" }, new Set())).toEqual({
      kind: "unexpected",
    });
    expect(classifyServerError(undefined, new Set())).toEqual({ kind: "unexpected" });
  });
});

describe("isBenignRace", () => {
  // The docs do not publish this error's code, so the message has to be enough.
  it("recognises the race by its message when the code is missing", () => {
    expect(isBenignRace({ message: ACTIVE_RESPONSE.message })).toBe(true);
    expect(isBenignRace({ message: "Something else entirely" })).toBe(false);
    expect(isBenignRace(undefined)).toBe(false);
  });
});

describe("what the user is shown", () => {
  // The requirement that caused this module: no technical detail on screen.
  it("never contains ids or server wording", () => {
    for (const text of [SETTING_REJECTED_NOTE, UNEXPECTED_ERROR_MESSAGE]) {
      expect(text).not.toMatch(/resp_|event_|invalid_request|conversation_already/i);
    }
  });
});
