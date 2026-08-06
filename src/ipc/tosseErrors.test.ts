// The front half of the "is this session dead?" contract with `src-tauri/src/tosse/mod.rs`.
//
// Every string below is the REAL output of `TosseError::to_string()` — that is the whole
// point: these fixtures are what the Rust side actually sends, so a reword there breaks
// this test as well as its own (`session_gone_errors_keep_the_wording_the_front_matches_on`).
// Nothing here is invented wording.

import { describe, expect, it } from "vitest";
import { isSessionGone, SESSION_GONE_MARKERS } from "./tosseErrors";

describe("isSessionGone", () => {
  // `TosseError::NotConnected` — nothing stored at all.
  it("recognises a missing session", () => {
    expect(isSessionGone(new Error("not connected to TOSSE"))).toBe(true);
  });

  // `TosseError::Denied(SESSION_REVOKED_REASON)`, wrapped by Display.
  it("recognises a revoked or expired grant", () => {
    expect(
      isSessionGone(
        new Error(
          "authorization refused: your TOSSE session expired or was revoked — connect again",
        ),
      ),
    ).toBe(true);
  });

  // ⚠️ The direction that costs the most when it is wrong: reading an outage as a sign-out
  // withdraws the whole view and invites a sign-in the user does not need, while the stored
  // session is still valid. These are the real messages of the transient variants.
  it("leaves a transient failure alone", () => {
    for (const message of [
      "TOSSE is unreachable: error sending request for url (https://…): dns error",
      "TOSSE answered HTTP 502: Bad Gateway",
      "TOSSE answered HTTP 429: Too many requests",
      "unexpected response from TOSSE: the briefing carried no `projects` list",
      "could not access the Keychain: security exit 51",
      "no local port available for the sign-in callback — 47890: Address already in use",
    ]) {
      expect(isSessionGone(new Error(message)), message).toBe(false);
    }
  });

  it("says nothing about an empty or non-Error failure", () => {
    expect(isSessionGone(undefined)).toBe(false);
    expect(isSessionGone(null)).toBe(false);
    expect(isSessionGone(new Error(""))).toBe(false);
    // A bare string rejection still reads (some call sites throw those).
    expect(isSessionGone("not connected to TOSSE")).toBe(true);
  });

  it("keeps the markers lower-case, since the match folds case", () => {
    // A marker written with capitals would never match `message.toLowerCase()` — a silent
    // no-op, and exactly the kind of break this whole module exists to make loud.
    for (const marker of SESSION_GONE_MARKERS) {
      expect(marker).toBe(marker.toLowerCase());
    }
  });
});
