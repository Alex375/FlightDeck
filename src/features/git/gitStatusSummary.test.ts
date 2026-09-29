import { describe, it, expect } from "vitest";
import {
  branchSyncPill,
  classifyGitError,
  gitErrorDetail,
  gitMetaText,
  isConflict,
  rollDirection,
  summarizeGitStatus,
  syncPill,
} from "./gitStatusSummary";
import type { GitFileEntry, GitStatus } from "../../ipc/client";

/** A file entry from its porcelain XY code, flagged the way the Rust parser flags it. */
function entry(path: string, xy: string, kind: "ordinary" | "unmerged" = "ordinary"): GitFileEntry {
  const [x, y] = [xy[0], xy[1]];
  const unmerged = kind === "unmerged";
  return {
    path,
    orig_path: null,
    index_status: x,
    worktree_status: y,
    staged: unmerged || x !== ".",
    unstaged: unmerged || y !== ".",
    untracked: false,
  };
}

function untracked(path: string): GitFileEntry {
  return {
    path,
    orig_path: null,
    index_status: ".",
    worktree_status: "?",
    staged: false,
    unstaged: true,
    untracked: true,
  };
}

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    head: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    upstream_gone: false,
    unborn: false,
    files: [],
    ...over,
  };
}

describe("summarizeGitStatus — counts", () => {
  it("counts staged, modified and untracked entries", () => {
    const s = summarizeGitStatus(
      status({
        files: [entry("a", "M."), entry("b", ".M"), entry("c", "A."), untracked("d"), untracked("e/")],
      }),
    );
    expect(s).toMatchObject({ changed: 5, staged: 2, modified: 1, untracked: 2, conflicts: 0 });
  });

  it("counts an MM file in BOTH staged and modified (git's semantics)", () => {
    const s = summarizeGitStatus(status({ files: [entry("a", "MM")] }));
    expect(s).toMatchObject({ changed: 1, staged: 1, modified: 1 });
  });

  it("counts a conflict once, and never in the staged or modified buckets", () => {
    const s = summarizeGitStatus(
      status({ files: [entry("a", "UU", "unmerged"), entry("b", "AA", "unmerged"), entry("c", "M.")] }),
    );
    expect(s).toMatchObject({ changed: 3, conflicts: 2, staged: 1, modified: 0, untracked: 0 });
  });

  it("an untracked directory is ONE entry", () => {
    expect(summarizeGitStatus(status({ files: [untracked("newdir/")] })).untracked).toBe(1);
  });

  it("an intent-to-add file (.A) is modified, not staged", () => {
    expect(summarizeGitStatus(status({ files: [entry("a", ".A")] }))).toMatchObject({
      staged: 0,
      modified: 1,
    });
  });

  it("a clean tree is a real zero everywhere", () => {
    expect(summarizeGitStatus(status())).toMatchObject({
      changed: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    });
  });
});

describe("isConflict", () => {
  it("matches every unmerged XY code", () => {
    for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"])
      expect(isConflict(entry("f", xy, "unmerged")), xy).toBe(true);
  });

  it("does not take an untracked entry for a conflict (the fileMeta 'U' trap)", () => {
    expect(isConflict(untracked("f"))).toBe(false);
  });

  it("does not match ordinary codes", () => {
    for (const xy of ["M.", ".M", "MM", "A.", "D.", ".D", "R.", "AM", "AD"])
      expect(isConflict(entry("f", xy)), xy).toBe(false);
  });
});

describe("summarizeGitStatus — branch and sync", () => {
  it("reads ahead/behind only when tracking", () => {
    expect(summarizeGitStatus(status({ ahead: 2, behind: 1 })).sync).toEqual({
      kind: "tracking",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
    });
  });

  it("no upstream is not a fake 0/0", () => {
    expect(summarizeGitStatus(status({ upstream: null })).sync).toEqual({ kind: "no-upstream" });
  });

  it("a gone upstream is not a fake 0/0", () => {
    expect(summarizeGitStatus(status({ upstream: "origin/feat", upstream_gone: true })).sync).toEqual({
      kind: "gone",
      upstream: "origin/feat",
    });
  });

  it("labels a detached HEAD by its short oid", () => {
    const s = summarizeGitStatus(status({ branch: null, upstream: null }));
    expect(s.detached).toBe(true);
    expect(s.branchLabel).toBe("a1b2c3d");
  });

  it("keeps the branch name on an unborn branch", () => {
    const s = summarizeGitStatus(status({ head: null, unborn: true, upstream: null }));
    expect(s).toMatchObject({ branchLabel: "main", unborn: true, detached: false });
  });
});

describe("syncPill", () => {
  const tracking = (ahead: number, behind: number) =>
    ({ kind: "tracking", upstream: "origin/main", ahead, behind }) as const;

  it("prints only the non-zero directions, with real arrows", () => {
    expect(syncPill(tracking(2, 1)).text).toBe("↑2 ↓1");
    expect(syncPill(tracking(2, 0)).text).toBe("↑2");
    expect(syncPill(tracking(0, 3)).text).toBe("↓3");
  });

  it("says in sync at 0/0, and that it is as of the last fetch", () => {
    const p = syncPill(tracking(0, 0));
    expect(p.text).toBe("in sync");
    expect(p.warn).toBe(false);
    expect(p.tooltip).toContain("origin/main");
    expect(p.tooltip).toContain("last fetch");
  });

  it("names the tracking target and the counts in the tooltip", () => {
    expect(syncPill(tracking(2, 1)).tooltip).toBe(
      "Tracking origin/main (2 ahead, 1 behind) — compared with the last fetch",
    );
  });

  it("warns on a gone upstream, quiet on no upstream", () => {
    expect(syncPill({ kind: "gone", upstream: "origin/x" })).toMatchObject({
      text: "upstream gone",
      warn: true,
    });
    expect(syncPill({ kind: "no-upstream" })).toMatchObject({ text: "no upstream", warn: false });
  });

  it("says a gone upstream was not found by the last fetch — true of a never-pushed one too", () => {
    // git reports a fresh clone of an EMPTY repository the same way (branch.upstream with no
    // branch.ab): "no longer exists" would be wrong there.
    const tip = syncPill({ kind: "gone", upstream: "origin/x" }).tooltip;
    expect(tip).toContain("origin/x");
    expect(tip).toContain("last fetch");
    expect(tip).not.toContain("no longer");
  });

  it("at 0/0 the tooltip says so in words", () => {
    expect(syncPill(tracking(0, 0)).tooltip).toBe(
      "Tracking origin/main (neither ahead nor behind) — compared with the last fetch",
    );
  });
});

describe("branchSyncPill", () => {
  it("says nothing for a detached HEAD with no upstream — there is no branch to track", () => {
    expect(branchSyncPill(summarizeGitStatus(status({ branch: null, upstream: null })))).toBeNull();
  });

  it("keeps the pill of a detached HEAD that does report an upstream", () => {
    const s = summarizeGitStatus(status({ branch: null, upstream: "origin/main", ahead: 1 }));
    expect(branchSyncPill(s)?.text).toBe("↑1");
  });

  it("an ordinary branch gets its sync pill, 'no upstream' included", () => {
    expect(branchSyncPill(summarizeGitStatus(status({ ahead: 2, behind: 1 })))?.text).toBe("↑2 ↓1");
    expect(branchSyncPill(summarizeGitStatus(status({ upstream: null })))?.text).toBe("no upstream");
  });
});

describe("rollDirection", () => {
  it("rolls up when a known count grew, down when it shrank", () => {
    expect(rollDirection(1, 3)).toBe("up");
    expect(rollDirection(3, 0)).toBe("down");
  });

  it("never rolls on the first reading, unknown→known, known→unknown or no change", () => {
    expect(rollDirection(null, 2)).toBeNull();
    expect(rollDirection(2, null)).toBeNull();
    expect(rollDirection(null, null)).toBeNull();
    expect(rollDirection(2, 2)).toBeNull();
    expect(rollDirection(0, 0)).toBeNull();
  });
});

describe("gitMetaText", () => {
  it("is an em dash when unknown, never a fake 0", () => {
    expect(gitMetaText(null)).toBe("—");
  });

  it("says clean for a known empty tree, else the entry count", () => {
    expect(gitMetaText(summarizeGitStatus(status()))).toBe("clean");
    expect(gitMetaText(summarizeGitStatus(status({ files: [entry("a", "MM"), untracked("b")] })))).toBe("2");
  });
});

describe("classifyGitError", () => {
  // The core's own wording: `git <args>: <stderr>`, with git forced to LC_ALL=C.
  const cmd = "git --no-optional-locks status --porcelain=v2 --branch -z: ";

  it("recognises an ordinary folder", () => {
    expect(
      classifyGitError(`${cmd}fatal: not a git repository (or any of the parent directories): .git`),
    ).toBe("not-a-repo");
  });

  it("recognises a folder that is gone", () => {
    expect(
      classifyGitError(`${cmd}fatal: cannot change to '/x/wt': No such file or directory`),
    ).toBe("folder-gone");
    expect(classifyGitError(`${cmd}fatal: cannot change to '/x/file': Not a directory`)).toBe(
      "folder-gone",
    );
  });

  it("does not call a folder it may not read 'gone'", () => {
    expect(
      classifyGitError(`${cmd}fatal: cannot change to '/Users/a/Documents/x': Operation not permitted`),
    ).toBe("no-access");
  });

  it("recognises a folder outside any repository up to a mount point", () => {
    expect(
      classifyGitError(
        `${cmd}fatal: not a git repository (or any parent up to mount point /Volumes)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).`,
      ),
    ).toBe("not-a-repo");
  });

  it("does not hide a BROKEN gitlink as an ordinary folder", () => {
    // A worktree folder whose repository pruned or lost it: `.git` points nowhere. Calling it
    // "not a repo" would make the widget vanish over a real failure.
    expect(classifyGitError(`${cmd}fatal: not a git repository: /repo/.git/worktrees/x`)).toBe(
      "other",
    );
  });

  it("recognises a missing git binary", () => {
    expect(classifyGitError("could not launch git: No such file or directory (os error 2)")).toBe(
      "git-missing",
    );
  });

  it("recognises a Mac without the Command Line Tools (the /usr/bin/git shim)", () => {
    expect(
      classifyGitError(
        `${cmd}xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun`,
      ),
    ).toBe("git-missing");
  });

  it("does not call every failed spawn 'git is not installed'", () => {
    expect(classifyGitError("could not launch git: Too many open files (os error 24)")).toBe("other");
  });

  it("leaves anything else as other", () => {
    expect(classifyGitError(`${cmd}fatal: detected dubious ownership in repository at '/x'`)).toBe(
      "other",
    );
  });

  it("does not call a permission-refused folder gone, nor a gone folder refused", () => {
    expect(classifyGitError(`${cmd}fatal: cannot change to '/x': Permission denied`)).toBe(
      "no-access",
    );
    // A bare "Operation not permitted" without the chdir wording is not ours to explain.
    expect(classifyGitError(`${cmd}fatal: unable to read index: Operation not permitted`)).toBe(
      "other",
    );
  });
});

describe("gitErrorDetail", () => {
  const cmd = "git --no-optional-locks status --porcelain=v2 --branch -z: ";

  it("keeps git's own words: no command line, no fatal: prefix", () => {
    expect(gitErrorDetail(`${cmd}fatal: detected dubious ownership in repository at '/x'`)).toBe(
      "detected dubious ownership in repository at '/x'",
    );
    expect(gitErrorDetail(`${cmd}error: bad index file sha1 signature`)).toBe(
      "bad index file sha1 signature",
    );
  });

  it("keeps a multi-line stderr whole", () => {
    expect(gitErrorDetail(`${cmd}fatal: a\nhint: b`)).toBe("a\nhint: b");
  });

  it("leaves a message it does not recognise as is", () => {
    expect(gitErrorDetail("git status failed")).toBe("git status failed");
    expect(gitErrorDetail("could not launch git: boom")).toBe("could not launch git: boom");
    expect(gitErrorDetail("unexpected git output: x")).toBe("unexpected git output: x");
  });
});
