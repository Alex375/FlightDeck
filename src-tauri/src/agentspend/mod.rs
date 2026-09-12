//! Sub-agent spend — what the helper agents actually ran on, and how much they produced.
//!
//! ZERO instrumentation: the CLI already writes one JSON line per event into
//! `~/.claude/projects/<slug>/**/agent-*.jsonl`, and every `assistant` line carries the
//! three things this module needs — `message.model`, `message.usage`, and
//! `attributionAgent` (the sub-agent TYPE: `Explore`, `general-purpose`,
//! `workflow-subagent`). We only read.
//!
//! ## Why a flat bucket list rather than a query API
//!
//! Measured on a real corpus (931 files, 194 MiB, 24 066 assistant turns spanning 20
//! active days): the whole thing collapses to **50** distinct
//! `(day, repo, agent, model, workflow)` buckets. So one scan returns everything and the
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;

/// The sub-agent name recorded when a turn carries no `attributionAgent`. Rare (4 lines
/// in 1467 sampled) but real, and hiding those turns would understate the total.
pub const UNATTRIBUTED: &str = "unknown";

/// One aggregated cell of the spend cube. Every number is a SUM over the turns that
/// share the five key fields.
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
    /// The sub-agent type: `Explore`, `general-purpose`, `workflow-subagent`, … or
    /// [`UNATTRIBUTED`].
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

/// Per-file scan result, cached so re-opening the page does not re-read 194 MiB.
#[derive(Debug, Clone)]
struct CachedFile {
    size: u64,
    mtime_ms: i64,
    cells: Vec<(BucketKey, Counts)>,
    lines_unparsed: u32,
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

/// Testable core: aggregate every `agent-*.jsonl` under `projects_dir`.
pub fn scan_in(projects_dir: &Path) -> SpendReport {
    let mut report = SpendReport::default();
    if !projects_dir.is_dir() {
        report
            .warnings
            .push(format!("no transcripts directory at {}", projects_dir.display()));
        return report;
    }

    let mut files = Vec::new();
    collect_agent_files(projects_dir, &mut files, 0);

    // Repo roots are resolved by walking the filesystem, so memoize per distinct cwd —
    // a corpus of ~1000 files typically holds a dozen distinct working directories.
    let mut repo_cache: HashMap<String, String> = HashMap::new();
    let mut totals: HashMap<BucketKey, Counts> = HashMap::new();

    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);

    for path in files {
        let stamp = file_stamp(&path);
        if let Some((size, mtime_ms)) = stamp {
            if let Some(hit) = cache.get(&path) {
                if hit.size == size && hit.mtime_ms == mtime_ms {
                    for (key, counts) in &hit.cells {
                        totals.entry(key.clone()).or_default().add(counts);
                    }
                    report.files_scanned += 1;
                    report.lines_unparsed += hit.lines_unparsed;
                    continue;
                }
            }
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            report.files_unreadable += 1;
            continue;
        };
        let workflow = is_workflow_path(&path);
        let (cells, unparsed) = scan_file(&text, workflow, &mut repo_cache);
        for (key, counts) in &cells {
            totals.entry(key.clone()).or_default().add(counts);
        }
        report.files_scanned += 1;
        report.lines_unparsed += unparsed;
        if let Some((size, mtime_ms)) = stamp {
            cache.insert(path, CachedFile { size, mtime_ms, cells, lines_unparsed: unparsed });
        }
    }

    report.buckets = totals
        .into_iter()
        .map(|(key, counts)| SpendBucket {
            repo_label: label_for(&key.repo),
            day: key.day,
            repo: key.repo,
            agent: key.agent,
            model: key.model,
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
        (&a.day, &a.repo, &a.agent, &a.model, a.workflow)
            .cmp(&(&b.day, &b.repo, &b.agent, &b.model, b.workflow))
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
    #[serde(borrow)]
    message: Option<TurnMessage<'a>>,
}

#[derive(Deserialize)]
struct TurnMessage<'a> {
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
fn scan_file(
    text: &str,
    workflow: bool,
    repo_cache: &mut HashMap<String, String>,
) -> (Vec<(BucketKey, Counts)>, u32) {
    let mut cells: HashMap<BucketKey, Counts> = HashMap::new();
    let mut unparsed = 0u32;
    for line in text.lines() {
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
        let agent = turn.attribution_agent.filter(|s| !s.is_empty()).unwrap_or(UNATTRIBUTED);

        let usage = message.usage.unwrap_or_default();
        let key = BucketKey {
            day: day.to_string(),
            repo,
            agent: agent.to_string(),
            model: model.to_string(),
            workflow,
        };
        let entry = cells.entry(key).or_default();
        entry.turns += 1;
        entry.input_tokens += usage.input_tokens;
        entry.output_tokens += usage.output_tokens;
        entry.cache_read_tokens += usage.cache_read_input_tokens;
        entry.cache_creation_tokens += usage.cache_creation_input_tokens;
    }
    (cells.into_iter().collect(), unparsed)
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

/// Recursively gather `agent-*.jsonl` files. Depth-bounded: the tree is
/// `projects/<slug>/<session>/subagents[/workflows/wf_<id>]/`, so 6 is generous, and a
/// bound means a symlink loop cannot hang the scan.
fn collect_agent_files(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
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
            collect_agent_files(&path, out, depth + 1);
        } else if kind.is_file() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("agent-") && name.ends_with(".jsonl") {
                out.push(path);
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
        let mut memo = HashMap::new();
        let (cells, unparsed) = scan_file(&text, false, &mut memo);
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
        let mut memo = HashMap::new();
        let (cells, unparsed) = scan_file(&text, false, &mut memo);
        assert_eq!(unparsed, 0);
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].0.model, "claude-opus-5");
        assert_eq!(cells[0].1.turns, 1);
    }

    #[test]
    fn a_turn_without_attribution_is_counted_not_dropped() {
        let text = format!(
            r#"{{"type":"assistant","timestamp":"2026-09-09T10:00:00Z","cwd":"/r/app","message":{{"role":"assistant","model":"claude-opus-5","usage":{{"output_tokens":9}}}}}}"#
        );
        let mut memo = HashMap::new();
        let (cells, _) = scan_file(&text, false, &mut memo);
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
        let mut memo = HashMap::new();
        let (cells, unparsed) = scan_file(&text, false, &mut memo);
        assert_eq!(unparsed, 1, "a malformed turn must be reported, not silently skipped");
        assert_eq!(cells.len(), 1);
    }

    #[test]
    fn a_turn_with_an_unusable_timestamp_is_dropped() {
        let text = line("garbage", "/r/app", "Explore", "claude-opus-5", 4);
        let mut memo = HashMap::new();
        let (cells, _) = scan_file(&text, false, &mut memo);
        assert!(cells.is_empty());
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

        let mut repos: Vec<&str> = report.buckets.iter().map(|b| b.repo_label.as_str()).collect();
        repos.sort_unstable();
        repos.dedup();
        println!("repos: {repos:?}");

        assert!(report.files_scanned > 0, "no transcripts found — is this the right machine?");
        assert_eq!(report.buckets, again.buckets, "the cached scan must match the cold one");
    }
}
