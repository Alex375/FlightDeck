// Pure helpers for mapping a conversation to its worktree and labelling it.
// No React, no IPC — just logic over a WorktreeInfo[] and a cwd, so it is easy
// to reason about and reuse (indicator, sidebar badge, manager all share it).

import { resultText } from "../../agent/subagentMeta";
import type { ConversationItem, SessionStatePayload, WorktreeInfo } from "../../ipc/client";

const stripSlash = (p: string) => p.replace(/\/+$/, "");

/**
 * Pull the worktree path out of an `EnterWorktree` tool result, e.g.
 * "Created worktree at /…/.claude/worktrees/foo on branch …" or a "Switched to
 * worktree at /…" message. Returns null if no path is found.
 */
export function parseEnterWorktreePath(content: unknown): string | null {
  const s = resultText(content);
  const at = s.match(/worktree at (\/[^\n]+?)(?: on branch | on commit |[\n"']|$)/);
  if (at) return at[1].trim();
  const wt = s.match(/(\/\S*\/\.claude\/worktrees\/[^\s"']+)/);
  return wt ? wt[1] : null;
}

/**
 * Reconstruct the worktree a conversation is in from its transcript, by replaying
 * its EnterWorktree/ExitWorktree tool results IN ORDER — the same signal the live
 * stream uses (see `useGlobalSessionEvents`), but read back from the on-disk
 * transcript so the worktree survives a restart (live cwd is in-memory only).
 *
 * Returns the active worktree path, or null if the transcript shows none (never
 * entered, or the last worktree action was a SUCCESSFUL ExitWorktree). This null
 * is the "back to the spawn cwd" signal — callers fall through to `conv.cwd`.
 *
 * Both branches are gated on success (`!is_error`): a REFUSED ExitWorktree (e.g.
 * "Worktree has N commits — confirm with the user") did NOT leave the worktree,
 * so the session is still in it and `cwd` must stay put — same as for a failed
 * EnterWorktree.
 */
export function worktreeCwdFromTranscript(items: ConversationItem[]): string | null {
  const toolIds = new Map<string, "EnterWorktree" | "ExitWorktree">();
  let cwd: string | null = null;
  for (const item of items) {
    if (item.kind === "assistant_message") {
      for (const b of item.blocks) {
        if (b.type === "tool_use" && (b.name === "EnterWorktree" || b.name === "ExitWorktree")) {
          toolIds.set(b.id, b.name);
        }
      }
    } else if (item.kind === "tool_result" && toolIds.has(item.tool_use_id)) {
      const tool = toolIds.get(item.tool_use_id)!;
      toolIds.delete(item.tool_use_id);
      if (item.is_error) continue; // a refused/failed worktree op did not move the cwd
      if (tool === "EnterWorktree") {
        const path = parseEnterWorktreePath(item.content);
        if (path) cwd = path;
      } else if (tool === "ExitWorktree") {
        cwd = null;
      }
    }
  }
  return cwd;
}

/**
 * The directory a conversation is in RIGHT NOW, most specific first:
 *  - `liveCwd`: a worktree the agent moved into via EnterWorktree (parsed from
 *    its result) — overrides everything until ExitWorktree;
 *  - the live session's reported cwd (system/init);
 *  - the spawn cwd (when nothing live is known).
 */
export function effectiveCwd(
  conv: { cwd: string; liveCwd: string | null },
  state: SessionStatePayload | undefined,
): string {
  return conv.liveCwd ?? state?.cwd ?? conv.cwd;
}

/**
 * The worktree a conversation works in, resolved from its `cwd`. A conversation's
 * `claude` process is spawned with a fixed cwd, so that cwd's worktree IS the one
 * it lives in for its whole life. We match by longest path prefix: the worktree
 * whose path equals the cwd, or contains it (cwd is inside that working tree).
 * Returns null when nothing matches (e.g. a relative "." cwd, or a path outside
 * every listed worktree).
 */
export function resolveWorktree(
  cwd: string,
  worktrees: WorktreeInfo[],
): WorktreeInfo | null {
  const c = stripSlash(cwd);
  let best: WorktreeInfo | null = null;
  let bestLen = -1;
  for (const w of worktrees) {
    if (w.is_bare) continue;
    const wp = stripSlash(w.path);
    if (c === wp || c.startsWith(wp + "/")) {
      if (wp.length > bestLen) {
        best = w;
        bestLen = wp.length;
      }
    }
  }
  return best;
}

/** The repository's main worktree, if present. */
export function mainWorktree(worktrees: WorktreeInfo[]): WorktreeInfo | null {
  return worktrees.find((w) => w.is_main) ?? null;
}

/** Short display label for a worktree: its branch, else a short detached HEAD. */
export function worktreeLabel(w: WorktreeInfo): string {
  if (w.branch) return w.branch;
  if (w.is_detached && w.head) return w.head.slice(0, 7);
  return "detached";
}

/** The worktree's own name = the basename of its directory (not the full path). */
export function worktreeName(w: WorktreeInfo): string {
  const parts = w.path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || w.path;
}

/** A linked (non-main) worktree — the case that earns a sidebar badge. */
export function isLinked(w: WorktreeInfo): boolean {
  return !w.is_main && !w.is_bare;
}
