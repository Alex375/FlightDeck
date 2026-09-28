// What a `git status` SAYS, as the few figures a glance needs — pure, no React, no IPC, so
// the counting rules are pinned by tests and every surface counts the same way.
//
// Two traps this module exists to close:
//  - a CONFLICT (unmerged entry) is reported with both `staged` and `unstaged` set, so naive
//    counting puts one conflict in the Staged AND the Modified buckets. Conflicts are counted
//    on their own and kept out of both.
//  - `ahead` / `behind` are plain numbers that read 0 when there is no upstream, and 0 again
//    when the upstream is gone. Neither is "in sync": the sync reading keys off `upstream`
//    and `upstream_gone`, never off the numbers.
//
// ⚠️ Do NOT reuse `fileMeta.statusLetter` for conflicts: it returns "U" for UNTRACKED, while
// git's "U" means unmerged.

import type { GitFileEntry, GitStatus } from "../../ipc/client";

/** Where the branch stands against its remote-tracking branch (as of the last fetch). */
export type GitSync =
  | { kind: "tracking"; upstream: string; ahead: number; behind: number }
  | { kind: "no-upstream" }
  | { kind: "gone"; upstream: string };

export interface GitStatusSummary {
  /** The branch name; a short HEAD oid when detached; "HEAD" when even that is unknown. */
  branchLabel: string;
  /** HEAD is not on a branch (`branchLabel` is then a commit). */
  detached: boolean;
  /** The branch has no commits yet. */
  unborn: boolean;
  /** Changed ENTRIES, as git lists them (an untracked directory is one entry). */
  changed: number;
  /** Entries with something staged (conflicts excluded). */
  staged: number;
  /** Tracked entries with unstaged changes (conflicts excluded). An `MM` file counts here AND
   *  in `staged` — git's own semantics, so the buckets need not add up to `changed`. */
  modified: number;
  /** Untracked entries (`-unormal`: a new directory counts once). */
  untracked: number;
  /** Unmerged entries — a merge, rebase or cherry-pick stopped on them. */
  conflicts: number;
  sync: GitSync;
}

/** The unmerged XY codes of porcelain v2 (`u` entries): any side `U`, or both added / both
 *  deleted. An ordinary entry can never carry them. */
export function isConflict(f: Pick<GitFileEntry, "index_status" | "worktree_status">): boolean {
  const x = f.index_status;
  const y = f.worktree_status;
  return x === "U" || y === "U" || (x === y && (x === "A" || x === "D"));
}

/** Boil a `GitStatus` down to the widget's figures. */
export function summarizeGitStatus(st: GitStatus): GitStatusSummary {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const f of st.files) {
    if (isConflict(f)) {
      conflicts++;
      continue;
    }
    if (f.untracked) {
      untracked++;
      continue;
    }
    if (f.staged) staged++;
    if (f.unstaged) modified++;
  }
  const detached = st.branch === null;
  const branchLabel = st.branch ?? (st.head ? st.head.slice(0, 7) : "HEAD");
  const sync: GitSync =
    st.upstream === null
      ? { kind: "no-upstream" }
      : st.upstream_gone
        ? { kind: "gone", upstream: st.upstream }
        : { kind: "tracking", upstream: st.upstream, ahead: st.ahead, behind: st.behind };
  return {
    branchLabel,
    detached,
    unborn: st.unborn,
    changed: st.files.length,
    staged,
    modified,
    untracked,
    conflicts,
    sync,
  };
}

/** The quiet pill next to the branch: its text, whether it is a warning, and the hover line. */
export interface SyncPill {
  text: string;
  warn: boolean;
  tooltip: string;
}

/**
 * How the sync reading is SAID. Ahead/behind compare with the local remote-tracking ref, which
 * only moves on a fetch (nothing here fetches — it is network access and may prompt for
 * credentials), so the tooltip says so rather than letting "in sync" pass for a live answer.
 * Only the non-zero directions are printed: "↑2", "↓1", "↑2 ↓1".
 */
export function syncPill(sync: GitSync): SyncPill {
  switch (sync.kind) {
    case "no-upstream":
      return {
        text: "no upstream",
        warn: false,
        tooltip: "This branch tracks no remote branch",
      };
    case "gone":
      // Not "no longer exists": git reports the same shape for an upstream that never existed
      // yet (a fresh clone of an empty repository) — what both share is the last fetch not
      // finding it.
      return {
        text: "upstream gone",
        warn: true,
        tooltip: `Tracking ${sync.upstream}, which the last fetch did not find on the remote`,
      };
    case "tracking": {
      const parts: string[] = [];
      if (sync.ahead > 0) parts.push(`↑${sync.ahead}`);
      if (sync.behind > 0) parts.push(`↓${sync.behind}`);
      const counts =
        parts.length === 0
          ? "neither ahead nor behind"
          : [
              sync.ahead > 0 ? `${sync.ahead} ahead` : null,
              sync.behind > 0 ? `${sync.behind} behind` : null,
            ]
              .filter(Boolean)
              .join(", ");
      return {
        text: parts.length === 0 ? "in sync" : parts.join(" "),
        warn: false,
        tooltip: `Tracking ${sync.upstream} (${counts}) — compared with the last fetch`,
      };
    }
  }
}

/**
 * The pill the branch line shows, or null when it would say nothing: a detached HEAD is not on a
 * branch, so "no upstream" / "This branch tracks no remote branch" would be noise next to its
 * "detached" tag — and the tooltip would describe a branch that does not exist. (A detached HEAD
 * that DOES report an upstream, which git can do mid-rebase, keeps its pill.)
 */
export function branchSyncPill(summary: GitStatusSummary): SyncPill | null {
  if (summary.detached && summary.sync.kind === "no-upstream") return null;
  return syncPill(summary.sync);
}

/**
 * Which way a counter's figure rolls in when it changes: "up" (from below) when it grew, "down"
 * when it shrank — or not at all. Only a KNOWN value changing into another known value rolls:
 * the first reading and unknown→known are not a change of the tree, just the answer arriving.
 */
export function rollDirection(prev: number | null, next: number | null): "up" | "down" | null {
  if (prev === null || next === null || prev === next) return null;
  return next > prev ? "up" : "down";
}

/** The header's reading: the changed-entry count, "clean", or an em dash when unknown. */
export function gitMetaText(summary: GitStatusSummary | null): string {
  if (!summary) return "—";
  return summary.changed === 0 ? "clean" : String(summary.changed);
}

/** Why a status read failed, in the few cases the UI answers differently. */
export type GitErrorKind = "not-a-repo" | "folder-gone" | "no-access" | "git-missing" | "other";

/**
 * Sort a `git_status` error message. The core forces `LC_ALL=C`, so git's messages are stable
 * English and safe to match on:
 *  - "fatal: not a git repository (or any of the parent directories): .git" (or "… (or any
 *    parent up to mount point …)") — the discovery walk found nothing: an ordinary folder, not a
 *    failure;
 *  - "fatal: cannot change to '<dir>': No such file or directory" — the folder is gone (a removed
 *    worktree, a deleted checkout);
 *  - "… cannot change to …: Operation not permitted / Permission denied" — the folder exists but
 *    this app may not read it (macOS privacy settings); NOT "gone", or the advice would be wrong;
 *  - "could not launch git: No such file or directory …" — the core's own wording when there is
 *    no `git` binary to spawn; and the `/usr/bin/git` shim's "xcrun: error: invalid active
 *    developer path" — a Mac without the Command Line Tools, which is the same thing to a user.
 *
 * ⚠️ Narrow on purpose, because "not-a-repo" makes the widget disappear:
 *  - a BROKEN gitlink ("fatal: not a git repository: /repo/.git/worktrees/x" — a worktree folder
 *    left behind after its repository pruned or lost it) is a failure worth showing, not an
 *    ordinary folder: only the discovery-walk wording counts as "not-a-repo";
 *  - a spawn that failed for another reason (too many open files…) is not "git is not
 *    installed" — it stays "other", in its own words.
 */
export function classifyGitError(message: string): GitErrorKind {
  const m = message.toLowerCase();
  if (m.includes("not a git repository (or any")) return "not-a-repo";
  if (m.includes("could not launch git"))
    return m.includes("no such file or directory") ? "git-missing" : "other";
  if (m.includes("xcrun: error: invalid active developer path")) return "git-missing";
  if (m.includes("cannot change to")) {
    if (m.includes("no such file or directory") || m.includes("not a directory"))
      return "folder-gone";
    if (m.includes("operation not permitted") || m.includes("permission denied"))
      return "no-access";
  }
  return "other";
}

/**
 * The part of a status error worth a sentence: git's own words. The core formats a failed
 * command as `git <args>: <stderr>`, and git prefixes its own with `fatal:` / `error:` — both are
 * noise in a one-line note that already says the read failed (the full text stays in the
 * tooltip). Anything else is returned as is.
 */
export function gitErrorDetail(message: string): string {
  const stderr = /^git [^:\n]*: ([\s\S]+)$/.exec(message)?.[1] ?? message;
  return stderr.replace(/^(?:fatal|error): /, "").trim() || message.trim();
}
