//! Claude spend — what every Claude agent actually ran on, and how much it produced: the
//! MAIN agent of each conversation and the helper (sub-)agents it delegates to.
//!
//! ZERO instrumentation: the CLI already writes one JSON line per event — the main thread
//! into `~/.claude/projects/<slug>/<session>.jsonl`, each helper into
//! `~/.claude/projects/<slug>/**/agent-*.jsonl` — and every `assistant` line carries the
//! things this module needs: `message.model`, `message.usage`, and for a helper
//! `attributionAgent` (the sub-agent TYPE: `Explore`, `general-purpose`,
//! `workflow-subagent`). We only read.
//!
//! ## Main vs helper, and why nothing is counted twice
//!
//! Which [`SpendThread`] a turn belongs to comes from WHERE it is written: an `agent-*.jsonl`
//! file is a helper's, a session file is the main thread's — except a line flagged
//! `isSidechain: true`, which older CLIs wrote inline into the session file for their
//! helpers. Measured on a real corpus (164 session files, 3 441 helper files): not one API
//! response appears in both kinds of file, so the split is clean.
//!
//! The same response CAN appear in two session files, though — a fork (Flight Deck's, or
//! the CLI's `--fork-session`) copies the transcript it branches from, ids and usage
//! included (67 of 18 002 responses on that corpus). So responses are de-duplicated across
//! the WHOLE corpus by their API identity, not just within a file — otherwise every fork
//! would bill its parent's history a second time.
//!
//! ## Why a flat bucket list rather than a query API
//!
//! Measured on a real corpus (931 files, 194 MiB, 24 066 assistant turns spanning 20
//! active days): the whole thing collapses to **50** distinct
//! `(day, repo, thread, agent, model, workflow)` buckets. So one scan returns everything and the
//! front pivots client-side — every filter, every table and every chart comes out of the
//! same payload, with no second round trip and no server-side cube. If that ratio ever
//! stops holding (a year of daily use across many repos), the shape still degrades
//! gracefully: it is bounded by `days × repos × agents × models`, all small.
//!
//! ## Reading discipline
//!
//! - A **substring prefilter** (`"assistant"`) runs before any `serde_json` parse. The
//!   corpus is 194 MiB of long lines but only half of them are assistant turns; parsing
//!   every line as JSON is what would make this slow. The prefilter cannot produce false
//!   negatives — an assistant line always carries `"role":"assistant"`.
//! - Unreadable files are COUNTED, never swallowed: a report that scanned 400 of 931
//!   files must not look like a small bill (zero-silent-error).
//! - `<synthetic>` model rows are dropped — the CLI emits them for injected content that
//!   never hit a model, and pricing them would invent spend.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;

/// The sub-agent name recorded when a helper turn carries no `attributionAgent`. Rare (4
/// lines in 1467 sampled) but real, and hiding those turns would understate the total.
pub const UNATTRIBUTED: &str = "unknown";

/// Which agent of a conversation a turn belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SpendThread {
    /// The conversation's own agent — the one the user talks to.
    Main,
    /// A helper (sub-)agent it delegated to, workflow runs included.
    Helper,
}

/// One aggregated cell of the spend cube. Every number is a SUM over the turns that
/// share the six key fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpendBucket {
    /// `YYYY-MM-DD`, from the turn's `timestamp` (UTC, as the CLI writes it).
    pub day: String,
    /// Absolute path of the repository the work happened in — worktrees folded back onto
    /// their parent repo (see [`repo_root_for`]), so "this repo" means one row, not one
    /// row per branch.
    pub repo: String,
    /// Last path segment of `repo`, for display.
    pub repo_label: String,
    /// The conversation's main agent, or one of its helpers.
    pub thread: SpendThread,
    /// The sub-agent type: `Explore`, `general-purpose`, `workflow-subagent`, … or
    /// [`UNATTRIBUTED`]. Empty for a main-thread turn, which has no sub-agent type.
    pub agent: String,
    /// The model id EXACTLY as the transcript records it (`claude-haiku-4-5-20251001`),
    /// which is a full id where the app's catalogue uses aliases (`haiku`). The front
    /// normalizes; storing the raw id keeps this module honest about what it saw.
    pub model: String,
    /// Whether the turn belongs to a workflow run — a transcript filed under a
    /// `subagents/workflows/wf_<id>` directory.
    ///
    /// (Written without a trailing glob on purpose: this doc comment is transcribed into
    /// the generated TypeScript inside a block comment, and a literal `*` followed by `/`
    /// would close it early and break `bindings.ts`.)
    pub workflow: bool,
    pub turns: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// Everything the UI needs for the spend dashboard, in one payload.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SpendReport {
    pub buckets: Vec<SpendBucket>,
    /// Files opened and read to the end.
    pub files_scanned: u32,
    /// Files found but unreadable. Surfaced in the UI — a partial scan must never be
    /// mistaken for a small bill.
    pub files_unreadable: u32,
    /// Lines that looked like assistant turns but failed to parse. Same reasoning.
    pub lines_unparsed: u32,
    /// Human-readable notes about anything degraded (missing projects dir, …).
    pub warnings: Vec<String>,
}

/// The key of one bucket, before the counts are folded in.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BucketKey {
    day: String,
    repo: String,
    thread: SpendThread,
    agent: String,
    model: String,
    workflow: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Counts {
    turns: u32,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
}

impl Counts {
    fn add(&mut self, other: &Counts) {
        self.turns += other.turns;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
    }
}

/// One API response, already folded from its content-block lines (see [`scan_file`]).
#[derive(Debug, Clone)]
struct Response {
    /// Hash of the response's API identity (`message.id` + `requestId`), when it has one —
    /// the key that de-duplicates a response copied into another file by a fork. `None` for
    /// a line with no API identity: it can only be told apart within its own file, so it
    /// is never merged across files.
    id: Option<u64>,
    /// Index into the file's [`FileScan::keys`].
    key: u32,
    counts: Counts,
}

/// What one transcript contributes, before cross-file de-duplication.
#[derive(Debug, Clone, Default)]
struct FileScan {
    /// The distinct buckets this file's responses land in — stored once and referenced by
    /// index, so a file of 2 000 responses does not hold 2 000 copies of the same key.
    keys: Vec<BucketKey>,
    responses: Vec<Response>,
    lines_unparsed: u32,
}

/// Per-file scan result, cached so re-opening the page does not re-read 600+ MiB.
#[derive(Debug, Clone)]
struct CachedFile {
    size: u64,
    mtime_ms: i64,
    scan: FileScan,
}

/// The two kinds of transcript file, told apart by where the CLI writes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileKind {
    /// `projects/<slug>/<session>.jsonl` — a conversation's main thread.
    Session,
    /// `agent-*.jsonl` — one helper run.
    Helper,
}

/// Cache keyed by path, invalidated on (size, mtime) — these transcripts are append-only,
/// so either changing means "read it again". Process-wide and in memory only: the corpus
/// is re-derivable from disk, so persisting it would buy a cold-start win we do not need
/// at the cost of a schema to migrate.
static CACHE: Mutex<Option<HashMap<PathBuf, CachedFile>>> = Mutex::new(None);

/// Scan the user's Claude projects directory. `None` home → an empty report carrying a
/// warning rather than an error: an empty dashboard with an explanation beats a red page.
pub fn scan() -> SpendReport {
    let Some(home) = home_dir() else {
        return SpendReport {
            warnings: vec!["could not resolve the home directory".to_string()],
            ..Default::default()
        };
    };
    scan_in(&home.join(".claude/projects"))
}

/// Testable core: aggregate every session transcript and every `agent-*.jsonl` under
/// `projects_dir`.
pub fn scan_in(projects_dir: &Path) -> SpendReport {
    let mut report = SpendReport::default();
    if !projects_dir.is_dir() {
        report
            .warnings
            .push(format!("no transcripts directory at {}", projects_dir.display()));
        return report;
    }

    let mut files = Vec::new();
    collect_transcripts(projects_dir, &mut files);
    // Sorted so that when a forked response is found in two files, the SAME copy wins on
    // every scan — `read_dir` order is whatever the filesystem says it is.
    files.sort_by(|a, b| a.0.cmp(&b.0));

    // Repo roots are resolved by walking the filesystem, so memoize per distinct cwd —
    // a corpus of ~1000 files typically holds a dozen distinct working directories.
    let mut repo_cache: HashMap<String, String> = HashMap::new();

    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    // A transcript deleted since the last scan (the CLI prunes old sessions) must not live
    // on in memory forever.
    let present: HashSet<&PathBuf> = files.iter().map(|(p, _)| p).collect();
    cache.retain(|path, _| present.contains(path));

    // Pass 1 — bring every file's scan up to date. A file whose stamp cannot be read is
    // scanned but not cached, so it is held here rather than in the cache.
    let mut uncached: HashMap<PathBuf, FileScan> = HashMap::new();
    let mut readable: Vec<&PathBuf> = Vec::with_capacity(files.len());
    for (path, kind) in &files {
        let stamp = file_stamp(path);
        let fresh = matches!(
            (stamp, cache.get(path)),
            (Some((size, mtime_ms)), Some(hit)) if hit.size == size && hit.mtime_ms == mtime_ms
        );
        if !fresh {
            let Ok(text) = std::fs::read_to_string(path) else {
                report.files_unreadable += 1;
                continue;
            };
            let scan = scan_file(&text, *kind, is_workflow_path(path), &mut repo_cache);
            match stamp {
                Some((size, mtime_ms)) => {
                    cache.insert(path.clone(), CachedFile { size, mtime_ms, scan });
                }
                None => {
                    uncached.insert(path.clone(), scan);
                }
            }
        }
        readable.push(path);
    }

    // Pass 2 — fold every response into its bucket, each API response ONCE across the whole
    // corpus (see the module doc: a fork copies its parent's responses into a new file).
    let mut totals: HashMap<&BucketKey, Counts> = HashMap::new();
    let mut by_id: HashMap<u64, (&BucketKey, &Counts)> = HashMap::new();
    for path in readable {
        let Some(scan) = cache.get(path).map(|c| &c.scan).or_else(|| uncached.get(path)) else {
            continue;
        };
        report.files_scanned += 1;
        report.lines_unparsed += scan.lines_unparsed;
        for response in &scan.responses {
            let key = &scan.keys[response.key as usize];
            match response.id {
                None => totals.entry(key).or_default().add(&response.counts),
                Some(id) => match by_id.get_mut(&id) {
                    // Same rule as within a file: the copy with the most output is the
                    // complete one. On a tie the first file in path order keeps it.
                    Some(best) if response.counts.output_tokens > best.1.output_tokens => {
                        *best = (key, &response.counts);
                    }
                    Some(_) => {}
                    None => {
                        by_id.insert(id, (key, &response.counts));
                    }
                },
            }
        }
    }
    for (key, counts) in by_id.into_values() {
        totals.entry(key).or_default().add(counts);
    }

    report.buckets = totals
        .into_iter()
        .map(|(key, counts)| SpendBucket {
            repo_label: label_for(&key.repo),
            day: key.day.clone(),
            repo: key.repo.clone(),
            thread: key.thread,
            agent: key.agent.clone(),
            model: key.model.clone(),
            workflow: key.workflow,
            turns: counts.turns,
            input_tokens: counts.input_tokens,
            output_tokens: counts.output_tokens,
            cache_read_tokens: counts.cache_read_tokens,
            cache_creation_tokens: counts.cache_creation_tokens,
        })
        .collect();
    // Stable order so a re-scan does not reshuffle the table under the user.
    report.buckets.sort_by(|a, b| {
        (&a.day, &a.repo, a.thread, &a.agent, &a.model, a.workflow)
            .cmp(&(&b.day, &b.repo, b.thread, &b.agent, &b.model, b.workflow))
    });
    report
}

/// The five fields we want out of an assistant line, and nothing else.
///
/// Deliberately NOT `serde_json::Value`: a turn's `message.content` is the bulk of the
/// line (tool calls, prose, thinking) and we throw all of it away. Borrowing `&str` and
/// letting serde skip the rest cut the real-corpus scan from 2.3 s to well under a second
/// — the difference between a dashboard that needs a spinner and one that does not.
#[derive(Deserialize)]
struct TurnLine<'a> {
    #[serde(rename = "type")]
    kind: Option<&'a str>,
    timestamp: Option<&'a str>,
    cwd: Option<&'a str>,
    #[serde(rename = "attributionAgent")]
    attribution_agent: Option<&'a str>,
    /// A helper's line written inline into the SESSION file — how older CLIs recorded
    /// helpers before they got their own `agent-*.jsonl`.
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<bool>,
    /// The API request this line belongs to — half of the de-duplication key, see
    /// [`scan_file`].
    #[serde(rename = "requestId")]
    request_id: Option<&'a str>,
    /// The line's own id: the de-duplication key of last resort, for a line that carries
    /// neither a message id nor a request id.
    uuid: Option<&'a str>,
    #[serde(borrow)]
    message: Option<TurnMessage<'a>>,
}

#[derive(Deserialize)]
struct TurnMessage<'a> {
    /// The API message id (`msg_…`) — shared by every line the CLI writes for one response.
    id: Option<&'a str>,
    model: Option<&'a str>,
    usage: Option<TurnUsage>,
    // `content` is intentionally absent: serde skips it without allocating.
    #[serde(skip)]
    _borrow: std::marker::PhantomData<&'a ()>,
}

#[derive(Deserialize, Default)]
struct TurnUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// Aggregate one transcript's assistant turns. Pure apart from the repo-root memo, so the
/// parsing rules are unit-testable without a filesystem.
///
/// ⚠️ One API response is NOT one line. The CLI writes a line per content block (thinking,
/// text, each tool call), every one of them repeating the same `message.id` / `requestId`
/// and the same `usage` — input and cache counts identical, `output_tokens` partial on the
/// early lines (`5`, `5`, `5`, then `473`). Summing every line inflated the dashboard ~4.5×
/// (measured: 2 717 assistant lines = 613 distinct responses). So lines are first folded by
/// response, keeping the one with the most output (the final, complete count) — one turn
/// per response. Responses come back unaggregated: folding them into buckets waits until
/// every file is read, because a forked response must be counted once across files.
fn scan_file(
    text: &str,
    kind: FileKind,
    workflow: bool,
    repo_cache: &mut HashMap<String, String>,
) -> FileScan {
    // Response key → the bucket it lands in plus its best usage so far. The key is
    // `(message.id, requestId)`, falling back to the line uuid, then to the line's position
    // — a line with no identity at all is its own response rather than being merged.
    let mut responses: HashMap<String, (BucketKey, Counts)> = HashMap::new();
    let mut unparsed = 0u32;
    for (index, line) in text.lines().enumerate() {
        // Prefilter before any JSON parse. An assistant turn always carries
        // `"role":"assistant"`, so this can only ever over-select, never miss one.
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(turn) = serde_json::from_str::<TurnLine>(line) else {
            unparsed += 1;
            continue;
        };
        if turn.kind != Some("assistant") {
            continue;
        }
        let message = match turn.message {
            Some(m) => m,
            None => continue,
        };
        let model = message.model.unwrap_or("");
        // `<synthetic>` marks content the CLI injected without calling a model; pricing it
        // would invent spend that never happened.
        if model.is_empty() || model == "<synthetic>" {
            continue;
        }
        let Some(day) = turn.timestamp.and_then(day_of) else {
            continue;
        };
        let cwd = turn.cwd.unwrap_or("");
        let repo = match repo_cache.get(cwd) {
            Some(r) => r.clone(),
            None => {
                let resolved = repo_root_for(cwd);
                repo_cache.insert(cwd.to_string(), resolved.clone());
                resolved
            }
        };
        let thread = if kind == FileKind::Helper || turn.is_sidechain == Some(true) {
            SpendThread::Helper
        } else {
            SpendThread::Main
        };
        let attributed = turn.attribution_agent.filter(|s| !s.is_empty());
        let agent = match thread {
            SpendThread::Helper => attributed.unwrap_or(UNATTRIBUTED),
            // The main thread has no sub-agent type. Kept if the CLI ever records one (a
            // session started as a named agent) rather than discarded.
            SpendThread::Main => attributed.unwrap_or(""),
        };

        let usage = message.usage.unwrap_or_default();
        let key = BucketKey {
            day: day.to_string(),
            repo,
            thread,
            agent: agent.to_string(),
            model: model.to_string(),
            workflow,
        };
        let counts = Counts {
            turns: 1,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_input_tokens,
            cache_creation_tokens: usage.cache_creation_input_tokens,
        };
        // Prefixes keep the three kinds of key from ever colliding with one another; only
        // the first is an API identity, and so the only one de-duplicated across files.
        let response_key = match (message.id, turn.request_id, turn.uuid) {
            (None, None, None) => format!("#line:{index}"),
            (None, None, Some(uuid)) => format!("#uuid:{uuid}"),
            (id, request, _) => format!("api:{}\u{0}{}", id.unwrap_or(""), request.unwrap_or("")),
        };
        match responses.get_mut(&response_key) {
            // `>=`: on a tie the later line wins, which is the one the CLI wrote last.
            Some(best) if counts.output_tokens >= best.1.output_tokens => *best = (key, counts),
            Some(_) => {}
            None => {
                responses.insert(response_key, (key, counts));
            }
        }
    }

    let mut scan = FileScan { lines_unparsed: unparsed, ..Default::default() };
    let mut key_index: HashMap<BucketKey, u32> = HashMap::new();
    for (response_key, (key, counts)) in responses {
        let next = key_index.len() as u32;
        let index = *key_index.entry(key).or_insert(next);
        let id = response_key.starts_with("api:").then(|| hash_id(&response_key));
        scan.responses.push(Response { id, key: index, counts });
    }
    let mut keyed: Vec<(u32, BucketKey)> = key_index.into_iter().map(|(k, i)| (i, k)).collect();
    keyed.sort_by_key(|(i, _)| *i);
    scan.keys = keyed.into_iter().map(|(_, k)| k).collect();
    scan
}

/// A 64-bit digest of a response's API identity. Holding the digest instead of the two id
/// strings keeps the cache of a 600 MiB corpus to a few MiB; at ~10⁵ responses the chance
/// of two distinct ids colliding is ~10⁻⁹.
fn hash_id(key: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    hasher.finish()
}

/// `2026-09-09T18:44:34.920Z` → `2026-09-09`. Rejects anything that is not shaped like an
/// ISO date, so a malformed stamp drops the turn instead of inventing a bucket named after
/// garbage.
fn day_of(timestamp: &str) -> Option<&str> {
    let day = timestamp.get(..10)?;
    let bytes = day.as_bytes();
    let digits_ok = |i: usize| bytes[i].is_ascii_digit();
    if bytes.len() == 10
        && (0..4).all(digits_ok)
        && bytes[4] == b'-'
        && digits_ok(5)
        && digits_ok(6)
        && bytes[7] == b'-'
        && digits_ok(8)
        && digits_ok(9)
    {
        Some(day)
    } else {
        None
    }
}

/// Whether a transcript belongs to a workflow run. The CLI groups those under
/// `…/subagents/workflows/wf_<id>/`, which is where the spend concentrates — so this is a
/// first-class dimension, not a detail.
fn is_workflow_path(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with("wf_"))
}

/// Fold a working directory onto the repository it belongs to.
///
/// Two corrections, both observed on real data and both needed:
///   1. A cwd can sit INSIDE a worktree (`…/tosse-code/.claude/worktrees/voice/src-tauri`),
///      so we cut at the `/.claude/worktrees/` marker rather than stripping a suffix.
///   2. A cwd can be a plain subdirectory of the repo (`…/Citadel/experiments/village-sim`),
///      so after the cut we walk UP to the nearest `.git`. That also keeps a genuinely
///      nested repository separate, which a path heuristic alone would merge.
///
/// A path that no longer exists (a landed worktree, a deleted clone) keeps its cut form —
/// old spend still groups correctly instead of scattering.
fn repo_root_for(cwd: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    let cut = strip_worktree(cwd);
    match nearest_git_root(Path::new(cut)) {
        Some(root) => root.to_string_lossy().into_owned(),
        None => cut.to_string(),
    }
}

/// Cut a path at the `/.claude/worktrees/` marker, keeping everything before it. Pure.
fn strip_worktree(cwd: &str) -> &str {
    const MARKER: &str = "/.claude/worktrees/";
    match cwd.find(MARKER) {
        Some(i) => &cwd[..i],
        None => cwd,
    }
}

/// Nearest ancestor (inclusive) holding a `.git` entry — a directory for a normal clone,
/// a FILE for a worktree, hence `exists()` rather than `is_dir()`.
fn nearest_git_root(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// Display name for a repo path: its last segment, or the whole path when it has none.
fn label_for(repo: &str) -> String {
    Path::new(repo)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.to_string())
}

/// Gather every transcript under `projects/`: the session files sitting directly in each
/// `projects/<slug>/`, and the `agent-*.jsonl` helper files anywhere below.
///
/// Only a `.jsonl` DIRECTLY in a slug directory is a session transcript — deeper ones are
/// workflow bookkeeping (`journal.jsonl`) and carry no model turns.
fn collect_transcripts(projects_dir: &Path, out: &mut Vec<(PathBuf, FileKind)>) {
    collect_files(projects_dir, out, 0);
}

/// Depth-bounded: the tree is `projects/<slug>/<session>/subagents[/workflows/wf_<id>]/`,
/// so 6 is generous, and a bound means a symlink loop cannot hang the scan.
fn collect_files(dir: &Path, out: &mut Vec<(PathBuf, FileKind)>, depth: u32) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            collect_files(&path, out, depth + 1);
        } else if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".jsonl") {
                continue;
            }
            if name.starts_with("agent-") {
                out.push((path, FileKind::Helper));
            } else if depth == 1 {
                out.push((path, FileKind::Session));
            }
        }
    }
}

/// `(size, mtime_ms)` — the cheap disk fingerprint that says whether a cached scan is
/// still good. Mirrors the editor's `diskStamp` discipline.
fn file_stamp(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some((meta.len(), mtime))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_of_accepts_iso_and_rejects_junk() {
        assert_eq!(day_of("2026-09-09T18:44:34.920Z"), Some("2026-09-09"));
        assert_eq!(day_of("2026-09-09"), Some("2026-09-09"));
        assert_eq!(day_of("not-a-date"), None);
        assert_eq!(day_of("2026/09/09T00:00:00Z"), None);
        assert_eq!(day_of(""), None);
        assert_eq!(day_of("20260909T00"), None);
    }

    #[test]
    fn strip_worktree_cuts_at_the_marker_not_the_suffix() {
        // A cwd INSIDE a worktree — the case a suffix-strip would miss.
        assert_eq!(
            strip_worktree("/r/tosse-code/.claude/worktrees/voice-agent/src-tauri"),
            "/r/tosse-code"
        );
        // Deeply nested inside a worktree.
        assert_eq!(
            strip_worktree("/r/Citadel/.claude/worktrees/valeur/experiments/village-sim"),
            "/r/Citadel"
        );
        // The worktree root itself.
        assert_eq!(strip_worktree("/r/tosse-code/.claude/worktrees/mcp"), "/r/tosse-code");
        // No marker: untouched.
        assert_eq!(strip_worktree("/r/Citadel/experiments/sim"), "/r/Citadel/experiments/sim");
    }

    #[test]
    fn workflow_paths_are_recognised_by_their_wf_segment() {
        assert!(is_workflow_path(Path::new("/p/s/subagents/workflows/wf_abc/agent-1.jsonl")));
        assert!(!is_workflow_path(Path::new("/p/s/subagents/agent-1.jsonl")));
        // A repo that merely CONTAINS "wf" must not count.
        assert!(!is_workflow_path(Path::new("/p/wfmodels/subagents/agent-1.jsonl")));
    }

    #[test]
    fn label_is_the_last_segment() {
        assert_eq!(label_for("/Users/x/Documents/repositories/tosse-code"), "tosse-code");
        assert_eq!(label_for(""), "");
    }

    /// Scan one file's text and fold its responses into buckets — the per-file half of
    /// `scan_in`, without the cross-file de-duplication.
    fn fold(text: &str, kind: FileKind) -> (Vec<(BucketKey, Counts)>, u32) {
        let mut memo = HashMap::new();
        let scan = scan_file(text, kind, false, &mut memo);
        let mut cells: HashMap<BucketKey, Counts> = HashMap::new();
        for r in &scan.responses {
            cells.entry(scan.keys[r.key as usize].clone()).or_default().add(&r.counts);
        }
        (cells.into_iter().collect(), scan.lines_unparsed)
    }

    fn line(ts: &str, cwd: &str, agent: &str, model: &str, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","cwd":"{cwd}","attributionAgent":"{agent}","message":{{"role":"assistant","model":"{model}","usage":{{"input_tokens":3,"output_tokens":{out},"cache_read_input_tokens":10,"cache_creation_input_tokens":20}}}}}}"#
        )
    }

    #[test]
    fn scan_file_folds_turns_into_buckets() {
        let text = [
            line("2026-09-09T10:00:00Z", "/r/app", "Explore", "claude-haiku-4-5-20251001", 7),
            line("2026-09-09T11:00:00Z", "/r/app", "Explore", "claude-haiku-4-5-20251001", 5),
            line("2026-09-09T12:00:00Z", "/r/app", "general-purpose", "claude-opus-4-8", 100),
        ]
        .join("\n");
        let (cells, unparsed) = fold(&text, FileKind::Helper);
        assert_eq!(unparsed, 0);
        assert_eq!(cells.len(), 2, "same day+repo+agent+model folds into one bucket");
        let explore = cells.iter().find(|(k, _)| k.agent == "Explore").unwrap();
        assert_eq!(explore.1.turns, 2);
        assert_eq!(explore.1.output_tokens, 12);
        assert_eq!(explore.1.input_tokens, 6);
        assert_eq!(explore.1.cache_read_tokens, 20);
        assert_eq!(explore.1.cache_creation_tokens, 40);
    }

    #[test]
    fn scan_file_skips_synthetic_and_non_assistant_lines() {
        let text = [
            line("2026-09-09T10:00:00Z", "/r/app", "Explore", "<synthetic>", 7),
            r#"{"type":"user","timestamp":"2026-09-09T10:00:00Z","message":{"role":"user"}}"#
                .to_string(),
            // A USER line quoting the word assistant: survives the prefilter, dropped after parse.
            r#"{"type":"user","message":{"role":"user","content":"the \"assistant\" said"}}"#
                .to_string(),
            line("2026-09-09T10:00:00Z", "/r/app", "Explore", "claude-opus-5", 4),
        ]
        .join("\n");
        let (cells, unparsed) = fold(&text, FileKind::Helper);
        assert_eq!(unparsed, 0);
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].0.model, "claude-opus-5");
        assert_eq!(cells[0].1.turns, 1);
    }

    /// An assistant line as the CLI really writes it: one per content block, sharing the
    /// response's `message.id` / `requestId` and repeating its usage.
    fn block_line(msg_id: &str, req_id: &str, uuid: &str, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","requestId":"{req_id}","timestamp":"2026-09-09T10:00:00Z","cwd":"/r/app","attributionAgent":"Explore","message":{{"id":"{msg_id}","role":"assistant","model":"claude-opus-5","usage":{{"input_tokens":10,"output_tokens":{out},"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}}}}}"#
        )
    }

    #[test]
    fn content_blocks_of_one_response_count_once_with_the_final_output() {
        // Shape measured on a real sub-agent transcript: four lines at output 5 then the
        // complete count on the last, all repeating the same input and cache figures.
        let text = [
            block_line("msg_a", "req_a", "u1", 5),
            block_line("msg_a", "req_a", "u2", 5),
            block_line("msg_a", "req_a", "u3", 473),
            block_line("msg_b", "req_b", "u4", 8),
            block_line("msg_b", "req_b", "u5", 297),
        ]
        .join("\n");
        let (cells, unparsed) = fold(&text, FileKind::Helper);
        assert_eq!(unparsed, 0);
        assert_eq!(cells.len(), 1);
        let c = &cells[0].1;
        assert_eq!(c.turns, 2, "two responses, not five lines");
        assert_eq!(c.output_tokens, 473 + 297, "the complete count, not a sum of partials");
        assert_eq!(c.input_tokens, 20, "input repeated on every block is counted once");
        assert_eq!(c.cache_read_tokens, 200);
        assert_eq!(c.cache_creation_tokens, 100);
    }

    #[test]
    fn a_partial_block_written_after_the_complete_one_does_not_lower_the_count() {
        let text = [block_line("msg_a", "req_a", "u1", 473), block_line("msg_a", "req_a", "u2", 5)]
            .join("\n");
        let (cells, _) = fold(&text, FileKind::Helper);
        assert_eq!(cells[0].1.output_tokens, 473);
        assert_eq!(cells[0].1.turns, 1);
    }

    #[test]
    fn lines_without_a_response_id_fall_back_to_their_own_identity() {
        // `line()` carries no message id, request id or uuid: each is its own response,
        // never merged with its neighbour.
        let text = [
            line("2026-09-09T10:00:00Z", "/r/app", "Explore", "claude-opus-5", 4),
            line("2026-09-09T10:00:00Z", "/r/app", "Explore", "claude-opus-5", 4),
        ]
        .join("\n");
        let (cells, _) = fold(&text, FileKind::Helper);
        assert_eq!(cells[0].1.turns, 2);
        assert_eq!(cells[0].1.output_tokens, 8);
    }

    #[test]
    fn a_turn_without_attribution_is_counted_not_dropped() {
        let text = format!(
            r#"{{"type":"assistant","timestamp":"2026-09-09T10:00:00Z","cwd":"/r/app","message":{{"role":"assistant","model":"claude-opus-5","usage":{{"output_tokens":9}}}}}}"#
        );
        let (cells, _) = fold(&text, FileKind::Helper);
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].0.agent, UNATTRIBUTED);
        assert_eq!(cells[0].1.output_tokens, 9);
    }

    #[test]
    fn a_broken_assistant_line_is_counted_not_swallowed() {
        let text = [
            r#"{"type":"assistant","message":{"role":"assistant","model":"x""#.to_string(),
            line("2026-09-09T10:00:00Z", "/r/app", "Explore", "claude-opus-5", 4),
        ]
        .join("\n");
        let (cells, unparsed) = fold(&text, FileKind::Helper);
        assert_eq!(unparsed, 1, "a malformed turn must be reported, not silently skipped");
        assert_eq!(cells.len(), 1);
    }

    #[test]
    fn a_turn_with_an_unusable_timestamp_is_dropped() {
        let text = line("garbage", "/r/app", "Explore", "claude-opus-5", 4);
        let (cells, _) = fold(&text, FileKind::Helper);
        assert!(cells.is_empty());
    }

    /// A main-thread line as the CLI writes it into a session file: no `attributionAgent`,
    /// `isSidechain: false`.
    fn main_line(msg_id: &str, req_id: &str, model: &str, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":false,"requestId":"{req_id}","timestamp":"2026-09-09T10:00:00Z","cwd":"/r/app","message":{{"id":"{msg_id}","role":"assistant","model":"{model}","usage":{{"input_tokens":2,"output_tokens":{out},"cache_read_input_tokens":1000,"cache_creation_input_tokens":40}}}}}}"#
        )
    }

    #[test]
    fn a_session_file_turn_is_the_main_thread_with_no_helper_name() {
        let (cells, _) = fold(&main_line("msg_m", "req_m", "claude-opus-5-5", 120), FileKind::Session);
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].0.thread, SpendThread::Main);
        assert_eq!(cells[0].0.agent, "", "the main thread is not a sub-agent type");
        assert_eq!(cells[0].1.output_tokens, 120);
    }

    #[test]
    fn a_helper_file_turn_is_a_helper_whatever_its_flags_say() {
        let (cells, _) = fold(&main_line("msg_h", "req_h", "claude-haiku-4-5", 7), FileKind::Helper);
        assert_eq!(cells[0].0.thread, SpendThread::Helper);
        assert_eq!(cells[0].0.agent, UNATTRIBUTED);
    }

    #[test]
    fn an_inline_sidechain_line_in_a_session_file_is_a_helper() {
        // Older CLIs wrote helper turns into the session file itself, flagged as sidechain.
        let text = [
            main_line("msg_m", "req_m", "claude-opus-5", 50),
            r#"{"type":"assistant","isSidechain":true,"attributionAgent":"Explore","requestId":"req_s","timestamp":"2026-09-09T10:00:00Z","cwd":"/r/app","message":{"id":"msg_s","role":"assistant","model":"claude-haiku-4-5","usage":{"output_tokens":9}}}"#
                .to_string(),
        ]
        .join("\n");
        let (cells, _) = fold(&text, FileKind::Session);
        assert_eq!(cells.len(), 2);
        let helper = cells.iter().find(|(k, _)| k.thread == SpendThread::Helper).unwrap();
        assert_eq!(helper.0.agent, "Explore");
        assert_eq!(helper.1.output_tokens, 9);
        let main = cells.iter().find(|(k, _)| k.thread == SpendThread::Main).unwrap();
        assert_eq!(main.1.output_tokens, 50);
    }

    /// A fresh, empty projects directory under the system temp dir.
    fn temp_projects() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("flightdeck-agentspend-{}", uuid::Uuid::new_v4()))
            .join("projects");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn scan_in_reads_sessions_and_helpers_and_ignores_bookkeeping() {
        let projects = temp_projects();
        let slug = projects.join("-r-app");
        write(&slug.join("s1.jsonl"), &main_line("msg_1", "req_1", "claude-opus-5-5", 100));
        write(&slug.join("s1/subagents/agent-a1.jsonl"), &block_line("msg_2", "req_2", "u1", 30));
        // Workflow bookkeeping: a `.jsonl` deeper than the slug that is not an agent file.
        write(
            &slug.join("s1/subagents/workflows/wf_x/journal.jsonl"),
            &main_line("msg_3", "req_3", "claude-opus-5-5", 999),
        );
        let report = scan_in(&projects);
        assert_eq!(report.files_scanned, 2, "the journal is not a transcript");
        let main: u64 = report.buckets.iter().filter(|b| b.thread == SpendThread::Main).map(|b| b.output_tokens).sum();
        let helper: u64 = report.buckets.iter().filter(|b| b.thread == SpendThread::Helper).map(|b| b.output_tokens).sum();
        assert_eq!(main, 100);
        assert_eq!(helper, 30);
        std::fs::remove_dir_all(projects.parent().unwrap()).ok();
    }

    #[test]
    fn a_forked_session_does_not_bill_its_parents_history_twice() {
        let projects = temp_projects();
        let slug = projects.join("-r-app");
        let parent = [main_line("msg_1", "req_1", "claude-opus-5-5", 100), main_line("msg_2", "req_2", "claude-opus-5-5", 50)];
        write(&slug.join("parent.jsonl"), &parent.join("\n"));
        // The fork copies the parent's history, then goes on with a turn of its own.
        let fork = [parent[0].clone(), parent[1].clone(), main_line("msg_3", "req_3", "claude-opus-5-5", 7)];
        write(&slug.join("fork.jsonl"), &fork.join("\n"));
        let report = scan_in(&projects);
        let turns: u32 = report.buckets.iter().map(|b| b.turns).sum();
        let out: u64 = report.buckets.iter().map(|b| b.output_tokens).sum();
        assert_eq!(turns, 3, "two shared responses + one of the fork's own");
        assert_eq!(out, 157);
        std::fs::remove_dir_all(projects.parent().unwrap()).ok();
    }

    #[test]
    fn lines_without_an_api_identity_are_never_merged_across_files() {
        // `line()` carries no message/request id: each file's line is its own response, even
        // though both sit at index 0 — a file-local fallback key must stay file-local.
        let projects = temp_projects();
        let slug = projects.join("-r-app");
        let text = line("2026-09-09T10:00:00Z", "/r/app", "Explore", "claude-opus-5", 4);
        write(&slug.join("a/subagents/agent-1.jsonl"), &text);
        write(&slug.join("b/subagents/agent-2.jsonl"), &text);
        let report = scan_in(&projects);
        assert_eq!(report.buckets.iter().map(|b| b.turns).sum::<u32>(), 2);
        std::fs::remove_dir_all(projects.parent().unwrap()).ok();
    }

    #[test]
    fn a_rescan_after_an_append_counts_the_new_turn_once() {
        let projects = temp_projects();
        let file = projects.join("-r-app/s1.jsonl");
        write(&file, &main_line("msg_1", "req_1", "claude-opus-5-5", 100));
        assert_eq!(scan_in(&projects).buckets.iter().map(|b| b.turns).sum::<u32>(), 1);
        let grown = [main_line("msg_1", "req_1", "claude-opus-5-5", 100), main_line("msg_2", "req_2", "claude-opus-5-5", 5)];
        write(&file, &grown.join("\n"));
        let report = scan_in(&projects);
        assert_eq!(report.buckets.iter().map(|b| b.turns).sum::<u32>(), 2);
        assert_eq!(report.buckets.iter().map(|b| b.output_tokens).sum::<u64>(), 105);
        std::fs::remove_dir_all(projects.parent().unwrap()).ok();
    }

    #[test]
    fn missing_projects_dir_warns_instead_of_failing() {
        let report = scan_in(Path::new("/nonexistent/claude/projects"));
        assert!(report.buckets.is_empty());
        assert_eq!(report.files_scanned, 0);
        assert_eq!(report.warnings.len(), 1);
    }

    /// Scan the REAL corpus on this machine. Ignored by default (it depends on local
    /// transcripts); run with `cargo test --lib -- --ignored --nocapture`. Prints the
    /// per-model roll-up so it can be eyeballed against a known-good tally, and the wall
    /// clock — this is the number that decides whether the dashboard needs a spinner.
    #[test]
    #[ignore]
    fn live_scan_of_the_real_corpus() {
        let t0 = std::time::Instant::now();
        let report = scan();
        let cold = t0.elapsed();
        let t1 = std::time::Instant::now();
        let again = scan();
        let warm = t1.elapsed();

        println!(
            "files {} scanned / {} unreadable · {} unparsed lines · {} buckets",
            report.files_scanned, report.files_unreadable, report.lines_unparsed,
            report.buckets.len()
        );
        println!("cold {cold:?} · warm (cached) {warm:?}");

        let mut by_model: HashMap<&str, (u32, u64)> = HashMap::new();
        for b in &report.buckets {
            let e = by_model.entry(&b.model).or_default();
            e.0 += b.turns;
            e.1 += b.output_tokens;
        }
        let mut rows: Vec<_> = by_model.into_iter().collect();
        rows.sort_by_key(|(_, (_, out))| std::cmp::Reverse(*out));
        let mut total_turns = 0u32;
        let mut total_out = 0u64;
        for (model, (turns, out)) in &rows {
            println!("  {model:<32} {turns:>6} turns  {out:>10} out");
            total_turns += turns;
            total_out += out;
        }
        println!("  {:<32} {total_turns:>6} turns  {total_out:>10} out", "TOTAL");
        for thread in [SpendThread::Main, SpendThread::Helper] {
            let (turns, out) = report
                .buckets
                .iter()
                .filter(|b| b.thread == thread)
                .fold((0u32, 0u64), |(t, o), b| (t + b.turns, o + b.output_tokens));
            println!("  {:<32} {turns:>6} turns  {out:>10} out", format!("{thread:?}"));
        }

        let mut repos: Vec<&str> = report.buckets.iter().map(|b| b.repo_label.as_str()).collect();
        repos.sort_unstable();
        repos.dedup();
        println!("repos: {repos:?}");

        assert!(report.files_scanned > 0, "no transcripts found — is this the right machine?");
        assert_eq!(report.buckets, again.buckets, "the cached scan must match the cold one");
    }
}
