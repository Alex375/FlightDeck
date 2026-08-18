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

import { commands } from "../ipc/client";
import {
  useConversationsStore,
  loadConversationHistory,
  createConversationInRepo,
  type Conversation,
} from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import {
  runningBashCountsByConv,
  runningCountsByConv,
  useBackgroundTasksStore,
} from "../store/backgroundTasksStore";
import { useDisplay } from "../store/display";
import { useEditorStore } from "../features/editor/editorStore";
import { resolveMentionAbs } from "../features/conversation/fileMentions";
import { sendConversationMessage } from "../ipc/useCommands";
import { notifyFromAgent } from "../notifications/notify";
import { agentStatusForEntry } from "./useAgentStatus";
import type { AgentStatus } from "./status";
import type { SessionEntry, Turn } from "../store/types";
import type { View } from "../ui/shortcuts";

/** App-level helpers only the mounted React tree can provide (view switching
 *  lives in App state, injected the same way `runAppAction` receives it). */
export interface AppControlHelpers {
  changeView: (view: View) => void;
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

/** Serialize the tail of a conversation's timeline as plain-text turns. */
function serializeEntry(entry: SessionEntry, maxTurns: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = entry.timeline.length - 1; i >= 0 && out.length < maxTurns; i--) {
    const e = entry.timeline[i];
    if (e.kind === "turn_result") {
      const meta = entry.turnResults[e.id];
      if (meta?.isError)
        out.push({ role: "system", text: `[turn ended in error: ${meta.subtype}]` });
      continue;
    }
    if (e.kind === "error") {
      const err = entry.errors[e.id];
      if (err) out.push({ role: "system", text: `[error: ${err.message}]` });
      continue;
    }
    if (e.kind !== "turn") continue;
    const turn = entry.turns[e.id];
    // Sub-agent (Task) side-thread turns are internal work, not the dialogue.
    if (!turn || turn.parentToolUseId) continue;
    const text = turnText(turn);
    if (!text) continue;
    out.push({ role: turn.role, text: clip(text, 4000) });
  }
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
      last_activity_at: c.lastActivityAt,
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
    turns,
  };
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
  await sendConversationMessage(conv.id, { text, queued: busy });
  return {
    conversation_id: conv.id,
    delivered: true,
    ...(busy ? { note: "the agent was mid-turn; the message was queued/injected" } : {}),
  };
}

async function createConversation(args: Record<string, unknown>) {
  const raw = typeof args.repo_path === "string" ? args.repo_path.trim() : "";
  if (!raw) throw new Error("create_conversation: 'repo_path' is required");
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
  if (first) await sendConversationMessage(id, { text: first });
  return { conversation_id: id, repo_path: repoPath, backend, started: Boolean(first) };
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

async function addRepo(args: Record<string, unknown>) {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  if (!raw) throw new Error("add_repo: 'path' is required");
  const path = normalizeFolderPath("add_repo", raw);
  await assertFolder("add_repo", path);
  const repo = useConversationsStore.getState().addRepo(path);
  return { repo_id: repo.id, name: baseName(path), path };
}

async function openFile(
  args: Record<string, unknown>,
  session: string | null,
  helpers: AppControlHelpers,
) {
  const conv = resolveTarget(args, session);
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) throw new Error("open_file: 'path' is required");
  // '~' is a SHELL expansion the resolver doesn't perform — '<cwd>/~/notes.md'
  // would "succeed" into a nonsense tab. Refuse with the fix in the message.
  if (path === "~" || path.startsWith("~/"))
    throw new Error("open_file: '~' is not expanded — use an absolute path");
  const cwd = conv.liveCwd ?? conv.cwd;
  const abs = resolveMentionAbs(cwd, path);
  // Check existence BEFORE reporting success: revealInEditor would open a
  // preview tab whose read then fails, while the tool told the agent all was well.
  if (!(await commands.pathExists(abs)))
    throw new Error(`open_file: '${abs}' does not exist`);
  const line = typeof args.line === "number" ? Math.max(1, Math.floor(args.line)) : undefined;
  const column =
    typeof args.column === "number" ? Math.max(1, Math.floor(args.column)) : undefined;
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
  if (view !== "conversation" && view !== "flightdeck" && view !== "tosse")
    throw new Error("open_view: 'view' must be conversation | flightdeck | tosse");
  // `changeView` silently no-ops on an unavailable view; a TOOL must report the
  // refusal instead of returning a success that did nothing.
  if (view === "tosse" && !helpers.tosseAvailable)
    throw new Error("open_view: the TOSSE view is unavailable (not signed in to the CRM)");
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
      return createConversation(args);
    case "focus_conversation":
      return focusConversation(args, session, helpers);
    case "rename_conversation":
      return renameConversation(args, session);
    case "add_repo":
      return addRepo(args);
    case "open_file":
      return openFile(args, session, helpers);
    case "open_view":
      return openView(args, helpers);
    case "open_panel":
      return openPanel(args, session, helpers);
    case "notify_user":
      return notifyUser(args);
    default:
      // A tool listed in the Rust catalogue with no case here — a wiring bug,
      // surfaced to the caller rather than swallowed.
      throw new Error(`unknown app-control tool: ${tool}`);
  }
}
