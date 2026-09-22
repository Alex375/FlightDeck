// Browser / Playwright fallback that mirrors the tauri-specta { commands, events }
// surface exactly, but emits scripted fixtures instead of talking to a Rust core.
// Selected at runtime by provider.ts when window.__TAURI_INTERNALS__ is absent.

import type {
  AddressCandidate,
  AgentRouting,
  Backend,
  BootstrapProgressEvent,
  BootstrapReport,
  BranchInfo,
  CommitFile,
  CommitInfo,
  ContextFill,
  ConversationItem,
  ConversationRecord,
  DiagnosisState,
  GoalState,
  DiskConversation,
  GeneratedKey,
  HostKeyFingerprintEvent,
  LoginResultReason,
  LoginSession,
  MachineProvisionStatus,
  MachineRecord,
  MachineRevokeStatus,
  RepairAction,
  RepairOutcome,
  ServerDiagnosis,
  ServerLoginPromptEvent,
  ServerLoginResultEvent,
  StepId,
  StepState,
  ClaudeAccountRecord,
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
  WakeWordEvent,
  ArtifactHostEvent,
  HostBounds,
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
  ManagedMemory,
  SpendReport,
  SubagentRouting,
} from "../bindings";
import { DEMO_HISTORY_TRANSCRIPT, DEMO_SUBAGENT_TRANSCRIPT, DEMO_WORKFLOW_RUN, demoContextFill, demoWorkflowJournal, idleState, isDemoWorkflowDone, mockTaskOutput, MOCK_SESSION_ID, ScenarioDriver } from "./scenario";


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
// No wake-word engine in the browser mock — never fires, but must exist so VoiceHost can
// subscribe without crashing the whole app on boot.
const wakeWordEvent = new MockEmitter<WakeWordEvent>();
// B12: the bootstrap wizard's live checklist — pushed by `bootstrapServer`/
// `bootstrapResume` below as they walk their scripted step sequence.
const bootstrapProgressEvent = new MockEmitter<BootstrapProgressEvent>();
// B12: the wizard's non-blocking host-key info line — pushed once by `bootstrapServer`
// on a scripted first-contact run.
const hostKeyFingerprintEvent = new MockEmitter<HostKeyFingerprintEvent>();
// B12: the inline Claude sign-in flow — pushed by `startClaudeLogin`/
// `submitClaudeLoginCode` below.
const serverLoginPromptEvent = new MockEmitter<ServerLoginPromptEvent>();
const serverLoginResultEvent = new MockEmitter<ServerLoginResultEvent>();
const artifactHostEvent = new MockEmitter<ArtifactHostEvent>();
/** The page the mock artifact host is "on" — mirrors the real host's `requested`/`page` state so
 *  reload and the no-op re-show behave as they do in the app. */
let mockArtifactHostPage: string | null = null;

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
  wakeWordEvent,
  bootstrapProgressEvent,
  hostKeyFingerprintEvent,
  serverLoginPromptEvent,
  serverLoginResultEvent,
  artifactHostEvent,
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
  debug_capture: false,
  debug_dir: null,
  debug_error: null,
  phrases: [
    { key: "alexa", label: "Alexa" },
    { key: "hey_jarvis", label: "Hey Jarvis" },
    { key: "ground_control", label: "Ground Control" },
  ],
};

// In-memory voice-agent key state for the browser mock (no real Keychain).
const mockVoiceAgent: VoiceAgentStatus = {
  configured: false,
  key_hint: null,
  // A couple of entries is enough to exercise the picker in the browser mock —
  // the real catalogue lives Rust-side (`voice/mod.rs`).
  voices: [
    { key: "marin", label: "Marin — warm, recommended" },
    { key: "cedar", label: "Cedar — calm, recommended" },
    { key: "verse", label: "Verse — narrative" },
  ],
  default_voice: "marin",
};

// In-memory remote-access state for the browser mock (no real relay connection).
const mockRemote: RemoteStatus = {
  enabled: false,
  connected: false,
  relay_url: "https://relay-production-8fd4.up.railway.app",
  mac_id: "mock-mac-id",
  phone_token: "mock-phone-token",
  mac_label: "This Mac",
  pairing_url: "https://relay-production-8fd4.up.railway.app/#macId=mock-mac-id&pt=mock-phone-token",
  pairing_qr_svg: null,
  error: null,
};

// ---- Remote servers (SSH) + B12 bootstrap wizard --------------------------------
// Pre-B12 the browser mock had NO implementation at all for the machine-pairing
// commands (`generateMachineKey`/`addMachine`/`deleteMachine`/`listRemoteRepos`/
// `listRemoteDir`/the phone-provisioning trio) — "Remote servers (SSH)" was entirely
// non-functional in `pnpm dev`. Filled in here alongside the new B12 commands so the
// whole card (legacy ticket flow included) is exercisable without a real Tauri host.

/** Paired servers, mutated in place by `addMachine`/`bootstrapServer`/`deleteMachine`
 *  below. `loadPersistedState` mirrors this array — see its own doc. */
const mockMachines: MachineRecord[] = [];
/** Each paired machine's CURRENT diagnosis — what `machineDiagnose` returns and
 *  `machineRepair` mutates. Seeded by `bootstrapServer`'s own scripted scenario, or by
 *  the `?demo=servers` fixture below. */
const mockDiagnoses = new Map<string, ServerDiagnosis>();
const mockProvisionStatuses = new Map<string, MachineProvisionStatus>();
const mockRevokeStatuses = new Map<string, MachineRevokeStatus>();
/** Hosts (well, `host:port`) a `HostKeyMismatch` failure was forgiven for — a
 *  `bootstrap_forget_host_key` retry then converges on the "happy" outcome instead of
 *  failing again, mirroring the real wizard's "forget & retry" affordance. */
const mockForgottenHostKeys = new Set<string>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors `orchestrator::collapse_state` closely enough for the mock's own repairs
 *  (below) to keep a machine's headline state honest after mutating its tri-state
 *  facts — see that function's doc for the real ordering/rationale. */
function collapseMockState(d: ServerDiagnosis): DiagnosisState {
  if (d.installed_as === "none") return { kind: "failed", reason: "flightdeckd is not installed" };
  if (d.installed_as === "unknown")
    return { kind: "failed", reason: "could not determine whether flightdeckd is installed" };
  if (d.daemon_running === false) return { kind: "failed", reason: "flightdeckd is not running" };
  if (d.daemon_running === null)
    return { kind: "failed", reason: "could not determine whether flightdeckd is running" };
  // (B14) Split, same as the real `collapse_state`: missing claude gets its OWN state,
  // distinct from installed-but-signed-out.
  if (d.claude_installed !== true) return { kind: "needs_claude_install" };
  if (d.claude_logged_in !== true) return { kind: "needs_claude_sign_in" };
  return d.reboot_safe === true ? { kind: "ready" } : { kind: "running_not_reboot_safe" };
}

function readyDiagnosis(): ServerDiagnosis {
  return {
    state: { kind: "ready" },
    installed_as: "system",
    daemon_running: true,
    daemon_version_disk: "0.4.2",
    daemon_version_running: "0.4.2",
    restart_pending: false,
    reboot_safe: true,
    linger: null,
    sleep_masked: true,
    user_unit_missing_path: null,
    claude_installed: true,
    claude_logged_in: true,
    claude_email: "demo@example.com",
    tailscale_name: "mock-server.tail1234.ts.net",
    last_boot: "2026-09-15 08:12:03",
    busy_conversations: 0,
    bundled_daemon_version: null,
    daemon_outdated: false,
  };
}

const STEP_SEQUENCE: StepId[] = [
  "install_key",
  "probe",
  "install_claude",
  "upload_daemon",
  "run_init",
  "install_service",
  "escalate_persistence",
  "claude_auth",
  "add_machine",
  "diagnose",
];

type MockScenario = "happy" | "sudo" | "hostkey" | "fail" | "claude" | "restart";

/** Selects a scripted scenario from the ADDRESS field the wizard form was submitted
 *  with — a dev/Playwright-only convention (never shown to a real user; the trusted
 *  domains and real wire shapes are unaffected). Covers every needs_input kind the
 *  brief asks to verify visually: `sudo` → blocking sudo-password pause, `restart` →
 *  non-blocking restart-pending, `claude` → non-blocking Claude sign-in, `fail` → a
 *  hard failure, `hostkey` → `HostKeyMismatch` (retry via "forget the old key"),
 *  anything else → the full happy path. */
function scenarioFor(host: string): MockScenario {
  const h = host.toLowerCase();
  if (h.includes("hostkey") && !mockForgottenHostKeys.has(`${host}`)) return "hostkey";
  if (h.includes("sudo")) return "sudo";
  if (h.includes("fail")) return "fail";
  if (h.includes("claude")) return "claude";
  if (h.includes("restart")) return "restart";
  return "happy";
}

type MockStepOutcome =
  | { kind: "ok"; detail?: string }
  | { kind: "needs_input"; detail: string; blocking: boolean }
  | { kind: "failed"; detail: string };

/** One step's scripted outcome for `scenario` — `resuming` is true only for the ONE
 *  step `bootstrapResume` re-runs after a sudo password arrives (mirrors the real
 *  pipeline re-trying `escalate_persistence` with the password now available). */
function outcomeFor(scenario: MockScenario, id: StepId, resuming: boolean): MockStepOutcome {
  if (id === "install_key" && scenario === "hostkey") {
    return { kind: "failed", detail: "the server's host key does not match what was expected" };
  }
  if (id === "probe" && scenario === "fail") {
    return { kind: "failed", detail: "could not reach the server: connection refused" };
  }
  if (id === "escalate_persistence" && scenario === "sudo" && !resuming) {
    return {
      kind: "needs_input",
      detail: "this server needs a sudo password to finish persistence setup",
      blocking: true,
    };
  }
  if (id === "upload_daemon" && scenario === "restart") {
    return { kind: "needs_input", detail: "restart pending — 2 conversation(s) running", blocking: false };
  }
  if (id === "claude_auth" && scenario === "claude") {
    return { kind: "needs_input", detail: "Needs Claude sign-in", blocking: false };
  }
  const details: Partial<Record<StepId, string>> = {
    install_key: "Installed",
    probe: "arch=x86_64",
    install_claude: "2.1.211 (Claude Code)",
    upload_daemon: "Uploaded { restart_required: false }",
    install_service: "Installed { mechanism: System }",
    run_init: "Initialized",
    claude_auth: "demo@example.com",
    add_machine: "saved",
    diagnose: "Ready",
  };
  return { kind: "ok", detail: details[id] };
}

/** Advances the scripted pipeline from `fromIndex`, mutating and emitting `states`
 *  (already sized to the full 10-row checklist) after every transition — mirrors
 *  `orchestrator::run_steps`'s own "emit after every transition, stop on Failed or a
 *  blocking pause" shape closely enough for the UI's live checklist to exercise the
 *  same states a real run would. */
async function runMockPipeline(
  sessionId: string,
  host: string,
  states: StepState[],
  fromIndex: number,
  resuming: boolean,
): Promise<{ states: StepState[]; needsInput: StepId | null }> {
  const scenario = scenarioFor(host);
  const emit = () => bootstrapProgressEvent.emit({ session_id: sessionId, host, steps: states.map((s) => ({ ...s })) });
  emit();
  for (let i = fromIndex; i < STEP_SEQUENCE.length; i++) {
    const id = STEP_SEQUENCE[i];
    states[i] = { id, status: "running", detail: null };
    emit();
    await wait(220);
    if (id === "install_key" && i === 0) {
      // Mirrors `step_install_key`'s own host-key-fingerprint event, folded into this
      // same step — see the wizard's non-blocking info line.
      hostKeyFingerprintEvent.emit({ host, port: 22, fingerprint: "SHA256:mockFingerprint0000000000000000000", known: false });
    }
    const outcome = outcomeFor(scenario, id, resuming && id === "escalate_persistence");
    if (outcome.kind === "ok") {
      states[i] = { id, status: "ok", detail: outcome.detail ?? null };
      emit();
    } else if (outcome.kind === "needs_input") {
      states[i] = { id, status: "needs_input", detail: outcome.detail };
      emit();
      if (outcome.blocking) return { states, needsInput: id };
    } else {
      states[i] = { id, status: "failed", detail: outcome.detail };
      emit();
      return { states, needsInput: null };
    }
  }
  return { states, needsInput: null };
}

interface MockPausedSession {
  label: string;
  host: string;
  port: number;
  user: string;
  states: StepState[];
  pausedAtIndex: number;
}
const mockPausedSessions = new Map<string, MockPausedSession>();
/** In-flight Claude sign-in sessions (session_id → machine_id) — see
 *  `startClaudeLogin`/`submitClaudeLoginCode`/`cancelClaudeLogin` below. */
const mockLoginSessions = new Map<string, string>();
let mockLoginCounter = 0;

function findOrCreateMockMachine(label: string, host: string, port: number, user: string): MachineRecord {
  const existing = mockMachines.find((m) => m.host === host && m.port === port && m.user === user);
  if (existing) return existing;
  const machine: MachineRecord = {
    id: `mock-machine-${mockMachines.length + 1}-${Date.now()}`,
    label,
    host,
    port,
    user,
    identity_file: `/mock/ssh_keys/${host}`,
    added_at: Date.now(),
    addresses: [{ kind: "manual", value: host }],
    daemon_mac_id: `mac-${host}`,
    daemon_relay_url: "https://relay-production-8fd4.up.railway.app",
    daemon_label: label,
    phone_provisioned_at: null,
  };
  mockMachines.push(machine);
  return machine;
}

/** The final `ServerDiagnosis` for a just-finished scenario — independent tri-state
 *  facts consistent with that scenario's own step outcomes (see `outcomeFor`), so the
 *  status panel a wizard hands off to shows a diagnosis that actually matches what the
 *  checklist just did. */
function finalDiagnosisFor(scenario: MockScenario): ServerDiagnosis {
  const base = readyDiagnosis();
  if (scenario === "claude") {
    // (B14) The pipeline only ever PAUSES at `claude_auth`'s needs_input once
    // `install_claude` has already succeeded/skipped — so this scenario is "installed,
    // never signed in", never "not installed" (that's a DIFFERENT, earlier failure).
    return { ...base, claude_installed: true, claude_logged_in: false, claude_email: null, state: { kind: "needs_claude_sign_in" } };
  }
  if (scenario === "restart") {
    return { ...base, restart_pending: true, daemon_version_disk: "0.4.3", daemon_version_running: "0.4.2" };
  }
  return base;
}

let mockCounter = 0;
/** Distinguishes the wire uuids the mock hands back for successive sends. */
let mockSentCounter = 0;

/** The demo's EXTRA Claude accounts (the default one is not a row — it always exists).
 *  Seeded with one so the multi-account surfaces are reachable in dev/Playwright without
 *  going through the sign-in flow, and mutable so add / rename / remove actually do
 *  something in the browser build. */
type MockIdentity = {
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
};

/** The DEFAULT account's captured identity — what the app stores after signing that account
 *  in itself. Seeded so the demo names it by its address rather than the fallback. */
let mockDefaultIdentity: MockIdentity | null = {
  email: "demo@example.com",
  orgName: "Demo Org",
  subscriptionType: "max",
};

/** The demo's in-flight Claude sign-in, mirroring the core's single global login. */
let mockLoginInFlight: { accountId: string | null } | null = null;

const mockClaudeAccounts: ClaudeAccountRecord[] = [
  {
    id: "acct-b",
    label: "Work account",
    email: "demo-b@example.com",
    org_name: "Demo Org",
    subscription_type: "max",
    sort_index: 1,
    added_at: 0,
    label_is_generated: false,
  },
];

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

/**
 * A synthetic spend corpus with the same SHAPE as the real one: a handful of repos, a few
 * models, workflow runs dominating the total, and one deliberate disagreement (Explore
 * appearing on opus while it is configured for haiku) so the drift canary can be seen
 * firing without waiting for it to happen for real.
 *
 * Deterministic — a chart that reshuffles on every reload cannot be reviewed.
 */
function mockSpendReport(): SpendReport {
    const buckets: SpendReport["buckets"] = [];
    const repos = [
      ["/Users/demo/repos/tosse-code", "tosse-code"],
      ["/Users/demo/repos/santecall", "santecall"],
      ["/Users/demo/repos/Citadel", "Citadel"],
      // A deliberately long name: the label column is fixed, so this is the case that
      // proves the fade and the hover-for-full-path actually work.
      ["/Users/demo/repos/web_dentiste_middleware_api", "web_dentiste_middleware_api"],
    ];
    // A cheap deterministic pseudo-random so the numbers look lived-in but never move.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    // Days run UP TO TODAY, not from a frozen start date. The dashboard's default window
    // is the last 30 days and the drift canary looks at the last 7 — a fixture pinned to
    // absolute dates silently ages out of both, so the demo would show an empty chart and
    // no canary, which is precisely what a demo must not hide.
    const today = new Date();
    const day = (i: number) => {
      const d = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (20 - i)),
      );
      return d.toISOString().slice(0, 10);
    };
    for (let i = 0; i < 21; i++) {
      for (const [repo, label] of repos) {
        // Workflow runs: the bulk of the spend, on the expensive models.
        for (const model of ["claude-fable-5-1", "claude-opus-4-8"]) {
          const turns = rand(60) + (model === "claude-fable-5-1" ? 30 : 5);
          if (turns < 12) continue;
          buckets.push({
            day: day(i),
            repo,
            repo_label: label,
            agent: "workflow-subagent",
            model,
            workflow: true,
            turns,
            input_tokens: turns * 40,
            output_tokens: turns * (400 + rand(300)),
            cache_read_tokens: turns * 9000,
            cache_creation_tokens: turns * 1200,
          });
        }
        // Foreground helpers: far fewer turns.
        for (const [agent, model] of [
          ["Explore", "claude-opus-4-8"], // ← disagrees with the configured haiku
          ["general-purpose", "claude-sonnet-5"],
        ]) {
          const turns = rand(9);
          if (turns < 2) continue;
          buckets.push({
            day: day(i),
            repo,
            repo_label: label,
            agent,
            model,
            workflow: false,
            turns,
            input_tokens: turns * 30,
            output_tokens: turns * (200 + rand(200)),
            cache_read_tokens: turns * 7000,
            cache_creation_tokens: turns * 900,
          });
        }
      }
    }
    return {
      buckets,
      files_scanned: 931,
      files_unreadable: 0,
      lines_unparsed: 0,
      warnings: [],
    };
}

// ---- Commands (same shape as the generated facade) -------------------------

/** Mock-only: the current global output style, so a set is reflected by the next get. */
let mockOutputStyle = "default";

export const mockCommands = {
  async ping(msg: string): Promise<Pong> {
    return { ok: true, echo: msg, at_ms: Date.now() };
  },

  async fetchSlashCommands(_cwd: string): Promise<Result<SlashCommand[], string>> {
    return ok(MOCK_COMMANDS);
  },

  // Global output style (settings.json `outputStyle`) — mocked so the composer chip and the
  // Settings → Behavior card render in the browser mock (dev/Playwright) without a real
  // settings.json. Kept in a module-level var so a set is reflected by the next get.
  async getOutputStyle(): Promise<Result<string, string>> {
    return ok(mockOutputStyle);
  },
  async setOutputStyle(style: string): Promise<Result<null, string>> {
    mockOutputStyle = style;
    return ok(null);
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
      plugin_state_trusted: true,
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
  // (see `mockClaudeAccounts` below the object for the mutable demo account list)
  //
  // Two Claude accounts in the demo, so the multi-account surfaces are exercisable in
  // dev/Playwright: the composer's account chip only renders once a second one exists,
  // and the auto-switch policy needs somewhere to switch to.
  async accountClaudeStatus(accountId: string | null): Promise<Result<ClaudeAccountStatus, string>> {
    // An added account is signed in only once its identity was captured (i.e. after the
    // sign-in flow completed), so "Add account" yields a signed-out tile whose flow can be
    // exercised in dev/Playwright — as it is in the app.
    const added = accountId ? mockClaudeAccounts.find((a) => a.id === accountId) : null;
    const loggedIn = accountId === null || !!added?.email;
    return ok({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      email: accountId ? (added?.email ?? null) : "demo@example.com",
      orgName: "Demo Org",
      subscriptionType: "max",
    });
  },
  async accountClaudeLoginStart(accountId: string | null): Promise<Result<string, string>> {
    mockLoginInFlight = { accountId };
    return ok("https://claude.ai/oauth/demo");
  },
  async accountClaudeLoginCode(
    accountId: string | null,
    _code: string,
  ): Promise<Result<null, string>> {
    // Mirror the core's binding of the code to its account.
    if (!mockLoginInFlight) return { status: "error", error: "no Claude sign-in in progress" };
    if (mockLoginInFlight.accountId !== accountId) {
      return { status: "error", error: "this sign-in was superseded by one for another account" };
    }
    mockLoginInFlight = null;
    return ok(null);
  },
  async accountClaudeLoginCancel(): Promise<Result<null, string>> {
    mockLoginInFlight = null;
    return ok(null);
  },
  async accountClaudeLoginInFlight(): Promise<Result<{ accountId: string | null } | null, string>> {
    return ok(mockLoginInFlight ? { accountId: mockLoginInFlight.accountId } : null);
  },
  async accountClaudeLogout(_accountId: string | null): Promise<Result<null, string>> {
    return ok(null);
  },
  async claudeAccountsList(): Promise<Result<ClaudeAccountRecord[], string>> {
    return ok(mockClaudeAccounts);
  },
  async claudeAccountCreate(label: string): Promise<Result<ClaudeAccountRecord, string>> {
    const rec: ClaudeAccountRecord = {
      id: `acct-${mockClaudeAccounts.length + 2}`,
      label: label.trim() || `Account ${mockClaudeAccounts.length + 2}`,
      email: null,
      org_name: null,
      subscription_type: null,
      sort_index: mockClaudeAccounts.length + 1,
      added_at: Date.now(),
      label_is_generated: !label.trim(),
    };
    mockClaudeAccounts.push(rec);
    return ok(rec);
  },
  async claudeAccountCaptureIdentity(accountId: string | null): Promise<Result<null, string>> {
    if (accountId === null) {
      mockDefaultIdentity = {
        email: "demo@example.com",
        orgName: "Demo Org",
        subscriptionType: "max",
      };
      return ok(null);
    }
    const rec = mockClaudeAccounts.find((a) => a.id === accountId);
    if (!rec) return { status: "error", error: "this Claude account no longer exists" };
    rec.email = `demo-${rec.id}@example.com`;
    rec.subscription_type = "max";
    if (rec.label_is_generated) rec.label = rec.email;
    return ok(null);
  },
  async claudeDefaultIdentity(): Promise<Result<MockIdentity | null, string>> {
    return ok(mockDefaultIdentity);
  },
  async claudeAccountIdentity(
    accountId: string | null,
  ): Promise<Result<MockIdentity, UsageError>> {
    // Like the core: an account is known by its own token, so a signed-out one has no
    // identity to read.
    if (accountId === null) {
      return { status: "ok", data: { email: "demo@example.com", orgName: "Demo Org", subscriptionType: "max" } };
    }
    const rec = mockClaudeAccounts.find((a) => a.id === accountId);
    if (!rec) return { status: "error", error: { kind: "unknown_account", account_id: accountId } };
    if (!rec.email) return { status: "error", error: { kind: "no_token" } };
    return {
      status: "ok",
      data: { email: rec.email, orgName: rec.org_name, subscriptionType: rec.subscription_type },
    };
  },
  async claudeAccountRemove(
    accountId: string,
    _force: boolean,
  ): Promise<Result<string | null, string>> {
    const i = mockClaudeAccounts.findIndex((a) => a.id === accountId);
    if (i >= 0) mockClaudeAccounts.splice(i, 1);
    return ok(null);
  },
  async setConversationClaudeAccount(
    _convId: string,
    _accountId: string | null,
  ): Promise<Result<null, string>> {
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
        // The demo folder is on this Mac. A folder on a paired server carries its machine
        // here instead, and then no url was ever read — the probe is skipped rather than
        // run against a path that does not exist locally.
        machine: null,
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
      parentTaskId: null,
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
  // Written INTO the demo task (the briefing's own object), so the refetch that follows the
  // write shows the new person — a mock that only answered ok would hide a lost write.
  async tosseSetTaskAssignee(taskId: string, assignedTo: string): Promise<Result<null, string>> {
    const found = demoAllTasks().find((row) => row.task.id === taskId);
    if (!found) return err(`no task with id ${taskId}`);
    found.task.assignedTo = assignedTo;
    return ok(null);
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
    _backend: "claude" | "codex",
    flags: { ultracode: boolean },
  ): Promise<Result<string, string>> {
    const { ultracode } = flags;
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
    else if (demo === "agentmsg") driver.startAgentMessage();
    else if (demo === "tosse") driver.startTosse();
    else if (demo === "design") driver.startTypedArtifact();
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
    // context fill, so there is nothing to seed here — except for the `?ctx=` overrides
    // that reproduce the ring's pre-window states (see `demoContextFill`).
    return ok(demoContextFill());
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

  async getPlanUsage(accountId: string | null): Promise<Result<PlanUsage, UsageError>> {
    // No real OAuth endpoint in the browser; return plausible fills so the Plan
    // section of the context popover renders in dev/Playwright. Reset ~2h / ~3d out,
    // as ISO 8601 strings (matching the live endpoint shape).
    const iso = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();
    // Build the ok-arm directly: `ok()` fixes the error type to string, but this
    // command's Result error is UsageError. The mock never takes the error path.
    // Distinct fills per account, so the multi-account surfaces (per-card bars, the
    // account chip's percentages, the auto-switch policy) show something to choose
    // BETWEEN rather than the same number twice.
    const busy = accountId === null;
    return {
      status: "ok",
      data: {
        five_hour: { used_percentage: busy ? 42 : 8, resets_at: iso(2 * 3600) },
        seven_day: { used_percentage: busy ? 67 : 14, resets_at: iso(3 * 86400) },
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
    // `machines` always mirrors the mutable in-memory list — a server the wizard (or
    // the legacy ticket flow) just paired must still be here on the NEXT call
    // (`bootConversations()` re-reads this after a successful bootstrap), same as a
    // real reload showing the DB's truth rather than a stale snapshot.
    const demoParam = typeof location !== "undefined" ? new URLSearchParams(location.search).get("demo") : null;
    // `?demo=servers` — B12 visual check fixture: one paired server per headline
    // state (Ready / Needs Claude install / Needs Claude sign-in /
    // Running-not-reboot-safe / Failed — B14 added the "install" one, distinct from
    // "sign-in"), seeded once (idempotent — a second load must not duplicate them).
    if (demoParam === "servers" && mockMachines.length === 0) {
      const seed: Array<[string, string, ServerDiagnosis]> = [
        ["ready-vps", "ready.example.com", readyDiagnosis()],
        [
          "needs-install-vps",
          "needs-install.example.com",
          { ...readyDiagnosis(), claude_installed: false, claude_logged_in: null, claude_email: null, state: { kind: "needs_claude_install" } },
        ],
        [
          "needs-signin-vps",
          "needs-signin.example.com",
          { ...readyDiagnosis(), claude_installed: true, claude_logged_in: false, claude_email: null, state: { kind: "needs_claude_sign_in" } },
        ],
        [
          "reboot-unsafe-vps",
          "reboot-unsafe.example.com",
          { ...readyDiagnosis(), reboot_safe: false, linger: false, sleep_masked: false, state: { kind: "running_not_reboot_safe" } },
        ],
        [
          "unreachable-vps",
          "unreachable.example.com",
          {
            state: { kind: "failed", reason: "could not reach the server" },
            installed_as: "unknown",
            daemon_running: null,
            daemon_version_disk: null,
            daemon_version_running: null,
            restart_pending: false,
            reboot_safe: null,
            linger: null,
            sleep_masked: null,
            user_unit_missing_path: null,
            claude_installed: null,
            claude_logged_in: null,
            claude_email: null,
            tailscale_name: null,
            last_boot: null,
            busy_conversations: null,
            bundled_daemon_version: null,
            daemon_outdated: false,
          },
        ],
      ];
      for (const [label, host, diagnosis] of seed) {
        const m = findOrCreateMockMachine(label, host, 22, "deploy");
        mockDiagnoses.set(m.id, diagnosis);
      }
    }
    if (demoParam === null)
      return ok({ machines: [...mockMachines], claude_accounts: [], repos: [], conversations: [], active_id: null });
    const now = Date.now();
    // `?demo=remote` — visual check for the remote-machine mark (sidebar row, Flight Deck
    // lane header, stream card). Three folders that must read DIFFERENTLY at a glance:
    // a local one (unmarked), one on a paired server (globe + its name), and one whose
    // `machine_id` names nothing — the case that must NOT quietly look local.
    // Deliberately pairs the server here rather than reusing `?demo=servers`: the point is
    // a repo that CARRIES a machine, which that fixture has no repos for.
    const remoteDemo = demoParam === "remote";
    if (remoteDemo && mockMachines.length === 0) {
      findOrCreateMockMachine("vps-ovh", "51.83.1.2", 22, "deploy");
    }
    const remoteRepos: RepoRecord[] = remoteDemo
      ? [
          {
            id: "repo-remote",
            // A path that looks just like a local one once truncated — the confusion the
            // mark exists to end.
            path: "/home/deploy/demo-repo",
            added_at: now - 1,
            machine_id: mockMachines[0]?.id ?? null,
          },
          { id: "repo-orphan", path: "/srv/app", added_at: now - 2, machine_id: "machine-deleted" },
        ]
      : [];
    return ok({
      machines: [...mockMachines],
      repos: [
        { id: "repo-demo", path: "/Users/dev/demo-repo", added_at: now, machine_id: null },
        ...remoteRepos,
      ],
      conversations: [
        ...(remoteDemo
          ? ([
              {
                id: "conv-remote",
                name: "Deploy on the server",
                repo_id: "repo-remote",
                cwd: "/home/deploy/demo-repo",
                created_at: now - 1,
                last_activity_at: now - 1,
                session_id: null,
                model: "claude-opus-4-8",
                effort: "xhigh",
                ultracode: false,
                permission_mode: "auto",
                pending_reminder: null,
                clean_output: null,
                tosse_task_id: null,
                tosse_task_title: null,
                tosse_task_status: null,
                backend: "claude",
                claude_account_id: null,
              },
              {
                id: "conv-orphan",
                name: "Paired server gone",
                repo_id: "repo-orphan",
                cwd: "/srv/app",
                created_at: now - 2,
                last_activity_at: now - 2,
                session_id: null,
                model: "claude-opus-4-8",
                effort: "xhigh",
                ultracode: false,
                permission_mode: "auto",
                pending_reminder: null,
                clean_output: null,
                tosse_task_id: null,
                tosse_task_title: null,
                tosse_task_status: null,
                backend: "claude",
                claude_account_id: null,
              },
            ] as ConversationRecord[])
          : []),
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
          claude_account_id: null,
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
          claude_account_id: null,
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

  // The mock DOES pair machines now (below) — this command specifically still has
  // nothing to do for them, though: it pushes a title update to a LIVE relay
  // connection on the daemon side, which the browser mock never opens.
  async pushRemoteConversationTitle(_conversationId: string, _title: string): Promise<boolean> {
    return false;
  },

  // ---- Remote servers (SSH) — pairing + B12 bootstrap wizard ----

  async generateMachineKey(label: string): Promise<Result<GeneratedKey, string>> {
    return ok({ identity_file: `/mock/ssh_keys/${label}-${Date.now()}`, public_key: "ssh-ed25519 AAAAMOCKKEY mock-key" });
  },

  async addMachine(
    label: string,
    host: string,
    port: number,
    user: string,
    identityFile: string | null,
    addresses: AddressCandidate[] | null,
  ): Promise<Result<{ machine: MachineRecord; matched_existing: boolean }, string>> {
    if (!host.trim() || !user.trim()) return err("host and user are required");
    // Mirrors the real `add_machine`'s convergence rule (B_lifecycle-#1): match on
    // (port, user) plus host OR any already-recorded address, not just an exact
    // (host, port, user) triple — a re-pair can legitimately resolve a different
    // working address for the same physical server.
    const matched = mockMachines.find(
      (m) =>
        m.port === port &&
        m.user === user &&
        (m.host === host || (m.addresses ?? []).some((a) => a.value === host)),
    );
    const machine = matched ?? findOrCreateMockMachine(label || host, host, port, user);
    machine.label = label || host;
    machine.identity_file = identityFile ?? machine.identity_file;
    if (addresses && addresses.length > 0) machine.addresses = addresses;
    mockDiagnoses.set(machine.id, readyDiagnosis());
    return ok({ machine, matched_existing: matched != null });
  },

  async deleteMachine(id: string): Promise<Result<null, string>> {
    const i = mockMachines.findIndex((m) => m.id === id);
    if (i >= 0) mockMachines.splice(i, 1);
    mockDiagnoses.delete(id);
    mockProvisionStatuses.delete(id);
    mockRevokeStatuses.delete(id);
    return ok(null);
  },

  async listRemoteRepos(_machineId: string): Promise<Result<string[], string>> {
    return ok(["/home/mockuser/app", "/home/mockuser/another-repo"]);
  },

  async listRemoteDir(_machineId: string, path: string): Promise<Result<{ path: string; dirs: string[] }, string>> {
    const home = "/home/mockuser";
    const p = path.trim() || home;
    // A small, fixed two-level tree so the browser picker has something to descend
    // into and climb back out of — no real ssh in the mock.
    const tree: Record<string, string[]> = {
      [home]: ["app", "another-repo", "scratch"],
      [`${home}/app`]: ["src", "docs"],
      [`${home}/another-repo`]: ["lib"],
    };
    return ok({ path: p, dirs: tree[p] ?? [] });
  },

  async prepareRemoteDir(_machineId: string, _path: string): Promise<Result<null, string>> {
    return ok(null);
  },

  async phoneProvisioningStatus(): Promise<MachineProvisionStatus[]> {
    return [...mockProvisionStatuses.values()];
  },

  async phoneRevocationStatus(): Promise<MachineRevokeStatus[]> {
    return [...mockRevokeStatuses.values()];
  },

  async retryPhoneProvisioning(machineId: string): Promise<Result<MachineProvisionStatus, string>> {
    const status: MachineProvisionStatus = { machine_id: machineId, state: { kind: "provisioned", at_ms: Date.now() }, checked_at_ms: Date.now() };
    mockProvisionStatuses.set(machineId, status);
    return ok(status);
  },

  /** Runs the scripted pipeline chosen by `scenarioFor(host)` — see its own doc. */
  async bootstrapServer(
    label: string,
    host: string,
    port: number,
    user: string,
    _password: string | null,
    _maskSleep: boolean,
    _sudoPassword: string | null,
  ): Promise<Result<BootstrapReport, string>> {
    const sessionId = `mock-session-${Date.now()}`;
    const states: StepState[] = STEP_SEQUENCE.map((id) => ({ id, status: "pending", detail: null }));
    const { states: finalStates, needsInput } = await runMockPipeline(sessionId, host, states, 0, false);
    if (needsInput) {
      mockPausedSessions.set(sessionId, { label, host, port, user, states: finalStates, pausedAtIndex: STEP_SEQUENCE.indexOf(needsInput) });
      return ok({ session_id: sessionId, host, steps: finalStates, needs_input: needsInput, machine_id: null, diagnosis: null });
    }
    const scenario = scenarioFor(host);
    const failed = finalStates.some((s) => s.status === "failed");
    if (failed) {
      return ok({ session_id: sessionId, host, steps: finalStates, needs_input: null, machine_id: null, diagnosis: null });
    }
    const machine = findOrCreateMockMachine(label || host, host, port, user);
    const diagnosis = finalDiagnosisFor(scenario);
    mockDiagnoses.set(machine.id, diagnosis);
    return ok({ session_id: sessionId, host, steps: finalStates, needs_input: null, machine_id: machine.id, diagnosis });
  },

  async bootstrapResume(sessionId: string, sudoPassword: string | null): Promise<Result<BootstrapReport, string>> {
    const paused = mockPausedSessions.get(sessionId);
    if (!paused) return err("no bootstrap run is paused under this session id");
    if (!sudoPassword) return err("this server needs a sudo password to continue");
    mockPausedSessions.delete(sessionId);
    const { states: finalStates, needsInput } = await runMockPipeline(
      sessionId,
      paused.host,
      paused.states,
      paused.pausedAtIndex,
      true,
    );
    if (needsInput) {
      mockPausedSessions.set(sessionId, { ...paused, states: finalStates, pausedAtIndex: STEP_SEQUENCE.indexOf(needsInput) });
      return ok({ session_id: sessionId, host: paused.host, steps: finalStates, needs_input: needsInput, machine_id: null, diagnosis: null });
    }
    const scenario = scenarioFor(paused.host);
    const machine = findOrCreateMockMachine(paused.label || paused.host, paused.host, paused.port, paused.user);
    const diagnosis = finalDiagnosisFor(scenario);
    mockDiagnoses.set(machine.id, diagnosis);
    return ok({ session_id: sessionId, host: paused.host, steps: finalStates, needs_input: null, machine_id: machine.id, diagnosis });
  },

  async bootstrapCancel(sessionId: string): Promise<Result<null, string>> {
    mockPausedSessions.delete(sessionId);
    return ok(null);
  },

  async machineDiagnose(machineId: string): Promise<Result<ServerDiagnosis, string>> {
    const d = mockDiagnoses.get(machineId);
    if (!d) return err("unknown server");
    return ok({ ...d });
  },

  async machineRepair(machineId: string, action: RepairAction, _sudoPassword: string | null): Promise<Result<RepairOutcome, string>> {
    const machine = mockMachines.find((m) => m.id === machineId);
    if (!machine) return err("unknown server");
    const d = { ...(mockDiagnoses.get(machineId) ?? readyDiagnosis()) };
    let summary = "";
    let label = "";
    switch (action) {
      case "reupload_daemon":
        d.installed_as = d.installed_as === "none" ? "detached" : d.installed_as;
        d.daemon_running = true;
        d.daemon_version_disk = "0.4.2";
        label = "Re-upload the flightdeckd binary";
        summary = "Uploaded";
        break;
      case "restart_daemon":
        d.daemon_running = true;
        d.restart_pending = false;
        d.daemon_version_running = d.daemon_version_disk;
        label = "Restart the flightdeckd daemon";
        summary = "restarted";
        break;
      case "install_service":
        d.reboot_safe = true;
        d.user_unit_missing_path = false;
        label = "Install the persistence service";
        summary = "Installed";
        break;
      case "enable_linger":
        d.linger = true;
        d.reboot_safe = true;
        label = "Enable linger for this user";
        summary = "linger enabled";
        break;
      case "mask_sleep":
        d.sleep_masked = true;
        label = "Mask sleep/suspend targets";
        summary = "sleep targets masked";
        break;
      case "run_init":
        label = "Run flightdeckd init";
        summary = "Initialized";
        break;
      case "install_claude":
        d.claude_installed = true;
        label = "Install Claude Code";
        summary = "installed: 2.1.211 (Claude Code)";
        break;
      case "sign_in_claude":
        label = "Start the Claude sign-in flow";
        summary = "sign-in session mock-login started";
        break;
      case "provision_phone":
        label = "Provision this Mac's phone token";
        summary = "Provisioned";
        mockProvisionStatuses.set(machineId, { machine_id: machineId, state: { kind: "provisioned", at_ms: Date.now() }, checked_at_ms: Date.now() });
        break;
    }
    d.state = collapseMockState(d);
    mockDiagnoses.set(machineId, d);
    await wait(200);
    return ok({ action, label, summary, diagnosis: { ...d } });
  },

  async bootstrapForgetHostKey(host: string, _port: number): Promise<Result<null, string>> {
    mockForgottenHostKeys.add(host);
    return ok(null);
  },

  async startClaudeLogin(machineId: string): Promise<Result<LoginSession, string>> {
    // Mirrors the real single-flight semantics (B-finding #4): a second start for a
    // machine that already has a live mock session ATTACHES to it (owned:false)
    // instead of minting a competing one — only `restartClaudeLogin` below replaces
    // it. `owned` mirrors `AttachOutcome`/`LoginSession::owned` on the real backend —
    // see that struct's own doc for why the front needs it.
    for (const [sessionId, mId] of mockLoginSessions) {
      if (mId === machineId) return ok({ session_id: sessionId, machine_id: machineId, owned: false });
    }
    const sessionId = `mock-login-${++mockLoginCounter}`;
    mockLoginSessions.set(sessionId, machineId);
    setTimeout(() => {
      serverLoginPromptEvent.emit({ session_id: sessionId, machine_id: machineId, url: "https://claude.ai/oauth/authorize?mock=1" });
    }, 260);
    return ok({ session_id: sessionId, machine_id: machineId, owned: true });
  },

  async restartClaudeLogin(machineId: string): Promise<Result<LoginSession, string>> {
    const oldSessionId = Array.from(mockLoginSessions).find(([, mId]) => mId === machineId)?.[0];
    const sessionId = `mock-login-${++mockLoginCounter}`;
    // The NEW session is registered and handed back FIRST, exactly like the real
    // backend's `restart_claude_login` (`supersede_and_insert` + the immediate
    // `Ok(LoginSession{owned:true, ...})` return, well before the old actor's own
    // kill+wait completes) — the OLD session's "superseded" result only arrives
    // asynchronously afterward. A follow-up review of B-finding #4 caught an earlier
    // version of this mock getting that ordering BACKWARDS (emitting the superseded
    // result synchronously, before minting the new session), which accidentally
    // self-healed a race the real backend does not, and let it go untested.
    if (oldSessionId !== undefined) mockLoginSessions.delete(oldSessionId);
    mockLoginSessions.set(sessionId, machineId);
    if (oldSessionId !== undefined) {
      setTimeout(() => {
        serverLoginResultEvent.emit({
          session_id: oldSessionId,
          machine_id: machineId,
          ok: false,
          email: null,
          error: "superseded by another sign-in for this server",
          reason: "superseded" satisfies LoginResultReason,
        });
      }, 50);
    }
    setTimeout(() => {
      serverLoginPromptEvent.emit({ session_id: sessionId, machine_id: machineId, url: "https://claude.ai/oauth/authorize?mock=1" });
    }, 260);
    return ok({ session_id: sessionId, machine_id: machineId, owned: true });
  },

  async submitClaudeLoginCode(session: LoginSession, code: string): Promise<Result<null, string>> {
    if (!mockLoginSessions.has(session.session_id)) return err("that sign-in session is no longer active");
    setTimeout(() => {
      mockLoginSessions.delete(session.session_id);
      const accepted = code.trim().length >= 4;
      serverLoginResultEvent.emit({
        session_id: session.session_id,
        machine_id: session.machine_id,
        ok: accepted,
        email: accepted ? "demo@example.com" : null,
        error: accepted ? null : "that code wasn't accepted",
        reason: accepted ? null : ("failed" satisfies LoginResultReason),
      });
      if (accepted) {
        const d = mockDiagnoses.get(session.machine_id);
        if (d) {
          d.claude_installed = true;
          d.claude_logged_in = true;
          d.claude_email = "demo@example.com";
          d.state = collapseMockState(d);
          mockDiagnoses.set(session.machine_id, d);
        }
      }
    }, 300);
    return ok(null);
  },

  async cancelClaudeLogin(session: LoginSession): Promise<Result<null, string>> {
    const existed = mockLoginSessions.delete(session.session_id);
    // Mirrors the real backend (residual defect A8/R1, CRM 1abfc028): a Cancel now
    // ALWAYS emits a terminal result, even for the caller who initiated it — a still-
    // ATTACHED surface for the same session needs the same signal `Superseded` already
    // gets. The initiating surface's own UI is what ignores this event for itself (see
    // `ClaudeSignInInline`'s doc); this mock doesn't need to know who owns what.
    if (existed) {
      setTimeout(() => {
        serverLoginResultEvent.emit({
          session_id: session.session_id,
          machine_id: session.machine_id,
          ok: false,
          email: null,
          error: "cancelled",
          reason: "cancelled" satisfies LoginResultReason,
        });
      }, 10);
    }
    return ok(null);
  },

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

  async voiceAgentClientSecret(_voice: string | null): Promise<Result<ClientSecret, string>> {
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
    debugCapture: boolean | null,
  ): Promise<Result<WakeStatus, string>> {
    if (enabled !== null) mockWake.enabled = enabled;
    if (phrase !== null) mockWake.phrase = phrase;
    if (sensitivity !== null) mockWake.sensitivity = Math.min(1, Math.max(0, sensitivity));
    if (debugCapture !== null) {
      // Mirrors the core: no capture directory means the opt-in cannot be honoured,
      // and the mock says so rather than showing a switch that would never write.
      mockWake.debug_capture = false;
      mockWake.debug_error = debugCapture
        ? "the browser mock has no capture directory — recordings cannot be written"
        : null;
    }
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
    macLabel: string | null,
  ): Promise<Result<RemoteStatus, string>> {
    if (enabled !== null) mockRemote.enabled = enabled;
    if (relayUrl !== null && relayUrl.trim()) mockRemote.relay_url = relayUrl.trim();
    if (macLabel !== null && macLabel.trim()) mockRemote.mac_label = macLabel.trim();
    if (regeneratePairing) mockRemote.phone_token = `mock-pt-${Date.now()}`;
    mockRemote.pairing_url = `${mockRemote.relay_url.replace(/\/$/, "")}/#macId=${mockRemote.mac_id}&pt=${mockRemote.phone_token}`;
    mockRemote.connected = mockRemote.enabled;
    return ok({ ...mockRemote });
  },

  // The in-app artifact host is a NATIVE webview — there is none in the browser mock, so these
  // only replay the page-load events the real host emits (the viewer's status line reacts to
  // them). A URL containing `__signin__` lands on a fake sign-in page, `__fail__` refuses.
  async artifactHostShow(url: string, _bounds: HostBounds, _zoom: number): Promise<Result<null, string>> {
    if (url.includes("__fail__")) return { status: "error", error: "mock artifact host failed" };
    const page = url.includes("__signin__") ? "https://claude.ai/login?returnTo=%2Fartifact" : url;
    if (page !== mockArtifactHostPage) {
      mockArtifactHostPage = page;
      setTimeout(() => {
        artifactHostEvent.emit({ kind: "started", url: page });
        artifactHostEvent.emit({ kind: "finished", url: page });
      }, 50);
    }
    return ok(null);
  },

  async artifactHostSetBounds(_bounds: HostBounds): Promise<Result<null, string>> {
    return ok(null);
  },

  async artifactHostHide(): Promise<Result<null, string>> {
    return ok(null);
  },

  async artifactHostReload(): Promise<Result<null, string>> {
    // Like the real one: a reload NAVIGATES, so it replays the page-load events the viewer's
    // status waits on. Without them the demo's Reload button parked on "Loading…" forever —
    // behaviour production doesn't have. Nothing loaded → the same error Rust returns.
    const page = mockArtifactHostPage;
    if (!page) return { status: "error", error: "no artifact is loaded in the view" };
    setTimeout(() => {
      artifactHostEvent.emit({ kind: "started", url: page });
      artifactHostEvent.emit({ kind: "finished", url: page });
    }, 50);
    return ok(null);
  },

  async artifactHostClose(): Promise<Result<null, string>> {
    mockArtifactHostPage = null;
    return ok(null);
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

  // ---- Settings → Claude Code (routing / spend / instructions) — demo -------
  // Shaped like the real thing, including the two states that are easy to get wrong and
  // impossible to see otherwise: a built-in the baseline cannot reach (Plan), and an agent
  // whose configured model disagrees with what the transcripts say it ran on (Explore,
  // set to haiku, seen on opus) — which is what lights the drift canary.
  async listSubagentRouting(_repoPath: string): Promise<Result<SubagentRouting, string>> {
    const agents: AgentRouting[] = [
      {
        name: "Explore",
        description: "Sweeps the codebase to locate something. Read-only.",
        effective_model: "haiku",
        defined_model: "haiku",
        effort: null,
        origin: "user",
        path: "/Users/demo/.claude/agents/Explore.md",
        built_in: true,
        shadows_built_in: true,
        needs_file_to_steer: false,
        overridden_by_force: false,
        configured_at_ms: Date.now() - 10 * 86_400_000,
      },
      {
        name: "Plan",
        description: "Designs how a change should be made before any code is written.",
        effective_model: null,
        defined_model: null,
        effort: null,
        origin: "built_in",
        path: null,
        built_in: true,
        shadows_built_in: false,
        needs_file_to_steer: true,
        overridden_by_force: false,
        // A blind spot follows nothing, so nothing has been configured for it.
        configured_at_ms: null,
      },
      {
        name: "general-purpose",
        description: "The catch-all helper for multi-step work.",
        effective_model: "sonnet",
        defined_model: null,
        effort: null,
        origin: "built_in",
        path: null,
        built_in: true,
        shadows_built_in: false,
        needs_file_to_steer: false,
        overridden_by_force: false,
        configured_at_ms: Date.now() - 30 * 86_400_000,
      },
      {
        name: "tosse-manager",
        description: "CRM specialist. Never touches code.",
        effective_model: "claude-opus-4-8",
        defined_model: "claude-opus-4-8",
        effort: "high",
        origin: "plugin",
        path: "/Users/demo/.claude/plugins/tosse/agents/manager.md",
        built_in: false,
        shadows_built_in: false,
        needs_file_to_steer: false,
        overridden_by_force: false,
        configured_at_ms: Date.now() - 30 * 86_400_000,
      },
    ];
    return ok({
      agents,
      baseline: {
        model: "sonnet",
        forced_model: null,
        unreachable_builtins: ["Explore", "Plan"],
        error: null,
      },
      user_agents_dir: "/Users/demo/.claude/agents",
      project_agents_dir: "/Users/demo/repo/.claude/agents",
      // The repo in the demo DOES ignore .claude/ — so the scope warning is visible.
      project_dir_ignored: true,
      repo_is_worktree: false,
    });
  },
  async setSubagentModel(
    _path: string,
    _model: string | null,
    _effort: string | null,
  ): Promise<Result<null, string>> {
    return ok(null);
  },
  async createSubagentDefinition(
    dir: string,
    name: string,
    _description: string,
    _model: string | null,
    _effort: string | null,
    _body: string,
  ): Promise<Result<string, string>> {
    return ok(`${dir}/${name}.md`);
  },
  async setSubagentBaseline(
    _model: string | null,
    _forcedModel: string | null,
  ): Promise<Result<null, string>> {
    return ok(null);
  },
  async subagentSpend(): Promise<Result<SpendReport, string>> {
    return ok(mockSpendReport());
  },
  async readClaudeMemory(): Promise<Result<ManagedMemory, string>> {
    return ok({
      path: "/Users/demo/.claude/CLAUDE.md",
      exists: true,
      // A block already in the file, so the demo can show REMOVALS as well as additions —
      // an empty block only ever produces green, which hides half of what the diff is for.
      managed_text:
        "## Choosing a model for a helper agent\n\nAn older version of the policy that the\nsuggested block would replace.\n",
      full_text:
        "# My instructions\n\nAlways write tests before the fix.\n\n<!-- flightdeck:managed:start -->\n## Choosing a model for a helper agent\n\nAn older version of the policy that the\nsuggested block would replace.\n<!-- flightdeck:managed:end -->\n",
      marker_error: null,
    });
  },
  async writeClaudeMemory(_text: string | null): Promise<Result<null, string>> {
    return ok(null);
  },
  async fetchKnownAgents(_cwd: string): Promise<Result<string[], string>> {
    return ok(["claude", "Explore", "general-purpose", "Plan", "statusline-setup"]);
  },

  // ---- Extensions (MCP / plugins / skills / agents) — demo fixtures --------
  // Without these, the extensions manager calls `undefined(...)` in `?demo=` mode.
  async listExtensions(_repoPath: string): Promise<Result<ExtensionsSnapshot, string>> {
    return ok({ mcp_servers: [], plugins: [], skills: [], agents: [], warnings: [], plugin_state_trusted: true });
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
