//! Global "search everything" — the ONE full-text search service of the app: the contents
//! of the files under local folders (the selected repos + user-added folders) and the prose
//! of the Claude / Codex conversations whose cwd lies under those folders.
//!
//! Same encapsulation rule as `fs/` or `git/`: the IPC layer calls [`run`] with a
//! [`SearchTicket`] taken from the managed [`GlobalSearch`] state and owns nothing else.
//!
//! ## Query
//! One `regex::Regex` per search: a literal pattern is escaped, a regex one is used as-is;
//! case and whole-word are builder flags / `\b` wrappers. `multi_line` is always on so `^` /
//! `$` are LINE anchors, and `crlf` so a Windows line ending never defeats `$`. A
//! zero-length match (`a*`, `^`) is never a hit.
//!
//! ## Files
//! Each root is walked by ripgrep's own walker (`ignore`), in parallel, honouring
//! `.gitignore` / `.ignore` / the global git excludes — what a repo declares as noise is noise
//! here too, exactly like `rg` and VS Code. Hidden files ARE searched; VCS internals,
//! `node_modules` ([`SKIPPED_DIRS`]) and the app's git worktrees (`.claude/worktrees/`, each a
//! full copy of the repo that would duplicate every hit) never are. Files are matched line by
//! line, so a match never spans lines. Every file we could not read is COUNTED
//! (`unreadable_files`), every root we could not walk is NAMED with a reason
//! (`skipped_roots`): a "no result" must never hide a failure.
//!
//! ## Conversations
//! The candidates are exactly the conversations the History panel lists (same scanners, same
//! noise / sub-agent filters), kept when their cwd lies under a root. Only main-thread human
//! prompts and assistant prose are searched — the same per-message extractors the History
//! index uses, never tool output or thinking. Rows and extracted messages are cached per
//! transcript file, keyed by (mtime, size), so a typing-driven search re-reads nothing that
//! did not change.
//!
//! ## Supersede / cancel
//! Every search takes a new generation; a newer search (or `cancel_global_search`) bumps it,
//! and the workers — which re-check it per file / per conversation — stop as soon as they
//! notice and report `cancelled: true` (the caller drops such a result). A 15 s budget bounds
//! any single search; a cut-short result says so (`*_truncated`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use ignore::overrides::{Override, OverrideBuilder};
use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::supervisor::codex;
use crate::supervisor::history::{self, DiskConversation, SearchableMessage};

// ---- IPC contract ------------------------------------------------------------------------

/// What to look for.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct SearchQuery {
    pub pattern: String,
    /// `pattern` is a regular expression (Rust `regex` syntax) rather than literal text.
    pub is_regex: bool,
    pub match_case: bool,
    /// Only matches standing as a whole word.
    pub whole_word: bool,
}

/// One global search.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct GlobalSearchRequest {
    pub query: SearchQuery,
    /// Absolute LOCAL folder paths to search (selected repos + user-added folders).
    pub roots: Vec<String>,
    /// Search file contents under the roots.
    pub files: bool,
    /// Search conversation transcripts whose cwd lies under one of the roots.
    pub conversations: bool,
    /// VS Code-style comma-separated globs, relative to each root ("src/**, *.ts"). Empty =
    /// no filter. Files only.
    pub include: String,
    pub exclude: String,
}

/// The outcome of one global search.
#[derive(Debug, Clone, Default, Serialize, Type)]
pub struct GlobalSearchResult {
    pub files: Vec<FileHits>,
    pub conversations: Vec<ConversationHits>,
    /// Total matches found in files (even beyond what is returned).
    pub file_match_count: u32,
    /// Total matches found in conversations (even beyond what is returned).
    pub conversation_match_count: u32,
    /// Text files whose contents were searched.
    pub files_scanned: u32,
    /// Conversations (under a root) whose messages were searched.
    pub conversations_scanned: u32,
    /// A cap or the time budget cut the file results short.
    pub files_truncated: bool,
    /// A cap or the time budget cut the conversation results short.
    pub conversations_truncated: bool,
    /// Roots the FILE search could not walk, each with a human reason.
    pub skipped_roots: Vec<SkippedRoot>,
    /// Files (or folders) that failed to open/read — permission, I/O. Surfaced, never silent.
    pub unreadable_files: u32,
    /// Files over the size cap (4 MiB), not searched.
    pub large_files_skipped: u32,
    /// Conversation transcripts (Claude) / rollouts (Codex) that failed to open or read, so
    /// could not be searched — they may hold matches. Surfaced, never silent.
    pub unreadable_conversations: u32,
    /// Superseded by a newer search or `cancel_global_search`: the caller drops it.
    pub cancelled: bool,
    pub elapsed_ms: u32,
}

/// A requested root the file search could not walk.
#[derive(Debug, Clone, Serialize, Type)]
pub struct SkippedRoot {
    pub path: String,
    pub reason: String,
}

/// The matches found in one file.
#[derive(Debug, Clone, Serialize, Type)]
pub struct FileHits {
    /// The requested root (as sent) this file was found under.
    pub root: String,
    /// Absolute path.
    pub path: String,
    /// `/`-separated, relative to `root`.
    pub rel_path: String,
    /// At most 100 matching lines.
    pub lines: Vec<LineHit>,
    /// Every match in the file, including lines beyond those returned.
    pub match_count: u32,
}

/// One matching line of a file.
#[derive(Debug, Clone, Serialize, Type)]
pub struct LineHit {
    /// 1-based line number.
    pub line: u32,
    /// 1-based column of the line's FIRST match, in UTF-16 code units (Monaco's columns).
    pub column: u32,
    /// The line (no newline / CR), windowed with `…` markers when long.
    pub preview: String,
    /// Match spans inside `preview`, UTF-16 offsets, `[start, end)`.
    pub ranges: Vec<HitRange>,
}

/// A `[start, end)` span in UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct HitRange {
    pub start: u32,
    pub end: u32,
}

/// The matches found in one conversation.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ConversationHits {
    pub session_id: String,
    /// `"claude"` | `"codex"`.
    pub backend: String,
    pub title: Option<String>,
    pub excerpt: String,
    pub cwd: String,
    pub repo_root: String,
    /// The requested root (as sent) the conversation's cwd lies under — the most specific
    /// one when several nest.
    pub root: String,
    pub mtime_ms: i64,
    /// At most 20 matching messages.
    pub hits: Vec<MessageHit>,
    /// Every match in the conversation, including messages beyond those returned.
    pub match_count: u32,
}

/// One matching message of a conversation.
#[derive(Debug, Clone, Serialize, Type)]
pub struct MessageHit {
    /// `"user"` | `"assistant"`.
    pub role: String,
    /// 0-based index among the conversation's SEARCHABLE messages (human prompts +
    /// assistant prose, in transcript order).
    pub message_index: u32,
    /// The message, whitespace flattened, windowed around its first match.
    pub preview: String,
    /// Match spans inside `preview`, UTF-16 offsets, `[start, end)`.
    pub ranges: Vec<HitRange>,
}

// ---- Limits ------------------------------------------------------------------------------

/// Wall-clock budget of one search, files and conversations together.
const TIME_BUDGET: Duration = Duration::from_secs(15);
/// Files larger than this are not searched (counted in `large_files_skipped`): a generated
/// bundle / dump / lockfile of that size is noise, and reading it costs the whole search.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// A NUL byte in this prefix marks a file as binary — the editor's own rule (`fs::read_file`).
const BINARY_SNIFF_BYTES: usize = 8192;
const MAX_LINES_PER_FILE: usize = 100;
const MAX_FILES_WITH_HITS: usize = 1000;
const MAX_LINES_TOTAL: usize = 5000;
const MAX_HITS_PER_CONVERSATION: usize = 20;
const MAX_CONVERSATIONS_WITH_HITS: usize = 300;
/// Longest line shown whole; a longer one is windowed around its first match.
const LINE_PREVIEW_CHARS: usize = 240;
/// Longest (flattened) message shown whole; a longer one is windowed around its first match.
const MESSAGE_PREVIEW_CHARS: usize = 160;
/// How much context a windowed preview keeps BEFORE the first match.
const PREVIEW_LEAD_CHARS: usize = 60;
/// Match spans kept per line / message for highlighting. A preview window holds at most
/// [`LINE_PREVIEW_CHARS`] chars, so it can never show more non-empty spans than this; the
/// COUNT keeps going past it.
const PREVIEW_SPAN_CAP: usize = 512;
/// Upper bound on the threads extracting conversations in parallel.
const MAX_CONVERSATION_WORKERS: usize = 8;

/// Directory names the file search never descends into, whatever the ignore files say: VCS
/// internals (a `.git` FILE in a linked worktree too) and `node_modules` — VS Code's default
/// `search.exclude`, and the biggest cost in a folder that has no `.gitignore`. Build output
/// (`target`, `dist`, `build`…) is deliberately NOT listed, unlike the editor watcher's
/// `fs::IGNORED_DIRS`: a repo already gitignores its own, and a repo that COMMITS a `build/`
/// keeps real sources there (VS Code's own repo does) — hard-skipping it would silently hide
/// matches, which is worse than scanning it.
const SKIPPED_DIRS: &[&str] = &[".git", ".hg", ".svn", ".jj", "node_modules"];

// ---- Managed state ---------------------------------------------------------------------------

/// Tauri managed state of the global search: the supersede counter and the per-transcript
/// conversation cache. Cheap to share — everything lives behind one `Arc`.
#[derive(Default)]
pub struct GlobalSearch {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Bumped by every new search and by every cancel; a search whose generation is no longer
    /// current stops.
    generation: AtomicU64,
    /// Per transcript file: its listing row and (lazily) its searchable messages.
    conv_cache: Mutex<HashMap<PathBuf, CachedConversation>>,
}

/// One transcript's cached scan, valid while the file keeps the same (mtime, size).
struct CachedConversation {
    mtime_ms: i64,
    len: u64,
    /// The History-panel row; `None` = noise (no human message) — not a conversation.
    row: Option<Arc<DiskConversation>>,
    /// Filled on the first search that needs the full text.
    messages: Option<Arc<Vec<SearchableMessage>>>,
}

/// One search's claim on the current generation. Taken synchronously when the command starts,
/// so a newer search supersedes an older one in invocation order.
pub struct SearchTicket {
    inner: Arc<Inner>,
    generation: u64,
}

impl GlobalSearch {
    /// An idle search service with an empty cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a search: supersede whatever is in flight and claim the new generation.
    pub fn begin(&self) -> SearchTicket {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        SearchTicket {
            inner: self.inner.clone(),
            generation,
        }
    }

    /// Stop the in-flight search (if any) as soon as its workers notice.
    pub fn cancel(&self) {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
    }
}

impl SearchTicket {
    /// A newer search or a cancel took over: stop and report `cancelled`.
    fn superseded(&self) -> bool {
        self.inner.generation.load(Ordering::SeqCst) != self.generation
    }
}

/// Lock a mutex, recovering the data if a panicking holder poisoned it (a cache is still
/// usable; refusing to search because of it would be worse).
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where the conversation transcripts live: the env-resolved dirs in the app, temp dirs in
/// tests.
struct ConversationSources {
    claude_config_dir: Option<PathBuf>,
    codex_sessions_dir: Option<PathBuf>,
}

impl ConversationSources {
    fn from_env() -> Self {
        ConversationSources {
            claude_config_dir: history::claude_config_dir(),
            codex_sessions_dir: codex::codex_sessions_dir(),
        }
    }
}

// ---- Entry point -----------------------------------------------------------------------------

/// Run one global search to completion (blocking — call it off the async runtime). An empty
/// pattern, no roots, or no scope yields an empty result. `Err` only for an invalid query:
/// a bad regular expression or a bad include/exclude glob.
pub fn run(ticket: &SearchTicket, request: &GlobalSearchRequest) -> Result<GlobalSearchResult, String> {
    run_with(ticket, request, &ConversationSources::from_env())
}

fn run_with(
    ticket: &SearchTicket,
    request: &GlobalSearchRequest,
    sources: &ConversationSources,
) -> Result<GlobalSearchResult, String> {
    let started = Instant::now();
    let mut result = GlobalSearchResult::default();
    if request.query.pattern.trim().is_empty()
        || request.roots.is_empty()
        || (!request.files && !request.conversations)
    {
        result.elapsed_ms = to_u32(started.elapsed().as_millis());
        return Ok(result);
    }

    let query = CompiledQuery::new(&request.query)?;
    let file_plans = if request.files {
        let filters = FileFilters::parse(&request.include, &request.exclude)?;
        let (plans, skipped) = plan_file_roots(&request.roots, &filters)?;
        result.skipped_roots = skipped;
        Some(plans)
    } else {
        None
    };
    let conv_roots = request
        .conversations
        .then(|| conversation_roots(&request.roots));

    if ticket.superseded() {
        result.cancelled = true;
        result.elapsed_ms = to_u32(started.elapsed().as_millis());
        return Ok(result);
    }

    let deadline = started + TIME_BUDGET;
    let (files, conversations) = std::thread::scope(|scope| -> Result<_, String> {
        // Both scopes at once: the file walk on its own thread (it fans out further), the
        // conversations on this one. A failed spawn just runs the walk inline afterwards.
        let files_thread = match (&file_plans, &conv_roots) {
            (Some(plans), Some(_)) => std::thread::Builder::new()
                .name("global-search-files".to_string())
                .spawn_scoped(scope, || search_files(plans, &query, ticket, deadline))
                .map_err(|e| {
                    eprintln!("[search] cannot start the file-search thread, searching inline: {e}")
                })
                .ok(),
            _ => None,
        };
        let conversations = conv_roots
            .as_deref()
            .map(|roots| search_conversations(ticket, sources, roots, &query, deadline));
        let files = match files_thread {
            Some(handle) => Some(
                handle
                    .join()
                    .map_err(|_| "Search failed: the file search worker crashed".to_string())?,
            ),
            None => file_plans
                .as_deref()
                .map(|plans| search_files(plans, &query, ticket, deadline)),
        };
        Ok((files, conversations))
    })?;

    let mut cancelled = ticket.superseded();
    if let Some(f) = files {
        result.files = f.files;
        result.file_match_count = to_u32(f.match_count);
        result.files_scanned = f.scanned;
        result.files_truncated = f.truncated;
        result.unreadable_files = f.unreadable;
        result.large_files_skipped = f.large;
        cancelled |= f.cancelled;
    }
    if let Some(c) = conversations {
        result.conversations = c.conversations;
        result.conversation_match_count = to_u32(c.match_count);
        result.conversations_scanned = c.scanned;
        result.conversations_truncated = c.truncated;
        result.unreadable_conversations = c.unreadable;
        cancelled |= c.cancelled;
    }
    result.cancelled = cancelled;
    result.elapsed_ms = to_u32(started.elapsed().as_millis());
    Ok(result)
}

// ---- Query -------------------------------------------------------------------------------------

/// The compiled query, shared read-only by every worker (`Regex` is `Sync`).
struct CompiledQuery {
    re: Regex,
    /// Whether a whole-text `is_match` may rule a file out before the per-line scan. True
    /// unless the pattern could match a LINE but not the whole text: text anchors (`\A`, `\z`)
    /// or inline flags (`(?-m)` would turn `^` back into a text anchor).
    whole_text_precheck: bool,
}

impl CompiledQuery {
    fn new(query: &SearchQuery) -> Result<Self, String> {
        let mut pattern = if query.is_regex {
            query.pattern.clone()
        } else {
            regex::escape(&query.pattern)
        };
        if query.whole_word {
            if query.is_regex {
                pattern = format!(r"\b(?:{pattern})\b");
            } else {
                // A boundary only on an edge that IS a word char: `\bfoo(\b` would demand a
                // word char right after the `(`, so "foo(" would never match as a whole word.
                if query.pattern.chars().next().is_some_and(is_word_char) {
                    pattern = format!(r"\b{pattern}");
                }
                if query.pattern.chars().next_back().is_some_and(is_word_char) {
                    pattern.push_str(r"\b");
                }
            }
        }
        let re = RegexBuilder::new(&pattern)
            .case_insensitive(!query.match_case)
            .multi_line(true)
            .crlf(true)
            .build()
            .map_err(|e| format!("Invalid regular expression: {e}"))?;
        let whole_text_precheck = !query.is_regex
            || !(query.pattern.contains(r"\A")
                || query.pattern.contains(r"\z")
                || query.pattern.contains("(?"));
        Ok(CompiledQuery {
            re,
            whole_text_precheck,
        })
    }
}

/// A "word" char for whole-word edges — the regex crate's Unicode `\w` in practice.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Every non-empty match of `re` in `hay`: the count, and the first [`PREVIEW_SPAN_CAP`] byte
/// spans. Zero-length matches (`a*` between letters, a bare `^`) are not hits.
fn find_spans(re: &Regex, hay: &str) -> (u32, Vec<(usize, usize)>) {
    let mut count = 0u32;
    let mut spans = Vec::new();
    for m in re.find_iter(hay) {
        if m.start() == m.end() {
            continue;
        }
        count = count.saturating_add(1);
        if spans.len() < PREVIEW_SPAN_CAP {
            spans.push((m.start(), m.end()));
        }
    }
    (count, spans)
}

// ---- Include / exclude globs ------------------------------------------------------------------

/// One glob as the user typed it, plus the gitignore-syntax globs it expands to.
struct UserGlob {
    original: String,
    expanded: Vec<String>,
}

/// The parsed include / exclude filters, validated once and compiled per root (their globs are
/// relative to each root).
struct FileFilters {
    include: Vec<UserGlob>,
    exclude: Vec<UserGlob>,
}

impl FileFilters {
    /// Parse both comma-separated lists; `Err` names the first invalid glob.
    fn parse(include: &str, exclude: &str) -> Result<Self, String> {
        let filters = FileFilters {
            include: parse_globs(include),
            exclude: parse_globs(exclude),
        };
        // Validate up front, independent of any root: a bad glob is an error even when every
        // root turns out to be unreadable.
        filters.compile_for(Path::new("/"))?;
        Ok(filters)
    }

    /// The (include, exclude) matchers for one root; `None` when that list is empty.
    fn compile_for(&self, root: &Path) -> Result<(Option<Override>, Option<Override>), String> {
        Ok((
            compile_globs(root, &self.include, false)?,
            compile_globs(root, &self.exclude, true)?,
        ))
    }
}

fn parse_globs(list: &str) -> Vec<UserGlob> {
    split_globs(list)
        .into_iter()
        .map(|original| UserGlob {
            expanded: expand_glob(&original),
            original,
        })
        .collect()
}

/// Split a VS Code-style list on commas — but not on the commas of a `{a,b}` alternation.
fn split_globs(list: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    for ch in list.chars() {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' if depth == 0 => {
                let glob = current.trim();
                if !glob.is_empty() {
                    out.push(glob.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let glob = current.trim();
    if !glob.is_empty() {
        out.push(glob.to_string());
    }
    out
}

/// VS Code semantics in gitignore syntax: a glob WITHOUT a `/` matches at any depth (`**/`
/// prefix), one with a `/` is relative to the root (`./x` is spelled `/x`), and a glob naming a
/// folder also covers everything inside it (`x` → `x` + `x/**`).
fn expand_glob(glob: &str) -> Vec<String> {
    let glob = match glob.strip_prefix("./") {
        Some(rest) => format!("/{rest}"),
        None => glob.to_string(),
    };
    let glob = glob.trim_end_matches('/');
    if glob.is_empty() {
        return Vec::new();
    }
    let base = if glob.contains('/') {
        glob.to_string()
    } else {
        format!("**/{glob}")
    };
    if base.ends_with("**") {
        vec![base]
    } else {
        vec![base.clone(), format!("{base}/**")]
    }
}

/// Compile `globs` into an override matcher rooted at `root` — whitelist globs for an include
/// list, `!globs` for an exclude list. `None` for an empty list.
fn compile_globs(root: &Path, globs: &[UserGlob], negate: bool) -> Result<Option<Override>, String> {
    if globs.is_empty() {
        return Ok(None);
    }
    let mut builder = OverrideBuilder::new(root);
    for glob in globs {
        for expanded in &glob.expanded {
            let line = if negate {
                format!("!{expanded}")
            } else {
                expanded.clone()
            };
            builder.add(&line).map_err(|e| glob_error(&glob.original, e))?;
        }
    }
    let all = globs
        .iter()
        .map(|g| g.original.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    builder.build().map(Some).map_err(|e| glob_error(&all, e))
}

fn glob_error(original: &str, err: ignore::Error) -> String {
    let message = match err {
        ignore::Error::Glob { err, .. } => err,
        other => other.to_string(),
    };
    format!("Invalid glob '{original}': {message}")
}

// ---- File search -------------------------------------------------------------------------------

/// A requested root that exists and can be walked.
struct FileRoot {
    /// Position in the request — the primary sort key of the file results.
    order: usize,
    /// The path as the caller sent it, echoed back in [`FileHits::root`].
    given: String,
    /// Normalized (no trailing `/`): the walk root.
    path: PathBuf,
    /// Symlinks resolved: what nesting / duplicates are judged on.
    canonical: PathBuf,
}

/// How to walk one root.
struct FilePlan {
    root: FileRoot,
    include: Option<Override>,
    exclude: Option<Override>,
    /// Canonical paths of the OTHER searched roots strictly inside this one: this walk prunes
    /// them (they are walked as roots of their own), so nothing is reported twice and each hit
    /// is attributed to its most specific root — with that root's own globs and rules.
    nested: Vec<PathBuf>,
    /// The root is (inside) an app worktree: do not prune `.claude/worktrees/` below it.
    in_worktree: bool,
    /// The root is inside a git repository. Gitignore rules then apply the way git (and `rg`)
    /// apply them — stopping at the repo boundary. Outside any repo they are honoured anyway
    /// (`require_git(false)`), but NOT inside one: there `require_git(false)` would also let an
    /// ancestor's `.gitignore` (e.g. a dotfiles home with `*`) leak across the repo boundary and
    /// silently hide everything.
    in_repo: bool,
}

/// Strip trailing slashes (`/` itself stays `/`).
fn normalize_root(root: &str) -> String {
    let trimmed = root.trim_end_matches('/');
    if trimmed.is_empty() && root.starts_with('/') {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Validate a requested root for the file walk: `Ok((path, canonical))` or a human reason.
fn resolve_file_root(given: &str) -> Result<(PathBuf, PathBuf), String> {
    let normalized = normalize_root(given);
    if normalized.is_empty() {
        return Err("Empty path".to_string());
    }
    let path = PathBuf::from(&normalized);
    if !path.is_absolute() {
        return Err("Not an absolute path".to_string());
    }
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("Folder not found".to_string())
        }
        Err(e) => return Err(format!("Cannot access folder: {e}")),
    };
    if !meta.is_dir() {
        return Err("Not a folder".to_string());
    }
    // Listing it is what the walk needs — and what macOS privacy (TCC) refuses with
    // "Operation not permitted", which must read as a reason, not as "no match".
    if let Err(e) = std::fs::read_dir(&path) {
        return Err(format!("Cannot read folder: {e}"));
    }
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    Ok((path, canonical))
}

/// Resolve the requested roots into walk plans (request order kept, the same folder twice
/// walked once) and the roots that cannot be walked.
fn plan_file_roots(
    roots: &[String],
    filters: &FileFilters,
) -> Result<(Vec<FilePlan>, Vec<SkippedRoot>), String> {
    let mut resolved: Vec<FileRoot> = Vec::new();
    let mut skipped: Vec<SkippedRoot> = Vec::new();
    for (order, given) in roots.iter().enumerate() {
        match resolve_file_root(given) {
            Ok((path, canonical)) => {
                if !resolved.iter().any(|r| r.canonical == canonical) {
                    resolved.push(FileRoot {
                        order,
                        given: given.clone(),
                        path,
                        canonical,
                    });
                }
            }
            Err(reason) => {
                if !skipped.iter().any(|s| s.path == *given) {
                    skipped.push(SkippedRoot {
                        path: given.clone(),
                        reason,
                    });
                }
            }
        }
    }
    let nested_in = |outer: &FileRoot| -> Vec<PathBuf> {
        resolved
            .iter()
            .filter(|r| r.canonical != outer.canonical && r.canonical.starts_with(&outer.canonical))
            .map(|r| r.canonical.clone())
            .collect()
    };
    let mut plans = Vec::with_capacity(resolved.len());
    for root in &resolved {
        let (include, exclude) = filters.compile_for(&root.path)?;
        let in_worktree = [&root.path, &root.canonical].iter().any(|p| {
            let s = p.to_string_lossy();
            s.contains("/.claude/worktrees/") || s.ends_with("/.claude/worktrees")
        });
        let in_repo = root.canonical.ancestors().any(|a| a.join(".git").exists());
        plans.push(FilePlan {
            nested: nested_in(root),
            include,
            exclude,
            in_worktree,
            in_repo,
            root: FileRoot {
                order: root.order,
                given: root.given.clone(),
                path: root.path.clone(),
                canonical: root.canonical.clone(),
            },
        });
    }
    Ok((plans, skipped))
}

/// What the file search found.
struct FileOutcome {
    files: Vec<FileHits>,
    match_count: u64,
    scanned: u32,
    unreadable: u32,
    large: u32,
    truncated: bool,
    cancelled: bool,
}

/// Shared by every walker thread of one search.
struct FileCollector<'a> {
    query: &'a CompiledQuery,
    ticket: &'a SearchTicket,
    deadline: Instant,
    found: Mutex<FoundFiles>,
    match_count: AtomicU64,
    scanned: AtomicU32,
    unreadable: AtomicU32,
    large: AtomicU32,
    truncated: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Default)]
struct FoundFiles {
    /// (root order, hits) — sorted once the walk is over.
    files: Vec<(usize, FileHits)>,
    /// Lines returned so far, against [`MAX_LINES_TOTAL`].
    lines: usize,
}

fn search_files(
    plans: &[FilePlan],
    query: &CompiledQuery,
    ticket: &SearchTicket,
    deadline: Instant,
) -> FileOutcome {
    let collector = FileCollector {
        query,
        ticket,
        deadline,
        found: Mutex::new(FoundFiles::default()),
        match_count: AtomicU64::new(0),
        scanned: AtomicU32::new(0),
        unreadable: AtomicU32::new(0),
        large: AtomicU32::new(0),
        truncated: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
    };
    for plan in plans {
        if collector.stopped() {
            break;
        }
        build_walker(plan).run(|| {
            let collector = &collector;
            Box::new(move |entry| collector.visit(plan, entry))
        });
    }
    let found = collector
        .found
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut files = found.files;
    files.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.rel_path.cmp(&b.1.rel_path)));
    FileOutcome {
        files: files.into_iter().map(|(_, hits)| hits).collect(),
        match_count: collector.match_count.into_inner(),
        scanned: collector.scanned.into_inner(),
        unreadable: collector.unreadable.into_inner(),
        large: collector.large.into_inner(),
        truncated: collector.truncated.into_inner(),
        cancelled: collector.cancelled.into_inner(),
    }
}

/// The parallel walker for one root: ignore files honoured, hidden files included, symlinks
/// not followed, and [`keep_entry`] pruning what must never be searched.
fn build_walker(plan: &FilePlan) -> ignore::WalkParallel {
    let mut builder = WalkBuilder::new(&plan.root.path);
    builder
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(plan.in_repo)
        .follow_links(false);
    let filter = EntryFilter {
        root_path: plan.root.path.clone(),
        canonical: plan.root.canonical.clone(),
        nested: plan.nested.clone(),
        exclude: plan.exclude.clone(),
        in_worktree: plan.in_worktree,
    };
    builder.filter_entry(move |entry| filter.keep(entry));
    builder.build_parallel()
}

/// The walk-time pruning rules of one root (owned: the walker requires a `'static` filter).
struct EntryFilter {
    root_path: PathBuf,
    canonical: PathBuf,
    nested: Vec<PathBuf>,
    exclude: Option<Override>,
    in_worktree: bool,
}

impl EntryFilter {
    fn keep(&self, entry: &ignore::DirEntry) -> bool {
        if entry.depth() == 0 {
            return true;
        }
        let name = entry.file_name();
        if name.to_str().is_some_and(|n| SKIPPED_DIRS.contains(&n)) {
            return false;
        }
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        if is_dir {
            // `<repo>/.claude/worktrees/` holds the app's git worktrees — full copies of the repo.
            if !self.in_worktree
                && name == "worktrees"
                && entry
                    .path()
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|parent| parent == ".claude")
            {
                return false;
            }
            if !self.nested.is_empty() {
                if let Ok(rel) = entry.path().strip_prefix(&self.root_path) {
                    let canonical = self.canonical.join(rel);
                    if self.nested.iter().any(|n| *n == canonical) {
                        return false;
                    }
                }
            }
        }
        match &self.exclude {
            Some(exclude) => !exclude.matched(entry.path(), is_dir).is_ignore(),
            None => true,
        }
    }
}

/// One file's read, before matching.
enum FileRead {
    Text(Vec<u8>),
    /// Binary, vanished, too large or unreadable — already accounted for.
    Skip,
}

impl FileCollector<'_> {
    fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed) || self.truncated.load(Ordering::Relaxed)
    }

    fn visit(&self, plan: &FilePlan, entry: Result<ignore::DirEntry, ignore::Error>) -> WalkState {
        if self.stopped() {
            return WalkState::Quit;
        }
        if self.ticket.superseded() {
            self.cancelled.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        if Instant::now() >= self.deadline {
            self.truncated.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                // A folder we could not list hides its files: count it, never swallow it.
                eprintln!("[search] cannot read under {}: {err}", plan.root.path.display());
                self.unreadable.fetch_add(1, Ordering::Relaxed);
                return WalkState::Continue;
            }
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            return WalkState::Continue;
        }
        let path = entry.path();
        if let Some(include) = &plan.include {
            if include.matched(path, false).is_ignore() {
                return WalkState::Continue;
            }
        }
        let bytes = match self.read(path) {
            FileRead::Text(bytes) => bytes,
            FileRead::Skip => return WalkState::Continue,
        };
        self.scanned.fetch_add(1, Ordering::Relaxed);
        let text = String::from_utf8_lossy(&bytes);
        match search_text(&text, self.query) {
            Some(hits) => self.record(plan, path, hits),
            None => WalkState::Continue,
        }
    }

    /// Read a file for matching, accounting for every reason it is not searched.
    fn read(&self, path: &Path) -> FileRead {
        let size = match std::fs::metadata(path) {
            Ok(meta) => meta.len(),
            // Deleted between the listing and now: nothing left to miss.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FileRead::Skip,
            Err(e) => {
                eprintln!("[search] cannot stat {}: {e}", path.display());
                self.unreadable.fetch_add(1, Ordering::Relaxed);
                return FileRead::Skip;
            }
        };
        if size > MAX_FILE_BYTES {
            self.large.fetch_add(1, Ordering::Relaxed);
            return FileRead::Skip;
        }
        match std::fs::read(path) {
            Ok(bytes) if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) => FileRead::Skip,
            Ok(bytes) => FileRead::Text(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileRead::Skip,
            Err(e) => {
                eprintln!("[search] cannot read {}: {e}", path.display());
                self.unreadable.fetch_add(1, Ordering::Relaxed);
                FileRead::Skip
            }
        }
    }

    /// Keep one file's hits within the global caps; past them the search is truncated.
    fn record(&self, plan: &FilePlan, path: &Path, hits: TextHits) -> WalkState {
        self.match_count
            .fetch_add(u64::from(hits.match_count), Ordering::Relaxed);
        let mut found = lock(&self.found);
        if found.files.len() >= MAX_FILES_WITH_HITS || found.lines >= MAX_LINES_TOTAL {
            self.truncated.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        let mut lines = hits.lines;
        let room = MAX_LINES_TOTAL - found.lines;
        if lines.len() > room {
            lines.truncate(room);
            self.truncated.store(true, Ordering::Relaxed);
        }
        found.lines += lines.len();
        found.files.push((
            plan.root.order,
            FileHits {
                root: plan.root.given.clone(),
                path: path.to_string_lossy().into_owned(),
                rel_path: rel_path(&plan.root.path, path),
                lines,
                match_count: hits.match_count,
            },
        ));
        WalkState::Continue
    }
}

/// `path` relative to `root`, `/`-separated.
fn rel_path(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// The matching lines of one text file.
struct TextHits {
    lines: Vec<LineHit>,
    match_count: u32,
}

/// Match `text` line by line (`\n`, a trailing `\r` stripped). `None` when nothing matches.
fn search_text(text: &str, query: &CompiledQuery) -> Option<TextHits> {
    // A UTF-8 BOM is not part of line 1 for the editor (Monaco drops it): keep columns aligned.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // One whole-text pass rules out the (vast) majority of files cheaply. Sound with
    // `multi_line` + `crlf`: a match inside a line is also a match inside the text.
    if query.whole_text_precheck && !query.re.is_match(text) {
        return None;
    }
    let mut lines = Vec::new();
    let mut match_count = 0u32;
    for (index, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let (count, spans) = find_spans(&query.re, line);
        if count == 0 {
            continue;
        }
        match_count = match_count.saturating_add(count);
        if lines.len() < MAX_LINES_PER_FILE {
            lines.push(line_hit(index + 1, line, &spans));
        }
    }
    (match_count > 0).then_some(TextHits { lines, match_count })
}

fn line_hit(line_number: usize, line: &str, spans: &[(usize, usize)]) -> LineHit {
    let first = spans.first().map_or(0, |s| s.0);
    let (preview, ranges) = window_preview(line, spans, LINE_PREVIEW_CHARS);
    LineHit {
        line: to_u32(line_number),
        column: utf16_len(&line[..first]).saturating_add(1),
        preview,
        ranges,
    }
}

// ---- Conversation search -----------------------------------------------------------------------

/// A requested root as a cwd prefix: the path as sent, plus its symlink-resolved form when it
/// differs (a transcript records the cwd the CLI saw).
struct ConvRoot {
    given: String,
    prefixes: Vec<String>,
}

fn conversation_roots(roots: &[String]) -> Vec<ConvRoot> {
    let mut out: Vec<ConvRoot> = Vec::new();
    for given in roots {
        let normalized = normalize_root(given);
        if normalized.is_empty() || out.iter().any(|r| r.prefixes[0] == normalized) {
            continue;
        }
        let mut prefixes = vec![normalized.clone()];
        if let Ok(canonical) = std::fs::canonicalize(&normalized) {
            let canonical = canonical.to_string_lossy().into_owned();
            if canonical != normalized {
                prefixes.push(canonical);
            }
        }
        out.push(ConvRoot {
            given: given.clone(),
            prefixes,
        });
    }
    out
}

/// `path` is `root` or lies below it — on a `/` boundary, so `/a/repo2` is NOT under `/a/repo`.
fn path_is_under(path: &str, root: &str) -> bool {
    if root == "/" {
        return path.starts_with('/');
    }
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

/// The root a cwd lies under — the most specific (longest) one when several nest.
fn root_for_cwd<'a>(cwd: &str, roots: &'a [ConvRoot]) -> Option<&'a ConvRoot> {
    let mut best: Option<(&ConvRoot, usize)> = None;
    for root in roots {
        for prefix in &root.prefixes {
            if path_is_under(cwd, prefix) && best.is_none_or(|(_, len)| prefix.len() > len) {
                best = Some((root, prefix.len()));
            }
        }
    }
    best.map(|(root, _)| root)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Backend {
    Claude,
    Codex,
}

/// One transcript on disk, stat'ed once per search (its cache key).
struct ConvFile {
    path: PathBuf,
    backend: Backend,
    mtime_ms: i64,
    len: u64,
}

/// Every transcript of both backends, most recent first (so a time-cut search keeps the most
/// recent conversations), and how many could not even be stat'ed (logged, counted in
/// `unreadable_conversations`).
fn conversation_files(sources: &ConversationSources) -> (Vec<ConvFile>, u32) {
    let mut paths: Vec<(PathBuf, Backend)> = Vec::new();
    if let Some(dir) = &sources.claude_config_dir {
        paths.extend(
            history::transcript_files_in(dir)
                .into_iter()
                .map(|p| (p, Backend::Claude)),
        );
    }
    if let Some(dir) = &sources.codex_sessions_dir {
        paths.extend(
            codex::rollout_files_in(dir)
                .into_iter()
                .map(|p| (p, Backend::Codex)),
        );
    }
    let mut unreadable = 0u32;
    let mut files: Vec<ConvFile> = paths
        .into_iter()
        .filter_map(|(path, backend)| match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => Some(ConvFile {
                mtime_ms: history::file_mtime_ms(&meta),
                len: meta.len(),
                path,
                backend,
            }),
            Ok(_) => None,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                eprintln!("[search] cannot stat transcript {}: {e}", path.display());
                unreadable = unreadable.saturating_add(1);
                None
            }
        })
        .collect();
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    (files, unreadable)
}

/// What the conversation search found.
struct ConversationOutcome {
    conversations: Vec<ConversationHits>,
    match_count: u64,
    scanned: u32,
    unreadable: u32,
    truncated: bool,
    cancelled: bool,
}

/// Shared by the conversation worker threads of one search.
struct ConversationWorker<'a> {
    ticket: &'a SearchTicket,
    roots: &'a [ConvRoot],
    query: &'a CompiledQuery,
    deadline: Instant,
    files: &'a [ConvFile],
    next: AtomicUsize,
    found: Mutex<Vec<ConversationHits>>,
    match_count: AtomicU64,
    scanned: AtomicU32,
    /// Transcripts that failed to open/read (stat failures are counted by the caller).
    unreadable: AtomicU32,
    truncated: AtomicBool,
    cancelled: AtomicBool,
}

fn search_conversations(
    ticket: &SearchTicket,
    sources: &ConversationSources,
    roots: &[ConvRoot],
    query: &CompiledQuery,
    deadline: Instant,
) -> ConversationOutcome {
    let (files, unstattable) = conversation_files(sources);
    // Evict what is no longer on disk, so the cache tracks the transcripts that exist.
    {
        let live: HashSet<&Path> = files.iter().map(|f| f.path.as_path()).collect();
        lock(&ticket.inner.conv_cache).retain(|path, _| live.contains(path.as_path()));
    }
    let worker = ConversationWorker {
        ticket,
        roots,
        query,
        deadline,
        files: &files,
        next: AtomicUsize::new(0),
        found: Mutex::new(Vec::new()),
        match_count: AtomicU64::new(0),
        scanned: AtomicU32::new(0),
        unreadable: AtomicU32::new(unstattable),
        truncated: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
    };
    let threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(1, MAX_CONVERSATION_WORKERS)
        .min(files.len().max(1));
    std::thread::scope(|scope| {
        for _ in 1..threads {
            let spawned = std::thread::Builder::new()
                .name("global-search-conversations".to_string())
                .spawn_scoped(scope, || worker.drain());
            if let Err(e) = spawned {
                // Fewer helpers only means a slower search: this thread drains the rest.
                eprintln!("[search] cannot start a conversation-search thread: {e}");
                break;
            }
        }
        worker.drain();
    });

    let mut conversations = worker
        .found
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    conversations.sort_by(|a, b| {
        b.mtime_ms
            .cmp(&a.mtime_ms)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    let mut truncated = worker.truncated.into_inner();
    if conversations.len() > MAX_CONVERSATIONS_WITH_HITS {
        conversations.truncate(MAX_CONVERSATIONS_WITH_HITS);
        truncated = true;
    }
    ConversationOutcome {
        conversations,
        match_count: worker.match_count.into_inner(),
        scanned: worker.scanned.into_inner(),
        unreadable: worker.unreadable.into_inner(),
        truncated,
        cancelled: worker.cancelled.into_inner(),
    }
}

impl ConversationWorker<'_> {
    /// Take conversations off the shared queue until it is empty or the search must stop.
    fn drain(&self) {
        loop {
            if self.cancelled.load(Ordering::Relaxed) || self.truncated.load(Ordering::Relaxed) {
                return;
            }
            if self.ticket.superseded() {
                self.cancelled.store(true, Ordering::Relaxed);
                return;
            }
            if Instant::now() >= self.deadline {
                self.truncated.store(true, Ordering::Relaxed);
                return;
            }
            let index = self.next.fetch_add(1, Ordering::Relaxed);
            let Some(file) = self.files.get(index) else {
                return;
            };
            if let Some(hits) = self.search_one(file) {
                lock(&self.found).push(hits);
            }
        }
    }

    fn search_one(&self, file: &ConvFile) -> Option<ConversationHits> {
        let (row, cached_messages) = self.cached_row(file);
        let row = row?;
        let root = root_for_cwd(&row.cwd, self.roots)?;
        self.scanned.fetch_add(1, Ordering::Relaxed);
        let messages = match cached_messages {
            Some(messages) => messages,
            None => {
                let read = match file.backend {
                    Backend::Claude => history::searchable_messages(&file.path),
                    Backend::Codex => codex::codex_searchable_messages(&file.path),
                };
                match read {
                    Ok(messages) => {
                        let messages = Arc::new(messages);
                        self.store_messages(file, messages.clone());
                        messages
                    }
                    Err(e) => {
                        eprintln!("[search] cannot read transcript {}: {e}", file.path.display());
                        self.unreadable.fetch_add(1, Ordering::Relaxed);
                        return None;
                    }
                }
            }
        };
        let (hits, match_count) = match_messages(&messages, &self.query.re);
        if match_count == 0 {
            return None;
        }
        self.match_count
            .fetch_add(u64::from(match_count), Ordering::Relaxed);
        Some(ConversationHits {
            session_id: row.session_id.clone(),
            backend: row.backend.clone(),
            title: row.title.clone(),
            excerpt: row.excerpt.clone(),
            cwd: row.cwd.clone(),
            repo_root: row.repo_root.clone(),
            root: root.given.clone(),
            mtime_ms: row.mtime_ms,
            hits,
            match_count,
        })
    }

    /// The listing row of `file` (and its messages when already extracted), from the cache
    /// when the file is unchanged, else head-scanned and cached. The scan runs OUTSIDE the
    /// lock; the stat it is keyed on was taken BEFORE it, so a concurrent write can only make
    /// the next search re-scan, never pin a stale row.
    #[allow(clippy::type_complexity)]
    fn cached_row(
        &self,
        file: &ConvFile,
    ) -> (Option<Arc<DiskConversation>>, Option<Arc<Vec<SearchableMessage>>>) {
        {
            let cache = lock(&self.ticket.inner.conv_cache);
            if let Some(entry) = cache.get(&file.path) {
                if entry.mtime_ms == file.mtime_ms && entry.len == file.len {
                    return (entry.row.clone(), entry.messages.clone());
                }
            }
        }
        let row = match file.backend {
            Backend::Claude => history::scan_disk_conversation(&file.path),
            Backend::Codex => codex::scan_codex_rollout(&file.path),
        }
        .map(Arc::new);
        // The scanners answer `None` both for noise (no human message) and for a file they
        // could not open. Tell the two apart: an unreadable transcript is counted — it may
        // hold matches — and NOT cached as noise, so the next search tries it again.
        if row.is_none() {
            match std::fs::File::open(&file.path) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (None, None),
                Err(e) => {
                    eprintln!("[search] cannot open transcript {}: {e}", file.path.display());
                    self.unreadable.fetch_add(1, Ordering::Relaxed);
                    return (None, None);
                }
            }
        }
        lock(&self.ticket.inner.conv_cache).insert(
            file.path.clone(),
            CachedConversation {
                mtime_ms: file.mtime_ms,
                len: file.len,
                row: row.clone(),
                messages: None,
            },
        );
        (row, None)
    }

    fn store_messages(&self, file: &ConvFile, messages: Arc<Vec<SearchableMessage>>) {
        let mut cache = lock(&self.ticket.inner.conv_cache);
        if let Some(entry) = cache.get_mut(&file.path) {
            if entry.mtime_ms == file.mtime_ms && entry.len == file.len {
                entry.messages = Some(messages);
            }
        }
    }
}

/// Match every message: at most [`MAX_HITS_PER_CONVERSATION`] previews, every match counted.
fn match_messages(messages: &[SearchableMessage], re: &Regex) -> (Vec<MessageHit>, u32) {
    let mut hits = Vec::new();
    let mut total = 0u32;
    for (index, message) in messages.iter().enumerate() {
        let (count, spans) = find_spans(re, &message.text);
        if count == 0 {
            continue;
        }
        total = total.saturating_add(count);
        if hits.len() < MAX_HITS_PER_CONVERSATION {
            let (flat, flat_spans) = flatten_with_spans(&message.text, &spans);
            let (preview, ranges) = window_preview(&flat, &flat_spans, MESSAGE_PREVIEW_CHARS);
            hits.push(MessageHit {
                role: message.role.as_str().to_string(),
                message_index: to_u32(index),
                preview,
                ranges,
            });
        }
    }
    (hits, total)
}

// ---- Previews ----------------------------------------------------------------------------------

/// Collapse every whitespace run of `text` to one space (trimmed at both ends — exactly
/// `split_whitespace().join(" ")`) and carry the byte `spans` over to the flat text. A span
/// keeps its own edges: it does not swallow the collapsed space before it, and one that was
/// only whitespace becomes empty and is dropped.
fn flatten_with_spans(text: &str, spans: &[(usize, usize)]) -> (String, Vec<(usize, usize)>) {
    let mut flat = String::with_capacity(text.len());
    let mut mapped = vec![(0usize, 0usize); spans.len()];
    let (mut next_start, mut next_end) = (0usize, 0usize);
    let mut pending_space = false;
    for (byte, ch) in text.char_indices() {
        while next_end < spans.len() && spans[next_end].1 <= byte {
            mapped[next_end].1 = flat.len();
            next_end += 1;
        }
        let space = ch.is_whitespace();
        while next_start < spans.len() && spans[next_start].0 <= byte {
            let space_first = !space && pending_space && !flat.is_empty();
            mapped[next_start].0 = flat.len() + usize::from(space_first);
            next_start += 1;
        }
        if space {
            pending_space = true;
            continue;
        }
        if pending_space && !flat.is_empty() {
            flat.push(' ');
        }
        pending_space = false;
        flat.push(ch);
    }
    for span in mapped.iter_mut().skip(next_end) {
        span.1 = flat.len();
    }
    for span in mapped.iter_mut().skip(next_start) {
        span.0 = flat.len();
    }
    let mapped = mapped.into_iter().filter(|(s, e)| s < e).collect();
    (flat, mapped)
}

/// `text` whole when it fits in `max_chars`, else a `max_chars` window starting
/// [`PREVIEW_LEAD_CHARS`] before the first span (pulled back to stay full near the end), with
/// `…` on each cut side. Byte `spans` (sorted, on char boundaries) come back as UTF-16 ranges
/// inside the returned preview, clipped to it.
fn window_preview(text: &str, spans: &[(usize, usize)], max_chars: usize) -> (String, Vec<HitRange>) {
    let total_chars = text.chars().count();
    let (start_byte, end_byte, cut_head, cut_tail) = if total_chars <= max_chars {
        (0, text.len(), false, false)
    } else {
        let first_byte = spans.first().map_or(0, |s| s.0);
        let first_char = text[..first_byte].chars().count();
        let start_char = first_char
            .saturating_sub(PREVIEW_LEAD_CHARS)
            .min(total_chars - max_chars);
        let end_char = start_char + max_chars;
        (
            byte_at_char(text, start_char),
            byte_at_char(text, end_char),
            start_char > 0,
            end_char < total_chars,
        )
    };
    let window = &text[start_byte..end_byte];
    let mut preview = String::with_capacity(window.len() + 6);
    if cut_head {
        preview.push('…');
    }
    preview.push_str(window);
    if cut_tail {
        preview.push('…');
    }
    // `…` (U+2026) is one UTF-16 unit.
    let shift = u32::from(cut_head);
    let ranges = spans
        .iter()
        .filter_map(|&(start, end)| {
            let start = start.clamp(start_byte, end_byte);
            let end = end.clamp(start_byte, end_byte);
            (start < end).then(|| HitRange {
                start: shift + utf16_len(&text[start_byte..start]),
                end: shift + utf16_len(&text[start_byte..end]),
            })
        })
        .collect();
    (preview, ranges)
}

/// Byte offset of char `index` in `text` (its length past the end).
fn byte_at_char(text: &str, index: usize) -> usize {
    text.char_indices().nth(index).map_or(text.len(), |(byte, _)| byte)
}

fn utf16_len(s: &str) -> u32 {
    to_u32(s.chars().map(char::len_utf16).sum::<usize>())
}

/// Saturating conversion to the IPC's `u32`.
fn to_u32<T: TryInto<u32>>(n: T) -> u32 {
    n.try_into().unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests;
