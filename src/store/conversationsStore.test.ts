import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the IPC surface: the store's setters persist via `upsertConversation` and
// push live changes via set*; both return an ok Result. We assert what gets called.
vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      upsertConversation: vi.fn(() => ok()),
      setActiveConversation: vi.fn(() => ok()),
      setModel: vi.fn(() => ok()),
      setEffortLevel: vi.fn(() => ok()),
      setUltracode: vi.fn(() => ok()),
      setPermissionMode: vi.fn(() => ok()),
      generateConversationTitle: vi.fn(() => ok()),
      spawnSession: vi.fn(() => ok("session-1")),
      createWorktree: vi.fn(() => ok({ path: "/tmp/wt" })),
      loadSessionHistory: vi.fn(() => ok([])),
      codexLoadHistory: vi.fn(() => ok([])),
      loadSessionContext: vi.fn(() => ok({ context_tokens: 0 })),
      loadSessionGoal: vi.fn(() => ok(null)),
      deleteConversation: vi.fn(() => ok()),
      deleteRepo: vi.fn(() => ok()),
      deleteMachine: vi.fn(() => ok()),
      stopSession: vi.fn(() => ok()),
      setConversationClaudeAccount: vi.fn(() => ok()),
      // acknowledgeConversation publishes attention_cleared to the remote journal.
      publishControlEvent: vi.fn(() => Promise.resolve(null)),
      // C9: renameConversation's best-effort idle-rename push for a remote conv.
      pushRemoteConversationTitle: vi.fn(() => Promise.resolve(false)),
    },
  };
});

import { commands } from "../ipc/client";
import type { DiskConversation } from "../ipc/client";
import { usePermissionPrefs } from "./permissions";
import { useAppControlPrefs } from "./appControl";
import {
  acknowledgeConversation,
  conversationTitleForSpawn,
  createConversationInRepo,
  createConversationInWorktree,
  DEFAULT_CONV_NAME,
  DEFAULT_MODEL,
  demoteBypassConversations,
  detachClaudeAccount,
  ensureConversationSession,
  isSpawning,
  loadConversationHistory,
  reactivateDiskConversation,
  conversationForTask,
  conversationsForTask,
  refreshLinkedTaskMeta,
  useConversationsStore,
  type Conversation,
  type Machine,
} from "./conversationsStore";
import { CLAUDE_MODELS, DEFAULT_CODEX_MODEL } from "../features/conversation/models";
import { useConversationStore } from "./conversationStore";
import {
  clearManualAccountPicks,
  manualAccountPick,
  useClaudeAccountList,
  useClaudeAccountPrefs,
} from "./claudeAccounts";

const baseConv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "x",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: null,
  handle: null,
  liveCwd: null,
  bypassAllowed: false,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "default",
  pendingReminder: null,
  tosseTaskId: null,
  tosseTaskTitle: null,
  tosseTaskStatus: null,
  claudeAccountId: null,
  cleanOutput: null,
  kind: "claude",
  ...over,
});

function seed(conv: Conversation) {
  useConversationsStore.setState({
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
    conversations: [conv],
    activeId: "c1",
  });
}

const conv0 = () => useConversationsStore.getState().conversations[0];

beforeEach(() => {
  vi.clearAllMocks();
  seed(baseConv());
});

describe("conversationsStore — per-conversation controls", () => {
  it("setConvEffort stores the level and clears ultracode", () => {
    useConversationsStore.getState().setConvUltracode("c1"); // turn it on first
    expect(conv0().ultracode).toBe(true);
    useConversationsStore.getState().setConvEffort("c1", "low");
    expect(conv0().effort).toBe("low");
    expect(conv0().ultracode).toBe(false);
  });

  it("setConvUltracode sets xhigh effort + the ultracode flag", () => {
    useConversationsStore.getState().setConvUltracode("c1");
    expect(conv0().effort).toBe("xhigh");
    expect(conv0().ultracode).toBe(true);
  });

  it("setConvModel stores the chosen alias", () => {
    useConversationsStore.getState().setConvModel("c1", "sonnet");
    expect(conv0().model).toBe("sonnet");
  });

  it("setConvPermission stores the mode", () => {
    useConversationsStore.getState().setConvPermission("c1", "plan");
    expect(conv0().permissionMode).toBe("plan");
  });

  it("persists but does NOT push to the CLI when there is no live session", () => {
    useConversationsStore.getState().setConvModel("c1", "sonnet");
    expect(commands.upsertConversation).toHaveBeenCalled(); // persisted
    expect(commands.setModel).not.toHaveBeenCalled(); // nothing live to push to
  });

  it("pushes to the live session when a handle is present", () => {
    seed(baseConv({ handle: "session-7" }));
    useConversationsStore.getState().setConvEffort("c1", "high");
    expect(commands.setEffortLevel).toHaveBeenCalledWith("session-7", "high");
    useConversationsStore.getState().setConvPermission("c1", "acceptEdits");
    expect(commands.setPermissionMode).toHaveBeenCalledWith("session-7", "acceptEdits");
  });

  it("setConvCleanOutput writes an explicit override (from the inherited null) and persists", () => {
    expect(conv0().cleanOutput).toBeNull(); // starts inheriting the global default
    useConversationsStore.getState().setConvCleanOutput("c1", true);
    expect(conv0().cleanOutput).toBe(true); // now an explicit per-conversation choice
    expect(commands.upsertConversation).toHaveBeenCalled();
    // Explicit OFF is distinct from the inherited null.
    useConversationsStore.getState().setConvCleanOutput("c1", false);
    expect(conv0().cleanOutput).toBe(false);
  });

  it("setConvCleanOutput is idempotent — no write when unchanged", () => {
    useConversationsStore.getState().setConvCleanOutput("c1", true);
    vi.clearAllMocks();
    useConversationsStore.getState().setConvCleanOutput("c1", true);
    expect(commands.upsertConversation).not.toHaveBeenCalled();
  });

  it("setConvCleanOutput is display-only — never pushes to the live session", () => {
    seed(baseConv({ handle: "session-7" }));
    useConversationsStore.getState().setConvCleanOutput("c1", true);
    // Persisted, but there is no live-stream command for a pure display pref.
    expect(commands.upsertConversation).toHaveBeenCalled();
    expect(commands.setModel).not.toHaveBeenCalled();
    expect(commands.setPermissionMode).not.toHaveBeenCalled();
  });
});

describe("conversationsStore — Claude account selection", () => {
  it("persists the choice and, critically, does NOT kill a live session", () => {
    // The load-bearing guarantee: a running process cannot change identity, but changing
    // the account must never interrupt a turn either. So the setter only WRITES; the
    // restart is `ClaudeAccountApplyHost`'s job, at a safe boundary.
    seed(baseConv({ handle: "session-7", liveClaudeAccountId: null }));
    useConversationsStore.getState().setConvClaudeAccount("c1", "acct-b");
    expect(conv0().claudeAccountId).toBe("acct-b");
    // Persisted through the DEDICATED command — the core's sole writer of that column —
    // never the wholesale upsert that a stale copy could replay.
    expect(commands.setConversationClaudeAccount).toHaveBeenCalledWith("c1", "acct-b");
    expect(commands.upsertConversation).not.toHaveBeenCalled();
    expect(commands.stopSession).not.toHaveBeenCalled();
    // The live identity is untouched, so the composer can still say which account is
    // ACTUALLY in use rather than claiming the new one.
    expect(conv0().liveClaudeAccountId).toBeNull();
  });

  it("is idempotent and leaves Codex conversations alone", () => {
    useConversationsStore.getState().setConvClaudeAccount("c1", null); // already null
    expect(commands.setConversationClaudeAccount).not.toHaveBeenCalled();

    seed(baseConv({ kind: "codex" }));
    useConversationsStore.getState().setConvClaudeAccount("c1", "acct-b");
    expect(conv0().claudeAccountId).toBeNull();
    expect(commands.setConversationClaudeAccount).not.toHaveBeenCalled();
  });

  it("removing an account detaches its conversations in memory and clears the default", () => {
    useConversationsStore.setState({
      repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }],
      conversations: [
        baseConv({ id: "c1", claudeAccountId: "gone" }),
        baseConv({ id: "c2", claudeAccountId: "kept" }),
      ],
      activeId: "c1",
    });
    useClaudeAccountPrefs.getState().set({ defaultAccountId: "gone" });

    detachClaudeAccount("gone");

    const byId = (id: string) =>
      useConversationsStore.getState().conversations.find((c) => c.id === id)!;
    expect(byId("c1").claudeAccountId).toBeNull();
    expect(byId("c2").claudeAccountId).toBe("kept");
    expect(useClaudeAccountPrefs.getState().defaultAccountId).toBeNull();
  });

  it("a new Claude conversation starts on the configured default account", () => {
    useClaudeAccountList.getState().setAccounts([{ id: "acct-b", label: "B", sortIndex: 1 }]);
    useClaudeAccountPrefs.getState().set({ defaultAccountId: "acct-b" });
    try {
      const id = createConversationInRepo("/tmp/r1");
      const conv = useConversationsStore.getState().conversations.find((c) => c.id === id)!;
      expect(conv.claudeAccountId).toBe("acct-b");
    } finally {
      useClaudeAccountPrefs.getState().set({ defaultAccountId: null });
    }
  });

  it("only an AUTOMATIC switch arms the anti-oscillation cooldown", () => {
    useConversationsStore.getState().setConvClaudeAccount("c1", "acct-b");
    expect(conv0().lastAccountSwitchAt ?? null).toBeNull();

    useConversationsStore.getState().setConvClaudeAccount("c1", "acct-c", { auto: true });
    expect(conv0().lastAccountSwitchAt).toBeGreaterThan(0);
  });

  it("clearing the handle forgets the live account", () => {
    seed(baseConv({ handle: "session-7", liveClaudeAccountId: "acct-b" }));
    useConversationsStore.getState().setHandle("c1", null);
    expect(conv0().liveClaudeAccountId ?? null).toBeNull();
  });
});

describe("conversationsStore — Claude accounts in REMOTE (SSH) repos", () => {
  // The core refuses any non-default account on a remote repo (the SSH launcher does not
  // carry it), so a conversation seeded with the preferred default could never send.
  const remoteRepo = { id: "rr", path: "/srv/app", addedAt: 1, machineId: "m1" };

  beforeEach(() => {
    useClaudeAccountList.getState().setAccounts([{ id: "acct-b", label: "B", sortIndex: 1 }]);
    useClaudeAccountPrefs.getState().set({ defaultAccountId: "acct-b" });
    clearManualAccountPicks();
    useConversationsStore.setState({
      repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1 }, remoteRepo],
      conversations: [],
      activeId: null,
    });
  });
  afterEach(() => {
    useClaudeAccountPrefs.getState().set({ defaultAccountId: null });
  });

  const byId = (id: string) =>
    useConversationsStore.getState().conversations.find((c) => c.id === id)!;

  it("a new conversation in a remote repo starts on the default account", () => {
    expect(byId(createConversationInRepo("/srv/app")).claudeAccountId).toBeNull();
    // …while a local one still honours the preference.
    expect(byId(createConversationInRepo("/tmp/r1")).claudeAccountId).toBe("acct-b");
  });

  it("a new worktree conversation of a remote repo starts on the default account", () => {
    expect(byId(createConversationInWorktree("rr", "/srv/app/.claude/worktrees/x")).claudeAccountId).toBeNull();
    expect(byId(createConversationInWorktree("r1", "/tmp/r1/wt")).claudeAccountId).toBe("acct-b");
  });

  it("a reactivated or forked conversation in a remote repo runs on the default account", () => {
    const disk: DiskConversation = {
      session_id: "s-remote",
      cwd: "/srv/app",
      repo_root: "/srv/app",
      git_branch: null,
      title: null,
      excerpt: "hi",
      mtime_ms: 100,
      backend: "claude",
    };
    expect(byId(reactivateDiskConversation(disk)).claudeAccountId).toBeNull();
    // A fork inheriting a non-default account from its source must not carry it either.
    const forked = reactivateDiskConversation(
      { ...disk, session_id: "s-fork" },
      {
        model: "opus",
        effort: "xhigh",
        ultracode: false,
        permissionMode: "default",
        cleanOutput: null,
        claudeAccountId: "acct-b",
      },
    );
    expect(byId(forked).claudeAccountId).toBeNull();
  });

  it("refuses a non-default account on a remote conversation, but allows the way back", () => {
    useConversationsStore.setState({
      repos: [remoteRepo],
      conversations: [baseConv({ id: "c1", repoId: "rr", claudeAccountId: "acct-b" })],
    });
    useConversationsStore.getState().setConvClaudeAccount("c1", "acct-c", { auto: true });
    expect(byId("c1").claudeAccountId).toBe("acct-b");
    useConversationsStore.getState().setConvClaudeAccount("c1", null);
    expect(byId("c1").claudeAccountId).toBeNull();
  });
});

describe("conversationsStore — manual account picks pin the conversation", () => {
  beforeEach(() => clearManualAccountPicks());

  it("a USER pick is recorded, an automatic switch is not", () => {
    useConversationsStore.getState().setConvClaudeAccount("c1", "acct-b", { auto: true });
    expect(manualAccountPick("c1")).toBeUndefined();

    useConversationsStore.getState().setConvClaudeAccount("c1", null);
    expect(manualAccountPick("c1")).toBeNull();
    // Re-stating the current account is a deliberate choice too.
    clearManualAccountPicks();
    useConversationsStore.getState().setConvClaudeAccount("c1", null);
    expect(manualAccountPick("c1")).toBeNull();
  });
});

describe("conversationsStore — bypass-permissions unlock", () => {
  beforeEach(() => {
    usePermissionPrefs.setState({ allowBypassPermissions: false });
  });

  it("passes the app-wide opt-in to the spawn and remembers it on the conversation", async () => {
    usePermissionPrefs.setState({ allowBypassPermissions: true });
    await ensureConversationSession("c1");
    // The spawn-time flags ride the trailing `SpawnFlags` argument — the process gets
    // the unlock flag…
    const flags = vi.mocked(commands.spawnSession).mock.calls[0][6];
    expect(flags).toMatchObject({ allowBypassPermissions: true });
    // …and the conversation records that THIS live session can honour bypass.
    expect(conv0().bypassAllowed).toBe(true);
  });

  it("spawns WITHOUT the flag while the opt-in is off", async () => {
    await ensureConversationSession("c1");
    const flags = vi.mocked(commands.spawnSession).mock.calls[0][6];
    expect(flags).toMatchObject({ allowBypassPermissions: false });
    expect(conv0().bypassAllowed).toBe(false);
  });

  it("clearing the handle clears bypassAllowed — nothing to allow with no process", async () => {
    usePermissionPrefs.setState({ allowBypassPermissions: true });
    await ensureConversationSession("c1");
    expect(conv0().bypassAllowed).toBe(true);
    useConversationsStore.getState().setHandle("c1", null);
    expect(conv0().bypassAllowed).toBe(false);
  });

  it("demoteBypassConversations returns bypassing conversations to default, live ones included", () => {
    seed(baseConv({ handle: "session-7", permissionMode: "bypassPermissions" }));
    demoteBypassConversations();
    expect(conv0().permissionMode).toBe("default");
    // Withdrawing the permission has to bite NOW, not at the next spawn.
    expect(commands.setPermissionMode).toHaveBeenCalledWith("session-7", "default");
  });

  it("demoteBypassConversations leaves every other mode alone", () => {
    seed(baseConv({ handle: "session-7", permissionMode: "acceptEdits" }));
    demoteBypassConversations();
    expect(conv0().permissionMode).toBe("acceptEdits");
    expect(commands.setPermissionMode).not.toHaveBeenCalled();
  });
});

describe("conversationsStore — auto title (VS Code style)", () => {
  const store = () => useConversationsStore.getState();
  // The auto-title state (autoTitlePending / titleContext / titleGenCount /
  // lastAppliedSeq) is module-level and NOT reset between tests, so each test uses a
  // DISTINCT conversation id — its behavior never depends on another test's leftovers.
  const convOf = (id: string) => store().conversations.find((c) => c.id === id)!;

  it("places an optimistic placeholder then applies the generated title", () => {
    seed(baseConv({ id: "t1", name: DEFAULT_CONV_NAME }));
    store().noteFirstMessage("t1", "Help me fix the login bug");
    // Optimistic placeholder (the truncated message) — no longer the default name.
    expect(convOf("t1").name).not.toBe(DEFAULT_CONV_NAME);
    store().applyAutoTitle("t1", "Fix the login bug", 1);
    expect(convOf("t1").name).toBe("Fix the login bug");
  });

  it("a manual rename protects against a late-arriving generated title", () => {
    seed(baseConv({ id: "t2", name: DEFAULT_CONV_NAME }));
    store().noteFirstMessage("t2", "first question");
    store().renameConversation("t2", "My own title");
    // The generated title arrives AFTER the manual rename — it must be ignored.
    store().applyAutoTitle("t2", "Generated title", 1);
    expect(convOf("t2").name).toBe("My own title");
  });

  it("applyAutoTitle is a no-op on a conversation that never became eligible", () => {
    seed(baseConv({ id: "t3", name: "Existing title" }));
    store().applyAutoTitle("t3", "Generated title", 1);
    expect(convOf("t3").name).toBe("Existing title");
  });

  it("ignores an out-of-order (stale) title response", () => {
    seed(baseConv({ id: "t4", name: DEFAULT_CONV_NAME }));
    store().noteFirstMessage("t4", "first");
    // The richer (seq 3) response lands first…
    store().applyAutoTitle("t4", "Rich title", 3);
    expect(convOf("t4").name).toBe("Rich title");
    // …then the older (seq 1, poorer-context) response arrives late — it must be dropped.
    store().applyAutoTitle("t4", "Poor title", 1);
    expect(convOf("t4").name).toBe("Rich title");
  });

  it("triggerAutoTitle asks the binary (with its seq) only when eligible AND live", () => {
    seed(baseConv({ id: "t5", name: DEFAULT_CONV_NAME, handle: "session-7" }));
    store().noteFirstMessage("t5", "my description");
    store().triggerAutoTitle("t5", "my description");
    expect(commands.generateConversationTitle).toHaveBeenCalledWith("session-7", "my description", 1);
  });

  it("triggerAutoTitle is a no-op without a live session", () => {
    seed(baseConv({ id: "t6", name: DEFAULT_CONV_NAME, handle: null }));
    store().noteFirstMessage("t6", "my description");
    store().triggerAutoTitle("t6", "my description");
    expect(commands.generateConversationTitle).not.toHaveBeenCalled();
  });

  it("regenerates from the accumulated user messages, capped, then freezes", () => {
    seed(baseConv({ id: "t7", name: DEFAULT_CONV_NAME, handle: "session-7" }));
    const s = store();
    s.noteFirstMessage("t7", "/list-tasks");
    s.triggerAutoTitle("t7", "/list-tasks");
    s.triggerAutoTitle("t7", "do the rename task");
    s.triggerAutoTitle("t7", "add tests");
    s.triggerAutoTitle("t7", "and a fourth message"); // over the cap of 3
    // Capped at 3 regenerations.
    expect(commands.generateConversationTitle).toHaveBeenCalledTimes(3);
    // The 2nd generation titles from the ACCUMULATED intent (with its seq), not just
    // the latest msg — this is what unsticks "/list-tasks" → the actual task.
    expect(commands.generateConversationTitle).toHaveBeenNthCalledWith(
      2,
      "session-7",
      "/list-tasks\ndo the rename task",
      2,
    );
  });
});

describe("conversationsStore — C9 remote title push", () => {
  const store = () => useConversationsStore.getState();

  function seedRemote(over: Partial<Conversation> = {}) {
    useConversationsStore.setState({
      repos: [{ id: "r1", path: "/work/demo", addedAt: 1, machineId: "m1" }],
      machines: [
        {
          id: "m1",
          label: "build-server",
          host: "h.example",
          port: 22,
          user: "agent",
          addedAt: 1,
          addresses: [],
        },
      ],
      conversations: [baseConv({ sessionId: "sid-1", ...over })],
      activeId: "c1",
    });
  }

  it("pushes the new title when the repo is remote and this Mac has no live session", () => {
    seedRemote({ handle: null });
    store().renameConversation("c1", "New name");
    expect(commands.pushRemoteConversationTitle).toHaveBeenCalledWith("c1", "New name");
  });

  it("logs a warning when the push does not land — its own best-effort failure path, not just an IPC exception", async () => {
    // `push_remote_conversation_title` is infallible from the caller's point of view:
    // it resolves `false` (never rejects) for every documented failure — server
    // unreachable, daemon too old, ssh round trip failed. A `.catch()` alone would
    // never see this, so the "log it" contract needs its own `.then()` branch.
    seedRemote({ handle: null });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    store().renameConversation("c1", "New name");
    // pushRemoteConversationTitle is mocked to resolve `false` (see the mock at the
    // top of this file) and is fired-and-forgotten (never awaited) by the store —
    // flush the microtask queue so its `.then()` has run.
    await Promise.resolve();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("did not land"), "c1");
    warnSpy.mockRestore();
  });

  it("never pushes while THIS Mac holds a live session for the conversation", () => {
    seedRemote({ handle: "session-7" });
    store().renameConversation("c1", "New name");
    // The rename itself still lands locally…
    expect(conv0().name).toBe("New name");
    // …but nothing is pushed: the live session's own next reattach carries it, and
    // an ad hoc attach here would evict this Mac's OWN live link (see
    // `push_remote_conversation_title`'s safety contract).
    expect(commands.pushRemoteConversationTitle).not.toHaveBeenCalled();
  });

  it("never pushes for a conversation that has never run on the daemon (no session_id)", () => {
    seedRemote({ handle: null, sessionId: null });
    store().renameConversation("c1", "New name");
    expect(commands.pushRemoteConversationTitle).not.toHaveBeenCalled();
  });

  it("never pushes for a LOCAL conversation (no machineId)", () => {
    seed(baseConv({ sessionId: "sid-1", handle: null }));
    store().renameConversation("c1", "New name");
    expect(commands.pushRemoteConversationTitle).not.toHaveBeenCalled();
  });

  it("never pushes while a resume-spawn of the same idle remote conversation is in flight", async () => {
    // `conv.handle` stays null for the whole duration `ensureConversationSession`'s
    // spawn is pending (set only once it resolves) — so a rename racing that window
    // must be caught by `isSpawning`, not `conv.handle` alone, or it would push mid-
    // attach and evict the just-landed live session.
    seedRemote({ handle: null, sessionId: "sid-1" });
    let resolveSpawn: (v: { status: "ok"; data: string }) => void = () => {};
    vi.mocked(commands.spawnSession).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );
    const spawnDone = ensureConversationSession("c1");
    // The spawn promise is registered synchronously (before its first await), so by
    // this point `isSpawning("c1")` is already true.
    expect(isSpawning("c1")).toBe(true);
    store().renameConversation("c1", "New name");
    expect(conv0().name).toBe("New name"); // the local rename still lands…
    expect(commands.pushRemoteConversationTitle).not.toHaveBeenCalled(); // …but nothing is pushed
    resolveSpawn({ status: "ok", data: "session-42" });
    await spawnDone;
    expect(isSpawning("c1")).toBe(false);
  });

  it("conversationTitleForSpawn omits the still-untitled placeholder but threads a real name", () => {
    expect(conversationTitleForSpawn(DEFAULT_CONV_NAME)).toBeNull();
    expect(conversationTitleForSpawn("My Feature")).toBe("My Feature");
  });

  it("spawnSession threads the conversation's current title in its flags", async () => {
    seedRemote({ name: "My Feature", handle: null, sessionId: null });
    await ensureConversationSession("c1");
    const call = vi.mocked(commands.spawnSession).mock.calls[0];
    const flags = call[6] as { conversationTitle?: string | null };
    expect(flags.conversationTitle).toBe("My Feature");
  });

  it("spawnSession omits the title for a still-untitled conversation", async () => {
    seedRemote({ name: DEFAULT_CONV_NAME, handle: null, sessionId: null });
    await ensureConversationSession("c1");
    const call = vi.mocked(commands.spawnSession).mock.calls[0];
    const flags = call[6] as { conversationTitle?: string | null };
    expect(flags.conversationTitle).toBeNull();
  });
});

describe("conversationsStore — persisted reminder", () => {
  it("setReminder stores the kind and persists it", () => {
    useConversationsStore.getState().setReminder("c1", "review");
    expect(conv0().pendingReminder).toBe("review");
    expect(commands.upsertConversation).toHaveBeenCalled();
  });

  it("setReminder is idempotent — no write when unchanged", () => {
    useConversationsStore.getState().setReminder("c1", "error");
    vi.clearAllMocks();
    useConversationsStore.getState().setReminder("c1", "error");
    expect(commands.upsertConversation).not.toHaveBeenCalled();
  });

  it("loadConversationHistory marks the turn seen but PRESERVES the persisted reminder (opening ≠ acknowledging)", async () => {
    // Opening a conversation replays its on-disk transcript and marks it seen (so a
    // HISTORICAL completion doesn't read as a fresh "Claude just finished, go look") —
    // but it must NOT clear the persisted reminder. Only startConversationSession (going
    // live) clears it. This asymmetry is the survive-a-restart guarantee; lock it so a
    // future "unify the loaders" can't silently regress it.
    seed(baseConv({ id: "c-load", sessionId: "sess-load", pendingReminder: "review" }));
    const cs = useConversationStore.getState();
    const ensureSession = vi.spyOn(cs, "ensureSession").mockImplementation(() => {});
    const applyItem = vi.spyOn(cs, "applyItem").mockImplementation(() => {});
    const applyContextFill = vi.spyOn(cs, "applyContextFill").mockImplementation(() => {});
    const markSeen = vi.spyOn(cs, "markSeen").mockImplementation(() => {});
    // Non-empty history so the loader runs past its early return and reaches markSeen.
    vi.mocked(commands.loadSessionHistory).mockResolvedValueOnce({
      status: "ok",
      data: [{}],
    } as never);

    await loadConversationHistory("c-load");

    expect(markSeen).toHaveBeenCalledWith("c-load");
    expect(conv0().pendingReminder).toBe("review"); // NOT cleared
    expect(commands.setActiveConversation).not.toHaveBeenCalled();

    ensureSession.mockRestore();
    applyItem.mockRestore();
    applyContextFill.mockRestore();
    markSeen.mockRestore();
  });

  it("acknowledgeConversation clears the persisted reminder AND marks the live turn seen", () => {
    seed(baseConv({ pendingReminder: "review" }));
    // The helper exists to do BOTH halves; lock in the live one too, so a future
    // change dropping markSeen (which would leave an open conv stuck on "review")
    // fails here.
    const markSeen = vi.spyOn(useConversationStore.getState(), "markSeen");
    acknowledgeConversation("c1");
    expect(markSeen).toHaveBeenCalledWith("c1");
    expect(conv0().pendingReminder).toBeNull();
    expect(commands.upsertConversation).toHaveBeenCalled();
    markSeen.mockRestore();
  });
});

describe("conversationsStore — friction-free delete + undo", () => {
  const store = () => useConversationsStore.getState();
  const find = (id: string) => store().conversations.find((c) => c.id === id);

  beforeEach(() => {
    // The undo stack is module-level (not reset by the store reseed); drain leftovers
    // from earlier tests so each starts with an empty stack, then clear the spies the
    // drain's re-adds tripped.
    while (store().undoRemoveConversation()) {
      /* pop until empty */
    }
    vi.clearAllMocks();
  });

  it("removeConversation pushes a snapshot that undo restores (handle cleared, resume info kept)", () => {
    seed(baseConv({ id: "u1", sessionId: "sess-u1", handle: "session-9" }));
    store().removeConversation("u1");
    expect(find("u1")).toBeUndefined(); // gone from the list
    expect(commands.stopSession).toHaveBeenCalledWith("session-9"); // live process killed
    expect(commands.deleteConversation).toHaveBeenCalledWith("u1"); // row deleted

    expect(store().undoRemoveConversation()).toBe(true);
    const restored = find("u1");
    expect(restored).toBeDefined();
    expect(restored!.handle).toBeNull(); // the dead session's handle is dropped
    expect(restored!.sessionId).toBe("sess-u1"); // --resume info preserved
    expect(store().activeId).toBe("u1"); // re-selected
    expect(commands.upsertConversation).toHaveBeenCalled(); // re-persisted
  });

  it("undo with an empty stack is a no-op returning false", () => {
    seed(baseConv({ id: "u2" }));
    expect(store().undoRemoveConversation()).toBe(false);
    expect(find("u2")).toBeDefined(); // untouched
  });

  it("is LIFO across several deletes", () => {
    seed(baseConv({ id: "a" }));
    store().addConversation(baseConv({ id: "b" }));
    store().removeConversation("a");
    store().removeConversation("b");
    // Last deleted comes back first.
    store().undoRemoveConversation();
    expect(find("b")).toBeDefined();
    expect(find("a")).toBeUndefined();
    store().undoRemoveConversation();
    expect(find("a")).toBeDefined();
  });

  it("does not restore into a repo that no longer exists", () => {
    seed(baseConv({ id: "u4" }));
    store().removeConversation("u4");
    // The repo is dropped after the delete — there's nowhere to put the row back.
    useConversationsStore.setState({ repos: [] });
    expect(store().undoRemoveConversation()).toBe(false);
    expect(find("u4")).toBeUndefined();
  });

  it("undo clears the once-per-run history guard so the transcript reloads", async () => {
    seed(baseConv({ id: "u5", sessionId: "sess-u5" }));
    const cs = useConversationStore.getState();
    const ensureSession = vi.spyOn(cs, "ensureSession").mockImplementation(() => {});
    const applyItem = vi.spyOn(cs, "applyItem").mockImplementation(() => {});
    const applyContextFill = vi.spyOn(cs, "applyContextFill").mockImplementation(() => {});
    const markSeen = vi.spyOn(cs, "markSeen").mockImplementation(() => {});
    // Non-empty history so the loader runs past its early return and records the guard.
    vi.mocked(commands.loadSessionHistory).mockResolvedValue({ status: "ok", data: [{}] } as never);

    await loadConversationHistory("u5");
    expect(commands.loadSessionHistory).toHaveBeenCalledTimes(1);
    // A second load this run is a no-op — the guard suppresses it.
    await loadConversationHistory("u5");
    expect(commands.loadSessionHistory).toHaveBeenCalledTimes(1);

    // Delete + undo must clear the guard so the restored conversation re-reads its
    // on-disk transcript (otherwise it would come back blank).
    store().removeConversation("u5");
    store().undoRemoveConversation();
    await loadConversationHistory("u5");
    expect(commands.loadSessionHistory).toHaveBeenCalledTimes(2);

    ensureSession.mockRestore();
    applyItem.mockRestore();
    applyContextFill.mockRestore();
    markSeen.mockRestore();
  });
});

// B_lifecycle-#0: removeMachine used to drop a server's repos/conversations from the
// store WITHOUT stopping their live `claude` sessions — unlike removeRepo/removeConversation
// in this same file. These lock in the fix: every live handle on the removed server is
// stopped, repos/conversations on OTHER servers (and local repos) are left alone, and the
// active selection is re-derived the same way removeRepo already does.
describe("conversationsStore — removeMachine stops every live session on the server", () => {
  const store = () => useConversationsStore.getState();

  function machine(id: string, label: string): Machine {
    return { id, label, host: "10.0.0.1", port: 22, user: "root", addedAt: 1, addresses: [] };
  }

  function seedTwoServers() {
    useConversationsStore.setState({
      machines: [machine("m1", "box one"), machine("m2", "box two")],
      repos: [
        { id: "r1", path: "/remote/r1", addedAt: 1, machineId: "m1" },
        { id: "r2", path: "/remote/r2", addedAt: 1, machineId: "m2" }, // different server
        { id: "r3", path: "/local", addedAt: 1 }, // local repo, no machineId
      ],
      conversations: [
        baseConv({ id: "c1", repoId: "r1", handle: "session-a" }),
        baseConv({ id: "c2", repoId: "r1", handle: null }), // no live process to stop
        baseConv({ id: "c3", repoId: "r2", handle: "session-b" }), // must survive
        baseConv({ id: "c4", repoId: "r3", handle: "session-c" }), // must survive
      ],
      activeId: "c1",
    });
  }

  it("stops every live handle anchored to the removed server and nothing else", () => {
    seedTwoServers();
    store().removeMachine("m1");

    // Only the removed server's live session was stopped — not the surviving servers'.
    expect(commands.stopSession).toHaveBeenCalledTimes(1);
    expect(commands.stopSession).toHaveBeenCalledWith("session-a");
  });

  it("drops the machine + its repos/conversations, leaving other servers and local repos untouched", () => {
    seedTwoServers();
    store().removeMachine("m1");

    expect(store().machines.map((m) => m.id)).toEqual(["m2"]);
    expect(store().repos.map((r) => r.id).sort()).toEqual(["r2", "r3"]);
    expect(store().conversations.map((c) => c.id).sort()).toEqual(["c3", "c4"]);
    expect(commands.deleteMachine).toHaveBeenCalledWith("m1");
  });

  it("re-derives the active selection when the active conversation was on the removed server", () => {
    seedTwoServers();
    store().removeMachine("m1");
    // c1 (the old active id) is gone — the store must not keep pointing at a dropped row.
    expect(store().activeId).not.toBe("c1");
    expect(["c3", "c4", null]).toContain(store().activeId);
  });

  it("leaves the active selection alone when it wasn't on the removed server", () => {
    seedTwoServers();
    useConversationsStore.setState({ activeId: "c3" });
    store().removeMachine("m1");
    expect(store().activeId).toBe("c3");
  });

  it("is a no-op on servers/conversations when removing an UNRELATED machine with no repos", () => {
    seedTwoServers();
    useConversationsStore.setState({
      machines: [...store().machines, machine("m3", "empty box")],
    });
    store().removeMachine("m3");
    expect(commands.stopSession).not.toHaveBeenCalled();
    expect(store().conversations.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3", "c4"]);
    expect(commands.deleteMachine).toHaveBeenCalledWith("m3");
  });
});

describe("conversationsStore — backend (kind) branches", () => {
  it("setConvBackend flips kind + model on a pristine conversation and persists", () => {
    useConversationsStore.getState().setConvBackend("c1", "codex", "gpt-5.5");
    expect(conv0().kind).toBe("codex");
    expect(conv0().model).toBe("gpt-5.5");
    expect(commands.upsertConversation).toHaveBeenCalled();
  });

  it("setConvBackend is refused once a session EVER existed (sessionId set, handle off)", () => {
    // A restarted app: the conversation is reloaded with its persisted sessionId but no
    // live handle. Flipping here would hand a Codex thread id to `claude --resume`
    // (fresh empty session) and orphan the whole history — the guard must hold on
    // sessionId alone, not just on a live handle.
    seed(baseConv({ sessionId: "sess-1", handle: null }));
    useConversationsStore.getState().setConvBackend("c1", "codex", "gpt-5.5");
    expect(conv0().kind).toBe("claude");
    expect(conv0().model).toBe("opus");
    expect(commands.upsertConversation).not.toHaveBeenCalled();
  });

  it("setConvBackend is refused on a live session (handle bound)", () => {
    seed(baseConv({ handle: "session-7" }));
    useConversationsStore.getState().setConvBackend("c1", "codex", "gpt-5.5");
    expect(conv0().kind).toBe("claude");
    expect(commands.upsertConversation).not.toHaveBeenCalled();
  });

  it("setConvBackend is refused while a spawn is IN FLIGHT (no sessionId/handle yet)", async () => {
    // Freeze the spawn mid-flight: sessionId/handle are still null, but the actor being
    // started already reads the kind captured at send time — flipping now would persist
    // kind=codex over a Claude session (history invisible on reload, resume broken).
    let releaseSpawn!: (v: unknown) => void;
    vi.mocked(commands.spawnSession).mockReturnValueOnce(
      new Promise((res) => {
        releaseSpawn = res;
      }) as never,
    );
    const inflight = ensureConversationSession("c1");
    useConversationsStore.getState().setConvBackend("c1", "codex", "gpt-5.5");
    expect(conv0().kind).toBe("claude"); // refused, not queued
    expect(conv0().model).toBe("opus");
    releaseSpawn({ status: "ok", data: "session-1" });
    await inflight;
    // Once spawned it stays refused (handle guard takes over from the spawn guard).
    useConversationsStore.getState().setConvBackend("c1", "codex", "gpt-5.5");
    expect(conv0().kind).toBe("claude");
  });

  it("createConversationInRepo seeds the backend's own defaults", () => {
    // Codex: its own model + effort (a Claude alias would be rejected at thread/start).
    const cx = createConversationInRepo("/tmp/r1", "codex");
    const codexConv = useConversationsStore.getState().conversations.find((c) => c.id === cx)!;
    expect(codexConv.kind).toBe("codex");
    expect(codexConv.model).toBe("gpt-6-astra"); // FACTORY_DEFAULTS.codexModel
    expect(codexConv.effort).toBe("xhigh"); // DEFAULT_CODEX_EFFORT
    // Default (kind omitted) stays the pre-Codex Claude behaviour.
    const cl = createConversationInRepo("/tmp/r1");
    const claudeConv = useConversationsStore.getState().conversations.find((c) => c.id === cl)!;
    expect(claudeConv.kind).toBe("claude");
    expect(claudeConv.model).not.toBe("gpt-6-astra");
  });

  it("Codex model/effort changes persist but are NEVER pushed live (per-turn overrides)", () => {
    seed(baseConv({ kind: "codex", model: "gpt-5.5", effort: "medium", handle: "session-7" }));
    useConversationsStore.getState().setConvModel("c1", "gpt-5.4");
    useConversationsStore.getState().setConvEffort("c1", "high");
    expect(conv0().model).toBe("gpt-5.4"); // persisted…
    expect(conv0().effort).toBe("high");
    expect(commands.upsertConversation).toHaveBeenCalled();
    // …but no live push: Codex has no set_model/set_effort channel — the values ride
    // the next turn/start as overrides (buildCodexControls).
    expect(commands.setModel).not.toHaveBeenCalled();
    expect(commands.setEffortLevel).not.toHaveBeenCalled();
  });

  it("loadConversationHistory routes a Codex conversation to the rollout reader and skips the Claude context seed", async () => {
    seed(baseConv({ id: "cx-hist", kind: "codex", sessionId: "thread-1" }));
    const cs = useConversationStore.getState();
    const ensureSession = vi.spyOn(cs, "ensureSession").mockImplementation(() => {});
    const applyItem = vi.spyOn(cs, "applyItem").mockImplementation(() => {});
    const applyContextFill = vi.spyOn(cs, "applyContextFill").mockImplementation(() => {});
    const markSeen = vi.spyOn(cs, "markSeen").mockImplementation(() => {});
    // Non-empty history so the loader runs past its early return, down to the seed gate.
    vi.mocked(commands.codexLoadHistory).mockResolvedValueOnce({
      status: "ok",
      data: [{}],
    } as never);

    await loadConversationHistory("cx-hist");

    expect(commands.codexLoadHistory).toHaveBeenCalledWith("thread-1");
    expect(commands.loadSessionHistory).not.toHaveBeenCalled();
    // Codex has no cold context source (its ring fills from the first live push) —
    // the Claude transcript context seed must not run for a Codex thread id.
    expect(commands.loadSessionContext).not.toHaveBeenCalled();

    ensureSession.mockRestore();
    applyItem.mockRestore();
    applyContextFill.mockRestore();
    markSeen.mockRestore();
  });

  it("loadConversationHistory seeds the context ring from the transcript for a CLAUDE conversation", async () => {
    seed(baseConv({ id: "cl-hist", sessionId: "sess-cl" }));
    const cs = useConversationStore.getState();
    const ensureSession = vi.spyOn(cs, "ensureSession").mockImplementation(() => {});
    const applyItem = vi.spyOn(cs, "applyItem").mockImplementation(() => {});
    const applyContextFill = vi.spyOn(cs, "applyContextFill").mockImplementation(() => {});
    const markSeen = vi.spyOn(cs, "markSeen").mockImplementation(() => {});
    vi.mocked(commands.loadSessionHistory).mockResolvedValueOnce({
      status: "ok",
      data: [{}],
    } as never);

    await loadConversationHistory("cl-hist");

    expect(commands.codexLoadHistory).not.toHaveBeenCalled();
    expect(commands.loadSessionContext).toHaveBeenCalledWith("sess-cl");

    ensureSession.mockRestore();
    applyItem.mockRestore();
    applyContextFill.mockRestore();
    markSeen.mockRestore();
  });
});

describe("conversationsStore — controls applied at spawn", () => {
  it("ensureConversationSession passes the persisted controls to spawn_session", async () => {
    seed(
      baseConv({ model: "sonnet", effort: "high", ultracode: false, permissionMode: "plan" }),
    );
    const handle = await ensureConversationSession("c1");
    expect(handle).toBe("session-1");
    // (cwd, resume, model, effort, permissionMode, backend, flags) — the conversation's
    // own controls + its backend, then the spawn-only flags: ultracode, the app-wide
    // bypass opt-in, the app-control policy (default ON) and the Claude account (null =
    // the default one). NOT the old hardcoded defaults.
    expect(commands.spawnSession).toHaveBeenCalledWith(
      "/tmp/r1",
      null,
      "sonnet",
      "high",
      "plan",
      "claude",
      {
        ultracode: false,
        allowBypassPermissions: false,
        appControl: true,
        claudeAccountId: null,
        // C9: the conversation's current title ("x", `baseConv`'s default name —
        // not the untitled placeholder, so it threads through).
        conversationTitle: "x",
      },
    );
  });

  it("spawns WITHOUT app control once the policy is switched off", async () => {
    useAppControlPrefs.setState({ agentServer: false });
    try {
      await ensureConversationSession("c1");
      const flags = vi.mocked(commands.spawnSession).mock.calls[0][6];
      expect(flags).toMatchObject({ appControl: false });
    } finally {
      useAppControlPrefs.setState({ agentServer: true });
    }
  });

  it("spawns on the conversation's Claude account", async () => {
    // The account can only be applied at spawn (the CLI reads its credentials once at
    // startup), so a conversation pointed at another account must carry it HERE — not
    // silently authenticate as the default one and bill the wrong subscription.
    useConversationsStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === "c1" ? { ...c, claudeAccountId: "acct-b" } : c,
      ),
    }));
    await ensureConversationSession("c1");
    const flags = vi.mocked(commands.spawnSession).mock.calls[0][6];
    expect(flags).toMatchObject({ claudeAccountId: "acct-b" });
  });
});

describe("reactivateDiskConversation — backend-aware", () => {
  const diskConv = (over: Partial<DiskConversation>): DiskConversation => ({
    session_id: "s-x",
    cwd: "/tmp/disk-repo",
    repo_root: "/tmp/disk-repo",
    git_branch: null,
    title: null,
    excerpt: "hi",
    mtime_ms: 100,
    backend: "claude",
    ...over,
  });

  beforeEach(() => {
    // Seed a repo the disk cwd already belongs to so reactivation reuses it (the auto-add
    // path would call the un-mocked commands.upsertRepo — not what this test exercises).
    useConversationsStore.setState({
      repos: [{ id: "disk-r", path: "/tmp/disk-repo", addedAt: 1 }],
      conversations: [],
      activeId: null,
    });
  });

  it("brings a Codex disk row back as a Codex conversation with Codex defaults", () => {
    const id = reactivateDiskConversation(diskConv({ session_id: "cx-1", backend: "codex" }));
    const conv = useConversationsStore.getState().conversations.find((c) => c.id === id)!;
    // Backend, its default model, and the resume id all come from the disk row — a Codex
    // thread must not be reactivated as a Claude conversation (else the next message would
    // spawn the wrong CLI and the rollout history wouldn't load).
    expect(conv.kind).toBe("codex");
    expect(conv.model).toBe(DEFAULT_CODEX_MODEL);
    expect(conv.sessionId).toBe("cx-1");
  });

  it("brings a Claude disk row back as a Claude conversation with Claude defaults", () => {
    const id = reactivateDiskConversation(diskConv({ session_id: "cl-1", backend: "claude" }));
    const conv = useConversationsStore.getState().conversations.find((c) => c.id === id)!;
    expect(conv.kind).toBe("claude");
    expect(conv.model).toBe(DEFAULT_MODEL);
  });

  // A default the picker doesn't offer would seed every conversation with a row the
  // menu can't highlight (and, for a mistyped id, a model the binary would reject).
  it("the Claude default is a model the picker actually offers", () => {
    expect(CLAUDE_MODELS.map((m) => m.value)).toContain(DEFAULT_MODEL);
  });
});

describe("conversationsStore — the TOSSE task link", () => {
  it("stores the task with its title and status, and clears them together", () => {
    useConversationsStore
      .getState()
      .linkConversationToTask("c1", { id: "t-1", title: "Fix login", status: "En cours" });
    expect(conv0().tosseTaskId).toBe("t-1");
    // The denormalised pair is what keeps the link legible — and the delete warning
    // working — with no network.
    expect(conv0().tosseTaskTitle).toBe("Fix login");
    expect(conv0().tosseTaskStatus).toBe("En cours");
    expect(commands.upsertConversation).toHaveBeenCalled();

    useConversationsStore.getState().linkConversationToTask("c1", null);
    expect(conv0().tosseTaskId).toBeNull();
    expect(conv0().tosseTaskTitle).toBeNull();
    expect(conv0().tosseTaskStatus).toBeNull();
  });

  it("does not re-persist an unchanged link", () => {
    const link = { id: "t-1", title: "Fix login", status: "En cours" };
    useConversationsStore.getState().linkConversationToTask("c1", link);
    vi.clearAllMocks();
    useConversationsStore.getState().linkConversationToTask("c1", link);
    expect(commands.upsertConversation).not.toHaveBeenCalled();
  });

  it("lists a task's conversations, most recently active first", () => {
    const a = baseConv({ id: "c1", tosseTaskId: "t-1", lastActivityAt: 10 });
    const b = baseConv({ id: "c2", tosseTaskId: "t-1", lastActivityAt: 20 });
    const other = baseConv({ id: "c3", tosseTaskId: "t-2", lastActivityAt: 30 });
    // A task legitimately carries several (a retry, a second opinion): they are all
    // listed, and the one being worked in comes first — that ordering is what makes
    // "open the conversation on this task" unambiguous.
    expect(conversationsForTask([a, b, other], "t-1").map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(conversationForTask([a, b, other], "t-1")?.id).toBe("c2");
    expect(conversationsForTask([a, b, other], "t-9")).toEqual([]);
    expect(conversationForTask([a], null)).toBeNull();
  });

  it("re-stamps a linked conversation when the CRM's copy moved on", () => {
    useConversationsStore
      .getState()
      .linkConversationToTask("c1", { id: "t-1", title: "Fix login", status: "En cours" });
    const changed = refreshLinkedTaskMeta([
      { id: "t-1", title: "Fix the login bug", status: "Review" },
    ]);
    expect(changed).toBe(1);
    expect(conv0().tosseTaskStatus).toBe("Review");
    expect(conv0().tosseTaskTitle).toBe("Fix the login bug");
    // Nothing moved → nothing written.
    expect(refreshLinkedTaskMeta([{ id: "t-1", title: "Fix the login bug", status: "Review" }])).toBe(0);
  });

  it("leaves a link alone when the task is absent from the payload", () => {
    // The briefing deliberately omits whole categories (done, backlog, parked). Treating
    // "absent" as "gone" would erase the link the moment a task is finished — exactly
    // when the user still wants to know which conversation did it.
    useConversationsStore
      .getState()
      .linkConversationToTask("c1", { id: "t-1", title: "Fix login", status: "En cours" });
    expect(refreshLinkedTaskMeta([{ id: "t-other", title: "x", status: "En cours" }])).toBe(0);
    expect(conv0().tosseTaskId).toBe("t-1");
    expect(conv0().tosseTaskStatus).toBe("En cours");
  });
});
