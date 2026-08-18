import { describe, it, expect, vi, beforeEach } from "vitest";

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
      stopSession: vi.fn(() => ok()),
    },
  };
});

import { commands } from "../ipc/client";
import type { DiskConversation } from "../ipc/client";
import { usePermissionPrefs } from "./permissions";
import { useAppControlPrefs } from "./appControl";
import {
  acknowledgeConversation,
  createConversationInRepo,
  DEFAULT_CONV_NAME,
  DEFAULT_MODEL,
  demoteBypassConversations,
  ensureConversationSession,
  loadConversationHistory,
  reactivateDiskConversation,
  conversationForTask,
  conversationsForTask,
  refreshLinkedTaskMeta,
  useConversationsStore,
  type Conversation,
} from "./conversationsStore";
import { CLAUDE_MODELS, DEFAULT_CODEX_MODEL } from "../features/conversation/models";
import { useConversationStore } from "./conversationStore";

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

describe("conversationsStore — bypass-permissions unlock", () => {
  beforeEach(() => {
    usePermissionPrefs.setState({ allowBypassPermissions: false });
  });

  it("passes the app-wide opt-in to the spawn and remembers it on the conversation", async () => {
    usePermissionPrefs.setState({ allowBypassPermissions: true });
    await ensureConversationSession("c1");
    // Second-to-last positional arg of spawnSession (the trailing one is the
    // app-control flag) — the process gets the unlock flag…
    const args = vi.mocked(commands.spawnSession).mock.calls[0];
    expect(args[args.length - 2]).toBe(true);
    // …and the conversation records that THIS live session can honour bypass.
    expect(conv0().bypassAllowed).toBe(true);
  });

  it("spawns WITHOUT the flag while the opt-in is off", async () => {
    await ensureConversationSession("c1");
    const args = vi.mocked(commands.spawnSession).mock.calls[0];
    expect(args[args.length - 2]).toBe(false);
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
    expect(codexConv.model).toBe("gpt-5.6-sol"); // DEFAULT_CODEX_MODEL
    expect(codexConv.effort).toBe("xhigh"); // DEFAULT_CODEX_EFFORT
    // Default (kind omitted) stays the pre-Codex Claude behaviour.
    const cl = createConversationInRepo("/tmp/r1");
    const claudeConv = useConversationsStore.getState().conversations.find((c) => c.id === cl)!;
    expect(claudeConv.kind).toBe("claude");
    expect(claudeConv.model).not.toBe("gpt-5.6-sol");
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
    // (cwd, resume, model, effort, permissionMode, ultracode, backend,
    // allowBypassPermissions, appControl) — the conversation's own controls + its
    // backend + the app-wide bypass opt-in + the app-control policy (default ON),
    // NOT the old hardcoded defaults.
    expect(commands.spawnSession).toHaveBeenCalledWith(
      "/tmp/r1",
      null,
      "sonnet",
      "high",
      "plan",
      false,
      "claude",
      false,
      true,
    );
  });

  it("spawns WITHOUT app control once the policy is switched off", async () => {
    useAppControlPrefs.setState({ agentServer: false });
    try {
      await ensureConversationSession("c1");
      const args = vi.mocked(commands.spawnSession).mock.calls[0];
      expect(args[args.length - 1]).toBe(false);
    } finally {
      useAppControlPrefs.setState({ agentServer: true });
    }
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
