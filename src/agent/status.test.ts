import { describe, it, expect } from "vitest";
import {
  agentStatusToDot,
  backgroundCount,
  reAlertOnBashFinish,
  deriveAgentStatus,
  isDismissable,
  looksLikeQuestion,
  questionExcerpt,
  readoutBucket,
  rowAttention,
  statusReminderKind,
  type AgentSignals,
} from "./status";

/** A live, idle, fully-consumed session — the neutral baseline to override per test. */
function sig(over: Partial<AgentSignals> = {}): AgentSignals {
  return {
    handle: "session-1",
    busy: false,
    awaitingPermission: false,
    pendingToolName: null,
    pendingPrompt: null,
    activity: null,
    lastTurnSubtype: null,
    lastTurnIsError: false,
    turnSeen: true,
    lastAssistantText: null,
    persistedReminder: null,
    runningBackgroundTasks: 0,
    runningBackgroundBashTasks: 0,
    reAlertOnBackgroundBash: false,
    ...over,
  };
}

describe("deriveAgentStatus", () => {
  it("is off with no live handle (whatever else is set)", () => {
    expect(deriveAgentStatus(sig({ handle: null })).kind).toBe("off");
    // off wins over everything, even a pending permission.
    expect(
      deriveAgentStatus(sig({ handle: null, awaitingPermission: true, busy: true })).kind,
    ).toBe("off");
  });

  describe("persisted reminder re-surfaces a settled state when off", () => {
    it("maps each persisted kind back to its status when there is no live handle", () => {
      expect(deriveAgentStatus(sig({ handle: null, persistedReminder: "review" })).kind).toBe(
        "review",
      );
      expect(deriveAgentStatus(sig({ handle: null, persistedReminder: "error" }))).toEqual({
        kind: "error",
        message: expect.any(String),
      });
      expect(
        deriveAgentStatus(sig({ handle: null, persistedReminder: "openQuestion" })),
      ).toEqual({ kind: "needInput", via: "openQuestion", prompt: null });
    });

    it("is off when no reminder is persisted", () => {
      expect(deriveAgentStatus(sig({ handle: null, persistedReminder: null })).kind).toBe("off");
    });

    it("is IGNORED while the process is live — live signals win", () => {
      // A live, idle session with a stale persisted reminder reads as idle, not the
      // reminder: the live derivation is authoritative whenever the handle is set.
      expect(
        deriveAgentStatus(sig({ handle: "session-1", turnSeen: true, persistedReminder: "review" }))
          .kind,
      ).toBe("idle");
      expect(
        deriveAgentStatus(sig({ handle: "session-1", busy: true, persistedReminder: "error" }))
          .kind,
      ).toBe("running");
    });
  });

  it("is idle when live, not busy, and the last turn was consumed", () => {
    expect(deriveAgentStatus(sig()).kind).toBe("idle");
  });

  it("is 'backgrounding' when idle but background tools are still running", () => {
    expect(deriveAgentStatus(sig({ runningBackgroundTasks: 2 }))).toEqual({
      kind: "backgrounding",
      count: 2,
    });
    // It maps to the green (running-family) 'bg' dot, and never demands attention.
    expect(agentStatusToDot({ kind: "backgrounding", count: 2 })).toBe("bg");
    expect(rowAttention({ kind: "backgrounding", count: 2 })).toBeNull();
  });

  it("busy still wins over running background tasks (the main loop is active)", () => {
    expect(deriveAgentStatus(sig({ busy: true, runningBackgroundTasks: 3 })).kind).toBe("running");
  });

  it("an unseen ALERT surfaces over backgrounding, but a clean finish IS backgrounding", () => {
    // A question the agent is waiting on genuinely wants the user → it wins over the calm
    // background state even while background work runs.
    expect(
      deriveAgentStatus(
        sig({ turnSeen: false, lastAssistantText: "On continue ?", runningBackgroundTasks: 1 }),
      ).kind,
    ).toBe("needInput");
    // But a CLEAN finish with background work still running is NOT "review" (nothing to
    // review yet) — it is the green `backgrounding` state.
    expect(
      deriveAgentStatus(
        sig({ turnSeen: false, lastTurnSubtype: "success", runningBackgroundTasks: 1 }),
      ).kind,
    ).toBe("backgrounding");
  });

  it("is running while busy", () => {
    expect(deriveAgentStatus(sig({ busy: true, activity: "requesting" }))).toEqual({
      kind: "running",
      activity: "requesting",
    });
  });

  it("a pending permission outranks busy", () => {
    const s = deriveAgentStatus(sig({ busy: true, awaitingPermission: true, pendingToolName: "Bash" }));
    expect(s.kind).toBe("needIntervention");
  });

  it("AskUserQuestion → needInput via questionnaire (carries the prompt)", () => {
    expect(
      deriveAgentStatus(
        sig({
          awaitingPermission: true,
          pendingToolName: "AskUserQuestion",
          pendingPrompt: "Quelle approche ?",
        }),
      ),
    ).toEqual({ kind: "needInput", via: "questionnaire", prompt: "Quelle approche ?" });
  });

  it("any other tool permission → needIntervention (carries the tool)", () => {
    expect(
      deriveAgentStatus(sig({ awaitingPermission: true, pendingToolName: "Edit" })),
    ).toEqual({ kind: "needIntervention", tool: "Edit" });
  });

  it("falls back to a generic tool label when the tool name is missing", () => {
    const s = deriveAgentStatus(sig({ awaitingPermission: true, pendingToolName: null }));
    expect(s).toEqual({ kind: "needIntervention", tool: "tool" });
  });

  describe("when a turn just finished and is unconsumed (turnSeen=false)", () => {
    it("is review for a clean finish that doesn't look like a question", () => {
      expect(
        deriveAgentStatus(
          sig({ turnSeen: false, lastTurnSubtype: "success", lastAssistantText: "C'est fait ✅" }),
        ).kind,
      ).toBe("review");
    });

    it("is needInput via openQuestion when the last text ends on a question", () => {
      expect(
        deriveAgentStatus(
          sig({
            turnSeen: false,
            lastTurnSubtype: "success",
            lastAssistantText: "Je peux commencer ?",
          }),
        ),
      ).toEqual({ kind: "needInput", via: "openQuestion", prompt: "Je peux commencer ?" });
    });

    it("is error when the last turn flagged is_error", () => {
      expect(deriveAgentStatus(sig({ turnSeen: false, lastTurnIsError: true })).kind).toBe("error");
    });

    it("is error when the subtype starts with error_ (even without is_error)", () => {
      expect(
        deriveAgentStatus(sig({ turnSeen: false, lastTurnSubtype: "error_max_turns" })).kind,
      ).toBe("error");
    });

    it("error outranks the open-question heuristic", () => {
      // A failing turn whose text happens to end in "?" is an error, not a question.
      expect(
        deriveAgentStatus(
          sig({ turnSeen: false, lastTurnIsError: true, lastAssistantText: "Pourquoi ?" }),
        ).kind,
      ).toBe("error");
    });

    describe("background work still running behind a just-finished turn", () => {
      it("a CLEAN finish with bg running is 'backgrounding' (green), NOT review", () => {
        // The workflow / sub-agent is still churning and the agent will resume on its own —
        // there is nothing to review yet, so this is the calm green running-family state.
        const s = deriveAgentStatus(
          sig({ turnSeen: false, lastTurnSubtype: "success", runningBackgroundTasks: 2 }),
        );
        expect(s).toEqual({ kind: "backgrounding", count: 2 });
        // review never carries a background count anymore.
        expect(backgroundCount(s)).toBe(0);
      });

      it("a QUESTION with bg still alerts and carries bg (for the violet accent)", () => {
        const s = deriveAgentStatus(
          sig({ turnSeen: false, lastAssistantText: "On y va ?", runningBackgroundTasks: 1 }),
        );
        expect(s).toEqual({ kind: "needInput", via: "openQuestion", prompt: "On y va ?", bg: 1 });
        expect(backgroundCount(s)).toBe(1);
      });

      it("an ERROR with bg still alerts and carries bg (for the violet accent)", () => {
        const s = deriveAgentStatus(
          sig({ turnSeen: false, lastTurnIsError: true, runningBackgroundTasks: 1 }),
        );
        expect(s.kind).toBe("error");
        expect(backgroundCount(s)).toBe(1);
      });

      it("with no bg running, a clean finish is plain review (backgroundCount 0)", () => {
        const s = deriveAgentStatus(sig({ turnSeen: false, lastTurnSubtype: "success" }));
        expect(s).toEqual({ kind: "review" });
        expect(backgroundCount(s)).toBe(0);
      });
    });
  });

  it("once consumed (turnSeen=true) a finished question/review drops to idle", () => {
    expect(
      deriveAgentStatus(sig({ turnSeen: true, lastAssistantText: "Je peux commencer ?" })).kind,
    ).toBe("idle");
  });

  describe("re-alert on background Bash (setting, Bash-only scope, finish-edge only)", () => {
    // Baseline: a background Bash command running is one of the background tasks. The
    // "bash-only" case is `runningBackgroundBashTasks === runningBackgroundTasks` (> 0). The
    // setting adds a ONE-TIME review alert at the clean-finish edge; once seen, the conversation
    // falls back to the normal green backgrounding.

    it("OFF: a lone background Bash command keeps the calm green backgrounding (shipped default)", () => {
      const s = deriveAgentStatus(
        sig({
          turnSeen: false,
          lastTurnSubtype: "success",
          runningBackgroundTasks: 1,
          runningBackgroundBashTasks: 1,
          reAlertOnBackgroundBash: false,
        }),
      );
      expect(s).toEqual({ kind: "backgrounding", count: 1 });
    });

    it("ON + Bash-only + clean finish (unseen) → blue review, NOT backgrounding (the ping fires)", () => {
      const s = deriveAgentStatus(
        sig({
          turnSeen: false,
          lastTurnSubtype: "success",
          runningBackgroundTasks: 2,
          runningBackgroundBashTasks: 2,
          reAlertOnBackgroundBash: true,
        }),
      );
      expect(s).toEqual({ kind: "review" });
      // `review` never carries a background count (the violet accent is for alerts, not review).
      expect(backgroundCount(s)).toBe(0);
    });

    it("ON + Bash-only + SEEN (turnSeen) → falls BACK to green backgrounding (full count), NOT idle", () => {
      // The alert is a one-shot: after "Vu" the conversation returns to today's calm green state
      // while the Bash keeps running. This is the crux of the finish-edge-only scope.
      const s = deriveAgentStatus(
        sig({
          turnSeen: true,
          runningBackgroundTasks: 1,
          runningBackgroundBashTasks: 1,
          reAlertOnBackgroundBash: true,
        }),
      );
      expect(s).toEqual({ kind: "backgrounding", count: 1 });
    });

    it("ON + Bash-only + error/question → UNCHANGED alert, KEEPS the violet bg accent (full count)", () => {
      // The setting touches only the clean-finish path; error / open-question alert exactly as they
      // do with the setting off, still carrying the background count for the violet accent.
      const err = deriveAgentStatus(
        sig({
          turnSeen: false,
          lastTurnIsError: true,
          runningBackgroundTasks: 1,
          runningBackgroundBashTasks: 1,
          reAlertOnBackgroundBash: true,
        }),
      );
      expect(err.kind).toBe("error");
      expect(backgroundCount(err)).toBe(1);

      const q = deriveAgentStatus(
        sig({
          turnSeen: false,
          lastAssistantText: "On continue ?",
          runningBackgroundTasks: 1,
          runningBackgroundBashTasks: 1,
          reAlertOnBackgroundBash: true,
        }),
      );
      expect(q.kind).toBe("needInput");
      expect(backgroundCount(q)).toBe(1);
    });

    it("ON + MIXED (a workflow/sub-agent also running) → keeps green backgrounding with the FULL count", () => {
      // 2 background tasks, only 1 is Bash → not Bash-only → the setting does not bite.
      const s = deriveAgentStatus(
        sig({
          turnSeen: false,
          lastTurnSubtype: "success",
          runningBackgroundTasks: 2,
          runningBackgroundBashTasks: 1,
          reAlertOnBackgroundBash: true,
        }),
      );
      expect(s).toEqual({ kind: "backgrounding", count: 2 });
    });

    it("ON + NO Bash (only a sub-agent/workflow) → unchanged green backgrounding", () => {
      const s = deriveAgentStatus(
        sig({
          turnSeen: false,
          lastTurnSubtype: "success",
          runningBackgroundTasks: 1,
          runningBackgroundBashTasks: 0,
          reAlertOnBackgroundBash: true,
        }),
      );
      expect(s).toEqual({ kind: "backgrounding", count: 1 });
    });

    it("reAlertOnBashFinish: true only for ON + Bash-only", () => {
      const base = { runningBackgroundTasks: 2, runningBackgroundBashTasks: 2 };
      expect(reAlertOnBashFinish(sig({ ...base, reAlertOnBackgroundBash: true }))).toBe(true);
      expect(reAlertOnBashFinish(sig({ ...base, reAlertOnBackgroundBash: false }))).toBe(false);
      // Mixed set (1 of 2 is Bash) → not bash-only → false even with the setting on.
      expect(
        reAlertOnBashFinish(
          sig({ runningBackgroundTasks: 2, runningBackgroundBashTasks: 1, reAlertOnBackgroundBash: true }),
        ),
      ).toBe(false);
      // No background work at all → false regardless.
      expect(
        reAlertOnBashFinish(
          sig({ runningBackgroundTasks: 0, runningBackgroundBashTasks: 0, reAlertOnBackgroundBash: true }),
        ),
      ).toBe(false);
    });
  });
});

describe("looksLikeQuestion", () => {
  it("is false for null/empty", () => {
    expect(looksLikeQuestion(null)).toBe(false);
    expect(looksLikeQuestion("")).toBe(false);
  });

  it("detects a plain trailing question mark", () => {
    expect(looksLikeQuestion("Veux-tu que je continue ?")).toBe(true);
  });

  it("ignores trailing whitespace / markdown emphasis / closers", () => {
    expect(looksLikeQuestion("On part là-dessus ?\n")).toBe(true);
    expect(looksLikeQuestion("**Tu confirmes ?**")).toBe(true);
    expect(looksLikeQuestion("(tu confirmes ?)")).toBe(true);
    expect(looksLikeQuestion("Voici le plan ?\n```")).toBe(true);
  });

  it("is false for a statement (incl. one ending on an emoji)", () => {
    expect(looksLikeQuestion("Build vert ✅")).toBe(false);
    expect(looksLikeQuestion("C'est terminé.")).toBe(false);
    expect(looksLikeQuestion("Done!")).toBe(false);
  });
});

// The text these heuristics read comes from the agent — on a remote conversation, from a
// server: a long run of trailing-closer characters INSIDE it made an end-anchored regex try
// every start position and scan to the run's end, freezing the webview (quadratic) on every
// re-derive of the conversation's status.
describe("question heuristics stay linear on a long inner run", () => {
  const RUN = 100_000;

  it("looksLikeQuestion", () => {
    const t0 = performance.now();
    expect(looksLikeQuestion("a" + " ".repeat(RUN) + "b?")).toBe(true);
    expect(looksLikeQuestion("Done." + "_".repeat(RUN) + "Shall I continue")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("questionExcerpt", () => {
    const t0 = performance.now();
    expect(questionExcerpt("a" + ")".repeat(RUN) + "b?")).not.toBeNull();
    questionExcerpt("[".repeat(RUN) + "?");
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("questionExcerpt still reads the question at the end of a long message", () => {
    expect(questionExcerpt("x".repeat(RUN) + "\n\nAll done. Shall I ship it?**")).toBe("Shall I ship it?");
  });
});

describe("agentStatusToDot (4-colour grouping)", () => {
  it("maps each status onto its dot colour", () => {
    expect(agentStatusToDot({ kind: "off" })).toBe("off");
    expect(agentStatusToDot({ kind: "idle" })).toBe("done");
    expect(agentStatusToDot({ kind: "running", activity: null })).toBe("work");
    expect(agentStatusToDot({ kind: "needInput", via: "questionnaire", prompt: null })).toBe("ask");
    expect(agentStatusToDot({ kind: "needIntervention", tool: "Bash" })).toBe("ask");
    expect(agentStatusToDot({ kind: "review" })).toBe("review");
    expect(agentStatusToDot({ kind: "error", message: "x" })).toBe("err");
    // backgrounding shares the green running-family 'bg' token (recoloured in CSS).
    expect(agentStatusToDot({ kind: "backgrounding", count: 1 })).toBe("bg");
  });
});

describe("statusReminderKind", () => {
  it("returns the persistable kind for the three reminders", () => {
    expect(statusReminderKind({ kind: "review" })).toBe("review");
    expect(statusReminderKind({ kind: "error", message: "x" })).toBe("error");
    expect(statusReminderKind({ kind: "needInput", via: "openQuestion", prompt: "Y?" })).toBe(
      "openQuestion",
    );
  });

  it("returns null for blocking / non-reminder states (not persisted)", () => {
    expect(statusReminderKind({ kind: "needInput", via: "questionnaire", prompt: null })).toBeNull();
    expect(statusReminderKind({ kind: "needIntervention", tool: "Edit" })).toBeNull();
    expect(statusReminderKind({ kind: "running", activity: null })).toBeNull();
    expect(statusReminderKind({ kind: "idle" })).toBeNull();
    expect(statusReminderKind({ kind: "off" })).toBeNull();
  });
});

describe("isDismissable", () => {
  it("is true only for non-blocking reminders", () => {
    expect(isDismissable({ kind: "review" })).toBe(true);
    expect(isDismissable({ kind: "error", message: "x" })).toBe(true);
    expect(isDismissable({ kind: "needInput", via: "openQuestion", prompt: null })).toBe(true);
  });

  it("is false for real blocks and non-attention states", () => {
    // A questionnaire / permission must be ANSWERED, not dismissed.
    expect(isDismissable({ kind: "needInput", via: "questionnaire", prompt: null })).toBe(false);
    expect(isDismissable({ kind: "needIntervention", tool: "Edit" })).toBe(false);
    expect(isDismissable({ kind: "running", activity: null })).toBe(false);
    expect(isDismissable({ kind: "idle" })).toBe(false);
    expect(isDismissable({ kind: "off" })).toBe(false);
  });
});

describe("rowAttention", () => {
  it("buckets need-input/intervention as input, plus review and error", () => {
    expect(rowAttention({ kind: "needInput", via: "questionnaire", prompt: null })).toBe("input");
    expect(rowAttention({ kind: "needIntervention", tool: "Bash" })).toBe("input");
    expect(rowAttention({ kind: "review" })).toBe("review");
    expect(rowAttention({ kind: "error", message: "x" })).toBe("error");
  });

  it("gives no emphasis to running/idle/off", () => {
    expect(rowAttention({ kind: "running", activity: null })).toBeNull();
    expect(rowAttention({ kind: "idle" })).toBeNull();
    expect(rowAttention({ kind: "off" })).toBeNull();
  });
});

describe("readoutBucket (fleet readout stages)", () => {
  it("folds running + backgrounding into 'running'", () => {
    expect(readoutBucket({ kind: "running", activity: null })).toBe("running");
    expect(readoutBucket({ kind: "backgrounding", count: 3 })).toBe("running");
  });

  it("folds all three attention states into 'needAttention'", () => {
    expect(readoutBucket({ kind: "needInput", via: "questionnaire", prompt: null })).toBe(
      "needAttention",
    );
    expect(readoutBucket({ kind: "needIntervention", tool: "Bash" })).toBe("needAttention");
    expect(readoutBucket({ kind: "error", message: "x" })).toBe("needAttention");
  });

  it("maps review to its own stage and folds idle + off into 'idle'", () => {
    expect(readoutBucket({ kind: "review" })).toBe("review");
    expect(readoutBucket({ kind: "idle" })).toBe("idle");
    expect(readoutBucket({ kind: "off" })).toBe("idle");
  });
});
