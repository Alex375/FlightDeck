//! Launching a conversation on a paired server FROM a repository on this Mac: the repository's
//! exact state — commits not pushed yet, staged and unstaged changes, untracked work, Claude's
//! own files and the project's secrets — is pushed over SSH into a clone Flight Deck manages
//! on the server, a worktree is made there at the same commit, and the conversation starts in
//! it knowing where it runs (a context header, `--append-system-prompt`).
//!
//! The server needs no access to GitHub: commits travel as a `git bundle`, uncommitted state
//! as binary patches plus a tar of the files git does not track. The clone is
//! `~/flightdeck/repos/<name>` (marked `flightdeck.managed`), reused when its origin matches
//! this repository's (`normalize_remote_url`, never by name); its `origin` is this repository's
//! url, redacted (`redact_remote_url`). The worktree is `<clone>/.claude/worktrees/<slug>`.
//!
//! The steps, each one visible and retryable from the front, each leaving no partial state
//! when it fails:
//!   1. [`check`] — reach the server, read its facts (OS, user, home, git), and align it with
//!      this Mac (the hook for task 763ae7f2, see [`align_hook`]);
//!   2. [`transfer`] — the commits and refs into the managed clone;
//!   3. [`copy`] — the uncommitted state, staged on the server;
//!   4. [`worktree`] — the worktree, with the staged state laid over it (all or nothing);
//!   5. the conversation itself, started by the front once [`context_header`] is saved.
//!
//! `plan` holds every decision as a pure function, `scripts` the server-side shell, `stream`
//! the progress-reporting upload. This module runs this Mac's `git` only through
//! [`crate::git::snapshot`], and the server's only through its own scripts over SSH.

pub mod plan;
pub mod scripts;
pub mod stream;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::snapshot::{self, BundleOutcome};
use crate::store::MachineRecord;
use plan::{Choice, CopyWhy, SkipWhy};
use stream::{Cancel, SendError};

/// Largest bundle sent (the commits the server lacks).
pub const MAX_BUNDLE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Largest single file copied (untracked work, Claude's files, secrets); a larger one is
/// reported as not copied.
pub const MAX_COPIED_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// Most bytes of files copied in all; past it the rest is reported as not copied.
pub const MAX_COPIED_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// Most entries git may list as untracked or ignored before the copy refuses to guess.
const MAX_LISTED: usize = 20_000;
/// Most entries looked at inside wholly ignored folders, looking for Claude's files and
/// secrets; a folder still unread past it is reported as not scanned.
const MAX_WALKED: usize = 50_000;
/// Most "not copied" entries listed in the report (the rest are counted).
const REPORT_MAX: usize = 300;

/// A quick server round trip (facts, listings).
const T_QUICK: Duration = Duration::from_secs(45);
/// Storing the commits / creating the worktree: index-pack and a checkout can take minutes
/// on a large repository.
const T_HEAVY: Duration = Duration::from_secs(15 * 60);

// ---- What the steps report -------------------------------------------------------------

/// The server, as step 1 read it.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerFacts {
    pub os: String,
    pub user: String,
    pub home: String,
    pub host: String,
    /// `git --version`.
    pub git: String,
    /// Whether this Mac also aligned the server (its daemon, its Claude Code) or only checked
    /// the link — see [`align_hook`].
    pub aligned: bool,
}

/// The repository on this Mac, as the transfer took it.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    pub repo_path: String,
    pub commit: String,
    pub branch: Option<String>,
    pub subject: String,
    /// `origin`, redacted (no credentials).
    pub origin: Option<String>,
    pub unpushed: Option<u32>,
    pub submodules: bool,
    /// This Mac's name, as the user knows it.
    pub mac_name: String,
    /// What a clone of a repository without origin is recognized by.
    pub source: String,
}

/// Step 2's result.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    pub local: LocalState,
    /// The managed clone on the server.
    pub clone: String,
    /// Made by this transfer (else reused).
    pub created: bool,
    /// Bytes of commits sent; 0 when the clone already had them all.
    pub bundle_bytes: u64,
}

/// One file copied.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopiedFile {
    pub path: String,
    pub bytes: u64,
    pub why: CopyWhy,
}

/// One entry not copied (a folder ends in `/`).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub path: String,
    pub why: SkipWhy,
}

/// Step 3's result: what the uncommitted state is made of, and what stays behind.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutcome {
    /// Files with staged changes.
    pub staged: u32,
    /// Files with unstaged changes.
    pub unstaged: u32,
    pub copied: Vec<CopiedFile>,
    pub skipped: Vec<SkippedEntry>,
    /// Entries not copied beyond those listed.
    pub skipped_more: u32,
    /// Bytes sent to the server for this step.
    pub bytes: u64,
    /// The archive staged on the server; `None` when there was nothing uncommitted at all.
    pub stage: Option<String>,
}

/// Step 4's result.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOutcome {
    pub worktree: String,
    /// The branch it is on (`None` = detached, like the Mac).
    pub branch: Option<String>,
    /// That branch was created by this launch (so abandoning it removes it).
    pub created_branch: bool,
}

/// Progress of an upload, for the front.
pub type Progress<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// How to reach the server for a step.
pub struct Ctx<'a> {
    pub machine: &'a MachineRecord,
    pub known_hosts: Option<&'a str>,
    /// Test seam: a directory holding a fake `ssh`.
    pub ssh_bin: Option<&'a Path>,
}

impl Ctx<'_> {
    fn name(&self) -> String {
        crate::remote_files::server_name(self.machine)
    }

    /// Run `script` with `sh -s` on the server and return its tagged answer lines with the
    /// value of its final `ok`. Every failure is a sentence naming the server.
    async fn run(&self, what: &str, script: &str, timeout: Duration) -> Result<(String, String), String> {
        let out = crate::ipc::commands::run_ssh_on_machine_stdin(
            self.machine,
            self.known_hosts,
            "sh -s",
            script.as_bytes(),
            self.ssh_bin,
            timeout,
        )
        .await
        .map_err(|e| self.failed(what, &e))?;
        let lines = scripts::tagged(&out.stdout);
        let value = scripts::outcome(&lines, || no_answer(out.exit_code, &out.stderr))
            .map_err(|e| self.failed(what, &e))?
            .to_string();
        Ok((out.stdout, value))
    }

    fn failed(&self, what: &str, why: &str) -> String {
        self.failed_at(what, "on", why)
    }

    /// `Couldn't <what> <preposition> <server>: <why>.` — "on" for work done there, "to" for
    /// what is sent.
    fn failed_at(&self, what: &str, preposition: &str, why: &str) -> String {
        let why = if why.contains("timed out") {
            format!("{} stopped answering", self.name())
        } else {
            why.trim_end_matches('.').to_string()
        };
        format!("Couldn't {what} {preposition} {}: {why}.", self.name())
    }

    /// Send `local` to the server's launch folder as `file_name`; its path there.
    async fn send(
        &self,
        what: &str,
        launch_id: &str,
        file_name: &str,
        local: &Path,
        progress: Progress<'_>,
        cancel: &Cancel,
    ) -> Result<String, String> {
        let size = std::fs::metadata(local).map_err(|e| format!("Couldn't read {}: {e}.", local.display()))?.len();
        let cmd = scripts::upload_command(launch_id, file_name, size);
        let ans = stream::send_file(self.machine, self.known_hosts, &cmd, local, size, progress, cancel, self.ssh_bin)
            .await
            .map_err(|e| match e {
                SendError::Cancelled => "Cancelled.".to_string(),
                e => self.failed_at(what, "to", &e.to_string()),
            })?;
        let lines = scripts::tagged(&ans.stdout);
        let path = scripts::outcome(&lines, || no_answer(ans.exit_code, &ans.stderr))
            .map_err(|e| self.failed_at(what, "to", &e))?;
        if !path.starts_with('/') {
            return Err(self.failed_at(what, "to", "the server did not say where the file went"));
        }
        Ok(path.to_string())
    }
}

/// What to say when a script never answered: ssh's own failure, classified when it can be,
/// else the last thing it wrote.
fn no_answer(exit_code: Option<i32>, stderr: &str) -> String {
    let lines: Vec<String> = stderr.lines().map(str::to_string).collect();
    match crate::ssh_link::classify_transport_close(exit_code, &lines) {
        Some(issue) => crate::ssh_link::describe_with_detail(issue, &lines),
        None => lines
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .map(|l| crate::remote_files::sanitize(l))
            .unwrap_or_else(|| "the server gave no answer".to_string()),
    }
}

fn git_err(e: impl std::fmt::Display) -> String {
    format!("git on this {}: {e}", crate::platform::MACHINE)
}

// ---- Step 1: the link, the server's facts, the alignment ---------------------------------

/// Align the server with this Mac before using it — the entry point task 763ae7f2 delivers
/// (`bootstrap::align::align_machine`).
///
/// HOOK (task 763ae7f2): until that lands on `dev`, the link check of [`check`] is all this
/// step does, and it says so (`ServerFacts::aligned = false`). Once it does, call it here and
/// return `Ok(true)` when it aligned.
async fn align_hook(_machine_id: &str) -> Result<bool, String> {
    Ok(false)
}

/// Step 1: reach the server and read what a launch needs from it. Refuses a server without
/// `git` or `tar` — say which, rather than fail three steps later.
pub async fn check(ctx: &Ctx<'_>) -> Result<ServerFacts, String> {
    let (out, _) = ctx.run("check the server", scripts::FACTS, T_QUICK).await?;
    let lines = scripts::tagged(&out);
    let get = |k: &str| {
        lines
            .iter()
            .find(|(kind, _)| *kind == k)
            .map(|(_, v)| crate::remote_files::sanitize(v))
    };
    let home = get("home").filter(|h| h.starts_with('/')).ok_or_else(|| {
        ctx.failed("check the server", "it did not say where its home folder is")
    })?;
    let git = get("git").ok_or_else(|| {
        format!("{} has no git — install it there (e.g. `sudo apt install git`), then retry.", ctx.name())
    })?;
    if get("tar").is_none() {
        return Err(format!("{} has no tar — install it there, then retry.", ctx.name()));
    }
    let aligned = align_hook(&ctx.machine.id).await?;
    Ok(ServerFacts {
        os: get("os").unwrap_or_default(),
        user: get("user").unwrap_or_default(),
        home,
        host: get("host").unwrap_or_default(),
        git,
        aligned,
    })
}

// ---- Step 2: the commits ---------------------------------------------------------------

/// The repository's state on this Mac — what the launch reproduces. Blocking (local git).
pub fn local_state(repo_path: &str) -> Result<LocalState, String> {
    let head = snapshot::head_state(repo_path).map_err(git_err)?;
    if snapshot::is_shallow(repo_path).map_err(git_err)? {
        return Err(
            "This repository is a shallow clone: its history stops where a transfer would have to start. \
             Fetch the full history first (`git fetch --unshallow`), then retry."
                .to_string(),
        );
    }
    let origin = match crate::git::remote_url(repo_path).map_err(git_err)? {
        crate::git::RemoteLookup::Url(u) => Some(crate::git::redact_remote_url(&u)),
        crate::git::RemoteLookup::NoRemote => None,
        crate::git::RemoteLookup::NotARepository => {
            return Err(format!("{repo_path} is not a git repository — only a repository can be moved to a server."))
        }
    };
    Ok(LocalState {
        repo_path: repo_path.to_string(),
        commit: head.commit,
        branch: head.branch,
        subject: head.subject,
        origin,
        unpushed: snapshot::unpushed_count(repo_path),
        submodules: snapshot::has_submodules(repo_path),
        mac_name: crate::platform::this_machine_name(),
        source: plan::source_marker(&crate::platform::this_host_name(), repo_path),
    })
}

/// Parse [`scripts::clone_state`]'s answer.
fn parse_clone_state(out: &str) -> plan::CloneState {
    let mut st = plan::CloneState::default();
    for (k, v) in scripts::tagged(out) {
        match k {
            "ref" => {
                if let Some((o, r)) = v.split_once(' ') {
                    st.refs.push((o.to_string(), r.to_string()));
                }
            }
            "checkedout" => st.checked_out.push(v.to_string()),
            "wtdir" => st.worktree_dirs.push(v.to_string()),
            _ => {}
        }
    }
    st
}

/// Step 2: put this repository's commits and refs into its managed clone on the server
/// (created when there is none), sending only the commits the clone lacks.
pub async fn transfer(
    ctx: &Ctx<'_>,
    launch_id: &str,
    repo_path: &str,
    tmp: &Path,
    progress: Progress<'_>,
    cancel: &Cancel,
) -> Result<TransferOutcome, String> {
    let rp = repo_path.to_string();
    let local = tokio::task::spawn_blocking(move || local_state(&rp))
        .await
        .map_err(|e| e.to_string())??;

    // Which clone.
    let (out, _) = ctx.run("list Flight Deck's clones", scripts::LIST_CLONES, T_QUICK).await?;
    let lines = scripts::tagged(&out);
    let base = lines
        .iter()
        .find(|(k, _)| *k == "base")
        .map(|(_, v)| v.to_string())
        .filter(|b| b.starts_with('/'))
        .ok_or_else(|| ctx.failed("list Flight Deck's clones", "it did not say where they live"))?;
    let taken: Vec<String> = lines.iter().filter(|(k, _)| *k == "name").map(|(_, v)| v.to_string()).collect();
    let clones: Vec<plan::ServerClone> = lines
        .iter()
        .filter(|(k, _)| *k == "clone")
        .filter_map(|(_, v)| {
            let mut f = v.splitn(3, '\t');
            let path = f.next()?.to_string();
            let origin = f.next().map(str::to_string).filter(|s| !s.is_empty());
            let source = f.next().map(str::to_string).filter(|s| !s.is_empty());
            Some(plan::ServerClone { path, origin, source })
        })
        .collect();
    let picked = plan::pick_clone(&clones, local.origin.as_deref(), &local.source).cloned();
    let (clone, created) = match picked {
        Some(c) => (c.path, false),
        None => (
            format!("{base}/{}", plan::new_clone_name(local.origin.as_deref(), repo_path, &taken)),
            true,
        ),
    };

    // What it already has.
    let server_refs = if created {
        Vec::new()
    } else {
        let (out, _) = ctx.run("read the clone", &scripts::clone_state(&clone), T_QUICK).await?;
        parse_clone_state(&out).refs
    };

    // The commits it lacks, bundled on this Mac.
    let bundle = tmp.join("repo.bundle");
    let (rp, b, sr) = (repo_path.to_string(), bundle.clone(), server_refs.clone());
    let (mac_refs, outcome) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let mac_refs = snapshot::transfer_refs(&rp).map_err(git_err)?;
        let oids: Vec<String> = sr.iter().map(|(o, _)| o.clone()).collect();
        let known = snapshot::known_objects(&rp, &oids).map_err(git_err)?;
        let basis = plan::bundle_basis(&sr, &known);
        let outcome = snapshot::create_bundle(&rp, &b, &basis).map_err(git_err)?;
        Ok((mac_refs, outcome))
    })
    .await
    .map_err(|e| e.to_string())??;
    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&bundle);
        return Err("Cancelled.".to_string());
    }
    let (remote_bundle, bundle_bytes) = match outcome {
        BundleOutcome::NothingNew => (None, 0),
        BundleOutcome::Written(n) if n > MAX_BUNDLE_BYTES => {
            let _ = std::fs::remove_file(&bundle);
            return Err(format!(
                "The commits to send weigh {:.1} GiB — more than the {} GiB a transfer takes.",
                n as f64 / (1024.0 * 1024.0 * 1024.0),
                MAX_BUNDLE_BYTES / (1024 * 1024 * 1024)
            ));
        }
        BundleOutcome::Written(n) => {
            let sent = ctx.send("send the commits", launch_id, "repo.bundle", &bundle, progress, cancel).await;
            let _ = std::fs::remove_file(&bundle);
            (Some(sent?), n)
        }
    };

    let updates = plan::ref_updates(&mac_refs, &local.commit, &server_refs);
    let script = scripts::apply_repo(&scripts::ApplyRepo {
        clone: &clone,
        create: created,
        bundle: remote_bundle.as_deref(),
        origin: local.origin.as_deref(),
        source: &local.source,
        head: &local.commit,
        ref_updates: &updates,
    });
    ctx.run("store the commits in the clone", &script, T_HEAVY).await?;
    Ok(TransferOutcome { local, clone, created, bundle_bytes })
}

// ---- Step 3: the uncommitted state -------------------------------------------------------

/// What [`select_files`] decided.
#[derive(Debug, Default)]
struct Selection {
    copy: Vec<(String, u64, CopyWhy)>,
    skipped: Vec<SkippedEntry>,
}

/// Walk a wholly ignored folder (no symbolic link followed), adding the files of ours it
/// holds and reporting what it does not. `budget` counts entries looked at.
fn walk_ignored(root: &Path, rel_dir: &str, budget: &mut usize, sel: &mut Selection) {
    let mut stack = vec![rel_dir.trim_end_matches('/').to_string()];
    let mut found_any = false;
    let mut skipped_here: Vec<SkippedEntry> = Vec::new();
    while let Some(dir) = stack.pop() {
        if *budget == 0 {
            sel.skipped.push(SkippedEntry { path: format!("{dir}/"), why: SkipWhy::Unscanned });
            continue;
        }
        let Ok(rd) = std::fs::read_dir(root.join(&dir)) else {
            skipped_here.push(SkippedEntry { path: format!("{dir}/"), why: SkipWhy::NotAFile });
            continue;
        };
        for entry in rd.flatten() {
            if *budget == 0 {
                sel.skipped.push(SkippedEntry { path: format!("{dir}/"), why: SkipWhy::Unscanned });
                break;
            }
            *budget -= 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = format!("{dir}/{name}");
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                match plan::ignored_dir_is_walked(&rel) {
                    Ok(()) => stack.push(rel),
                    Err(why) => skipped_here.push(SkippedEntry { path: format!("{rel}/"), why }),
                }
                continue;
            }
            match plan::choose_ignored_file(&rel) {
                Choice::Copy(why) => {
                    found_any = true;
                    sel.copy.push((rel, 0, why));
                }
                Choice::Skip(why) => skipped_here.push(SkippedEntry { path: rel, why }),
            }
        }
    }
    if found_any {
        sel.skipped.extend(skipped_here);
    } else {
        // Nothing of ours in it: the folder is reported once, not file by file.
        sel.skipped.push(SkippedEntry { path: format!("{}/", rel_dir.trim_end_matches('/')), why: SkipWhy::Ignored });
    }
}

/// Decide every untracked and ignored entry, then size the copies (and enforce the bounds).
/// Blocking (git, the filesystem).
fn select_files(repo: &str) -> Result<Selection, String> {
    let root = Path::new(repo);
    let untracked = snapshot::untracked_files(repo).map_err(git_err)?;
    let ignored = snapshot::ignored_entries(repo).map_err(git_err)?;
    if untracked.len() + ignored.len() > MAX_LISTED {
        return Err(format!(
            "git lists {} untracked or ignored entries here — more than a launch looks through ({MAX_LISTED}). \
             Ignore the generated folders (`.gitignore`), then retry.",
            untracked.len() + ignored.len()
        ));
    }
    let mut sel = Selection::default();
    let mut budget = MAX_WALKED;
    for p in &untracked {
        match plan::choose_untracked(p) {
            Choice::Copy(why) => sel.copy.push((p.clone(), 0, why)),
            Choice::Skip(why) => sel.skipped.push(SkippedEntry { path: p.clone(), why }),
        }
    }
    for p in &ignored {
        if p.ends_with('/') {
            match plan::ignored_dir_is_walked(p) {
                Ok(()) => walk_ignored(root, p, &mut budget, &mut sel),
                Err(why) => sel.skipped.push(SkippedEntry { path: p.clone(), why }),
            }
        } else {
            match plan::choose_ignored_file(p) {
                Choice::Copy(why) => sel.copy.push((p.clone(), 0, why)),
                Choice::Skip(why) => sel.skipped.push(SkippedEntry { path: p.clone(), why }),
            }
        }
    }
    // Size each copy; keep regular files and symbolic links within the bounds.
    sel.copy.sort_by(|a, b| a.0.cmp(&b.0));
    let mut total = 0u64;
    let mut kept = Vec::with_capacity(sel.copy.len());
    for (p, _, why) in std::mem::take(&mut sel.copy) {
        if !plan::is_safe_relative_path(&p) {
            sel.skipped.push(SkippedEntry { path: p, why: SkipWhy::NotAFile });
            continue;
        }
        let meta = match std::fs::symlink_metadata(root.join(&p)) {
            Ok(m) => m,
            Err(_) => {
                sel.skipped.push(SkippedEntry { path: p, why: SkipWhy::NotAFile });
                continue;
            }
        };
        let ft = meta.file_type();
        if !(ft.is_file() || ft.is_symlink()) {
            sel.skipped.push(SkippedEntry { path: p, why: SkipWhy::NotAFile });
            continue;
        }
        let len = if ft.is_file() { meta.len() } else { 0 };
        if len > MAX_COPIED_FILE_BYTES {
            sel.skipped.push(SkippedEntry { path: p, why: SkipWhy::TooLarge });
            continue;
        }
        if total + len > MAX_COPIED_TOTAL_BYTES {
            sel.skipped.push(SkippedEntry { path: p, why: SkipWhy::OverBudget });
            continue;
        }
        total += len;
        kept.push((p, len, why));
    }
    sel.copy = kept;
    sel.skipped.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(sel)
}

/// Pack `paths` (relative to `root`) into a tar at `out`; symbolic links stay links.
fn pack_files(root: &Path, paths: &[String], out: &Path) -> Result<(), String> {
    let f = std::fs::File::create(out).map_err(|e| format!("Couldn't write {}: {e}", out.display()))?;
    let mut b = tar::Builder::new(f);
    b.follow_symlinks(false);
    for p in paths {
        b.append_path_with_name(root.join(p), p)
            .map_err(|e| format!("Couldn't pack {p}: {e}"))?;
    }
    b.into_inner()
        .and_then(|mut f| std::io::Write::flush(&mut f))
        .map_err(|e| format!("Couldn't write {}: {e}", out.display()))
}

/// The local half of step 3: the repository must still be where the transfer took it; then
/// the patches, the file selection, and the archive that carries them. `None` = nothing
/// uncommitted at all.
fn stage_locally(local: &LocalState, tmp: &Path) -> Result<(Option<PathBuf>, CopyOutcome), String> {
    let repo = local.repo_path.as_str();
    let now = snapshot::head_state(repo).map_err(git_err)?;
    if now.commit != local.commit || now.branch != local.branch {
        return Err(format!(
            "The repository moved on since its commits were sent (now {}{}). Cancel and start the launch again \
             to take its new state.",
            now.branch.as_deref().map(|b| format!("on {b} at ")).unwrap_or_default(),
            &now.commit[..now.commit.len().min(12)]
        ));
    }
    let index = snapshot::diff_patch(repo, true).map_err(git_err)?;
    let worktree = snapshot::diff_patch(repo, false).map_err(git_err)?;
    let staged = if index.is_empty() { 0 } else { snapshot::diff_file_count(repo, true).map_err(git_err)? };
    let unstaged = if worktree.is_empty() { 0 } else { snapshot::diff_file_count(repo, false).map_err(git_err)? };
    let sel = select_files(repo)?;
    let mut skipped = sel.skipped;
    let skipped_more = skipped.len().saturating_sub(REPORT_MAX) as u32;
    skipped.truncate(REPORT_MAX);
    let copied: Vec<CopiedFile> =
        sel.copy.iter().map(|(p, n, why)| CopiedFile { path: p.clone(), bytes: *n, why: *why }).collect();
    let report = CopyOutcome { staged, unstaged, copied, skipped, skipped_more, bytes: 0, stage: None };
    if index.is_empty() && worktree.is_empty() && sel.copy.is_empty() {
        return Ok((None, report));
    }
    let files_tar = tmp.join("files.tar");
    let paths: Vec<String> = sel.copy.iter().map(|(p, _, _)| p.clone()).collect();
    if !paths.is_empty() {
        pack_files(Path::new(repo), &paths, &files_tar)?;
    }
    let stage = tmp.join("stage.tar");
    let f = std::fs::File::create(&stage).map_err(|e| format!("Couldn't write {}: {e}", stage.display()))?;
    let mut b = tar::Builder::new(f);
    let mut add_bytes = |name: &str, bytes: &[u8]| -> Result<(), String> {
        let mut h = tar::Header::new_gnu();
        h.set_size(bytes.len() as u64);
        h.set_mode(0o600);
        h.set_cksum();
        b.append_data(&mut h, name, bytes).map_err(|e| format!("Couldn't pack {name}: {e}"))
    };
    if !index.is_empty() {
        add_bytes("index.patch", &index)?;
    }
    if !worktree.is_empty() {
        add_bytes("worktree.patch", &worktree)?;
    }
    if !paths.is_empty() {
        b.append_path_with_name(&files_tar, "files.tar").map_err(|e| format!("Couldn't pack the files: {e}"))?;
    }
    b.into_inner()
        .and_then(|mut f| std::io::Write::flush(&mut f))
        .map_err(|e| format!("Couldn't write {}: {e}", stage.display()))?;
    let _ = std::fs::remove_file(&files_tar);
    Ok((Some(stage), report))
}

/// Step 3: send the uncommitted state — staged and unstaged changes, the files git does not
/// track that the conversation needs — to the server, staged there for step 4.
pub async fn copy(
    ctx: &Ctx<'_>,
    launch_id: &str,
    local: &LocalState,
    tmp: &Path,
    progress: Progress<'_>,
    cancel: &Cancel,
) -> Result<CopyOutcome, String> {
    let (l, t) = (local.clone(), tmp.to_path_buf());
    let (stage, mut report) = tokio::task::spawn_blocking(move || stage_locally(&l, &t))
        .await
        .map_err(|e| e.to_string())??;
    let Some(stage) = stage else {
        return Ok(report);
    };
    let sent = ctx.send("send the uncommitted changes", launch_id, "stage.tar", &stage, progress, cancel).await;
    report.bytes = std::fs::metadata(&stage).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&stage);
    report.stage = Some(sent?);
    Ok(report)
}

// ---- Step 4: the worktree ----------------------------------------------------------------

/// Step 4: create the worktree in the clone, at the transferred commit, on the Mac's branch
/// when that loses nothing (see [`plan::plan_branch`]), with the staged state laid over it.
pub async fn worktree(ctx: &Ctx<'_>, t: &TransferOutcome, stage: Option<&str>) -> Result<WorktreeOutcome, String> {
    let (out, _) = ctx.run("read the clone", &scripts::clone_state(&t.clone), T_QUICK).await?;
    let state = parse_clone_state(&out);
    let local = &t.local;
    // Is the server's branch of that name behind the commit? Only this Mac's history can
    // tell — an oid it does not know is server-side work.
    let tip = local.branch.as_deref().and_then(|b| {
        let r = format!("refs/heads/{b}");
        state.refs.iter().find(|(_, n)| *n == r).map(|(o, _)| o.clone())
    });
    let behind = match &tip {
        Some(tip) => {
            let (repo, tip, commit) = (local.repo_path.clone(), tip.clone(), local.commit.clone());
            tokio::task::spawn_blocking(move || -> Result<bool, String> {
                let known = snapshot::known_objects(&repo, std::slice::from_ref(&tip)).map_err(git_err)?;
                Ok(known.first().copied().unwrap_or(false)
                    && snapshot::is_ancestor(&repo, &tip, &commit).map_err(git_err)?)
            })
            .await
            .map_err(|e| e.to_string())??
        }
        None => false,
    };
    let branch = plan::plan_branch(local.branch.as_deref(), &local.commit, &state, |o| behind && tip.as_deref() == Some(o));
    let slug = plan::worktree_slug(local.branch.as_deref(), &local.commit, &state.worktree_dirs);
    let path = format!("{}/.claude/worktrees/{slug}", t.clone);
    let step = match &branch {
        plan::BranchPlan::Create { name } => scripts::BranchStep::Create { name },
        plan::BranchPlan::FastForward { name, old } => scripts::BranchStep::FastForward { name, old },
        plan::BranchPlan::Detached => scripts::BranchStep::Detached,
    };
    let script = scripts::create_worktree(&scripts::CreateWorktree {
        clone: &t.clone,
        worktree: &path,
        commit: &local.commit,
        branch: step,
        stage,
    });
    let (_, made) = ctx.run("create the worktree", &script, T_HEAVY).await?;
    Ok(WorktreeOutcome {
        worktree: if made.starts_with('/') { made } else { path },
        branch: branch.branch().map(str::to_string),
        created_branch: matches!(branch, plan::BranchPlan::Create { .. }),
    })
}

// ---- Step 5: what the conversation is told -------------------------------------------------

/// The context header of a launch that reached its worktree.
pub fn context_header(
    server: &str,
    facts: &ServerFacts,
    t: &TransferOutcome,
    c: &CopyOutcome,
    w: &WorktreeOutcome,
) -> String {
    let not_copied: Vec<String> = c
        .skipped
        .iter()
        .filter(|s| matches!(s.why, SkipWhy::Regenerable | SkipWhy::TooLarge | SkipWhy::OverBudget | SkipWhy::Unscanned))
        .map(|s| s.path.clone())
        .collect();
    plan::context_header(&plan::HeaderFacts {
        server: server.to_string(),
        server_os: facts.os.clone(),
        server_user: facts.user.clone(),
        worktree: w.worktree.clone(),
        clone: t.clone.clone(),
        mac: t.local.mac_name.clone(),
        mac_path: t.local.repo_path.clone(),
        commit: t.local.commit.clone(),
        subject: t.local.subject.clone(),
        mac_branch: t.local.branch.clone(),
        server_branch: w.branch.clone(),
        unpushed: t.local.unpushed,
        staged: c.staged,
        unstaged: c.unstaged,
        copied: c.copied.iter().map(|f| f.path.clone()).collect(),
        not_copied,
        submodules: t.local.submodules,
    })
}

// ---- Cleanup -----------------------------------------------------------------------------

/// Remove what a launch left on the server: its upload folder, and — when `discard` names
/// the worktree it made (the launch is abandoned) — that worktree and the branch it created.
pub async fn cleanup(ctx: &Ctx<'_>, launch_id: &str, discard: Option<(&str, &WorktreeOutcome)>) -> Result<(), String> {
    let discard = discard.map(|(clone, w)| {
        let created = if w.created_branch { w.branch.as_deref() } else { None };
        (clone, w.worktree.as_str(), created)
    });
    ctx.run("clean up", &scripts::cleanup(launch_id, discard), T_QUICK).await.map(|_| ())
}

// ---- The launches in flight --------------------------------------------------------------

/// One launch, as the front drives it step by step.
pub struct Launch {
    pub conversation_id: String,
    pub machine_id: String,
    pub repo_path: String,
    pub cancel: Arc<Cancel>,
    /// This launch's own scratch folder on this Mac (bundle, archives).
    pub tmp: PathBuf,
    pub facts: Option<ServerFacts>,
    pub transfer: Option<TransferOutcome>,
    pub copy: Option<CopyOutcome>,
    pub worktree: Option<WorktreeOutcome>,
}

/// Every launch in flight, by id.
pub static LAUNCHES: LazyLock<Mutex<HashMap<String, Launch>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A launch id the scripts can take as a folder name: a uuid.
pub fn is_launch_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

#[cfg(test)]
mod tests;
