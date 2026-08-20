import { describe, it, expect, beforeEach } from "vitest";
import {
  announcementText,
  clearVoiceAnnouncements,
  nextVoiceAnnouncement,
  onVoiceAnnouncement,
  pendingVoiceAnnouncements,
  queueVoiceAnnouncement,
  type FleetAnnouncement,
} from "./announce";
import { clampAutoClose } from "./voicePrefs";

const done = (over: Partial<FleetAnnouncement> = {}): FleetAnnouncement => ({
  kind: "turn_completed",
  conversationId: "c1",
  title: "Alpha",
  outcome: "success",
  lastAssistantText: "The bug is fixed.",
  repository: "proj",
  ...over,
});

beforeEach(() => clearVoiceAnnouncements());

describe("announcementText", () => {
  it("carries the id, title, repo and last reply for a completion", () => {
    const text = announcementText(done());
    expect(text).toContain('"Alpha"');
    expect(text).toContain("repo proj");
    expect(text).toContain("finished its turn");
    expect(text).toContain("The bug is fixed.");
    expect(text).toContain("conversation_id: c1");
  });

  it("says the error loudly and distinguishes permission from question", () => {
    expect(announcementText(done({ outcome: "error" }))).toContain("WITH AN ERROR");
    const perm = announcementText(
      done({ kind: "needs_attention", reason: "permission", tool: "Bash", prompt: null }),
    );
    expect(perm).toContain("permission prompt");
    expect(perm).toContain("Bash");
    const q = announcementText(
      done({ kind: "needs_attention", reason: "question", prompt: "Which port?" }),
    );
    expect(q).toContain("asked a question");
    expect(q).toContain("Which port?");
  });
});

describe("the announcement queue", () => {
  it("delivers FIFO and notifies subscribers", () => {
    let pings = 0;
    const un = onVoiceAnnouncement(() => pings++);
    queueVoiceAnnouncement(done({ conversationId: "a" }));
    queueVoiceAnnouncement(done({ conversationId: "b" }));
    expect(pings).toBe(2);
    expect(nextVoiceAnnouncement()?.conversationId).toBe("a");
    expect(nextVoiceAnnouncement()?.conversationId).toBe("b");
    expect(nextVoiceAnnouncement()).toBeNull();
    un();
  });

  it("caps the backlog to the freshest few — no minute-long monologue after an absence", () => {
    for (let i = 0; i < 12; i++) queueVoiceAnnouncement(done({ conversationId: `c${i}` }));
    expect(pendingVoiceAnnouncements()).toBe(5);
    expect(nextVoiceAnnouncement()?.conversationId).toBe("c7"); // oldest kept = 12-5
  });
});

describe("clampAutoClose", () => {
  it("bounds the silence guard to 10s–300s and defaults nonsense", () => {
    expect(clampAutoClose(3)).toBe(10);
    expect(clampAutoClose(9999)).toBe(300);
    expect(clampAutoClose(42.4)).toBe(42);
    expect(clampAutoClose(Number.NaN)).toBe(25);
  });
});
