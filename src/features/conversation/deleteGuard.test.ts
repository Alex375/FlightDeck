// When deleting a conversation asks first.
//
// The friction-free delete is deliberate, so every added question has to be justified —
// and every SKIPPED question has to be safe. Both directions are locked here.

import { describe, expect, it } from "vitest";
import { deleteReason } from "./deleteGuard";

const base = { busy: false, taskStatus: null, warnOnLinkedTask: true };

describe("deleteReason", () => {
  it("keeps the one-click delete for an idle, unlinked conversation", () => {
    expect(deleteReason(base)).toBeNull();
  });

  it("asks about a live run", () => {
    expect(deleteReason({ ...base, busy: true })).toBe("running");
  });

  it("asks about a task being worked on or waiting to be read", () => {
    expect(deleteReason({ ...base, taskStatus: "En cours" })).toBe("linkedTask");
    expect(deleteReason({ ...base, taskStatus: "Review" })).toBe("linkedTask");
  });

  // A task nobody is waiting on must NOT ask: a dialog that appears for every deletion is
  // one the user learns to dismiss without reading, which costs the warnings that matter.
  it("stays silent for a task that is not live", () => {
    for (const status of ["À faire", "Backlog", "En attente", "Fait", "Archivé"]) {
      expect(deleteReason({ ...base, taskStatus: status })).toBeNull();
    }
  });

  it("merges the two reasons into one question", () => {
    expect(deleteReason({ ...base, busy: true, taskStatus: "En cours" })).toBe("both");
  });

  // The preference governs the TOSSE side only. Switching it off must not disarm the
  // guard that exists to stop a live session from being killed by a stray click.
  it("lets the preference silence the task warning, never the running one", () => {
    expect(deleteReason({ ...base, taskStatus: "En cours", warnOnLinkedTask: false })).toBeNull();
    expect(
      deleteReason({ busy: true, taskStatus: "En cours", warnOnLinkedTask: false }),
    ).toBe("running");
  });
});
