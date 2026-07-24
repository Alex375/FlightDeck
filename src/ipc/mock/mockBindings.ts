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
  McpServerLive,
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
  SessionRemoteControlEvent,
  SessionStatePayload,
  SessionStateEvent,
  SessionTaskEvent,
  SessionTitleEvent,
  SessionSummaryEvent,
  SlashCommand,
  TerminalExitEvent,
  TerminalOutputEvent,
  TickEvent,
  UsageError,
  WorkflowJournal,
  WorkflowPhase,
  WorkflowRun,
  WorktreeInfo,
  WorktreeStatus,
} from "../bindings";
import { DEMO_SUBAGENT_TRANSCRIPT, DEMO_WORKFLOW_RUN, idleState, isDemoWorkflowDone, mockTaskOutput, MOCK_SESSION_ID, ScenarioDriver } from "./scenario";

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
const tickEvent = new MockEmitter<TickEvent>();
// No real filesystem in the browser mock — these never fire, but must exist so
// the editor's `useFsWatch` can subscribe without crashing.
const fsChangeEvent = new MockEmitter<FsChangeEvent>();
const fsWatchErrorEvent = new MockEmitter<FsWatchErrorEvent>();
// No real PTY in the browser mock — these never fire, but must exist so the
// integrated terminal can subscribe without crashing.
const terminalOutputEvent = new MockEmitter<TerminalOutputEvent>();
const terminalExitEvent = new MockEmitter<TerminalExitEvent>();

export const mockEvents = {
  sessionMessageEvent,
  sessionPermissionEvent,
  sessionStateEvent,
  sessionCommandsEvent,
  sessionTaskEvent,
  sessionTitleEvent,
  sessionSummaryEvent,
  sessionRemoteControlEvent,
  sessionCodexPlanUsageEvent,
  sessionExtensionsChangedEvent,
  accountLoginEvent,
  tickEvent,
  fsChangeEvent,
  fsWatchErrorEvent,
  terminalOutputEvent,
  terminalExitEvent,
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

let mockCounter = 0;

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
        { id: "browser@openai-bundled", name: "browser", marketplace: "openai-bundled", version: null, description: null, enabled: true, scope: "user", update_available: false, latest_version: null, skill_count: 0, agent_count: 0, command_count: 0, mcp_count: 0 },
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

  async spawnSession(
    _repoPath: string,
    _resume: string | null,
    model: string | null,
    effort: string | null,
    permissionMode: string | null,
    ultracode: boolean,
    _backend: "claude" | "codex",
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
  ): Promise<Result<null, string>> {
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
    return ok(null);
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
    if (HISTORY_DEMO_SESSION_IDS.has(sessionId)) return ok(DEMO_SUBAGENT_TRANSCRIPT);
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
    // Live progress counts (the mid-run signal), kept consistent with the demo's 2 wire ticks
    // (r-correctness done, r-perf running). Grows to "all done" once the run finishes.
    return ok(isDemoWorkflowDone() ? { started: 3, done: 3 } : { started: 2, done: 1 });
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

  async setAwake(_awake: boolean): Promise<Result<null, string>> {
    // No real power assertion in the browser/dev mock — the toggle is inert here.
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
