// The one product decision "Start" and "Discuss" do NOT share: whether a successful launch
// takes the window with it.
//
// It is locked here rather than left inline in the provider because the two buttons run
// through the SAME launch code — the conversation is created, linked and sent to either way
// — so the only thing telling them apart is this predicate. Both callers (the one-click
// path and the folder dialog) go through it, so a change here changes both or neither.
//
// The second half of this file locks what they DO share: the folder is equipped with the
// TOSSE plugin before either of them sends anything.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared with the mock factories below (they run before the module body, so the state they
// close over has to be hoisted with them).
const h = vi.hoisted(() => ({
  /** What the folder's `/` catalogue advertises — empty until the plugin is switched on,
   *  which is exactly the state a dormant plugin leaves it in. */
  catalogue: [] as { name: string }[],
  /** The store's conversations, MUTABLE so a test can have one appear mid-launch — which
   *  is what a second launch fired while this one waits on the plugin looks like. */
  conversations: [] as { id: string }[],
  linkConversationToTask: vi.fn(),
  renameConversation: vi.fn(),
  addErrorTurn: vi.fn(),
}));

vi.mock("../../ipc/client", () => ({
  commands: { listExtensions: vi.fn(), setPluginEnabled: vi.fn() },
}));
vi.mock("../../ipc/useCommands", () => ({ sendConversationMessage: vi.fn(async () => {}) }));
vi.mock("../../store/commandsStore", () => ({
  // Enabling the plugin is what makes the CLI publish the skill: the refetch is where the
  // catalogue stops being empty.
  refetchSlashCommands: vi.fn(async () => {
    h.catalogue = [{ name: "tosse-workflow:pickup" }];
  }),
  prefetchSlashCommands: vi.fn(async () => {}),
  useCommandsStore: { getState: () => ({ byCwd: { "/repo": h.catalogue } }) },
}));
vi.mock("../../store/conversationsStore", () => ({
  // Every conversation in the store counts as this task's — the numbering is what is under
  // test, not the filtering.
  conversationsForTask: (convs: { id: string }[]) => convs,
  createConversationInRepo: vi.fn(() => "conv-1"),
  useConversationsStore: {
    getState: () => ({
      repos: [{ id: "repo-1", path: "/repo" }],
      conversations: h.conversations,
      linkConversationToTask: h.linkConversationToTask,
      renameConversation: h.renameConversation,
    }),
  },
}));
vi.mock("../../store/conversationStore", () => ({
  useConversationStore: { getState: () => ({ addErrorTurn: h.addErrorTurn }) },
}));

import { launchFocusesConversation, launchTaskConversation } from "./taskConversation";
import { commands } from "../../ipc/client";
import { sendConversationMessage } from "../../ipc/useCommands";

const listExtensions = commands.listExtensions as unknown as ReturnType<typeof vi.fn>;
const setPluginEnabled = commands.setPluginEnabled as unknown as ReturnType<typeof vi.fn>;
const send = sendConversationMessage as unknown as ReturnType<typeof vi.fn>;

const TASK = {
  id: "task-1",
  title: "Ship it",
  status: "À faire",
  priority: null,
  kind: null,
  assignedTo: null,
  dueDate: null,
  projectName: null,
  notes: null,
  context: null,
  content: null,
  blockedBy: [],
};

/** A folder where `tosse-workflow` ships the pickup skill, switched on or off. */
function installed(enabled: boolean) {
  return {
    status: "ok" as const,
    data: {
      mcp_servers: [],
      plugins: [{ id: "tosse-workflow@tosse-plugins", name: "tosse-workflow", enabled }],
      skills: [{ name: "tosse-workflow:pickup", source: "tosse-workflow@tosse-plugins" }],
      agents: [],
      warnings: [],
      plugin_state_trusted: true,
    },
  };
}

describe("launchFocusesConversation", () => {
  it("stays on the tasks view when Start is pressed and the preference is on", () => {
    expect(launchFocusesConversation("pickup", true)).toBe(false);
  });

  it("follows Start to the conversation when the preference is off", () => {
    expect(launchFocusesConversation("pickup", false)).toBe(true);
  });

  // The asymmetry is the point, not an oversight: "Discuss" is a question, and its answer
  // is the reason to press it. The preference is about handing a task OFF, so it must not
  // silently swallow the one gesture that is waiting for a reply.
  it("always follows Discuss, whatever the preference says", () => {
    expect(launchFocusesConversation("discuss", true)).toBe(true);
    expect(launchFocusesConversation("discuss", false)).toBe(true);
  });
});

describe("launchTaskConversation equips the folder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.catalogue = [];
    h.conversations = [];
    setPluginEnabled.mockResolvedValue({ status: "ok", data: null });
  });

  // ⚠️ The store is read AFTER the plugin work, never before it. Equipping a folder can take
  // seconds (a config scan, and a short-lived `claude` on the dormant path); a snapshot taken
  // on the near side would have two launches fired inside that window both see the task as
  // carrying nothing, so both would name themselves after the bare title and the "(2)" that
  // tells a second pass from the first would never appear.
  it("counts the task's conversations after equipping, not before", async () => {
    listExtensions.mockResolvedValue(installed(false));
    // Another launch lands while this one waits on the plugin write.
    setPluginEnabled.mockImplementation(async () => {
      h.conversations = [{ id: "conv-0" }];
      return { status: "ok", data: null };
    });

    await launchTaskConversation({ task: TASK, repoId: "repo-1", mode: "discuss" });

    expect(h.renameConversation).toHaveBeenCalledWith("conv-1", "Ship it (2)");
  });

  // The regression this whole task exists for: "Discuss" used to skip the plugin entirely
  // ("plain prose works anywhere"), which was true of its FIRST message and false of the
  // conversation it opens — one that carries on without /pickup, /done… and says nothing.
  it("switches a dormant plugin on for Discuss, not just for Start", async () => {
    listExtensions.mockResolvedValue(installed(false));

    const out = await launchTaskConversation({ task: TASK, repoId: "repo-1", mode: "discuss" });

    expect(setPluginEnabled).toHaveBeenCalledWith("tosse-workflow@tosse-plugins", true);
    expect(out.plugin).toEqual({
      kind: "enabled",
      plugin: "tosse-workflow",
      pickup: "tosse-workflow:pickup",
    });
  });

  // Order is the whole mechanism: `set_plugin_enabled` writes `settings.json`, and a
  // `claude` process reads it at startup. Enabling after the send would leave the very
  // conversation the user is looking at unequipped.
  it("enables BEFORE the message that spawns the session", async () => {
    listExtensions.mockResolvedValue(installed(false));

    await launchTaskConversation({ task: TASK, repoId: "repo-1", mode: "discuss" });

    expect(setPluginEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0],
    );
  });

  // Equipping is best-effort: a refused write must not cost the user their conversation.
  // It travels back instead, and the caller says it.
  it("still opens the conversation when the plugin could not be enabled", async () => {
    listExtensions.mockResolvedValue(installed(false));
    setPluginEnabled.mockResolvedValue({ status: "error", error: "settings.json is read-only" });

    const out = await launchTaskConversation({ task: TASK, repoId: "repo-1", mode: "discuss" });

    expect(send).toHaveBeenCalled();
    expect(out.convId).toBe("conv-1");
    expect(out.plugin.kind).toBe("failed");
  });

  // "Start" reads the catalogue AFTER the plugin work, so the name it sends is the one the
  // freshly enabled plugin publishes — asking first would have found nothing and quietly
  // downgraded to written instructions in a folder that was one toggle from ready.
  it("sends the skill name the just-enabled plugin publishes", async () => {
    listExtensions.mockResolvedValue(installed(false));

    const out = await launchTaskConversation({ task: TASK, repoId: "repo-1", mode: "pickup" });

    expect(out.pickup).toBe("available");
    expect(send).toHaveBeenCalledWith("conv-1", { text: "/tosse-workflow:pickup task-1" });
  });
});
