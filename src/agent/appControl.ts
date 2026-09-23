// The app-control EXECUTOR — the front half of the app-hosted MCP servers
// (`src-tauri/src/appmcp`). The Rust hub forwards each tool call here as an
// `app_control_request` event because the webview owns all UI state (stores,
// view, editor, live statuses); this module runs the action against the
// existing stores and answers through `app_control_respond`.
//
// Design rule (same as composerActions.ts): built ON the app's existing
// actions, never beside them — `sendConversationMessage`, `revealInEditor`,
// `createConversationInRepo`, `renameConversation`… — so a tool call and the
// equivalent click can never mean two different things.
//
// Kept React-free: pure functions over `.getState()`, so every tool is directly
// unit-testable. The React side is a thin listener host (AppControlHost.tsx).

import {
  commands,
  type BackgroundTask,
  type DiskConversation,
  type JsonValue,
  type PermissionDecision,
  type TosseTaskDetail,
} from "../ipc/client";
import { isSessionGone } from "../ipc/tosseErrors";
import {
  useConversationsStore,
  loadConversationHistory,
  createConversationInRepo,
  acknowledgeConversation,
  reactivateDiskConversation,
  stopConversationSession,
  type Conversation,
  type LinkedTosseTask,
} from "../store/conversationsStore";
import { agentRemoveConversationsEnabled, remoteAnswersEnabled } from "../store/appControl";
import { useConversationStore } from "../store/conversationStore";
import { CLAUDE_MODELS } from "../features/conversation/models";
// The thread's own map of error-bearing notice subtypes — imported, never copied, so a new
// core error subtype surfaces here the same day it surfaces on screen.
import { NOTICE_ERROR_HEADINGS } from "../features/conversation/noticeView";
import { effortLevelsForModel, type EffortLevel } from "../features/conversation/EffortGauge";
import { questionnaireUpdatedInput, asObject } from "../features/conversation/questionnaire";
import {
  runningBashCountsByConv,
  runningCountsByConv,
  useBackgroundTasksStore,
} from "../store/backgroundTasksStore";
import { useDisplay } from "../store/display";
import { useEditorStore } from "../features/editor/editorStore";
import { resolveMentionAbs } from "../features/conversation/fileMentions";
import { IDE_SETTING_PATH, ideBlockedReason, openFileInIde } from "../features/ide/openInIde";
import { useIdeStore, workspaceConversations } from "../features/ide/ideStore";
import { sendConversationMessage } from "../ipc/useCommands";
import { notifyFromAgent } from "../notifications/notify";
import {
  buildAgentMessageEnvelope,
  parseAgentMessage,
  type AgentMessageSender,
} from "../features/conversation/agentMessage";
import { pushAgentMessageToast, pushConversationCreatedToast } from "../store/toasts";
import { agentStatusForEntry } from "./useAgentStatus";
import type { AgentStatus } from "./status";
import type { NoticeItem, SessionEntry, Turn } from "../store/types";
import type { View } from "../ui/shortcuts";
// The single gate for a task id that will become a URL — shared with the thread card, which
// builds the same CRM link from the same agent-supplied field. See its module doc.
import { canonicalTosseTaskId, sameTaskId } from "../features/tosse/taskId";

/** App-level helpers only the mounted React tree can provide (view switching
 *  lives in App state, injected the same way `runAppAction` receives it). */
export interface AppControlHelpers {
  changeView: (view: View) => void;
  /** The view on screen RIGHT NOW — so a tool can route to where the user is looking
   *  instead of yanking them somewhere else (see `defaultOpenFileView`). Optional: a host
   *  that cannot tell (none today) simply gets the historical behaviour. */
  currentView?: View;
  /** Whether the TOSSE view currently exists (signed in + pref on). `changeView`
   *  silently no-ops on an unavailable view; a TOOL result must not — the caller
   *  needs the refusal, not a success that did nothing. */
  tosseAvailable: boolean;
}

/** Trim long free text for a voice/text summary payload. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The last path segment, as a human repo label (mirrors repoName elsewhere). */
function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/** Lexically canonicalize an agent-supplied ABSOLUTE folder path: collapse
 *  `//`, resolve `.`/`..` segments, strip the trailing slash. `addRepo`'s
 *  idempotence is exact string equality on the stored path, so `/x/y/` must
 *  normalize to `/x/y` — models emit trailing slashes all the time, and each
 *  variant would otherwise register a duplicate, persisted repo group. */
function normalizeFolderPath(tool: string, raw: string): string {
  if (!raw.startsWith("/")) throw new Error(`${tool}: the path must be absolute`);
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Assert the path is an existing FOLDER. `pathExists` is `Path::exists()` —
 *  true for plain files too — while `readDir` errors on both a missing path and
 *  a file, which is exactly the check a repo root needs. */
async function assertFolder(tool: string, path: string): Promise<void> {
  const dir = await commands.readDir(path);
  if (dir.status !== "ok") throw new Error(`${tool}: '${path}' is not an existing folder`);
}

// ---- Caller / target resolution ---------------------------------------------

/** A conversation as the sender of an agent message (its attribution envelope). */
function senderOf(conv: Conversation): AgentMessageSender {
  const repo = useConversationsStore.getState().repos.find((r) => r.id === conv.repoId);
  return {
    conversationId: conv.id,
    title: conv.name,
    repo: repo ? baseName(repo.path) : null,
    backend: conv.kind,
  };
}

/**
 * The label of the REMOTE machine actually hosting `conv`, when this Mac only relays
 * it (its repo carries a `machineId`) — `null` for a local conversation. Additive
 * field for `list_conversations`/`read_conversation` (C9): lets the phone relay
 * (flightdeck-remote) fold a conversation the Mac lists with one its host
 * `flightdeckd` daemon ALSO lists into a single row (see PROTOCOL.md §5/§5.3) —
 * `flightdeckd` never emits this itself (its own conversations are always local to
 * it), so its presence here is what tells the phone "this row is a relay, prefer the
 * daemon's own row instead". Falls back to the machine's id if it somehow has no
 * label (never happens in practice — `add_machine` always sets one) rather than
 * silently reporting local.
 */
function hostedOnFor(conv: Conversation): string | null {
  const s = useConversationsStore.getState();
  const repo = s.repos.find((r) => r.id === conv.repoId);
  if (!repo?.machineId) return null;
  const machine = s.machines.find((m) => m.id === repo.machineId);
  return machine ? machine.label || machine.id : repo.machineId;
}

/** Only the app attributes a message to a conversation. A caller with no conversation (voice,
 *  phone relay, external MCP client) handing in a ready-made envelope would pass its text off
 *  as another conversation's — on screen and to the recipient model alike. */
function assertNotForgedEnvelope(tool: string, argName: string, text: string): void {
  if (parseAgentMessage(text))
    throw new Error(
      `${tool}: '${argName}' cannot be a <flightdeck-message> envelope — only a conversation's own send is attributed`,
    );
}

/** The conversation a live session handle belongs to (the in-app caller). */
function convBySession(session: string | null): Conversation | null {
  if (!session) return null;
  return (
    useConversationsStore.getState().conversations.find((c) => c.handle === session) ?? null
  );
}

/** Resolve a tool's target conversation: explicit `conversation_id` wins, else
 *  the calling session's own conversation. Throws a caller-readable error. */
function resolveTarget(args: Record<string, unknown>, session: string | null): Conversation {
  const explicit = typeof args.conversation_id === "string" ? args.conversation_id : null;
  if (explicit) {
    const conv = useConversationsStore.getState().conversations.find((c) => c.id === explicit);
    if (!conv) throw new Error(`no conversation with id '${explicit}' (see list_conversations)`);
    return conv;
  }
  const own = convBySession(session);
  if (!own) throw new Error("conversation_id is required (no calling conversation to default to)");
  return own;
}

// ---- Status & serialization --------------------------------------------------

/** The rich status of one conversation, from the same signals the UI derives. */
function statusFor(conv: Conversation): AgentStatus {
  const entry = useConversationStore.getState().sessions[conv.id];
  const tasks = useBackgroundTasksStore.getState().sessions;
  return agentStatusForEntry(
    conv.handle,
    entry,
    conv.pendingReminder,
    runningCountsByConv(tasks)[conv.id] ?? 0,
    runningBashCountsByConv(tasks)[conv.id] ?? 0,
    useDisplay.getState().alertOnBackgroundBash,
  );
}

/** Flatten a status to what an agent needs: a kind plus its one salient detail. */
function statusJson(s: AgentStatus): Record<string, unknown> {
  switch (s.kind) {
    case "running":
      return { kind: "running", activity: s.activity };
    case "backgrounding":
      return { kind: "backgrounding", background_tasks: s.count };
    case "needInput":
      return { kind: "needs_input", question: s.prompt ? clip(s.prompt, 400) : null };
    case "needIntervention":
      return { kind: "needs_permission", tool: s.tool };
    case "error":
      return { kind: "error", message: s.message };
    default:
      return { kind: s.kind };
  }
}

/** One turn → readable text. User turns quote the prompt; assistant turns join
 *  their text blocks and summarize tool calls in one line each. Images become
 *  an `[image]` placeholder (the transcript convention — `history.rs`
 *  `push_user`), so an image-only turn never vanishes from the digest. */
function turnText(turn: Turn): string {
  const parts: string[] = [];
  for (const b of turn.blocks) {
    if (b.type === "text" && b.text.trim()) parts.push(b.text.trim());
    else if (b.type === "tool_use") parts.push(`[tool: ${b.name}]`);
    // Images ride the unspecialized "other" bucket (NormalizedBlock has no
    // image variant) — surface a placeholder rather than dropping the turn.
    else if (
      b.type === "other" &&
      typeof b.raw === "object" &&
      b.raw !== null &&
      (b.raw as { type?: unknown }).type === "image"
    )
      parts.push("[image]");
    // thinking / unknown blocks are noise for a text digest.
  }
  if (turn.streamingText.trim()) parts.push(turn.streamingText.trim());
  // Optimistic user turns carry their images OUTSIDE the blocks (Turn.images).
  if (parts.length === 0 && turn.images?.length) parts.push("[image]");
  return parts.join("\n");
}

/** An error-bearing notice as ONE plain-text line, or `null` for the quiet ones
 *  (`control_change`, `interrupted`, `remote_link`…). Routes on exactly what `NoticeBlock`
 *  routes on — `NOTICE_ERROR_HEADINGS` plus the two subtypes it headings itself — so the
 *  "zero silent error" contract holds on the MCP surface too: a conversation that died
 *  (`process_exited`) must not read to another agent as one still thinking. */
function noticeErrorText(n: NoticeItem): string | null {
  const d = (n.detail ?? null) as Record<string, unknown> | null;
  const str = (k: string): string | null => {
    const v = d?.[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const message = str("message");
  if (n.subtype === "control_error")
    return `Setting "${str("control") ?? "control"}" rejected by Claude Code${
      message ? `: ${message}` : ""
    }`;
  const heading = NOTICE_ERROR_HEADINGS[n.subtype] ?? (n.subtype === "error" ? "Error" : null);
  if (!heading) return null;
  return message ? `${heading}: ${message}` : heading;
}

/**
 * How many system lines one digest may carry, on top of the dialogue turns asked for.
 *
 * They are collected newest-first, so the cap drops the OLDEST ones — and the count of what
 * was dropped is reported rather than swallowed. Generous on purpose: the point of the cap is
 * only to keep a flapping session from returning megabytes, not to ration errors.
 */
const MAX_SYSTEM_LINES = 20;

/**
 * Serialize the tail of a conversation's timeline as plain-text turns.
 *
 * `maxTurns` is a budget of DIALOGUE turns: system lines (a dead process, a rejected control
 * request, a failed background task, a turn that ended in error) ride alongside it and are
 * capped separately. They used to be counted in, which meant a conversation that crashed in a
 * burst — `process_exited` then `protocol_error` then… — spent the caller's whole `max_turns`
 * on its own death rattle and answered with barely any of the dialogue it was asked for.
 */
function serializeEntry(entry: SessionEntry, maxTurns: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let dialogue = 0;
  let systemLines = 0;
  let omittedSystem = 0;
  const pushSystem = (text: string) => {
    if (systemLines >= MAX_SYSTEM_LINES) {
      omittedSystem++;
      return;
    }
    systemLines++;
    out.push({ role: "system", text });
  };
  for (let i = entry.timeline.length - 1; i >= 0 && dialogue < maxTurns; i--) {
    const e = entry.timeline[i];
    if (e.kind === "turn_result") {
      const meta = entry.turnResults[e.id];
      if (meta?.isError) pushSystem(`[turn ended in error: ${meta.subtype}]`);
      continue;
    }
    if (e.kind === "error") {
      const err = entry.errors[e.id];
      if (err) pushSystem(`[error: ${err.message}]`);
      continue;
    }
    if (e.kind === "notice") {
      const n = entry.notices[e.id];
      if (!n) continue;
      // A failed background task is a discreet notice in the thread, but still something a
      // reader of this conversation must see.
      if (n.subtype === "task_failed") {
        const msg = (n.detail as { message?: unknown } | null)?.message;
        pushSystem(`[${typeof msg === "string" ? msg : "Background task failed"}]`);
        continue;
      }
      // …and so is every OTHER error-bearing notice: a dead process, a rejected control
      // request, a transcript that would not restore. Dropping them let a conversation
      // polling `read_conversation` on a crashed one see the prompt with no answer and no
      // system line, and conclude it was still thinking.
      const err = noticeErrorText(n);
      if (err) pushSystem(`[${clip(err, 400)}]`);
      continue;
    }
    if (e.kind !== "turn") continue;
    const turn = entry.turns[e.id];
    // Sub-agent (Task) side-thread turns are internal work, not the dialogue.
    if (!turn || turn.parentToolUseId) continue;
    const text = turnText(turn);
    if (!text) continue;
    // A message another conversation sent: attributed, rather than passing the envelope's
    // tags off as the user's own words.
    const agent = turn.role === "user" ? parseAgentMessage(text) : null;
    dialogue++;
    if (agent) {
      out.push({
        role: "user",
        from_conversation: { conversation_id: agent.fromConversationId, title: agent.fromTitle },
        text: clip(agent.body, 4000),
      });
      continue;
    }
    out.push({ role: turn.role, text: clip(text, 4000) });
  }
  // Said, not swallowed. `out` is reversed below, so this lands at the top — ahead of every
  // system line that survived, which are all newer than the dropped ones.
  if (omittedSystem > 0)
    out.push({ role: "system", text: `[${omittedSystem} older system line(s) omitted]` });
  return out.reverse();
}

// ---- The tools ---------------------------------------------------------------

function listConversations(session: string | null): unknown {
  const s = useConversationsStore.getState();
  const caller = convBySession(session);
  return s.conversations.map((c) => {
    const repo = s.repos.find((r) => r.id === c.repoId);
    return {
      conversation_id: c.id,
      title: c.name,
      repository: repo ? { name: baseName(repo.path), path: repo.path } : null,
      backend: c.kind,
      status: statusJson(statusFor(c)),
      model: c.model,
      effort: c.ultracode ? "ultracode" : c.effort,
      last_activity_at: c.lastActivityAt,
      // Background work running NOW, whatever the status: `status.background_tasks` only
      // exists in `backgrounding`, so a remote client could not otherwise tell that a
      // `running` / `needs_*` conversation also has background work going on.
      background_tasks: runningBackgroundCount(c),
      // Additive (C9): the join key across hosts (§5) + the relay-vs-local marker
      // (§5.3) the phone relay uses to fold a Mac-relayed row into its daemon's own.
      session_id: c.sessionId,
      hosted_on: hostedOnFor(c),
      ...(caller && caller.id === c.id ? { is_caller: true } : {}),
    };
  });
}

function whoami(session: string | null): unknown {
  const conv = convBySession(session);
  if (!conv) throw new Error("whoami: no conversation is associated with this caller");
  const repo = useConversationsStore.getState().repos.find((r) => r.id === conv.repoId);
  return {
    conversation_id: conv.id,
    title: conv.name,
    repository: repo ? { name: baseName(repo.path), path: repo.path } : null,
    cwd: conv.liveCwd ?? conv.cwd,
    backend: conv.kind,
    model: conv.model,
    status: statusJson(statusFor(conv)),
  };
}

async function readConversation(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  const rawMax = typeof args.max_turns === "number" ? args.max_turns : 10;
  const maxTurns = Math.max(1, Math.min(40, Math.floor(rawMax)));
  // Cold conversation: hydrate its timeline from the on-disk transcript first
  // (idempotent, no process spawned).
  await loadConversationHistory(conv.id);
  const entry = useConversationStore.getState().sessions[conv.id];
  const turns = entry ? serializeEntry(entry, maxTurns) : [];
  return {
    conversation_id: conv.id,
    title: conv.name,
    status: statusJson(statusFor(conv)),
    model: conv.model,
    effort: conv.ultracode ? "ultracode" : conv.effort,
    turns,
    // Additive (C9) — same meaning as in list_conversations, see `hostedOnFor`.
    session_id: conv.sessionId,
    hosted_on: hostedOnFor(conv),
  };
}

/** The curated Claude model catalogue + the effort levels each one supports. */
function listModels(): unknown {
  return {
    models: CLAUDE_MODELS.map((m) => ({
      value: m.value,
      label: m.label,
      efforts: effortLevelsForModel(m.value),
    })),
  };
}

function setConversationModel(args: Record<string, unknown>, session: string | null): unknown {
  const conv = resolveTarget(args, session);
  const model = typeof args.model === "string" ? args.model.trim() : "";
  if (!model) throw new Error("set_conversation_model: 'model' is required");
  if (!CLAUDE_MODELS.some((m) => m.value === model))
    throw new Error(`set_conversation_model: unknown model '${model}' (see list_models)`);
  useConversationsStore.getState().setConvModel(conv.id, model);
  return { conversation_id: conv.id, model };
}

/** Interrupt the target conversation's CURRENT turn (the composer's stop button). */
async function interruptConversation(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  if (!conv.handle) throw new Error("the conversation is not running — nothing to interrupt");
  const res = await commands.interruptSession(conv.handle);
  if (res.status === "error") throw new Error(res.error);
  return { conversation_id: conv.id, interrupted: true };
}

/** Power the live process off WITHOUT archiving — the stream's "turn off". */
async function stopStream(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  if (!conv.handle) return { conversation_id: conv.id, stopped: false, note: "already off" };
  await stopConversationSession(conv.id);
  return { conversation_id: conv.id, stopped: true };
}

/**
 * A task the registry holds that is NOT background work: a FOREGROUND sub-agent (the
 * `Agent` tool without run_in_background). It is part of the running turn and renders
 * inline in the thread, never in the pinned bars — AgentBar keeps only the detached ones
 * (`bgAgentIds`). Codex has no detached/foreground split: every sub-agent is background
 * (mirrors AgentBar).
 */
function isForegroundTask(t: BackgroundTask, conv: Conversation): boolean {
  if (t.kind !== "agent" || conv.kind === "codex") return false;
  const detached = useConversationStore.getState().sessions[conv.id]?.bgAgentIds ?? [];
  return t.tool_use_id == null || !detached.includes(t.tool_use_id);
}

/** How many background tasks are running now — what the desktop's pinned bars list. */
function runningBackgroundCount(conv: Conversation): number {
  const tasks = useBackgroundTasksStore.getState().sessions[conv.id] ?? {};
  let n = 0;
  for (const t of Object.values(tasks)) {
    if (t.status === "running" && !isForegroundTask(t, conv)) n++;
  }
  return n;
}

/** The conversation's background tasks (live-only registry). The registry KEEPS finished
 *  tasks (completed / failed / stopped), so callers that want what is running now must
 *  filter on `status`. `command` is the raw shell command of a Bash task — the readable
 *  fallback when the agent gave the task no `label` (what the desktop bar shows). The rest
 *  is what the pinned bars print beside the name, so a remote client can draw the same
 *  rows: a sub-agent's type + model (AgentBar), a workflow's latest "<phase>: <label>"
 *  (WorkflowBar), and the usage roll-up when the wire has one (rare while running). */
function listBackgroundTasksTool(args: Record<string, unknown>, session: string | null): unknown {
  const conv = resolveTarget(args, session);
  const tasks = useBackgroundTasksStore.getState().sessions[conv.id] ?? {};
  return {
    conversation_id: conv.id,
    tasks: Object.values(tasks).map((t) => ({
      task_id: t.task_id,
      kind: t.kind,
      status: t.status,
      label: t.label ?? null,
      command: t.command ? clip(t.command, 400) : null,
      subagent_type: t.subagent_type ?? null,
      model: t.model ?? null,
      progress: t.progress ?? null,
      tokens: t.tokens ?? null,
      tool_uses: t.tool_uses ?? null,
      duration_ms: t.duration_ms ?? null,
      ...(isForegroundTask(t, conv) ? { foreground: true } : {}),
    })),
  };
}

/** Stop ONE background task (bg Bash / Monitor / sub-agent / workflow) by id. */
async function stopBackgroundTask(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  const taskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!taskId) throw new Error("stop_background_task: 'task_id' is required (see list_background_tasks)");
  if (!conv.handle) throw new Error("the conversation is not running");
  const res = await commands.stopTask(conv.handle, taskId);
  if (res.status === "error") throw new Error(res.error);
  return { conversation_id: conv.id, task_id: taskId, stopping: true };
}

/** Classify a pending can_use_tool request for a remote card. */
function pendingKind(toolName: string): "questions" | "plan" | "permission" {
  if (toolName === "AskUserQuestion") return "questions";
  if (toolName === "ExitPlanMode") return "plan";
  return "permission";
}

/** Full detail of the target conversation's pending requests (permission prompts,
 *  questionnaires, plan approvals). Read-only; the raw `input` carries the
 *  questionnaire's options / the plan's markdown, exactly as the desktop sees them. */
function getPendingRequest(args: Record<string, unknown>, session: string | null): unknown {
  const conv = resolveTarget(args, session);
  const perms = useConversationStore.getState().sessions[conv.id]?.pendingPermissions ?? [];
  return {
    conversation_id: conv.id,
    requests: perms.map((p) => ({
      request_id: p.request_id,
      kind: pendingKind(p.tool_name),
      tool_name: p.tool_name,
      title: p.title,
      description: p.description,
      input: p.input,
    })),
  };
}

/** Answer ONE pending request (allow/deny).
 *
 *  A QUESTION (the `AskUserQuestion` tool) is NOT a permission prompt — it does
 *  not gate a tool run, it just collects the user's choice — so answering one is
 *  never privilege-raising and needs NO opt-in: the answer rides in as the
 *  questionnaire's `updated_input.answers` (a free-text answer becomes the
 *  question's "Other" choice), built here from the pending request's own input so
 *  the caller supplies only the answer text, not the whole questionnaire blob.
 *
 *  A permission prompt / plan approval DOES decide what runs, so it stays behind
 *  the explicit Settings → Control opt-in (answering a specific visible request
 *  is not privilege-raising like changing the permission MODE, but it hands real
 *  control to whoever holds the pairing token — off by default). */
async function answerRequest(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  const requestId = typeof args.request_id === "string" ? args.request_id.trim() : "";
  if (!requestId) throw new Error("answer_request: 'request_id' is required (see get_pending_request)");
  const behavior = args.behavior === "allow" || args.behavior === "deny" ? args.behavior : null;
  if (!behavior) throw new Error("answer_request: 'behavior' must be 'allow' or 'deny'");
  const perms = useConversationStore.getState().sessions[conv.id]?.pendingPermissions ?? [];
  const pending = perms.find((p) => p.request_id === requestId);
  if (!pending) {
    throw new Error(
      `no pending request '${requestId}' — it may have been answered or withdrawn (see get_pending_request)`,
    );
  }
  const isQuestion = pending.tool_name === "AskUserQuestion";
  if (!isQuestion && !remoteAnswersEnabled()) {
    throw new Error(
      "answering permission requests is turned off — enable it in Settings → Control " +
        '("Answer permission requests remotely"). Questions (AskUserQuestion) can always be answered.',
    );
  }
  // Mirror useAnswerPermission: fail loudly when the process died with the card
  // up — silently dismissing is indistinguishable from a delivered answer.
  if (!conv.handle) throw new Error("the session ended before the answer could be sent");

  let decision: PermissionDecision;
  let answers: Record<string, string> | undefined;
  if (behavior === "deny") {
    decision = {
      behavior: "deny",
      message:
        typeof args.message === "string" && args.message.trim() ? args.message.trim() : "Rejected.",
    };
  } else if (isQuestion) {
    // If the caller already built a full updated_input with answers, respect it;
    // otherwise coerce the loose `answers` payload onto the real questions.
    const direct = asObject((args.updated_input ?? null) as JsonValue);
    if (Object.keys(asObject(direct.answers)).length > 0) {
      decision = { behavior: "allow", updated_input: args.updated_input as JsonValue };
    } else {
      const built = questionnaireUpdatedInput(pending.input, args.answers ?? null);
      if (Object.keys(built.answers).length === 0) {
        throw new Error(
          built.unmatched.length
            ? `answer_request: none of your answers matched this question (${built.unmatched.join("; ")}) — ` +
              "key them by the question text from get_pending_request"
            : "answer_request: provide 'answers' for the question (see get_pending_request) — " +
              "a free-text answer is accepted as the 'Other' choice",
        );
      }
      answers = built.answers;
      decision = { behavior: "allow", updated_input: built.updatedInput as JsonValue };
    }
  } else {
    decision = { behavior: "allow", updated_input: (args.updated_input ?? null) as JsonValue | null };
  }
  useConversationStore.getState().removePermission(conv.id, requestId);
  const res = await commands.answerPermission(conv.handle, requestId, decision);
  if (res.status === "error") throw new Error(res.error);
  void commands.publishControlEvent("attention_cleared", conv.id, conv.name, {
    reason: "answered",
    request_id: requestId,
    behavior,
  });
  return { conversation_id: conv.id, request_id: requestId, behavior, ...(answers ? { answers } : {}) };
}

function setConversationEffort(args: Record<string, unknown>, session: string | null): unknown {
  const conv = resolveTarget(args, session);
  const effort = typeof args.effort === "string" ? args.effort.trim() : "";
  if (!effort) throw new Error("set_conversation_effort: 'effort' is required");
  const store = useConversationsStore.getState();
  if (effort === "ultracode") {
    store.setConvUltracode(conv.id);
  } else {
    const valid = effortLevelsForModel(conv.model);
    if (!valid.includes(effort as EffortLevel))
      throw new Error(
        `set_conversation_effort: '${effort}' not available for this model (valid: ${valid.join(", ")})`,
      );
    store.setConvEffort(conv.id, effort);
  }
  return { conversation_id: conv.id, effort };
}

async function sendMessage(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new Error("send_message: 'text' is required");
  // Guard the one queue-jumping foot-gun: an in-app agent messaging ITSELF would
  // inject into its own running turn — surreal and never what was meant.
  const caller = convBySession(session);
  if (caller && caller.id === conv.id)
    throw new Error("send_message: a conversation cannot message itself (that's your own thread)");
  if (!caller) assertNotForgedEnvelope("send_message", "text", text);
  // From another conversation, the message travels inside its attribution envelope, so the
  // recipient — model AND reader, live AND after a reload — knows which agent sent it; the
  // id it carries links the send to its arrival for navigation. A caller with no conversation
  // (the voice agent, the phone relay, an external MCP client) is the human speaking through
  // another surface: that text goes as is.
  const messageId = caller ? crypto.randomUUID() : null;
  const wireText =
    caller && messageId
      ? buildAgentMessageEnvelope(senderOf(caller), messageId, text)
      : text;
  // Hydrate a COLD conversation's timeline BEFORE the send creates a live entry:
  // `loadConversationHistory` is additive and assumes it runs on a fresh entry —
  // loading it later (read_conversation, or the user opening the thread) would
  // replay the whole past transcript ON TOP of the live turns, corrupting the
  // timeline (same order-of-operations as FlightDeckReplyModal's send path).
  await loadConversationHistory(conv.id);
  const busy = useConversationStore.getState().sessions[conv.id]?.state.busy ?? false;
  // `queued: busy` mirrors the composer's own send exactly (pending badge +
  // durable injectedMidTurn flag for clean-output's round grouping) — a tool
  // call and the equivalent click must never mean two different things.
  await sendConversationMessage(conv.id, { text: wireText, queued: busy });
  if (caller && messageId) {
    pushAgentMessageToast({
      fromConvId: caller.id,
      fromTitle: caller.name,
      toConvId: conv.id,
      toTitle: conv.name,
      messageId,
      excerpt: clip(text.replace(/\s+/g, " "), 160),
    });
  }
  return {
    conversation_id: conv.id,
    delivered: true,
    ...(messageId ? { message_id: messageId } : {}),
    ...(busy ? { note: "the agent was mid-turn; the message was queued/injected" } : {}),
  };
}

async function createConversation(args: Record<string, unknown>, session: string | null) {
  const raw = typeof args.repo_path === "string" ? args.repo_path.trim() : "";
  if (!raw) throw new Error("create_conversation: 'repo_path' is required");
  // Before anything is created: a refused first message must not leave an empty conversation.
  if (!convBySession(session) && typeof args.first_message === "string")
    assertNotForgedEnvelope("create_conversation", "first_message", args.first_message);
  const repoPath = normalizeFolderPath("create_conversation", raw);
  // Validate the FOLDER exists BEFORE registering anything — a typo'd path (or
  // a plain file) would otherwise create a permanent empty repo group.
  await assertFolder("create_conversation", repoPath);
  const backend = args.backend === "codex" ? "codex" : "claude";
  // Creating from a tool must not steal what the human is looking at:
  // `addConversation` auto-selects (the "+"-button semantic), so restore the
  // previous selection afterwards — `focus_conversation` is the explicit tool
  // for bringing it on screen.
  const prevActive = useConversationsStore.getState().activeId;
  const id = createConversationInRepo(repoPath, backend);
  if (prevActive && prevActive !== id) {
    useConversationsStore.getState().selectConversation(prevActive);
  }
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title) useConversationsStore.getState().renameConversation(id, title);
  const first = typeof args.first_message === "string" ? args.first_message.trim() : "";
  // Created BY a conversation: its first message carries the same attribution as a
  // send_message (the new agent knows who started it; the id links both sides), and the
  // creation is announced. A caller with no conversation is the human: nothing changes.
  const caller = convBySession(session);
  const messageId = caller && first ? crypto.randomUUID() : null;
  if (first) {
    const text = caller && messageId ? buildAgentMessageEnvelope(senderOf(caller), messageId, first) : first;
    await sendConversationMessage(id, { text });
  }
  if (caller) {
    pushConversationCreatedToast({
      fromConvId: caller.id,
      fromTitle: caller.name,
      convId: id,
      title:
        useConversationsStore.getState().conversations.find((c) => c.id === id)?.name ??
        (title || baseName(repoPath)),
      repo: baseName(repoPath),
      messageId,
    });
  }
  return {
    conversation_id: id,
    repo_path: repoPath,
    backend,
    started: Boolean(first),
    ...(messageId ? { message_id: messageId } : {}),
  };
}

function focusConversation(
  args: Record<string, unknown>,
  session: string | null,
  helpers: AppControlHelpers,
) {
  const conv = resolveTarget(args, session);
  useConversationsStore.getState().selectConversation(conv.id);
  helpers.changeView("conversation");
  return { conversation_id: conv.id, focused: true };
}

function renameConversation(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) throw new Error("rename_conversation: 'name' is required");
  useConversationsStore.getState().renameConversation(conv.id, name);
  return { conversation_id: conv.id, title: name };
}

/** Mark a conversation as seen — clears its "needs attention" highlight, exactly
 *  as the card's "Seen" button does. Non-destructive: it only dismisses the
 *  alert; the conversation, its live session and its history are untouched. */
function acknowledgeConv(args: Record<string, unknown>, session: string | null) {
  const conv = resolveTarget(args, session);
  acknowledgeConversation(conv.id);
  return { conversation_id: conv.id, acknowledged: true };
}

/** Remove a conversation from the active Flight Deck list. NOT a history delete:
 *  the transcript stays on disk (re-openable from History) and ⌘Z undoes it — it
 *  just clears the conversation from the live list (and stops its session).
 *  Gated by a user policy (`agentRemoveConversations`) and refuses to remove the
 *  caller's own conversation (that would tear down the session mid-tool-call). */
function removeConversationTool(args: Record<string, unknown>, session: string | null) {
  if (!agentRemoveConversationsEnabled()) {
    throw new Error(
      "removing conversations is turned off — enable it in Settings → Control " +
        "(\"Let agents remove conversations from the list\")",
    );
  }
  const conv = resolveTarget(args, session);
  if (session && conv.handle === session) {
    throw new Error("can't remove the calling conversation — target another one by conversation_id");
  }
  const title = conv.name;
  useConversationsStore.getState().removeConversation(conv.id);
  return {
    conversation_id: conv.id,
    title,
    removed: true,
    note: "Removed from the active list. History is preserved (reopen from History) and ⌘Z undoes this.",
  };
}

/** The best label for a past (on-disk) conversation: its AI title, else its
 *  first human message, capped. */
function diskTitle(d: DiskConversation): string {
  const t = (d.title ?? "").trim();
  return t || clip(d.excerpt, 80) || "(untitled)";
}

/** Search the on-disk history of PAST conversations (the History panel's index).
 *  With a query it ranks by relevance; without one it returns the most recent.
 *  Read-only — it surfaces candidates the agent can then `reopen_conversation`.
 *  Marks rows already live so the agent focuses instead of duplicating. */
async function searchPastConversations(args: Record<string, unknown>) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const rawLimit = typeof args.limit === "number" ? Math.floor(args.limit) : 15;
  const limit = Math.min(40, Math.max(1, rawLimit || 15));

  const listRes = await commands.listDiskConversations();
  if (listRes.status !== "ok") throw new Error(`couldn't read past conversations: ${listRes.error}`);
  const byId = new Map(listRes.data.map((d) => [d.session_id, d]));
  const activeSessionIds = new Set(
    useConversationsStore
      .getState()
      .conversations.map((c) => c.sessionId)
      .filter((s): s is string => !!s),
  );

  let rows: Array<{ d: DiskConversation; match?: string }>;
  if (query) {
    const hitRes = await commands.searchConversations(query);
    if (hitRes.status !== "ok") throw new Error(`search failed: ${hitRes.error}`);
    rows = hitRes.data
      .map((h) => ({ d: byId.get(h.session_id), match: h.snippet }))
      .filter((r): r is { d: DiskConversation; match: string } => !!r.d)
      .slice(0, limit);
  } else {
    rows = [...listRes.data]
      .sort((a, b) => b.mtime_ms - a.mtime_ms)
      .slice(0, limit)
      .map((d) => ({ d }));
  }

  return {
    query: query || null,
    count: rows.length,
    conversations: rows.map(({ d, match }) => ({
      session_id: d.session_id,
      title: diskTitle(d),
      repo: baseName(d.repo_root),
      backend: d.backend,
      last_activity_ms: d.mtime_ms,
      already_active: activeSessionIds.has(d.session_id),
      ...(match ? { match: clip(match, 160) } : {}),
    })),
  };
}

/** Bring a PAST conversation back onto the active Flight Deck list (by the
 *  session_id from search_past_conversations). Non-destructive and additive:
 *  it re-creates the list entry from the on-disk transcript, lazily (no process
 *  until the next message). If it's already active, it focuses it instead. */
async function reopenConversation(args: Record<string, unknown>) {
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  if (!sessionId) {
    throw new Error("reopen_conversation: 'session_id' is required (from search_past_conversations)");
  }
  const existing = useConversationsStore
    .getState()
    .conversations.find((c) => c.sessionId === sessionId);
  if (existing) {
    useConversationsStore.getState().selectConversation(existing.id);
    return {
      conversation_id: existing.id,
      session_id: sessionId,
      reopened: false,
      note: "Already on the active list — focused it.",
    };
  }
  const listRes = await commands.listDiskConversations();
  if (listRes.status !== "ok") throw new Error(`couldn't read past conversations: ${listRes.error}`);
  const d = listRes.data.find((x) => x.session_id === sessionId);
  if (!d) {
    throw new Error(`no past conversation with session_id '${sessionId}' (see search_past_conversations)`);
  }
  const id = reactivateDiskConversation(d);
  return {
    conversation_id: id,
    session_id: sessionId,
    title: diskTitle(d),
    reopened: true,
    note: "Brought back onto the active Flight Deck list.",
  };
}

async function addRepo(args: Record<string, unknown>) {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  if (!raw) throw new Error("add_repo: 'path' is required");
  const path = normalizeFolderPath("add_repo", raw);
  await assertFolder("add_repo", path);
  const repo = useConversationsStore.getState().addRepo(path);
  return { repo_id: repo.id, name: baseName(path), path };
}

/**
 * Where `open_file` opens when the agent did not say: WHERE THE USER IS LOOKING.
 *
 * An agent has no idea which view is on screen, so it omits `view` — and the historical
 * default ("conversation") then threw a user who was working in the IDE view out of it,
 * to show the file in a side editor they were not using. So: when the IDE view is on
 * screen AND its current workspace holds this agent's conversation, the file belongs in
 * that workspace's editor (the very route a click on its file mention takes there).
 * Everywhere else the historical default stands — including when the workspace on screen
 * is another folder's: opening a file must not swap the folder under the user.
 */
function defaultOpenFileView(conv: Conversation, helpers: AppControlHelpers): "conversation" | "ide" {
  if (helpers.currentView !== "ide") return "conversation";
  const ide = useIdeStore.getState();
  const ws = ide.workspaces.find((w) => w.id === ide.activeId);
  if (!ws) return "conversation";
  const { conversations, repos } = useConversationsStore.getState();
  return workspaceConversations(ws, conversations, repos).some((c) => c.id === conv.id)
    ? "ide"
    : "conversation";
}

async function openFile(
  args: Record<string, unknown>,
  session: string | null,
  helpers: AppControlHelpers,
) {
  const conv = resolveTarget(args, session);
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) throw new Error("open_file: 'path' is required");
  // No explicit `view` → follow the user's eyes (see defaultOpenFileView); anything other
  // than the two known views is a caller mistake, not a silent fallback.
  const view = args.view ?? defaultOpenFileView(conv, helpers);
  if (view !== "conversation" && view !== "ide")
    throw new Error("open_file: 'view' must be conversation | ide");
  if (view === "ide") {
    // Same refusal CLAUSE as open_view's ide branch — checked BEFORE any of the shared
    // resolution work below, so a switched-off IDE or a remote repository never costs a
    // wasted pathExists round-trip for a call that was always going to be refused.
    if (!useDisplay.getState().ideView)
      throw new Error(`open_file: the IDE view is switched off (${IDE_SETTING_PATH})`);
    const repo = useConversationsStore.getState().repos.find((r) => r.id === conv.repoId) ?? null;
    if (ideBlockedReason(repo))
      throw new Error("open_file: the IDE cannot open a remote repository (it browses this Mac's files)");
  }
  // '~' is a SHELL expansion the resolver doesn't perform — '<cwd>/~/notes.md'
  // would "succeed" into a nonsense tab. Refuse with the fix in the message.
  if (path === "~" || path.startsWith("~/"))
    throw new Error("open_file: '~' is not expanded — use an absolute path");
  // SHARED by both modes, computed ONCE: the same cwd resolves the path AND — in "ide"
  // mode — becomes the workspace's folder, so the file that opens and the folder it opens
  // IN can never disagree about where they came from.
  const cwd = conv.liveCwd ?? conv.cwd;
  const abs = resolveMentionAbs(cwd, path);
  // Check existence BEFORE reporting success: opening would create a preview tab whose
  // read then fails, while the tool told the agent all was well.
  if (!(await commands.pathExists(abs)))
    throw new Error(`open_file: '${abs}' does not exist`);
  const line = typeof args.line === "number" ? Math.max(1, Math.floor(args.line)) : undefined;
  const column =
    typeof args.column === "number" ? Math.max(1, Math.floor(args.column)) : undefined;

  if (view === "ide") {
    // `null` = the conversation vanished between resolution and here (deleted during the
    // pathExists await). Nothing was opened — so say so rather than report a hollow success.
    if (openFileInIde(conv.id, cwd, abs, line != null ? { line, column } : undefined) === null)
      throw new Error("open_file: the conversation no longer exists");
    helpers.changeView("ide");
    return {
      conversation_id: conv.id,
      path: abs,
      ...(line != null ? { line } : {}),
      view: "ide" as const,
    };
  }

  // Showing a file only means something on screen: focus the conversation, then
  // reveal (which opens the editor panel and jumps to the line).
  useConversationsStore.getState().selectConversation(conv.id);
  helpers.changeView("conversation");
  useEditorStore
    .getState()
    .revealInEditor(conv.id, cwd, abs, line != null ? { line, column } : undefined);
  return { conversation_id: conv.id, path: abs, ...(line != null ? { line } : {}) };
}

function openView(args: Record<string, unknown>, helpers: AppControlHelpers) {
  const view = args.view;
  if (view !== "conversation" && view !== "flightdeck" && view !== "tosse" && view !== "ide")
    throw new Error("open_view: 'view' must be conversation | flightdeck | tosse | ide");
  // `changeView` silently no-ops on an unavailable view; a TOOL must report the
  // refusal instead of returning a success that did nothing.
  if (view === "tosse" && !helpers.tosseAvailable)
    throw new Error("open_view: the TOSSE view is unavailable (not signed in to the CRM)");
  if (view === "ide" && !useDisplay.getState().ideView)
    throw new Error(`open_view: the IDE view is switched off (${IDE_SETTING_PATH})`);
  helpers.changeView(view);
  return { view };
}

function openPanel(
  args: Record<string, unknown>,
  session: string | null,
  helpers: AppControlHelpers,
) {
  const panel = args.panel;
  if (panel !== "editor" && panel !== "terminal" && panel !== "git" && panel !== "none")
    throw new Error("open_panel: 'panel' must be editor | terminal | git | none");
  const conv = resolveTarget(args, session);
  // Panels live in the conversation view; make the target visible first.
  useConversationsStore.getState().selectConversation(conv.id);
  helpers.changeView("conversation");
  const editor = useEditorStore.getState();
  editor.ensureConv(conv.id, conv.liveCwd ?? conv.cwd);
  // Git takes the side region over everything; editor and terminal can coexist
  // as a split (each setter closes Git and clears the artifact/task side views —
  // deliberately NOT each other).
  if (panel === "editor") editor.setOpen(true);
  else if (panel === "terminal") editor.setTerminalOpen(true);
  else if (panel === "git") editor.setGitOpen(true);
  else {
    editor.setOpen(false);
    editor.setTerminalOpen(false);
    editor.setGitOpen(false);
  }
  return { conversation_id: conv.id, panel };
}

async function browseFolders(args: Record<string, unknown>) {
  const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
  const depth = typeof args.depth === "number" ? Math.max(1, Math.min(3, Math.floor(args.depth))) : null;
  if (path && !path.startsWith("/"))
    throw new Error("browse_folders: 'path' must be absolute (or omitted for the home overview)");
  const res = await commands.folderTree(path, depth);
  if (res.status !== "ok") throw new Error(`browse_folders: ${res.error}`);
  // The registered repos ARE the agent's primary map — the tree is for finding
  // what is not registered yet.
  const s = useConversationsStore.getState();
  return {
    registered_repos: s.repos.map((r) => ({ name: baseName(r.path), path: r.path })),
    root: res.data.root,
    tree: res.data.tree,
    ...(res.data.truncated
      ? { note: "the tree was truncated — absent ≠ nonexistent; browse a subfolder for more" }
      : {}),
  };
}

function notifyUser(args: Record<string, unknown>) {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) throw new Error("notify_user: 'message' is required");
  const channels = notifyFromAgent(clip(message, 500), args.critical === true);
  const any = channels.banner || channels.dock || channels.sound;
  return {
    notified: any,
    ...(any ? {} : { note: "every notification channel is disabled in Settings → Notifications" }),
  };
}

/** The calling conversation, for tools that only ever act on the caller's OWN
 *  conversation — never on another one by id. */
function callerOnly(tool: string, session: string | null): Conversation {
  const conv = convBySession(session);
  if (!conv)
    throw new Error(`${tool}: only a conversation can call this (it acts on the calling conversation)`);
  return conv;
}


/**
 * The whole CRM budget of ONE `link_tosse_task` call.
 *
 * The MCP hub answers the agent "the app did not answer in time" after 30 s (`FRONT_TIMEOUT`,
 * `appmcp/mod.rs`), while resolving a SUBTASK costs two CRM reads plus, possibly, a token
 * refresh. Past the hub's deadline the agent has already been told the call failed, so a link
 * written afterwards is state it does not know it has. Kept well under 30 s so the front
 * reports the timeout ITSELF — before anything is written.
 */
const CRM_BUDGET_MS = 12_000;

/** Race one CRM read against the remaining budget. The read itself cannot be cancelled (the
 *  IPC call is already in flight); what matters is that we stop WAITING for it and fail
 *  before the write, rather than landing a link the agent was told never happened. */
async function withinBudget<T>(tool: string, deadline: number, work: Promise<T>): Promise<T> {
  const expired = () =>
    new Error(`${tool}: reading TOSSE took too long — nothing was linked, try again`);
  const left = deadline - Date.now();
  if (left <= 0) throw expired();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired()), left);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** WHAT went wrong on a CRM read, with none of WHAT THE SERVER SAID. `tosse_task_detail`'s
 *  error text carries up to 300 characters of the response body (`snippet()`), so relaying it
 *  verbatim would hand the agent a 300-byte window onto the CRM it could page through, one
 *  failed read at a time. Only the nature of the failure travels. */
function crmFailure(error: string): string {
  const http = /^TOSSE answered HTTP (\d{3})\b/.exec(error);
  if (http) return `the CRM answered HTTP ${http[1]}`;
  if (error.startsWith("TOSSE is unreachable")) return "the CRM is unreachable";
  return "the read failed";
}

/** One task read from the CRM, or `null` when the app has no usable TOSSE session.
 *
 *  Only a GONE session (never signed in, revoked) is `null` — the same reading the tasks view
 *  gives it (`isSessionGone`), and the case where the agent's own title is the best we have.
 *  Any other failure — an unknown id (HTTP 404), a malformed one (HTTP 400), an outage — is
 *  thrown: the agent named a task we could not confirm, and saying so beats linking a
 *  conversation to a guess. The message names the id and the NATURE of the failure only
 *  (see `crmFailure`). */
async function readTosseTask(
  tool: string,
  taskId: string,
  deadline: number,
): Promise<TosseTaskDetail | null> {
  // The choke point EVERY CRM read passes through: an id that is not a UUID never reaches
  // the URL builder, whoever handed it over (the agent, or the CRM's own `parentTaskId`).
  const id = canonicalTosseTaskId(taskId);
  if (!id) throw new Error(`${tool}: '${clip(taskId, 60)}' is not a task id`);
  const res = await withinBudget(tool, deadline, commands.tosseTaskDetail(id));
  if (res.status === "ok") return res.data;
  if (isSessionGone(res.error)) return null;
  throw new Error(`${tool}: couldn't read TOSSE task '${taskId}' — ${crmFailure(res.error)}`);
}

/** Resolve the task to link: from the CRM when the app can read it (a subtask resolving to
 *  its parent), else from what the agent passed. Both reads share ONE deadline, so the whole
 *  resolution stays inside `CRM_BUDGET_MS` however slow the CRM is.
 *
 *  `taskId` is already canonical (`canonicalTosseTaskId`). A task the CRM answered for carries
 *  the CRM's OWN id, byte for byte — the id the rest of the app matches conversations on; only
 *  the fallback, where nothing could be read, stores the canonical form of what the agent
 *  passed. */
async function resolveLinkTarget(
  args: Record<string, unknown>,
  taskId: string,
): Promise<{ task: LinkedTosseTask; source: "tosse" | "agent"; subtask?: LinkedTosseTask }> {
  const tool = "link_tosse_task";
  const deadline = Date.now() + CRM_BUDGET_MS;
  // The TOSSE tab's own gate: with it off, the app makes NO CRM requests at all
  // (LinkedTaskSync reads the same preference).
  const detail = useDisplay.getState().tosseTasksView
    ? await readTosseTask(tool, taskId, deadline)
    : null;
  if (detail) {
    const own = { id: detail.task.id, title: detail.task.title, status: detail.task.status };
    if (!detail.parentTaskId) return { task: own, source: "tosse" };
    // A subtask is a step of its parent's work: the conversation carries the PARENT, the
    // unit the tasks view opens, reviews and counts conversations for.
    const parent = await readTosseTask(tool, detail.parentTaskId, deadline);
    if (!parent) throw new Error(`${tool}: couldn't read the parent of subtask '${taskId}'`);
    return {
      task: { id: parent.task.id, title: parent.task.title, status: parent.task.status },
      source: "tosse",
      subtask: own,
    };
  }
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title)
    throw new Error(
      `${tool}: this app can't read TOSSE right now (not signed in, or the TOSSE tab is off) — ` +
        "pass the task's 'title' (and 'status')",
    );
  const status = typeof args.status === "string" && args.status.trim() ? args.status.trim() : null;
  return { task: { id: taskId, title, status }, source: "agent" };
}

/** Link the CALLING conversation to the TOSSE task it works on — the same link the tasks
 *  view's "Start" writes (`linkConversationToTask`), for work picked up from inside the
 *  conversation. Never silently moves an existing link to a different task: that takes an
 *  explicit `replace`, and the result names what was replaced. */
async function linkTosseTask(args: Record<string, unknown>, session: string | null) {
  const caller = callerOnly("link_tosse_task", session);
  const raw = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (!raw) throw new Error("link_tosse_task: 'task_id' is required");
  // Validated AND normalized BEFORE the resolution, so a forged id never leaves the app
  // (`resolveLinkTarget` reads the CRM ahead of every refusal below, and with the TOSSE tab
  // off nothing is read at all — the id is simply STORED, to be spent on the CRM later), and
  // so every comparison from here on is made on one single spelling of the id.
  const taskId = canonicalTosseTaskId(raw);
  if (!taskId)
    throw new Error(`link_tosse_task: 'task_id' must be a TOSSE task UUID — got '${clip(raw, 60)}'`);
  // ⚠️ The CRM read happens BEFORE the "already linked / pass replace" refusals below, and
  // that order is DELIBERATE — not an oversight to be tidied up. The id the agent passes is
  // not necessarily the id that gets linked: a SUBTASK resolves to its parent. A conversation
  // linked to the parent, handed the id of one of its subtasks, is `already_linked` — and
  // there is no way to know that before asking the CRM what the id resolves to. Refusing
  // first would answer "already linked to ANOTHER task" for what is the very same work. The
  // id is validated above, and a failed read no longer relays the CRM's answer (`crmFailure`),
  // so reading first costs nothing but the read.
  const { task, source, subtask } = await resolveLinkTarget(args, taskId);

  // Re-read AFTER the awaits: the link may have moved while the CRM was being read.
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === caller.id);
  if (!conv) throw new Error("link_tosse_task: the calling conversation no longer exists");
  const alreadyLinked = sameTaskId(conv.tosseTaskId, task.id);
  const previous =
    conv.tosseTaskId && !alreadyLinked
      ? { id: conv.tosseTaskId, title: conv.tosseTaskTitle }
      : null;
  if (previous && args.replace !== true)
    throw new Error(
      `link_tosse_task: this conversation is already linked to another task — ` +
        `'${previous.title ?? previous.id}' (${previous.id}). Pass replace: true to move the link.`,
    );
  // An UNVERIFIED entry must never erase a VERIFIED one. On the SAME task id, what the app
  // already holds came from a CRM read (`refreshLinkedTaskMeta`, the tasks view, an earlier
  // link); the agent's own title/status — `source: "agent"`, the fallback used when the CRM
  // cannot be read at all — is a guess, so it only FILLS what is missing. Otherwise a second
  // link_tosse_task during a CRM outage would replace the real title by the guess and blank
  // the known status to null.
  const linked: LinkedTosseTask =
    source === "agent" && alreadyLinked
      ? {
          // The id ALREADY stored, not our normalization of the agent's: it is the exact
          // string the CRM handed back, and what the tasks view matches conversations on
          // (`refreshLinkedTaskMeta` keys its map on the CRM's own ids).
          id: conv.tosseTaskId as string,
          title: conv.tosseTaskTitle ?? task.title,
          status: conv.tosseTaskStatus ?? task.status,
        }
      : task;
  useConversationsStore.getState().linkConversationToTask(conv.id, linked);
  return {
    conversation_id: conv.id,
    task: { task_id: linked.id, title: linked.title, status: linked.status },
    source,
    ...(alreadyLinked ? { already_linked: true } : {}),
    ...(subtask
      ? { note: `'${subtask.title}' is a subtask — linked its parent task instead` }
      : {}),
    ...(previous ? { replaced: { task_id: previous.id, title: previous.title } } : {}),
  };
}

/** Remove the CALLING conversation's task link. The CRM task itself is untouched. */
function unlinkTosseTask(session: string | null) {
  const conv = callerOnly("unlink_tosse_task", session);
  if (!conv.tosseTaskId)
    return { conversation_id: conv.id, unlinked: false, note: "not linked to any task" };
  const previous = { task_id: conv.tosseTaskId, title: conv.tosseTaskTitle };
  useConversationsStore.getState().linkConversationToTask(conv.id, null);
  return { conversation_id: conv.id, unlinked: true, previous };
}

// ---- Dispatch ----------------------------------------------------------------

/**
 * Execute one bridged tool call. Throws with a caller-readable message on any
 * failure (the host converts it into the MCP `isError` result). `session` is
 * the calling live session handle (in-app callers) or null (voice bridge).
 */
export async function executeAppControlTool(
  tool: string,
  args: Record<string, unknown>,
  session: string | null,
  helpers: AppControlHelpers,
): Promise<unknown> {
  switch (tool) {
    case "list_conversations":
      return listConversations(session);
    case "whoami":
      return whoami(session);
    case "read_conversation":
      return readConversation(args, session);
    case "send_message":
      return sendMessage(args, session);
    case "create_conversation":
      return createConversation(args, session);
    case "list_models":
      return listModels();
    case "set_conversation_model":
      return setConversationModel(args, session);
    case "set_conversation_effort":
      return setConversationEffort(args, session);
    case "interrupt_conversation":
      return interruptConversation(args, session);
    case "stop_stream":
      return stopStream(args, session);
    case "list_background_tasks":
      return listBackgroundTasksTool(args, session);
    case "stop_background_task":
      return stopBackgroundTask(args, session);
    case "get_pending_request":
      return getPendingRequest(args, session);
    case "answer_request":
      return answerRequest(args, session);
    case "focus_conversation":
      return focusConversation(args, session, helpers);
    case "rename_conversation":
      return renameConversation(args, session);
    case "acknowledge_conversation":
      return acknowledgeConv(args, session);
    case "remove_conversation":
      return removeConversationTool(args, session);
    case "search_past_conversations":
      return searchPastConversations(args);
    case "reopen_conversation":
      return reopenConversation(args);
    case "add_repo":
      return addRepo(args);
    case "browse_folders":
      return browseFolders(args);
    case "open_file":
      return openFile(args, session, helpers);
    case "open_view":
      return openView(args, helpers);
    case "open_panel":
      return openPanel(args, session, helpers);
    case "notify_user":
      return notifyUser(args);
    case "link_tosse_task":
      return linkTosseTask(args, session);
    case "unlink_tosse_task":
      return unlinkTosseTask(session);
    default:
      // A tool listed in the Rust catalogue with no case here — a wiring bug,
      // surfaced to the caller rather than swallowed.
      throw new Error(`unknown app-control tool: ${tool}`);
  }
}
