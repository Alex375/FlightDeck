import { describe, it, expect, vi, beforeEach } from "vitest";

// setReminder persists via commands.upsertConversation; stub the IPC surface so the
// store mutation runs without a real backend (same pattern as conversationsStore.test).
vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return { commands: { upsertConversation: vi.fn(() => ok()) } };
});

import { commands } from "../ipc/client";
import { syncReminderFromLive } from "./reminderSync";
import { useConversationsStore, type Conversation } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import type { SessionEntry, Turn } from "../store/types";
import type { ReminderKind } from "./status";

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "x",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: null,
  handle: "session-1", // live by default
  liveCwd: null,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "default",
  pendingReminder: null,
  tosseTaskId: null,
  tosseTaskTitle: null,
  tosseTaskStatus: null,
  cleanOutput: null,
  kind: "claude",
  ...over,
});

function assistantTurn(id: string, text: string): Turn {
  return {
    id,
    role: "assistant",
    status: "final",
    streamingText: "",
    streamingThinking: "",
    blocks: text ? [{ type: "text", text } as unknown as Turn["blocks"][number]] : [],
    parentToolUseId: null,
    hasThinking: false,
  };
}

/** A live session entry whose last turn settled (or is still running when busy). */
function entry(opts: {
  busy?: boolean;
  turnSeen: boolean;
  isError?: boolean;
  subtype?: string;
  text?: string;
}): SessionEntry {
  return {
    session: "c1",
    state: { busy: opts.busy ?? false, awaiting_permission: false, activity: null },
    timeline: [
      { kind: "turn", id: "t1" },
      { kind: "turn_result", id: "tr1" },
    ],
    turns: { t1: assistantTurn("t1", opts.text ?? "C'est fait ✅") },
    notices: {},
    errors: {},
    turnResults: {
      tr1: {
        subtype: opts.subtype ?? "success",
        isError: opts.isError ?? false,
        result: null,
        totalCostUsd: null,
        numTurns: null,
        durationMs: null,
      },
    },
    toolResults: {},
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    todos: [],
    turnSeen: opts.turnSeen,
    seq: 2,
  } as unknown as SessionEntry;
}

function seed(c: Conversation, e: SessionEntry | undefined) {
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
    conversations: [c],
    activeId: "c1",
  });
  useConversationStore.setState({ sessions: e ? { c1: e } : {} });
}

const persisted = (): ReminderKind | null =>
  useConversationsStore.getState().conversations[0].pendingReminder;

beforeEach(() => vi.clearAllMocks());

describe("syncReminderFromLive — arming the persisted reminder from the live status", () => {
  it("arms 'review' for a clean finished turn", () => {
    seed(conv(), entry({ turnSeen: false, text: "C'est fait ✅" }));
    syncReminderFromLive("c1");
    expect(persisted()).toBe("review");
    expect(commands.upsertConversation).toHaveBeenCalled();
  });

  it("arms 'error' for a turn that ended in error", () => {
    seed(conv(), entry({ turnSeen: false, isError: true }));
    syncReminderFromLive("c1");
    expect(persisted()).toBe("error");
  });

  it("arms 'openQuestion' when the last text reads as a question", () => {
    seed(conv(), entry({ turnSeen: false, text: "Je peux continuer ?" }));
    syncReminderFromLive("c1");
    expect(persisted()).toBe("openQuestion");
  });

  it("clears (no spurious arm) for an interrupted / already-seen turn", () => {
    // turnSeen=true → live status idle → reminder must be cleared, not armed.
    seed(conv({ pendingReminder: "review" }), entry({ turnSeen: true }));
    syncReminderFromLive("c1");
    expect(persisted()).toBeNull();
  });

  it("PRESERVES the persisted reminder when the process is off (handle === null)", () => {
    // The off-guard: quitting/stopping must not erase the reminder. Even with a live
    // entry that would derive 'idle', a null handle means we leave the DB untouched.
    seed(conv({ handle: null, pendingReminder: "review" }), entry({ turnSeen: true }));
    syncReminderFromLive("c1");
    expect(persisted()).toBe("review");
    expect(commands.upsertConversation).not.toHaveBeenCalled();
  });

  it("ended-edge sequence: arms while the handle is live, then preserves across the unbind", () => {
    // Mirrors useGlobalSessionEvents.onState on a session-end state: it calls
    // syncReminderFromLive (handle STILL bound) BEFORE the `ended` setHandle(null). This
    // locks the load-bearing ORDER — a future reorder (unbind first) would make the sync
    // hit the off-guard and silently drop the off-restart reminder.
    seed(conv(), entry({ turnSeen: false, text: "C'est fait ✅" }));
    // 1) the settle-edge sync, handle live → arms 'review'.
    syncReminderFromLive("c1");
    expect(persisted()).toBe("review");
    // 2) the `ended` unbind: handle → null must NOT erase the persisted reminder.
    useConversationsStore.getState().setHandle("c1", null);
    expect(persisted()).toBe("review");
    // 3) any later sync is now a no-op (off-guard) — still preserved.
    syncReminderFromLive("c1");
    expect(persisted()).toBe("review");
  });

  it("converges regardless of which edge lands first (busy-edge before the turn settles)", () => {
    // Edge 1: the busy→false state event arrives BEFORE the turn_result message, so the
    // entry isn't settled yet (still busy) → running → reminder cleared.
    seed(conv({ pendingReminder: "review" }), entry({ busy: true, turnSeen: false }));
    syncReminderFromLive("c1");
    expect(persisted()).toBeNull();
    // Edge 2: the turn_result message now lands (entry settles) → reminder armed.
    useConversationStore.setState({ sessions: { c1: entry({ turnSeen: false }) } });
    syncReminderFromLive("c1");
    expect(persisted()).toBe("review");
  });
});
