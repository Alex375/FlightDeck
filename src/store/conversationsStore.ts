// Real conversation management: repos (working folders) and the conversations
// the user started in them. Each conversation IS a live `claude` session (one
// spawned process). Conversations are grouped by repo in the sidebar.
//
// Identity: a conversation's `id` is a STABLE uuid generated at creation and
// persisted — it is the identity the whole app keys off and never changes. The
// live Rust session handle (`session-N`) is a SEPARATE, in-memory-only field
// (`handle`) that is remapped on every restart and never persisted. Other
// services can therefore reference a conversation by an id independent of both
// SQL and the transport.
//
// Persistence: repos + conversation metadata (incl. the claude session_id for
// --resume) + the active selection live in the Rust core's SQLite db, behind the
// IPC commands. This store is the in-memory cache + the single persistence
// adapter: each mutation mirrors itself to the core (best-effort, off the hot
// path). The conversation MESSAGES are NOT stored here: on resume we rebuild them
// from Claude's own on-disk transcript via `loadSessionHistory`. `claude --resume`
// does NOT re-stream past messages, so the live event path delivers nothing for an
// existing conversation — reading the transcript is what fills it back in.
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { uid } from "../util/id";
import { commands } from "../ipc/client";
import type { ConversationItem, ConversationRecord, DiskConversation, ForkOutcome, PermissionMode, RepoRecord, RewindOutcome } from "../ipc/client";
import type { ReminderKind } from "../agent/status";
import { useConversationStore } from "./conversationStore";
import { useBackgroundTasksStore } from "./backgroundTasksStore";
import { useWorkflowLiveStore } from "./workflowLive";
import { useRemoteControlStore } from "./remoteControl";
import { refreshActiveGoal, useGoalStore } from "./goalStore";
import { useCodexPlanUsageStore } from "./codexPlanUsage";
import { useLastMessageSummaryStore } from "./lastMessageSummary";
// The Codex default model — seeds a Codex conversation so its persisted `model` is
// always a real Codex wire id. models.ts only imports `BackendKind` as a TYPE from
// here (erased at runtime), so this value edge is acyclic.
import { DEFAULT_CODEX_MODEL } from "../features/conversation/models";
import { userMessagePreviewText } from "../features/conversation/userText";
import { useAppErrors } from "./appErrors";
import { getCachedWindow, clearCachedWindow, clearAllCachedWindows } from "./contextWindowCache";
import { clearTodoBarOpen, clearAllTodoBarOpen } from "./todoBarUi";
import { clearComposerDraft, clearAllComposerDrafts, useComposerDrafts } from "./composerDrafts";
import {
  clearComposerAttachments,
  clearAllComposerAttachments,
} from "../features/conversation/composerAttachments";
import {
  clearArtifactsCache,
  clearAllArtifactsCache,
} from "../features/conversation/artifacts";
import {
  clearCodexControls,
  clearAllCodexControls,
  DEFAULT_CODEX_EFFORT,
} from "../features/conversation/codexControls";
import { clearWorkFold, clearAllWorkFold } from "./workFold";
import {
  clearPlanAnnotations,
  clearAllPlanAnnotations,
  snapshotPlanAnnotations,
  restorePlanAnnotations,
  type PlanConvSnapshot,
} from "./planAnnotations";
import { clearSidebarFold, clearAllSidebarFold } from "./sidebarFold";
import {
  clearManualOrderConversation,
  clearManualOrderRepo,
  clearAllManualOrder,
  useOrderSlot,
  slotFor,
  manualIndex,
  manualConvIndex,
  manualComparator,
  type OrderBlob,
} from "./manualOrder";
import { useDisplay } from "./display";
import { disposeTerminal, disposeAllTerminals } from "../features/terminal/cleanup";
import { useGitViewStore } from "../features/git/gitViewStore";
import { clearMentionCache } from "../features/conversation/mentionCache";
import { worktreeCwdFromTranscript } from "../features/git/worktree";
import { useMemo } from "react";

export const DEFAULT_CONV_NAME = "New conversation";

// Product defaults for a conversation's controls — also the spawn defaults the
// Rust core falls back to. A conversation seeds these at creation; the composer
// uses the same values as its display fallback, so UI and stream never disagree.
export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "xhigh";
// "auto" is the binary's own native default and what the live session reports;
// keeping the seed/fallback on "auto" makes the chip show "Auto mode" by default.
export const DEFAULT_PERMISSION_MODE = "auto";

/** A working folder / repository a conversation can be opened in. */
export interface Repo {
  id: string;
  /** Absolute path, or "." for the default local project. */
  path: string;
  addedAt: number;
}

/** Which agent backend drives a conversation. Chosen at creation, immutable after
 *  — every per-conversation behaviour (transport, message rendering, composer
 *  controls, usage ring) branches on it. Mirrors the persisted
 *  `ConversationRecord.backend`; pre-existing rows decode as "claude". */
export type BackendKind = "claude" | "codex";

export interface Conversation {
  /** Stable uuid — the identity everything keys off. Persisted, never changes. */
  id: string;
  name: string;
  /** FK to Repo.id — the authoritative grouping key. */
  repoId: string;
  /** Absolute path the session was spawned in (== repo.path at creation). */
  cwd: string;
  createdAt: number;
  /**
   * Unix ms timestamp of the last activity — the last message sent OR received.
   * Drives the sidebar's most-recent-first ordering; bumped by `noteActivity`.
   */
  lastActivityAt: number;
  /** Claude's own session_id from system/init — used for --resume on restart. */
  sessionId: string | null;
  /**
   * Agent backend driving this conversation ("claude" | "codex"). PERSISTED,
   * chosen at creation, immutable after — the single discriminant every
   * backend-aware surface reads (transport, rendering, composer controls, usage).
   */
  kind: BackendKind;
  /**
   * Live Rust session handle (`session-N`) for IPC and live-state lookups.
   * In-memory ONLY — never persisted; set on spawn/resume, changes each launch.
   */
  handle: string | null;
  /**
   * The worktree the session moved INTO mid-conversation via the agent's
   * `EnterWorktree` tool (parsed from its result), or null when it is in its
   * spawn cwd. In-memory ONLY. Takes precedence over the spawn `cwd` for the
   * worktree indicator/badge so they follow the agent. Cleared on `ExitWorktree`.
   */
  liveCwd: string | null;
  // ---- Per-conversation controls (persisted) -------------------------------
  // Last-known model / effort / ultracode / permission, persisted so they survive
  // a restart and are re-applied at the next (lazy) spawn. While a session is LIVE,
  // its own state (get_settings / system/init) is the source of truth for DISPLAY;
  // these are what we spawn/restore from and what a pre-spawn pick writes to.
  /** Model ALIAS chosen in the UI (e.g. "opus"); null → product default at spawn. */
  model: string | null;
  /** Reasoning-effort level (low/medium/high/xhigh); null → product default. */
  effort: string | null;
  /** Whether the "ultracode" tier (xhigh + orchestration) is on. */
  ultracode: boolean;
  /** Permission mode (default/plan/acceptEdits/auto/…); null → product default. */
  permissionMode: string | null;
  /**
   * Per-conversation "clean output" display preference — a TRISTATE:
   *  - `null`  → inherit the GLOBAL default (the app-level `useDisplay().cleanOutput`);
   *  - `true`  → explicitly folded for THIS conversation;
   *  - `false` → explicitly verbose for THIS conversation.
   * The one display pref that is per-conversation, not global. New conversations
   * start `null` (follow the global default); the composer chip writes an explicit
   * boolean. Persisted, so each conversation keeps its own reading mode across a
   * restart. The effective value is resolved by `useEffectiveCleanOutput`.
   */
  cleanOutput: boolean | null;
  /**
   * An unacknowledged, non-blocking status reminder that must survive a restart:
   * `"review"` / `"error"` / `"openQuestion"`, or null when nothing is pending.
   * Persisted because a settled state is otherwise live-only — when the process is
   * off (`handle === null`), `deriveAgentStatus` falls back to this to re-display
   * the reminder. Armed by the event router on a finished turn; cleared by "Seen"
   * (`acknowledgeConversation`) or the next message. NOT for blocking states
   * (permission / questionnaire) — those exist only while live.
   */
  pendingReminder: ReminderKind | null;
}

/** Coerce a persisted (untyped) reminder string back to the union, defaulting any
 *  unrecognised value to null — defensive against a stale/foreign DB row. */
function asReminderKind(s: string | null): ReminderKind | null {
  return s === "review" || s === "error" || s === "openQuestion" ? s : null;
}

/** Display name for a repo path — its basename. */
export function repoName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function deriveName(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return DEFAULT_CONV_NAME;
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

/** Clean a model-generated title: trim, collapse whitespace, cap length. */
function cleanTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

// Conversations whose name is an auto placeholder (the truncated first message) still
// eligible to be REPLACED by the binary's model-generated title — the VS Code
// extension's behavior. In-memory ONLY (the auto/custom distinction is intentionally
// NOT persisted, to avoid a schema column): a manual rename removes the conversation
// from this set so a late-arriving smart title never clobbers a title the user chose
// (the "onlyIfNoCustomTitle" guard). KNOWN LIMITATION of being in-memory: if the app
// quits before the async title arrives, the persisted placeholder (the truncated
// first message) stays as the name and is never re-titled on the next run — the
// placeholder is the graceful fallback, so this is cosmetic.
const autoTitlePending = new Set<string>();

// Auto-title REGENERATION (beyond the VS Code one-shot): the title is regenerated on
// each of the first few user messages, feeding the model the ACCUMULATED user intent
// — so a session that opens with "/list-tasks" and then "do task X" isn't stuck on
// "List tasks". `titleContext` holds the user messages so far (the description sent to
// the binary); `titleGenCount` caps the regenerations (and doubles as the monotonic
// `seq` we tag each request with); `lastAppliedSeq` lets `applyAutoTitle` drop an
// out-of-order (stale) response so an older-context title can't overwrite a fresher
// one. All in-memory, cleared on rename/remove/wipe.
const MAX_TITLE_REGENS = 3;
const titleContext = new Map<string, string[]>();
const titleGenCount = new Map<string, number>();
const lastAppliedSeq = new Map<string, number>();

// Undo stack for the friction-free conversation delete (the × on a row removes a
// conversation with no confirmation). `removeConversation` captures the full
// `Conversation` snapshot anyway, so undo is cheap: re-insert the row (and let the
// transcript reload from disk — the on-disk .jsonl is never touched by a delete).
// LIFO, in-memory ONLY (no SQLite/localStorage — same policy as the auto-title state):
// an accidental delete is undoable within the session, not across restarts. Cleared
// on wipe. Drained by ⌘Z via [undoRemoveConversation].
const removedConversations: Conversation[] = [];
// Parallel to the undo stack: a deleted conversation's plan annotations + notes (user-authored
// content), keyed by id so ⌘Z can re-seed them. Without this, clearPlanAnnotations on delete
// would silently lose the comments even though the row itself is restorable.
const removedPlanAnnotations = new Map<string, PlanConvSnapshot | null>();

// ---- Persistence adapter ----------------------------------------------------
// The ONE place that knows the SQL-facing DTO shape (snake_case `*Record`).
// Maps to/from the camelCase domain model and forwards to the core. If the
// storage layer changes, only this section moves.

const repoToRecord = (r: Repo): RepoRecord => ({
  id: r.id,
  path: r.path,
  added_at: r.addedAt,
});

const convToRecord = (c: Conversation): ConversationRecord => ({
  id: c.id,
  name: c.name,
  repo_id: c.repoId,
  cwd: c.cwd,
  created_at: c.createdAt,
  last_activity_at: c.lastActivityAt,
  session_id: c.sessionId,
  model: c.model,
  effort: c.effort,
  ultracode: c.ultracode,
  permission_mode: c.permissionMode,
  pending_reminder: c.pendingReminder,
  clean_output: c.cleanOutput,
  backend: c.kind,
});

const recordToRepo = (r: RepoRecord): Repo => ({
  id: r.id,
  path: r.path,
  addedAt: r.added_at,
});

const recordToConv = (c: ConversationRecord): Conversation => ({
  id: c.id,
  name: c.name,
  repoId: c.repo_id,
  cwd: c.cwd,
  createdAt: c.created_at,
  lastActivityAt: c.last_activity_at,
  sessionId: c.session_id,
  handle: null,
  liveCwd: null,
  model: c.model,
  effort: c.effort,
  ultracode: c.ultracode,
  permissionMode: c.permission_mode,
  pendingReminder: asReminderKind(c.pending_reminder),
  cleanOutput: c.clean_output,
  // Defensive: any unexpected/legacy value decodes to "claude" (the default backend).
  kind: c.backend === "codex" ? "codex" : "claude",
});

// The one user-facing message for any persistence failure (deduped in the banner),
// so a broken DB shows ONE clear warning, not a flood of per-write errors.
const PERSIST_FAILURE_MSG =
  "Couldn't save the conversation changes — they may not survive a restart.";

/** Fire a persistence command, logging AND surfacing (never throwing) on failure.
 *  Persistence is best-effort and off the hot path — a failed write must not break
 *  the UI — but it must NOT be silent: a lost rename/model/etc would vanish on the
 *  next restart with no warning, so it raises an app-level banner (deduped). */
function syncToCore(
  label: string,
  run: () => Promise<{ status: "ok"; data: unknown } | { status: "error"; error: string }>,
): void {
  void run()
    .then((res) => {
      if (res.status !== "ok") {
        console.error(`[persist] ${label} failed:`, res.error);
        useAppErrors.getState().pushError(PERSIST_FAILURE_MSG, `${label}: ${res.error}`);
      }
    })
    .catch((e) => {
      console.error(`[persist] ${label} threw:`, e);
      useAppErrors
        .getState()
        .pushError(PERSIST_FAILURE_MSG, `${label}: ${e instanceof Error ? e.message : String(e)}`);
    });
}

interface ConversationsState {
  repos: Repo[];
  conversations: Conversation[];
  activeId: string | null;
  /** Idempotent by canonical path: returns the existing repo or a new one. */
  addRepo: (path: string) => Repo;
  /** Remove a repo and all of its conversations. */
  removeRepo: (path: string) => void;
  addConversation: (c: Conversation) => void;
  selectConversation: (id: string) => void;
  removeConversation: (id: string) => void;
  /**
   * Restore the most recently `removeConversation`-d conversation (LIFO) — the ⌘Z
   * undo of the no-confirmation × delete. Re-inserts the snapshot (with a cleared
   * live handle, the old process is gone) and re-selects it; the timeline reloads
   * from the on-disk transcript and the next message re-spawns via --resume. Returns
   * true if something was restored, false if the undo stack was empty (or the
   * snapshot's repo is gone) — the caller uses that to decide whether to consume the
   * key event.
   */
  undoRemoveConversation: () => boolean;
  /** Rename a conversation to a user-chosen title. Blank or unchanged names are ignored. */
  renameConversation: (id: string, name: string) => void;
  /**
   * On the first user message of an untitled conversation: set an optimistic
   * placeholder name (the truncated message) and mark it eligible for the binary's
   * model-generated title. No-op once the conversation has any non-default name.
   */
  noteFirstMessage: (id: string, text: string) => void;
  /**
   * Accumulate `text` (a user message) and ask the live session to (re)generate a
   * smart title from the user's intent SO FAR. Called on each send; regenerates up to
   * a small cap then freezes, so the title tracks the real topic as the conversation
   * evolves (e.g. "/list-tasks" → "do task X") without churning forever. No-op unless
   * still auto-title-eligible, under the cap, and live. Title arrives via
   * `SessionTitleEvent` → [`applyAutoTitle`].
   */
  triggerAutoTitle: (id: string, text: string) => void;
  /**
   * Apply a model-generated title (from `SessionTitleEvent`) as the conversation
   * name — but ONLY if it is still auto-title-eligible (the user has not renamed it
   * since) AND `seq` is newer than the last applied (drops out-of-order/stale
   * responses). Does NOT consume eligibility: later regenerations replace it until the
   * title settles. Persisted.
   */
  applyAutoTitle: (id: string, title: string, seq: number) => void;
  /** Store Claude's session_id on the conversation for --resume (keyed by stable id). */
  noteSessionId: (id: string, sessionId: string) => void;
  /** Bind a conversation (by stable id) to its live Rust session handle. In-memory only. */
  setHandle: (id: string, handle: string | null) => void;
  /** Set/clear the worktree the session moved into (EnterWorktree/ExitWorktree). In-memory only. */
  setLiveCwd: (id: string, cwd: string | null) => void;
  /** Repoint a conversation's working directory (e.g. into a freshly created worktree) and persist it. */
  repointCwd: (id: string, cwd: string) => void;
  /**
   * Mark a conversation active "now" — bumps `lastActivityAt`, which re-sorts the
   * sidebar (most recent first). Activity is the three meaningful edits to a
   * conversation: it is created, the user sends a message, or Claude FINISHES a
   * turn (`turn_result` — the end of its agentic loop, NOT each intermediate
   * message it emits while working). `persist` mirrors the new timestamp to the
   * core; we pass it on all three since they're rare/terminal, so the recency
   * order survives a restart.
   */
  noteActivity: (id: string, opts?: { persist?: boolean }) => void;
  // ---- Controls: persist + push to the live stream --------------------------
  // Each writes the conversation record (so a pre-spawn pick survives and is
  // re-applied at spawn) AND, if a session is live, pushes the change to it. A
  // live push failure is logged, never thrown — and the core's get_settings
  // read-back then re-aligns the indicator with reality, so the UI can't lie.
  /** Set this conversation's model (the clamp of effort is the composer's job). */
  setConvModel: (id: string, model: string) => void;
  /**
   * Flip a FRESH conversation's backend AND model in one shot — how the composer's
   * unified model picker selects the backend (picking a Codex model ⇒ a Codex
   * conversation). The backend is immutable once the session exists (incompatible
   * formats), so this is a NO-OP unless the conversation is still unspawned
   * (`sessionId` and `handle` both null). Nothing to push live — there is no handle.
   */
  setConvBackend: (id: string, kind: BackendKind, model: string) => void;
  /** Set a plain effort level — clears the ultracode tier. */
  setConvEffort: (id: string, effort: string) => void;
  /** Enable the ultracode tier (effort xhigh + the separate flag). */
  setConvUltracode: (id: string) => void;
  /** Set the permission mode. */
  setConvPermission: (id: string, mode: PermissionMode) => void;
  /**
   * Set this conversation's explicit "clean output" override (persisted). Writes a
   * boolean — the chip only ever sets an explicit choice — so the conversation stops
   * inheriting the global default. Idempotent when unchanged. Purely a display pref,
   * so (unlike model/effort/permission) there is NOTHING to push to the live stream.
   */
  setConvCleanOutput: (id: string, enabled: boolean) => void;
  /**
   * Set (or clear with null) the conversation's persisted status reminder and
   * mirror it to the core. Idempotent: a no-op when the value is unchanged, so the
   * event router can call it freely on every settling edge without redundant writes.
   * Armed from the live status on a finished turn; cleared on "Seen" / next message.
   */
  setReminder: (id: string, reminder: ReminderKind | null) => void;
}

export const useConversationsStore = create<ConversationsState>()((set, get) => ({
  repos: [],
  conversations: [],
  activeId: null,

  addRepo: (path) => {
    const existing = get().repos.find((r) => r.path === path);
    if (existing) return existing;
    const repo: Repo = { id: uid(), path, addedAt: Date.now() };
    set((s) => ({ repos: [...s.repos, repo] }));
    syncToCore("upsertRepo", () => commands.upsertRepo(repoToRecord(repo)));
    return repo;
  },

  removeRepo: (path) => {
    const repo = get().repos.find((r) => r.path === path);
    if (!repo) return;
    // Forget this repo's sidebar collapse state (the group is about to disappear).
    clearSidebarFold(repo.id);
    // Forget any manual drag order for this repo (and its conversations, in every slot).
    clearManualOrderRepo(repo.id);
    // Cascade-delete every conversation under this repo. Mirror removeConversation's
    // full per-row teardown: the Rust delete_repo only cascades DB rows, so we must
    // stop each live `claude` process here (no orphan) and drop every per-conversation
    // store + persisted cache so nothing is leaked.
    for (const c of get().conversations) {
      if (c.repoId !== repo.id) continue;
      // Kill the live `claude` process (if any) so deleting a repo never leaves an
      // orphan — same no-orphan policy as removeConversation.
      if (c.handle) {
        syncToCore("stopSession", () => commands.stopSession(c.handle!));
      }
      useConversationStore.getState().dropSession(c.id);
      useBackgroundTasksStore.getState().dropSession(c.id);
      useWorkflowLiveStore.getState().drop(c.id);
      clearCachedWindow(c.id);
      disposeTerminal(c.id);
      clearTodoBarOpen(c.id);
      clearComposerDraft(c.id);
      clearComposerAttachments(c.id);
      clearCodexControls(c.id);
      clearWorkFold(c.id);
      clearPlanAnnotations(c.id);
      useGitViewStore.getState().clear(c.id);
      useRemoteControlStore.getState().clear(c.id);
      useGoalStore.getState().clear(c.id);
      // Drop the derived artifacts memo: it pins this conversation's timeline + tool results.
      clearArtifactsCache(c.id);
      useLastMessageSummaryStore.getState().clear(c.id);
      autoTitlePending.delete(c.id);
      titleContext.delete(c.id);
      titleGenCount.delete(c.id);
      lastAppliedSeq.delete(c.id);
    }
    set((s) => {
      const conversations = s.conversations.filter((c) => c.repoId !== repo.id);
      return {
        repos: s.repos.filter((r) => r.id !== repo.id),
        conversations,
        activeId: conversations.some((c) => c.id === s.activeId)
          ? s.activeId
          : (conversations[conversations.length - 1]?.id ?? null),
      };
    });
    // The db cascades the repo's conversations via the FK; just drop the repo
    // and re-sync the active selection.
    syncToCore("deleteRepo", () => commands.deleteRepo(repo.id));
    syncToCore("setActive", () => commands.setActiveConversation(get().activeId));
  },

  addConversation: (c) => {
    set((s) => ({ conversations: [...s.conversations, c], activeId: c.id }));
    syncToCore("upsertConversation", () => commands.upsertConversation(convToRecord(c)));
    syncToCore("setActive", () => commands.setActiveConversation(c.id));
  },

  selectConversation: (id) => {
    set({ activeId: id });
    syncToCore("setActive", () => commands.setActiveConversation(id));
  },

  removeConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    // Push the pre-teardown snapshot onto the undo stack BEFORE we mutate anything,
    // so ⌘Z (undoRemoveConversation) can restore the row exactly as it was. The delete
    // is friction-free (no confirm dialog), so this is the safety net.
    if (conv) {
      removedConversations.push(conv);
      // Capture the plan annotations/notes BEFORE clearing them below, so undo can restore
      // this user content (the row is restorable but the comments would otherwise be gone).
      removedPlanAnnotations.set(id, snapshotPlanAnnotations(id));
    }
    set((s) => {
      const rest = s.conversations.filter((c) => c.id !== id);
      return {
        conversations: rest,
        activeId: s.activeId === id ? (rest[rest.length - 1]?.id ?? null) : s.activeId,
      };
    });
    // Kill the live `claude` process (if any) so deleting a conversation never
    // leaves an orphan. Distinct from interrupt: this terminates the session.
    if (conv?.handle) {
      syncToCore("stopSession", () => commands.stopSession(conv.handle!));
    }
    // Drop its (now unreachable) message timeline from the message store, and its
    // persisted context-window so the localStorage cache doesn't keep orphans.
    useConversationStore.getState().dropSession(id);
    useBackgroundTasksStore.getState().dropSession(id);
    useWorkflowLiveStore.getState().drop(id);
    clearCachedWindow(id);
    clearTodoBarOpen(id);
    clearComposerDraft(id);
    clearComposerAttachments(id);
    clearCodexControls(id);
    clearWorkFold(id);
    clearManualOrderConversation(id);
    clearPlanAnnotations(id);
    autoTitlePending.delete(id);
    titleContext.delete(id);
    titleGenCount.delete(id);
    lastAppliedSeq.delete(id);
    // Kill its integrated terminal (PTY shell + xterm instance) too — same no-orphan
    // policy as the claude session above. No-op if it never opened a terminal.
    disposeTerminal(id);
    useGitViewStore.getState().clear(id);
    // Drop the bridge state too — the session was just stopped, so a lingering
    // "connected" chip would be a stale, misleading indicator.
    useRemoteControlStore.getState().clear(id);
    // Drop its active-goal too — the conversation is gone.
    useGoalStore.getState().clear(id);
    // Drop the derived artifacts memo, which pins the (now dropped) timeline + tool results —
    // otherwise the heaviest part of a deleted conversation outlives it for the whole run.
    clearArtifactsCache(id);
    // Drop its Flight Deck last-message summary — the card is gone.
    useLastMessageSummaryStore.getState().clear(id);
    syncToCore("deleteConversation", () => commands.deleteConversation(id));
    syncToCore("setActive", () => commands.setActiveConversation(get().activeId));
  },

  undoRemoveConversation: () => {
    const snapshot = removedConversations.pop();
    if (!snapshot) return false;
    // Already back (an out-of-band re-add): just focus it, don't duplicate the row.
    if (get().conversations.some((c) => c.id === snapshot.id)) {
      get().selectConversation(snapshot.id);
      return true;
    }
    // Its repo may have been removed since the delete (e.g. the whole repo was
    // dropped): a conversation under a missing repo would group nowhere and silently
    // vanish from the sidebar, so there is nothing useful to restore — discard it.
    if (!get().repos.some((r) => r.id === snapshot.repoId)) return false;
    // The live process was killed and the message timeline dropped on removal. Clear
    // the once-per-run history guard so the select-time loader actually re-reads the
    // on-disk transcript (otherwise the restored row would stay blank); re-insert a
    // CLEAN record (no stale handle — the old session is dead, the next message
    // re-spawns it via --resume). addConversation re-selects + re-persists the row.
    historyLoaded.delete(snapshot.id);
    get().addConversation({ ...snapshot, handle: null });
    // Re-seed the plan annotations/notes captured at delete time (user content).
    restorePlanAnnotations(snapshot.id, removedPlanAnnotations.get(snapshot.id) ?? null);
    removedPlanAnnotations.delete(snapshot.id);
    return true;
  },

  renameConversation: (id, name) => {
    const trimmed = name.trim().replace(/\s+/g, " ");
    const conv = get().conversations.find((c) => c.id === id);
    // Ignore a blank or unchanged title — an empty name would leave an unlabeled row.
    if (!conv || !trimmed || trimmed === conv.name) return;
    // A manual rename is a custom title: it takes the conversation out of auto-title
    // eligibility (and stops any further regeneration), so a late-arriving model title
    // never clobbers the user's choice.
    autoTitlePending.delete(id);
    titleContext.delete(id);
    titleGenCount.delete(id);
    lastAppliedSeq.delete(id);
    const updated = { ...conv, name: trimmed };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(rename)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  noteFirstMessage: (id, text) => {
    const conv = get().conversations.find((c) => c.id === id);
    // Only a still-untitled conversation auto-titles: a custom rename (or a resumed
    // conversation carrying a prior name) is left untouched.
    if (!conv || conv.name !== DEFAULT_CONV_NAME) return;
    // Optimistic placeholder (the truncated message), like the VS Code extension —
    // instant feedback and the fallback if title generation fails. Mark it eligible
    // for replacement by the model-generated title (see triggerAutoTitle).
    autoTitlePending.add(id);
    const updated = { ...conv, name: deriveName(text) };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(rename)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  triggerAutoTitle: (id, text) => {
    // Eligible only if still an auto placeholder (not renamed/resumed).
    if (!autoTitlePending.has(id)) return;
    const count = titleGenCount.get(id) ?? 0;
    if (count >= MAX_TITLE_REGENS) return; // title has settled — stop regenerating
    // Accumulate the user's messages FIRST (before the live-handle gate) so the
    // intent stays complete even if the session is momentarily down — then regenerate
    // from the WHOLE intent so far, not just the first message ("/list-tasks" then
    // "do task X" lands on the task). The binary truncates to its own token budget.
    const ctx = [...(titleContext.get(id) ?? []), text];
    titleContext.set(id, ctx);
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv?.handle) return; // no live session to ask (the placeholder stays)
    const description = ctx.join("\n").trim();
    if (!description) return;
    // Tag this request with a monotonic seq so applyAutoTitle can drop a stale,
    // out-of-order response (older-context title arriving after a fresher one).
    const seq = count + 1;
    titleGenCount.set(id, seq);
    // Fire-and-forget: the title returns via SessionTitleEvent → applyAutoTitle. A
    // failure is non-fatal (the placeholder/last title stays) — log it, never surface it.
    void commands
      .generateConversationTitle(conv.handle, description, seq)
      .then((res) => {
        if (res.status === "error")
          console.error("[autoTitle] generateConversationTitle failed:", res.error);
      })
      .catch((e) => console.error("[autoTitle] generateConversationTitle threw:", e));
  },

  applyAutoTitle: (id, title, seq) => {
    // Apply only while still eligible (the user hasn't renamed since). NOT consumed:
    // later regenerations (up to the cap) replace it in turn until the title settles.
    if (!autoTitlePending.has(id)) return;
    // Drop a stale, out-of-order response: only ever move the title FORWARD in seq, so
    // an earlier (poorer-context) generation that resolves late can't clobber a fresher
    // one. Record the seq even when the name doesn't change, so a later older seq loses.
    if (seq <= (lastAppliedSeq.get(id) ?? 0)) return;
    lastAppliedSeq.set(id, seq);
    const conv = get().conversations.find((c) => c.id === id);
    const cleaned = cleanTitle(title);
    if (!conv || !cleaned || cleaned === conv.name) return;
    const updated = { ...conv, name: cleaned };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(autoTitle)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  noteSessionId: (id, sessionId) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.sessionId === sessionId) return;
    const updated = { ...conv, sessionId };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conv.id ? updated : c)),
    }));
    syncToCore("upsertConversation(sessionId)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  setHandle: (id, handle) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, handle } : c)),
    })),

  setLiveCwd: (id, cwd) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id && c.liveCwd !== cwd ? { ...c, liveCwd: cwd } : c,
      ),
    })),

  repointCwd: (id, cwd) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.cwd === cwd) return;
    const updated = { ...conv, cwd };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
    }));
    syncToCore("upsertConversation(cwd)", () => commands.upsertConversation(convToRecord(updated)));
  },

  noteActivity: (id, opts) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, lastActivityAt: Date.now() };
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? updated : c)),
    }));
    if (opts?.persist) {
      syncToCore("upsertConversation(activity)", () =>
        commands.upsertConversation(convToRecord(updated)),
      );
    }
  },

  setConvModel: (id, model) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.model === model) return;
    const updated = { ...conv, model };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(model)", () => commands.upsertConversation(convToRecord(updated)));
    // Claude pushes the model live (set_model); Codex has no such channel — the model
    // rides the next turn as an override (see codexControls.buildCodexControls), so only
    // the persisted record matters here.
    if (conv.handle && conv.kind === "claude")
      syncToCore("setModel(live)", () => commands.setModel(conv.handle!, model));
  },

  setConvBackend: (id, kind, model) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    // Backend is fixed at creation: once a session exists (or ever existed), the
    // transport + message format are engaged and cannot switch. Only a pristine,
    // never-spawned conversation may flip. This guard is the safety net behind the
    // composer already hiding the other backend once the conversation is locked.
    if (conv.sessionId || conv.handle) return;
    // A spawn IN FLIGHT is engaged too: sessionId/handle only land at its end, but the
    // actor being started already reads the kind captured at send time. Flipping now
    // would persist kind=X with a session of backend Y — history invisible on reload,
    // resume permanently broken (review HIGH). The pick is refused, not queued.
    if (isSpawning(id)) return;
    if (conv.kind === kind && conv.model === model) return;
    const updated = { ...conv, kind, model };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    // No live push (guarded above → no handle): persist the pick so the eventual
    // spawn starts on the chosen backend + model.
    syncToCore("upsertConversation(backend)", () => commands.upsertConversation(convToRecord(updated)));
  },

  setConvEffort: (id, effort) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, effort, ultracode: false };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(effort)", () => commands.upsertConversation(convToRecord(updated)));
    // Codex effort rides the next turn as an override, not a live command (see setConvModel).
    if (conv.handle && conv.kind === "claude")
      syncToCore("setEffortLevel(live)", () => commands.setEffortLevel(conv.handle!, effort));
  },

  setConvUltracode: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const updated = { ...conv, effort: "xhigh", ultracode: true };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(ultracode)", () => commands.upsertConversation(convToRecord(updated)));
    if (conv.handle) syncToCore("setUltracode(live)", () => commands.setUltracode(conv.handle!));
  },

  setConvPermission: (id, mode) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.permissionMode === mode) return;
    const updated = { ...conv, permissionMode: mode };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(permission)", () => commands.upsertConversation(convToRecord(updated)));
    if (conv.handle)
      syncToCore("setPermissionMode(live)", () => commands.setPermissionMode(conv.handle!, mode));
  },

  setConvCleanOutput: (id, enabled) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.cleanOutput === enabled) return; // idempotent
    const updated = { ...conv, cleanOutput: enabled };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    // Display-only: persist the per-conversation choice, but nothing to push to the
    // live stream (the renderer reads the record directly).
    syncToCore("upsertConversation(cleanOutput)", () =>
      commands.upsertConversation(convToRecord(updated)),
    );
  },

  setReminder: (id, reminder) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv || conv.pendingReminder === reminder) return; // idempotent: no churn
    const updated = { ...conv, pendingReminder: reminder };
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }));
    syncToCore("upsertConversation(reminder)", () => commands.upsertConversation(convToRecord(updated)));
  },
}));

/**
 * Create a new conversation in `repoPath` (registering the repo if new) with a
 * fresh stable id. Returns its stable id.
 *
 * Lazy policy: NO `claude` process is spawned here — only the metadata record is
 * created. The live session is spawned on the first message (see
 * [`ensureConversationSession`]).
 */
export function createConversationInRepo(
  repoPath: string,
  // The backend is chosen HERE (the "+" selector) and immutable afterwards. Defaults
  // to Claude, so every existing caller and the no-Codex case are unchanged.
  kind: BackendKind = "claude",
): string {
  const repo = useConversationsStore.getState().addRepo(repoPath);
  const id = uid();
  const now = Date.now();
  useConversationsStore.getState().addConversation({
    id,
    name: DEFAULT_CONV_NAME,
    repoId: repo.id,
    cwd: repoPath,
    createdAt: now,
    // A brand-new conversation is the most recent activity → top of the list.
    lastActivityAt: now,
    sessionId: null,
    handle: null, // no live process until the first message
    liveCwd: null,
    // Seed the backend's own default model so a Codex conversation never carries a
    // Claude alias (which its binary would reject at thread/start).
    model: kind === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
    // Seed the backend's own default effort (Codex "medium" vs Claude "xhigh").
    effort: kind === "codex" ? DEFAULT_CODEX_EFFORT : DEFAULT_EFFORT,
    ultracode: false,
    permissionMode: DEFAULT_PERMISSION_MODE,
    pendingReminder: null,
    // null = inherit the global "clean output" default; the composer chip sets an
    // explicit per-conversation override.
    cleanOutput: null,
    kind,
  });
  return id;
}

/**
 * Create a new conversation in an EXISTING repo but rooted at `cwd` — typically a
 * git worktree of that repo. Reuses the repo's id (so the conversation still
 * groups under it in the sidebar) while spawning `claude` in the worktree
 * directory. Returns the new conversation's stable id.
 *
 * This is how the app starts an agent "directly in a worktree": same repo group,
 * a different working directory. The worktree indicator/badge resolve that cwd
 * and light up accordingly. Lazy as ever — no process is spawned here.
 */
export function createConversationInWorktree(
  repoId: string,
  cwd: string,
  kind: BackendKind = "claude",
): string {
  const id = uid();
  const now = Date.now();
  useConversationsStore.getState().addConversation({
    id,
    name: DEFAULT_CONV_NAME,
    repoId,
    cwd,
    createdAt: now,
    lastActivityAt: now,
    sessionId: null,
    handle: null, // no live process until the first message
    liveCwd: null,
    // Seed the backend's own default model so a Codex conversation never carries a
    // Claude alias (which its binary would reject at thread/start).
    model: kind === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
    // Seed the backend's own default effort (Codex "medium" vs Claude "xhigh").
    effort: kind === "codex" ? DEFAULT_CODEX_EFFORT : DEFAULT_EFFORT,
    ultracode: false,
    permissionMode: DEFAULT_PERMISSION_MODE,
    pendingReminder: null,
    // null = inherit the global "clean output" default; the composer chip sets an
    // explicit per-conversation override.
    cleanOutput: null,
    kind,
  });
  return id;
}

/** Branch/dir name for an app-created worktree when starting a conversation in one. */
function autoWorktreeBranch(): string {
  return `wt-${Date.now().toString(36)}`;
}

/** The existing repo whose path is the longest prefix of `cwd`, or a freshly-added
 *  repo at `repoRoot` when the cwd belongs to a repo the app never opened. Mirrors
 *  the front's existing longest-prefix conversation↔repo association. */
function resolveOrCreateRepoForCwd(cwd: string, repoRoot: string): Repo {
  const store = useConversationsStore.getState();
  const match = store.repos
    .filter((r) => cwd === r.path || cwd.startsWith(r.path.replace(/\/+$/, "") + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return match ?? store.addRepo(repoRoot);
}

/**
 * Bring a conversation discovered on disk (the history panel) back into the app.
 *
 * Reuses the existing repo whose path is the longest prefix of its cwd, else
 * AUTO-ADDS a repo at the derived repo root (so a conversation from a folder the app
 * never opened still lands in the sidebar, grouped under its repo). Inserts the
 * conversation row with a FRESH stable id — the original was forgotten when it left
 * the app — while preserving Claude's `session_id` so the next message resumes it
 * (`--resume`). When the same `session_id` is already present (it was never actually
 * forgotten), just selects it instead of duplicating. Returns the stable id.
 *
 * Lazy as ever: NO `claude` process is spawned here; selection + the first message
 * drive the (re)spawn, and the thread fills from the on-disk transcript.
 */
export function reactivateDiskConversation(d: DiskConversation): string {
  const store = useConversationsStore.getState();
  const existing = store.conversations.find((c) => c.sessionId === d.session_id);
  if (existing) {
    store.selectConversation(existing.id);
    return existing.id;
  }
  const repo = resolveOrCreateRepoForCwd(d.cwd, d.repo_root);
  // Keep the original cwd as-is. If its worktree was since removed, the FIRST message's
  // spawn fails with a missing-cwd error and `ensureConversationSession`'s existing
  // fallback repoints to the repo's main checkout and starts a FRESH session (with a
  // notice) — the same graceful path an in-app conversation gets when its worktree is
  // deleted. Pre-resolving to repo_root here would instead let the spawn succeed and the
  // `--resume` fail silently (the fallback's `cwd` guard wouldn't trigger), so don't.
  const cwd = d.cwd;
  const id = uid();
  // Reactivate onto the SAME backend the conversation ran on (the disk row carries it),
  // so a Codex thread comes back as a Codex conversation — its cold history reads from the
  // rollout and the next message resumes via `thread/resume`, not `claude --resume`. Seed
  // the backend's own default model/effort so a Codex conversation never carries a Claude
  // alias its binary would reject at thread/start.
  const kind: BackendKind = d.backend === "codex" ? "codex" : "claude";
  useConversationsStore.getState().addConversation({
    id,
    // An untitled conversation falls back to its first prompt — cleaned up first, or a
    // conversation opened on a slash command would be NAMED with the CLI's raw
    // `<command-message>…<command-name>` wrapper.
    name: (d.title ?? "").trim() || userMessagePreviewText(d.excerpt).trim() || DEFAULT_CONV_NAME,
    repoId: repo.id,
    cwd,
    // The transcript's last-message time is the best available creation/activity proxy
    // (the real created_at was lost with the SQLite row), and keeps recency ordering sane.
    createdAt: d.mtime_ms,
    lastActivityAt: d.mtime_ms,
    sessionId: d.session_id,
    handle: null, // no live process until the first message (lazy)
    liveCwd: null,
    model: kind === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL,
    effort: kind === "codex" ? DEFAULT_CODEX_EFFORT : DEFAULT_EFFORT,
    ultracode: false,
    permissionMode: DEFAULT_PERMISSION_MODE,
    pendingReminder: null,
    // null = inherit the global "clean output" default; the composer chip sets an
    // explicit per-conversation override.
    cleanOutput: null,
    kind,
  });
  return id;
}

/**
 * Materialize a native Codex fork (a `thread/fork` result) as a real conversation. The Claude
 * fork path (`reactivateDiskConversation`) hardcodes `kind:"claude"` and takes a transcript
 * file, whereas a Codex branch is just a new thread id + resolved model — so it needs its own
 * inserter. Lands in the SOURCE conversation's repo + cwd, with the forked thread as its
 * `sessionId` (the resume key), so selecting it loads the branch's history via the
 * `conv.kind==="codex"` cold-load path. `addConversation` auto-selects it. Returns the new id.
 */
export function materializeCodexBranch(
  source: Conversation,
  forkThreadId: string,
  forkModel: string | null,
  name: string,
): string {
  const id = uid();
  const now = Date.now();
  useConversationsStore.getState().addConversation({
    id,
    name,
    repoId: source.repoId,
    cwd: source.liveCwd ?? source.cwd,
    createdAt: now,
    lastActivityAt: now,
    // The forked thread id IS the conversation's resume key (like Claude's session_id).
    sessionId: forkThreadId,
    handle: null,
    liveCwd: null,
    // The forked thread's resolved Codex model (fall back to the source's, then the default).
    model: forkModel ?? source.model ?? DEFAULT_CODEX_MODEL,
    effort: source.effort ?? DEFAULT_CODEX_EFFORT,
    ultracode: false,
    permissionMode: DEFAULT_PERMISSION_MODE,
    pendingReminder: null,
    cleanOutput: null,
    kind: "codex",
  });
  return id;
}

/**
 * Boot: hydrate the store from the core's persisted state. Called once at App
 * mount. The store starts empty — persistence lives in the Rust core, not in the
 * webview — so nothing is in memory until this runs.
 *
 * Lazy policy: boot spawns NOTHING. Conversations are listed from their
 * metadata; a conversation's transcript is loaded on demand when it is shown
 * (see [`loadConversationHistory`]) and its `claude` process is spawned only when
 * the user sends a message. An empty store stays empty — no default conversation.
 */
export async function bootConversations(): Promise<void> {
  const res = await commands.loadPersistedState();
  if (res.status === "ok") {
    useConversationsStore.setState({
      repos: res.data.repos.map(recordToRepo),
      conversations: res.data.conversations.map(recordToConv),
      activeId: res.data.active_id,
    });
  } else {
    // A failed hydration leaves the store empty — INDISTINGUISHABLE from a fresh
    // install, so all the user's conversations would appear silently gone. Surface
    // it loudly: a corrupt/locked DB is a real problem, not "no conversations yet".
    console.error("loadPersistedState failed:", res.error);
    useAppErrors
      .getState()
      .pushError(
        "Couldn't load your conversations — the database may be corrupted or locked. Your data is not lost; restart the app.",
        res.error,
      );
  }
}

/** A conversation's live Rust session handle, or null if it isn't spawned. */
export function liveHandle(convId: string): string | null {
  return (
    useConversationsStore.getState().conversations.find((c) => c.id === convId)?.handle ?? null
  );
}

/**
 * Acknowledge ("Seen") a conversation's reminder: mark the last turn seen in the
 * LIVE message store (so it drops to idle now) AND clear the PERSISTED reminder
 * (so the acknowledgement survives a restart). This is the single "Seen" entry point
 * the UI calls — distinct from the raw `markSeen`, which the history loaders use to
 * silence a replayed PAST completion WITHOUT touching the persisted reminder: an
 * unopened reminder must survive a restart, so merely OPENING a conversation can't
 * clear it — only this explicit acknowledgement (or the next message) does.
 */
export function acknowledgeConversation(convId: string): void {
  useConversationStore.getState().markSeen(convId);
  useConversationsStore.getState().setReminder(convId, null);
}

// In-flight spawns keyed by conversation id. Spawning is async (a round-trip to
// the core), so two concurrent callers — e.g. the "turn on" button and a message
// send firing at once — could both see a null handle and spawn TWO processes,
// leaking one as an orphan. Sharing the in-flight promise makes the spawn
// idempotent per conversation: concurrent callers await the same one.
const spawning = new Map<string, Promise<string>>();

/** Whether `convId` has a session spawn IN FLIGHT (worktree creation + process start).
 *  Consulted by the backend guard (`setConvBackend`) and the composer's picker lock:
 *  during this window the conversation has no sessionId/handle yet but is already
 *  engaged on the kind captured at send time. */
export function isSpawning(convId: string): boolean {
  return spawning.has(convId);
}

/**
 * Ensure a conversation has a LIVE `claude` session, spawning it lazily if not.
 * Returns the live handle. This is the single spawn point of the lazy policy —
 * called on the first message (and on any send after the session was stopped or
 * ended). A conversation with a `sessionId` is resumed (`--resume`) so the same
 * Claude session continues; a brand-new one starts fresh.
 *
 * The handle is bound synchronously before this resolves, so live events (which
 * the core keys by handle) route back to this conversation's stable id.
 */
export async function ensureConversationSession(
  convId: string,
  opts?: { worktree?: boolean },
): Promise<string> {
  let conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv) throw new Error(`conversation ${convId} not found`);
  if (conv.handle) return conv.handle;
  const inflight = spawning.get(convId);
  if (inflight) return inflight;
  const promise = (async () => {
    const before = useConversationsStore.getState().conversations.find((c) => c.id === convId);
    if (!before) throw new Error(`conversation ${convId} not found`);
    let cwd = before.cwd;
    // First spawn requested in a fresh worktree: create one (app-managed, under
    // .claude/worktrees) and repoint the conversation's cwd into it BEFORE
    // spawning — so the session, its transcript, and `--resume` all live in the
    // worktree (cwd stays the single source of truth). Only on the very first
    // spawn (no sessionId yet); a later resume reuses the existing cwd and never
    // creates a second worktree. A failure throws so the send surfaces it.
    if (opts?.worktree && !before.sessionId) {
      const repo = useConversationsStore.getState().repos.find((r) => r.id === before.repoId);
      if (!repo) throw new Error("repository not found for this conversation");
      const wt = await commands.createWorktree(repo.path, autoWorktreeBranch(), null, true);
      if (wt.status !== "ok") throw new Error(`could not create worktree: ${wt.error}`);
      useConversationsStore.getState().repointCwd(convId, wt.data.path);
      cwd = wt.data.path;
    }
    // Apply this conversation's persisted controls at spawn, so the live stream
    // starts in EXACTLY the model/effort/permission/ultracode the UI shows — never
    // the old hardcoded defaults. A pre-first-message pick is honored here too.
    // RE-READ the record here (not the `before` captured above): the worktree
    // creation can take seconds, and a control changed during that window must
    // reach the actor being started — most critically `kind` (belt to the
    // setConvBackend spawning guard: whatever kind spawns is the kind persisted).
    const atSpawn =
      useConversationsStore.getState().conversations.find((c) => c.id === convId) ?? before;
    let res = await commands.spawnSession(
      cwd,
      atSpawn.sessionId ?? null,
      atSpawn.model,
      atSpawn.effort,
      atSpawn.permissionMode,
      atSpawn.ultracode,
      // The backend is fixed at creation; the spawn routes to the Claude or Codex actor.
      atSpawn.kind,
    );
    if (res.status !== "ok") {
      // The spawn may have failed because the conversation's cwd is GONE — its
      // worktree was removed. (A missing cwd and a missing `claude` binary both
      // surface as the same OS error.) If so, fall back to the repo's main
      // checkout and start FRESH there: resuming the old session would fail,
      // since its transcript lives under the deleted worktree's project, not the
      // main one (verified: `claude --resume` errors when the session isn't in
      // the current project). The user is told; prior turns already shown stay,
      // and the message they just sent goes to the new session.
      const repo = useConversationsStore.getState().repos.find((r) => r.id === before.repoId);
      const fallback = repo?.path;
      if (
        fallback &&
        fallback !== cwd &&
        !(await commands.pathExists(cwd)) &&
        (await commands.pathExists(fallback))
      ) {
        useConversationStore
          .getState()
          .addErrorTurn(
            convId,
            `⚠️ The worktree tied to this conversation was deleted. It is being restarted in the main working tree (${repoName(fallback)}) — new session.`,
          );
        useConversationsStore.getState().repointCwd(convId, fallback);
        res = await commands.spawnSession(
          fallback,
          null,
          atSpawn.model,
          atSpawn.effort,
          atSpawn.permissionMode,
          atSpawn.ultracode,
          // Same backend on the fresh-worktree re-spawn.
          atSpawn.kind,
        );
      }
    }
    if (res.status !== "ok") throw new Error(res.error);
    useConversationsStore.getState().setHandle(convId, res.data);
    return res.data;
  })();
  spawning.set(convId, promise);
  try {
    return await promise;
  } finally {
    spawning.delete(convId);
  }
}

/**
 * Stop a conversation's live `claude` process (the "turn off" action). No-op if
 * it isn't running. The core also clears the handle via the terminal `ended`
 * event, but we drop it here too so the UI flips to "off" without waiting for the
 * round-trip. Distinct from `interrupt` (which only ends the current turn): this
 * kills the process. The on-disk transcript is untouched, so a later send (or
 * "turn on") resumes the same Claude session via `--resume`.
 */
export async function stopConversationSession(convId: string): Promise<void> {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.handle) return; // already off
  const res = await commands.stopSession(conv.handle);
  useConversationsStore.getState().setHandle(convId, null);
  // The core's terminal `ended` event is keyed by the (now-cleared) handle and
  // gets dropped, so the message store would keep the last live state (e.g.
  // busy=true) and the composer would stay locked. Reset it to idle so the
  // conversation reads as off and a new message can re-spawn it.
  useConversationStore.getState().clearState(convId);
  // Same reason: the bridge died with the process, but its `ended` clear won't fire
  // (handle already cleared) — drop the remote-control state here so the chip resets.
  useRemoteControlStore.getState().clear(convId);
  if (res.status !== "ok") throw new Error(res.error);
}

/**
 * Turn a conversation's stream ON (the "turn on" action). Before spawning, it
 * re-syncs the timeline from Claude's on-disk transcript so any turns added
 * out-of-band — e.g. while the same session was resumed in a terminal
 * (`claude --resume`) — show up. `--resume` does not re-stream past messages, so
 * reading the transcript is the only way to pick them up.
 */
export async function startConversationSession(convId: string): Promise<string> {
  await reloadConversationHistory(convId);
  const handle = await ensureConversationSession(convId);
  // `reloadConversationHistory` marked the replayed turn seen, so the conversation is
  // now live + idle and its reminder bar is hidden. Reconcile the PERSISTED reminder
  // to match (clear it): otherwise a stale "review"/"error" would resurrect via the
  // off-branch the moment the stream is later stopped or the app is force-quit —
  // bringing the stream online IS engaging with it, like sending the next message.
  useConversationsStore.getState().setReminder(convId, null);
  return handle;
}

/**
 * Restart a conversation's stream (off→on): stop the live process if any, then
 * start it again. Clearing the handle in `stopConversationSession` first means
 * `ensureConversationSession` sees no live handle and genuinely re-spawns instead
 * of returning the dead one. Like "turn on", this re-syncs the on-disk transcript
 * (via `startConversationSession`) so externally-added turns appear.
 */
export async function restartConversationSession(convId: string): Promise<string> {
  await stopConversationSession(convId);
  return startConversationSession(convId);
}

// Conversations whose on-disk transcript has already been replayed this run.
const historyLoaded = new Set<string>();

/**
 * Re-derive a conversation's active worktree from its transcript and restore it as
 * `liveCwd`, so the editor (and the worktree indicator/badge, which share
 * `effectiveCwd`) root on the RIGHT worktree even out of a live session and after
 * a restart — not the main checkout. `liveCwd` is in-memory only (no SQLite
 * column, no migration); the on-disk transcript is its durable source of truth.
 * Mirrors the live EnterWorktree/ExitWorktree interception in
 * `useGlobalSessionEvents`. A conversation that never touched a worktree (or last
 * did ExitWorktree) yields null → `effectiveCwd` falls back to `conv.cwd`.
 */
function rehydrateWorktreeCwd(convId: string, items: ConversationItem[]): void {
  useConversationsStore.getState().setLiveCwd(convId, worktreeCwdFromTranscript(items));
}

/**
 * Load a conversation's history from Claude's on-disk transcript into the message
 * store, keyed by its STABLE id — no process spawned (pure file IO). Idempotent
 * and run at most once per conversation per app run; `applyItem` also dedupes by
 * id, so a later live re-spawn never double-renders. A conversation with no
 * `sessionId` (never sent a message) has nothing to load.
 */
export async function loadConversationHistory(convId: string): Promise<void> {
  if (historyLoaded.has(convId)) return;
  historyLoaded.add(convId); // mark before awaiting to avoid a double-load race
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv || !conv.sessionId) return;
  // Seed the active `/goal` (Claude only) from the transcript — INDEPENDENT of the history load
  // below, so it shows even when the RENDERED thread is empty: a conversation whose only on-disk
  // content is a goal still has one, since its `/goal` command echo is now dropped as noise. Goal
  // state is disk-only (not on the live stream).
  if (conv.kind !== "codex") void refreshActiveGoal(convId, conv.sessionId);
  // Codex renders LIVE-only (a resumed thread re-streams nothing), so its cold history
  // comes from its on-disk ROLLOUT via a distinct reader (full tool fidelity); Claude
  // reads its transcript. Both return the same `ConversationItem[]` result shape.
  const res =
    conv.kind === "codex"
      ? await commands.codexLoadHistory(conv.sessionId)
      : await commands.loadSessionHistory(conv.sessionId);
  // Distinguish a real failure from "nothing to show": a command-level error
  // (rare — the core itself rarely rejects; a corrupt transcript comes back as an
  // in-band history_error Notice item) is surfaced, an empty history is silent.
  if (res.status !== "ok") {
    console.error("load history failed:", res.error);
    useAppErrors
      .getState()
      .pushError("Couldn't load a conversation's history.", res.error);
    return;
  }
  if (res.data.length === 0) return;
  const { ensureSession, applyItem, applyContextFill, markSeen, reanchorReplay } =
    useConversationStore.getState();
  ensureSession(convId);
  // `hydrating: true` — replayed history has no wall-clock meaning, so suppress the
  // live tool/thinking duration stamps (else every reloaded tool shows a bogus "0ms").
  for (const item of res.data) applyItem(convId, item, true);
  // The transcript carries NO `turn_result`, so the remote-replay anchor was never
  // re-armed during hydration — pin it to the end now, so the FIRST live remote turn
  // splices at the tail of the restored history, not above it.
  reanchorReplay(convId);
  // Root the editor on the worktree this conversation actually lives in, read back
  // from the transcript (its live cwd is in-memory only and lost on restart).
  rehydrateWorktreeCwd(convId, res.data);
  // Mark the restored history seen: a historical completion is not a fresh "Claude
  // just finished, go look", so only genuine LIVE completions surface as review.
  markSeen(convId);
  // Seed the context ring from the transcript so it shows immediately on open, before any
  // new live turn reports usage. CLAUDE only — Codex has no cold context source (its ring
  // fills from the first live `thread/tokenUsage/updated` push). A missing/unreadable
  // transcript is NOT an error (the core returns an empty fill), so a status "error" here
  // is a real failure worth surfacing rather than swallowing.
  if (conv.kind !== "codex") {
    const ctx = await commands.loadSessionContext(conv.sessionId);
    if (ctx.status === "ok")
      // Tokens from the transcript; window from the persisted cache (the only place the
      // real 200k-vs-1M window is known before the first live turn).
      applyContextFill(convId, {
        context_tokens: ctx.data.context_tokens,
        context_window: getCachedWindow(convId),
      });
    else console.error("loadSessionContext failed:", ctx.error);
  }
}

/**
 * Re-read a conversation's on-disk transcript and rebuild its timeline from
 * scratch. Unlike `loadConversationHistory` (additive, once per run), this RESETS
 * the session first, so it picks up turns appended out-of-band — e.g. the same
 * Claude session resumed in a terminal (`claude --resume`). The reset is required
 * for correctness: replaying an assistant message over an existing turn would
 * APPEND its blocks a second time (the reducer merges same-id blocks), duplicating
 * content. A failed or empty read leaves the current timeline untouched. Called
 * when the stream is (re)started from the UI; on a conversation that never sent a
 * message (no session_id) there is nothing to read.
 */
export async function reloadConversationHistory(convId: string): Promise<void> {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.sessionId) return;
  // Re-seed the active `/goal` (Claude only) from the transcript — INDEPENDENT of the history reload
  // below, so it survives an empty rendered timeline (a conversation whose only on-disk content is
  // a goal, its command echo dropped as noise). Goal state is disk-only.
  if (conv.kind !== "codex") void refreshActiveGoal(convId, conv.sessionId);
  // Codex cold history comes from its rollout reader; Claude from its transcript (see
  // loadConversationHistory). Same result shape either way.
  const res =
    conv.kind === "codex"
      ? await commands.codexLoadHistory(conv.sessionId)
      : await commands.loadSessionHistory(conv.sessionId);
  if (res.status !== "ok") {
    console.error("reload history failed:", res.error);
    useAppErrors
      .getState()
      .pushError("Couldn't reload a conversation's history.", res.error);
    return; // keep the current timeline
  }
  if (res.data.length === 0) return; // nothing on disk → keep timeline
  const { resetSession, applyItem, applyContextFill, markSeen, reanchorReplay } =
    useConversationStore.getState();
  resetSession(convId);
  // `hydrating: true` — see loadConversationHistory: suppress live duration stamps on replay.
  for (const item of res.data) applyItem(convId, item, true);
  // Transcript carries no `turn_result` → pin the remote-replay anchor to the tail so
  // a later live remote turn splices at the end, not above the restored history.
  reanchorReplay(convId);
  // Re-root the editor on the conversation's actual worktree, re-derived from the
  // freshly re-read transcript (live cwd is in-memory only).
  rehydrateWorktreeCwd(convId, res.data);
  // Mark restored history seen so turning the stream on doesn't flash an old
  // conversation as "review" (only fresh LIVE completions should).
  markSeen(convId);
  // Re-seed the context ring from the transcript (resetSession cleared it); window from
  // the persisted cache (the real 200k-vs-1M value learned on a prior turn). CLAUDE only —
  // Codex re-fills the ring from the first live `thread/tokenUsage/updated`.
  if (conv.kind !== "codex") {
    const ctx = await commands.loadSessionContext(conv.sessionId);
    if (ctx.status === "ok")
      applyContextFill(convId, {
        context_tokens: ctx.data.context_tokens,
        context_window: getCachedWindow(convId),
      });
    else console.error("loadSessionContext failed:", ctx.error);
  }
  historyLoaded.add(convId); // the select-time loader is now satisfied for this run
}

/**
 * Rewind a conversation IN PLACE to a chosen message ("resume from here") —
 * destructive: everything after the cut is dropped from Claude's on-disk transcript.
 *
 * `targetIsUser` selects the semantics (see `rewind_conversation` in the core):
 *  - a USER message → that prompt and everything after it are removed, and the prompt
 *    text is put back in the composer draft so it can be edited and re-sent;
 *  - a CLAUDE message → its whole response is kept and everything AFTER it is removed.
 *
 * Order matters: the target is VALIDATED first (read-only — killing a session for a rewind
 * that cannot resolve is not recoverable), then the live `claude` process is stopped (it
 * holds the full history in memory and would rewrite the transcript on its next turn,
 * undoing the cut), THEN the transcript is truncated, THEN the timeline is rebuilt. The
 * next message re-spawns `--resume` on the truncated transcript (VERIFIED: resume honours
 * the truncation). Returns the outcome, or `null` if the conversation has no session yet.
 */
export async function rewindConversation(
  convId: string,
  targetId: string,
  targetIsUser: boolean,
  targetText: string | null,
  occurrence: number | null,
  // Codex only: the Codex turn id to fork THROUGH (the new tip, inclusive); the thread
  // computes it from the boundary's turn ids. Ignored on Claude (which cuts by prompt text).
  codexLastTurnId: string | null = null,
): Promise<RewindOutcome | null> {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.sessionId) return null;
  if (conv.kind === "codex") {
    // Native Codex rewind: Codex has no in-place truncation, so FORK the thread THROUGH the
    // chosen turn (thread/fork{lastTurnId}, inclusive) and SWAP this conversation onto the
    // branch; the stale original thread is archived. ⚠️ Like the Claude rewind, this does NOT
    // revert on-disk file changes — history only. Stop any live session first so its in-memory
    // thread can't diverge from the swapped branch.
    await stopConversationSession(convId);
    const cwd = conv.liveCwd ?? conv.cwd;
    const res = await commands.codexFork(conv.sessionId, cwd, conv.model, codexLastTurnId);
    if (res.status !== "ok") {
      useAppErrors.getState().pushError("Couldn't rewind the Codex conversation.", res.error);
      throw new Error(res.error);
    }
    const staleThread = conv.sessionId;
    // Point the conversation at the rewound branch (its new resume key), then rebuild its
    // (now shorter) timeline from the branch's rollout.
    useConversationsStore.getState().noteSessionId(convId, res.data.threadId);
    await reloadConversationHistory(convId);
    // Best-effort: archive the abandoned original thread so it drops out of Codex's list.
    // A failure is surfaced (console) but never blocks the rewind (the branch is already live).
    void commands.codexArchive(staleThread, cwd).then((r) => {
      if (r.status !== "ok") console.warn("[codex-rewind] archive of stale thread failed:", r.error);
    });
    // A user rewind hands the removed prompt back to the composer to edit and re-send.
    if (targetIsUser && targetText) useComposerDrafts.getState().setDraft(convId, targetText);
    return { removed_prompt: targetIsUser ? targetText : null, removed_lines: 1 };
  }
  // 1. Check the target can actually be located — READ-ONLY, before anything destructive.
  //    The kill below can't be undone, and a target the locator can't find (a turn whose
  //    text no longer matches, a line the transcript never persisted) would otherwise take
  //    the live session down with it and still leave the message on screen.
  const check = await commands.checkRewindTarget(
    conv.sessionId,
    targetId,
    targetIsUser,
    targetText,
    occurrence,
  );
  if (check.status !== "ok") {
    useAppErrors.getState().pushError("Couldn't rewind the conversation.", check.error);
    throw new Error(check.error);
  }
  // 2. Kill the live process AND WAIT for it to be fully reaped (stopConversationSession →
  //    stop_session → shutdown_and_wait) so nothing re-writes the transcript from its
  //    in-memory state while / after we truncate.
  await stopConversationSession(convId);
  // 3. Truncate the on-disk transcript at the target. `targetText` + `occurrence` are the
  //    fallback locator for a LIVE turn (its synthetic front id isn't on disk — resolve_cut),
  //    occurrence disambiguating identical repeated prompts.
  const res = await commands.rewindConversation(conv.sessionId, targetId, targetIsUser, targetText, occurrence);
  if (res.status !== "ok") {
    useAppErrors.getState().pushError("Couldn't rewind the conversation.", res.error);
    throw new Error(res.error);
  }
  // 4. Rebuild the timeline from the (now shorter) transcript.
  await reloadConversationHistory(convId);
  // 5. A user rewind hands the removed prompt back to the composer so it can be edited
  //    and re-sent ("go back to this prompt, control returns to Claude").
  if (res.data.removed_prompt) {
    useComposerDrafts.getState().setDraft(convId, res.data.removed_prompt);
  }
  return res.data;
}

/**
 * Fork a NEW conversation branched at a message ("fork from here") — NON-destructive:
 * the original conversation is left untouched. The core copies the transcript up to the cut
 * into a fresh session file; we bring it into the app as a real conversation (which selects
 * it and loads its history), and seed its composer with the removed prompt for a user fork.
 * Returns the new conversation's stable id, or `null` if the source has no session yet.
 */
export async function forkConversation(
  convId: string,
  targetId: string,
  targetIsUser: boolean,
  targetText: string | null,
  occurrence: number | null,
  // Codex only: the Codex turn id to fork THROUGH (the branch tip, inclusive). Ignored on Claude.
  codexLastTurnId: string | null = null,
): Promise<string | null> {
  const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
  if (!conv?.sessionId) return null;
  if (conv.kind === "codex") {
    // Native Codex fork: branch the thread THROUGH the chosen turn into a NEW thread, then
    // materialize it as a fresh Codex conversation (the source is left intact). Non-destructive.
    const cwd = conv.liveCwd ?? conv.cwd;
    const res = await commands.codexFork(conv.sessionId, cwd, conv.model, codexLastTurnId);
    if (res.status !== "ok") {
      useAppErrors.getState().pushError("Couldn't fork the Codex conversation.", res.error);
      throw new Error(res.error);
    }
    const newId = materializeCodexBranch(conv, res.data.threadId, res.data.model, `${conv.name} (fork)`);
    // A user fork seeds the new branch's composer with the removed prompt to edit and re-send.
    if (targetIsUser && targetText) useComposerDrafts.getState().setDraft(newId, targetText);
    return newId;
  }
  const res = await commands.forkConversation(conv.sessionId, targetId, targetIsUser, targetText, occurrence);
  if (res.status !== "ok") {
    useAppErrors.getState().pushError("Couldn't fork the conversation.", res.error);
    throw new Error(res.error);
  }
  const outcome: ForkOutcome = res.data;
  // Reuse the disk-conversation import path (creates the row, auto-selects it → its history
  // loads via ConductorConversation's effect). Name it after the source, marked as a branch.
  const branch: DiskConversation = {
    ...outcome.conversation,
    title: `${conv.name} (fork)`,
  };
  const newId = reactivateDiskConversation(branch);
  if (outcome.removed_prompt) {
    useComposerDrafts.getState().setDraft(newId, outcome.removed_prompt);
  }
  return newId;
}

/**
 * Drop ALL data — persisted (the core's db) and in-memory — leaving an empty
 * slate (no default conversation). Wired to the Settings "drop all" button; also
 * handy during development since the SQL model is still in flux. Best-effort
 * stops every live `claude` session first so we don't orphan child processes.
 * Claude's on-disk transcripts are untouched.
 */
export async function wipeAllData(): Promise<void> {
  const { conversations } = useConversationsStore.getState();
  await Promise.all(
    conversations
      .filter((c): c is Conversation & { handle: string } => c.handle !== null)
      .map((c) => commands.stopSession(c.handle)),
  );
  // Kill every integrated terminal (PTY shells + xterm instances) before clearing.
  disposeAllTerminals();
  await commands.wipeAllData();
  historyLoaded.clear();
  clearAllCachedWindows();
  clearAllTodoBarOpen();
  clearAllComposerDrafts();
  clearAllComposerAttachments();
  clearAllCodexControls();
  clearAllWorkFold();
  clearAllPlanAnnotations();
  clearAllSidebarFold();
  clearAllManualOrder();
  autoTitlePending.clear();
  titleContext.clear();
  titleGenCount.clear();
  lastAppliedSeq.clear();
  removedConversations.length = 0; // nothing to "undo" back into a wiped slate
  removedPlanAnnotations.clear();
  clearMentionCache();
  useConversationsStore.setState({ repos: [], conversations: [], activeId: null });
  useConversationStore.setState({ sessions: {} });
  useBackgroundTasksStore.getState().clear();
  useWorkflowLiveStore.getState().clear();
  useGitViewStore.getState().clearAll();
  useRemoteControlStore.getState().clearAll();
  useGoalStore.getState().clearAll();
  clearAllArtifactsCache();
  useCodexPlanUsageStore.getState().clear();
  useLastMessageSummaryStore.getState().clearAll();
}

export const useConversations = () =>
  useConversationsStore(useShallow((s) => s.conversations));
export const useRepos = () => useConversationsStore(useShallow((s) => s.repos));
export const useActiveConversationId = () => useConversationsStore((s) => s.activeId);

/** The repo (working folder) a conversation belongs to. */
export function useConversationRepo(convId: string | null): Repo | null {
  return useConversationsStore((s) => {
    const conv = s.conversations.find((c) => c.id === convId);
    return conv ? (s.repos.find((r) => r.id === conv.repoId) ?? null) : null;
  });
}

export interface RepoGroup {
  repo: Repo;
  conversations: Conversation[];
}

/**
 * The grouping skeleton shared by the sidebar's recency order and the FlightDeck's
 * status-ordered lanes: bucket conversations under their repo, sort within each
 * repo (`sortConvs`), then order the groups (`sortRepos`). Pure + testable. The two
 * call sites differ ONLY in their comparators, so the grouping and empty-repo
 * handling never drift between them.
 */
export function groupByRepo(
  repos: Repo[],
  conversations: Conversation[],
  sortConvs: (a: Conversation, b: Conversation) => number,
  sortRepos: (a: RepoGroup, b: RepoGroup) => number,
): RepoGroup[] {
  const byRepo = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const arr = byRepo.get(c.repoId) ?? [];
    arr.push(c);
    byRepo.set(c.repoId, arr);
  }
  for (const arr of byRepo.values()) arr.sort(sortConvs);
  return [...repos]
    .map((repo) => ({ repo, conversations: byRepo.get(repo.id) ?? [] }))
    .sort(sortRepos);
}

/**
 * Group conversations under their repo and order by recency: within a repo the
 * most recently active conversation comes first, and repos are ordered by their
 * most recent conversation (an empty repo falls back to when it was added). The
 * recency-ordered grouping the sidebar shows — the FlightDeck reuses the same
 * skeleton (`groupByRepo`) but orders status-first instead (see `orderLanes`).
 */
export function groupConversationsByRepo(
  repos: Repo[],
  conversations: Conversation[],
): RepoGroup[] {
  // After the recency sort, a group's first conversation is its most recent one.
  const recency = (g: RepoGroup) => g.conversations[0]?.lastActivityAt ?? g.repo.addedAt;
  return groupByRepo(
    repos,
    conversations,
    (a, b) => b.lastActivityAt - a.lastActivityAt,
    (a, b) => recency(b) - recency(a),
  );
}

/**
 * Group conversations by repo honouring the sidebar's MANUAL drag order per level. Each
 * level (conversations within a repo; the repos themselves) is either automatic
 * (recency, the historical behaviour) or manual, chosen independently via the two
 * `auto*` flags. In manual mode the order comes from `order`; items missing from it
 * (brand-new, or never dragged) sort to the top newest-first (see `manualComparator`).
 * Pure + testable — the sidebar hook and the ⌘⌥↑/↓ nav both call it.
 */
export function groupConversationsByRepoOrdered(
  repos: Repo[],
  conversations: Conversation[],
  order: OrderBlob,
  autoConvs: boolean,
  autoRepos: boolean,
): RepoGroup[] {
  const convIndex = autoConvs ? null : manualConvIndex(order.convOrder);
  const sortConvs = convIndex
    ? manualComparator<Conversation>(convIndex, (c) => c.id, (c) => c.createdAt)
    : (a: Conversation, b: Conversation) => b.lastActivityAt - a.lastActivityAt;
  // A repo's recency = the max activity across its conversations (order-independent, so
  // it's correct even when the conversations are in a manual, non-recency order); empty
  // repos fall back to when they were added.
  const repoRecency = (g: RepoGroup) =>
    g.conversations.length ? Math.max(...g.conversations.map((c) => c.lastActivityAt)) : g.repo.addedAt;
  const sortRepos = autoRepos
    ? (a: RepoGroup, b: RepoGroup) => repoRecency(b) - repoRecency(a)
    : manualComparator<RepoGroup>(manualIndex(order.repoOrder), (g) => g.repo.id, (g) => g.repo.addedAt);
  return groupByRepo(repos, conversations, sortConvs, sortRepos);
}

/** Reactive repo-grouped conversations, honouring the sidebar's manual drag order (or
 *  recency when the auto-order toggles are on). */
export function useConversationsByRepo(): RepoGroup[] {
  const repos = useRepos();
  const conversations = useConversations();
  const autoConvs = useDisplay((s) => s.autoOrderSidebarConvs);
  const autoRepos = useDisplay((s) => s.autoOrderSidebarRepos);
  const shared = useDisplay((s) => s.sharedManualOrder);
  const order = useOrderSlot(slotFor("sidebar", shared));
  return useMemo(
    () => groupConversationsByRepoOrdered(repos, conversations, order, autoConvs, autoRepos),
    [repos, conversations, order, autoConvs, autoRepos],
  );
}

// NOTE: the conversation status model now lives in `src/agent/status.ts`
// (`deriveAgentStatus` + `agentStatusToDot`), consumed via the `useAgentStatus`
// hook. It replaces the old flat `streamStatus(handle, state)` so the sidebar,
// the title-bar control, and the upcoming fleet view share one rich source of
// truth (running / idle / need-input / need-intervention / review / error / off).
