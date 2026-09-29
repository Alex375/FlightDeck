//! Working-tree status and per-file diffs — the source-control half of the git
//! service. Same encapsulation rule as the rest of [`super`]: only this module
//! shells out to `git` (via the shared helpers) and parses its output.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{build_diff, run_git, GitDiff, GitError};

/// One changed path reported by `git status --porcelain=v2`. The `index_status` /
/// `worktree_status` are the two halves of git's `XY` code (`.` = unchanged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GitFileEntry {
    /// Path relative to the repository root (forward slashes, as git emits).
    pub path: String,
    /// For a rename/copy, the path it came from; `None` otherwise.
    pub orig_path: Option<String>,
    /// Index (staged) status letter: `M A D R C T .` or `?` (untracked).
    pub index_status: String,
    /// Working-tree (unstaged) status letter, same alphabet.
    pub worktree_status: String,
    /// Index differs from HEAD (there is something staged).
    pub staged: bool,
    /// Working tree differs from the index (there is something unstaged).
    pub unstaged: bool,
    /// Not yet tracked by git.
    pub untracked: bool,
}

/// Summary of `git status`: the current branch, its upstream tracking counts and
/// the changed files. Backs the source-control view's header + file list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GitStatus {
    /// Current branch name; `None` when detached.
    pub branch: Option<String>,
    /// Full HEAD commit oid; `None` on an unborn branch.
    pub head: Option<String>,
    /// Upstream ref short name (e.g. `origin/main`); `None` when unset.
    pub upstream: Option<String>,
    /// Commits ahead of upstream. ⚠️ Also `0` when there is NO upstream or it is GONE:
    /// read it only when `upstream` is set and `upstream_gone` is false.
    pub ahead: u32,
    /// Commits behind upstream. Same caveat as `ahead`.
    pub behind: u32,
    /// An upstream is configured but its commit is missing — typically the remote branch
    /// was deleted and pruned. git then prints `branch.upstream` WITHOUT `branch.ab`, so
    /// `ahead`/`behind` are not counts but the struct's defaults: without this flag a gone
    /// upstream reads as a fake "in sync" 0/0.
    pub upstream_gone: bool,
    /// The branch has no commits yet (unborn HEAD).
    pub unborn: bool,
    /// Changed entries (staged + unstaged + untracked), in git's order.
    pub files: Vec<GitFileEntry>,
}

/// Arguments of the status read. Porcelain v2 with `-z` so filenames with
/// spaces/newlines and rename pairs parse unambiguously.
///
/// ⚠️ `--no-optional-locks` comes FIRST (a top-level git option, so it must precede the
/// subcommand): a plain `git status` opportunistically refreshes the index and writes it
/// back under `.git/index.lock`. This read runs in the BACKGROUND (panel refreshes, turn
/// ends) while the agent may be running `git add` / `git commit` in the same checkout;
/// holding that lock, even briefly, makes the AGENT's command fail with "Unable to create
/// …/index.lock: File exists". A read must never break a write.
const STATUS_ARGS: &[&str] = &["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"];

/// Status of the working tree at `cwd` (see [`STATUS_ARGS`]).
pub fn status(cwd: &str) -> Result<GitStatus, GitError> {
    let out = run_git(cwd, STATUS_ARGS)?;
    Ok(parse_status_v2(&out))
}

/// Diff of one working-tree file against HEAD: the "before" side is the file's
/// content at HEAD (empty when the file is new), the "after" side is the current
/// on-disk content (empty when deleted). The front's Monaco diff editor renders
/// the visual diff from these two texts.
pub fn diff_worktree(cwd: &str, path: &str, orig_path: Option<&str>) -> Result<GitDiff, GitError> {
    // `HEAD:<path>` resolves relative to the repo root (where status paths live).
    // For a rename/copy the "before" lives at HEAD under the ORIGINAL path (the new
    // path doesn't exist at HEAD) — without this it would render as fully added.
    // A missing blob (genuine add / unborn) just yields an empty "before" side.
    let old_path = orig_path.unwrap_or(path);
    let old = super::show_blob_or_empty(cwd, &format!("HEAD:{old_path}"))?;
    let new = std::fs::read(std::path::Path::new(cwd).join(path)).unwrap_or_default();
    Ok(build_diff(path, &old, &new, "HEAD", "Working tree"))
}

/// Parse `git status --porcelain=v2 --branch -z`. Records are NUL-separated;
/// header lines start with `# `, entries with `1`/`2`/`u`/`?`/`!`. A type-`2`
/// (rename/copy) entry is followed by its original path as a separate NUL token.
/// Pure function (no IO) — unit-tested directly.
fn parse_status_v2(out: &str) -> GitStatus {
    let mut st = GitStatus::default();
    // git prints `branch.ab` only "if upstream is set and the commit is present": an
    // upstream with no `branch.ab` is a GONE upstream (see `GitStatus::upstream_gone`).
    let mut saw_ab = false;
    let mut tokens = out.split('\0');
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        if let Some(rest) = tok.strip_prefix("# ") {
            saw_ab |= parse_branch_header(rest, &mut st);
            continue;
        }
        match tok.as_bytes()[0] {
            b'1' => {
                if let Some(e) = parse_ordinary(tok) {
                    st.files.push(e);
                }
            }
            b'2' => {
                // The rename/copy source path is the following NUL token.
                let orig = tokens.next().map(|s| s.to_string());
                if let Some(mut e) = parse_renamed(tok) {
                    e.orig_path = orig;
                    st.files.push(e);
                }
            }
            b'u' => {
                if let Some(e) = parse_unmerged(tok) {
                    st.files.push(e);
                }
            }
            b'?' => st.files.push(GitFileEntry {
                // Token is `?` + one separator space + <path>. Strip exactly that
                // (index 2), NOT all leading whitespace — a filename may itself
                // begin with spaces. (`?` and the space are one byte each.)
                path: tok.get(2..).unwrap_or("").to_string(),
                orig_path: None,
                index_status: ".".into(),
                worktree_status: "?".into(),
                staged: false,
                unstaged: true,
                untracked: true,
            }),
            // `!` ignored entries are not requested (no `--ignored`) — skip if seen.
            _ => {}
        }
    }
    st.upstream_gone = st.upstream.is_some() && !saw_ab;
    st
}

/// Apply one `# branch.*` header line. Returns whether it was the `branch.ab` line:
/// the caller needs to know it was SEEN, not only its values, to tell a gone upstream
/// from a genuine `+0 -0`.
fn parse_branch_header(rest: &str, st: &mut GitStatus) -> bool {
    if let Some(oid) = rest.strip_prefix("branch.oid ") {
        if oid == "(initial)" {
            st.unborn = true;
        } else {
            st.head = Some(oid.to_string());
        }
    } else if let Some(name) = rest.strip_prefix("branch.head ") {
        if name != "(detached)" {
            st.branch = Some(name.to_string());
        }
    } else if let Some(up) = rest.strip_prefix("branch.upstream ") {
        st.upstream = Some(up.to_string());
    } else if let Some(ab) = rest.strip_prefix("branch.ab ") {
        // "+<ahead> -<behind>"
        let mut parts = ab.split_whitespace();
        st.ahead = parts
            .next()
            .and_then(|s| s.trim_start_matches('+').parse().ok())
            .unwrap_or(0);
        st.behind = parts
            .next()
            .and_then(|s| s.trim_start_matches('-').parse().ok())
            .unwrap_or(0);
        return true;
    }
    false
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — 8 fixed fields then the path.
fn parse_ordinary(tok: &str) -> Option<GitFileEntry> {
    let mut it = tok.splitn(9, ' ');
    it.next()?; // "1"
    let xy = it.next()?;
    for _ in 0..6 {
        it.next()?;
    }
    let path = it.next()?.to_string();
    Some(entry_from_xy(xy, path))
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>` — 9 fixed fields then
/// the (new) path; the original path arrives as the next NUL token (handled by
/// the caller).
fn parse_renamed(tok: &str) -> Option<GitFileEntry> {
    let mut it = tok.splitn(10, ' ');
    it.next()?; // "2"
    let xy = it.next()?;
    for _ in 0..7 {
        it.next()?;
    }
    let path = it.next()?.to_string();
    Some(entry_from_xy(xy, path))
}

/// `u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` — 10 fixed fields then
/// the path. An unmerged entry is a conflict: mark both sides changed.
fn parse_unmerged(tok: &str) -> Option<GitFileEntry> {
    let mut it = tok.splitn(11, ' ');
    it.next()?; // "u"
    let xy = it.next()?;
    for _ in 0..8 {
        it.next()?;
    }
    let path = it.next()?.to_string();
    let mut e = entry_from_xy(xy, path);
    e.staged = true;
    e.unstaged = true;
    Some(e)
}

fn entry_from_xy(xy: &str, path: String) -> GitFileEntry {
    let b = xy.as_bytes();
    let x = *b.first().unwrap_or(&b'.') as char;
    let y = *b.get(1).unwrap_or(&b'.') as char;
    GitFileEntry {
        path,
        orig_path: None,
        index_status: x.to_string(),
        worktree_status: y.to_string(),
        staged: x != '.',
        unstaged: y != '.',
        untracked: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fields are space-separated within a record, records NUL-separated. Built
    // here with explicit `\0` so the shape matches `git status -z` exactly.
    #[test]
    fn parses_branch_header_and_counts() {
        let out = "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0";
        let st = parse_status_v2(out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.head.as_deref(), Some("abc123"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!(st.ahead, 2);
        assert_eq!(st.behind, 1);
        assert!(!st.upstream_gone);
        assert!(!st.unborn);
    }

    // Verified against git 2.50: once the remote branch is deleted and pruned, the
    // header keeps `branch.upstream` but drops `branch.ab`.
    #[test]
    fn upstream_without_ab_is_gone_not_in_sync() {
        let out = "# branch.oid abc123\0# branch.head feat\0# branch.upstream origin/feat\0";
        let st = parse_status_v2(out);
        assert_eq!(st.upstream.as_deref(), Some("origin/feat"));
        assert!(st.upstream_gone, "an upstream with no branch.ab is gone");
        assert_eq!((st.ahead, st.behind), (0, 0), "the counts stay at their defaults");
    }

    #[test]
    fn in_sync_upstream_is_not_gone() {
        let out =
            "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0";
        let st = parse_status_v2(out);
        assert!(!st.upstream_gone, "a real +0 -0 is in sync, not gone");
    }

    #[test]
    fn no_upstream_is_not_gone() {
        let out = "# branch.oid abc123\0# branch.head local\0";
        let st = parse_status_v2(out);
        assert_eq!(st.upstream, None);
        assert!(!st.upstream_gone, "gone needs an upstream to be gone from");
    }

    #[test]
    fn status_read_takes_no_optional_locks() {
        // A top-level option: only valid BEFORE the subcommand.
        assert_eq!(STATUS_ARGS.first(), Some(&"--no-optional-locks"));
        assert_eq!(STATUS_ARGS.get(1), Some(&"status"));
    }

    #[test]
    fn unborn_branch_sets_flag() {
        let out = "# branch.oid (initial)\0# branch.head main\0";
        let st = parse_status_v2(out);
        assert!(st.unborn);
        assert_eq!(st.head, None);
    }

    #[test]
    fn parses_ordinary_changed_entry() {
        // staged-modified, unstaged-clean: XY = "M."
        let out = "1 M. N... 100644 100644 100644 1111 2222 src/lib.rs\0";
        let st = parse_status_v2(out);
        assert_eq!(st.files.len(), 1);
        let f = &st.files[0];
        assert_eq!(f.path, "src/lib.rs");
        assert_eq!(f.index_status, "M");
        assert_eq!(f.worktree_status, ".");
        assert!(f.staged && !f.unstaged && !f.untracked);
    }

    #[test]
    fn parses_untracked_entry() {
        let out = "? newfile.txt\0";
        let st = parse_status_v2(out);
        assert_eq!(st.files.len(), 1);
        let f = &st.files[0];
        assert_eq!(f.path, "newfile.txt");
        assert!(f.untracked && f.unstaged && !f.staged);
    }

    #[test]
    fn parses_rename_with_orig_path() {
        // type-2 entry, then the original path as the next NUL token.
        let out = "2 R. N... 100644 100644 100644 1111 2222 R100 new/name.rs\0old/name.rs\0";
        let st = parse_status_v2(out);
        assert_eq!(st.files.len(), 1);
        let f = &st.files[0];
        assert_eq!(f.path, "new/name.rs");
        assert_eq!(f.orig_path.as_deref(), Some("old/name.rs"));
        assert_eq!(f.index_status, "R");
    }

    #[test]
    fn path_with_spaces_survives() {
        let out = "1 .M N... 100644 100644 100644 1111 2222 dir/a file.txt\0";
        let st = parse_status_v2(out);
        assert_eq!(st.files[0].path, "dir/a file.txt");
        assert!(st.files[0].unstaged && !st.files[0].staged);
    }

    #[test]
    fn untracked_path_keeps_leading_spaces() {
        // `?` + one separator space + a filename that itself starts with spaces.
        let out = "?   leading.txt\0";
        let st = parse_status_v2(out);
        assert_eq!(st.files.len(), 1);
        assert_eq!(st.files[0].path, "  leading.txt", "only the separator space is stripped");
        assert!(st.files[0].untracked);
    }
}
