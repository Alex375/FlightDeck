//! The decisions of a server launch, as pure functions: which files travel and which stay,
//! which server clone is this repository's, what the worktree and its branch are called, how
//! the clone's refs move, and what the conversation is told about where it runs. No process,
//! no filesystem, no network — everything here is unit-tested on plain values.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::git::normalize_remote_url;

// ---- Which files travel -----------------------------------------------------------------

/// Folders that are heavy and that a build or an install regenerates: never sent, wherever
/// they sit (a `.env` inside `node_modules` included).
pub const REGENERABLE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".gradle",
    "Pods",
    "DerivedData",
    ".terraform",
    "coverage",
];

/// Why a file is copied to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CopyWhy {
    /// Not tracked and not ignored: work that was never added.
    Untracked,
    /// Ignored, but Claude's own (`.claude/**`, `CLAUDE.local.md`, `.mcp.json`).
    Claude,
    /// Ignored, but a secret the project needs to run (`.env*`, keys, credentials).
    Secret,
}

/// Why something is NOT copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SkipWhy {
    /// A heavy folder a build or an install regenerates (`node_modules`, `target`…).
    Regenerable,
    /// Ignored by git and neither Claude's nor a secret (logs, editor settings…).
    Ignored,
    /// One file over [`super::MAX_COPIED_FILE_BYTES`].
    TooLarge,
    /// This Mac's own worktrees (`.claude/worktrees/`) — separate checkouts, not this one.
    Worktrees,
    /// Not a regular file or a symbolic link (a socket, a fifo), or unreadable.
    NotAFile,
    /// An ignored folder too large to look through within the budget: files of ours it may
    /// hold were not found.
    Unscanned,
    /// The copy reached its total budget before this file.
    OverBudget,
}

/// The verdict on one path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Choice {
    Copy(CopyWhy),
    Skip(SkipWhy),
}

fn components(path: &str) -> impl Iterator<Item = &str> {
    path.split('/').filter(|c| !c.is_empty())
}

/// `path` runs through a regenerable folder.
pub fn under_regenerable(path: &str) -> bool {
    components(path).any(|c| REGENERABLE_DIRS.contains(&c))
}

/// `path` is (inside) a `.claude/worktrees` folder, at any depth.
pub fn under_claude_worktrees(path: &str) -> bool {
    let parts: Vec<&str> = components(path).collect();
    parts.windows(2).any(|w| w[0] == ".claude" && w[1] == "worktrees")
}

/// Whether an IGNORED file is one the conversation needs anyway: Claude's own files, or a
/// secret the project reads at run time. Decided on the path alone.
pub fn claude_or_secret(path: &str) -> Option<CopyWhy> {
    let parts: Vec<&str> = components(path).collect();
    let name = *parts.last()?;
    if parts[..parts.len() - 1].contains(&".claude") {
        return Some(CopyWhy::Claude);
    }
    if matches!(name, "CLAUDE.local.md" | "CLAUDE.md" | ".mcp.json") {
        return Some(CopyWhy::Claude);
    }
    // A `secrets/` folder: everything in it.
    if parts[..parts.len() - 1].iter().any(|c| matches!(*c, "secrets" | ".secrets")) {
        return Some(CopyWhy::Secret);
    }
    is_secret_name(name).then_some(CopyWhy::Secret)
}

/// File names that hold secrets: dotenv files, keys and certificates' private halves,
/// credential files, package-registry tokens.
fn is_secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with(".env") {
        return true;
    }
    const NAMES: &[&str] = &[".npmrc", ".pypirc", ".netrc", ".dev.vars", "id_rsa", "id_ed25519", "id_ecdsa"];
    if NAMES.contains(&lower.as_str()) {
        return true;
    }
    const PREFIXES: &[&str] = &["secret", "credentials", "service-account", "service_account"];
    if PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    const EXTENSIONS: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".p8", ".jks", ".keystore", ".tfvars"];
    EXTENSIONS.iter().any(|e| lower.ends_with(e))
}

/// An untracked, NOT ignored file: copied, unless it sits in a regenerable folder (one that
/// is not ignored still regenerates) or in this Mac's worktrees.
pub fn choose_untracked(path: &str) -> Choice {
    if under_claude_worktrees(path) {
        Choice::Skip(SkipWhy::Worktrees)
    } else if under_regenerable(path) {
        Choice::Skip(SkipWhy::Regenerable)
    } else {
        Choice::Copy(CopyWhy::Untracked)
    }
}

/// An IGNORED file: copied only when it is Claude's or a secret, and not in a regenerable
/// folder or this Mac's worktrees.
pub fn choose_ignored_file(path: &str) -> Choice {
    if under_claude_worktrees(path) {
        return Choice::Skip(SkipWhy::Worktrees);
    }
    if under_regenerable(path) {
        return Choice::Skip(SkipWhy::Regenerable);
    }
    match claude_or_secret(path) {
        Some(why) => Choice::Copy(why),
        None => Choice::Skip(SkipWhy::Ignored),
    }
}

/// A wholly ignored FOLDER (git lists it once, `dir/`): looked through for files of ours,
/// unless it is regenerable or this Mac's worktrees — those are skipped whole, unread.
pub fn ignored_dir_is_walked(path: &str) -> Result<(), SkipWhy> {
    if under_claude_worktrees(path) {
        Err(SkipWhy::Worktrees)
    } else if under_regenerable(path) {
        Err(SkipWhy::Regenerable)
    } else {
        Ok(())
    }
}

/// A path git handed us, safe to put in an archive and extract under the worktree: relative,
/// no `.`/`..` component, no NUL, no backslash (a separator on no side, but a smell).
pub fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\0')
        && !path.contains('\\')
        && path.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

// ---- Which server clone -----------------------------------------------------------------

/// A clone Flight Deck manages on the server (`~/flightdeck/repos/<name>`, marked
/// `flightdeck.managed`), as the inspection reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerClone {
    pub path: String,
    /// Its `origin` url, if it has one.
    pub origin: Option<String>,
    /// The `flightdeck.source` marker it was created with: which folder of which machine.
    pub source: Option<String>,
}

/// The marker a clone of a repository WITHOUT an origin is recognized by: the machine and
/// the folder it came from.
pub fn source_marker(machine: &str, local_path: &str) -> String {
    format!("{machine}:{local_path}")
}

/// The server clone this repository goes into, if one exists. By origin, compared with
/// [`normalize_remote_url`] — never by name. A repository with no origin (or a clone
/// predating its origin) is recognized by its [`source_marker`] instead, and only on a clone
/// with no origin of its own: a clone of another repository never matches by marker.
pub fn pick_clone<'a>(clones: &'a [ServerClone], mac_origin: Option<&str>, source: &str) -> Option<&'a ServerClone> {
    if let Some(key) = mac_origin.and_then(normalize_remote_url) {
        if let Some(c) = clones
            .iter()
            .find(|c| c.origin.as_deref().and_then(normalize_remote_url).as_deref() == Some(key.as_str()))
        {
            return Some(c);
        }
    }
    clones
        .iter()
        .find(|c| c.origin.is_none() && c.source.as_deref() == Some(source))
}

/// A name for the repository, from its origin's last path segment (what it is called
/// upstream) else its folder's.
pub fn repo_name(origin: Option<&str>, local_path: &str) -> String {
    let from_origin = origin.and_then(|o| {
        let o = o.trim().trim_end_matches('/');
        let o = o.strip_suffix(".git").unwrap_or(o);
        o.rsplit(['/', ':']).next().map(str::to_string)
    });
    let from_path = local_path.trim_end_matches('/').rsplit('/').next().map(str::to_string);
    from_origin
        .filter(|s| !s.is_empty())
        .or(from_path)
        .unwrap_or_else(|| "repository".to_string())
}

/// `raw` as one path component the server scripts take as-is: `[A-Za-z0-9._-]`, anything
/// else `-`, no leading dot or dash, at most `max` characters, never empty.
pub fn safe_component(raw: &str, max: usize) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect();
    while s.starts_with(['.', '-']) {
        s.remove(0);
    }
    let s: String = s.chars().take(max).collect();
    let s = s.trim_end_matches(['.', '-']).to_string();
    if s.is_empty() {
        "repository".to_string()
    } else {
        s
    }
}

/// The first of `base`, `base-2`, `base-3`… not in `taken`.
pub fn first_free(base: &str, taken: &[String]) -> String {
    if !taken.iter().any(|t| t == base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !taken.iter().any(|t| t == c))
        .expect("an unbounded range always has a free name")
}

/// The folder name of a NEW clone under the managed base: the repository's name, made
/// unique among what the base already holds (managed or not — a name is never reused).
pub fn new_clone_name(origin: Option<&str>, local_path: &str, taken: &[String]) -> String {
    first_free(&safe_component(&repo_name(origin, local_path), 60), taken)
}

// ---- The worktree and its branch ---------------------------------------------------------

/// The worktree folder's name under `<clone>/.claude/worktrees/`: the branch's (slashes
/// dashed), or `detached-<sha7>`; unique among the folders already there.
pub fn worktree_slug(branch: Option<&str>, commit: &str, taken: &[String]) -> String {
    let base = match branch {
        Some(b) => safe_component(&b.replace('/', "-"), 50),
        None => format!("detached-{}", &commit[..commit.len().min(7)]),
    };
    first_free(&base, taken)
}

/// How the worktree's branch is set up on the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchPlan {
    /// A new branch at the commit (it does not exist there, or the Mac's name was taken).
    Create { name: String },
    /// The server's branch of that name, moved forward to the commit (`old` → commit): it
    /// holds nothing the commit does not, and no worktree has it checked out.
    FastForward { name: String, old: String },
    /// No branch: the Mac is on a detached HEAD.
    Detached,
}

impl BranchPlan {
    pub fn branch(&self) -> Option<&str> {
        match self {
            BranchPlan::Create { name } | BranchPlan::FastForward { name, .. } => Some(name),
            BranchPlan::Detached => None,
        }
    }
}

/// The server clone's state the branch decision reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloneState {
    /// `(oid, refname)` of every ref.
    pub refs: Vec<(String, String)>,
    /// Branches (`refs/heads/x`) checked out in some worktree of the clone.
    pub checked_out: Vec<String>,
    /// Folder names already under `.claude/worktrees/`.
    pub worktree_dirs: Vec<String>,
}

impl CloneState {
    fn head_oid(&self, branch: &str) -> Option<&str> {
        let r = format!("refs/heads/{branch}");
        self.refs.iter().find(|(_, n)| *n == r).map(|(o, _)| o.as_str())
    }
    fn is_checked_out(&self, branch: &str) -> bool {
        let r = format!("refs/heads/{branch}");
        self.checked_out.iter().any(|c| *c == r)
    }
}

/// Which branch the worktree gets. The Mac's own name when that loses nothing: the server
/// has no such branch, or has it behind the commit and checked out nowhere (`is_behind`
/// answers "is this oid an ancestor of the commit", from THIS Mac's history — an oid the Mac
/// does not know is server-side work, so not behind). Otherwise a fresh `<name>-2`, `-3`…:
/// a branch holding work of its own on the server is never moved, and one a worktree has
/// checked out is never shared.
pub fn plan_branch(
    mac_branch: Option<&str>,
    commit: &str,
    state: &CloneState,
    is_behind: impl Fn(&str) -> bool,
) -> BranchPlan {
    let Some(b) = mac_branch else {
        return BranchPlan::Detached;
    };
    match state.head_oid(b) {
        None => return BranchPlan::Create { name: b.to_string() },
        Some(old) if !state.is_checked_out(b) && (old == commit || is_behind(old)) => {
            return BranchPlan::FastForward { name: b.to_string(), old: old.to_string() };
        }
        Some(_) => {}
    }
    let taken: Vec<String> = state
        .refs
        .iter()
        .filter_map(|(_, r)| r.strip_prefix("refs/heads/").map(str::to_string))
        .collect();
    BranchPlan::Create { name: first_free(b, &taken) }
}

// ---- How the clone's refs move ----------------------------------------------------------

/// Where this Mac's local branches land in the server clone: a namespace of its own, so a
/// transfer never moves a branch the server works on (the worktree's branch is set up apart,
/// see [`plan_branch`]).
pub const MAC_HEADS_NS: &str = "refs/flightdeck/mac/heads/";
/// This Mac's HEAD commit at the last transfer (kept reachable when it is detached).
pub const MAC_HEAD_REF: &str = "refs/flightdeck/mac/HEAD";

/// The `git update-ref --stdin` commands that bring the clone's view of this Mac up to date:
/// its local branches under [`MAC_HEADS_NS`], its `origin/*` as `origin/*` (what this Mac
/// last fetched — the server may not reach origin itself), its tags, its HEAD. Refs in those
/// two managed namespaces the Mac no longer has are deleted; a server tag is never deleted.
pub fn ref_updates(mac_refs: &[(String, String)], head: &str, server_refs: &[(String, String)]) -> Vec<String> {
    let mut wanted: Vec<(String, String)> = Vec::new();
    for (oid, name) in mac_refs {
        let target = if let Some(b) = name.strip_prefix("refs/heads/") {
            format!("{MAC_HEADS_NS}{b}")
        } else if name.starts_with("refs/remotes/origin/") || name.starts_with("refs/tags/") {
            name.clone()
        } else {
            continue;
        };
        wanted.push((target, oid.clone()));
    }
    wanted.push((MAC_HEAD_REF.to_string(), head.to_string()));
    let mut lines: Vec<String> = wanted.iter().map(|(r, o)| format!("update {r} {o}")).collect();
    for (_, name) in server_refs {
        let managed = name.starts_with(MAC_HEADS_NS) || name.starts_with("refs/remotes/origin/");
        if managed && name != MAC_HEAD_REF && !wanted.iter().any(|(r, _)| r == name) {
            lines.push(format!("delete {name}"));
        }
    }
    lines
}

/// The commits the server clone already has that this Mac knows too: what the bundle can
/// leave out. `known` answers, for each of the server's oids in order, whether this Mac has
/// it. Deduplicated.
pub fn bundle_basis(server_refs: &[(String, String)], known: &[bool]) -> Vec<String> {
    let mut basis: Vec<String> = Vec::new();
    for ((oid, _), k) in server_refs.iter().zip(known) {
        if *k && !basis.contains(oid) {
            basis.push(oid.clone());
        }
    }
    basis
}

// ---- What the conversation is told --------------------------------------------------------

/// Everything the context header states.
#[derive(Debug, Clone, Default)]
pub struct HeaderFacts {
    pub server: String,
    pub server_os: String,
    pub server_user: String,
    pub worktree: String,
    pub clone: String,
    pub mac: String,
    pub mac_path: String,
    pub commit: String,
    pub subject: String,
    /// The Mac's branch (`None` = detached HEAD).
    pub mac_branch: Option<String>,
    /// The branch the worktree is on, when it differs from the Mac's.
    pub server_branch: Option<String>,
    pub unpushed: Option<u32>,
    pub staged: u32,
    pub unstaged: u32,
    pub copied: Vec<String>,
    pub not_copied: Vec<String>,
    pub submodules: bool,
}

/// At most this many copied files are named in the header; the rest are counted.
const HEADER_MAX_FILES: usize = 40;

fn list_capped(items: &[String], max: usize) -> String {
    let mut s = items.iter().take(max).map(|p| format!("`{p}`")).collect::<Vec<_>>().join(", ");
    if items.len() > max {
        s.push_str(&format!(" and {} more", items.len() - max));
    }
    s
}

/// The text appended to this conversation's system prompt (`--append-system-prompt`): where
/// it runs, where its working tree came from, what was and was not brought along, and that
/// the environment may need adapting. Plain prose; never starts with `-` (the daemon reads a
/// flag's value as the next token unless it starts with one).
pub fn context_header(f: &HeaderFacts) -> String {
    let mut out = String::new();
    out.push_str("# Where this conversation runs\n\n");
    out.push_str(&format!(
        "This conversation runs on the server \"{}\" ({}, user `{}`), in `{}` — not on the {} it was started from. \
         Every path, command and tool you use is on that server.\n\n",
        f.server, f.server_os, f.server_user, f.worktree, crate::platform::MACHINE
    ));
    let branch = match &f.mac_branch {
        Some(b) => format!("on branch `{b}`"),
        None => "on a detached HEAD".to_string(),
    };
    out.push_str(&format!(
        "Its working tree was transferred over SSH from the {} \"{}\" (`{}`), {branch} at commit `{}` (\"{}\")",
        crate::platform::MACHINE,
        f.mac,
        f.mac_path,
        &f.commit[..f.commit.len().min(12)],
        // A backslash is the one character a fish login shell reads inside the single quotes
        // the header travels in to the server; a commit subject is the one place one may sit.
        f.subject.replace('\\', "/")
    ));
    match f.unpushed {
        Some(0) | None => out.push_str(".\n"),
        Some(n) => out.push_str(&format!(", {n} commit(s) of which were not pushed to origin yet.\n")),
    }
    if let (Some(sb), Some(mb)) = (&f.server_branch, &f.mac_branch) {
        if sb != mb {
            out.push_str(&format!(
                "The server already had a branch `{mb}` carrying other work, so this worktree is on a new branch `{sb}`.\n"
            ));
        }
    }
    out.push_str(&format!(
        "- It is a git worktree of the clone `{}`, which Flight Deck manages on this server. The {}'s local branches are under \
         `refs/flightdeck/mac/heads/*`; `origin/*` is what the {} last fetched — this server may not be able to reach origin.\n",
        f.clone,
        crate::platform::MACHINE,
        crate::platform::MACHINE
    ));
    if f.staged + f.unstaged > 0 {
        out.push_str(&format!(
            "- The {}'s uncommitted changes were applied: {} staged file(s) (staged here too), {} with unstaged changes.\n",
            crate::platform::MACHINE,
            f.staged,
            f.unstaged
        ));
    }
    if !f.copied.is_empty() {
        out.push_str(&format!(
            "- Files git does not track were copied (untracked work, Claude's files, secrets such as `.env`): {}.\n",
            list_capped(&f.copied, HEADER_MAX_FILES)
        ));
    }
    if !f.not_copied.is_empty() {
        out.push_str(&format!("- Not copied: {}.\n", list_capped(&f.not_copied, HEADER_MAX_FILES)));
    }
    if f.submodules {
        out.push_str("- The repository's submodules were NOT transferred.\n");
    }
    out.push_str(&format!(
        "\nThe development environment here may not match the {}'s: dependencies not installed (`node_modules`, `target`, \
         virtualenvs…), different tool versions, absolute paths that pointed into the {}. Adapt it freely — install, build, \
         fix paths — whenever the task needs it. Nothing on the {} is reachable from here.\n",
        crate::platform::MACHINE,
        crate::platform::MACHINE,
        crate::platform::MACHINE
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_work_is_copied_but_never_from_a_regenerable_folder() {
        assert_eq!(choose_untracked("src/new.rs"), Choice::Copy(CopyWhy::Untracked));
        assert_eq!(choose_untracked("notes/plan.md"), Choice::Copy(CopyWhy::Untracked));
        assert_eq!(choose_untracked("web/node_modules/x/index.js"), Choice::Skip(SkipWhy::Regenerable));
        assert_eq!(choose_untracked("target/debug/app"), Choice::Skip(SkipWhy::Regenerable));
        assert_eq!(choose_untracked(".claude/worktrees/feat/a.rs"), Choice::Skip(SkipWhy::Worktrees));
    }

    #[test]
    fn ignored_claude_files_and_secrets_are_copied() {
        for p in [
            ".claude/settings.local.json",
            ".claude/skills/deploy/SKILL.md",
            "packages/api/.claude/agents/x.md",
            "CLAUDE.local.md",
            "sub/CLAUDE.local.md",
            ".mcp.json",
        ] {
            assert_eq!(choose_ignored_file(p), Choice::Copy(CopyWhy::Claude), "{p}");
        }
        for p in [
            ".env",
            ".env.local",
            "api/.env.production",
            ".envrc",
            "config/master.key",
            "certs/server.pem",
            "secrets/db.yaml",
            "credentials.json",
            "service-account-prod.json",
            ".npmrc",
            "infra/prod.tfvars",
            ".dev.vars",
        ] {
            assert_eq!(choose_ignored_file(p), Choice::Copy(CopyWhy::Secret), "{p}");
        }
    }

    #[test]
    fn other_ignored_files_regenerable_ones_and_worktrees_stay() {
        assert_eq!(choose_ignored_file("debug.log"), Choice::Skip(SkipWhy::Ignored));
        assert_eq!(choose_ignored_file(".idea/workspace.xml"), Choice::Skip(SkipWhy::Ignored));
        assert_eq!(choose_ignored_file(".DS_Store"), Choice::Skip(SkipWhy::Ignored));
        // A secret's name inside a regenerable folder is a dependency's file, not ours.
        assert_eq!(choose_ignored_file("node_modules/pkg/.env"), Choice::Skip(SkipWhy::Regenerable));
        assert_eq!(choose_ignored_file(".venv/lib/key.pem"), Choice::Skip(SkipWhy::Regenerable));
        // This Mac's worktrees are other checkouts, even though they live under `.claude/`.
        assert_eq!(choose_ignored_file(".claude/worktrees/x/.env"), Choice::Skip(SkipWhy::Worktrees));
        assert_eq!(ignored_dir_is_walked(".claude/worktrees/"), Err(SkipWhy::Worktrees));
        assert_eq!(ignored_dir_is_walked("node_modules/"), Err(SkipWhy::Regenerable));
        assert_eq!(ignored_dir_is_walked("web/dist/"), Err(SkipWhy::Regenerable));
        assert_eq!(ignored_dir_is_walked(".claude/"), Ok(()));
        assert_eq!(ignored_dir_is_walked("config/"), Ok(()));
    }

    #[test]
    fn archive_paths_must_stay_under_the_worktree() {
        assert!(is_safe_relative_path("a/b.txt"));
        assert!(is_safe_relative_path(".env"));
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\\b", "a\0b"] {
            assert!(!is_safe_relative_path(bad), "{bad:?}");
        }
    }

    fn clone(path: &str, origin: Option<&str>, source: Option<&str>) -> ServerClone {
        ServerClone { path: path.into(), origin: origin.map(Into::into), source: source.map(Into::into) }
    }

    #[test]
    fn the_clone_is_found_by_origin_in_any_notation_never_by_name() {
        let clones = [
            clone("/h/flightdeck/repos/FlightDeck", Some("git@github.com:Alex375/FlightDeck.git"), None),
            clone("/h/flightdeck/repos/other", Some("https://github.com/x/other"), None),
        ];
        let got = pick_clone(&clones, Some("https://user:tok@github.com/alex375/flightdeck"), "mac:/r");
        assert_eq!(got.map(|c| c.path.as_str()), Some("/h/flightdeck/repos/FlightDeck"));
        // Same folder NAME, different repository: no match.
        let named = [clone("/h/flightdeck/repos/FlightDeck", Some("https://github.com/someone/FlightDeck"), None)];
        assert_eq!(pick_clone(&named, Some("git@github.com:Alex375/FlightDeck.git"), "mac:/r"), None);
    }

    #[test]
    fn a_repository_without_origin_is_found_by_its_marker_only_on_an_origin_less_clone() {
        let marker = source_marker("Armand's Mac", "/Users/a/proj");
        let clones = [
            clone("/h/r/proj", Some("https://github.com/x/proj"), Some(&marker)),
            clone("/h/r/proj-2", None, Some(&marker)),
        ];
        assert_eq!(pick_clone(&clones, None, &marker).map(|c| c.path.as_str()), Some("/h/r/proj-2"));
        assert_eq!(pick_clone(&clones, None, "other:/x"), None);
    }

    #[test]
    fn new_clone_names_come_from_origin_and_never_collide() {
        assert_eq!(new_clone_name(Some("git@github.com:Alex375/FlightDeck.git"), "/Users/a/tosse-code", &[]), "FlightDeck");
        assert_eq!(new_clone_name(None, "/Users/a/my proj/", &[]), "my-proj");
        let taken = vec!["FlightDeck".to_string(), "FlightDeck-2".to_string()];
        assert_eq!(new_clone_name(Some("https://github.com/a/FlightDeck"), "/x", &taken), "FlightDeck-3");
        assert_eq!(new_clone_name(None, "/Users/a/..", &[]), "repository");
        assert_eq!(safe_component("../../etc", 60), "etc");
    }

    #[test]
    fn worktree_slugs_follow_the_branch() {
        assert_eq!(worktree_slug(Some("feat/run-on-server"), "abc", &[]), "feat-run-on-server");
        assert_eq!(
            worktree_slug(Some("dev"), "abc", &["dev".into()]),
            "dev-2"
        );
        assert_eq!(worktree_slug(None, "0123456789abcdef", &[]), "detached-0123456");
    }

    fn state(refs: &[(&str, &str)], checked_out: &[&str]) -> CloneState {
        CloneState {
            refs: refs.iter().map(|(o, r)| (o.to_string(), r.to_string())).collect(),
            checked_out: checked_out.iter().map(|s| s.to_string()).collect(),
            worktree_dirs: Vec::new(),
        }
    }

    #[test]
    fn the_macs_branch_name_is_kept_when_nothing_is_lost() {
        // Absent on the server.
        assert_eq!(plan_branch(Some("dev"), "c2", &state(&[], &[]), |_| false), BranchPlan::Create { name: "dev".into() });
        // Behind the commit, checked out nowhere: moved forward.
        let s = state(&[("c1", "refs/heads/dev")], &[]);
        assert_eq!(
            plan_branch(Some("dev"), "c2", &s, |o| o == "c1"),
            BranchPlan::FastForward { name: "dev".into(), old: "c1".into() }
        );
        // Already there.
        assert_eq!(
            plan_branch(Some("dev"), "c1", &s, |_| false),
            BranchPlan::FastForward { name: "dev".into(), old: "c1".into() }
        );
        assert_eq!(plan_branch(None, "c1", &s, |_| true), BranchPlan::Detached);
    }

    #[test]
    fn a_branch_with_server_work_or_checked_out_is_never_touched() {
        // Its tip is unknown to the Mac: server-side commits.
        let s = state(&[("s9", "refs/heads/dev"), ("x", "refs/heads/dev-2")], &[]);
        assert_eq!(plan_branch(Some("dev"), "c2", &s, |_| false), BranchPlan::Create { name: "dev-3".into() });
        // Behind, but another worktree has it checked out.
        let s = state(&[("c1", "refs/heads/dev")], &["refs/heads/dev"]);
        assert_eq!(plan_branch(Some("dev"), "c2", &s, |_| true), BranchPlan::Create { name: "dev-2".into() });
    }

    #[test]
    fn ref_updates_mirror_the_mac_and_prune_only_managed_namespaces() {
        let mac = vec![
            ("h1".to_string(), "refs/heads/dev".to_string()),
            ("h2".to_string(), "refs/heads/feat/x".to_string()),
            ("o1".to_string(), "refs/remotes/origin/dev".to_string()),
            ("t1".to_string(), "refs/tags/v1".to_string()),
        ];
        let server = vec![
            ("old".to_string(), "refs/flightdeck/mac/heads/gone".to_string()),
            ("o0".to_string(), "refs/remotes/origin/deleted".to_string()),
            ("w".to_string(), "refs/heads/server-work".to_string()),
            ("st".to_string(), "refs/tags/server-tag".to_string()),
            ("hh".to_string(), MAC_HEAD_REF.to_string()),
        ];
        let lines = ref_updates(&mac, "h1", &server);
        assert_eq!(
            lines,
            [
                "update refs/flightdeck/mac/heads/dev h1",
                "update refs/flightdeck/mac/heads/feat/x h2",
                "update refs/remotes/origin/dev o1",
                "update refs/tags/v1 t1",
                "update refs/flightdeck/mac/HEAD h1",
                "delete refs/flightdeck/mac/heads/gone",
                "delete refs/remotes/origin/deleted",
            ]
        );
    }

    #[test]
    fn the_bundle_basis_is_what_both_sides_have() {
        let server = vec![
            ("a".to_string(), "refs/heads/x".to_string()),
            ("b".to_string(), "refs/heads/y".to_string()),
            ("a".to_string(), "refs/heads/z".to_string()),
        ];
        assert_eq!(bundle_basis(&server, &[true, false, true]), ["a"]);
    }

    fn facts() -> HeaderFacts {
        HeaderFacts {
            server: "josty-CC".into(),
            server_os: "Linux".into(),
            server_user: "josty".into(),
            worktree: "/home/josty/flightdeck/repos/FlightDeck/.claude/worktrees/dev".into(),
            clone: "/home/josty/flightdeck/repos/FlightDeck".into(),
            mac: "Armand's MacBook".into(),
            mac_path: "/Users/armand/tosse-code".into(),
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
            subject: "fix things".into(),
            mac_branch: Some("dev".into()),
            server_branch: Some("dev".into()),
            unpushed: Some(2),
            staged: 1,
            unstaged: 3,
            copied: vec![".env".into(), ".claude/settings.local.json".into()],
            not_copied: vec!["node_modules/".into()],
            submodules: false,
        }
    }

    #[test]
    fn the_header_says_where_it_runs_and_what_came_along() {
        let h = context_header(&facts());
        assert!(!h.starts_with('-'));
        for needle in [
            "\"josty-CC\" (Linux, user `josty`)",
            "/home/josty/flightdeck/repos/FlightDeck/.claude/worktrees/dev",
            "\"Armand's MacBook\" (`/Users/armand/tosse-code`)",
            "on branch `dev` at commit `0123456789ab`",
            "2 commit(s) of which were not pushed",
            "1 staged file(s)",
            "`.env`, `.claude/settings.local.json`",
            "Not copied: `node_modules/`",
            "Adapt it freely",
        ] {
            assert!(h.contains(needle), "missing {needle:?} in:\n{h}");
        }
        assert!(!h.contains("new branch"), "{h}");
    }

    #[test]
    fn the_header_names_a_renamed_branch_and_caps_the_file_list() {
        let mut f = facts();
        f.server_branch = Some("dev-2".into());
        f.copied = (0..50).map(|i| format!("f{i}")).collect();
        f.unpushed = None;
        f.submodules = true;
        let h = context_header(&f);
        assert!(h.contains("new branch `dev-2`"), "{h}");
        assert!(h.contains("and 10 more"), "{h}");
        assert!(h.contains("submodules were NOT transferred"), "{h}");
        assert!(!h.contains("not pushed"), "{h}");
    }
}
