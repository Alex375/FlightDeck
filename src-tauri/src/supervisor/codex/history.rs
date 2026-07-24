//! Codex cold-history restore — rebuild a past Codex conversation from its on-disk
//! rollout, WITHOUT spawning an app-server. The Codex analogue of
//! [`crate::supervisor::history`] (which reads Claude's transcript).
//!
//! Codex records every thread as a JSON-lines "rollout" at
//! `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl` (default
//! `$CODEX_HOME` = `~/.codex`). The app-server's `thread/resume` DOES return the thread
//! inline, but its item view is LOSSY: it OMITS every tool execution (shell commands,
//! file edits) — verified against codex-cli 0.142.5. The raw rollout is the only
//! full-fidelity source, so we parse it directly (like the Claude backend reads its
//! transcript) and normalize into the shared [`ConversationItem`] model, so the UI
//! rebuilds the conversation identically to a live Codex session.
//!
//! ## Rollout wire (verified 0.142.5)
//! Each line is `{timestamp, type, payload}`. We map:
//!  - **Messages from `event_msg`** — `user_message{message}` (the REAL user text) →
//!    `UserMessage`; `agent_message{message}` (VERIFIED 1:1 with the assistant
//!    `response_item`) → an assistant `Text`. We do NOT read `response_item`'s `message`
//!    items: role=`developer` is injected `<permissions>`, role=`user` mixes the real
//!    text with an injected `<environment_context>`, so filtering by role is unsafe.
//!  - **Tools from `response_item`**, paired to their output by `call_id` — `function_call`
//!    (`exec_command`) → a `Bash` card; `custom_tool_call` (`apply_patch`) → an
//!    `ApplyPatch` card whose per-file diffs come from the structured
//!    `event_msg:patch_apply_end`; `web_search_call` → a `WebSearch` card.
//!  - Reasoning is `encrypted_content` (opaque) → dropped, as are the per-turn
//!    bookkeeping lines (`token_count`, `task_*`, `turn_context`, `session_meta`).
//!
//! Reusing `call_id` as BOTH the synthesized `tool_use` id and its result's
//! `tool_use_id` lets the front's id-keyed store pair the card with its result exactly
//! as the live path does.

use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::codex_home;
use super::server::CLIENT_NAME_INTERNAL;
use crate::supervisor::history::{
    self, DiskConversation, IndexedConversation, EXCERPT_CHARS, HEAD_SCAN_LINES, INDEX_BODY_CAP,
};
use crate::supervisor::model::{ConversationItem, NormalizedBlock};

/// Find the rollout file for `thread_id` under `<home>/sessions` (nested
/// `YYYY/MM/DD/`). The thread id is the tail of the filename
/// (`rollout-<ts>-<threadId>.jsonl`), so we scan for a `.jsonl` whose stem ENDS WITH the
/// id — robust to not reimplementing the date-path encoding. Bounded recursion (the tree
/// is date-shallow); an unreadable dir is logged and skipped, never fatal.
fn find_rollout(sessions_dir: &Path, thread_id: &str) -> Option<PathBuf> {
    let suffix = format!("{thread_id}.jsonl");
    fn walk(dir: &Path, suffix: &str, depth: u32) -> Option<PathBuf> {
        if depth > 6 {
            return None; // date tree is 3 deep; a generous cap guards against surprises
        }
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                eprintln!("[codex-history] cannot read {}: {e}", dir.display());
                return None;
            }
        };
        // Collect then check files first (cheap) before descending, so a match near the
        // top wins without walking the whole tree.
        let mut subdirs = Vec::new();
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                subdirs.push(path);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(suffix) && n.starts_with("rollout-"))
            {
                return Some(path);
            }
        }
        for sub in subdirs {
            if let Some(found) = walk(&sub, suffix, depth + 1) {
                return Some(found);
            }
        }
        None
    }
    walk(sessions_dir, &suffix, 0)
}

/// Load and normalize the cold history for a Codex `thread_id`, returning the ordered
/// items the UI replays (no app-server spawned). An absent/unreadable rollout yields an
/// empty vec — "no history to show" is a normal state, not an error. Mirrors
/// [`crate::supervisor::history::load_history`].
pub fn load_thread_history(thread_id: &str) -> Vec<ConversationItem> {
    let Some(home) = codex_home() else {
        return Vec::new();
    };
    let Some(path) = find_rollout(&home.join("sessions"), thread_id) else {
        return Vec::new();
    };
    parse_rollout(&path)
}

// ---- Disk listing + search index (the Codex analogue of the Claude scan in
// `crate::supervisor::history`) ---------------------------------------------------------
//
// The history panel lists EVERY past conversation found on disk, both backends. Claude's
// side reads `~/.claude/projects/*/*.jsonl`; here we read Codex's rollouts at
// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and normalize the header + first
// prompt into the SAME [`DiskConversation`] shape (marked `backend: "codex"`), and the
// full message text into the SAME [`IndexedConversation`] so a mixed history is one list
// and one search. Reusing `history`'s helpers (excerpt cap, mtime, body cap, fold) keeps
// the two backends' rows byte-for-byte consistent.

/// `$CODEX_HOME/sessions` — the root of the date-nested rollout tree. `None` when no
/// Codex home resolves (Codex never installed/used).
fn codex_sessions_dir() -> Option<PathBuf> {
    codex_home().map(|h| h.join("sessions"))
}

/// Recursively collect every `rollout-*.jsonl` path under `dir` (Codex nests them as
/// `YYYY/MM/DD/`). Bounded depth — the date tree is 3 deep; a generous cap guards against
/// surprises — and tolerant: an unreadable dir is logged and skipped, never fatal.
fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 6 {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            eprintln!("[codex-history] cannot read {}: {e}", dir.display());
            return;
        }
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, out, depth + 1);
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        {
            out.push(path);
        }
    }
}

/// List every Codex thread found on disk as a [`DiskConversation`] row (backend
/// `"codex"`), most-recent-first. The Codex analogue of the Claude scan in
/// [`history::list_disk_conversations`]. An absent `~/.codex/sessions` (Codex never used)
/// yields an empty vec — a normal state, not an error.
pub fn list_codex_disk_conversations() -> Vec<DiskConversation> {
    match codex_sessions_dir() {
        Some(dir) => list_codex_disk_conversations_in(&dir),
        None => Vec::new(),
    }
}

fn list_codex_disk_conversations_in(sessions_dir: &Path) -> Vec<DiskConversation> {
    let mut paths = Vec::new();
    collect_rollouts(sessions_dir, &mut paths, 0);
    let mut out: Vec<DiskConversation> = paths.iter().filter_map(|p| scan_codex_rollout(p)).collect();
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

/// Bounded head-read of one rollout → its listing row, or `None` for a thread with no
/// human message (aborted/empty — filtered as noise, mirroring the Claude scan). Reads the
/// `session_meta` header for the thread id / cwd / git branch and the first
/// `event_msg{user_message}` for the excerpt. Codex has no `ai-title`, so `title` is always
/// `None` (the excerpt labels the row) — matching the front's Codex auto-title-by-truncation.
fn scan_codex_rollout(path: &Path) -> Option<DiskConversation> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = history::file_mtime_ms(&meta);

    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut excerpt: Option<String> = None;

    for line in reader.lines().take(HEAD_SCAN_LINES) {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = entry.get("payload").unwrap_or(&Value::Null);
        match entry.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                // A spawned sub-agent / guardian thread is not a user conversation — drop it,
                // the Codex analogue of Claude's `subagents/` + `isSidechain` filter.
                if is_subagent_meta(payload) {
                    return None;
                }
                if session_id.is_none() {
                    session_id = thread_id_from_meta(payload);
                }
                if cwd.is_none() {
                    if let Some(c) = payload.get("cwd").and_then(Value::as_str) {
                        if !c.is_empty() {
                            cwd = Some(c.to_string());
                        }
                    }
                }
                if git_branch.is_none() {
                    git_branch = payload
                        .get("git")
                        .and_then(|g| g.get("branch"))
                        .and_then(Value::as_str)
                        .filter(|b| !b.is_empty())
                        .map(str::to_string);
                }
            }
            Some("event_msg") if excerpt.is_none() => {
                if payload.get("type").and_then(Value::as_str) == Some("user_message") {
                    let text = message_text(payload);
                    if !text.trim().is_empty() {
                        excerpt = Some(history::flatten_truncate(&text, EXCERPT_CHARS));
                    }
                }
            }
            _ => {}
        }
        // Once id + cwd + excerpt are known nothing better lies further down (Codex writes
        // no title line) — stop, keeping the common case cheap.
        if session_id.is_some() && cwd.is_some() && excerpt.is_some() {
            break;
        }
    }

    // Noise filter, in lock-step with `index_codex_rollout`: no human message = an
    // aborted/empty thread, never listed. The thread id is required to join a SQLite row
    // and to reactivate (`thread/resume`) — a row without it is unusable.
    let session_id = session_id?;
    let excerpt = excerpt?;
    let cwd = cwd.unwrap_or_default();
    let repo_root = history::repo_root_from_cwd(&cwd);
    Some(DiskConversation {
        session_id,
        cwd,
        repo_root,
        git_branch,
        title: None,
        excerpt,
        mtime_ms,
        backend: "codex".to_string(),
    })
}

/// True when a `session_meta` payload describes a SPAWNED thread (a sub-agent / guardian /
/// collaborator) rather than a top-level user conversation. Such threads carry a
/// `parent_thread_id` and a STRUCTURED `source` (`{"subagent": …}`) instead of a plain
/// client string (`"vscode"` / `"cli"` / `"exec"`). They are the Codex analogue of Claude's
/// `isSidechain` sub-agent transcripts and must NOT surface as history rows. A user FORK
/// stays listed — it carries `forked_from_id`, never `parent_thread_id` (verified across a
/// real `~/.codex`: the two markers are disjoint). Either signal alone is conclusive; we
/// check both defensively. A `null`-valued key counts as absent.
///
/// ALSO covers threads WE started for internal one-shot work (the Codex auto-title): they
/// carry our internal `originator` marker ([`CLIENT_NAME_INTERNAL`]). Their cleanup is a
/// best-effort `thread/archive`, so when it fails the rollout stays in `sessions/` and used
/// to be listed as a real conversation — one whose only "user message" is the title prompt
/// the app wrote, rendered under the user's own avatar.
fn is_subagent_meta(payload: &Value) -> bool {
    let has_parent = payload
        .get("parent_thread_id")
        .is_some_and(|v| !v.is_null());
    let structured_source = payload.get("source").is_some_and(Value::is_object);
    let internal = payload.get("originator").and_then(Value::as_str) == Some(CLIENT_NAME_INTERNAL);
    has_parent || structured_source || internal
}

/// The thread id from a `session_meta` payload — its `id` (the current thread, correct even
/// for a fork whose `forked_from_id` differs), falling back to `session_id`. Equals the
/// rollout's filename tail, so [`find_rollout`] can later locate this exact file on resume.
fn thread_id_from_meta(payload: &Value) -> Option<String> {
    payload
        .get("id")
        .or_else(|| payload.get("session_id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Build the full-text search index over every Codex rollout on disk (the Codex half of
/// [`history::build_search_index`]). Reads each rollout in full for its user + agent
/// message text — heavy, so the caller runs it once, off the panel-open path, and caches it.
pub fn build_codex_search_index() -> Vec<IndexedConversation> {
    match codex_sessions_dir() {
        Some(dir) => build_codex_search_index_in(&dir),
        None => Vec::new(),
    }
}

fn build_codex_search_index_in(sessions_dir: &Path) -> Vec<IndexedConversation> {
    let mut paths = Vec::new();
    collect_rollouts(sessions_dir, &mut paths, 0);
    paths.iter().filter_map(|p| index_codex_rollout(p)).collect()
}

/// Read + fold ONE rollout into its searchable index row, or `None` for a human-less
/// thread (same noise filter as the list). Only the real message text is indexed
/// (`event_msg` user/agent messages) — tool output and opaque reasoning are excluded,
/// matching the Claude indexer's main-thread-text scope.
fn index_codex_rollout(path: &Path) -> Option<IndexedConversation> {
    let mtime_ms = std::fs::metadata(path)
        .ok()
        .map(|m| history::file_mtime_ms(&m))
        .unwrap_or(0);
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id: Option<String> = None;
    let mut excerpt = String::new();
    let mut body = String::new();
    let mut truncated = false;

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = entry.get("payload").unwrap_or(&Value::Null);
        match entry.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                // Keep the index in lock-step with the list: a sub-agent thread is never
                // listed, so it must never be indexed (else a hit would orphan).
                if is_subagent_meta(payload) {
                    return None;
                }
                if session_id.is_none() {
                    session_id = thread_id_from_meta(payload);
                }
            }
            Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    let text = message_text(payload);
                    if !text.trim().is_empty() {
                        if excerpt.is_empty() {
                            excerpt = history::flatten_truncate(&text, EXCERPT_CHARS);
                        }
                        history::append_capped(&mut body, &text, INDEX_BODY_CAP, &mut truncated);
                    }
                }
                Some("agent_message") => {
                    if let Some(text) = payload.get("message").and_then(Value::as_str) {
                        if !text.is_empty() {
                            history::append_capped(&mut body, text, INDEX_BODY_CAP, &mut truncated);
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    let session_id = session_id?;
    if truncated {
        eprintln!("[codex-history] search index: body for {session_id} capped at {INDEX_BODY_CAP} bytes");
    }
    // Same noise filter as `scan_codex_rollout` — a thread with no human message never
    // enters the index, so a search hit is never orphaned from the list.
    if excerpt.trim().is_empty() {
        return None;
    }
    Some(IndexedConversation::from_text(
        session_id,
        "", // Codex writes no ai-title; the excerpt is the only label.
        &excerpt,
        body,
        mtime_ms,
    ))
}

/// A history-restore notice (unreadable / partially-corrupt rollout). Rendered as a
/// visible bubble by the UI — restoring a conversation must never drop messages
/// silently (the zero-silent-error contract). Same `history_error` subtype the Claude
/// restore uses.
fn history_notice(message: String) -> ConversationItem {
    ConversationItem::Notice {
        subtype: "history_error".to_string(),
        detail: json!({ "message": message }),
    }
}

/// Read + normalize the rollout at `path`, surfacing IO/partial-parse problems as
/// notices instead of a silently-empty conversation.
fn parse_rollout(path: &Path) -> Vec<ConversationItem> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let (mut items, skipped) = parse_rollout_str(&content);
            if skipped > 0 {
                items.push(history_notice(format!(
                    "{skipped} line(s) of this Codex history were unreadable — some messages may be missing."
                )));
            }
            items
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            eprintln!("[codex-history] cannot read rollout {}: {e}", path.display());
            vec![history_notice(format!(
                "Unable to read this conversation's Codex history: {e}"
            ))]
        }
    }
}

/// Normalize a Codex rollout into [`ConversationItem`]s plus the COUNT of malformed
/// lines skipped (so the caller can surface a "history may be incomplete" notice). Never
/// aborts on a bad line. Two passes: (1) index every `patch_apply_end` by `call_id` so an
/// `apply_patch` card can carry the structured per-file diffs; (2) walk in file order and
/// emit the timeline.
pub(crate) fn parse_rollout_str(content: &str) -> (Vec<ConversationItem>, usize) {
    // Pass 1 — structured file changes, keyed by the apply_patch call_id.
    let mut patch_changes: HashMap<String, (Vec<Value>, bool)> = HashMap::new();
    let mut skipped = 0usize;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            skipped += 1;
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("event_msg") {
            let p = entry.get("payload").unwrap_or(&Value::Null);
            if p.get("type").and_then(Value::as_str) == Some("patch_apply_end") {
                if let Some(call_id) = p.get("call_id").and_then(Value::as_str) {
                    let changes = map_patch_changes(p.get("changes").unwrap_or(&Value::Null));
                    let success = p.get("success").and_then(Value::as_bool).unwrap_or(true);
                    patch_changes.insert(call_id.to_string(), (changes, success));
                }
            }
        }
    }

    // Pass 2 — the timeline. `open_tools` tracks tool cards awaiting a result so an
    // interrupted turn (a call with no output) can still be closed at the end rather than
    // rendering "running" forever (mirrors the live actor's `close_dangling_tools`).
    let mut items: Vec<ConversationItem> = Vec::new();
    let mut open_tools: Vec<String> = Vec::new();
    // `view_image` calls, keyed by call_id → the image path from its arguments. The function
    // call precedes its output in the file, so this local map is populated in time for the
    // output line to replace the model-facing text with the base64 image thumbnail (the cold
    // analogue of the live `imageView` mapping).
    let mut view_image_calls: HashMap<String, String> = HashMap::new();
    let mut msg_seq = 0u64;
    // The Codex turn currently being read. `turn_context` lines carry the authoritative
    // `turn_id` and precede their turn's events; most `event_msg`/`response_item` payloads
    // also carry it. Tracking the latest lets us tag each assistant item with its turn — the
    // cold analogue of the live actor's `current_turn_id` — so the front can target a turn
    // boundary by id for native rewind/fork (`thread/fork{lastTurnId}`).
    let mut current_turn: Option<String> = None;
    // The session's working directory (from `session_meta`), used to resolve a RELATIVE
    // `view_image` path the same way the live actor resolves it against `state.cwd` — so a
    // reloaded image renders the thumbnail, not a "not found" note. `session_meta` precedes
    // every tool line, so it is captured in time.
    let mut rollout_cwd: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue; // already counted in pass 1
        };
        let payload = entry.get("payload").unwrap_or(&Value::Null);
        // A rollout is APPEND-ONLY: rolling a thread back does not erase anything, the CLI
        // just appends `{"type":"thread_rolled_back","num_turns":N}`. Replaying the file
        // verbatim therefore replayed turns the backend has already discarded — including a
        // user prompt the user watched disappear. Drop the LAST `num_turns` turns, a turn
        // starting at each user message (the same boundary the rest of this module treats as
        // a turn). `num_turns` missing or 0 → nothing to drop.
        if payload.get("type").and_then(Value::as_str) == Some("thread_rolled_back") {
            let n = payload.get("num_turns").and_then(Value::as_u64).unwrap_or(0) as usize;
            if n > 0 {
                let starts: Vec<usize> = items
                    .iter()
                    .enumerate()
                    .filter(|(_, it)| matches!(it, ConversationItem::UserMessage { .. }))
                    .map(|(i, _)| i)
                    .collect();
                // Fewer recorded turns than the rollback claims → the whole file goes.
                let cut = starts.len().saturating_sub(n);
                items.truncate(starts.get(cut).copied().unwrap_or(0));
                // Tool cards from the dropped turns can no longer be closed — forget them,
                // or the end-of-file sweep would emit results for cards that no longer exist.
                open_tools.clear();
                view_image_calls.clear();
            }
            continue;
        }
        if let Some(t) = payload.get("turn_id").and_then(Value::as_str) {
            current_turn = Some(t.to_string());
        }
        if entry.get("type").and_then(Value::as_str) == Some("session_meta") {
            if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                rollout_cwd = Some(cwd.to_string());
            }
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    let text = message_text(payload);
                    // An empty turn is not a turn: without this it rendered as an avatar
                    // and an empty bubble (and a blank row in the history preview). Mirrors
                    // the Claude side's `push_user_text` guard.
                    if !text.trim().is_empty() {
                        msg_seq += 1;
                        items.push(ConversationItem::UserMessage {
                            id: format!("cx-u{msg_seq}"),
                            text,
                            parent_tool_use_id: None,
                            replay: false,
                        });
                    }
                }
                Some("agent_message") => {
                    if let Some(text) = payload.get("message").and_then(Value::as_str) {
                        if !text.is_empty() {
                            msg_seq += 1;
                            let before = items.len();
                            items.push(assistant_text(format!("cx-a{msg_seq}"), text.to_string()));
                            stamp_turn(&mut items, before, current_turn.as_deref());
                        }
                    }
                }
                _ => {} // token_count, task_*, agent_reasoning, patch_apply_end (pass 1) …
            },
            Some("response_item") => {
                let before = items.len();
                push_response_item(
                    payload,
                    &patch_changes,
                    &mut view_image_calls,
                    rollout_cwd.as_deref(),
                    &mut items,
                    &mut open_tools,
                );
                stamp_turn(&mut items, before, current_turn.as_deref());
            }
            // session_meta, turn_context, compacted (compaction boundary — the pre-compaction
            // turns still precede it in the file, so the full history renders) …
            _ => {}
        }
    }

    // Close any tool card that never got a result (interrupted turn) so the round folds.
    for id in open_tools.drain(..) {
        items.push(ConversationItem::ToolResult {
            tool_use_id: id,
            content: json!("(interrupted)"),
            is_error: true,
            parent_tool_use_id: None,
        });
    }

    (items, skipped)
}

/// Map ONE `response_item` payload to the timeline (tools only — messages come from
/// `event_msg`). `open_tools` gains the card id until its result lands.
fn push_response_item(
    payload: &Value,
    patch_changes: &HashMap<String, (Vec<Value>, bool)>,
    view_image_calls: &mut HashMap<String, String>,
    cwd: Option<&str>,
    items: &mut Vec<ConversationItem>,
    open_tools: &mut Vec<String>,
) {
    let Some(kind) = payload.get("type").and_then(Value::as_str) else {
        return;
    };
    match kind {
        // A function tool call. `exec_command` → a Bash card (its `arguments` is a JSON
        // STRING `{cmd, workdir}`). ANY OTHER function tool (Codex's `update_plan`, an MCP
        // tool exposed as a function call, …) → a GENERIC card NAMED AFTER THE TOOL carrying
        // its parsed args, so it renders faithfully instead of a bogus Bash command whose
        // "command" is the raw JSON. Its output pairs by `call_id` either way (below).
        "function_call" => {
            let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
                return;
            };
            let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
            let args: Value = payload
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            if name == "exec_command" {
                let command = args
                    .get("cmd")
                    .and_then(Value::as_str)
                    .or_else(|| args.get("command").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string();
                let cwd = args.get("workdir").and_then(Value::as_str).map(str::to_string);
                push_tool_use(items, open_tools, call_id, "Bash", json!({ "command": command, "cwd": cwd }));
            } else if name == "view_image" {
                // The `view_image` tool → a Read card; its result is replaced with the
                // base64 image thumbnail in the paired `function_call_output` below (the path
                // is remembered by call_id), mirroring the live `imageView` mapping so a
                // reloaded conversation shows the image, not just the tool name.
                let path = args.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                push_tool_use(items, open_tools, call_id, "Read", json!({ "file_path": path }));
                if !path.is_empty() {
                    view_image_calls.insert(call_id.to_string(), path);
                }
            } else {
                // Unknown/non-shell function tool → a generic card with its parsed args (or the
                // raw arguments string if they don't parse). Never mislabeled as Bash.
                let input = if args.is_null() {
                    json!({ "arguments": payload.get("arguments").and_then(Value::as_str).unwrap_or("") })
                } else {
                    args
                };
                push_tool_use(items, open_tools, call_id, tool_label(name), input);
            }
        }
        "function_call_output" => {
            let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
                return;
            };
            if let Some(path) = view_image_calls.get(call_id) {
                // A `view_image` result → the image thumbnail (re-read from the path), not the
                // model-facing confirmation text. A relative path resolves against the session
                // cwd (as the live actor does); an unreadable path degrades to a text note
                // (never a blank card).
                let content = super::image_result_content(path, cwd);
                push_tool_result(items, open_tools, call_id, content, false);
            } else {
                let raw = payload.get("output").and_then(Value::as_str).unwrap_or("");
                let (clean, is_error) = split_exec_output(raw);
                push_tool_result(items, open_tools, call_id, json!(clean), is_error);
            }
        }
        // A custom (freeform) tool call. `apply_patch` → an ApplyPatch card whose per-file
        // diffs come from the paired `patch_apply_end` (pass 1). ANY OTHER custom tool → a
        // generic card, so its output (`custom_tool_call_output`, handled unconditionally
        // below) pairs with a real card instead of dangling as an orphan result.
        "custom_tool_call" => {
            let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
                return;
            };
            let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
            if name == "apply_patch" {
                let changes = patch_changes
                    .get(call_id)
                    .map(|(c, _)| c.clone())
                    .unwrap_or_default();
                push_tool_use(items, open_tools, call_id, "ApplyPatch", json!({ "changes": changes }));
            } else {
                let input = payload.get("input").cloned().unwrap_or(Value::Null);
                push_tool_use(items, open_tools, call_id, tool_label(name), json!({ "input": input }));
            }
        }
        "custom_tool_call_output" => {
            let Some(call_id) = payload.get("call_id").and_then(Value::as_str) else {
                return;
            };
            // Prefer the structured changes + success from patch_apply_end; fall back to the
            // raw text output (e.g. a denied/failed patch with no structured end).
            match patch_changes.get(call_id) {
                Some((changes, success)) => push_tool_result(
                    items,
                    open_tools,
                    call_id,
                    json!({ "status": if *success { "completed" } else { "failed" }, "changes": changes }),
                    !success,
                ),
                None => {
                    let raw = payload.get("output").and_then(Value::as_str).unwrap_or("");
                    let (clean, is_error) = split_exec_output(raw);
                    push_tool_result(items, open_tools, call_id, json!(clean), is_error);
                }
            }
        }
        // A web search → a self-contained WebSearch card (no separate output line).
        "web_search_call" => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "websearch".to_string());
            let query = payload
                .get("action")
                .and_then(|a| a.get("query"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            push_tool_use(items, open_tools, &id, "WebSearch", json!({ "query": query }));
            push_tool_result(items, open_tools, &id, json!({ "query": query }), false);
        }
        // message (role developer/user/assistant), reasoning, and any unmodelled item →
        // dropped (messages ride `event_msg`; reasoning is encrypted/opaque).
        _ => {}
    }
}

/// Emit a tool card (an assistant message carrying one `ToolUse` block) and mark it open.
fn push_tool_use(
    items: &mut Vec<ConversationItem>,
    open_tools: &mut Vec<String>,
    id: &str,
    name: &str,
    input: Value,
) {
    open_tools.push(id.to_string());
    items.push(ConversationItem::AssistantMessage {
        id: id.to_string(),
        blocks: vec![NormalizedBlock::ToolUse {
            id: id.to_string(),
            name: name.to_string(),
            input,
        }],
        parent_tool_use_id: None,
        // Filled by `stamp_turn` from the caller's tracked `current_turn` after this push.
        turn_id: None,
    });
}

/// Close a tool card with its result (paired by `tool_use_id == call_id`).
fn push_tool_result(
    items: &mut Vec<ConversationItem>,
    open_tools: &mut Vec<String>,
    id: &str,
    content: Value,
    is_error: bool,
) {
    open_tools.retain(|t| t != id);
    items.push(ConversationItem::ToolResult {
        tool_use_id: id.to_string(),
        content,
        is_error,
        parent_tool_use_id: None,
    });
}

/// The card label for a non-standard tool: its own name, or a neutral fallback when the
/// wire omits it — never empty (an empty tool name would render a nameless card).
fn tool_label(name: &str) -> &str {
    if name.is_empty() {
        "tool"
    } else {
        name
    }
}

/// An authoritative assistant text message (one `Text` block).
fn assistant_text(id: String, text: String) -> ConversationItem {
    ConversationItem::AssistantMessage {
        id,
        blocks: vec![NormalizedBlock::Text { text }],
        parent_tool_use_id: None,
        turn_id: None,
    }
}

/// Tag every `AssistantMessage` produced by ONE rollout line (those pushed at/after `from`)
/// with the Codex `turn_id` of the turn being read — the cold analogue of the live actor
/// stamping each emitted item with `current_turn_id`. Only fills a `None` (never overwrites
/// an already-tagged item); a `None` `turn_id` (a line before any `turn_context`) is left as
/// is, so the front simply can't offer rewind/fork on that boundary.
fn stamp_turn(items: &mut [ConversationItem], from: usize, turn_id: Option<&str>) {
    let Some(t) = turn_id else { return };
    for item in &mut items[from..] {
        if let ConversationItem::AssistantMessage { turn_id, .. } = item {
            if turn_id.is_none() {
                *turn_id = Some(t.to_string());
            }
        }
    }
}

/// The user turn's text; an image-only turn (empty text but attachments) gets an
/// `[image]` placeholder so the bubble is never blank.
/// The display text of a rollout `user_message`, with the `[image]` placeholder for a turn
/// that is nothing but attachments.
///
/// ⚠️ Reads BOTH image fields. Flight Deck only ever sends `UserInput::LocalImage`
/// (`codex/session.rs`), which the CLI persists as `local_images`, leaving `images` empty —
/// so keying on `images` alone made every image-only Codex turn come back as an EMPTY
/// bubble (and its conversation vanish from the history list and the search index, whose
/// callers drop a turn with no excerpt).
fn message_text(payload: &Value) -> String {
    let text = payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !text.is_empty() {
        return text;
    }
    let has_images = ["images", "local_images"].iter().any(|k| {
        payload
            .get(k)
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
    });
    if has_images {
        "[image]".to_string()
    } else {
        text
    }
}

/// Split a Codex exec/apply output string into (clean_output, is_error). Codex wraps
/// tool output with a metadata preamble (`Chunk ID: …` / `Exit code: …` / `Wall time: …`
/// / `Process exited with code N` / `Output:\n<real output>`); when present we read the
/// exit code for `is_error` and return only the real output. An un-wrapped string is
/// returned verbatim (never mis-stripped).
fn split_exec_output(raw: &str) -> (String, bool) {
    let wrapped = raw.starts_with("Chunk ID:")
        || raw.starts_with("Exit code:")
        || raw.starts_with("Wall time:");
    if !wrapped {
        return (raw.to_string(), false);
    }
    let exit_code = raw.lines().take(8).find_map(|l| {
        l.strip_prefix("Process exited with code ")
            .or_else(|| l.strip_prefix("Exit code: "))
            .and_then(|s| s.trim().parse::<i64>().ok())
    });
    let is_error = exit_code.is_some_and(|c| c != 0);
    let clean = match raw.split_once("\nOutput:\n") {
        Some((_, rest)) => rest.to_string(),
        None => raw.to_string(),
    };
    (clean, is_error)
}

/// Map a `patch_apply_end.changes` object (`{path: {type, content?/unified_diff?}}`) to
/// the live `fileChange` shape (`[{path, kind, diff}]`) the front's `applyPatchChanges`
/// consumes. An `add` has full `content` → synthesize an all-additions unified diff so
/// `parseUnifiedDiff` (which needs a `@@` header) renders it; an `update` already ships a
/// real `unified_diff`; a `delete` has no old content on the wire → an empty diff (the
/// path + kind still render).
fn map_patch_changes(changes: &Value) -> Vec<Value> {
    let Some(obj) = changes.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (path, ch) in obj {
        let kind = ch.get("type").and_then(Value::as_str).unwrap_or("update");
        let diff = match kind {
            "add" => unified_diff_for_add(ch.get("content").and_then(Value::as_str).unwrap_or("")),
            "delete" => String::new(),
            _ => ch
                .get("unified_diff")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        };
        out.push(json!({ "path": path, "kind": { "type": kind }, "diff": diff }));
    }
    out
}

/// Synthesize a unified diff for a newly-ADDED file: one hunk of all-`+` lines. Empty
/// content → empty diff (nothing to render).
fn unified_diff_for_add(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    // Split into lines WITHOUT a trailing empty produced by a final newline.
    let trimmed = content.strip_suffix('\n').unwrap_or(content);
    let lines: Vec<&str> = trimmed.split('\n').collect();
    let mut s = format!("@@ -0,0 +1,{} @@\n", lines.len());
    for l in lines {
        s.push('+');
        s.push_str(l);
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a rollout line from a top-level type + payload.
    fn line(ty: &str, payload: Value) -> String {
        json!({ "timestamp": "2026-07-08T00:00:00Z", "type": ty, "payload": payload }).to_string()
    }

    fn is_user(i: &ConversationItem, want: &str) -> bool {
        matches!(i, ConversationItem::UserMessage { text, .. } if text == want)
    }
    fn tool_use<'a>(items: &'a [ConversationItem], id: &str) -> Option<(&'a str, &'a Value)> {
        items.iter().find_map(|i| match i {
            ConversationItem::AssistantMessage { blocks, .. } => {
                blocks.iter().find_map(|b| match b {
                    NormalizedBlock::ToolUse { id: tid, name, input } if tid == id => {
                        Some((name.as_str(), input))
                    }
                    _ => None,
                })
            }
            _ => None,
        })
    }
    fn tool_result<'a>(items: &'a [ConversationItem], id: &str) -> Option<&'a ConversationItem> {
        items.iter().find(
            |i| matches!(i, ConversationItem::ToolResult { tool_use_id, .. } if tool_use_id == id),
        )
    }

    #[test]
    fn user_and_agent_messages_come_from_event_msg() {
        let content = [
            line("session_meta", json!({ "id": "t1", "cwd": "/tmp" })),
            line("response_item", json!({ "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "<permissions instructions>…" }] })),
            line("response_item", json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<environment_context>…" }] })),
            line("event_msg", json!({ "type": "user_message", "message": "salut", "images": [] })),
            line("response_item", json!({ "type": "reasoning", "summary": [], "encrypted_content": "gAAA…" })),
            line("event_msg", json!({ "type": "agent_message", "message": "Bonjour, je t'aide.", "phase": "final_answer" })),
            line("response_item", json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Bonjour, je t'aide." }] })),
        ]
        .join("\n");
        let (items, skipped) = parse_rollout_str(&content);
        assert_eq!(skipped, 0);
        // Exactly one user bubble + one assistant text — injected developer/user-role and the
        // duplicate assistant response_item and the encrypted reasoning are all dropped.
        assert_eq!(items.iter().filter(|i| matches!(i, ConversationItem::UserMessage { .. })).count(), 1);
        assert!(is_user(&items[0], "salut"));
        let asst: Vec<_> = items.iter().filter(|i| matches!(i, ConversationItem::AssistantMessage { .. })).collect();
        assert_eq!(asst.len(), 1);
        assert!(matches!(asst[0], ConversationItem::AssistantMessage { blocks, .. }
            if matches!(&blocks[0], NormalizedBlock::Text { text } if text == "Bonjour, je t'aide.")));
    }

    #[test]
    fn exec_command_becomes_a_bash_card_paired_by_call_id() {
        let content = [
            line("response_item", json!({ "type": "function_call", "name": "exec_command", "call_id": "c1",
                "arguments": "{\"cmd\":\"ls -la\",\"workdir\":\"/repo\"}" })),
            line("response_item", json!({ "type": "function_call_output", "call_id": "c1",
                "output": "Chunk ID: ab\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nfile-a\nfile-b\n" })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        let (name, input) = tool_use(&items, "c1").expect("bash card");
        assert_eq!(name, "Bash");
        assert_eq!(input.get("command").and_then(Value::as_str), Some("ls -la"));
        assert_eq!(input.get("cwd").and_then(Value::as_str), Some("/repo"));
        match tool_result(&items, "c1") {
            Some(ConversationItem::ToolResult { content, is_error, .. }) => {
                // Preamble stripped, real output kept, exit 0 → not an error.
                assert_eq!(content.as_str(), Some("file-a\nfile-b\n"));
                assert!(!is_error);
            }
            _ => panic!("missing tool result"),
        }
    }

    #[test]
    fn nonzero_exit_marks_the_result_as_error() {
        let content = line("response_item", json!({ "type": "function_call_output", "call_id": "c9",
            "output": "Chunk ID: z\nProcess exited with code 2\nOutput:\nboom\n" }));
        // Pair it to a card so it isn't a dangling result.
        let content = format!(
            "{}\n{}",
            line("response_item", json!({ "type": "function_call", "name": "exec_command", "call_id": "c9", "arguments": "{\"cmd\":\"false\"}" })),
            content
        );
        let (items, _) = parse_rollout_str(&content);
        assert!(matches!(tool_result(&items, "c9"), Some(ConversationItem::ToolResult { is_error: true, .. })));
    }

    #[test]
    fn apply_patch_card_carries_structured_diffs_from_patch_apply_end() {
        let content = [
            line("response_item", json!({ "type": "custom_tool_call", "name": "apply_patch", "call_id": "p1",
                "input": "*** Begin Patch\n*** Add File: /repo/a.txt\n+hello\n*** End Patch" })),
            line("event_msg", json!({ "type": "patch_apply_end", "call_id": "p1", "success": true, "changes": {
                "/repo/a.txt": { "type": "add", "content": "hello\nworld\n" },
                "/repo/b.css": { "type": "update", "unified_diff": "@@ -1,1 +1,1 @@\n-a\n+b\n" }
            } })),
            line("response_item", json!({ "type": "custom_tool_call_output", "call_id": "p1",
                "output": "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA /repo/a.txt\n" })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        let (name, input) = tool_use(&items, "p1").expect("apply-patch card");
        assert_eq!(name, "ApplyPatch");
        let changes = input.get("changes").and_then(Value::as_array).expect("changes on input");
        assert_eq!(changes.len(), 2);
        // Add → synthesized all-additions unified diff.
        let add = changes.iter().find(|c| c.get("path").and_then(Value::as_str) == Some("/repo/a.txt")).unwrap();
        let add_diff = add.get("diff").and_then(Value::as_str).unwrap();
        assert!(add_diff.starts_with("@@ -0,0 +1,2 @@\n"), "add diff = {add_diff:?}");
        assert!(add_diff.contains("+hello\n+world\n"));
        // Update → the real unified_diff, verbatim.
        let upd = changes.iter().find(|c| c.get("path").and_then(Value::as_str) == Some("/repo/b.css")).unwrap();
        assert_eq!(upd.get("diff").and_then(Value::as_str), Some("@@ -1,1 +1,1 @@\n-a\n+b\n"));
        // Result carries the changes too, not an error.
        assert!(matches!(tool_result(&items, "p1"), Some(ConversationItem::ToolResult { is_error: false, .. })));
    }

    #[test]
    fn web_search_is_a_self_contained_card() {
        let content = line("response_item", json!({ "type": "web_search_call", "id": "ws1", "status": "completed",
            "action": { "type": "search", "query": "rust tokio" } }));
        let (items, _) = parse_rollout_str(&content);
        let (name, input) = tool_use(&items, "ws1").expect("websearch card");
        assert_eq!(name, "WebSearch");
        assert_eq!(input.get("query").and_then(Value::as_str), Some("rust tokio"));
        assert!(tool_result(&items, "ws1").is_some());
    }

    #[test]
    fn malformed_lines_are_counted_not_fatal() {
        let content = format!(
            "{}\nnot json at all\n{}",
            line("event_msg", json!({ "type": "user_message", "message": "un" })),
            line("event_msg", json!({ "type": "agent_message", "message": "deux" })),
        );
        let (items, skipped) = parse_rollout_str(&content);
        assert_eq!(skipped, 1);
        assert!(items.iter().any(|i| is_user(i, "un")));
    }

    #[test]
    fn interrupted_tool_call_is_closed_not_left_running() {
        // A function_call with no matching output (interrupted turn) still gets a result so
        // the round can fold instead of rendering "running" forever.
        let content = line("response_item", json!({ "type": "function_call", "name": "exec_command", "call_id": "hang",
            "arguments": "{\"cmd\":\"sleep 999\"}" }));
        let (items, _) = parse_rollout_str(&content);
        assert!(matches!(tool_result(&items, "hang"), Some(ConversationItem::ToolResult { is_error: true, .. })));
    }

    #[test]
    fn image_only_user_turn_gets_a_placeholder() {
        // ⚠️ The REAL shape Flight Deck produces. It only ever sends `UserInput::LocalImage`,
        // which the CLI persists under `local_images` — `images` stays empty. Keying on
        // `images` alone (as this test used to, with a shape the app cannot emit) meant every
        // image-only Codex turn came back as an EMPTY bubble, and its conversation dropped
        // out of the history list and the search index entirely.
        let content = line(
            "event_msg",
            json!({ "type": "user_message", "message": "", "images": [], "local_images": ["/tmp/a.png"] }),
        );
        let (items, _) = parse_rollout_str(&content);
        assert!(is_user(&items[0], "[image]"));
        // The other field still works (a turn sent by another Codex client).
        let other = line("event_msg", json!({ "type": "user_message", "message": "", "images": ["data:…"] }));
        let (items, _) = parse_rollout_str(&other);
        assert!(is_user(&items[0], "[image]"));
    }

    /// A `user_message` with no text and no attachments is not a turn — it must not render
    /// as an avatar with an empty bubble (nor a blank row in the history preview).
    #[test]
    fn a_wholly_empty_user_turn_is_not_a_bubble() {
        let content = line("event_msg", json!({ "type": "user_message", "message": "" }));
        let (items, _) = parse_rollout_str(&content);
        assert!(
            !items.iter().any(|i| matches!(i, ConversationItem::UserMessage { .. })),
            "an empty user_message must not become a bubble"
        );
    }

    /// A rollout is append-only: `thread_rolled_back{num_turns}` says the last N turns were
    /// discarded by the backend. Replaying them would show the user a prompt they watched
    /// disappear.
    #[test]
    fn a_rolled_back_turn_is_not_replayed() {
        let content = [
            line("event_msg", json!({ "type": "user_message", "message": "first" })),
            line("event_msg", json!({ "type": "agent_message", "message": "answer one" })),
            line("event_msg", json!({ "type": "user_message", "message": "second" })),
            line("event_msg", json!({ "type": "agent_message", "message": "answer two" })),
            line("event_msg", json!({ "type": "thread_rolled_back", "num_turns": 1 })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        let users: Vec<_> = items
            .iter()
            .filter_map(|i| match i {
                ConversationItem::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(users, vec!["first"], "the rolled-back turn must be gone, the earlier one kept");
    }

    #[test]
    fn non_exec_function_tool_is_a_generic_card_not_bogus_bash() {
        // A non-shell function tool (e.g. Codex's update_plan, or an MCP tool) must NOT be
        // mislabeled as a Bash card whose "command" is the raw JSON arguments.
        let content = [
            line("response_item", json!({ "type": "function_call", "name": "update_plan", "call_id": "u1",
                "arguments": "{\"plan\":[{\"step\":\"build\",\"status\":\"pending\"}]}" })),
            line("response_item", json!({ "type": "function_call_output", "call_id": "u1", "output": "ok" })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        let (name, input) = tool_use(&items, "u1").expect("generic tool card");
        assert_eq!(name, "update_plan", "named after the tool, not Bash");
        assert!(input.get("plan").is_some(), "parsed args carried through, not a fake command");
        assert!(tool_result(&items, "u1").is_some(), "its output pairs by call_id");
    }

    #[test]
    fn view_image_function_call_reloads_as_a_read_card_with_the_image_thumbnail() {
        // A `view_image` tool call on disk (a function_call whose arguments carry the path) →
        // a Read card whose result is the base64 image thumbnail (re-read from the path), the
        // cold analogue of the live `imageView` mapping, so a reloaded Codex conversation shows
        // the image instead of just the tool name.
        let path = std::env::temp_dir().join("tosse_codex_history_view_image.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\nreload-bytes").expect("write temp image");
        let args = json!({ "path": path.to_string_lossy(), "detail": "original" }).to_string();
        let content = [
            line("response_item", json!({ "type": "function_call", "name": "view_image", "call_id": "vi1", "arguments": args })),
            line("response_item", json!({ "type": "function_call_output", "call_id": "vi1", "output": "attached image" })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        let (name, input) = tool_use(&items, "vi1").expect("a Read card for the viewed image");
        assert_eq!(name, "Read");
        assert!(input.get("file_path").is_some(), "the path rides the card input");
        match tool_result(&items, "vi1") {
            Some(ConversationItem::ToolResult { content, .. }) => {
                let arr = content.as_array().expect("image thumbnail is an array");
                assert_eq!(arr[0]["type"], "image");
                assert_eq!(arr[0]["source"]["media_type"], "image/png");
                assert!(arr[0]["source"]["data"].as_str().is_some_and(|d| !d.is_empty()));
            }
            _ => panic!("expected an image ToolResult for vi1"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn view_image_relative_path_resolves_against_session_cwd_on_reload() {
        // Mirror the live actor: a RELATIVE view_image path resolves against the session cwd
        // (from session_meta), so the thumbnail renders instead of a "not found" note.
        let dir = std::env::temp_dir().join("tosse_codex_hist_rel");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("shot.png"), b"rel-bytes").expect("write");
        let args = json!({ "path": "shot.png", "detail": "original" }).to_string();
        let content = [
            line("session_meta", json!({ "id": "t1", "cwd": dir.to_string_lossy() })),
            line("response_item", json!({ "type": "function_call", "name": "view_image", "call_id": "vr1", "arguments": args })),
            line("response_item", json!({ "type": "function_call_output", "call_id": "vr1", "output": "attached" })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        match tool_result(&items, "vr1") {
            Some(ConversationItem::ToolResult { content, .. }) => {
                let arr = content.as_array().expect("image array — relative path resolved via session cwd");
                assert_eq!(arr[0]["type"], "image");
            }
            _ => panic!("expected an image ToolResult for vr1"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_apply_patch_custom_tool_pairs_its_output_no_orphan() {
        // A custom (freeform) tool other than apply_patch must still get a card, so its output
        // pairs with it instead of dangling as an orphan ToolResult.
        let content = [
            line("response_item", json!({ "type": "custom_tool_call", "name": "some_tool", "call_id": "x1", "input": "raw input" })),
            line("response_item", json!({ "type": "custom_tool_call_output", "call_id": "x1", "output": "done" })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        let (name, _) = tool_use(&items, "x1").expect("generic custom-tool card (the call is not dropped)");
        assert_eq!(name, "some_tool");
        assert!(tool_result(&items, "x1").is_some(), "output pairs — not an orphan result");
        // Symmetric pairing means no card is left open (no synthetic '(interrompu)' result).
        assert_eq!(
            items.iter().filter(|i| matches!(i, ConversationItem::ToolResult { .. })).count(),
            1
        );
    }

    #[test]
    fn failed_apply_patch_output_is_marked_error_via_exit_code() {
        // A failed apply_patch with NO structured patch_apply_end: is_error is read from the
        // wrapped "Exit code:" preamble (the real output format), never defaulted to success.
        let content = [
            line("response_item", json!({ "type": "custom_tool_call", "name": "apply_patch", "call_id": "p9",
                "input": "*** Begin Patch\n*** Update File: /x\n@@\n-a\n+b\n*** End Patch" })),
            line("response_item", json!({ "type": "custom_tool_call_output", "call_id": "p9",
                "output": "Exit code: 1\nWall time: 0.1 seconds\nOutput:\napply_patch failed: /x not found\n" })),
        ]
        .join("\n");
        let (items, _) = parse_rollout_str(&content);
        assert!(
            matches!(tool_result(&items, "p9"), Some(ConversationItem::ToolResult { is_error: true, .. })),
            "a failed patch (exit 1) must render as an error, not a clean success"
        );
    }

    /// PROBE (not a hermetic regression test): parse a REAL on-disk rollout end-to-end and
    /// assert it yields a sane, tool-inclusive timeline. Pass a thread id via
    /// `TOSSE_CODEX_PROBE_THREAD` (else it scans `~/.codex/sessions` for the newest rollout).
    /// Run: `cargo test --lib -- --ignored --nocapture live_load_real_rollout`.
    #[test]
    #[ignore = "reads a real ~/.codex rollout off disk"]
    fn live_load_real_rollout() {
        let thread_id = std::env::var("TOSSE_CODEX_PROBE_THREAD").ok().or_else(|| {
            // Newest rollout: recurse sessions/ and pull the thread id out of the filename.
            let home = codex_home()?;
            let mut newest: Option<(std::time::SystemTime, String)> = None;
            fn scan(dir: &Path, newest: &mut Option<(std::time::SystemTime, String)>) {
                let Ok(rd) = std::fs::read_dir(dir) else { return };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        scan(&p, newest);
                    } else if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        if let Some(stem) = name.strip_prefix("rollout-").and_then(|s| s.strip_suffix(".jsonl")) {
                            // stem = "<ts>-<uuid>"; the uuid is the last 5 dash groups.
                            let parts: Vec<&str> = stem.rsplitn(6, '-').collect();
                            if parts.len() == 6 {
                                let id = parts[..5].iter().rev().cloned().collect::<Vec<_>>().join("-");
                                let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                                if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                                    *newest = Some((mtime, id));
                                }
                            }
                        }
                    }
                }
            }
            scan(&home.join("sessions"), &mut newest);
            newest.map(|(_, id)| id)
        });
        let Some(thread_id) = thread_id else {
            eprintln!("PROBE: no rollout found on disk — skipping");
            return;
        };
        let items = load_thread_history(&thread_id);
        let users = items.iter().filter(|i| matches!(i, ConversationItem::UserMessage { .. })).count();
        let tool_uses = items.iter().filter(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::ToolUse { .. })))).count();
        let tool_results = items.iter().filter(|i| matches!(i, ConversationItem::ToolResult { .. })).count();
        let texts = items.iter().filter(|i| matches!(i, ConversationItem::AssistantMessage { blocks, .. }
            if blocks.iter().any(|b| matches!(b, NormalizedBlock::Text { .. })))).count();
        eprintln!(
            "PROBE thread {thread_id}: {} items → {users} user, {texts} assistant-text, {tool_uses} tool cards, {tool_results} results",
            items.len()
        );
        assert!(!items.is_empty(), "a real rollout must produce items");
        // Every tool card must be paired with a result (none left 'running').
        assert_eq!(tool_uses, tool_results, "each tool card should have exactly one result");
    }

    // ---- Disk listing + search index ----------------------------------------------

    use std::io::Write;

    /// Write a rollout `<name>.jsonl` under a fake `<base>/YYYY/MM/DD/` sessions tree.
    fn write_rollout(base: &Path, day: &str, name: &str, lines: &[String]) {
        let dir = base.join("2026").join("07").join(day);
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join(format!("{name}.jsonl"))).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    #[test]
    fn codex_disk_listing_reads_backend_cwd_git_and_first_prompt() {
        let base = std::env::temp_dir().join(format!("tosse-codex-list-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        // A normal thread: header (id/cwd/git.branch) + first user prompt + a reply.
        write_rollout(
            &base,
            "10",
            "rollout-2026-07-10T01-00-00-aaaaaaaa-1111-2222-3333-444444444444",
            &[
                line("session_meta", json!({ "id": "aaaaaaaa-1111-2222-3333-444444444444", "cwd": "/Users/me/Repos/app", "git": { "branch": "main" } })),
                line("response_item", json!({ "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "<permissions>…" }] })),
                line("event_msg", json!({ "type": "user_message", "message": "Fix the login scroll bug", "images": [] })),
                line("event_msg", json!({ "type": "agent_message", "message": "On y va." })),
            ],
        );
        // A thread whose cwd is an app WORKTREE → repo_root rolls up to the repo.
        write_rollout(
            &base,
            "09",
            "rollout-2026-07-09T02-00-00-bbbbbbbb-1111-2222-3333-444444444444",
            &[
                line("session_meta", json!({ "id": "bbbbbbbb-1111-2222-3333-444444444444", "cwd": "/Users/me/Repos/app/.claude/worktrees/feat-x" })),
                line("event_msg", json!({ "type": "user_message", "message": "Add a dark mode toggle", "images": [] })),
            ],
        );
        // An aborted thread: header + a reply but NO human message → filtered as noise.
        write_rollout(
            &base,
            "10",
            "rollout-2026-07-10T03-00-00-cccccccc-1111-2222-3333-444444444444",
            &[
                line("session_meta", json!({ "id": "cccccccc-1111-2222-3333-444444444444", "cwd": "/x" })),
                line("event_msg", json!({ "type": "agent_message", "message": "orphelin" })),
            ],
        );
        // A spawned sub-agent (guardian) thread: has a `parent_thread_id` + a structured
        // `source` and its first user_message is an injected assessment prompt → filtered out
        // (never a top-level conversation), even though it HAS a "human" message.
        write_rollout(
            &base,
            "10",
            "rollout-2026-07-10T04-00-00-dddddddd-1111-2222-3333-444444444444",
            &[
                line("session_meta", json!({ "id": "dddddddd-1111-2222-3333-444444444444", "cwd": "/Users/me/Repos/app", "parent_thread_id": "aaaaaaaa-1111-2222-3333-444444444444", "source": { "subagent": { "other": "guardian" } } })),
                line("event_msg", json!({ "type": "user_message", "message": "The following is the Codex agent history whose request action you are assessing…", "images": [] })),
            ],
        );
        // A user FORK (has `forked_from_id`, NOT `parent_thread_id`, plain string source) is a
        // REAL conversation → stays listed.
        write_rollout(
            &base,
            "10",
            "rollout-2026-07-10T05-00-00-eeeeeeee-1111-2222-3333-444444444444",
            &[
                line("session_meta", json!({ "id": "eeeeeeee-1111-2222-3333-444444444444", "forked_from_id": "aaaaaaaa-1111-2222-3333-444444444444", "cwd": "/Users/me/Repos/app", "source": "vscode" })),
                line("event_msg", json!({ "type": "user_message", "message": "Continue on the fork", "images": [] })),
            ],
        );
        // A stray non-rollout file in the tree → ignored (only `rollout-*.jsonl` counts).
        std::fs::write(base.join("2026").join("07").join("10").join("notes.jsonl"), "{}\n").unwrap();

        let got = list_codex_disk_conversations_in(&base);
        std::fs::remove_dir_all(&base).ok();

        // Three real threads (normal + worktree + fork); the aborted one, the sub-agent, and
        // the stray file are excluded.
        assert_eq!(got.len(), 3, "got {got:#?}");
        assert!(got.iter().all(|c| !c.session_id.starts_with("dddd")), "sub-agent thread is filtered out");
        assert!(got.iter().any(|c| c.session_id.starts_with("eeee")), "a user fork stays listed");
        // Most-recent-first: the 07-10 thread (mtime newer) sorts above the 07-09 one, but
        // since both are written in the same test run mtimes are ~equal — assert by id.
        let normal = got.iter().find(|c| c.session_id.starts_with("aaaa")).expect("normal thread");
        assert_eq!(normal.backend, "codex");
        assert_eq!(normal.title, None, "Codex has no ai-title");
        assert_eq!(normal.excerpt, "Fix the login scroll bug");
        assert_eq!(normal.cwd, "/Users/me/Repos/app");
        assert_eq!(normal.repo_root, "/Users/me/Repos/app");
        assert_eq!(normal.git_branch.as_deref(), Some("main"));

        let worktree = got.iter().find(|c| c.session_id.starts_with("bbbb")).expect("worktree thread");
        assert_eq!(worktree.cwd, "/Users/me/Repos/app/.claude/worktrees/feat-x");
        assert_eq!(worktree.repo_root, "/Users/me/Repos/app", "worktree cwd rolls up to the repo");
        assert_eq!(worktree.git_branch, None);
        assert_eq!(worktree.excerpt, "Add a dark mode toggle");
    }

    #[test]
    fn codex_search_index_finds_by_user_and_agent_text_and_skips_noise() {
        let base = std::env::temp_dir().join(format!("tosse-codex-idx-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        write_rollout(
            &base,
            "10",
            "rollout-2026-07-10T01-00-00-11111111-1111-1111-1111-111111111111",
            &[
                line("session_meta", json!({ "id": "11111111-1111-1111-1111-111111111111", "cwd": "/repo" })),
                line("event_msg", json!({ "type": "user_message", "message": "revoir l'authentification serveur", "images": [] })),
                line("event_msg", json!({ "type": "agent_message", "message": "Je remplace le middleware JWT." })),
            ],
        );
        // Noise (no human message) → must NOT enter the index.
        write_rollout(
            &base,
            "10",
            "rollout-2026-07-10T02-00-00-22222222-2222-2222-2222-222222222222",
            &[
                line("session_meta", json!({ "id": "22222222-2222-2222-2222-222222222222", "cwd": "/repo" })),
                line("event_msg", json!({ "type": "agent_message", "message": "middleware orphelin" })),
            ],
        );

        let index = build_codex_search_index_in(&base);
        std::fs::remove_dir_all(&base).ok();

        assert_eq!(index.len(), 1, "the human-less thread is filtered out of the index");
        // A term from the user prompt hits (excerpt), accent-folded.
        let by_user = history::score_index(&index, "authentification");
        assert_eq!(by_user.len(), 1);
        assert_eq!(by_user[0].session_id, "11111111-1111-1111-1111-111111111111");
        // A term found ONLY in the agent's reply hits the indexed body…
        let by_agent = history::score_index(&index, "middleware");
        assert_eq!(by_agent.len(), 1, "agent text is searchable and the orphan is absent");
        assert_eq!(by_agent[0].session_id, "11111111-1111-1111-1111-111111111111");
    }

    /// PROBE (not hermetic): run the REAL disk scan + index against `~/.codex/sessions` and
    /// report what it finds. Confirms the scanner produces sane, reactivatable rows on a live
    /// install (each row's `session_id` must be locatable by [`find_rollout`], the same lookup
    /// reactivation/preview use). Run:
    /// `cargo test --lib -- --ignored --nocapture live_list_codex_disk_conversations`.
    #[test]
    #[ignore = "reads real ~/.codex rollouts off disk"]
    fn live_list_codex_disk_conversations() {
        let rows = list_codex_disk_conversations();
        eprintln!("PROBE: {} Codex conversation(s) on disk", rows.len());
        for r in rows.iter().take(10) {
            eprintln!(
                "  {} · backend={} · repo={} · branch={:?} · {:?}",
                r.session_id, r.backend, r.repo_root, r.git_branch, r.excerpt
            );
        }
        for r in &rows {
            assert_eq!(r.backend, "codex", "every row from the Codex scan is backend=codex");
            assert!(!r.session_id.is_empty(), "a listed row must carry a thread id");
            assert!(!r.excerpt.is_empty(), "a listed row must carry an excerpt");
            // The listed id must locate its own rollout — else preview/reactivation would
            // come back empty.
            assert!(
                load_thread_history(&r.session_id).len() > 0 || r.excerpt == "[image]",
                "the thread id {} must resolve to a readable rollout",
                r.session_id
            );
        }
        // The full merged listing must include the Codex rows too (both backends).
        let merged = crate::supervisor::history::list_disk_conversations();
        let codex_in_merged = merged.iter().filter(|c| c.backend == "codex").count();
        eprintln!(
            "PROBE: merged listing has {} rows, {} Codex",
            merged.len(),
            codex_in_merged
        );
        assert_eq!(codex_in_merged, rows.len(), "the merged list surfaces every Codex row");
    }

    // ---- Cold-restore silent-error contract (parse_rollout notices) ---------------

    #[test]
    fn parse_rollout_surfaces_a_history_error_notice_on_a_malformed_line() {
        // The whole point of the notice: a partially-corrupt rollout must NOT silently drop
        // turns. Mirrors the Claude side's `malformed_transcript_line_surfaces_a_history_error_notice`.
        let dir = std::env::temp_dir().join(format!("tosse-codex-badline-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-badline.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{}", line("event_msg", json!({ "type": "user_message", "message": "salut" }))).unwrap();
        writeln!(f, "not json at all").unwrap();
        drop(f);

        let items = parse_rollout(&path);
        std::fs::remove_dir_all(&dir).ok();

        // The good turn still restores…
        assert!(items.iter().any(|i| is_user(i, "salut")), "the well-formed turn must restore");
        // …and the skipped malformed line surfaces a visible history_error notice (never silent).
        assert!(
            items.iter().any(|i| matches!(i, ConversationItem::Notice { subtype, .. } if subtype == "history_error")),
            "a skipped malformed rollout line must surface a history_error notice, got {items:#?}"
        );
    }

    #[test]
    fn parse_rollout_surfaces_a_notice_when_the_file_is_unreadable() {
        // Invalid UTF-8 → read_to_string errors with InvalidData (NOT NotFound) → the IO-error
        // branch must surface a history_error notice, not a silently-empty conversation. (A
        // truncated-mid-write kill that leaves invalid bytes is the realistic trigger.)
        let dir = std::env::temp_dir().join(format!("tosse-codex-badutf8-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-badutf8.jsonl");
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x9f]).unwrap();

        let items = parse_rollout(&path);
        std::fs::remove_dir_all(&dir).ok();

        assert!(
            items.iter().any(|i| matches!(i, ConversationItem::Notice { subtype, .. } if subtype == "history_error")),
            "an unreadable rollout must surface a history_error notice, not an empty conversation"
        );
    }
}
