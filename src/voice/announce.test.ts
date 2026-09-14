import { describe, it, expect, beforeEach } from "vitest";
import {
  announcementText,
  attentionFields,
  clearVoiceAnnouncements,
  nextVoiceAnnouncement,
  onVoiceAnnouncement,
  pendingIsQuestion,
  pendingVoiceAnnouncements,
  queueVoiceAnnouncement,
  type FleetAnnouncement,
} from "./announce";
import { clampAutoClose } from "./voicePrefs";

const askInput = {
  questions: [
    {
      question: "Which port?",
      header: "Port",
      multiSelect: false,
      options: [{ label: "3000" }, { label: "8080" }, { label: "Other" }],
    },
  ],
};

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
    expect(q).toContain("asked the user a question");
    expect(q).toContain("Which port?");
    // The regression this fixes: a question must never be announced as a permission.
    expect(q).toContain("NOT a permission prompt");
    expect(q).toContain("get_pending_request");
  });
});

describe("attentionFields", () => {
  it("classifies an AskUserQuestion as a QUESTION — never a permission, no tool, reads the question", () => {
    const f = attentionFields({
      tool_name: "AskUserQuestion",
      input: askInput,
      title: "Question",
      description: null,
    });
    expect(f.reason).toBe("question");
    expect(f.tool).toBeNull();
    expect(f.prompt).toBe("Which port?");
  });

  it("classifies a real tool as a permission prompt, carrying its title/description", () => {
    const f = attentionFields({
      tool_name: "Bash",
      input: { command: "rm -rf /tmp/x" },
      title: "Run a command",
      description: "delete scratch",
    });
    expect(f.reason).toBe("permission");
    expect(f.tool).toBe("Bash");
    expect(f.prompt).toBe("Run a command");
  });

  it("treats nothing-pending as a question (a settled open question), no tool", () => {
    const f = attentionFields(null);
    expect(f.reason).toBe("question");
    expect(f.tool).toBeNull();
    expect(f.prompt).toBeNull();
  });

  it("falls back to the title when a questionnaire input is malformed", () => {
    const f = attentionFields({
      tool_name: "AskUserQuestion",
      input: {},
      title: "A question",
      description: null,
    });
    expect(f.reason).toBe("question");
    expect(f.prompt).toBe("A question");
  });

  it("pendingIsQuestion only flags AskUserQuestion", () => {
    expect(pendingIsQuestion({ tool_name: "AskUserQuestion" })).toBe(true);
    expect(pendingIsQuestion({ tool_name: "Bash" })).toBe(false);
    expect(pendingIsQuestion(null)).toBe(false);
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
