//! Reading a repository's EXACT local state, to rebuild it on a paired server: which commit
//! and branch it is on, which commits a server clone still lacks (shipped as a `git bundle`),
//! the staged and unstaged changes (as binary patches), and the files git does not track.
//!
//! Read-only on this Mac — nothing here writes to the repository (the bundle goes to a file
//! the caller names, outside it). The server side of the transfer is `server_launch`, which
//! never runs this Mac's git against a server path.

use std::path::Path;
use std::process::{Command, Stdio};

use super::{run_git, run_git_bytes, GitError};

/// Where the repository is: its HEAD commit and the branch checked out (`None` = detached).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadState {
    pub commit: String,
    pub branch: Option<String>,
    /// The HEAD commit's subject line, for the user and the agent.
    pub subject: String,
}

/// HEAD's commit, branch and subject. `Err` on a repository with no commit yet (nothing to
/// transfer), with git's own message.
pub fn head_state(repo: &str) -> Result<HeadState, GitError> {
    let commit = run_git(repo, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])
        .map_err(|_| GitError::Parse("this repository has no commit yet".into()))?
        .trim()
        .to_string();
    // `symbolic-ref -q` exits 1 on a detached HEAD: an answer, not a failure.
    let branch = match run_git(repo, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        Ok(b) => Some(b.trim().to_string()).filter(|b| !b.is_empty()),
        Err(GitError::Command { code: Some(1), .. }) => None,
        Err(e) => return Err(e),
    };
    let subject = run_git(repo, &["log", "-1", "--format=%s", &commit])?.trim().to_string();
    Ok(HeadState { commit, branch, subject })
}

/// A shallow clone: its history stops at a boundary a bundle cannot carry past.
pub fn is_shallow(repo: &str) -> Result<bool, GitError> {
    Ok(run_git(repo, &["rev-parse", "--is-shallow-repository"])?.trim() == "true")
}

/// Commits on HEAD that its upstream does not have. `None` when the branch has no upstream
/// (or HEAD is detached): there is nothing to count against.
pub fn unpushed_count(repo: &str) -> Option<u32> {
    run_git(repo, &["rev-list", "--count", "@{upstream}..HEAD"])
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// The refs the transfer carries, as `(oid, refname)`: local branches, tags, and this Mac's
/// view of `origin` (its symbolic `origin/HEAD` left out — it names a branch, not a commit).
pub fn transfer_refs(repo: &str) -> Result<Vec<(String, String)>, GitError> {
    let out = run_git(
        repo,
        &[
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            "refs/heads",
            "refs/tags",
            "refs/remotes/origin",
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once(' '))
        .filter(|(_, r)| *r != "refs/remotes/origin/HEAD")
        .map(|(o, r)| (o.to_string(), r.to_string()))
        .collect())
}

/// Which of `oids` this repository has (as any object), in order. One `git cat-file
/// --batch-check` for the lot.
pub fn known_objects(repo: &str, oids: &[String]) -> Result<Vec<bool>, GitError> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = String::with_capacity(oids.len() * 41);
    for o in oids {
        input.push_str(o);
        input.push('\n');
    }
    let out = run_git_stdin(repo, &["cat-file", "--batch-check=%(objectname)"], input.as_bytes())?;
    let out = String::from_utf8_lossy(&out);
    // One line per input: the oid back when it exists, `<oid> missing` otherwise.
    let lines: Vec<&str> = out.lines().collect();
    if lines.len() != oids.len() {
        return Err(GitError::Parse(format!(
            "cat-file answered {} lines for {} objects",
            lines.len(),
            oids.len()
        )));
    }
    Ok(lines.iter().map(|l| !l.ends_with(" missing")).collect())
}

/// Whether `ancestor` is an ancestor of (or equal to) `of`. `merge-base --is-ancestor` exits
/// 1 for "no": an answer, not a failure.
pub fn is_ancestor(repo: &str, ancestor: &str, of: &str) -> Result<bool, GitError> {
    match run_git(repo, &["merge-base", "--is-ancestor", ancestor, of]) {
        Ok(_) => Ok(true),
        Err(GitError::Command { code: Some(1), .. }) => Ok(false),
        Err(e) => Err(e),
    }
}

/// What [`create_bundle`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleOutcome {
    /// Written to the file, this many bytes.
    Written(u64),
    /// The server already has every commit the refs point at: no bundle (git refuses an
    /// empty one), the refs alone are sent.
    NothingNew,
}

/// Bundle every commit the transfer's refs reach (local branches, tags, `origin/*` and HEAD)
/// that `basis` — commits the server already has — does not, into `out`.
pub fn create_bundle(repo: &str, out: &Path, basis: &[String]) -> Result<BundleOutcome, GitError> {
    let out_s = out.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec![
        "bundle".into(),
        "create".into(),
        "-q".into(),
        out_s,
        "--branches".into(),
        "--tags".into(),
        "--remotes=origin".into(),
        "HEAD".into(),
    ];
    if !basis.is_empty() {
        args.push("--not".into());
        args.extend(basis.iter().cloned());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    match run_git(repo, &argv) {
        Ok(_) => {}
        // git's own (LC_ALL=C) verdict that nothing is left once the basis is subtracted.
        Err(GitError::Command { stderr, .. }) if stderr.contains("Refusing to create empty bundle") => {
            return Ok(BundleOutcome::NothingNew);
        }
        Err(e) => return Err(e),
    }
    let len = std::fs::metadata(out)
        .map_err(|e| GitError::Parse(format!("the bundle was not written: {e}")))?
        .len();
    Ok(BundleOutcome::Written(len))
}

/// The staged changes (index vs HEAD, `cached`) or the unstaged ones (work tree vs index), as
/// a binary patch `git apply` takes back. Submodules are left out: their commits are not in
/// the transfer, so a pointer change could not apply.
pub fn diff_patch(repo: &str, cached: bool) -> Result<Vec<u8>, GitError> {
    let mut args = vec!["diff", "--binary", "--no-color", "--no-ext-diff", "--ignore-submodules=all"];
    if cached {
        args.push("--cached");
    }
    run_git_bytes(repo, &args)
}

/// How many files a [`diff_patch`] touches.
pub fn diff_file_count(repo: &str, cached: bool) -> Result<u32, GitError> {
    let mut args = vec!["diff", "--name-only", "-z", "--ignore-submodules=all"];
    if cached {
        args.push("--cached");
    }
    let out = run_git_bytes(repo, &args)?;
    Ok(out.split(|b| *b == 0).filter(|p| !p.is_empty()).count() as u32)
}

/// Files git does not track and does not ignore, relative to the repository root.
pub fn untracked_files(repo: &str) -> Result<Vec<String>, GitError> {
    let out = run_git_bytes(repo, &["ls-files", "-z", "--others", "--exclude-standard"])?;
    Ok(split_z(&out))
}

/// What git ignores, relative to the root: a wholly ignored folder as ONE entry ending in
/// `/` (`node_modules/`), never its hundred thousand files.
pub fn ignored_entries(repo: &str) -> Result<Vec<String>, GitError> {
    let out = run_git_bytes(
        repo,
        &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    )?;
    Ok(split_z(&out))
}

/// The repository declares submodules (they are not transferred).
pub fn has_submodules(repo: &str) -> bool {
    Path::new(repo).join(".gitmodules").is_file()
}

fn split_z(out: &[u8]) -> Vec<String> {
    out.split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect()
}

/// [`run_git_bytes`] with `input` on git's stdin (`cat-file --batch-check`).
fn run_git_stdin(dir: &str, args: &[&str], input: &[u8]) -> Result<Vec<u8>, GitError> {
    use std::io::Write as _;
    let mut child = Command::new("git")
        .env("LC_ALL", "C")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(GitError::Spawn)?;
    // Written from a thread: git answers line by line while it reads, so a large input
    // written here before reading would fill both pipes and deadlock.
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let output = child.wait_with_output().map_err(GitError::Spawn)?;
    let _ = writer.join();
    if !output.status.success() {
        return Err(GitError::Command {
            args: args.join(" "),
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A throwaway repository with one commit.
    pub(crate) struct Repo(pub PathBuf);

    impl Repo {
        pub fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("fd-snapshot-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let r = Repo(dir);
            r.git(&["init", "-q", "-b", "main"]);
            r.git(&["config", "user.email", "t@example.com"]);
            r.git(&["config", "user.name", "T"]);
            r.write("a.txt", "one\n");
            r.git(&["add", "."]);
            r.git(&["commit", "-q", "-m", "first"]);
            r
        }
        pub fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
        pub fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git").arg("-C").arg(&self.0).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        pub fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn head_state_reads_branch_and_detached() {
        let r = Repo::new("head");
        let h = head_state(r.path()).unwrap();
        assert_eq!(h.branch.as_deref(), Some("main"));
        assert_eq!(h.subject, "first");
        assert_eq!(h.commit.len(), 40);
        r.git(&["checkout", "-q", "--detach"]);
        assert_eq!(head_state(r.path()).unwrap().branch, None);
    }

    #[test]
    fn head_state_refuses_an_unborn_repository() {
        let dir = std::env::temp_dir().join(format!("fd-snapshot-unborn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git").arg("-C").arg(&dir).args(["init", "-q"]).output().unwrap();
        let e = head_state(dir.to_str().unwrap()).unwrap_err();
        assert!(e.to_string().contains("no commit yet"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_is_empty_once_the_basis_has_everything() {
        let r = Repo::new("bundle");
        let head = head_state(r.path()).unwrap().commit;
        let out = r.0.join("x.bundle");
        assert!(matches!(create_bundle(r.path(), &out, &[]).unwrap(), BundleOutcome::Written(n) if n > 0));
        let out2 = r.0.join("y.bundle");
        assert_eq!(create_bundle(r.path(), &out2, &[head]).unwrap(), BundleOutcome::NothingNew);
    }

    #[test]
    fn known_objects_tells_present_from_missing() {
        let r = Repo::new("known");
        let head = head_state(r.path()).unwrap().commit;
        let got = known_objects(r.path(), &[head, "0123456789012345678901234567890123456789".into()]).unwrap();
        assert_eq!(got, [true, false]);
    }

    #[test]
    fn untracked_and_ignored_are_listed_apart() {
        let r = Repo::new("lists");
        r.write(".gitignore", "node_modules/\n.env\n");
        r.git(&["add", ".gitignore"]);
        r.git(&["commit", "-q", "-m", "ignore"]);
        r.write("new.txt", "x");
        r.write(".env", "SECRET=1");
        r.write("node_modules/a/b.js", "x");
        assert_eq!(untracked_files(r.path()).unwrap(), ["new.txt"]);
        let mut ign = ignored_entries(r.path()).unwrap();
        ign.sort();
        assert_eq!(ign, [".env", "node_modules/"]);
    }

    #[test]
    fn staged_and_unstaged_patches_are_separate() {
        let r = Repo::new("diff");
        r.write("a.txt", "two\n");
        r.git(&["add", "a.txt"]);
        r.write("a.txt", "three\n");
        let staged = String::from_utf8(diff_patch(r.path(), true).unwrap()).unwrap();
        let unstaged = String::from_utf8(diff_patch(r.path(), false).unwrap()).unwrap();
        assert!(staged.contains("+two") && !staged.contains("+three"), "{staged}");
        assert!(unstaged.contains("+three") && unstaged.contains("-two"), "{unstaged}");
        assert_eq!(diff_file_count(r.path(), true).unwrap(), 1);
    }
}
