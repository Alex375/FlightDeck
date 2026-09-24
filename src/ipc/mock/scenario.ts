// Scripted fixture timeline for the browser mock (dev / Playwright).
//
// It replays a realistic Claude Code turn over the same event shapes the Rust core
// emits, so the conversation UI can be developed and screenshotted with zero backend:
//   send → busy → stream text → tool_use(Read, Grep, Glob) → tool_results → stream
//        text + code → tool_use(Edit) → PERMISSION (pause) → [answer] → tool_result
//        → final → turn_result → idle
// The first message runs three consecutive tools so the grouped "Ran N steps"
// section (ToolSection) is exercised by the mock, not just a single-step run.
//
// Token-by-token deltas with small delays so Playwright can capture mid-stream.

import type {
  BackgroundTask,
  ConversationItem,
  PermissionDecision,
  PermissionRequestPayload,
  SessionStatePayload,
  WorkflowJournal,
  WorkflowRun,
} from "../client";
import { buildAgentMessageEnvelope } from "../../features/conversation/agentMessage";

export interface ScenarioEmit {
  state: (s: SessionStatePayload) => void;
  item: (i: ConversationItem) => void;
  permission: (p: PermissionRequestPayload) => void;
  /** Background-task lifecycle snapshot (optional — only the bg demo emits these). */
  task?: (t: BackgroundTask) => void;
}

/** Build a full BackgroundTask from a partial (mock convenience). */
function taskOf(p: Partial<BackgroundTask> & { task_id: string }): BackgroundTask {
  return {
    kind: "agent",
    tool_use_id: null,
    label: null,
    command: null,
    subagent_type: null,
    model: null,
    agent_id: null,
    status: "running",
    progress: null,
    tokens: null,
    tool_uses: null,
    duration_ms: null,
    summary: null,
    output_file: null,
    ...p,
  };
}

/** A finished sub-agent transcript — what `load_subagent_transcript` returns. Used by
 *  the browser mock so the transcript popover renders real-shaped content in dev. */
export const DEMO_SUBAGENT_TRANSCRIPT: ConversationItem[] = [
  {
    kind: "user_message",
    id: "su1",
    parent_tool_use_id: null,
    text: "Explore the supervisor module and map its structure: the protocol types, the assembler, and how background tasks flow through it. Return a concise structured map.",
    replay: false,
  },
  {
    kind: "assistant_message",
    id: "sa1",
    parent_tool_use_id: null,
    blocks: [
      { type: "thinking", text: "Let me list the supervisor directory first, then read the key files to map the data flow." },
      { type: "text", text: "I'll start by listing the `supervisor/` module, then read the key files." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -1 src-tauri/src/supervisor", description: "list module" } },
    ],
  },
  {
    kind: "tool_result",
    tool_use_id: "t1",
    is_error: false,
    parent_tool_use_id: null,
    content: "assembler.rs\ncontrol.rs\nhistory.rs\nmodel.rs\nprotocol.rs\nsession.rs\nsubagents.rs\ntransport.rs",
  },
  {
    kind: "assistant_message",
    id: "sa2",
    parent_tool_use_id: null,
    blocks: [
      {
        type: "text",
        text: "Here's the module map:\n\n- **protocol.rs** — serde types for the stream-json wire\n- **assembler.rs** — normalization + background-task registry\n- **session.rs** — tokio actor per session\n- **subagents.rs** — disk readers (sub-agent transcript, workflow manifest)\n\nBackground-task flow: `task_started → task_progress → task_updated → task_notification`, each event re-emitted as a full `BackgroundTask`.",
      },
    ],
  },
];

/** A finished MULTI-TURN conversation — what `load_session_history` returns for the History
 *  panel's demo rows. Distinct from the sub-agent transcript above, which has a single
 *  opening turn by design: a real conversation is a back-and-forth, and the preview has to
 *  exercise that (several human messages in a row is what the message minimap maps). */
export const DEMO_HISTORY_TRANSCRIPT: ConversationItem[] = [
  ...DEMO_SUBAGENT_TRANSCRIPT,
  {
    kind: "user_message",
    id: "hu2",
    parent_tool_use_id: null,
    text: "Good. Now walk me through how a background task reaches the UI — I want to know which layer decides a task is finished.",
    replay: false,
  },
  {
    kind: "assistant_message",
    id: "ha2",
    parent_tool_use_id: null,
    blocks: [
      {
        type: "text",
        text: "The assembler owns that call. `task_notification` is the terminal event; the front never infers completion from a `tool_result` arriving, because the two can land out of order.",
      },
    ],
  },
  {
    kind: "user_message",
    id: "hu3",
    parent_tool_use_id: null,
    text: "/compact",
    replay: false,
  },
  {
    kind: "assistant_message",
    id: "ha3",
    parent_tool_use_id: null,
    blocks: [{ type: "text", text: "Conversation compacted." }],
  },
  {
    kind: "user_message",
    id: "hu4",
    parent_tool_use_id: null,
    text: "Last thing: add a regression test for the out-of-order case, then summarise what changed.",
    replay: false,
  },
  {
    kind: "assistant_message",
    id: "ha4",
    parent_tool_use_id: null,
    blocks: [
      { type: "text", text: "Added — the test drives a `tool_result` BEFORE its notification and asserts the card stays live." },
    ],
  },
];

/** A canned workflow-run manifest — what `load_workflow_run` returns — so the
 *  <WorkflowDetail> 3-panel view (phases → agents → transcript) renders real-shaped content
 *  in dev. Mirrors the on-disk `workflows/wf_<id>.json` shape (camelCase, raw
 *  workflowProgress entries). Two phases: Research (one agent done, one running) and Verify
 *  (one queued). */
export const DEMO_WORKFLOW_RUN: WorkflowRun = {
  runId: "wf_demo123",
  taskId: "tk_wf",
  // The mock returns this only once the run is DONE (the manifest is end-only), so completed.
  status: "completed",
  workflowName: "review-changes",
  defaultModel: "claude-opus-4-8",
  durationMs: 18420,
  agentCount: 3,
  totalTokens: 64210,
  totalToolCalls: 27,
  summary: null,
  phases: [
    { title: "Research", detail: "explore the diff across dimensions" },
    { title: "Verify", detail: "adversarially confirm each finding" },
  ],
  workflowProgress: [
    { type: "workflow_phase", index: 1, title: "Research" },
    {
      type: "workflow_agent",
      index: 1,
      label: "r-correctness",
      phaseTitle: "Research",
      phaseIndex: 1,
      agentId: "demoagent_fg",
      agentType: "general-purpose",
      model: "claude-opus-4-8",
      state: "done",
      tokens: 31840,
      toolCalls: 14,
      durationMs: 9120,
      promptPreview:
        "Review the changed files for correctness bugs: off-by-one, null handling, race conditions. Return structured findings.",
      resultPreview:
        "2 findings: (1) unguarded array access in parseWorkflow when workflowProgress is null; (2) poll interval not cleared on unmount.",
    },
    {
      type: "workflow_agent",
      index: 2,
      label: "r-perf",
      phaseTitle: "Research",
      phaseIndex: 1,
      agentId: "demoagent_bg",
      agentType: "general-purpose",
      model: "claude-opus-4-8",
      state: "running",
      tokens: 12480,
      toolCalls: 6,
      promptPreview: "Review the changed files for performance regressions and needless re-renders.",
      lastToolName: "Grep",
    },
    { type: "workflow_phase", index: 2, title: "Verify" },
    {
      type: "workflow_agent",
      index: 3,
      label: "v-correctness",
      phaseTitle: "Verify",
      phaseIndex: 2,
      agentId: "demoagent_v",
      agentType: "general-purpose",
      model: "claude-haiku-4-5",
      state: "queued",
      promptPreview: "Adversarially verify each correctness finding — try to refute it.",
    },
  ],
  result: null,
};

/** The demo run's live journal — what the Rust watcher pushes mid-run. Kept consistent with
 *  the manifest above (same agent ids) so the live overview and the post-run report describe
 *  the same three agents: r-correctness done, r-perf in flight, v-correctness queued (a queued
 *  agent has NOT been spawned, so the journal — which only knows spawns — doesn't list it). */
export function demoWorkflowJournal(): WorkflowJournal {
  return isDemoWorkflowDone()
    ? {
        started: 3,
        done: 3,
        agents: [
          { agentId: "demoagent_fg", done: true },
          { agentId: "demoagent_bg", done: true },
          { agentId: "demoagent_v", done: true },
        ],
      }
    : {
        started: 2,
        done: 1,
        agents: [
          { agentId: "demoagent_fg", done: true },
          { agentId: "demoagent_bg", done: false },
        ],
      };
}

// Demo-only flag: the dynamic workflow's manifest exists ONLY once the run is done (mirrors
// reality — the CLI writes it at the end). While false, the mock's `load_workflow_run` returns
// null so the modal shows its LIVE overview; once true it returns the rich manifest. Flipped
// by the workflow demo's completion step.
let demoWorkflowDone = false;
export function isDemoWorkflowDone(): boolean {
  return demoWorkflowDone;
}

/** Canned output for the background-shell demo, returned by the mock's
 *  `read_task_output` so the <BashOutputPopover> renders real-shaped logs in dev. */
const BASH_OUTPUTS: Record<string, string> = {
  tk_dev:
    "VITE v5.4.2  ready in 412 ms\n\n  ➜  Local:   http://localhost:1420/\n  ➜  Network: use --host to expose\n  ➜  press h + enter to show help\n\n[12:04:18] hmr update /src/App.tsx\n[12:04:31] hmr update /src/ui/conductor-conversation.css\n",
  tk_build:
    "vite v5.4.2 building for production...\n✓ 1240 modules transformed.\ndist/index.html                   0.46 kB │ gzip:  0.30 kB\ndist/assets/index-a1b2c3.css     38.91 kB │ gzip:  7.12 kB\ndist/assets/index-d4e5f6.js     284.10 kB │ gzip: 92.34 kB\n✓ built in 9.40s\n",
};

/** Canned event stream for the Monitor demo, returned by the mock's `read_task_output`
 *  so the <MonitorBar>'s <TaskOutputPopover> tails real-shaped events in dev. One line
 *  per event — the append-only shape the `Monitor` tool writes to `tasks/<id>.output`. */
const MONITOR_OUTPUTS: Record<string, string> = {
  tk_mon:
    "[12:04:18] GET /api/health 200 4ms\n[12:04:19] GET /api/tasks 200 22ms\n[12:04:21] POST /api/login 401 8ms\n[12:04:23] GET /api/tasks 200 19ms\n[12:04:26] WARN slow query (842ms) tasks.list\n[12:04:28] GET /api/health 200 3ms\n",
  tk_mon2:
    "▶ build started\n✓ typecheck passed\n✓ 1240 modules transformed\n✓ built in 9.40s\n■ stream ended\n",
};

/** The mock side of `read_task_output` — canned logs keyed by the demo task ids
 *  (background shell commands AND Monitor watches share the on-disk output sink). */
export function mockTaskOutput(taskId: string): string | null {
  return BASH_OUTPUTS[taskId] ?? MONITOR_OUTPUTS[taskId] ?? null;
}

const MODEL = "claude-opus-4-8[1m]";
export const MOCK_SESSION_ID = "01HVMOCK-S3SSION-ID";

// Visual-verification override for the context ring's pre-first-turn states, which the
// mock cannot otherwise reach (it seeds a fully-known window): `?ctx=none` = nothing
// reported yet (a conversation that never ran), `?ctx=nowindow` = tokens known but the
// window not — a first turn in flight, or a conversation just reloaded from its
// transcript (which carries no window). Baked into `baseState` so every emission
// inherits it.
const CTX_DEMO =
  typeof location !== "undefined" ? new URLSearchParams(location.search).get("ctx") : null;

const baseState: SessionStatePayload = {
  busy: false,
  session_id: MOCK_SESSION_ID,
  cwd: null,
  model: MODEL,
  permission_mode: "auto",
  output_style: null,
  effort: "xhigh",
  ultracode: false,
  activity: null,
  awaiting_permission: false,
    retry: null,
  link: null,
  ended: false,
  context_tokens: CTX_DEMO === "none" ? null : 29756,
  context_window: CTX_DEMO === "none" || CTX_DEMO === "nowindow" ? null : 1000000,
  rate_limit: {
    status: "allowed",
    resets_at: Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60,
    limit_type: "five_hour",
    using_overage: false,
  },
};

export const idleState = (): SessionStatePayload => ({ ...baseState });

/** What the mock seeds from "the transcript" on load. Default: nothing (the demo has no
 *  transcript). `?ctx=nowindow` reproduces a RELOADED conversation — the transcript
 *  carries the token count but never the window, so the ring must stay openable with no
 *  percentage until the next turn ends. */
export const demoContextFill = (): { context_tokens: number | null; context_window: number | null } => ({
  context_tokens: CTX_DEMO === "nowindow" ? 29756 : null,
  context_window: null,
});

// ---- Fixture content -------------------------------------------------------

const M1_TEXT =
  "I'll inspect `src/App.tsx` to understand the streaming bug, then propose a fix.\n\n";

const READ_RESULT = `  9  useEffect(() => {
 10    // subscribes but never cleans up -> listener leak
 11    events.sessionMessageEvent.listen((e) => apply(e.payload));
 12  }, []);`;

const M2_TEXT = `The problem: the \`useEffect\` subscribes to the event but never **unsubscribes** on unmount, which leaks a listener on every mount. Here's the fix:

\`\`\`tsx
useEffect(() => {
  const un = events.sessionMessageEvent.listen((e) => apply(e.payload));
  return () => { un.then((f) => f()); };
}, [session]);
\`\`\`

I'll apply the change.`;

const EDIT_OLD = `  useEffect(() => {
    events.sessionMessageEvent.listen((e) => apply(e.payload));
  }, []);`;

const EDIT_NEW = `  useEffect(() => {
    const un = events.sessionMessageEvent.listen((e) => apply(e.payload));
    return () => { un.then((f) => f()); };
  }, [session]);`;

const EDIT_INPUT = {
  file_path: "src/App.tsx",
  old_string: EDIT_OLD,
  new_string: EDIT_NEW,
};

const M3_ALLOW =
  "Fixed ✓ The subscription is now cleaned up on unmount — no more listener leak. Want me to run the tests?";

const M3_DENY =
  "Got it, I won't apply the change. Let me know if you'd prefer a different approach.";

const PERMISSION: PermissionRequestPayload = {
  request_id: "perm_edit_1",
  tool_name: "Edit",
  tool_use_id: "toolu_edit",
  input: EDIT_INPUT,
  title: "Edit src/App.tsx",
  description: "Apply the subscription-cleanup fix",
  suggestions: [],
  blocked_path: null,
  decision_reason: null,
  agent_id: null,
};

const Q_INTRO =
  "Before coding the authentication, I need your input on two things:\n\n";

const QUESTION: PermissionRequestPayload = {
  request_id: "ask_q_1",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_ask",
  input: {
    questions: [
      {
        header: "Approach",
        question: "Which authentication approach do you prefer?",
        multiSelect: false,
        options: [
          { label: "JWT (stateless)", description: "Signed tokens, no server state, easy to scale." },
          { label: "Server sessions", description: "Cookie + server-side store, easy revocation." },
          { label: "Delegated OAuth", description: "Google / GitHub, no passwords to manage." },
        ],
      },
      {
        header: "Storage",
        question: "Where to store the token on the client?",
        multiSelect: false,
        options: [
          { label: "Cookie httpOnly", description: "Inaccessible to JS, recommended." },
          { label: "localStorage", description: "Simple, but exposed to XSS." },
        ],
      },
      {
        header: "Extras",
        question: "Which protections do you want to enable? (multiple choices allowed)",
        multiSelect: true,
        options: [
          { label: "Rate limiting", description: "Limit login attempts." },
          { label: "2FA", description: "Two-factor authentication (TOTP)." },
          { label: "Refresh tokens", description: "Silent session renewal." },
        ],
      },
    ],
  },
  title: "Claude is asking you a question",
  description: "Your choice guides the rest of the implementation.",
  suggestions: [],
  blocked_path: null,
  decision_reason: null,
  agent_id: null,
};

// ---- Driver ----------------------------------------------------------------

/**
 * Drives one scripted turn. `start()` runs up to the permission prompt and pauses;
 * `resolvePermission()` resumes with the continuation matching the decision.
 */
export class ScenarioDriver {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private clock = 0;
  private awaiting = false;
  private mode: "edit" | "question" = "edit";
  private pendingId: string | null = null;
  /** Background tasks emitted by the shell / monitor demos, so `stopTask` can re-emit a
   *  known one as stopped (mirroring the core's `stop_task` → `task_*` flow). */
  private bgTasks = new Map<string, BackgroundTask>();

  constructor(
    private emit: ScenarioEmit,
    private busyState: SessionStatePayload = { ...baseState, busy: true, activity: "thinking" },
  ) {}

  /** Schedule `fn` `deltaMs` after the previous scheduled step. */
  private step(deltaMs: number, fn: () => void) {
    this.clock += deltaMs;
    this.timers.push(setTimeout(fn, this.clock));
  }

  private streamText(messageId: string, text: string, chunk = 3, perChunkMs = 26) {
    for (let i = 0; i < text.length; i += chunk) {
      const piece = text.slice(i, i + chunk);
      this.step(perChunkMs, () =>
        this.emit.item({ kind: "text_delta", message_id: messageId, text: piece }),
      );
    }
  }

  start() {
    this.reset();
    this.mode = "edit";
    this.pendingId = PERMISSION.request_id;
    this.emit.state({ ...this.busyState });

    // --- m1: intro + Read tool ---
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m1", M1_TEXT);
    this.step(180, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: M1_TEXT },
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "src/App.tsx" } },
          { type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "useState", path: "src" } },
          { type: "tool_use", id: "toolu_glob", name: "Glob", input: { pattern: "**/*.tsx" } },
        ],
      }),
    );
    this.step(520, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_read",
        content: READ_RESULT,
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(140, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_grep",
        content: "src/App.tsx:12: const [count, setCount] = useState(0)\nsrc/Counter.tsx:4: const [n] = useState(0)",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(140, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_glob",
        content: "src/App.tsx\nsrc/Counter.tsx\nsrc/main.tsx",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );

    // --- m2: diagnosis + code + Edit tool ---
    this.step(300, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m2", M2_TEXT, 3, 20);
    this.step(180, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: M2_TEXT },
          { type: "tool_use", id: "toolu_edit", name: "Edit", input: EDIT_INPUT },
        ],
      }),
    );

    // --- permission prompt, then PAUSE ---
    this.step(360, () => {
      this.awaiting = true;
      this.emit.permission(PERMISSION);
      this.emit.state({ ...baseState, busy: true, activity: null, awaiting_permission: true });
    });
  }

  /** Scripted AskUserQuestion flow: short intro, then a questionnaire prompt. */
  startQuestion() {
    this.reset();
    this.mode = "question";
    this.pendingId = QUESTION.request_id;
    this.emit.state({ ...this.busyState });

    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m1", Q_INTRO);
    this.step(180, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [{ type: "text", text: Q_INTRO }],
      }),
    );
    this.step(320, () => {
      this.awaiting = true;
      this.emit.permission(QUESTION);
      this.emit.state({ ...baseState, busy: true, activity: null, awaiting_permission: true });
    });
  }

  /**
   * Background-tools demo (`?demo=background`): one FOREGROUND sub-agent (streams
   * inline, finishes) then one BACKGROUND sub-agent that keeps running after the turn
   * ends — so the inline card, the pinned AgentBar, the "backgrounding" status colour
   * and (via load_subagent_transcript) the transcript popover all render in dev.
   */
  startBackground() {
    this.reset();
    this.emit.state({ ...this.busyState });

    // --- foreground sub-agent: streams inline, then completes ---
    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "I'm running a security audit via a sub-agent.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          {
            type: "tool_use",
            id: "toolu_fg",
            name: "Agent",
            input: {
              description: "Security audit",
              subagent_type: "security",
              prompt:
                "Audit the security of the auth module and list the findings, sorted by severity (high / medium / low), with a proposed fix for each.",
            },
          },
        ],
      }),
    );
    this.step(60, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_fg", tool_use_id: "toolu_fg", label: "Security audit", subagent_type: "security", model: "claude-haiku-4-5", status: "running" }),
      ),
    );
    // live sub-thread content (scoped under toolu_fg)
    this.step(240, () =>
      this.emit.item({ kind: "message_started", id: "sa_fg", role: "assistant", parent_tool_use_id: "toolu_fg" }),
    );
    this.step(160, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "sa_fg",
        parent_tool_use_id: "toolu_fg",
        blocks: [
          {
            type: "text",
            text: "3 findings: (1) no rate-limit on `/login` [high], (2) tokens in localStorage [medium], (3) no refresh-token rotation [medium].",
          },
        ],
      }),
    );
    this.step(200, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_fg", tool_use_id: "toolu_fg", label: "Security audit", subagent_type: "security", model: "claude-haiku-4-5", status: "completed", agent_id: "demoagent_fg", tokens: 18400, tool_uses: 7, duration_ms: 21000 }),
      ),
    );
    this.step(120, () =>
      this.emit.item({ kind: "tool_result", tool_use_id: "toolu_fg", content: "3 findings reported (1 high, 2 medium).", is_error: false, parent_tool_use_id: null }),
    );

    // --- background sub-agent: launched detached, stays running past the turn ---
    this.step(280, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    const t2 = "Now I'm launching a code explorer in the background. I'll let you know when it's done — you can keep talking to me in the meantime.";
    this.streamText("m2", t2, 3, 18);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t2 },
          {
            type: "tool_use",
            id: "toolu_bg",
            name: "Agent",
            input: {
              description: "Explore the code",
              subagent_type: "Explore",
              run_in_background: true,
              prompt: "Explore the supervisor module and map its structure: protocol types, the assembler, and how background tasks flow.",
            },
          },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_bg",
        content:
          "Async agent launched successfully.\nagentId: demoagent_bg\noutput_file: /Users/dev/.claude/projects/x/subagents/agent-demoagent_bg.jsonl",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_bg", tool_use_id: "toolu_bg", label: "Explore the code", subagent_type: "Explore", model: "claude-sonnet-4-6", status: "running" }),
      ),
    );
    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.021, num_turns: 2, duration_ms: 26000, duration_api_ms: 18600, ttft_ms: 900 }),
    );
    // Idle main loop, but tk_bg keeps running → conversation goes "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …then the background agent finishes a few seconds later: it drops out of the
    // AgentBar / FlightDeck badge, and the conversation falls back from "backgrounding"
    // to idle. (Exercises the disappear-on-complete behaviour in dev.)
    this.step(14000, () =>
      this.emit.task?.(
        taskOf({ task_id: "tk_bg", tool_use_id: "toolu_bg", label: "Explore the code", subagent_type: "Explore", model: "claude-sonnet-4-6", status: "completed", agent_id: "demoagent_bg", tokens: 42000, tool_uses: 15, duration_ms: 38000 }),
      ),
    );
  }

  /** Record + emit a background task snapshot (so `stopTask` can find it later). */
  private emitTask(t: BackgroundTask) {
    this.bgTasks.set(t.task_id, t);
    this.emit.task?.(t);
  }

  /**
   * Background-shell demo (`?demo=shell`): a FOREGROUND command (in flight while busy →
   * the bottom "$ command…" indicator, registre 1), then TWO `run_in_background`
   * commands — a dev server that keeps running (Stop button + live output tail) and a
   * build that completes a few seconds later (finished row with duration + exit code).
   * Exercises the pinned <BashBar>, the <BashOutputPopover> and stop_task end to end.
   */
  startShell() {
    this.reset();
    this.bgTasks.clear();
    this.emit.state({ ...this.busyState });

    // --- foreground command: stays in flight a moment → "$ pnpm test…" at the bottom ---
    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "I'm running the test suite, then a few background commands.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "pnpm test -- --run", description: "run the test suite" } },
        ],
      }),
    );
    // Held in flight (no result) so the working indicator shows the live command.
    this.step(2200, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_fg",
        content: "Test Files  12 passed (12)\nTests  148 passed (148)\nDuration  3.41s",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );

    // --- background #1: a dev server that KEEPS running (Stop button + live tail) ---
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    const t2 = "I'm starting the dev server in the background — you can keep talking to me in the meantime.";
    this.streamText("m2", t2, 3, 18);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t2 },
          { type: "tool_use", id: "toolu_dev", name: "Bash", input: { command: "pnpm dev", description: "start dev server", run_in_background: true } },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_dev",
        content:
          "Command running in background with ID: tk_dev. Output is being written to: /Users/dev/.claude/projects/x/tasks/tk_dev.output. You will be notified when it completes.",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_dev", kind: "bash", tool_use_id: "toolu_dev", label: "pnpm dev", command: "pnpm dev --host", status: "running", output_file: "tasks/tk_dev.output" })),
    );

    // --- background #2: a build that COMPLETES a few seconds later ---
    this.step(220, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2b",
        parent_tool_use_id: null,
        blocks: [
          { type: "tool_use", id: "toolu_build", name: "Bash", input: { command: "pnpm build", description: "production build", run_in_background: true } },
        ],
      }),
    );
    this.step(60, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_build",
        content:
          "Command running in background with ID: tk_build. Output is being written to: /Users/dev/.claude/projects/x/tasks/tk_build.output.",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_build", kind: "bash", tool_use_id: "toolu_build", label: "production build", command: "pnpm build", status: "running", output_file: "tasks/tk_build.output" })),
    );

    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.014, num_turns: 2, duration_ms: 8200, duration_api_ms: 6100, ttft_ms: 700 }),
    );
    // Idle main loop, but the two bg commands keep running → conversation "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …the build finishes a few seconds later: its row flips to completed (duration + exit).
    this.step(6000, () =>
      this.emitTask(
        taskOf({
          task_id: "tk_build",
          kind: "bash",
          tool_use_id: "toolu_build",
          label: "production build",
          command: "pnpm build",
          status: "completed",
          duration_ms: 9400,
          summary: 'Background command "pnpm build" completed (exit code 0)',
          output_file: "tasks/tk_build.output",
        }),
      ),
    );
  }

  /**
   * Agent-to-agent messaging demo (`?demo=agentmsg`): a message from another conversation
   * arrives (the received card), then the agent answers through `send_message` — one send
   * delivered, one refused (the failed card). Exercises both cards and their jump chips.
   */
  /**
   * `?demo=tosse` — the TOSSE action cards, in one pass: the LOOKUPS grouped in a run (rose
   * glyph, "Read tasks · 12 tasks"), then a card per write — a task filed, a status moved, a
   * context updated — plus the two states that must never pass for a success: a write the CRM
   * REFUSED, and one still in flight. Mirrors what a real `/pickup` does to the CRM.
   */
  startTosse() {
    this.reset();
    this.emit.state({ ...this.busyState });

    const TASK = {
      id: "6edf5907-048b-4b61-a6fc-b85bc14253c9",
      title: "Style the TOSSE MCP calls in the thread",
      projectId: "ef02be22-fe30-4463-9450-ec3b20746a35",
      type: "Code",
      status: "En cours",
      priority: "Moyenne",
      assignedTo: "Alexandre",
      project: { id: "ef02be22-fe30-4463-9450-ec3b20746a35", name: "Tosse Code" },
    };
    const json = (v: unknown) => [{ type: "text" as const, text: JSON.stringify(v, null, 2) }];
    const tosse = (tool: string) => `mcp__claude_ai_TOSSE__${tool}`;

    this.step(240, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "Picking the task up — let me read the board and the context first.\n\n";
    this.streamText("m1", t1);
    this.step(160, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "ts_read1", name: tosse("get_tasks"), input: { project_id: "ef02be22" } },
          { type: "tool_use", id: "ts_read2", name: tosse("get_context_chain"), input: { repository_id: "8c509e62" } },
          { type: "tool_use", id: "ts_read3", name: tosse("list_subtasks"), input: { parent_task_id: TASK.id } },
        ],
      }),
    );
    this.step(420, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "ts_read1",
        // The board as it stood BEFORE the move — including the target task in « À faire ».
        // This sighting is what lets the status card render the arrow: the CRM never sends a
        // previous status back, so the card reads it out of the thread (see priorTaskStatus).
        content: json([
          { id: TASK.id, title: TASK.title, status: "À faire", priority: "Moyenne" },
          ...Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, status: "Backlog" })),
        ]),
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "ts_read2",
        content: json({ repository: { name: "tosse-code" }, project: { name: "Tosse Code" } }),
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "ts_read3",
        content: json([]),
        is_error: false,
        parent_tool_use_id: null,
      }),
    );

    this.step(320, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    const t2 = "No blockers. Moving it to **En cours**, filing the follow-up and recording the decision.\n\n";
    this.streamText("m2", t2, 3, 18);
    this.step(160, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t2 },
          {
            type: "tool_use",
            id: "ts_status",
            name: tosse("update_task_status"),
            input: { task_id: TASK.id, status: "En cours" },
          },
          {
            type: "tool_use",
            id: "ts_create",
            name: tosse("create_task"),
            input: {
              title: "Write an English README",
              project_id: "ef02be22",
              type: "Rédaction",
              priority: "Basse",
            },
          },
          {
            type: "tool_use",
            id: "ts_ctx",
            name: tosse("update_context"),
            input: { entity_type: "project", entity_id: "ef02be22", context: "…" },
          },
          // Refused by the CRM — must read as a failure, never as a quiet success.
          {
            type: "tool_use",
            id: "ts_fail",
            name: tosse("archive_task"),
            input: { task_id: "00000000-0000-0000-0000-000000000000" },
          },
          // Never answered: the card stays pending while the turn runs.
          {
            type: "tool_use",
            id: "ts_pending",
            name: tosse("update_task"),
            input: { task_id: TASK.id, priority: "Haute", due_date: "2026-10-01" },
          },
        ],
      }),
    );
    this.step(420, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "ts_status",
        content: json(TASK),
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(220, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "ts_create",
        content: json({
          id: "b1d0c0de-1111-2222-3333-444455556666",
          title: "Write an English README",
          type: "Rédaction",
          status: "À faire",
          priority: "Basse",
          assignedTo: "Armand",
          project: { id: "ef02be22", name: "Tosse Code" },
        }),
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(220, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "ts_ctx",
        content: json({ ok: true, entity_type: "project", name: "Tosse Code" }),
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(220, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "ts_fail",
        content: [{ type: "text", text: "Error: no task with id 00000000-0000-0000-0000-000000000000" }],
        is_error: true,
        parent_tool_use_id: null,
      }),
    );
  }

  startAgentMessage() {
    this.reset();
    this.emit.state({ ...this.busyState });

    this.step(200, () =>
      this.emit.item({
        kind: "user_message",
        id: "u-agent",
        parent_tool_use_id: null,
        replay: false,
        text: buildAgentMessageEnvelope(
          { conversationId: "conv-demo-codex", title: "Codex demo", repo: "demo-repo", backend: "codex" },
          "msg-demo-in",
          "The API schema changed: `GET /users` now returns `{ items, next }`.\n\nCan you update the client in `src/api/users.ts` and tell me when it's done?",
        ),
      }),
    );
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "Got it — I'll update the client, then report back to the Codex conversation.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          {
            type: "tool_use",
            id: "toolu_send_ok",
            name: "mcp__flightdeck__send_message",
            input: {
              conversation_id: "conv-demo-codex",
              text: "Done: `src/api/users.ts` now reads `items` and follows `next` for pagination. Tests pass.",
            },
          },
          {
            type: "tool_use",
            id: "toolu_send_err",
            name: "mcp__flightdeck__send_message",
            input: { conversation_id: "conv-gone", text: "Also pinging the review conversation." },
          },
          {
            type: "tool_use",
            id: "toolu_create",
            name: "mcp__flightdeck__create_conversation",
            input: {
              repo_path: "/Users/dev/demo-repo",
              title: "Review API client",
              first_message: "Review the new pagination in `src/api/users.ts` and flag anything risky.",
            },
          },
        ],
      }),
    );
    this.step(500, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_send_ok",
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { conversation_id: "conv-demo-codex", delivered: true, message_id: "msg-demo-out" },
              null,
              2,
            ),
          },
        ],
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(200, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_send_err",
        content: [{ type: "text", text: "no conversation with id 'conv-gone' (see list_conversations)" }],
        is_error: true,
        parent_tool_use_id: null,
      }),
    );
    this.step(300, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_create",
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { conversation_id: "conv-demo-codex", repo_path: "/Users/dev/demo-repo", backend: "codex", started: true, message_id: "msg-demo-create" },
              null,
              2,
            ),
          },
        ],
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    const t2 = "I've let the Codex conversation know; the review conversation no longer exists.";
    this.streamText("m2", t2, 3, 18);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [{ type: "text", text: t2 }],
      }),
    );
    this.step(200, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.004, num_turns: 2, duration_ms: 3100, duration_api_ms: 2400, ttft_ms: 500 }),
    );
    this.step(40, () => this.emit.state(idleState()));
  }

  /**
   * Typed-artifact demo (`?demo=design`): a Claude Design canvas, as the real CLI publishes one —
   * a quickstart, the typed CREATE (`type_url`, no file) and the FILL (`url` + a DATA
   * `file_path` + `files`). Opening it must show the hosted page (the mock host only replays
   * page loads), never the local `canvas.json`.
   */
  startTypedArtifact() {
    this.reset();
    this.emit.state({ ...this.busyState });
    const own = "https://claude.ai/artifact/EB7RRtdoZg1CDk4L3R1Nqg";
    const type = "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd";
    const canvas = "/private/tmp/claude-501/demo/scratchpad/sidebar-canvas/project/canvas.json";
    this.step(200, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "I'll lay the three layouts out on a Design canvas.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "toolu_qs", name: "Artifact", input: { action: "quickstart", intent: "design" } },
          {
            type: "tool_use",
            id: "toolu_create",
            name: "Artifact",
            input: { action: "publish", type_url: type, title: "Flight Deck — sidebar conversation", auto_open: "after_first_write" },
          },
        ],
      }),
    );
    this.step(300, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_qs",
        content: [
          {
            type: "text",
            text: `Quickstart for a design.\n\nThe Artifact type to start from:\n- Design [core] — Design canvas for websites, screens and UI mockups: live artboards laid out on a canvas. — type_url: ${type}`,
          },
        ],
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(300, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_create",
        content: [
          {
            type: "text",
            text: `Created a new Artifact at ${own} (version 1789733111-c4c6) from the Artifact type ${type} (release 1789673869-b48e). The type's files (fixed on it, its page included): "SKILL.md", "artifact-type/app.js", "index.html".`,
          },
        ],
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m2", role: "assistant", parent_tool_use_id: null }),
    );
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m2",
        parent_tool_use_id: null,
        blocks: [
          {
            type: "tool_use",
            id: "toolu_fill",
            name: "Artifact",
            input: {
              action: "publish",
              url: own,
              root: "/private/tmp/claude-501/demo/scratchpad/sidebar-canvas",
              file_path: canvas,
              files: { "project/Main.dc.html": "project/Main.dc.html", "project/A-Onglets.dc.html": "project/A-Onglets.dc.html" },
            },
          },
        ],
      }),
    );
    this.step(400, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_fill",
        content: [
          {
            type: "text",
            text: `Updated the Artifact at ${own} (Version 2) with ${canvas} (and any \`files\` listed). Its page comes from the Artifact type ${type} (release 1789673869-b48e) and can't be changed here.`,
          },
        ],
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m3", role: "assistant", parent_tool_use_id: null }),
    );
    const t3 = "The canvas is up — three layouts side by side, plus the closed-panel variants below.";
    this.streamText("m3", t3, 3, 18);
    this.step(150, () =>
      this.emit.item({ kind: "assistant_message", id: "m3", parent_tool_use_id: null, blocks: [{ type: "text", text: t3 }] }),
    );
    this.step(200, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.004, num_turns: 3, duration_ms: 3100, duration_api_ms: 2400, ttft_ms: 500 }),
    );
    this.step(40, () => this.emit.state(idleState()));
  }

  /**
   * Background-monitor demo (`?demo=monitor`): the agent launches the `Monitor` tool —
   * a live watch whose every stdout line is an event (read from disk, NOT the wire). One
   * watch KEEPS streaming (persistent → Stop button + live event tail) and a second one
   * ENDS a few seconds later ("stream ended"). Exercises the pinned <MonitorBar>, its
   * <TaskOutputPopover> event tail, and stop_task end to end.
   */
  startMonitor() {
    this.reset();
    this.bgTasks.clear();
    this.emit.state({ ...this.busyState });

    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "I'm setting up two watches in the background — you can keep talking to me in the meantime.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "toolu_mon", name: "Monitor", input: { command: "tail -F /var/log/app.log", description: "watch application logs", persistent: true, timeout_ms: 0 } },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_mon",
        content:
          "Monitor started (task tk_mon, persistent). You will be notified on each event. Keep working…",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_mon", kind: "monitor", tool_use_id: "toolu_mon", label: "watch application logs", status: "running", output_file: "tasks/tk_mon.output" })),
    );

    // --- second watch: a build monitor that ENDS a few seconds later (stream ended) ---
    this.step(240, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1b",
        parent_tool_use_id: null,
        blocks: [
          { type: "tool_use", id: "toolu_mon2", name: "Monitor", input: { command: "pnpm build --watch", description: "watch the build", persistent: false, timeout_ms: 8000 } },
        ],
      }),
    );
    this.step(60, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_mon2",
        content: "Monitor started (task tk_mon2, timeout 8000ms). You will be notified on each event. Keep working…",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_mon2", kind: "monitor", tool_use_id: "toolu_mon2", label: "watch the build", status: "running", output_file: "tasks/tk_mon2.output" })),
    );

    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.009, num_turns: 1, duration_ms: 5200, duration_api_ms: 3800, ttft_ms: 600 }),
    );
    // Idle main loop, but the watches keep running → conversation "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …the build watch ends a few seconds later: its row drops out of the bar.
    this.step(6000, () =>
      this.emitTask(
        taskOf({
          task_id: "tk_mon2",
          kind: "monitor",
          tool_use_id: "toolu_mon2",
          label: "watch the build",
          status: "completed",
          duration_ms: 6400,
          summary: 'Monitor "watch the build" stream ended',
          output_file: "tasks/tk_mon2.output",
        }),
      ),
    );
  }

  /**
   * Dynamic-workflow demo (`?demo=workflow`): the agent launches the `Workflow` tool — a
   * fleet of sub-agents orchestrated across phases. A Workflow is ALWAYS a background task
   * (it returns immediately with a run id), so it lives in the pinned <WorkflowBar>, NOT
   * inline in the thread. The run keeps going past the turn → its row stays in the bar with
   * live phase progress; clicking it opens the <WorkflowDetail> 3-panel view (its manifest
   * comes from the mocked `load_workflow_run`). Exercises the bar, the modal and stop_task.
   */
  startWorkflow() {
    this.reset();
    this.bgTasks.clear();
    demoWorkflowDone = false; // run starts → manifest absent → modal shows the LIVE overview
    this.emit.state({ ...this.busyState });

    this.step(220, () =>
      this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
    );
    const t1 = "I'm launching a multi-agent review of the diff via a workflow — you can keep talking to me in the meantime.\n\n";
    this.streamText("m1", t1);
    this.step(150, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m1",
        parent_tool_use_id: null,
        blocks: [
          { type: "text", text: t1 },
          { type: "tool_use", id: "toolu_wf", name: "Workflow", input: { description: "review-changes", script: "export const meta = { name: 'review-changes' }" } },
        ],
      }),
    );
    this.step(120, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_wf",
        content:
          "Workflow launched in background. Task ID: tk_wf\nSummary: Review the changed files across dimensions, verify each finding\nTranscript dir: /Users/dev/.claude/projects/x/subagents/workflows/wf_demo123\nRun ID: wf_demo123",
        is_error: false,
        parent_tool_use_id: null,
      }),
    );
    this.step(60, () =>
      this.emitTask(taskOf({ task_id: "tk_wf", kind: "workflow", tool_use_id: "toolu_wf", label: "review-changes", status: "running", progress: "Research: r-correctness" })),
    );
    // Live phase progress ticks (coarse "<phase>: <label>" from the wire).
    this.step(2600, () =>
      this.emitTask(taskOf({ task_id: "tk_wf", kind: "workflow", tool_use_id: "toolu_wf", label: "review-changes", status: "running", progress: "Research: r-perf" })),
    );

    this.step(220, () =>
      this.emit.item({ kind: "turn_result", subtype: "success", is_error: false, result: null, api_error_status: null, total_cost_usd: 0.052, num_turns: 1, duration_ms: 6200, duration_api_ms: 4500, ttft_ms: 650 }),
    );
    // Idle main loop, but the workflow keeps running → conversation "backgrounding".
    this.step(40, () => this.emit.state(idleState()));
    // …later the workflow FINISHES: the manifest "lands" (mock flag flips → the modal upgrades
    // its live overview to the rich report) and the row drops out of the bar. (A long window so
    // the live overview is easy to inspect in dev.)
    this.step(20000, () => {
      demoWorkflowDone = true;
      this.emitTask(
        taskOf({
          task_id: "tk_wf",
          kind: "workflow",
          tool_use_id: "toolu_wf",
          label: "review-changes",
          status: "completed",
          duration_ms: 18420,
          summary: 'Workflow "review-changes" completed',
        }),
      );
    });
  }

  /**
   * `?demo=remotelink` (CRM `c9bf1482`) — a remote conversation whose SSH link has not
   * attached yet when the message is sent: `WorkingIndicator` must read the link
   * wording, not the usual "thinking" activity line (see `remoteLinkText.ts`). Walks
   * both `RemoteLinkState` variants — `Connecting` (never attached), then
   * `Reconnecting` (attached once, dropped) — before the link finally attaches and
   * the turn proceeds normally, so the transition back to the ordinary activity line
   * is visible too. Mirrors the real actor's own sequencing (`session.rs::run_actor`):
   * `link` is set alongside `busy`, cleared the instant `FdAttach` would land.
   */
  startRemoteLink() {
    this.reset();
    this.emit.state({ ...baseState, busy: true, link: { kind: "connecting" } });
    this.step(2200, () => {
      this.emit.state({ ...baseState, busy: true, link: { kind: "reconnecting", attempt: 1 } });
    });
    this.step(2200, () => {
      // Attached: `link` clears and the turn proceeds like any other.
      this.emit.state({ ...baseState, busy: true, activity: "thinking", link: null });
      this.step(260, () =>
        this.emit.item({ kind: "message_started", id: "m1", role: "assistant", parent_tool_use_id: null }),
      );
      const text = "Connected — continuing with the turn.\n\n";
      this.streamText("m1", text);
      this.step(180, () =>
        this.emit.item({
          kind: "assistant_message",
          id: "m1",
          parent_tool_use_id: null,
          blocks: [{ type: "text", text }],
        }),
      );
      this.step(200, () => {
        this.emit.item({
          kind: "turn_result",
          subtype: "success",
          is_error: false,
          result: null,
          api_error_status: null,
          total_cost_usd: 0.01,
          num_turns: 1,
          duration_ms: 1200,
          duration_api_ms: 900,
          ttft_ms: 200,
        });
        this.emit.state(idleState());
      });
    });
  }

  /**
   * `?demo=remotelinkblocked` / `?demo=remotelinkblockedhost` (CRM `c9bf1482`, review
   * finding): the real incident this whole feature exists to fix — a HARD ssh-level
   * precondition failure (key refused, or the server's host identity changed) drives
   * the link straight to the TERMINAL `remote_link_blocked` thread notice instead of
   * retrying forever, mirroring `run_actor`'s own two terminal branches
   * (`ssh_link::SshLinkIssue::KeyRefused`/`HostKeyChanged` in `session.rs`): `busy`
   * clears and the state ends (`ended: true`, `link: null`), same as the real actor's
   * `flag_undelivered_if_busy` + `set_ended`. Unlike `startRemoteLink` above (the
   * happy-path recovery), this never attaches — so it is the one demo path that
   * exercises the thread notice's heading ("Can't reach this server",
   * `NOTICE_ERROR_HEADINGS`) and message text live, in a real conversation, the way
   * the incident actually looked (busy spinner → terminal notice), not just in
   * component-level unit tests.
   */
  startRemoteLinkBlocked(reason: "ssh_key_refused" | "ssh_host_key_changed") {
    this.reset();
    this.emit.state({ ...baseState, busy: true, link: { kind: "connecting" } });
    this.step(1200, () => {
      const message =
        reason === "ssh_key_refused"
          ? "This Mac's saved key was refused by this server. Reconnect this Mac in Settings → Control → Remote, then reopen this conversation."
          : "This server's identity has changed since this Mac last connected to it. Review it in Settings → Control → Remote before reconnecting.";
      this.emit.item({
        kind: "notice",
        subtype: "remote_link_blocked",
        detail: { message, reason, machine_id: "mock-machine-1", detail: null },
      });
      this.emit.state({ ...baseState, busy: false, link: null, ended: true });
    });
  }

  /** Mock the `stop_task` command: re-emit a known background task as stopped, exactly
   *  as the core would after the CLI kills it (the bar reflects it). Kind-aware summary
   *  so a watch reads "Monitor … stopped" and a command "Background command … stopped". */
  stopTask(taskId: string) {
    const t = this.bgTasks.get(taskId);
    if (!t) return;
    const fallback =
      t.kind === "monitor"
        ? `Monitor "${t.label}" stopped`
        : `Background command "${t.label}" stopped`;
    const stopped: BackgroundTask = {
      ...t,
      status: "stopped",
      summary: t.summary ?? fallback,
      duration_ms: t.duration_ms ?? 4200,
    };
    this.emitTask(stopped);
  }

  /** Resume the turn after the user answers the pending prompt. */
  resolvePermission(requestId: string, decision: PermissionDecision) {
    if (!this.awaiting || requestId !== this.pendingId) return;
    this.awaiting = false;
    this.reset();
    const allowed = decision.behavior === "allow";

    if (this.mode === "question") {
      this.emit.state({ ...baseState, busy: true, activity: null });

      // Realistic AskUserQuestion tool card, mirroring the CLI: the recorded
      // tool_use carries ONLY the questions (no answers), and the answers come
      // back in the tool_result string — exercising the parser end-to-end.
      if (decision.behavior === "allow" && decision.updated_input) {
        const upd = decision.updated_input;
        const answers =
          upd && typeof upd === "object" && !Array.isArray(upd)
            ? ((upd as Record<string, unknown>).answers as Record<string, string> | undefined)
            : undefined;
        const pairs = Object.entries(answers ?? {})
          .map(([q, a]) => `"${q}"="${a}"`)
          .join(", ");
        const resultText = pairs
          ? `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`
          : "The user skipped the questionnaire without answering.";
        this.step(120, () =>
          this.emit.item({
            kind: "assistant_message",
            id: "mq0",
            parent_tool_use_id: null,
            blocks: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: QUESTION.input }],
          }),
        );
        this.step(180, () =>
          this.emit.item({
            kind: "tool_result",
            tool_use_id: "toolu_ask",
            content: resultText,
            is_error: false,
            parent_tool_use_id: null,
          }),
        );
      }

      const txt = allowed
        ? "Perfect, noted — I'll go with this approach and start the implementation."
        : "Okay, I won't proceed for now. Let me know when you want to revisit this.";
      this.step(260, () =>
        this.emit.item({ kind: "message_started", id: "mq", role: "assistant", parent_tool_use_id: null }),
      );
      this.streamText("mq", txt, 3, 22);
      this.step(160, () =>
        this.emit.item({
          kind: "assistant_message",
          id: "mq",
          parent_tool_use_id: null,
          blocks: [{ type: "text", text: txt }],
        }),
      );
      this.step(220, () =>
        this.emit.item({
          kind: "turn_result",
          subtype: "success",
          is_error: false,
          result: null,
          api_error_status: null,
          total_cost_usd: 0.0061,
          num_turns: 1,
          duration_ms: 4200,
          duration_api_ms: 3100,
          ttft_ms: 550,
        }),
      );
      this.step(40, () => this.emit.state(idleState()));
      return;
    }

    this.emit.state({ ...baseState, busy: true, activity: allowed ? "editing" : null });
    this.step(220, () =>
      this.emit.item({
        kind: "tool_result",
        tool_use_id: "toolu_edit",
        content: allowed
          ? "The file src/App.tsx has been updated successfully."
          : "Permission denied by user.",
        is_error: !allowed,
        parent_tool_use_id: null,
      }),
    );

    const finalText = allowed ? M3_ALLOW : M3_DENY;
    this.step(260, () =>
      this.emit.item({ kind: "message_started", id: "m3", role: "assistant", parent_tool_use_id: null }),
    );
    this.streamText("m3", finalText, 3, 22);
    this.step(160, () =>
      this.emit.item({
        kind: "assistant_message",
        id: "m3",
        parent_tool_use_id: null,
        blocks: [{ type: "text", text: finalText }],
      }),
    );
    this.step(220, () =>
      this.emit.item({
        kind: "turn_result",
        subtype: allowed ? "success" : "success",
        is_error: false,
        result: null,
        api_error_status: null,
        total_cost_usd: 0.0142,
        num_turns: 3,
        duration_ms: 9300,
        duration_api_ms: 6800,
        ttft_ms: 800,
      }),
    );
    this.step(40, () => this.emit.state(idleState()));
  }

  /** Interrupt the current turn: stop streaming, finalize, go idle. */
  interrupt() {
    this.reset();
    this.awaiting = false;
    this.emit.item({
      kind: "turn_result",
      subtype: "interrupted",
      is_error: false,
      result: null,
      api_error_status: null,
      total_cost_usd: null,
      num_turns: null,
      duration_ms: null,
      duration_api_ms: null,
      ttft_ms: null,
    });
    this.emit.state(idleState());
  }

  /** Clear all pending timers (used on pause, resume, interrupt, teardown). */
  reset() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.clock = 0;
  }
}
