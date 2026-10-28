//! The `~/.claude` user config the server alignment ([`super::align`]) mirrors from this
//! Mac onto a paired server: settings, sub-agents, skills, commands, output styles, hooks
//! (and the scripts they run), plugins and their marketplaces, the global `CLAUDE.md`,
//! and the user-scope MCP servers. This Mac wins: what the server holds differently is
//! replaced, what it holds beyond it inside the mirrored trees is removed — after ONE
//! rotating backup of the server's previous config (`~/.flightdeckd/claude-config-backup.tar.gz`).
//!
//! NEVER copied, by construction (an allowlist, never a denylist over the whole tree):
//! credentials (`.credentials.json`, the Keychain, `oauthAccount`), transcripts
//! (`projects/`), history, caches and run state (`sessions/`, `shell-snapshots/`,
//! `file-history/`, `plugins/data/`…). `~/.claude.json` belongs to the CLI: only its
//! `mcpServers` are aligned, and only through the server's own CLI (`claude mcp add-json
//! --scope user`) — never by writing that file. An MCP server whose config carries
//! credentials (`env`, `headers`) is not passed on a command line other users of the
//! server can read: it is left as the server has it, and the report says so.
//!
//! Absolute paths into this Mac's home (`/Users/<me>/…`) are rewritten to the server's
//! home in every text file sent — `installed_plugins.json` and `known_marketplaces.json`
//! carry them, and so do permission rules and hook commands.
//!
//! Plugins travel as files, never as a reinstall by the server's CLI: the cache holds the
//! exact versions this Mac runs, and a private marketplace (no GitHub access on the
//! server — the `tosse-workflow` trap) installs nowhere else. The paths that need it are
//! rewritten, which is what made copying the cache unsafe without it.
//!
//! The work is split so that everything deciding WHAT happens is pure and tested here
//! ([`is_synced_path`], [`rewrite_home`], [`hook_script_paths`], [`plan_sync`],
//! [`plan_mcp`], [`parse_facts`]), and the scripts only move bytes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::ipc::commands::shq;

/// Trees under the home mirrored as a whole: a file the server holds there that this Mac
/// doesn't is removed.
pub(crate) const SYNCED_DIRS: &[&str] = &[
    ".claude/agents",
    ".claude/skills",
    ".claude/commands",
    ".claude/output-styles",
    ".claude/hooks",
    ".claude/plugins/marketplaces",
    ".claude/plugins/cache",
];

/// Single files mirrored (absent here → removed there).
pub(crate) const SYNCED_FILES: &[&str] = &[
    ".claude/settings.json",
    ".claude/CLAUDE.md",
    ".claude/keybindings.json",
    ".claude/plugins/installed_plugins.json",
    ".claude/plugins/known_marketplaces.json",
];

/// The name, at the archive's root, of the list of paths the apply script removes.
const DELETE_LIST: &str = ".fd-align-delete";

/// Bounds on what one alignment reads off this Mac: a tree past them is refused, saying
/// so, rather than shipping gigabytes over a phone tether.
const MAX_FILES: usize = 50_000;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// A hook script larger than this is not a script.
const MAX_EXTRA_BYTES: u64 = 1024 * 1024;

/// Never copied, wherever it sits.
fn is_excluded_name(name: &str) -> bool {
    matches!(name, ".credentials.json" | ".DS_Store") || name.ends_with(".sock")
}

/// A home-relative path, normalized: no absolute path, no `..`/`.` component, no empty
/// component, no leading `-` (it is a script argument on the server), no control byte.
fn is_clean_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.starts_with('-')
        && !rel.chars().any(|c| c.is_control())
        && rel.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// Whether `rel` (home-relative) is part of the mirrored config — inside one of
/// [`SYNCED_DIRS`] or one of [`SYNCED_FILES`], and never an excluded name.
pub(crate) fn is_synced_path(rel: &str) -> bool {
    if !is_clean_rel(rel) || rel.split('/').any(is_excluded_name) {
        return false;
    }
    SYNCED_FILES.contains(&rel) || SYNCED_DIRS.iter().any(|d| rel.strip_prefix(d).is_some_and(|r| r.starts_with('/')))
}

/// Whether a change to `rel` only takes effect in a NEW `claude` process. The marketplace
/// clones are catalogs: what runs is the plugin cache and `installed_plugins.json`, so a
/// marketplace refresh (which a server's own auto-update makes at its own pace) recycles
/// nobody.
pub(crate) fn needs_restart(rel: &str) -> bool {
    !(rel.starts_with(".claude/plugins/marketplaces/") || rel == ".claude/plugins/known_marketplaces.json")
}

/// `text` with every occurrence of the directory `from` — as a whole path prefix, never a
/// longer name that starts with it (`/Users/me2`) — replaced by `to`. `None` when nothing
/// changed.
pub(crate) fn rewrite_home(text: &str, from: &str, to: &str) -> Option<String> {
    let from = from.trim_end_matches('/');
    let to = to.trim_end_matches('/');
    if from.is_empty() || from == to || !text.contains(from) {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut changed = false;
    while let Some(i) = rest.find(from) {
        let after = &rest[i + from.len()..];
        let boundary = after.chars().next().is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '.')));
        out.push_str(&rest[..i]);
        if boundary {
            out.push_str(to);
            changed = true;
        } else {
            out.push_str(from);
        }
        rest = after;
    }
    out.push_str(rest);
    changed.then_some(out)
}

/// Programs that run the script named next on their command line.
const INTERPRETERS: &[&str] = &["sh", "bash", "zsh", "dash", "python", "python3", "node", "ruby", "perl", "deno", "bun"];

/// A home-relative path whose first component is a dotfile or dot-folder of the home
/// itself (`.zshrc`, `.config/…`, `.netrc`) — the user's shell and tool config, never a
/// hook's script to ship (`~/.claude/…` is the one exception).
fn is_home_dotfile(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or(rel);
    first.starts_with('.') && first != ".claude"
}

/// The home-relative paths of the scripts `settings`' hooks and status line run — what a
/// hook needs on the server besides its line in `settings.json`. Only the PROGRAM of each
/// command is read (its first word after any `VAR=value`, or the script an interpreter
/// is given — `bash ~/x.sh`), never its arguments: `source ~/.zshrc && …` or
/// `cat ~/.netrc` would otherwise ship a shell config or a credential. It must name a file
/// under the home (`~/…`, `$HOME/…`, `${HOME}/…`, or this Mac's home spelled out), never a
/// home dotfile. A word that only might be a path is harmless — only one naming an
/// existing file here is ever sent (see [`collect_local`]).
pub(crate) fn hook_script_paths(settings: &Value, mac_home: &str) -> Vec<String> {
    let mut commands: Vec<&str> = Vec::new();
    if let Some(events) = settings.get("hooks").and_then(Value::as_object) {
        for groups in events.values().filter_map(Value::as_array) {
            for hooks in groups.iter().filter_map(|g| g.get("hooks")).filter_map(Value::as_array) {
                commands.extend(hooks.iter().filter_map(|h| h.get("command")).filter_map(Value::as_str));
            }
        }
    }
    if let Some(c) = settings.pointer("/statusLine/command").and_then(Value::as_str) {
        commands.push(c);
    }
    let home = format!("{}/", mac_home.trim_end_matches('/'));
    let mut out = BTreeSet::new();
    for command in commands {
        for segment in command.split(|c: char| matches!(c, ';' | '&' | '|' | '\n' | '(' | ')' | '`')) {
            let words: Vec<&str> = segment
                .split_whitespace()
                .map(|w| w.trim_matches(|c| c == '"' || c == '\''))
                .filter(|w| !w.is_empty())
                .collect();
            // Past `VAR=value` assignments to the program; past an interpreter (and its
            // flags) to the script it runs.
            let Some(mut i) = words.iter().position(|w| !(w.contains('=') && !w.starts_with('/') && !w.starts_with('~')))
            else {
                continue;
            };
            let program_name = words[i].rsplit('/').next().unwrap_or(words[i]);
            if INTERPRETERS.contains(&program_name) {
                match words[i + 1..].iter().position(|w| !w.starts_with('-')) {
                    Some(j) => i += 1 + j,
                    None => continue,
                }
            }
            let word = words[i];
            let rel = ["~/", "$HOME/", "${HOME}/", home.as_str()].iter().find_map(|p| word.strip_prefix(p));
            if let Some(rel) = rel.filter(|r| is_clean_rel(r) && !is_home_dotfile(r)) {
                out.insert(rel.to_string());
            }
        }
    }
    out.into_iter().collect()
}

/// Extra files a hook needs that must never leave this Mac, whatever a command names:
/// keys and credential stores.
fn is_secret_extra(rel: &str) -> bool {
    const SECRET_PREFIXES: &[&str] = &[".ssh/", ".gnupg/", ".aws/", ".config/gcloud/", ".kube/", "Library/Keychains/"];
    rel == ".claude.json"
        || rel.starts_with(".claude/.credentials")
        || rel.split('/').any(is_excluded_name)
        || SECRET_PREFIXES.iter().any(|p| rel.starts_with(p))
}

/// One file of this Mac's config, as the server should hold it (paths rewritten).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalFile {
    /// Home-relative.
    pub rel: String,
    pub bytes: Vec<u8>,
    pub exec: bool,
    /// sha256 of `bytes`, lowercase hex (what `sha256sum` prints).
    pub sha: String,
}

impl LocalFile {
    fn new(rel: String, bytes: Vec<u8>, exec: bool) -> Self {
        let sha = hex_sha256(&bytes);
        Self { rel, bytes, exec, sha }
    }
}

/// This Mac's config, ready to compare with a server's.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct LocalConfig {
    /// Mirrored files and the hook scripts outside the mirrored trees, sorted by path.
    pub files: Vec<LocalFile>,
    /// The hook scripts' paths (a subset of `files`), which the server lists explicitly.
    pub extras: Vec<String>,
    /// User-scope MCP servers to hold, by name (paths rewritten).
    pub mcp: BTreeMap<String, Value>,
    /// User-scope MCP servers left as the server has them: they carry credentials.
    pub mcp_withheld: Vec<String>,
    /// `~/.claude.json` could not be read here: the MCP servers are left alone.
    pub mcp_unknown: Option<String>,
}

impl LocalConfig {
    /// A fingerprint of what this config would make the server hold — the alignment's
    /// freshness check compares it with the one its last pass applied.
    pub(crate) fn digest(&self) -> String {
        let mut h = Sha256::new();
        for f in &self.files {
            h.update(f.rel.as_bytes());
            h.update([0, u8::from(f.exec)]);
            h.update(f.sha.as_bytes());
            h.update(b"\n");
        }
        h.update(serde_json::to_string(&self.mcp).unwrap_or_default().as_bytes());
        h.update(self.mcp_withheld.join("\n").as_bytes());
        format!("{:x}", h.finalize())
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The bytes a file is sent as: a text file (valid UTF-8, no NUL) with this Mac's home
/// rewritten to the server's; anything else untouched.
fn as_sent(bytes: Vec<u8>, mac_home: &str, server_home: &str) -> Vec<u8> {
    if bytes.contains(&0) {
        return bytes;
    }
    match std::str::from_utf8(&bytes) {
        Ok(text) => rewrite_home(text, mac_home, server_home).map(String::into_bytes).unwrap_or(bytes),
        Err(_) => bytes,
    }
}

#[cfg(unix)]
fn is_exec(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
fn is_exec(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Reads this Mac's config under `mac_home`, as a server whose home is `server_home`
/// should hold it. Blocking (file IO) — call it off the async workers. `Err` names what
/// could not be read: a config read halfway is never sent (the server would lose the
/// rest of its files to the mirror's removals).
pub(crate) fn collect_local(mac_home: &Path, server_home: &str) -> Result<LocalConfig, String> {
    let mac_home_str = mac_home.to_string_lossy().into_owned();
    let mut files: Vec<LocalFile> = Vec::new();
    let mut total: u64 = 0;
    let mut add = |rel: String, path: &Path, exec: bool, files: &mut Vec<LocalFile>| -> Result<(), String> {
        let bytes = std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        total += bytes.len() as u64;
        if files.len() >= MAX_FILES || total > MAX_TOTAL_BYTES {
            return Err(format!(
                "this Mac's ~/.claude config is too large to send (over {MAX_FILES} files or {} MiB) — look for a large \
                 folder in its skills, plugins or hooks",
                MAX_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        files.push(LocalFile::new(rel, as_sent(bytes, &mac_home_str, server_home), exec));
        Ok(())
    };
    // A root that is ABSENT here is absent on the server too (the mirror). One that is
    // there but can't be read — a link to a moved repository or an unmounted volume, a
    // permission — is an error: read as "absent", it would plan the removal of the
    // server's whole copy of it.
    for rel in SYNCED_FILES {
        let path = mac_home.join(rel);
        match present(&path)? {
            Some(m) if m.is_file() => add(rel.to_string(), &path, is_exec(&m), &mut files)?,
            Some(_) => return Err(format!("{} on this Mac is not a file", path.display())),
            None => {}
        }
    }
    for dir in SYNCED_DIRS {
        let root = mac_home.join(dir);
        match present(&root)? {
            Some(m) if m.is_dir() => {}
            Some(_) => return Err(format!("{} on this Mac is not a folder", root.display())),
            None => continue,
        }
        // Symlinks followed (a skill linked in from a repository is a skill), loops refused
        // by walkdir itself.
        for entry in walkdir::WalkDir::new(&root).follow_links(true).sort_by_file_name() {
            let entry = entry.map_err(|e| format!("could not read this Mac's {dir}: {e}"))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(sub) = entry.path().strip_prefix(mac_home) else { continue };
            let rel = sub.to_string_lossy().replace('\\', "/");
            if !is_synced_path(&rel) {
                continue; // an excluded name, or a name no server script could carry safely
            }
            let meta = entry.metadata().map_err(|e| format!("could not read {}: {e}", entry.path().display()))?;
            add(rel, entry.path(), is_exec(&meta), &mut files)?;
        }
    }
    let settings: Value = files
        .iter()
        .find(|f| f.rel == ".claude/settings.json")
        .and_then(|f| serde_json::from_slice(&f.bytes).ok())
        .unwrap_or(Value::Null);
    let mut extras = Vec::new();
    // The settings were rewritten for the server already: a hook spelled with this Mac's
    // home now names the server's — read its words against the server's home.
    for rel in hook_script_paths(&settings, server_home) {
        if is_synced_path(&rel) || is_secret_extra(&rel) || files.iter().any(|f| f.rel == rel) {
            continue;
        }
        let path = mac_home.join(&rel);
        match std::fs::metadata(&path) {
            Ok(m) if m.is_file() && m.len() <= MAX_EXTRA_BYTES => {
                add(rel.clone(), &path, is_exec(&m), &mut files)?;
                extras.push(rel);
            }
            _ => {} // not a file here (a word that only looked like a path)
        }
    }
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    let (mcp, mcp_withheld, mcp_unknown) = match read_mac_mcp(mac_home) {
        Ok(servers) => {
            let mut keep = BTreeMap::new();
            let mut withheld = Vec::new();
            for (name, value) in servers {
                if carries_credentials(&value) {
                    withheld.push(name);
                } else {
                    let text = serde_json::to_string(&value).unwrap_or_default();
                    let value = rewrite_home(&text, &mac_home_str, server_home)
                        .and_then(|t| serde_json::from_str(&t).ok())
                        .unwrap_or(value);
                    keep.insert(name, value);
                }
            }
            (keep, withheld, None)
        }
        Err(e) => (BTreeMap::new(), Vec::new(), Some(e)),
    };
    Ok(LocalConfig { files, extras, mcp, mcp_withheld, mcp_unknown })
}

/// What `path` is, links followed — `None` when nothing is there at all; an `Err` when
/// something is there that can't be read (a dangling link included), never `None`.
fn present(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {} on this Mac: {e}", path.display())),
        Ok(m) if m.file_type().is_symlink() => std::fs::metadata(path).map(Some).map_err(|e| {
            format!("{} on this Mac is a link to something that can't be read ({e}) — fix or remove the link", path.display())
        }),
        Ok(m) => Ok(Some(m)),
    }
}

/// A cheap fingerprint of this Mac's config FILES — path, size and modification time of
/// every one [`collect_local`] would read (no content) — so a pass that is not due can be
/// told so without reading and hashing every plugin again. `None` when something can't be
/// listed (the caller then reads it all).
pub(crate) fn stat_key(mac_home: &Path) -> Option<String> {
    fn stamp(h: &mut Sha256, rel: &str, m: &std::fs::Metadata) {
        let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos());
        h.update(format!("{rel}\0{}\0{mtime:?}\0{}\n", m.len(), is_exec(m)).as_bytes());
    }
    let mut h = Sha256::new();
    for rel in SYNCED_FILES.iter().copied().chain([".claude.json"]) {
        if let Some(m) = present(&mac_home.join(rel)).ok()? {
            stamp(&mut h, rel, &m);
        }
    }
    for dir in SYNCED_DIRS {
        let root = mac_home.join(dir);
        if present(&root).ok()?.is_none() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&root).follow_links(true).sort_by_file_name() {
            let entry = entry.ok()?;
            if entry.file_type().is_file() {
                let rel = entry.path().strip_prefix(mac_home).ok()?.to_string_lossy().into_owned();
                stamp(&mut h, &rel, &entry.metadata().ok()?);
            }
        }
    }
    Some(format!("{:x}", h.finalize()))
}

/// This Mac's user-scope MCP servers (`~/.claude.json` → `mcpServers`). No file, or none
/// declared: an empty set — a server's own then go, as for any other mirrored config.
fn read_mac_mcp(mac_home: &Path) -> Result<BTreeMap<String, Value>, String> {
    let path = mac_home.join(".claude.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(format!("could not read this Mac's ~/.claude.json: {e}")),
    };
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("this Mac's ~/.claude.json is not valid JSON: {e}"))?;
    Ok(mcp_servers_of(&v))
}

fn mcp_servers_of(claude_json: &Value) -> BTreeMap<String, Value> {
    claude_json
        .get("mcpServers")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Whether a word reads like it names or holds a secret.
fn secretish(word: &str) -> bool {
    let w = word.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "AUTH", "BEARER"].iter().any(|m| w.contains(m))
}

/// Whether an MCP server's config carries what is likely a secret: a non-empty `env` or
/// `headers`, a URL with a query string or a user/password in it, or an argument that reads
/// like a key (`--api-key=…`, `token=…`). Such a config would sit, for a moment, on the
/// command line of the server's `claude mcp add-json` — readable by every user of that
/// server.
pub(crate) fn carries_credentials(server: &Value) -> bool {
    let non_empty = |k: &str| server.get(k).and_then(Value::as_object).is_some_and(|m| !m.is_empty());
    let url_secret = server
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|u| u.contains('?') || u.split("://").nth(1).is_some_and(|rest| rest.split('/').next().unwrap_or("").contains('@')));
    let arg_secret = server
        .get("args")
        .and_then(Value::as_array)
        .is_some_and(|args| args.iter().filter_map(Value::as_str).any(secretish));
    non_empty("env") || non_empty("headers") || url_secret || arg_secret
}

/// `settings.json` keys that choose how THIS machine authenticates or bills — an API-key
/// helper, a cloud provider's credential export, a forced login method. Copied, they would
/// silently move the server off the Claude login it was set up with (onto API billing, or
/// onto credentials it doesn't have): the server keeps its own.
const WITHHELD_SETTINGS: &[&str] =
    &["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "forceLoginMethod", "forceLoginOrgUUID"];

/// `env` entries of `settings.json` the server keeps its own of: anything that reads like a
/// secret (`ANTHROPIC_API_KEY`, `*_TOKEN`…) — a key leaves this Mac only by the user's
/// hand — and what picks the provider or endpoint the server's `claude` talks to.
fn is_withheld_env(key: &str) -> bool {
    const PROVIDER: &[&str] = &[
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_BEDROCK_BASE_URL",
        "ANTHROPIC_VERTEX_BASE_URL",
        "ANTHROPIC_VERTEX_PROJECT_ID",
    ];
    secretish(key) || PROVIDER.contains(&key) || ["AWS_", "GOOGLE_", "AZURE_", "GCLOUD_"].iter().any(|p| key.starts_with(p))
}

/// Pure: this Mac's `settings.json` as the server should hold it — without its withheld
/// keys ([`WITHHELD_SETTINGS`], the secret or provider `env` entries), with the SERVER's own
/// values for those put back (`server`: its current settings, `None` when it has none or
/// they don't parse). Returns `None` when nothing is withheld either way (the Mac's bytes
/// go as they are), else the new bytes and the names withheld from this Mac.
pub(crate) fn withhold_settings(mac: &[u8], server: Option<&Value>) -> Option<(Vec<u8>, Vec<String>)> {
    let Ok(Value::Object(mut ours)) = serde_json::from_slice::<Value>(mac) else { return None };
    let mut withheld = Vec::new();
    for key in WITHHELD_SETTINGS {
        if ours.remove(*key).is_some() {
            withheld.push(key.to_string());
        }
    }
    if let Some(Value::Object(env)) = ours.get_mut("env") {
        let drop: Vec<String> = env.keys().filter(|k| is_withheld_env(k)).cloned().collect();
        for k in drop {
            env.remove(&k);
            withheld.push(format!("env.{k}"));
        }
    }
    let mut kept_server = false;
    if let Some(Value::Object(theirs)) = server {
        for key in WITHHELD_SETTINGS {
            if let Some(v) = theirs.get(*key) {
                ours.insert(key.to_string(), v.clone());
                kept_server = true;
            }
        }
        if let Some(Value::Object(their_env)) = theirs.get("env") {
            for (k, v) in their_env.iter().filter(|(k, _)| is_withheld_env(k)) {
                let env = ours.entry("env").or_insert_with(|| Value::Object(Default::default()));
                if let Value::Object(env) = env {
                    env.insert(k.clone(), v.clone());
                    kept_server = true;
                }
            }
        }
    }
    if withheld.is_empty() && !kept_server {
        return None;
    }
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(ours)).ok()?;
    bytes.push(b'\n');
    Some((bytes, withheld))
}

/// Applies [`withhold_settings`] to `local`'s `settings.json`: the names withheld from this
/// Mac (for the report).
pub(crate) fn apply_withheld_settings(local: &mut LocalConfig, server: Option<&Value>) -> Vec<String> {
    let Some(f) = local.files.iter_mut().find(|f| f.rel == ".claude/settings.json") else { return Vec::new() };
    match withhold_settings(&f.bytes, server) {
        Some((bytes, withheld)) => {
            *f = LocalFile::new(f.rel.clone(), bytes, f.exec);
            withheld
        }
        None => Vec::new(),
    }
}

// ============================================================================
// The server's side
// ============================================================================

/// One file as the server holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteFile {
    pub sha: String,
    pub exec: bool,
}

/// What [`facts_script`] read on the server.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ServerConfigFacts {
    /// `$HOME` — what this Mac's home paths are rewritten to.
    pub home: Option<String>,
    /// `claude --version`'s first line (`None`: no working `claude`).
    pub claude_version: Option<String>,
    /// Every mirrored file and listed hook script the server holds, home-relative.
    pub manifest: HashMap<String, RemoteFile>,
    /// The server has neither `sha256sum` nor `shasum`: nothing can be compared.
    pub no_hasher: bool,
    /// Its user-scope MCP servers — `None` when `~/.claude.json` could not be read
    /// (`mcp_unreadable` says why). No file at all is an empty set.
    pub mcp: Option<BTreeMap<String, Value>>,
    pub mcp_unreadable: Option<String>,
    /// Its `~/.claude/settings.json`, parsed — where the keys it keeps its own of
    /// ([`withhold_settings`]) are read. `None`: none, or not JSON.
    pub settings: Option<Value>,
    /// The script ran to its end (a cut-short answer is never compared).
    pub complete: bool,
}

/// Every path the server lists: the mirrored roots, then `extras`.
fn listed_roots(extras: &[String]) -> Vec<String> {
    SYNCED_DIRS.iter().chain(SYNCED_FILES.iter()).map(|s| s.to_string()).chain(extras.iter().cloned()).collect()
}

/// How the scripts below are run: through `sh` (POSIX word splitting and globbing,
/// whatever the login shell — a Mac's is zsh), as the ssh user, from its home.
pub(crate) fn as_remote_command(script: &str) -> String {
    format!("sh -c {}", shq(script))
}

/// One round trip reading what the alignment compares: `$HOME`, `claude --version`, the
/// sha256 and exec bit of every file in the mirrored roots and of each listed hook script,
/// and `~/.claude.json` (base64 — the Mac reads its `mcpServers`). Nothing is written.
pub(crate) fn facts_script(extras: &[String]) -> String {
    let dirs: Vec<String> = SYNCED_DIRS.iter().map(|d| shq(d)).collect();
    let files: Vec<String> = SYNCED_FILES.iter().map(|f| shq(f)).chain(extras.iter().map(|e| shq(e))).collect();
    format!(
        r#"cd "$HOME" || {{ echo 'FD_HOME:'; exit 1; }}
printf 'FD_HOME:%s\n' "$HOME"
CLAUDE_BIN={claude}
if FD_V=$("$CLAUDE_BIN" --version 2>/dev/null); then
    printf 'FD_CLAUDE_VERSION:%s\n' "$(printf '%s\n' "$FD_V" | head -n 1)"
else
    echo 'FD_CLAUDE_VERSION:'
fi
if command -v sha256sum >/dev/null 2>&1; then FD_H='sha256sum'
elif command -v shasum >/dev/null 2>&1; then FD_H='shasum -a 256'
else FD_H=''
fi
if [ -z "$FD_H" ]; then
    echo FD_NO_HASHER
else
    for d in {dirs}; do
        if [ -d "$d" ]; then
            find "$d" -type f -exec $FD_H {{}} + 2>/dev/null | sed 's/^/FD_SHA:/'
            find "$d" -type f -perm -u+x 2>/dev/null | sed 's/^/FD_X:/'
        fi
    done
    for f in {files}; do
        if [ -f "$f" ]; then
            $FD_H "$f" 2>/dev/null | sed 's/^/FD_SHA:/'
            if [ -x "$f" ]; then printf 'FD_X:%s\n' "$f"; fi
        fi
    done
fi
if [ -f .claude/settings.json ] && [ "$(wc -c < .claude/settings.json)" -le 1048576 ]; then
    printf 'FD_SETTINGS:'
    base64 < .claude/settings.json | tr -d '\n'
    echo
fi
if [ ! -e .claude.json ]; then
    echo 'FD_CLAUDE_JSON_NONE'
elif [ "$(wc -c < .claude.json)" -gt 33554432 ]; then
    echo 'FD_CLAUDE_JSON_TOO_BIG'
else
    printf 'FD_CLAUDE_JSON:'
    base64 < .claude.json | tr -d '\n'
    echo
fi
echo FD_END
"#,
        claude = crate::ipc::commands::resolve_claude_bin_expr(),
        dirs = dirs.join(" "),
        files = files.join(" "),
    )
}

/// Pure parser of [`facts_script`]'s answer.
pub(crate) fn parse_facts(stdout: &str) -> ServerConfigFacts {
    use base64::Engine;
    let mut facts = ServerConfigFacts::default();
    let mut exec = BTreeSet::new();
    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("FD_HOME:") {
            facts.home = Some(v.trim()).filter(|v| v.starts_with('/')).map(str::to_string);
        } else if let Some(v) = line.strip_prefix("FD_CLAUDE_VERSION:") {
            facts.claude_version = Some(v.trim()).filter(|v| !v.is_empty()).map(str::to_string);
        } else if let Some(v) = line.strip_prefix("FD_SHA:") {
            // `<64 hex>  <path>` — a path sha256sum had to escape (a backslash or newline in
            // it) starts with `\` and is skipped: it can't be named back safely.
            if let Some((sha, path)) = v.split_once("  ") {
                if sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()) && is_clean_rel(path) {
                    facts.manifest.insert(path.to_string(), RemoteFile { sha: sha.to_ascii_lowercase(), exec: false });
                }
            }
        } else if let Some(v) = line.strip_prefix("FD_X:") {
            exec.insert(v.to_string());
        } else if line == "FD_NO_HASHER" {
            facts.no_hasher = true;
        } else if line == "FD_CLAUDE_JSON_NONE" {
            facts.mcp = Some(BTreeMap::new());
        } else if line == "FD_CLAUDE_JSON_TOO_BIG" {
            facts.mcp_unreadable = Some("its ~/.claude.json is over 32 MiB".to_string());
        } else if let Some(v) = line.strip_prefix("FD_CLAUDE_JSON:") {
            match base64::engine::general_purpose::STANDARD.decode(v.trim()) {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(json) => facts.mcp = Some(mcp_servers_of(&json)),
                    Err(e) => facts.mcp_unreadable = Some(format!("its ~/.claude.json is not valid JSON ({e})")),
                },
                Err(_) => facts.mcp_unreadable = Some("its ~/.claude.json could not be read".to_string()),
            }
        } else if let Some(v) = line.strip_prefix("FD_SETTINGS:") {
            facts.settings = base64::engine::general_purpose::STANDARD
                .decode(v.trim())
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
        } else if line == "FD_END" {
            facts.complete = true;
        }
    }
    for path in exec {
        if let Some(f) = facts.manifest.get_mut(&path) {
            f.exec = true;
        }
    }
    facts
}

/// What one alignment writes and removes on the server.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SyncPlan {
    /// Indices into [`LocalConfig::files`].
    pub write: Vec<usize>,
    /// Home-relative paths inside the mirrored roots the server holds and this Mac doesn't.
    pub delete: Vec<String>,
}

impl SyncPlan {
    pub(crate) fn is_empty(&self) -> bool {
        self.write.is_empty() && self.delete.is_empty()
    }

    /// Whether the change takes effect only in a new `claude` process (see [`needs_restart`]).
    pub(crate) fn needs_restart(&self, local: &LocalConfig) -> bool {
        self.write.iter().any(|&i| needs_restart(&local.files[i].rel)) || self.delete.iter().any(|p| needs_restart(p))
    }
}

/// Pure: what makes the server hold `local` — every file missing there or different
/// (content or exec bit), and every file of a mirrored root it holds beyond it. A listed
/// hook script outside the mirrored roots is only ever written, never removed.
pub(crate) fn plan_sync(local: &LocalConfig, remote: &HashMap<String, RemoteFile>) -> SyncPlan {
    let mut plan = SyncPlan::default();
    for (i, f) in local.files.iter().enumerate() {
        match remote.get(&f.rel) {
            Some(r) if r.sha == f.sha && r.exec == f.exec => {}
            _ => plan.write.push(i),
        }
    }
    let ours: BTreeSet<&str> = local.files.iter().map(|f| f.rel.as_str()).collect();
    let mut delete: Vec<String> =
        remote.keys().filter(|p| is_synced_path(p) && !ours.contains(p.as_str())).cloned().collect();
    delete.sort();
    plan.delete = delete;
    plan
}

/// One change to the server's user-scope MCP servers.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum McpChange {
    /// Hold exactly this config under this name (replacing any).
    Set(String, Value),
    Remove(String),
}

/// Pure: what makes the server's user-scope MCP servers this Mac's. A server this Mac
/// withholds (it carries credentials) is left as the server has it, present or not.
pub(crate) fn plan_mcp(local: &LocalConfig, server: &BTreeMap<String, Value>) -> Vec<McpChange> {
    let mut changes = Vec::new();
    for (name, value) in &local.mcp {
        if server.get(name) != Some(value) {
            changes.push(McpChange::Set(name.clone(), value.clone()));
        }
    }
    for name in server.keys() {
        if !local.mcp.contains_key(name) && !local.mcp_withheld.contains(name) {
            changes.push(McpChange::Remove(name.clone()));
        }
    }
    changes
}

/// The archive [`apply_script`] unpacks: every file to write at its home-relative path,
/// and the list of paths to remove. Gzip'd tar, read by GNU tar and bsdtar alike.
pub(crate) fn build_payload(local: &LocalConfig, plan: &SyncPlan) -> Result<Vec<u8>, String> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let mut append = |path: &str, bytes: &[u8], mode: u32| -> Result<(), String> {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(mode);
        header.set_mtime(now);
        header.set_entry_type(tar::EntryType::Regular);
        tar.append_data(&mut header, path, bytes).map_err(|e| format!("could not pack {path}: {e}"))
    };
    for &i in &plan.write {
        let f = &local.files[i];
        append(&f.rel, &f.bytes, if f.exec { 0o755 } else { 0o644 })?;
    }
    if !plan.delete.is_empty() {
        let list = plan.delete.join("\n") + "\n";
        append(DELETE_LIST, list.as_bytes(), 0o600)?;
    }
    let gz = tar.into_inner().map_err(|e| format!("could not pack the config: {e}"))?;
    gz.finish().map_err(|e| format!("could not pack the config: {e}"))
}

/// Applies [`build_payload`]'s archive (on stdin) in the server's home: first ONE backup of
/// everything the mirror covers plus `~/.claude.json` (`~/.flightdeckd/claude-config-backup.tar.gz`,
/// replaced each time, 0600 — it holds what the config holds; the very first one is also
/// kept for good as `claude-config-before-flightdeck.tar.gz`), then the removals, then each
/// file moved into place from a staging folder on the same filesystem (a rename: a `claude`
/// reading its settings never sees half a file). A backup that fails changes nothing.
/// Nothing is written or removed under a folder that is a symbolic link on the server
/// (`FD_UNDER_LINK:`). Each file that could not be written is named (`FD_WRITE_FAILED:`);
/// `FD_APPLIED` closes a run that got through.
pub(crate) fn apply_script(extras: &[String]) -> String {
    let dirs: Vec<String> = SYNCED_DIRS.iter().map(|d| shq(d)).collect();
    let backed_up: Vec<String> = listed_roots(extras).iter().map(|p| shq(p)).chain([shq(".claude.json")]).collect();
    format!(
        r#"set -f
cd "$HOME" || exit 90
mkdir -p .claude "$HOME/.flightdeckd" || {{ echo 'FD_FAIL:could not create ~/.claude on the server' >&2; exit 91; }}
# A staging folder an interrupted run left behind (never a concurrent run's: those are young).
find .claude -maxdepth 1 -name '.fd-align-stage.*' -mmin +60 -exec rm -rf {{}} + 2>/dev/null
STAGE=$(mktemp -d "$HOME/.claude/.fd-align-stage.XXXXXX") || {{ echo 'FD_FAIL:could not create a staging folder in ~/.claude' >&2; exit 91; }}
trap 'rm -rf "$STAGE"' EXIT
if ! tar -xzf - -C "$STAGE"; then echo 'FD_FAIL:the config archive could not be unpacked on the server' >&2; exit 92; fi
# Whether a folder on the way to $1 (home-relative) is a symbolic link: a file written or
# removed there would land outside the mirrored tree (in the repository the link points to).
fd_under_link() {{
    fd_d=$(dirname "$1")
    [ "$fd_d" = . ] && return 1
    fd_p=$HOME
    fd_ifs=$IFS
    IFS=/
    for fd_c in $fd_d; do
        fd_p=$fd_p/$fd_c
        if [ -L "$fd_p" ]; then IFS=$fd_ifs; return 0; fi
    done
    IFS=$fd_ifs
    return 1
}}
BK="$HOME/.flightdeckd/claude-config-backup.tar.gz"
ORIG="$HOME/.flightdeckd/claude-config-before-flightdeck.tar.gz"
set --
for p in {backed_up}; do [ -e "$p" ] && set -- "$@" "$p"; done
if [ $# -gt 0 ]; then
    (umask 077; tar -czf "$BK.tmp" "$@") 2>/dev/null
    rc=$?
    # GNU tar answers 1 for a file that changed while it was read (a running claude
    # rewrites ~/.claude.json often): the archive is whole. bsdtar's 1 is a failure.
    if [ "$rc" = 1 ] && [ -s "$BK.tmp" ] && tar --version 2>/dev/null | grep -q GNU; then rc=0; fi
    if [ "$rc" = 0 ]; then
        mv -f "$BK.tmp" "$BK" && chmod 600 "$BK" && printf 'FD_BACKUP:%s\n' "$BK"
        # The server's config from before Flight Deck ever changed it, kept for good.
        [ -e "$ORIG" ] || {{ cp -p "$BK" "$ORIG" && chmod 600 "$ORIG"; }}
    else
        rm -f "$BK.tmp"
        echo 'FD_FAIL:could not back up the current config of the server — nothing was changed' >&2
        exit 93
    fi
fi
if [ -f "$STAGE/{delete_list}" ]; then
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        if fd_under_link "$f"; then printf 'FD_UNDER_LINK:%s\n' "$f"; continue; fi
        rm -f "$f" || printf 'FD_REMOVE_FAILED:%s\n' "$f"
    done < "$STAGE/{delete_list}"
    rm -f "$STAGE/{delete_list}"
fi
(cd "$STAGE" && find . -type f) | while IFS= read -r f; do
    f=${{f#./}}
    if fd_under_link "$f"; then printf 'FD_UNDER_LINK:%s\n' "$f"; continue; fi
    if mkdir -p "$HOME/$(dirname "$f")" 2>/dev/null && mv -f "$STAGE/$f" "$HOME/$f" 2>/dev/null; then :; else printf 'FD_WRITE_FAILED:%s\n' "$f"; fi
done
for d in {dirs}; do
    [ -d "$d" ] && [ ! -L "$d" ] && find "$d" -mindepth 1 -depth -type d -empty -exec rmdir {{}} \; 2>/dev/null
done
echo FD_APPLIED
"#,
        backed_up = backed_up.join(" "),
        delete_list = DELETE_LIST,
        dirs = dirs.join(" "),
    )
}

/// What [`apply_script`] reported.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ApplyOutcome {
    pub backup: Option<String>,
    pub write_failed: Vec<String>,
    pub remove_failed: Vec<String>,
    /// Left alone: a folder on the way is a symbolic link on the server.
    pub under_link: Vec<String>,
    pub applied: bool,
}

pub(crate) fn parse_apply(stdout: &str) -> ApplyOutcome {
    let mut out = ApplyOutcome::default();
    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("FD_BACKUP:") {
            out.backup = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("FD_UNDER_LINK:") {
            out.under_link.push(v.to_string());
        } else if let Some(v) = line.strip_prefix("FD_WRITE_FAILED:") {
            out.write_failed.push(v.to_string());
        } else if let Some(v) = line.strip_prefix("FD_REMOVE_FAILED:") {
            out.remove_failed.push(v.to_string());
        } else if line == "FD_APPLIED" {
            out.applied = true;
        }
    }
    out
}

/// The server's own CLI applies `changes` (`claude mcp remove|add-json --scope user`):
/// `FD_MCP_OK:<name>` or `FD_MCP_FAIL:<name>:<its last line>` for each.
pub(crate) fn mcp_script(changes: &[McpChange]) -> String {
    let mut s = format!("CLAUDE_BIN={}\n", crate::ipc::commands::resolve_claude_bin_expr());
    for change in changes {
        match change {
            McpChange::Set(name, value) => {
                let json = serde_json::to_string(value).unwrap_or_default();
                s.push_str(&format!(
                    "\"$CLAUDE_BIN\" mcp remove --scope user {n} >/dev/null 2>&1\n\
                     if FD_OUT=$(\"$CLAUDE_BIN\" mcp add-json --scope user {n} {j} 2>&1); then printf 'FD_MCP_OK:%s\\n' {n}; \
                     else printf 'FD_MCP_FAIL:%s:%s\\n' {n} \"$(printf '%s\\n' \"$FD_OUT\" | tail -n 1)\"; fi\n",
                    n = shq(name),
                    j = shq(&json),
                ));
            }
            McpChange::Remove(name) => {
                s.push_str(&format!(
                    "if FD_OUT=$(\"$CLAUDE_BIN\" mcp remove --scope user {n} 2>&1); then printf 'FD_MCP_OK:%s\\n' {n}; \
                     else printf 'FD_MCP_FAIL:%s:%s\\n' {n} \"$(printf '%s\\n' \"$FD_OUT\" | tail -n 1)\"; fi\n",
                    n = shq(name),
                ));
            }
        }
    }
    s
}

/// `(applied, failed with why)` from [`mcp_script`]'s answer.
pub(crate) fn parse_mcp(stdout: &str) -> (Vec<String>, Vec<(String, String)>) {
    let mut ok = Vec::new();
    let mut failed = Vec::new();
    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("FD_MCP_OK:") {
            ok.push(v.to_string());
        } else if let Some(v) = line.strip_prefix("FD_MCP_FAIL:") {
            let (name, why) = v.split_once(':').unwrap_or((v, ""));
            failed.push((name.to_string(), why.trim().to_string()));
        }
    }
    (ok, failed)
}

/// Reads a whole archive back (tests): `(path, bytes, mode)` per entry.
#[cfg(test)]
fn unpack(payload: &[u8]) -> Vec<(String, Vec<u8>, u32)> {
    use std::io::Read;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(payload));
    archive
        .entries()
        .unwrap()
        .map(|e| {
            let mut e = e.unwrap();
            let path = e.path().unwrap().to_string_lossy().into_owned();
            let mode = e.header().mode().unwrap();
            let mut bytes = Vec::new();
            e.read_to_end(&mut bytes).unwrap();
            (path, bytes, mode)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_allowlisted_config_is_ever_synced() {
        for rel in [
            ".claude/settings.json",
            ".claude/CLAUDE.md",
            ".claude/agents/Explore.md",
            ".claude/skills/foo/SKILL.md",
            ".claude/plugins/cache/mk/p/1.0/plugin.json",
            ".claude/plugins/installed_plugins.json",
            ".claude/plugins/marketplaces/mk/.git/HEAD",
        ] {
            assert!(is_synced_path(rel), "{rel}");
        }
        for rel in [
            ".claude/.credentials.json",
            ".claude/projects/x/y.jsonl",
            ".claude/history.jsonl",
            ".claude/sessions/a",
            ".claude/plugins/data/p/state",
            ".claude/plugins/blocklist.json",
            ".claude/skills/foo/.DS_Store",
            ".claude/agents/../.credentials.json",
            ".claude/agents",
            ".claude/agentsX/a.md",
            ".claude.json",
            "/etc/passwd",
            ".claude/skills/a/.credentials.json",
        ] {
            assert!(!is_synced_path(rel), "{rel}");
        }
    }

    #[test]
    fn a_marketplace_refresh_needs_no_restart() {
        assert!(!needs_restart(".claude/plugins/marketplaces/mk/README.md"));
        assert!(!needs_restart(".claude/plugins/known_marketplaces.json"));
        assert!(needs_restart(".claude/plugins/cache/mk/p/1.0/x.md"));
        assert!(needs_restart(".claude/settings.json"));
        assert!(needs_restart(".claude/agents/Explore.md"));
    }

    #[test]
    fn the_home_is_rewritten_only_as_a_whole_path() {
        let from = "/Users/me";
        let to = "/home/srv";
        assert_eq!(
            rewrite_home(r#"{"installPath":"/Users/me/.claude/plugins/cache/x"}"#, from, to).as_deref(),
            Some(r#"{"installPath":"/home/srv/.claude/plugins/cache/x"}"#)
        );
        assert_eq!(rewrite_home("Read(/Users/me)", from, to).as_deref(), Some("Read(/home/srv)"));
        assert_eq!(rewrite_home("/Users/me", from, to).as_deref(), Some("/home/srv"));
        // A longer name that starts with it is someone else.
        assert_eq!(rewrite_home("/Users/me2/x and /Users/me.old", from, to), None);
        assert_eq!(rewrite_home("/Users/me2/x /Users/me/y", from, to).as_deref(), Some("/Users/me2/x /home/srv/y"));
        assert_eq!(rewrite_home("nothing here", from, to), None);
        assert_eq!(rewrite_home("/Users/me/x", from, from), None, "same home: nothing to do");
    }

    #[test]
    fn hook_scripts_are_read_off_hook_and_status_line_commands() {
        let settings = json!({
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [
                    {"type": "command", "command": "~/bin/guard.sh --strict"},
                    {"type": "command", "command": "python3 \"$HOME/.claude/scripts/check.py\" && echo ok"}
                ]}],
                "Stop": [{"hooks": [{"type": "command", "command": "/Users/me/tools/notify; ${HOME}/x/../y"}]}]
            },
            "statusLine": {"type": "command", "command": "bash '/Users/me/.claude/statusline.sh'"}
        });
        assert_eq!(
            hook_script_paths(&settings, "/Users/me"),
            vec![".claude/scripts/check.py", ".claude/statusline.sh", "bin/guard.sh", "tools/notify"]
        );
        assert!(hook_script_paths(&json!({}), "/Users/me").is_empty());
    }

    #[test]
    fn only_a_hooks_program_is_shipped_never_its_arguments_or_a_home_dotfile() {
        let settings = json!({"hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "source ~/.zshrc && ~/bin/x.sh"},
            {"type": "command", "command": "cat ~/.netrc | ~/bin/y.sh ~/data/secret.txt"},
            {"type": "command", "command": "FOO=1 BAR=~/z ~/bin/z.sh"},
            {"type": "command", "command": "bash -e ~/.config/hook.sh"},
            {"type": "command", "command": "node --no-warnings ~/tools/n.js"}
        ]}]}});
        assert_eq!(hook_script_paths(&settings, "/Users/me"), vec!["bin/x.sh", "bin/y.sh", "bin/z.sh", "tools/n.js"]);
    }

    #[test]
    fn secret_or_provider_settings_stay_the_servers_own() {
        let mac = br#"{"apiKeyHelper":"~/k.sh","env":{"ANTHROPIC_API_KEY":"sk-mac","CLAUDE_CODE_SUBAGENT_MODEL":"sonnet","CLAUDE_CODE_USE_BEDROCK":"1"},"model":"opus"}"#;
        let server = json!({"env": {"ANTHROPIC_API_KEY": "sk-server", "OTHER": "x"}, "forceLoginMethod": "claudeai"});
        let (bytes, withheld) = withhold_settings(mac, Some(&server)).unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_API_KEY"], "sk-server", "the server keeps its own key");
        assert_eq!(v["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "sonnet", "the rest is this Mac's");
        assert!(v["env"].get("CLAUDE_CODE_USE_BEDROCK").is_none() && v["env"].get("OTHER").is_none());
        assert!(v.get("apiKeyHelper").is_none());
        assert_eq!(v["forceLoginMethod"], "claudeai");
        assert_eq!(v["model"], "opus");
        assert_eq!(withheld, vec!["apiKeyHelper", "env.ANTHROPIC_API_KEY", "env.CLAUDE_CODE_USE_BEDROCK"]);
        // Nothing to withhold either way: this Mac's bytes go as they are.
        assert!(withhold_settings(br#"{"env":{"CLAUDE_CODE_SUBAGENT_MODEL":"sonnet"}}"#, Some(&json!({}))).is_none());
        assert!(!sha_of(&withhold_settings(mac, None).unwrap().0).is_empty());
    }

    fn sha_of(b: &[u8]) -> String {
        hex_sha256(b)
    }

    #[test]
    fn an_unreadable_root_on_the_mac_is_an_error_never_an_absence() {
        let dir = std::env::temp_dir().join(format!("fd-align-broken-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("moved-away"), dir.join(".claude/skills")).unwrap();
        let err = collect_local(&dir, "/home/srv").unwrap_err();
        assert!(err.contains("link to something that can't be read"), "{err}");
        std::fs::remove_file(dir.join(".claude/skills")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("gone.json"), dir.join(".claude/settings.json")).unwrap();
        assert!(collect_local(&dir, "/home/srv").is_err(), "a dangling settings.json never reads as absent");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_named_by_a_hook_never_leave_the_mac() {
        for rel in [".ssh/id_ed25519", ".aws/credentials", ".claude.json", ".claude/.credentials.json", "Library/Keychains/x"] {
            assert!(is_secret_extra(rel), "{rel}");
        }
        assert!(!is_secret_extra("bin/guard.sh"));
    }

    #[test]
    fn mcp_servers_carrying_credentials_are_withheld() {
        assert!(carries_credentials(&json!({"type": "stdio", "command": "x", "env": {"TOKEN": "s"}})));
        assert!(carries_credentials(&json!({"type": "http", "url": "u", "headers": {"Authorization": "Bearer s"}})));
        assert!(!carries_credentials(&json!({"type": "http", "url": "https://mcp.railway.com"})));
        assert!(!carries_credentials(&json!({"type": "stdio", "command": "x", "env": {}})));
        assert!(carries_credentials(&json!({"type": "http", "url": "https://h/mcp?token=abc"})));
        assert!(carries_credentials(&json!({"type": "http", "url": "https://u:p@h/mcp"})));
        assert!(carries_credentials(&json!({"type": "stdio", "command": "x", "args": ["--api-key=abc"]})));
        assert!(!carries_credentials(&json!({"type": "stdio", "command": "npx", "args": ["-y", "@railway/mcp"]})));
    }

    fn local(files: &[(&str, &str, bool)]) -> LocalConfig {
        LocalConfig {
            files: files.iter().map(|(r, b, x)| LocalFile::new(r.to_string(), b.as_bytes().to_vec(), *x)).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_plan_writes_what_differs_and_removes_what_the_mac_lacks() {
        let l = local(&[
            (".claude/settings.json", "{}", false),
            (".claude/agents/a.md", "A", false),
            (".claude/hooks/h.sh", "#!/bin/sh", true),
            ("bin/guard.sh", "#!/bin/sh", true),
        ]);
        let same = |i: usize| RemoteFile { sha: l.files[i].sha.clone(), exec: l.files[i].exec };
        let mut remote = HashMap::new();
        remote.insert(".claude/settings.json".to_string(), same(0));
        remote.insert(".claude/agents/a.md".to_string(), RemoteFile { sha: "0".repeat(64), exec: false });
        remote.insert(".claude/hooks/h.sh".to_string(), RemoteFile { exec: false, ..same(2) }); // exec bit lost
        remote.insert(".claude/agents/old.md".to_string(), RemoteFile { sha: "1".repeat(64), exec: false });
        remote.insert(".claude/CLAUDE.md".to_string(), RemoteFile { sha: "2".repeat(64), exec: false });
        remote.insert("bin/other.sh".to_string(), RemoteFile { sha: "3".repeat(64), exec: true }); // not ours to remove
        let plan = plan_sync(&l, &remote);
        let written: Vec<&str> = plan.write.iter().map(|&i| l.files[i].rel.as_str()).collect();
        assert_eq!(written, vec![".claude/agents/a.md", ".claude/hooks/h.sh", "bin/guard.sh"]);
        assert_eq!(plan.delete, vec![".claude/CLAUDE.md", ".claude/agents/old.md"]);
        assert!(plan.needs_restart(&l));

        let aligned: HashMap<String, RemoteFile> =
            l.files.iter().map(|f| (f.rel.clone(), RemoteFile { sha: f.sha.clone(), exec: f.exec })).collect();
        assert!(plan_sync(&l, &aligned).is_empty());
    }

    #[test]
    fn a_marketplace_only_change_recycles_nobody() {
        let l = local(&[(".claude/plugins/marketplaces/mk/README.md", "new", false)]);
        let plan = plan_sync(&l, &HashMap::new());
        assert!(!plan.is_empty());
        assert!(!plan.needs_restart(&l));
    }

    #[test]
    fn mcp_plan_mirrors_the_mac_but_leaves_withheld_servers_alone() {
        let mut l = LocalConfig::default();
        l.mcp.insert("railway".into(), json!({"type": "http", "url": "https://mcp.railway.com"}));
        l.mcp.insert("docs".into(), json!({"type": "http", "url": "https://d"}));
        l.mcp_withheld.push("secret".into());
        let mut server = BTreeMap::new();
        server.insert("railway".into(), json!({"type": "http", "url": "https://mcp.railway.com"}));
        server.insert("docs".into(), json!({"type": "http", "url": "https://old"}));
        server.insert("secret".into(), json!({"type": "stdio", "command": "x", "env": {"T": "server's own"}}));
        server.insert("stale".into(), json!({"type": "stdio", "command": "y"}));
        assert_eq!(
            plan_mcp(&l, &server),
            vec![McpChange::Set("docs".into(), json!({"type": "http", "url": "https://d"})), McpChange::Remove("stale".into())]
        );
    }

    #[test]
    fn the_facts_answer_parses_into_a_manifest() {
        use base64::Engine;
        let claude_json = base64::engine::general_purpose::STANDARD
            .encode(br#"{"oauthAccount":{"x":1},"mcpServers":{"railway":{"type":"http","url":"u"}}}"#);
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let out = format!(
            "FD_HOME:/home/srv\nFD_CLAUDE_VERSION:2.1.278 (Claude Code)\nFD_SHA:{a}  .claude/settings.json\n\
             FD_SHA:{b}  .claude/hooks/h.sh\nFD_SHA:\\{a}  .claude/agents/we\\\\ird.md\nFD_X:.claude/hooks/h.sh\n\
             FD_CLAUDE_JSON:{claude_json}\nFD_END\n"
        );
        let f = parse_facts(&out);
        assert!(f.complete);
        assert_eq!(f.home.as_deref(), Some("/home/srv"));
        assert_eq!(f.claude_version.as_deref(), Some("2.1.278 (Claude Code)"));
        assert_eq!(f.manifest.len(), 2, "the escaped path is skipped: {:?}", f.manifest);
        assert_eq!(f.manifest[".claude/settings.json"], RemoteFile { sha: a.clone(), exec: false });
        assert_eq!(f.manifest[".claude/hooks/h.sh"], RemoteFile { sha: b.to_ascii_lowercase(), exec: true });
        assert_eq!(f.mcp.unwrap()["railway"], json!({"type": "http", "url": "u"}));

        let cut = parse_facts("FD_HOME:/home/srv\nFD_CLAUDE_VERSION:\n");
        assert!(!cut.complete && cut.claude_version.is_none() && cut.mcp.is_none());
        assert_eq!(parse_facts("FD_CLAUDE_JSON_NONE\nFD_END\n").mcp, Some(BTreeMap::new()));
        assert!(parse_facts("FD_CLAUDE_JSON:%%%\n").mcp_unreadable.is_some());
    }

    #[test]
    fn the_payload_carries_the_writes_their_modes_and_the_removals() {
        let l = local(&[(".claude/settings.json", "{}", false), ("bin/guard.sh", "#!/bin/sh\n", true)]);
        let plan = SyncPlan { write: vec![0, 1], delete: vec![".claude/agents/old.md".into()] };
        let entries = unpack(&build_payload(&l, &plan).unwrap());
        assert_eq!(entries[0], (".claude/settings.json".to_string(), b"{}".to_vec(), 0o644));
        assert_eq!(entries[1], ("bin/guard.sh".to_string(), b"#!/bin/sh\n".to_vec(), 0o755));
        assert_eq!(entries[2].0, DELETE_LIST);
        assert_eq!(entries[2].1, b".claude/agents/old.md\n".to_vec());
    }

    #[test]
    fn collect_local_reads_the_allowlist_rewrites_the_home_and_finds_hook_scripts() {
        let dir = std::env::temp_dir().join(format!("fd-align-home-{}", uuid::Uuid::new_v4()));
        let home = dir.as_path();
        let h = home.to_string_lossy().into_owned();
        let w = |rel: &str, text: &str| {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        };
        w(".claude/settings.json", &format!(r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"{h}/bin/n.sh"}}]}}]}},"permissions":{{"allow":["Read({h}/x)"]}}}}"#));
        w(".claude/agents/Explore.md", "---\nmodel: haiku\n---\n");
        w(".claude/.credentials.json", "SECRET");
        w(".claude/projects/p/t.jsonl", "{}");
        w(".claude/skills/s/.DS_Store", "junk");
        w(".claude/plugins/installed_plugins.json", &format!(r#"{{"installPath":"{h}/.claude/plugins/cache/p"}}"#));
        w("bin/n.sh", "#!/bin/sh\n");
        w(".ssh/id_ed25519", "KEY");
        w(".claude.json", r#"{"oauthAccount":{"emailAddress":"x"},"mcpServers":{"a":{"type":"http","url":"u"},"b":{"type":"stdio","command":"c","env":{"T":"s"}}}}"#);

        let c = collect_local(home, "/home/srv").unwrap();
        let rels: Vec<&str> = c.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(
            rels,
            vec![".claude/agents/Explore.md", ".claude/plugins/installed_plugins.json", ".claude/settings.json", "bin/n.sh"]
        );
        assert_eq!(c.extras, vec!["bin/n.sh"]);
        let settings = String::from_utf8(c.files[2].bytes.clone()).unwrap();
        assert!(settings.contains("/home/srv/bin/n.sh") && settings.contains("Read(/home/srv/x)"), "{settings}");
        assert!(!settings.contains(&h));
        let installed = String::from_utf8(c.files[1].bytes.clone()).unwrap();
        assert!(installed.contains("/home/srv/.claude/plugins/cache/p"), "{installed}");
        assert_eq!(c.mcp.keys().collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(c.mcp_withheld, vec!["b"]);
        assert!(!c.digest().is_empty());
        assert_eq!(c.digest(), collect_local(home, "/home/srv").unwrap().digest(), "stable");
        assert_ne!(c.digest(), collect_local(home, "/home/other").unwrap().digest(), "depends on the server's home");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn the_scripts_quote_every_path_and_close_with_their_markers() {
        let extras = vec!["bin/it's.sh".to_string()];
        let facts = facts_script(&extras);
        assert!(facts.contains(&shq("bin/it's.sh")) && facts.trim_end().ends_with("echo FD_END"));
        let apply = apply_script(&extras);
        assert!(apply.contains("FD_APPLIED") && apply.contains(&shq(".claude.json")));
        let mcp = mcp_script(&[McpChange::Set("n'x".into(), json!({"url": "a'b"})), McpChange::Remove("old".into())]);
        assert!(mcp.contains(&shq("n'x")) && mcp.contains(&shq(r#"{"url":"a'b"}"#)) && mcp.contains("mcp remove --scope user 'old'"));
        assert_eq!(
            parse_mcp("FD_MCP_OK:a\nFD_MCP_FAIL:b:already exists\n"),
            (vec!["a".to_string()], vec![("b".to_string(), "already exists".to_string())])
        );
        let applied = parse_apply(
            "FD_BACKUP:/home/srv/.flightdeckd/b.tgz\nFD_WRITE_FAILED:.claude/x\nFD_UNDER_LINK:.claude/skills/a.md\nFD_APPLIED\n",
        );
        assert!(applied.applied && applied.backup.is_some() && applied.write_failed == vec![".claude/x"]);
        assert_eq!(applied.under_link, vec![".claude/skills/a.md"]);
        assert!(apply.starts_with("set -f\n"), "no glob ever expands a path");
    }
}
