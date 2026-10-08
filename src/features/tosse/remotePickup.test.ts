// The check behind the "plugin assumed on" decision for a server's folder: once the new
// session reports the skills it loaded, a name we sent that is not among them is SAID —
// otherwise a wrong assumption looks exactly like a pickup that worked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationStore } from "../../store/conversationStore";
import { ASSUMED_PICKUP, PICKUP_CHECK_MS, missingPickupMessage, watchSentPickup } from "./remotePickup";

/** The session `convId` reports its skills, as `system/init` would land in the store. */
function report(convId: string, skills: string[] | null) {
  useConversationStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [convId]: { ...s.sessions[convId], state: { ...s.sessions[convId]?.state, loaded_skills: skills } },
    } as typeof s.sessions,
  }));
}

afterEach(() => {
  vi.useRealTimers();
  useConversationStore.setState({ sessions: {} });
});

describe("watchSentPickup", () => {
  it("calls back once when the first report lacks the name sent", () => {
    const onMissing = vi.fn();
    watchSentPickup("w1", ASSUMED_PICKUP, onMissing);

    report("w1", null); // spawned, no turn yet: nothing to conclude
    expect(onMissing).not.toHaveBeenCalled();
    report("w1", ["simplify"]);
    report("w1", ["simplify"]);

    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the report has it", () => {
    const onMissing = vi.fn();
    watchSentPickup("w2", ASSUMED_PICKUP, onMissing);

    report("w2", ["tosse-workflow:pickup"]);
    report("w2", []); // a later reload's list is not this check's business

    expect(onMissing).not.toHaveBeenCalled();
  });

  it("settles on a report that already arrived", () => {
    report("w3", ["simplify"]);
    const onMissing = vi.fn();

    watchSentPickup("w3", ASSUMED_PICKUP, onMissing);

    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  // A session that never speaks within the window leaves nothing to conclude.
  it("stands down after the watch window", () => {
    vi.useFakeTimers();
    const onMissing = vi.fn();
    watchSentPickup("w4", ASSUMED_PICKUP, onMissing);

    vi.advanceTimersByTime(PICKUP_CHECK_MS);
    report("w4", ["simplify"]);

    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe("missingPickupMessage", () => {
  it("names the command, the machine and both ways out", () => {
    const m = missingPickupMessage(ASSUMED_PICKUP, "Base");
    expect(m).toContain("« /tosse-workflow:pickup »");
    expect(m).toContain("on Base");
    expect(m).toContain("Enable the tosse-workflow plugin");
    expect(m).toContain("start the task by hand");
  });
});
