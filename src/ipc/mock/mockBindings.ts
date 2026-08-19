// Browser / Playwright fallback that mirrors the tauri-specta { commands, events }
// surface exactly, but emits scripted fixtures instead of talking to a Rust core.
// Selected at runtime by provider.ts when window.__TAURI_INTERNALS__ is absent.

import type {
  Backend,
  BranchInfo,
  CommitFile,
  CommitInfo,
  ContextFill,
  ConversationItem,
  ConversationRecord,
  GoalState,
  DiskConversation,
  ClaudeAccountStatus,
  ClaudeCliStatus,
  ClaudeUpdateOutcome,
  CodexAccountStatus,
  CodexControls,
  CodexHooksSnapshot,
  CodexLoginStart,
  CodexPluginsLive,
  ExtensionsSnapshot,
  FileContent,
  FileStat,
  FsChangeEvent,
  FsWatchErrorEvent,
  FsEntry,
  GitDiff,
  GitFileEntry,
  GitStatus,
  ImageAttachment,
  ImageContent,
  MarketplaceInfo,
  McpAuthResult,
  LiveModel,
  McpServerLive,
  RewindFilesResult,
  PluginContents,
  PermissionDecision,
  PermissionMode,
  PersistedState,
  PlanUsage,
  Pong,
  ForkOutcome,
  RemoteControlState,
  RepoRecord,
  Result,
  RewindOutcome,
  SearchHit,
  AccountLoginEvent,
  SessionCodexPlanUsageEvent,
  SessionCommandsEvent,
  SessionExtensionsChangedEvent,
  SessionMessageEvent,
  SessionPermissionEvent,
  SessionPermissionResolvedEvent,
  SessionRemoteControlEvent,
  SessionStatePayload,
  SessionStateEvent,
  SessionTaskEvent,
  SessionTitleEvent,
  SessionSummaryEvent,
  TosseAccountStatus,
  TosseOffBoardTask,
  TosseTaskProject,
  TosseBriefing,
  TosseCrmEvent,
  TosseLiveStateEvent,
  TosseProject,
  LocalRepoScan,
  TosseProjectRepo,
  TosseRepoLink,
  TosseRepoLinksPayload,
  TosseRepository,
  TosseTask,
  TosseTaskDetail,
  SlashCommand,
  AppControlRequestEvent,
  TerminalExitEvent,
  TerminalOutputEvent,
  TickEvent,
  UsageError,
  ClientSecret,
  FolderTree,
  VoiceAgentStatus,
  RemoteStatus,
  VoiceBridgeStatus,
  WakeStatus,
  WorkflowJournal,
  WorkflowJournalEvent,
  WorkflowPhase,
  WorkflowRun,
  WorktreeInfo,
  WorktreeStatus,
} from "../bindings";
import { DEMO_HISTORY_TRANSCRIPT, DEMO_SUBAGENT_TRANSCRIPT, DEMO_WORKFLOW_RUN, demoWorkflowJournal, idleState, isDemoWorkflowDone, mockTaskOutput, MOCK_SESSION_ID, ScenarioDriver } from "./scenario";


// A small slash-command catalogue so the browser/Playwright build exercises the
// `/` autocomplete menu without a real `claude` process.
// Faithful to the real `initialize` shape: BARE names, plugin carried as a
// leading "(plugin)" in the description (built-ins have none).
const MOCK_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Start a new session with empty context", argument_hint: "[name]" },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argument_hint: "" },
  { name: "init", description: "Initialize a new CLAUDE.md with codebase documentation", argument_hint: "" },
  { name: "review", description: "Review a pull request", argument_hint: "" },
  { name: "pickup", description: "(tosse-workflow) Start working on a TOSSE task", argument_hint: "<task_id>" },
  { name: "done", description: "(tosse-workflow) Finish a TOSSE task and move it to review", argument_hint: "" },
  { name: "list-tasks", description: "(tosse-workflow) List the tasks for the current project", argument_hint: "" },
  { name: "algorithmic-art", description: "(example-skills) Creating algorithmic art using p5.js with seeded randomness", argument_hint: "" },
  { name: "canvas-design", description: "(example-skills) Create beautiful visual art in .png and .pdf documents", argument_hint: "" },
];

// ---- Minimal Tauri-shaped event emitter -----------------------------------

type EventCb<T> = (e: { payload: T; event: string; id: number }) => void;

class MockEmitter<T> {
  private cbs = new Set<EventCb<T>>();

  listen(cb: EventCb<T>): Promise<() => void> {
    this.cbs.add(cb);
    return Promise.resolve(() => {
      this.cbs.delete(cb);
    });
  }

  once(cb: EventCb<T>): Promise<() => void> {
    const wrapped: EventCb<T> = (e) => {
      this.cbs.delete(wrapped);
      cb(e);
    };
    this.cbs.add(wrapped);
    return Promise.resolve(() => {
      this.cbs.delete(wrapped);
    });
  }

  emit(payload: T): void {
    this.cbs.forEach((cb) => cb({ payload, event: "mock", id: 0 }));
  }
}

const sessionMessageEvent = new MockEmitter<SessionMessageEvent>();
const sessionPermissionEvent = new MockEmitter<SessionPermissionEvent>();
// Never emitted by a scenario (nothing withdraws a mock permission), but it MUST exist:
// `useGlobalSessionEvents` attaches every listener at App mount, so a missing emitter is
// `undefined.listen()` — which takes the whole app down in the browser mock, not just the
// events it carries. Any event added to `bindings.ts` has to be mirrored here.
const sessionPermissionResolvedEvent = new MockEmitter<SessionPermissionResolvedEvent>();
const sessionStateEvent = new MockEmitter<SessionStateEvent>();
const sessionCommandsEvent = new MockEmitter<SessionCommandsEvent>();
const sessionTaskEvent = new MockEmitter<SessionTaskEvent>();
const sessionTitleEvent = new MockEmitter<SessionTitleEvent>();
const sessionSummaryEvent = new MockEmitter<SessionSummaryEvent>();
// No real bridge in the browser mock — never fires, but must exist so the composer's
// Remote Control chip / event router can subscribe without crashing.
const sessionRemoteControlEvent = new MockEmitter<SessionRemoteControlEvent>();
// No real Codex app-server in the browser mock — never fires, but must exist so the
// global event router can subscribe without crashing.
const sessionCodexPlanUsageEvent = new MockEmitter<SessionCodexPlanUsageEvent>();
// Extensions v2 + accounts: never fire in the mock, but the global router subscribes.
const sessionExtensionsChangedEvent = new MockEmitter<SessionExtensionsChangedEvent>();
const accountLoginEvent = new MockEmitter<AccountLoginEvent>();
// The TOSSE live channel. No socket in the browser mock, so no CRM change ever arrives —
// but the STATE event is emitted by `tosseLiveStart`/`Stop` below, so the indicator and the
// host's reconnection handling run for real here.
const tosseCrmEvent = new MockEmitter<TosseCrmEvent>();
const tosseLiveStateEvent = new MockEmitter<TosseLiveStateEvent>();
const tickEvent = new MockEmitter<TickEvent>();
// No real filesystem in the browser mock — these never fire, but must exist so
// the editor's `useFsWatch` can subscribe without crashing.
const fsChangeEvent = new MockEmitter<FsChangeEvent>();
// Pushed by `watchWorkflowJournal` below, so the workflow demo exercises the live readout.
const workflowJournalEvent = new MockEmitter<WorkflowJournalEvent>();
const fsWatchErrorEvent = new MockEmitter<FsWatchErrorEvent>();
// No real PTY in the browser mock — these never fire, but must exist so the
// integrated terminal can subscribe without crashing.
const terminalOutputEvent = new MockEmitter<TerminalOutputEvent>();
const terminalExitEvent = new MockEmitter<TerminalExitEvent>();
// No app-hosted MCP server in the browser mock — never fires, but must exist so
// the AppControlHost can subscribe without crashing.
const appControlRequestEvent = new MockEmitter<AppControlRequestEvent>();

export const mockEvents = {
  sessionMessageEvent,
  sessionPermissionEvent,
  sessionPermissionResolvedEvent,
  sessionStateEvent,
  sessionCommandsEvent,
  sessionTaskEvent,
  sessionTitleEvent,
  sessionSummaryEvent,
  sessionRemoteControlEvent,
  sessionCodexPlanUsageEvent,
  sessionExtensionsChangedEvent,
  accountLoginEvent,
  tosseCrmEvent,
  tosseLiveStateEvent,
  tickEvent,
  fsChangeEvent,
  fsWatchErrorEvent,
  workflowJournalEvent,
  terminalOutputEvent,
  terminalExitEvent,
  appControlRequestEvent,
};

// ---- Per-session scenario wiring -------------------------------------------

interface SessionRecord {
  driver: ScenarioDriver;
  lastState: SessionStatePayload;
}

const records = new Map<string, SessionRecord>();

function getRecord(session: string): SessionRecord {
  let rec = records.get(session);
  if (!rec) {
    let lastState = idleState();
    const driver = new ScenarioDriver({
      state: (s) => {
        rec!.lastState = s;
        sessionStateEvent.emit({ session, state: s });
      },
      item: (item) => sessionMessageEvent.emit({ session, item }),
      permission: (request) => sessionPermissionEvent.emit({ session, request }),
      task: (task) => sessionTaskEvent.emit({ session, task }),
    });
    rec = { driver, lastState };
    records.set(session, rec);
  }
  return rec;
}

const ok = <T>(data: T): Result<T, string> => ({ status: "ok", data });
const err = <T>(error: string): Result<T, string> => ({ status: "error", error });

// In-memory voice-bridge state for the browser mock (no real listener).
const mockVoiceBridge: VoiceBridgeStatus = {
  enabled: false,
  running: false,
  port: 7068,
  token: "mock-voice-token",
  url: null,
  error: null,
};

// In-memory wake-word state for the browser mock (no real capture / models).
const mockWake: WakeStatus = {
  enabled: false,
  phrase: "alexa",
  sensitivity: 0.5,
  running: false,
  error: null,
  phrases: [
    { key: "alexa", label: "Alexa" },
    { key: "hey_jarvis", label: "Hey Jarvis" },
  ],
};

// In-memory voice-agent key state for the browser mock (no real Keychain).
const mockVoiceAgent: VoiceAgentStatus = {
  configured: false,
  key_hint: null,
};

// In-memory remote-access state for the browser mock (no real relay connection).
const mockRemote: RemoteStatus = {
  enabled: false,
  connected: false,
  relay_url: "https://relay-production-8fd4.up.railway.app",
  mac_id: "mock-mac-id",
  phone_token: "mock-phone-token",
  pairing_url: "https://relay-production-8fd4.up.railway.app/#macId=mock-mac-id&pt=mock-phone-token",
  pairing_qr_svg: null,
  error: null,
};

let mockCounter = 0;
/** Distinguishes the wire uuids the mock hands back for successive sends. */
let mockSentCounter = 0;

// ---- TOSSE briefing fixture ------------------------------------------------
// Shaped like `GET /api/v1/briefing/morning`: active projects with their client and open
// tasks, paused projects by name only, and the project-less tasks. Mutated in place by the
// write commands so the demo behaves like the real thing.

function demoTask(
  id: string,
  title: string,
  status: string,
  extra: Partial<TosseTask> = {},
): TosseTask {
  return {
    id,
    title,
    status,
    priority: "Moyenne",
    kind: "Code",
    assignedTo: "Alexandre",
    dueDate: null,
    notes: null,
    subtaskCount: 0,
    subtaskDone: 0,
    ...extra,
  };
}

// One client with a website (its mark resolves to that domain's favicon) and one with
// neither logo nor site (it falls back to initials on a hashed gradient) — so a demo run
// exercises BOTH ends of the avatar cascade instead of only the empty one.
const demoClientInterne = {
  id: "c-interne",
  name: "Interne",
  logoUrl: null,
  website: "https://anthropic.com",
};
const demoClientWd = { id: "c-wd", name: "Webdentiste", logoUrl: null, website: null };

// The project → folder pins a demo run has made so far. In memory only: the mock has no
// database, and starting fresh on every reload is what makes the "asked once" behaviour
// visible in a demo.
const demoProjectRepos: TosseProjectRepo[] = [];

const demoBriefing: TosseBriefing = {
  projects: [
    {
      id: "p-tosse-code",
      name: "Tosse Code",
      status: "En cours",
      client: demoClientInterne,
      startDate: "2026-03-12T00:00:00.000Z",
      dueDate: null,
      taskCount: 58,
      taskDone: 41,
      tasks: [
        demoTask("t-lot2", "Lot 2 — vue « Tâches TOSSE » + écriture", "En cours", {
          priority: "Haute",
          subtaskCount: 4,
          subtaskDone: 1,
        }),
        demoTask("t-lot1", "Lot 1 — connexion (OAuth) + onglet Réglages", "Review", {
          priority: "Haute",
        }),
        demoTask("t-bypass", "Réglage « autoriser le mode Bypass permissions »", "Review"),
        demoTask("t-workflows", "Affichage live des workflows dans Flight Deck", "À faire", {
          assignedTo: "Les deux",
          subtaskCount: 4,
          subtaskDone: 1,
        }),
        demoTask("t-lot3", "Lot 3 — association conversation ↔ tâche", "À faire", {
          priority: "Haute",
        }),
        demoTask("t-readme", "Rédiger un README anglais", "À faire", {
          priority: "Basse",
          kind: "Rédaction",
        }),
      ],
    },
    {
      id: "p-crm",
      name: "TOSSE",
      status: "En cours",
      client: demoClientInterne,
      startDate: null,
      dueDate: "2026-08-15T00:00:00.000Z",
      taskCount: 28,
      taskDone: 16,
      tasks: [
        demoTask("t-bearer", "Bearer OAuth first-party sur /api/v1/*", "Review", {
          priority: "Urgente",
          // The CRM attributes actions taken through the MCP server this way, and it is how
          // most tasks Claude files show up — so the demo has to exercise that mark too.
          assignedTo: "MCP de Alexandre",
        }),
        demoTask("t-changelog", "Page changelog publique", "À faire", { assignedTo: "Armand" }),
      ],
    },
    {
      id: "p-santecall",
      name: "SanteCall 3.0 — Refonte plateforme",
      status: "En cours",
      client: demoClientWd,
      startDate: null,
      // Deliberately in the past: exercises the overdue styling.
      dueDate: "2026-07-28T00:00:00.000Z",
      taskCount: 31,
      taskDone: 9,
      tasks: [
        demoTask("t-volubile", "Migration Volubile → middleware provider", "En cours", {
          priority: "Urgente",
          assignedTo: "Armand",
          dueDate: "2026-08-02T00:00:00.000Z",
        }),
        demoTask("t-blocked", "Refonte du flux d'identification patient", "À faire", {
          priority: "Haute",
          assignedTo: "Armand",
        }),
      ],
    },
  ],
  pausedProjects: [
    {
      id: "p-mcp-santecall",
      name: "Serveur MCP SanteCall",
      status: "En pause",
      client: demoClientWd,
      startDate: null,
      dueDate: null,
      tasks: [],
      taskCount: 12,
      taskDone: 10,
    },
  ],
  // A project-less task has no card to live in — the view gives it its own band.
  generalTasks: [demoTask("t-admin", "Déclarer l'URSSAF du trimestre", "À faire", { kind: "Admin" })],
};

let demoNextId = 1;

/** The project shape a `/api/v1/tasks` row carries — less than the briefing's (no dates, no
 *  counts), which is exactly what makes a fabricated card a degraded one. */
function demoTaskProject(
  id: string,
  name: string,
  client: TosseTaskProject["client"] = null,
): TosseTaskProject {
  return { id, name, status: "En cours", client };
}

/** The task-row view of a project the BRIEFING already carries — projected from that entry,
 *  never retyped. Two copies of an id would let `offBoardProjectCards` stop recognising the
 *  project as briefed and fabricate a phantom card beside the real one; two copies of a name
 *  would have a row's detail panel disagree with the card it is rendered under. */
function demoBriefedProject(id: string): TosseTaskProject {
  const p = demoBriefing.projects.find((x) => x.id === id);
  if (!p) throw new Error(`demo fixture: no briefed project ${id}`);
  return demoTaskProject(p.id, p.name, p.client);
}

const demoProjTosseCode = demoBriefedProject("p-tosse-code");
const demoProjSanteCall = demoBriefedProject("p-santecall");
/** ⚠️ Deliberately ABSENT from `demoBriefing`: a project whose whole queue is off the board.
 *  Its card has to be BUILT from these rows, and a demo run is where that is seen. */
const demoProjArchi = demoTaskProject("p-archi", "Archipel — portail client", demoClientWd);

/**
 * The off-board rows by status, hoisted out of the `tosseTasksByStatus` command so
 * `tosseTaskDetail` can answer for them too. The real `GET /tasks/:id` knows every task
 * whatever its status — and a task the BRIEFING does not carry is precisely the one the app
 * has to be able to ask about (see `linkedTaskReconcile`), so a mock that 404s on it would
 * hide that path.
 *
 * Spread across projects the briefing HAS, one it does NOT, and the project-less band, so a
 * demo run exercises every place an off-board row can appear.
 */
const demoOffBoard: Record<string, TosseOffBoardTask[]> = {
  "En attente": [
    {
      project: demoProjSanteCall,
      task: demoTask("w-vpn", "Accès VPN au préprod client", "En attente", { priority: "Haute" }),
    },
    {
      project: demoProjArchi,
      task: demoTask("w-maquettes", "Validation des maquettes", "En attente", {
        priority: "Haute",
        assignedTo: "Les deux",
      }),
    },
    {
      project: demoProjArchi,
      task: demoTask("w-contrat", "Signature de l'avenant", "En attente", { kind: "Admin" }),
    },
    {
      project: null,
      task: demoTask("w-compta", "Retour du comptable sur le bilan", "En attente", {
        kind: "Admin",
      }),
    },
  ],
  Backlog: [
    {
      project: demoProjTosseCode,
      task: demoTask("b-mcp", "Serveur MCP de pilotage de l'IDE", "Backlog", { priority: "Haute" }),
    },
    {
      project: demoProjTosseCode,
      task: demoTask("b-readme", "Refondre la page d'accueil", "Backlog", {
        priority: "Basse",
        assignedTo: "Armand",
      }),
    },
    {
      project: demoProjSanteCall,
      task: demoTask("b-audit", "Audit de sécurité annuel", "Backlog"),
    },
    {
      project: null,
      task: demoTask("b-mutuelle", "Changer de mutuelle", "Backlog", { kind: "Admin" }),
    },
  ],
};

/** Every off-board row, whatever its status. */
function demoOffBoardRows(): TosseOffBoardTask[] {
  return Object.values(demoOffBoard).flat();
}

/** Every demo task with the project it belongs to, for the detail command. */
function demoAllTasks(): { task: TosseTask; projectId: string | null; projectName: string | null }[] {
  const rows = demoBriefing.projects.flatMap((p: TosseProject) =>
    p.tasks.map((task) => ({ task, projectId: p.id, projectName: p.name })),
  );
  return [
    ...rows,
    ...demoBriefing.generalTasks.map((task) => ({ task, projectId: null, projectName: null })),
    // The row carries its own project name, so a task of a project the briefing never sent
    // still resolves one — the very case the fabricated cards exist for.
    ...demoOffBoardRows().map((row) => ({
      task: row.task,
      projectId: row.project?.id ?? null,
      projectName: row.project?.name ?? null,
    })),
  ];
}

/**
 * Subtasks per parent task, created on first read and then KEPT — so ticking one in the
 * demo actually sticks, and the panel that shows it can be seen to refresh (or not).
 */
const demoSubtasksByParent = new Map<string, TosseTask[]>();

function demoSubtasks(parentId: string): TosseTask[] {
  let rows = demoSubtasksByParent.get(parentId);
  if (!rows) {
    rows = [
      demoTask(`${parentId}-st-1`, "Cadrage design", "Fait"),
      demoTask(`${parentId}-st-2`, "Vue + navigation ⌘3", "À faire"),
      demoTask(`${parentId}-st-3`, "Lecture briefing + groupement client", "À faire"),
      demoTask(`${parentId}-st-4`, "Écriture : statut + création", "À faire"),
    ];
    demoSubtasksByParent.set(parentId, rows);
  }
  return rows;
}

/** Apply a status write to a subtask wherever it lives. Returns true if one matched. */
function writeDemoSubtaskStatus(taskId: string, status: string): boolean {
  for (const rows of demoSubtasksByParent.values()) {
    const row = rows.find((r) => r.id === taskId);
    if (row) {
      row.status = status;
      return true;
    }
  }
  return false;
}

// ---- Commands (same shape as the generated facade) -------------------------

export const mockCommands = {
  async ping(msg: string): Promise<Pong> {
    return { ok: true, echo: msg, at_ms: Date.now() };
  },

  async fetchSlashCommands(_cwd: string): Promise<Result<SlashCommand[], string>> {
    return ok(MOCK_COMMANDS);
  },

  // Backend binary detection — stubbed "installed" for the browser mock (dev/Playwright)
  // so the composer's backend-aware controls render without a real `claude`/`codex`
  // binary. Both twins MUST exist: `binaryAvailable.probe()` calls `commands.xxx()`
  // synchronously, so a missing method throws a TypeError before its `.catch` is attached
  // → the always-mounted AuthWarningBar / Settings → Accounts crash the mock UI.
  async claudeAvailable(): Promise<boolean> {
    return true;
  },
  async codexAvailable(): Promise<boolean> {
    return true;
  },
  async codexListModels(): Promise<
    Result<
      { id: string; displayName: string; efforts: string[]; defaultEffort: string | null; isDefault: boolean }[],
      string
    >
  > {
    return ok([
      { id: "gpt-5.5", displayName: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", isDefault: true },
      { id: "gpt-5.4", displayName: "GPT-5.4", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", isDefault: false },
    ]);
  },
  async codexListSkills(_cwds: string[]): Promise<Result<{ name: string; description: string }[], string>> {
    return ok([{ name: "imagegen", description: "Generate an image" }]);
  },
  async codexCompact(_session: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async codexListExtensions(_cwd: string | null): Promise<Result<ExtensionsSnapshot, string>> {
    return ok({
      mcp_servers: [
        { name: "node_repl", scope: "user", transport: "stdio", command: "/opt/node_repl", url: null, source: null, enabled: true },
        { name: "railway", scope: "user", transport: "stdio", command: "railway", url: null, source: null, enabled: false },
      ],
      plugins: [
        { id: "browser@openai-bundled", name: "browser", marketplace: "openai-bundled", version: null, description: null, enabled: true, scope: "user", update_available: false, update_unproven: false, latest_version: null, skill_count: 0, agent_count: 0, command_count: 0, mcp_count: 0 },
      ],
      skills: [
        { name: "imagegen", description: "Generate an image", scope: "user", source: null, path: "/Users/x/.codex/skills/.system/imagegen/SKILL.md", enabled: true },
        { name: "off-skill", description: "A disabled skill (toggle demo)", scope: "user", source: null, path: "/Users/x/.codex/skills/off-skill/SKILL.md", enabled: false },
      ],
      agents: [],
      warnings: [],
    });
  },
  // ---- Extensions v2 (Codex) — toggles + live inventories, demo-shaped ----------
  async codexSetSkillEnabled(_path: string, enabled: boolean): Promise<Result<boolean, string>> {
    return ok(enabled);
  },
  async codexSetMcpEnabled(_name: string, _enabled: boolean): Promise<Result<boolean, string>> {
    // true = live sessions picked the change up (mirrors the real command's contract).
    return ok(true);
  },
  async codexSetPluginEnabled(_pluginId: string, _enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },
  async codexListPlugins(_cwds: string[]): Promise<Result<CodexPluginsLive, string>> {
    return ok({
      plugins: [
        {
          id: "documents@openai-primary-runtime",
          name: "documents",
          marketplace: "openai-primary-runtime",
          marketplacePath: "/Users/x/.cache/codex-runtimes/marketplace.json",
          displayName: "Documents",
          shortDescription: "Create and edit document artifacts",
          version: "26.630.12135",
          installed: true,
          enabled: true,
        },
        {
          id: "browser@openai-bundled",
          name: "browser",
          marketplace: "openai-bundled",
          marketplacePath: "/Users/x/.codex/plugins/marketplace.json",
          displayName: "Browser",
          shortDescription: "Control the in-app browser",
          version: "26.623.141536",
          installed: true,
          enabled: true,
        },
      ],
      marketplaces: [
        { name: "openai-primary-runtime", displayName: null, path: "/Users/x/.cache/codex-runtimes/marketplace.json", pluginCount: 1 },
        { name: "openai-bundled", displayName: null, path: "/Users/x/.codex/plugins/marketplace.json", pluginCount: 1 },
      ],
      loadErrors: [],
    });
  },
  async codexPluginContents(
    _pluginName: string,
    _marketplacePath: string | null,
    pluginId: string,
  ): Promise<Result<PluginContents, string>> {
    return ok({
      skills: [
        { name: "documents", description: "Create/edit .docx artifacts", scope: "plugin", source: pluginId, path: "/Users/x/.codex/plugins/cache/documents/SKILL.md", enabled: true },
      ],
      agents: [],
      mcp_servers: [],
    });
  },
  async codexListHooks(_cwds: string[]): Promise<Result<CodexHooksSnapshot, string>> {
    return ok({
      hooks: [
        {
          key: "user:preToolUse:0",
          eventName: "preToolUse",
          handlerType: "command",
          command: "./scripts/lint-guard.sh",
          source: "user",
          sourcePath: "/Users/x/.codex/hooks.toml",
          pluginId: null,
          enabled: true,
          trustStatus: "trusted",
        },
      ],
      warnings: [],
      errors: [],
    });
  },
  async codexMarketplaceAdd(_source: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async codexMarketplaceRemove(_name: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async codexMarketplaceUpgrade(_name: string | null): Promise<Result<null, string>> {
    return ok(null);
  },
  // ---- Accounts (Claude & Codex) — demo statuses ----------------------------------
  async accountClaudeStatus(): Promise<Result<ClaudeAccountStatus, string>> {
    return ok({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "demo@example.com",
      orgName: "Demo Org",
      subscriptionType: "max",
    });
  },
  async accountClaudeLoginStart(): Promise<Result<string, string>> {
    return ok("https://claude.ai/oauth/demo");
  },
  async accountClaudeLoginCode(_code: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async accountClaudeLoginCancel(): Promise<Result<null, string>> {
    return ok(null);
  },
  async accountClaudeLogout(): Promise<Result<null, string>> {
    return ok(null);
  },
  async accountCodexStatus(): Promise<Result<CodexAccountStatus, string>> {
    return ok({ loggedIn: true, authMethod: "chatgpt", email: "demo@example.com", planType: "plus" });
  },
  async accountCodexLoginStart(): Promise<Result<CodexLoginStart, string>> {
    return ok({ loginId: "demo-login", authUrl: "https://auth.openai.com/demo" });
  },
  async accountCodexLoginCancel(): Promise<Result<null, string>> {
    return ok(null);
  },
  async accountCodexLogout(): Promise<Result<null, string>> {
    return ok(null);
  },
  // ---- TOSSE (the CRM) — demo connection ------------------------------------------
  async tosseStatus(): Promise<Result<TosseAccountStatus, string>> {
    return ok({
      connected: true,
      name: "Demo User",
      email: "demo@example.com",
      signedOutReason: null,
      identityError: null,
    });
  },
  async tosseLoginStart(): Promise<Result<string, string>> {
    return ok("https://tosse.example/oauth/demo");
  },
  async tosseLoginCancel(): Promise<Result<null, string>> {
    return ok(null);
  },
  async tosseLogout(): Promise<Result<null, string>> {
    return ok(null);
  },
  // The live channel: there is no socket in the browser mock, so no CRM change ever
  // arrives — but the state is announced through the SAME event the core uses, so the
  // indicator and the host's reconnection handling are exercised rather than stubbed.
  // Reported as `live` (not `off`) so the toolbar shows its normal state instead of a
  // permanent warning about a connection this build was never going to make.
  async tosseLiveStart(): Promise<Result<null, string>> {
    tosseLiveStateEvent.emit({
      status: { state: "live", detail: null, attempts: 0, connections: 1 },
    });
    return ok(null);
  },
  async tosseLiveStop(): Promise<Result<null, string>> {
    tosseLiveStateEvent.emit({
      status: { state: "off", detail: null, attempts: 0, connections: 0 },
    });
    return ok(null);
  },
  // The demo repo, matched to a CRM repository from its git remote — enough to exercise the
  // badge's linked state and the whole card (url, linked project, Markdown context). Any
  // OTHER folder has no entry here, so it renders the un-associated state (hollow mark on
  // hover) and its picker lists the three repositories below.
  async tosseRepoLinks(): Promise<Result<TosseRepoLinksPayload, string>> {
    const repositories: TosseRepository[] = [
      {
        id: "crm-tosse-code",
        name: "tosse-code",
        url: "https://github.com/Alex375/tosse-code",
        host: "github",
        status: "Actif",
        context:
          "# tosse-code\n\nDesktop app to drive Claude Code.\n\n- **Stack**: Tauri 2, Rust, React\n- Ships as *Flight Deck*.",
        projects: [{ id: "p-tosse-code", name: "Tosse Code", status: "En cours" }],
      },
      {
        id: "crm-api",
        name: "TOSSE",
        url: "https://github.com/Alex375/CRM_max",
        host: "github",
        status: "Actif",
        context: null,
        projects: [{ id: "p-crm", name: "TOSSE", status: "En cours" }],
      },
      {
        id: "crm-archived",
        name: "old-prototype",
        url: null,
        host: "github",
        status: "Archivé",
        context: null,
        projects: [],
      },
    ];
    const links: TosseRepoLink[] = [
      {
        repoId: "repo-demo",
        resolved: true,
        notARepository: false,
        remoteUrl: "git@github.com:Alex375/tosse-code.git",
        repository: repositories[0],
        source: "remote",
        manualRepositoryId: null,
        ambiguous: [],
        remoteError: null,
      },
    ];
    return ok({ connected: true, links, repositories, error: null });
  },
  async tosseLinkRepository(): Promise<Result<null, string>> {
    return ok(null);
  },
  // Project → local folder pins. MUTABLE (like the briefing below), so a demo run
  // exercises the real "asked once, then remembered" path: pick a folder for a project
  // and the next Start goes straight there instead of asking again.
  // Two clones "on disk" the demo repo does not know about, so the "found on this Mac"
  // path is exercisable without touching a real filesystem.
  async scanLocalGitRepos(urls: string[]): Promise<Result<LocalRepoScan, string>> {
    const known: Record<string, { path: string; remoteUrl: string }[]> = {
      "https://github.com/Alex375/CRM_max": [
        { path: "/Users/dev/work/CRM_max", remoteUrl: "git@github.com:Alex375/CRM_max.git" },
      ],
      "https://github.com/Alex375/tosse-code": [
        { path: "/Users/dev/demo-repo", remoteUrl: "git@github.com:Alex375/tosse-code.git" },
      ],
    };
    const matches = urls.flatMap((u) =>
      (known[u] ?? []).map((m) => ({ ...m, matchedUrl: u })),
    );
    return ok({ matches, truncated: false, unreadable: [], visited: 42, elapsedMs: 12 });
  },
  async tosseProjectRepos(): Promise<Result<TosseProjectRepo[], string>> {
    return ok([...demoProjectRepos]);
  },
  async tosseLinkProjectRepo(
    projectId: string,
    repoId: string | null,
  ): Promise<Result<null, string>> {
    const at = demoProjectRepos.findIndex((p) => p.project_id === projectId);
    if (at >= 0) demoProjectRepos.splice(at, 1);
    if (repoId) demoProjectRepos.push({ project_id: projectId, repo_id: repoId });
    return ok(null);
  },
  // ---- TOSSE tasks view -------------------------------------------------------------
  // The demo briefing is MUTABLE: status changes and creations write into it, so the demo
  // exercises the real optimistic-update path (row moves, counts follow) instead of
  // snapping back on the next refetch.
  async tosseBriefing(): Promise<Result<TosseBriefing, string>> {
    return ok(demoBriefing);
  },
  // The real one is derived from the discovered `authorization_endpoint`; the demo answers
  // the production frontend so "Open in TOSSE" is clickable in a mock run too.
  async tosseWebUrl(): Promise<Result<string, string>> {
    return ok("https://frontend-production-7e11.up.railway.app");
  },
  // Each off-board status comes from its own request (the briefing excludes them all) — see
  // `demoOffBoard`. An unknown status answers with nothing rather than pretending: the real
  // core refuses anything outside its whitelist.
  async tosseTasksByStatus(status: string): Promise<Result<TosseOffBoardTask[], string>> {
    return ok(demoOffBoard[status] ?? []);
  },
  async tosseTaskDetail(taskId: string): Promise<Result<TosseTaskDetail, string>> {
    const found = demoAllTasks().find((row) => row.task.id === taskId);
    if (!found) return err(`no task with id ${taskId}`);
    // `subtaskDone` is DERIVED, as the server derives it
    // (`task.subtasks.filter(s => s.status === 'Fait').length`) — a frozen count would make
    // the panel's own header disagree with the checkboxes right underneath it.
    const subtasks = found.task.subtaskCount > 0 ? demoSubtasks(found.task.id) : [];
    return ok({
      task: {
        ...found.task,
        subtaskDone: subtasks.filter((st) => st.status === "Fait").length,
      },
      projectId: found.projectId,
      projectName: found.projectName,
      context:
        "## Périmètre\n\nListe des projets **groupés par client**, tâches triées par statut.\n\n- Écriture : statut + création\n- États dégradés : hors-ligne, session expirée",
      content: null,
      // MUTABLE, like the briefing above: ticking a subtask has to be visible in the demo,
      // otherwise a write that never reaches the open panel looks exactly like one that
      // does — the very bug this band of the UI shipped with.
      subtasks,
      blockedBy:
        found.task.id === "t-lot3"
          ? [{ id: "t-lot2", title: "Lot 2 — vue « Tâches TOSSE »", status: "En cours", resolved: false }]
          : [],
      blocks: [],
    });
  },
  async tosseSetTaskStatus(taskId: string, status: string): Promise<Result<null, string>> {
    // One id always refuses, so the demo can show what a rejected write looks like.
    if (taskId === "t-blocked") return err("Task is blocked by « Lot 1 » and cannot be started");
    // A subtask ticked in the detail panel — its own list, not the board.
    if (writeDemoSubtaskStatus(taskId, status)) return ok(null);
    // Mirrors the server's briefing filter — a task moved to any of these leaves the board,
    // not just « Fait » (briefing.service.ts: notIn ['Archivé','Fait','Backlog','En attente']).
    const leavesTheBoard = ["Fait", "Backlog", "En attente", "Archivé"].includes(status);

    // Lift the task out of wherever it is, remembering its project — the demo has to MOVE it
    // between the briefing and the off-board lists, exactly as the server does. A mock that
    // only deleted it would make a correct optimistic patch look like a bug on refetch (the
    // row would come back missing), and would hide the very behaviour this fixture is for.
    let task: TosseTask | null = null;
    let project: TosseTaskProject | null = null;
    for (const p of demoBriefing.projects) {
      const t = p.tasks.find((x) => x.id === taskId);
      if (!t) continue;
      task = t;
      project = demoTaskProject(p.id, p.name, p.client);
      p.tasks = p.tasks.filter((x) => x.id !== taskId);
      break;
    }
    // Project-less tasks are a real band of the view, so the demo has to move them too:
    // a mock that silently accepted the write without changing anything could not show the
    // difference between an applied write and a swallowed one.
    if (!task) {
      const g = demoBriefing.generalTasks.find((x) => x.id === taskId);
      if (g) {
        task = g;
        demoBriefing.generalTasks = demoBriefing.generalTasks.filter((x) => x.id !== taskId);
      }
    }
    if (!task) {
      for (const [key, rows] of Object.entries(demoOffBoard)) {
        const row = rows.find((r) => r.task.id === taskId);
        if (!row) continue;
        task = row.task;
        project = row.project;
        demoOffBoard[key] = rows.filter((r) => r.task.id !== taskId);
        break;
      }
    }
    if (!task) return ok(null);

    task.status = status;
    if (!leavesTheBoard) {
      const card = project ? demoBriefing.projects.find((p) => p.id === project.id) : null;
      if (card) card.tasks.push(task);
      else if (!project) demoBriefing.generalTasks.push(task);
      else {
        // ⚠️ A project the briefing does not carry yet (the `p-archi` fixture) still has to
        // keep its task SOMEWHERE. There is no server behind this mock to "start listing it one
        // refetch later": dropping it here removed the row from every demo collection at once —
        // gone from the board, gone from `demoAllTasks()`, and `tosseTaskDetail` began erroring
        // on it. So the demo does what the server would end up doing, immediately: the project
        // joins the briefing with its task.
        demoBriefing.projects.push({
          id: project.id,
          name: project.name,
          status: project.status,
          client: project.client,
          startDate: null,
          dueDate: null,
          tasks: [task],
          taskCount: 1,
          taskDone: 0,
        });
      }
    } else if (status in demoOffBoard) {
      demoOffBoard[status].push({ project, task });
    }
    // « Fait » / « Archivé » land nowhere, which is what closing a task means here.
    return ok(null);
  },
  async tosseSetProjectStatus(projectId: string, status: string): Promise<Result<null, string>> {
    const p = demoBriefing.projects.find((x) => x.id === projectId);
    if (p) p.status = status;
    return ok(null);
  },
  async tosseCreateTask(
    projectId: string,
    title: string,
    status: string,
    kind: string | null,
    priority: string | null,
    assignedTo: string | null,
  ): Promise<Result<TosseTask, string>> {
    const created: TosseTask = {
      id: `t-new-${demoNextId++}`,
      title,
      status,
      priority: priority ?? "Moyenne",
      kind: kind ?? "Code",
      assignedTo: assignedTo ?? "Alexandre",
      dueDate: null,
      notes: null,
      subtaskCount: 0,
      subtaskDone: 0,
    };
    demoBriefing.projects.find((p) => p.id === projectId)?.tasks.push(created);
    return ok(created);
  },

  async spawnSession(
    _repoPath: string,
    _resume: string | null,
    model: string | null,
    effort: string | null,
    permissionMode: string | null,
    ultracode: boolean,
    _backend: "claude" | "codex",
    _allowBypassPermissions?: boolean,
    _appControl?: boolean,
  ): Promise<Result<string, string>> {
    // Unique id per spawn so multiple browser conversations don't collide.
    const session = `mock-session-${++mockCounter}`;
    const rec = getRecord(session);
    // Emit the initial idle state + the slash-command catalogue once listeners
    // have had a tick to subscribe (mirrors the core's initialize handshake).
    // Seed the controls from the spawn args (mirrors the real core's seeding +
    // get_settings read-back), so the indicator reflects the spawned state.
    setTimeout(() => {
      const base = idleState();
      rec.lastState = {
        ...base,
        model: model ?? base.model,
        effort: effort ?? base.effort,
        ultracode,
        permission_mode: permissionMode ?? base.permission_mode,
      };
      sessionStateEvent.emit({ session, state: rec.lastState });
      sessionCommandsEvent.emit({ session, commands: MOCK_COMMANDS });
    }, 30);
    return ok(session);
  },

  async sendMessage(
    session: string,
    _text: string,
    _images: ImageAttachment[],
    codexControls: CodexControls | null,
  ): Promise<Result<string, string>> {
    // No actor to apply the per-turn Codex overrides to — log them so a dev/Playwright
    // run driving the demo Codex conversation can observe they were actually folded in.
    if (codexControls) console.info("[mock] sendMessage codexControls:", codexControls);
    const demo =
      typeof location !== "undefined"
        ? new URLSearchParams(location.search).get("demo")
        : null;
    const driver = getRecord(session).driver;
    if (demo === "question") driver.startQuestion();
    else if (demo === "background") driver.startBackground();
    else if (demo === "shell") driver.startShell();
    else if (demo === "monitor") driver.startMonitor();
    else if (demo === "workflow") driver.startWorkflow();
    else driver.start();
    // A stable-ish wire uuid so the demo exercises the same "this bubble is addressable"
    // path as production (the demo has no queue, so cancelling it always reports false).
    return ok(`mock-uuid-${session}-${mockSentCounter++}`);
  },

  async cancelQueuedMessage(_session: string, _messageUuid: string): Promise<Result<boolean, string>> {
    // No command queue in the demo → nothing is ever removed, which is the same answer
    // the binary gives for a message that already started running.
    return ok(false);
  },

  async answerPermission(
    session: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<Result<null, string>> {
    getRecord(session).driver.resolvePermission(requestId, decision);
    return ok(null);
  },

  async setPermissionMode(
    session: string,
    mode: PermissionMode,
  ): Promise<Result<null, string>> {
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, permission_mode: mode };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async setModel(session: string, model: string): Promise<Result<null, string>> {
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, model };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async setEffortLevel(
    session: string,
    level: string,
  ): Promise<Result<null, string>> {
    // Mirror the real core's read-back: a plain level clears ultracode, then the
    // state reflects the applied effort.
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, effort: level, ultracode: false };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async setUltracode(session: string): Promise<Result<null, string>> {
    // Ultra code = xhigh effort + the separate flag (read-back equivalent).
    const rec = getRecord(session);
    rec.lastState = { ...rec.lastState, effort: "xhigh", ultracode: true };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async setRemoteControl(
    session: string,
    enabled: boolean,
    _name: string | null,
  ): Promise<Result<RemoteControlState, string>> {
    // No real bridge in the browser mock — synthesize a plausible connected state
    // (with a fake claude.ai/code URL) so the composer chip is exercised end to end.
    const state: RemoteControlState = enabled
      ? {
          status: "connected",
          session_url: `https://claude.ai/code?session=mock-${session}`,
          error: null,
          pairing_code: null,
        }
      : { status: "disconnected", session_url: null, error: null, pairing_code: null };
    return ok(state);
  },

  async generateConversationTitle(
    session: string,
    description: string,
    seq: number,
  ): Promise<Result<null, string>> {
    // No real model in the browser mock — synthesize a plausible short title from
    // the description and emit it (echoing `seq`) like the core would, so the
    // auto-title behavior is exercised end to end in dev/Playwright.
    setTimeout(() => {
      const words = description.trim().replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");
      const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : "New conversation";
      sessionTitleEvent.emit({ session, title, seq });
    }, 40);
    return ok(null);
  },

  async generateMessageSummary(
    session: string,
    text: string,
    seq: number,
  ): Promise<Result<null, string>> {
    // No real model in the browser mock — synthesize a plausible ≤6-word summary from
    // the message and emit it (echoing `seq`), so the Flight Deck summary line is
    // exercised end to end in dev/Playwright.
    setTimeout(() => {
      const summary = text.trim().replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");
      if (summary) sessionSummaryEvent.emit({ session, summary, seq });
    }, 40);
    return ok(null);
  },

  async interruptSession(session: string): Promise<Result<null, string>> {
    getRecord(session).driver.interrupt();
    return ok(null);
  },

  async listSessionModels(_session: string): Promise<Result<LiveModel[], string>> {
    return ok([]);
  },

  async rewindFiles(
    _session: string,
    _userMessageId: string,
    _dryRun: boolean,
  ): Promise<Result<RewindFilesResult, string>> {
    // No file checkpoints in the demo: report the same refusal the binary gives when
    // checkpointing is off, so the UI exercises its "cannot rewind" path.
    return ok({
      can_rewind: false,
      files_changed: [],
      insertions: 0,
      deletions: 0,
      error: "File rewinding is not enabled.",
    });
  },

  async stopSession(session: string): Promise<Result<null, string>> {
    const rec = getRecord(session);
    rec.driver.reset();
    rec.lastState = { ...rec.lastState, busy: false, ended: true };
    sessionStateEvent.emit({ session, state: rec.lastState });
    return ok(null);
  },

  async stopTask(session: string, taskId: string): Promise<Result<null, string>> {
    // Mirror the core: the CLI kills the task, which settles to `stopped` via its
    // `task_*` lifecycle. The driver re-emits the known bg task snapshot as stopped
    // (a background Bash command or a Monitor watch).
    getRecord(session).driver.stopTask(taskId);
    return ok(null);
  },

  async readTaskOutputFile(path: string): Promise<Result<string | null, string>> {
    // No on-disk output file in the browser mock — the mock derives the demo task id from
    // the file's basename (`…/tasks/<task_id>.output`) and serves canned logs so the
    // task-output popover (Bash command output AND Monitor event streams) renders
    // real-shaped content (and tails) in dev/Playwright.
    const taskId = path.split("/").pop()?.replace(/\.output$/, "") ?? "";
    return ok(mockTaskOutput(taskId));
  },

  async openInTerminal(cwd: string, sessionId: string, backend: Backend): Promise<Result<null, string>> {
    // No OS terminal in the browser mock — log what the real command would run,
    // backend-aware like the core's resume_invocation (`claude --resume` vs
    // `codex resume`; same id, different CLI syntax).
    const resume = backend === "codex" ? `codex resume ${sessionId}` : `claude --resume ${sessionId}`;
    console.info(`[mock] openInTerminal: cd ${cwd} && ${resume}`);
    return ok(null);
  },

  async loadSessionHistory(sessionId: string): Promise<Result<ConversationItem[], string>> {
    // No real on-disk transcript in the browser mock. For the history panel's demo rows
    // return a representative transcript so the PREVIEW pane renders real-shaped content
    // in dev/Playwright; otherwise empty ("nothing to replay" → reload stays a no-op and
    // keeps whatever the live scenario already rendered).
    if (HISTORY_DEMO_SESSION_IDS.has(sessionId)) return ok(DEMO_HISTORY_TRANSCRIPT);
    return ok([]);
  },

  async codexLoadHistory(threadId: string): Promise<Result<ConversationItem[], string>> {
    // No real rollout in the browser mock. For the demo Codex conversation return a
    // representative cold timeline (messages + Bash + ApplyPatch cards) so the reload
    // rendering is exercisable in dev/Playwright; otherwise empty.
    if (threadId === "codex-thread-demo") return ok(DEMO_CODEX_HISTORY);
    return ok([]);
  },

  async loadSubagentTranscript(
    _sessionId: string,
    _agentId: string,
  ): Promise<Result<ConversationItem[], string>> {
    // No on-disk transcript in the browser mock — return a representative sample so
    // the transcript popover renders real-shaped content in dev/Playwright.
    return ok(DEMO_SUBAGENT_TRANSCRIPT);
  },

  async loadWorkflowRun(
    _sessionId: string,
    _runId: string,
  ): Promise<Result<WorkflowRun | null, string>> {
    // Mirror reality: the manifest exists only once the run is DONE. While running, null →
    // the modal shows its live overview; after, the rich 3-panel view.
    return ok(isDemoWorkflowDone() ? DEMO_WORKFLOW_RUN : null);
  },

  async loadWorkflowJournal(
    _sessionId: string,
    _runId: string,
  ): Promise<Result<WorkflowJournal | null, string>> {
    // Live per-agent progress (the mid-run signal), consistent with the demo's 2 wire ticks
    // (r-correctness done, r-perf running). Grows to "all done" once the run finishes.
    return ok(demoWorkflowJournal());
  },

  async watchWorkflowJournal(sessionId: string, runId: string): Promise<Result<null, string>> {
    // The real watcher pushes a snapshot as soon as it attaches; mirror that, or the mock's
    // card and detail modal would sit at "starting…" forever (no filesystem in the browser).
    setTimeout(
      () =>
        workflowJournalEvent.emit({
          session_id: sessionId,
          run_id: runId,
          journal: demoWorkflowJournal(),
          error: null,
        }),
      0,
    );
    return ok(null);
  },

  async unwatchWorkflowJournal(_sessionId: string, _runId: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async loadWorkflowPhases(
    _sessionId: string,
    _runId: string,
  ): Promise<Result<WorkflowPhase[], string>> {
    // The declared phase list (from the script's meta) — available from t=0, so the live
    // overview can show upcoming steps. Mirror the demo run's phases.
    return ok(DEMO_WORKFLOW_RUN.phases ?? []);
  },

  async loadSessionContext(_sessionId: string): Promise<Result<ContextFill, string>> {
    // No transcript in the browser mock; the scenario's baseState already carries a
    // context fill, so nothing to seed here.
    return ok({ context_tokens: null, context_window: null });
  },

  async loadSessionGoal(_sessionId: string): Promise<Result<GoalState | null, string>> {
    // No transcript in the browser mock; goal-active scenarios seed the goal store directly.
    return ok(null);
  },

  async rewindConversation(
    _sessionId: string,
    _targetId: string,
    _targetIsUser: boolean,
    _targetText: string | null,
    _occurrence: number | null,
  ): Promise<Result<RewindOutcome, string>> {
    // No on-disk transcript in the browser mock — a benign no-op outcome.
    return ok({ removed_prompt: null, removed_lines: 0 });
  },

  async forkConversation(
    _sessionId: string,
    _targetId: string,
    _targetIsUser: boolean,
    _targetText: string | null,
    _occurrence: number | null,
  ): Promise<Result<ForkOutcome, string>> {
    // No on-disk transcript in the browser mock — echo a placeholder branch row.
    return ok({
      conversation: {
        session_id: "mock-fork",
        cwd: "/mock",
        repo_root: "/mock",
        git_branch: null,
        title: null,
        excerpt: "fork (mock)",
        mtime_ms: 0,
        backend: "claude",
      },
      removed_prompt: null,
    });
  },

  async listDiskConversations(): Promise<Result<DiskConversation[], string>> {
    // A representative set so the history panel renders real-shaped rows in
    // dev/Playwright (two repos, one orphan-style worktree conversation).
    return ok(MOCK_DISK_CONVERSATIONS);
  },

  async primeHistoryIndex(): Promise<Result<number, string>> {
    return ok(MOCK_DISK_CONVERSATIONS.length);
  },

  async searchConversations(query: string): Promise<Result<SearchHit[], string>> {
    const q = query.trim().toLowerCase();
    if (!q) return ok([]);
    const hits: SearchHit[] = MOCK_DISK_CONVERSATIONS.filter(
      (c) =>
        (c.title ?? "").toLowerCase().includes(q) || c.excerpt.toLowerCase().includes(q),
    ).map((c, i) => ({ session_id: c.session_id, score: 100 - i, snippet: c.excerpt }));
    return ok(hits);
  },

  async getPlanUsage(): Promise<Result<PlanUsage, UsageError>> {
    // No real OAuth endpoint in the browser; return plausible fills so the Plan
    // section of the context popover renders in dev/Playwright. Reset ~2h / ~3d out,
    // as ISO 8601 strings (matching the live endpoint shape).
    const iso = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();
    // Build the ok-arm directly: `ok()` fixes the error type to string, but this
    // command's Result error is UsageError. The mock never takes the error path.
    return {
      status: "ok",
      data: {
        five_hour: { used_percentage: 42, resets_at: iso(2 * 3600) },
        seven_day: { used_percentage: 67, resets_at: iso(3 * 86400) },
        // A model-scoped weekly cap, as the live endpoint reports it: named after the
        // model and — when the window has never started — with no reset at all.
        scoped: [
          { label: "Fable", group: "weekly", window: { used_percentage: 0, resets_at: null } },
        ],
      },
    };
  },

  // ---- Persistence: in-memory only (no real db in the browser). The store
  // boots empty and persists are no-ops, which is the correct dev behaviour.
  async loadPersistedState(): Promise<Result<PersistedState, string>> {
    // Adding a repo needs the native folder picker (absent in the browser), so the
    // mock boots empty by default. With any `?demo` flag, seed one repo + conversation
    // so the dev/Playwright build has something to drive (e.g. `?demo=background`).
    const demo =
      typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
    if (!demo) return ok({ repos: [], conversations: [], active_id: null });
    const now = Date.now();
    return ok({
      repos: [{ id: "repo-demo", path: "/Users/dev/demo-repo", added_at: now }],
      conversations: [
        {
          id: "conv-demo",
          name: "Background tasks demo",
          repo_id: "repo-demo",
          cwd: "/Users/dev/demo-repo",
          created_at: now,
          last_activity_at: now,
          session_id: MOCK_SESSION_ID,
          model: "claude-opus-4-8",
          effort: "xhigh",
          ultracode: false,
          permission_mode: "auto",
          pending_reminder: null,
          clean_output: null,
          // Linked to a task the demo briefing carries, so the conversation↔task band is
          // exercisable in dev: the header chip, and the delete confirmation's task snippet.
          // « En cours » here and « Review » on the Codex row below, to cover both badges.
          tosse_task_id: "t-lot2",
          tosse_task_title: "Lot 2 — vue « Tâches TOSSE » + écriture",
          tosse_task_status: "En cours",
          backend: "claude",
        },
        // A Codex conversation so the mixed-fleet identity (backend badge, neutral avatar,
        // Codex picker icon) is exercisable in dev/Playwright. Renders live through the same
        // mock driver; only `backend` drives the brand marks.
        {
          id: "conv-demo-codex",
          name: "Codex demo",
          repo_id: "repo-demo",
          cwd: "/Users/dev/demo-repo",
          created_at: now - 1,
          last_activity_at: now - 1,
          // A persisted thread id so selecting it exercises the Codex COLD-load path
          // (rollout reader) — `codexLoadHistory` returns a representative timeline below.
          session_id: "codex-thread-demo",
          model: "gpt-5.5",
          effort: "high",
          ultracode: false,
          permission_mode: "auto",
          pending_reminder: null,
          clean_output: null,
          tosse_task_id: "t-lot1",
          tosse_task_title: "Lot 1 — connexion (OAuth) + onglet Réglages",
          tosse_task_status: "Review",
          backend: "codex",
        },
      ],
      active_id: "conv-demo",
    });
  },

  async upsertRepo(_repo: RepoRecord): Promise<Result<null, string>> {
    return ok(null);
  },

  async deleteRepo(_id: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async upsertConversation(_conversation: ConversationRecord): Promise<Result<null, string>> {
    return ok(null);
  },

  async deleteConversation(_id: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async setActiveConversation(_id: string | null): Promise<Result<null, string>> {
    return ok(null);
  },

  async wipeAllData(): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- App control (the app-hosted MCP servers) ----
  // No Rust hub in the browser mock: responding is accepted (and dropped), the
  // journal publish is a no-op, and the voice bridge pretends to apply configs
  // in memory so the Settings card is fully exercisable.

  async appControlRespond(
    _requestId: string,
    _result: unknown,
    _error: string | null,
  ): Promise<Result<null, string>> {
    return ok(null);
  },

  async publishControlEvent(
    _kind: string,
    _conversationId: string,
    _title: string,
    _detail: unknown,
  ): Promise<void> {},

  async voiceBridgeStatus(): Promise<VoiceBridgeStatus> {
    return { ...mockVoiceBridge };
  },

  async setVoiceBridge(
    enabled: boolean | null,
    port: number | null,
    regenerateToken: boolean,
  ): Promise<Result<VoiceBridgeStatus, string>> {
    if (enabled !== null) mockVoiceBridge.enabled = enabled;
    if (port !== null) mockVoiceBridge.port = port;
    if (regenerateToken) mockVoiceBridge.token = `mock-token-${Date.now()}`;
    mockVoiceBridge.running = mockVoiceBridge.enabled;
    mockVoiceBridge.url = mockVoiceBridge.running
      ? `http://127.0.0.1:${mockVoiceBridge.port}/mcp`
      : null;
    return ok({ ...mockVoiceBridge });
  },

  // ---- In-app voice agent ----
  // No Keychain / OpenAI in the browser mock: the key "stores" in memory so the
  // Settings card is exercisable, but a session can never start (clear error).

  async voiceAgentStatus(): Promise<Result<VoiceAgentStatus, string>> {
    return ok({ ...mockVoiceAgent });
  },

  async setVoiceAgentKey(key: string): Promise<Result<VoiceAgentStatus, string>> {
    if (key.trim().length < 20) return err("that is too short to be an OpenAI API key");
    mockVoiceAgent.configured = true;
    mockVoiceAgent.key_hint = `sk-…${key.trim().slice(-4)}`;
    return ok({ ...mockVoiceAgent });
  },

  async clearVoiceAgentKey(): Promise<Result<VoiceAgentStatus, string>> {
    mockVoiceAgent.configured = false;
    mockVoiceAgent.key_hint = null;
    return ok({ ...mockVoiceAgent });
  },

  async voiceAgentClientSecret(): Promise<Result<ClientSecret, string>> {
    return err("the voice agent is not available in the browser mock");
  },

  // ---- Wake word ----
  // No real microphone / ONNX models in the browser mock: the config "sticks" so
  // the Settings rows are exercisable, but the detector can never actually run.

  async wakeWordStatus(): Promise<WakeStatus> {
    return { ...mockWake };
  },

  async setWakeWordConfig(
    enabled: boolean | null,
    phrase: string | null,
    sensitivity: number | null,
  ): Promise<Result<WakeStatus, string>> {
    if (enabled !== null) mockWake.enabled = enabled;
    if (phrase !== null) mockWake.phrase = phrase;
    if (sensitivity !== null) mockWake.sensitivity = Math.min(1, Math.max(0, sensitivity));
    // The mock has no capture backend, so "running" can never be true.
    mockWake.running = false;
    mockWake.error = mockWake.enabled
      ? "the wake-word detector is not available in the browser mock"
      : null;
    return ok({ ...mockWake });
  },

  async appControlTools(_surface: string): Promise<Result<unknown, string>> {
    return ok({ tools: [] });
  },

  async folderTree(
    path: string | null,
    _depth: number | null,
  ): Promise<Result<FolderTree, string>> {
    return ok({
      root: path ?? "/Users/demo",
      tree: "Documents/\n  repositories/\n    demo-app/ (git repo)\nDesktop/",
      truncated: false,
    });
  },

  async remoteStatus(): Promise<RemoteStatus> {
    return { ...mockRemote };
  },

  async setRemote(
    enabled: boolean | null,
    relayUrl: string | null,
    regeneratePairing: boolean,
  ): Promise<Result<RemoteStatus, string>> {
    if (enabled !== null) mockRemote.enabled = enabled;
    if (relayUrl !== null && relayUrl.trim()) mockRemote.relay_url = relayUrl.trim();
    if (regeneratePairing) mockRemote.phone_token = `mock-pt-${Date.now()}`;
    mockRemote.pairing_url = `${mockRemote.relay_url.replace(/\/$/, "")}/#macId=${mockRemote.mac_id}&pt=${mockRemote.phone_token}`;
    mockRemote.connected = mockRemote.enabled;
    return ok({ ...mockRemote });
  },

  async setAwake(_awake: boolean): Promise<Result<null, string>> {
    // No real power assertion in the browser/dev mock — the toggle is inert here.
    return ok(null);
  },

  async setUiZoom(factor: number): Promise<Result<null, string>> {
    // There is no OS webview to ask in the browser/dev mock, so approximate its page zoom
    // with the CSS one — enough to see the stepper and ⌘+/⌘−/⌘0 actually do something while
    // developing. ⚠️ It is an APPROXIMATION, not the shipped mechanism: CSS zoom scales the
    // coordinate space that `position: fixed` popovers measure themselves against, so a
    // portalled menu can land slightly off HERE and be perfectly placed in the real app
    // (which scales the whole page at the webview level). Judge popover placement under
    // `/build-app`, not in the browser.
    document.documentElement.style.zoom = factor === 1 ? "" : String(factor);
    return ok(null);
  },

  async claudeCliStatus(): Promise<ClaudeCliStatus> {
    // Dev/Playwright: pretend the CLI is installed and current, auto-update on. Add
    // `?cliUpdate` to the URL to get the "update available" state instead (banner + the
    // Settings card's primary action) — otherwise it's only reachable when Anthropic
    // happens to publish a newer version than the one installed. `?cliLocked` gives the
    // auto-update-held-off-by-`~/.claude.json` state (greyed switch + its explanation), which
    // otherwise needs a real install carrying `autoUpdates:false` without the native-install
    // protection — any install method can be in that state, npm is just the usual one.
    const params = new URLSearchParams(location.search);
    const pending = params.has("cliUpdate");
    const locked = params.has("cliLocked");
    return {
      installed_version: "2.1.220",
      latest_version: pending ? "2.1.221" : "2.1.220",
      update_available: pending,
      auto_update_enabled: !locked,
      auto_update_locked: locked,
      install_method: locked ? "npm" : "native",
      channel: "latest",
      config_warning: null,
    };
  },

  async claudeCliUpdate(): Promise<Result<ClaudeUpdateOutcome, string>> {
    return ok({
      updated: false,
      from: null,
      to: "2.1.220",
      message: "Claude Code is up to date (2.1.220)",
    });
  },

  async setClaudeCliAutoUpdate(_enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Git worktrees: in-memory, no real `git` in the browser. Seeds a single
  // main worktree per repo so the indicator/manager render, and reflects
  // create/remove so the UI can be exercised end to end in dev/Playwright.
  async listWorktrees(repoPath: string): Promise<Result<WorktreeInfo[], string>> {
    return ok(mockWorktreeList(repoPath));
  },

  async worktreeStatus(_worktreePath: string): Promise<Result<WorktreeStatus, string>> {
    return ok({ dirty: false, untracked: false, changed_files: 0, ahead: null, behind: null });
  },

  async createWorktree(
    repoPath: string,
    branch: string,
    _baseRef: string | null,
    _newBranch: boolean,
  ): Promise<Result<WorktreeInfo, string>> {
    const list = mockWorktreeList(repoPath);
    const wt: WorktreeInfo = {
      path: `${repoPath.replace(/\/+$/, "")}/.claude/worktrees/${branch.replace(/\//g, "-")}`,
      branch,
      head: "1".repeat(40),
      is_main: false,
      is_detached: false,
      is_locked: false,
      is_bare: false,
    };
    mockWorktrees.set(repoPath, [...list, wt]);
    return ok(wt);
  },

  async removeWorktree(
    repoPath: string,
    worktreePath: string,
    _force: boolean,
  ): Promise<Result<null, string>> {
    mockWorktrees.set(
      repoPath,
      mockWorktreeList(repoPath).filter((w) => w.path !== worktreePath),
    );
    return ok(null);
  },

  async pathExists(path: string): Promise<boolean> {
    // A `__throw__` path simulates a transport rejection (exercises the paste
    // collision-probe error path). Otherwise everything "exists" by default so the
    // worktree spawn flow runs unchanged — except a `__free__` path, which reports
    // missing so a paste's collision probe resolves to the bare name at once.
    if (path.includes("__throw__")) throw new Error("mock pathExists transport failure");
    return !path.includes("__free__");
  },

  // ---- Git history / source control: synthetic data so the Git panel renders in
  // dev/Playwright (no real `git` in the browser). A small DAG with a merge lets
  // the graph layout be eyeballed; writes are accepted as no-ops.
  async gitStatus(_cwd: string): Promise<Result<GitStatus, string>> {
    return ok(MOCK_GIT_STATUS);
  },
  async gitDiff(_cwd: string, path: string): Promise<Result<GitDiff, string>> {
    return ok({
      path,
      old_text: "export function greet(name) {\n  return `Hi ${name}`;\n}\n",
      new_text: "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
      is_binary: false,
      old_label: "HEAD",
      new_label: "Working tree",
    });
  },
  async gitLog(_cwd: string, limit: number, skip: number): Promise<Result<CommitInfo[], string>> {
    return ok(skip >= MOCK_GIT_LOG.length ? [] : MOCK_GIT_LOG.slice(skip, skip + limit));
  },
  async gitBranches(_cwd: string): Promise<Result<BranchInfo[], string>> {
    return ok(MOCK_GIT_BRANCHES);
  },
  async gitCommitFiles(_cwd: string, _oid: string): Promise<Result<CommitFile[], string>> {
    return ok([
      { path: "src/app.ts", orig_path: null, status: "M" },
      { path: "src/new.ts", orig_path: null, status: "A" },
    ]);
  },
  async gitCommitFileDiff(
    _cwd: string,
    oid: string,
    path: string,
  ): Promise<Result<GitDiff, string>> {
    const short = oid.slice(0, 7);
    // A hunk with internal modify + delete — the case the single-trapezoid ribbon
    // used to skew; lets the per-charChange sub-ribbons be eyeballed in dev.
    return ok({
      path,
      old_text:
        'import { foo } from "./foo";\n\nfunction greet(name) {\n  const msg = "hi " + name;\n  log(msg);\n  return msg;\n}\n',
      new_text:
        'import { foo } from "./foo";\n\nfunction greet(name: string): string {\n  const greeting = `Hi ${name}`;\n  return greeting;\n}\n',
      is_binary: false,
      old_label: `${short}^`,
      new_label: short,
    });
  },
  async gitCommit(_cwd: string, _message: string): Promise<Result<string, string>> {
    return ok("deadbee");
  },
  async gitPush(_cwd: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async gitPull(_cwd: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async gitFetch(_cwd: string): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Editor filesystem: a tiny synthetic tree so the editor panel renders in
  // the browser/dev build (the real fs is only reachable in the Tauri app).
  // Sentinels `__fail__` (error Result) and `__throw__` (thrown rejection, like a
  // real transport Error) let the unit tests exercise the editor's error paths.
  async readDir(path: string): Promise<Result<FsEntry[], string>> {
    if (path.includes("__throw__")) throw new Error("mock readDir transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock readDir failed" };
    return ok(mockDir(path));
  },

  async readFile(path: string): Promise<Result<FileContent, string>> {
    if (path.includes("__throw__")) throw new Error("mock readFile transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock readFile failed" };
    return ok(mockFile(path));
  },

  async readImage(path: string): Promise<Result<ImageContent, string>> {
    if (path.includes("__throw__")) throw new Error("mock readImage transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock readImage failed" };
    // A 1×1 transparent PNG — enough for the dev/browser build to exercise the
    // image viewer path without a real filesystem.
    const data_base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    return ok({
      path,
      data_base64,
      too_large: false,
      size: mockBytesSize(path),
      mtime_ms: mockMtimeMs(path),
    });
  },

  async statFiles(paths: string[]): Promise<Result<FileStat[], string>> {
    if (paths.some((p) => p.includes("__throw__"))) throw new Error("mock statFiles transport failure");
    if (paths.some((p) => p.includes("__fail__"))) return { status: "error", error: "mock statFiles failed" };
    return ok(
      paths.map((path) => ({
        path,
        // `__gone__` simulates a path that vanished between two checks.
        exists: !path.includes("__gone__"),
        size: mockSize(path),
        mtime_ms: mockMtimeMs(path),
      })),
    );
  },

  async writeFile(_path: string, _content: string): Promise<Result<null, string>> {
    return ok(null);
  },

  // Mutating tree ops (explorer context menu). Same `__fail__`/`__throw__`
  // sentinels so unit tests can drive both the success and the error-surfacing
  // paths deterministically without a real filesystem.
  async createFile(path: string): Promise<Result<null, string>> {
    if (path.includes("__throw__")) throw new Error("mock createFile transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock createFile failed" };
    return ok(null);
  },

  async createDir(path: string): Promise<Result<null, string>> {
    if (path.includes("__throw__")) throw new Error("mock createDir transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock createDir failed" };
    return ok(null);
  },

  async renameEntry(from: string, to: string): Promise<Result<null, string>> {
    if (from.includes("__throw__") || to.includes("__throw__"))
      throw new Error("mock renameEntry transport failure");
    if (from.includes("__fail__") || to.includes("__fail__"))
      return { status: "error", error: "mock renameEntry failed" };
    return ok(null);
  },

  async copyEntry(from: string, to: string): Promise<Result<null, string>> {
    if (from.includes("__throw__") || to.includes("__throw__"))
      throw new Error("mock copyEntry transport failure");
    if (from.includes("__fail__") || to.includes("__fail__"))
      return { status: "error", error: "mock copyEntry failed" };
    return ok(null);
  },

  async deleteToTrash(path: string): Promise<Result<null, string>> {
    if (path.includes("__throw__")) throw new Error("mock deleteToTrash transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock deleteToTrash failed" };
    return ok(null);
  },

  async revealInFinder(path: string): Promise<Result<null, string>> {
    if (path.includes("__throw__")) throw new Error("mock revealInFinder transport failure");
    if (path.includes("__fail__")) return { status: "error", error: "mock revealInFinder failed" };
    return ok(null);
  },

  async watchDir(_path: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async unwatchDir(): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Integrated terminal: no real PTY in the browser mock. The commands are
  // no-ops so the terminal panel mounts without crashing (it just shows an empty
  // shell — output/exit events never fire here).
  async terminalOpen(
    _id: string,
    _cwd: string,
    _cols: number,
    _rows: number,
  ): Promise<Result<null, string>> {
    return ok(null);
  },

  async terminalWrite(_id: string, _data: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async terminalResize(_id: string, _cols: number, _rows: number): Promise<Result<null, string>> {
    return ok(null);
  },

  async terminalClose(_id: string): Promise<Result<null, string>> {
    return ok(null);
  },

  // ---- Extensions (MCP / plugins / skills / agents) — demo fixtures --------
  // Without these, the extensions manager calls `undefined(...)` in `?demo=` mode.
  async listExtensions(_repoPath: string): Promise<Result<ExtensionsSnapshot, string>> {
    return ok({ mcp_servers: [], plugins: [], skills: [], agents: [], warnings: [] });
  },
  async listPluginContents(_repoPath: string, _pluginId: string): Promise<Result<PluginContents, string>> {
    return ok({ skills: [], agents: [], mcp_servers: [] });
  },
  async setPluginEnabled(_pluginId: string, _enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },
  async listMarketplaces(): Promise<Result<MarketplaceInfo[], string>> {
    return ok([
      { name: "tosse-plugins", source: "Alex375/tosse-claude-plugin", auto_update: true },
      { name: "claude-plugins-official", source: "anthropics/claude-plugins-official", auto_update: false },
    ]);
  },
  async setMarketplaceAutoUpdate(_name: string, _enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },
  async setAllMarketplacesAutoUpdate(_enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },
  async refreshPluginMarketplaces(_name: string | null): Promise<Result<null, string>> {
    return ok(null);
  },
  async updatePlugin(_pluginId: string, _scope: string | null, _path: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async reloadPlugins(_session: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpStatus(_session: string): Promise<Result<McpServerLive[], string>> {
    return ok([]);
  },
  async mcpToggle(_session: string, _serverName: string, _enabled: boolean): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpReconnect(_session: string, _serverName: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpClearAuth(_session: string, _serverName: string): Promise<Result<null, string>> {
    return ok(null);
  },
  async mcpAuthenticate(_session: string, _serverName: string): Promise<Result<McpAuthResult, string>> {
    return ok({ auth_url: null, requires_user_action: false, error: null });
  },
};

/** A two-level synthetic directory listing for the browser/dev editor. */
function mockDir(path: string): FsEntry[] {
  const base = path.replace(/\/+$/, "");
  if (base.endsWith("/src")) {
    return [
      { name: "App.tsx", path: `${base}/App.tsx`, is_dir: false },
      { name: "main.tsx", path: `${base}/main.tsx`, is_dir: false },
    ];
  }
  return [
    { name: "src", path: `${base}/src`, is_dir: true },
    { name: "README.md", path: `${base}/README.md`, is_dir: false },
    { name: "package.json", path: `${base}/package.json`, is_dir: false },
  ];
}

// ---- Simulated disk mutations ----------------------------------------------
//
// The mock is otherwise deterministic, which makes "the agent rewrote this file
// while you weren't looking" — the exact case the editor's staleness check
// exists for — impossible to express. So each path carries a revision a caller
// can bump: content, size and mtime all derive from it, moving together the way
// a real rewrite moves them. Without this, `statFiles` could only ever answer
// "unchanged" and no test could tell a working refresh from a broken one.

const mockRevisions = new Map<string, number>();
/** Epoch ms of revision 0 — fixed, so a mock mtime is reproducible. */
const MOCK_MTIME_BASE = 1_700_000_000_000;

/** Simulate an external write to `path` (an agent editing the file on disk). */
export function touchMockFile(path: string): void {
  mockRevisions.set(path, (mockRevisions.get(path) ?? 0) + 1);
}

/** Reset every simulated write (call between tests). */
export function resetMockDisk(): void {
  mockRevisions.clear();
}

function mockRevision(path: string): number {
  return mockRevisions.get(path) ?? 0;
}

function mockMtimeMs(path: string): number {
  return MOCK_MTIME_BASE + mockRevision(path) * 1000;
}

/** Paths the mock serves as raw bytes (`readImage`) rather than text. */
function isMockBytesPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|pdf)$/i.test(path);
}

/** Byte size the mock reports for a bytes path — must match what `readImage`
 *  returns, or every stat would look like a change and re-read forever. */
function mockBytesSize(path: string): number {
  return 70 + mockRevision(path);
}

/** Synthetic file content for the browser/dev editor. */
function mockFile(path: string): FileContent {
  const name = path.split("/").pop() ?? path;
  const mtime_ms = mockMtimeMs(path);
  // Test sentinels: simulate a file that is binary / exceeds the size limit on
  // disk. Both return empty content, mirroring the Rust read_file guards.
  if (path.includes("__binary__"))
    return { path, content: "", too_large: false, binary: true, size: 1024, mtime_ms };
  if (path.includes("__toolarge__"))
    return { path, content: "", too_large: true, binary: false, size: 99_000_000, mtime_ms };
  let content = `// ${name}\n// (mock file — browser/dev build, no real filesystem)\n`;
  if (name.endsWith(".md")) {
    content = `# ${name}\n\nMock markdown for the dev build.\n\n- one\n- two\n`;
  } else if (name.endsWith(".json")) {
    content = `{\n  "name": "mock",\n  "version": "0.0.0"\n}\n`;
  }
  // A simulated write changes the bytes, exactly as the real thing would.
  const rev = mockRevision(path);
  if (rev > 0) content += `// revision ${rev}\n`;
  return { path, content, too_large: false, binary: false, size: content.length, mtime_ms };
}

/** Size the mock's `statFiles` reports — the same number the matching reader
 *  returns for that path (text vs bytes), so stat and read never disagree. */
function mockSize(path: string): number {
  return isMockBytesPath(path) ? mockBytesSize(path) : mockFile(path).size;
}

// Synthetic git state for dev/Playwright. A small DAG with one merge so the
// graph layout (rails diverging/merging) is visible without a real repo.
const MOCK_GIT_FILES: GitFileEntry[] = [
  {
    path: "src/app.ts",
    orig_path: null,
    index_status: "M",
    worktree_status: ".",
    staged: true,
    unstaged: false,
    untracked: false,
  },
  {
    path: "src/util.ts",
    orig_path: null,
    index_status: ".",
    worktree_status: "M",
    staged: false,
    unstaged: true,
    untracked: false,
  },
  {
    path: "notes.txt",
    orig_path: null,
    index_status: ".",
    worktree_status: "?",
    staged: false,
    unstaged: true,
    untracked: true,
  },
];
const MOCK_GIT_STATUS: GitStatus = {
  branch: "main",
  head: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  unborn: false,
  files: MOCK_GIT_FILES,
};
function mockCommit(
  oid: string,
  parents: string[],
  subject: string,
  ts: number,
  refs: string[] = [],
): CommitInfo {
  return {
    oid: oid.padEnd(40, oid[0] ?? "0"),
    short_oid: oid.slice(0, 7),
    parents: parents.map((p) => p.padEnd(40, p[0] ?? "0")),
    author_name: "Alexandre",
    author_email: "a@tosse.dev",
    timestamp: ts,
    subject,
    refs,
  };
}
const MOCK_GIT_LOG: CommitInfo[] = [
  mockCommit("merge00", ["main001", "feat001"], "Merge feat into main", 1_710_000_600, [
    "HEAD",
    "main",
  ]),
  mockCommit("feat001", ["base001"], "Add the feature", 1_710_000_500, ["feature"]),
  mockCommit("main001", ["base001"], "Tweak the docs", 1_710_000_400, ["origin/main"]),
  mockCommit("base001", ["root001"], "Wire it up", 1_710_000_300, []),
  mockCommit("root001", [], "Initial commit", 1_710_000_200, ["tag: v0.1.0"]),
];
const MOCK_GIT_BRANCHES: BranchInfo[] = [
  {
    name: "main",
    oid: "merge00".padEnd(40, "m"),
    is_head: true,
    is_remote: false,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  },
  {
    name: "feature",
    oid: "feat001".padEnd(40, "f"),
    is_head: false,
    is_remote: false,
    upstream: null,
    ahead: null,
    behind: null,
  },
  {
    name: "origin/main",
    oid: "main001".padEnd(40, "o"),
    is_head: false,
    is_remote: true,
    upstream: null,
    ahead: null,
    behind: null,
  },
];

// Per-repo worktree set, seeded lazily with just the main worktree (== repoPath).
const mockWorktrees = new Map<string, WorktreeInfo[]>();
function mockWorktreeList(repoPath: string): WorktreeInfo[] {
  let list = mockWorktrees.get(repoPath);
  if (!list) {
    list = [
      {
        path: repoPath,
        branch: "main",
        head: "0".repeat(40),
        is_main: true,
        is_detached: false,
        is_locked: false,
        is_bare: false,
      },
    ];
    mockWorktrees.set(repoPath, list);
  }
  return list;
}

// Demo on-disk conversations for the history panel (dev/Playwright only).
const MOCK_DISK_CONVERSATIONS: DiskConversation[] = [
  {
    session_id: MOCK_SESSION_ID,
    cwd: "/Users/dev/demo-repo",
    repo_root: "/Users/dev/demo-repo",
    git_branch: "main",
    title: "Authentication rework",
    excerpt: "The deployment breaks at login, the server auth needs reworking",
    mtime_ms: Date.now() - 3_600_000,
    backend: "claude",
  },
  {
    session_id: "demo-orphan-2222",
    cwd: "/Users/dev/demo-repo/.claude/worktrees/feat-dark-mode",
    repo_root: "/Users/dev/demo-repo",
    git_branch: "feat/dark-mode",
    title: null,
    excerpt: "Add a dark mode toggle in settings",
    mtime_ms: Date.now() - 4 * 86_400_000,
    backend: "claude",
  },
  {
    session_id: "demo-other-3333",
    cwd: "/Users/dev/other-project",
    repo_root: "/Users/dev/other-project",
    git_branch: null,
    title: "CSV import script",
    excerpt: "Parse the CSV and insert the rows into the database",
    mtime_ms: Date.now() - 20 * 86_400_000,
    backend: "claude",
  },
  {
    // A Codex thread on disk (backend badge + rollout-backed preview via codexLoadHistory).
    // Its session_id matches the mock's `codex-thread-demo` cold timeline.
    session_id: "codex-thread-demo",
    cwd: "/Users/dev/demo-repo",
    repo_root: "/Users/dev/demo-repo",
    git_branch: "main",
    title: null,
    excerpt: "Give me a quick tour of the project",
    mtime_ms: Date.now() - 2 * 3_600_000,
    backend: "codex",
  },
];

// Session ids of the history-panel demo rows — their preview renders a sample transcript.
const HISTORY_DEMO_SESSION_IDS = new Set(MOCK_DISK_CONVERSATIONS.map((c) => c.session_id));

// A representative Codex COLD-load timeline (what `codex_load_history` reconstructs from a
// rollout): user turn + agent text + a Bash card and an ApplyPatch card, each paired with
// its result by `tool_use_id`. Mirrors the real reader's output shape so the reload
// rendering (tool cards, diff view) is verifiable in dev/Playwright without a real rollout.
const DEMO_CODEX_HISTORY: ConversationItem[] = [
  { kind: "user_message", id: "cx-u1", text: "Add a hello.txt file and list the folder", parent_tool_use_id: null, replay: false },
  { kind: "assistant_message", id: "cx-a1", parent_tool_use_id: null, blocks: [{ type: "text", text: "I'll create the file then list the folder." }] },
  { kind: "assistant_message", id: "cx-p1", parent_tool_use_id: null, blocks: [{ type: "tool_use", id: "cx-p1", name: "ApplyPatch", input: { changes: [{ path: "/Users/dev/demo-repo/hello.txt", kind: { type: "add" }, diff: "@@ -0,0 +1,2 @@\n+hello\n+world\n" }] } }] },
  { kind: "tool_result", tool_use_id: "cx-p1", is_error: false, parent_tool_use_id: null, content: { status: "completed", changes: [{ path: "/Users/dev/demo-repo/hello.txt", kind: { type: "add" }, diff: "@@ -0,0 +1,2 @@\n+hello\n+world\n" }] } },
  { kind: "assistant_message", id: "cx-t1", parent_tool_use_id: null, blocks: [{ type: "tool_use", id: "cx-t1", name: "Bash", input: { command: "ls -la", cwd: "/Users/dev/demo-repo" } }] },
  { kind: "tool_result", tool_use_id: "cx-t1", is_error: false, parent_tool_use_id: null, content: "total 8\n-rw-r--r--  1 dev  staff  12 hello.txt\n" },
  { kind: "assistant_message", id: "cx-a2", parent_tool_use_id: null, blocks: [{ type: "text", text: "Done: `hello.txt` created, folder listed." }] },
];
