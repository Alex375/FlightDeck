//! Disk readers for background-task artifacts — the socle's disk-reading layer.
//!
//! `claude` writes per-task artifacts under a session's OWN directory, a sibling of
//! its `<session_id>.jsonl` transcript:
//!
//! ```text
//! <config>/projects/<cwd-slug>/<session_id>/
//!   ├── tasks/<task_id>.output                  ← Bash-bg AND Monitor (local_bash)
//!   ├── workflows/wf_<id>.json                  ← workflow run manifest
//!   └── subagents/
//!       ├── agent-<agentId>.jsonl               ← Agent sub-agent transcript
//!       └── workflows/wf_<id>/agent-<id>.jsonl  ← workflow agent transcript
//! ```
//!
//! These are pure, one-shot reads (the IPC layer runs them off the async runtime via
//! `spawn_blocking`). LIVE tailing/watching of a still-running task's output is
//! layered on top by the Monitor / Bash-bg display tasks (the `notify` crate) — the
//! socle just exposes the readers.
//!
//! We locate the session dir by scanning every project dir for a `<session_id>`
//! directory, mirroring how [`super::history`] globs for the transcript: Claude's
//! cwd→slug encoding is lossy (both `/` and `.` map to `-`), so we never invert it.
//! A session that moves its cwd mid-run (EnterWorktree) splits its artifacts across
//! MULTIPLE slugs, so we probe EVERY matching session dir, not just the first (see
//! [`session_dirs`]).
//!
//! NOTE for consumers: when a LIVE [`super::model::BackgroundTask`] is in hand, its
//! `output_file` already carries the exact absolute artifact path the CLI reported —
//! prefer reading that directly. The session-id scan here is the cold-resume fallback
//! (no live task in memory, e.g. reopening a past conversation), where only the ids
//! persisted in the transcript are available.

use std::path::{Path, PathBuf};

use super::history::{claude_config_dir, parse_transcript_str, project_dirs};
use super::model::{
    ConversationItem, WorkflowJournal, WorkflowJournalAgent, WorkflowPhase, WorkflowRun,
};

/// Cap on how deep we recurse under `subagents/` looking for a transcript — enough
/// for `subagents/workflows/wf_<id>/agent-<id>.jsonl` (depth 3) with margin, while
/// never walking an unbounded tree.
const MAX_SUBAGENT_DEPTH: usize = 4;

/// Reject an id that could escape the session directory once interpolated into a path.
/// Ids on the wire are UUIDs / `wf_…` / `tk_…` / agent slugs — ASCII alphanumerics plus
/// `-`/`_`. Anything carrying a path separator, `..`, or any other byte is refused, so a
/// crafted id (e.g. `../../../../etc/passwd`) can never walk outside `<session_dir>`.
/// Defense-in-depth: today the only id source is the trusted `claude` binary, but these
/// readers must stay the validated gatekeepers (same principle as `git::mod` /
/// `store::db`). Cost is nil for the legitimate UUID/slug case.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// EVERY artifact directory for a session (`<config>/projects/<slug>/<session_id>`),
/// across ALL project slugs that hold such a subdir.
///
/// A session that MOVES its cwd mid-run (the native `EnterWorktree` tool) writes artifacts
/// under MORE THAN ONE slug: the early ones land under the original cwd's slug, while a
/// workflow (or sub-agent) launched AFTER the move lands under the worktree's slug. So a
/// single "first match wins" lookup is wrong — it may return the original-cwd dir (which
/// holds `tool-results/`/`subagents/` but no `workflows/`) and miss the manifest entirely,
/// surfacing as a permanent "workflow indisponible". Callers therefore probe every match
/// for the artifact they want. Order follows [`super::history::project_dirs`] (filesystem
/// order); its loud-on-IO-error scan means a permission/IO error is never silently equated
/// with "absent" (finding #4).
fn session_dirs(config_dir: &Path, session_id: &str) -> Vec<PathBuf> {
    project_dirs(config_dir)
        .into_iter()
        .map(|dir| dir.join(session_id))
        .filter(|candidate| candidate.is_dir())
        .collect()
}

/// Load and normalize a sub-agent's full transcript into the same
/// [`ConversationItem`]s the live path produces, so the UI renders it with the
/// existing conversation components. Works for both a plain `Agent` sub-agent
/// (`subagents/agent-<id>.jsonl`) and a workflow agent
/// (`subagents/workflows/wf_<id>/agent-<id>.jsonl`) — we search `subagents/` for the
/// matching file. An absent/unreadable transcript yields an empty vec (a normal
/// state, not an error).
pub fn load_subagent_transcript(session_id: &str, agent_id: &str) -> Vec<ConversationItem> {
    match claude_config_dir() {
        Some(dir) => load_subagent_transcript_in(&dir, session_id, agent_id),
        None => Vec::new(),
    }
}

fn load_subagent_transcript_in(
    config_dir: &Path,
    session_id: &str,
    agent_id: &str,
) -> Vec<ConversationItem> {
    if !is_safe_id(session_id) || !is_safe_id(agent_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, agent={agent_id:?})");
        return Vec::new();
    }
    // Probe every project slug holding this session (a cwd move splits artifacts across
    // slugs) for the agent transcript; the first dir that has it wins.
    let file_name = format!("agent-{agent_id}.jsonl");
    let Some(path) = session_dirs(config_dir, session_id)
        .into_iter()
        .find_map(|dir| find_file_recursive(&dir.join("subagents"), &file_name, MAX_SUBAGENT_DEPTH))
    else {
        return Vec::new();
    };
    match std::fs::read_to_string(&path) {
        // A sub-agent's transcript is ENTIRELY sidechain, so keep every line. Any
        // malformed lines are logged (the drill-down view, when built, can surface them).
        Ok(content) => {
            let (items, skipped) = parse_transcript_str(&content, false);
            if skipped > 0 {
                eprintln!(
                    "[subagents] {skipped} unparseable line(s) skipped in {}",
                    path.display()
                );
            }
            items
        }
        // `find_file_recursive` already confirmed the file exists, so a read error here
        // is a real failure (permission/IO), not "absent" — log it, never silent.
        Err(e) => {
            eprintln!("[subagents] cannot read sub-agent transcript {}: {e}", path.display());
            Vec::new()
        }
    }
}

/// Read a workflow run's manifest (`workflows/<run_id>.json`) into a [`WorkflowRun`].
/// `run_id` is the `"wf_…"` id; for convenience a bare id is also tried with the `wf_` prefix.
///
/// `Ok(None)` = the manifest is ABSENT (normal: no run yet, or it's still running and the CLI
/// writes the manifest only at the end). `Err(msg)` = the manifest EXISTS but could not be read
/// or parsed (corrupt, truncated mid-write, CLI schema drift, IO error) — a REAL failure that
/// MUST surface to the user, never be silently equated with "missing" (unified error policy).
pub fn load_workflow_run(session_id: &str, run_id: &str) -> Result<Option<WorkflowRun>, String> {
    match claude_config_dir() {
        Some(dir) => load_workflow_run_in(&dir, session_id, run_id),
        None => Ok(None),
    }
}

fn load_workflow_run_in(
    config_dir: &Path,
    session_id: &str,
    run_id: &str,
) -> Result<Option<WorkflowRun>, String> {
    if !is_safe_id(session_id) || !is_safe_id(run_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, run={run_id:?})");
        return Ok(None);
    }
    // The manifest is named `<run_id>.json`; a bare id (no `wf_`) also tries the
    // `wf_`-prefixed name. Probe these names under the `workflows/` of EVERY project slug
    // holding this session — a workflow launched after an EnterWorktree sits under the
    // worktree's slug, not the original cwd's. The first existing file wins.
    let mut names = vec![format!("{run_id}.json")];
    if !run_id.starts_with("wf_") {
        names.push(format!("wf_{run_id}.json"));
    }
    let path = session_dirs(config_dir, session_id).into_iter().find_map(|dir| {
        let workflows = dir.join("workflows");
        names.iter().map(|n| workflows.join(n)).find(|p| p.is_file())
    });
    // Absent everywhere = normal ("no run to show, or not written yet").
    let Some(path) = path else {
        return Ok(None);
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        // The file existed a moment ago; if it's now gone (a race with the writer), treat as
        // absent. Any other IO error on an existing file is a REAL failure → surface it.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("failed to read manifest {}: {e}", path.display())),
    };
    // A present-but-unparseable manifest (corrupt, truncated mid-write, or a CLI schema change)
    // is a REAL failure, NOT the normal "absent" state — surface it so the UI shows the error
    // instead of a misleading "not found". Re-capture the fixture if the CLI shape changes.
    serde_json::from_str::<WorkflowRun>(&content)
        .map(Some)
        .map_err(|e| format!("unreadable manifest {}: {e}", path.display()))
}

/// The two fields of a journal entry we care about. Deliberately NOT `serde_json::Value`:
/// a `result` entry embeds the agent's ENTIRE return value (real journals reach hundreds of
/// KiB), and this file is re-read on every change of a running workflow. Deserializing into
/// this struct lets serde SKIP `result` (and the cache `key`) without materializing them.
#[derive(serde::Deserialize)]
struct JournalLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
}

/// Read a RUNNING workflow's live progress from its append-only journal
/// (`subagents/workflows/<run_id>/journal.jsonl`). The rich manifest is written only at the
/// END of a run, so during the run this journal is the only on-disk "how far along" signal:
/// `{"type":"started",agentId}` (agent spawned) then `{"type":"result",agentId}` (agent done).
/// We keep the AGENT IDS, not just tallies — they key each agent's incrementally-written
/// transcript, so the UI can show (and drill into) what is running right now. The run dir is
/// named exactly `<run_id>` (the `wf_…` id). Probes every project slug holding the session (a
/// cwd move splits artifacts across slugs).
///
/// `Ok(None)` = no journal yet (normal: the very first moments, or a resumed past run). `Err`
/// = a real IO error reading an existing journal (surfaced, never silent). Individual malformed
/// JSON lines are skipped (the journal is appended live, so a final partial line is expected).
pub fn load_workflow_journal(session_id: &str, run_id: &str) -> Result<Option<WorkflowJournal>, String> {
    match claude_config_dir() {
        Some(dir) => load_workflow_journal_in(&dir, session_id, run_id),
        None => Ok(None),
    }
}

/// The on-disk directory holding a run's live artifacts (`journal.jsonl` + one transcript
/// per agent), or `None` while no slug holding this session has it yet — the normal state
/// for the first moments of a run, since the CLI creates it with the first agent.
///
/// Exists for the live watcher ([`super::workflow_watch`]), which must watch the DIRECTORY:
/// watching `journal.jsonl` itself would fail while it is still absent, and re-watching an
/// atomically-replaced file is a class of bug we avoid entirely by watching its parent.
pub fn workflow_run_dir(session_id: &str, run_id: &str) -> Option<PathBuf> {
    let config_dir = claude_config_dir()?;
    if !is_safe_id(session_id) || !is_safe_id(run_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, run={run_id:?})");
        return None;
    }
    session_dirs(&config_dir, session_id)
        .into_iter()
        .map(|dir| dir.join("subagents").join("workflows").join(run_id))
        .find(|p| p.is_dir())
}

fn load_workflow_journal_in(
    config_dir: &Path,
    session_id: &str,
    run_id: &str,
) -> Result<Option<WorkflowJournal>, String> {
    if !is_safe_id(session_id) || !is_safe_id(run_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, run={run_id:?})");
        return Ok(None);
    }
    let mut content: Option<String> = None;
    for dir in session_dirs(config_dir, session_id) {
        let path = dir.join("subagents").join("workflows").join(run_id).join("journal.jsonl");
        match std::fs::read_to_string(&path) {
            Ok(c) => {
                content = Some(c);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // An existing journal that won't read (permission/IO) is a REAL failure → surface.
            Err(e) => return Err(format!("failed to read journal {}: {e}", path.display())),
        }
    }
    let Some(content) = content else {
        return Ok(None);
    };
    Ok(Some(parse_workflow_journal(&content)))
}

/// Fold a journal's text into per-agent state. Agents are keyed by `agentId` and kept in
/// FIRST-SEEN order, so a re-emitted `started` can't double-count and a `result` for an agent
/// whose `started` we never saw (a resumed/cached run) still registers rather than vanishing.
/// A malformed line (e.g. the final partial line of a live append) is skipped — expected, not
/// an error. An entry without an `agentId` still moves the tallies via a positional key, so a
/// shape change in the CLI degrades to "counts only" instead of to zero.
fn parse_workflow_journal(content: &str) -> WorkflowJournal {
    let mut agents: Vec<WorkflowJournalAgent> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (n, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<JournalLine>(line) else {
            continue;
        };
        let done = match entry.kind.as_str() {
            "started" => false,
            "result" => true,
            _ => continue,
        };
        // No id (unexpected shape): fall back to a per-line key so the agent is still counted.
        let key = entry.agent_id.unwrap_or_else(|| format!("#line-{n}"));
        match index.get(&key) {
            Some(&i) => {
                // `done` only ever moves false → true: a stray later `started` for an already
                // finished agent must not resurrect it as in-flight.
                agents[i].done |= done;
            }
            None => {
                index.insert(key.clone(), agents.len());
                agents.push(WorkflowJournalAgent { agent_id: key, done });
            }
        }
    }
    let done = agents.iter().filter(|a| a.done).count() as u64;
    WorkflowJournal { started: agents.len() as u64, done, agents }
}

/// The declared phases of a workflow, read from its SCRIPT's `meta.phases` — the only source
/// of the FULL phase list (including not-yet-reached phases) that exists DURING the run. The
/// rich manifest (which also carries `phases`) is written only at the end; the wire's
/// `task_progress` reveals a phase only once reached. But the script is written at t=0 (under
/// `workflows/scripts/…-<run_id>.js`), so parsing its `meta.phases` lets the live overview show
/// upcoming steps too. `meta` is a guaranteed pure literal (the Workflow tool enforces this),
/// so the string-aware scan in [`extract_meta_phases`] is reliable.
///
/// `Ok(vec)` (possibly empty) = no script/phases yet, the NORMAL state. `Err` = a real IO
/// failure reading an existing script (surfaced, never silent). The script file name embeds
/// the run id and ends with `-<run_id>.js`, so we anchor the match on that suffix (not a loose
/// substring) to avoid picking another run whose id is a prefix.
pub fn load_workflow_phases(session_id: &str, run_id: &str) -> Result<Vec<WorkflowPhase>, String> {
    match claude_config_dir() {
        Some(dir) => load_workflow_phases_in(&dir, session_id, run_id),
        None => Ok(Vec::new()),
    }
}

fn load_workflow_phases_in(
    config_dir: &Path,
    session_id: &str,
    run_id: &str,
) -> Result<Vec<WorkflowPhase>, String> {
    if !is_safe_id(session_id) || !is_safe_id(run_id) {
        eprintln!("[subagents] refusing unsafe id (session={session_id:?}, run={run_id:?})");
        return Ok(Vec::new());
    }
    let suffix = format!("-{run_id}.js");
    for dir in session_dirs(config_dir, session_id) {
        let scripts = dir.join("workflows").join("scripts");
        let entries = match std::fs::read_dir(&scripts) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("scan de {} : {e}", scripts.display())),
        };
        // The script is `<workflow-name>-<run_id>.js` (suffix anchored). Fall back to a loose
        // contains() only if no suffix match, for forward-compat with a naming change.
        let mut loose: Option<std::path::PathBuf> = None;
        let mut exact: Option<std::path::PathBuf> = None;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(&suffix) {
                exact = Some(entry.path());
                break;
            }
            if loose.is_none() && name.ends_with(".js") && name.contains(run_id) {
                loose = Some(entry.path());
            }
        }
        if let Some(path) = exact.or(loose) {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("failed to read script {}: {e}", path.display()))?;
            let phases = extract_meta_phases(&content);
            if !phases.is_empty() {
                return Ok(phases);
            }
        }
    }
    Ok(Vec::new())
}

/// Byte of a JS identifier (so a `key` match isn't part of a longer word).
fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

/// Index of the delimiter matching the opener at `s[start]` (`open`/`close`, e.g. `[`/`]`),
/// skipping any that appear INSIDE a JS string literal (`'…'`, `"…"`, `` `…` ``) so brackets
/// or braces in a `detail` string never throw the scan off. `None` if unbalanced.
fn match_delim(s: &[u8], start: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = start;
    let mut quote: Option<u8> = None;
    while i < s.len() {
        let c = s[i];
        match quote {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == b'\'' || c == b'"' || c == b'`' {
                    quote = Some(c);
                } else if c == open {
                    depth += 1;
                } else if c == close {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Parse exactly `len` hex digits of `s` starting at `start` into a codepoint. `None` if any
/// digit is missing/non-hex (so a malformed `\x`/`\u` degrades gracefully).
fn hex_val(s: &[u8], start: usize, len: usize) -> Option<u32> {
    if len == 0 || start + len > s.len() {
        return None;
    }
    let mut v: u32 = 0;
    for &b in &s[start..start + len] {
        let d = (b as char).to_digit(16)?;
        v = v * 16 + d;
    }
    Some(v)
}

/// Push a codepoint's UTF-8 bytes to `out` (dropping an invalid scalar value silently — a
/// surrogate half can't appear in well-formed source).
fn push_char(out: &mut Vec<u8>, cp: u32) {
    if let Some(c) = char::from_u32(cp) {
        let mut buf = [0u8; 4];
        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }
}

/// Read a JS string literal at `s[start]` (a quote byte). Returns the UNESCAPED content and the
/// index just past the closing quote. `None` if unterminated. Handles the common JS escapes,
/// including `\uXXXX`, `\u{X..}` and `\xNN` (decoded to UTF-8) and `\0 \b \f \v` — an unknown
/// escape preserves BOTH the backslash and the char (so e.g. a Windows path `\\t` already
/// collapsed, or a stray `\d`, is not silently corrupted).
fn read_js_string(s: &[u8], start: usize) -> Option<(String, usize)> {
    let q = s[start];
    let mut i = start + 1;
    let mut out: Vec<u8> = Vec::new();
    while i < s.len() {
        let c = s[i];
        if c == b'\\' && i + 1 < s.len() {
            let n = s[i + 1];
            match n {
                b'n' => { out.push(b'\n'); i += 2; }
                b't' => { out.push(b'\t'); i += 2; }
                b'r' => { out.push(b'\r'); i += 2; }
                b'b' => { out.push(0x08); i += 2; }
                b'f' => { out.push(0x0c); i += 2; }
                b'v' => { out.push(0x0b); i += 2; }
                b'0' => { out.push(0x00); i += 2; }
                b'\'' | b'"' | b'`' | b'\\' | b'/' => { out.push(n); i += 2; }
                b'x' => {
                    // \xNN — exactly two hex digits.
                    if let Some(cp) = hex_val(s, i + 2, 2) {
                        push_char(&mut out, cp);
                        i += 4;
                    } else {
                        out.push(b'\\'); // malformed → keep literal backslash + 'x'
                        i += 1;
                    }
                }
                b'u' => {
                    // \u{X..} (1-6 hex) or \uXXXX (exactly 4 hex).
                    if s.get(i + 2) == Some(&b'{') {
                        if let Some(end) = (i + 3..s.len().min(i + 11)).find(|&j| s[j] == b'}') {
                            if let Some(cp) = hex_val(s, i + 3, end - (i + 3)) {
                                push_char(&mut out, cp);
                                i = end + 1;
                                continue;
                            }
                        }
                        out.push(b'\\');
                        i += 1;
                    } else if let Some(cp) = hex_val(s, i + 2, 4) {
                        push_char(&mut out, cp);
                        i += 6;
                    } else {
                        out.push(b'\\');
                        i += 1;
                    }
                }
                // Unknown escape: preserve the backslash (then the char is copied next loop).
                _ => { out.push(b'\\'); i += 1; }
            }
            continue;
        }
        if c == q {
            return Some((String::from_utf8_lossy(&out).into_owned(), i + 1));
        }
        out.push(c);
        i += 1;
    }
    None
}

/// Read the string value of `key` in an object-literal slice (`key: "…"`). String-aware: it
/// skips over string contents, so it never matches `key` appearing inside another value.
/// `None` if the key is absent or its value isn't a string literal.
fn obj_str_value(obj: &str, key: &str) -> Option<String> {
    let b = obj.as_bytes();
    let kb = key.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'\'' || c == b'"' || c == b'`' {
            match read_js_string(b, i) {
                Some((_, end)) => {
                    i = end;
                    continue;
                }
                None => return None,
            }
        }
        if c == kb[0] && i + kb.len() <= b.len() && &b[i..i + kb.len()] == kb {
            let before_ok = i == 0 || !is_ident_byte(b[i - 1]);
            let after = i + kb.len();
            let after_ok = after >= b.len() || !is_ident_byte(b[after]);
            if before_ok && after_ok {
                let mut j = after;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < b.len() && b[j] == b':' {
                    j += 1;
                    while j < b.len() && b[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if j < b.len() && (b[j] == b'\'' || b[j] == b'"' || b[j] == b'`') {
                        return read_js_string(b, j).map(|(v, _)| v);
                    }
                    return None; // present but not a string value
                }
            }
        }
        i += 1;
    }
    None
}

/// Extract `meta.phases` (title + optional detail, in order) from a workflow script's source.
/// `meta` is a guaranteed pure literal, so a string-aware scan suffices: locate the `phases:`
/// array, split its top-level `{…}` objects, and read each object's `title`/`detail`. Robust to
/// brackets/braces/quotes inside a `detail`. Returns `[]` if there is no `phases` array.
pub fn extract_meta_phases(script: &str) -> Vec<WorkflowPhase> {
    let b = script.as_bytes();
    let key = b"phases";
    let mut i = 0;
    let mut array: Option<(usize, usize)> = None;
    while i < b.len() {
        let c = b[i];
        if c == b'\'' || c == b'"' || c == b'`' {
            match read_js_string(b, i) {
                Some((_, end)) => {
                    i = end;
                    continue;
                }
                None => break,
            }
        }
        if c == b'p' && i + key.len() <= b.len() && &b[i..i + key.len()] == key {
            let before_ok = i == 0 || !is_ident_byte(b[i - 1]);
            let after = i + key.len();
            let after_ok = after >= b.len() || !is_ident_byte(b[after]);
            if before_ok && after_ok {
                let mut j = after;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < b.len() && b[j] == b':' {
                    j += 1;
                    while j < b.len() && b[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if j < b.len() && b[j] == b'[' {
                        if let Some(close) = match_delim(b, j, b'[', b']') {
                            array = Some((j, close));
                            break;
                        }
                    }
                }
            }
        }
        i += 1;
    }
    let Some((open, close)) = array else {
        return Vec::new();
    };
    let mut phases = Vec::new();
    let mut k = open + 1;
    while k < close {
        let c = b[k];
        if c == b'{' {
            if let Some(end) = match_delim(b, k, b'{', b'}') {
                let obj = &script[k..=end];
                if let Some(title) = obj_str_value(obj, "title") {
                    phases.push(WorkflowPhase {
                        title,
                        detail: obj_str_value(obj, "detail"),
                    });
                }
                k = end + 1;
                continue;
            }
        }
        if c == b'\'' || c == b'"' || c == b'`' {
            if let Some((_, end)) = read_js_string(b, k) {
                k = end;
                continue;
            }
        }
        k += 1;
    }
    phases
}

/// Read a background task's output from the ABSOLUTE path the CLI reported on the wire
/// (`BackgroundTask.output_file`). This is the reliable reader: the CLI writes Bash-bg /
/// Monitor output to a temp dir (`/tmp/claude-<uid>/<slug>/<session>/tasks/<id>.output`),
/// NOT under the session dir, so the path can't be reconstructed — only echoed.
///
/// Guarded so this can't become an arbitrary-file read: the path must name a
/// `…/tasks/<file>.output` file (a `tasks` parent dir + an `.output` extension). Same
/// gatekeeper principle as [`is_safe_id`]. `None` when the guard fails or the file is
/// absent/unreadable (a non-NotFound IO error is logged).
pub fn read_task_output_file(path: &str) -> Option<String> {
    let p = Path::new(path);
    let is_output = p.extension().and_then(|e| e.to_str()) == Some("output");
    let in_tasks_dir = p.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str()) == Some("tasks");
    if !is_output || !in_tasks_dir {
        eprintln!("[subagents] refusing non-task output path {path:?}");
        return None;
    }
    match std::fs::read_to_string(p) {
        Ok(c) => Some(c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            eprintln!("[subagents] cannot read task output {path:?}: {e}");
            None
        }
    }
}

/// Depth-bounded search for a file named exactly `file_name` under `root`. Returns
/// the first match (sub-agent transcript ids are unique, so the first hit is the
/// one). `depth` counts remaining directory levels to descend.
fn find_file_recursive(root: &Path, file_name: &str, depth: usize) -> Option<PathBuf> {
    let direct = root.join(file_name);
    if direct.is_file() {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    // An absent dir → `None` (nothing to find); a permission/IO error is DISTINCT and
    // logged before `None`, never silently equated with "not found" (mirrors the policy
    // of `session_dirs` / `project_dirs`).
    let entries = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("[subagents] cannot scan {} for {file_name}: {e}", root.display());
            return None;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, file_name, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::model::NormalizedBlock;
    use std::io::Write;

    /// Build a fake `<config>/projects/<slug>/<session_id>/` artifact tree and read
    /// each artifact back through the public (config-dir-injected) readers.
    #[test]
    fn reads_subagent_transcript_workflow_manifest_and_task_output() {
        let base = std::env::temp_dir().join(format!("tosse-sub-{}", std::process::id()));
        let session_id = "ssssssss-1111-2222-3333-444444444444";
        let session_dir = base.join("projects").join("-some-cwd").join(session_id);
        std::fs::create_dir_all(session_dir.join("subagents")).unwrap();
        std::fs::create_dir_all(session_dir.join("subagents/workflows/wf_abc")).unwrap();
        std::fs::create_dir_all(session_dir.join("workflows")).unwrap();

        // A plain Agent sub-agent transcript — entirely sidechain, must be KEPT.
        let mut f = std::fs::File::create(session_dir.join("subagents/agent-aaa.jsonl")).unwrap();
        for l in [
            r#"{"type":"user","isSidechain":true,"uuid":"u1","message":{"role":"user","content":"do the thing"}}"#,
            r#"{"type":"assistant","isSidechain":true,"uuid":"a1","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"done"}]}}"#,
        ] {
            writeln!(f, "{l}").unwrap();
        }
        drop(f);

        // A workflow agent transcript nested two levels deep (find_file_recursive).
        let mut f =
            std::fs::File::create(session_dir.join("subagents/workflows/wf_abc/agent-bbb.jsonl"))
                .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","isSidechain":true,"uuid":"a2","message":{{"id":"m2","role":"assistant","content":[{{"type":"text","text":"wf agent"}}]}}}}"#
        )
        .unwrap();
        drop(f);

        // A workflow manifest (camelCase, as on disk).
        let mut f = std::fs::File::create(session_dir.join("workflows/wf_abc.json")).unwrap();
        write!(
            f,
            r#"{{"runId":"wf_abc","taskId":"tk1","status":"completed","durationMs":1234,"agentCount":2,"defaultModel":"claude-opus-4-8","phases":[{{"title":"Review","detail":"d"}}],"workflowProgress":[{{"type":"workflow_phase","index":1,"title":"Review"}}],"result":{{"ok":true}}}}"#
        )
        .unwrap();
        drop(f);

        // --- sub-agent transcript (sidechain kept) ---
        let items = load_subagent_transcript_in(&base, session_id, "aaa");
        assert_eq!(items.len(), 2, "got {items:#?}");
        assert!(matches!(&items[0], ConversationItem::UserMessage { text, .. } if text == "do the thing"));
        match &items[1] {
            ConversationItem::AssistantMessage { blocks, .. } => {
                assert!(matches!(&blocks[0], NormalizedBlock::Text { text } if text == "done"));
            }
            other => panic!("expected AssistantMessage, got {other:?}"),
        }

        // --- nested workflow agent transcript ---
        let wf_items = load_subagent_transcript_in(&base, session_id, "bbb");
        assert_eq!(wf_items.len(), 1, "the nested workflow agent transcript should be found");

        // --- workflow manifest ---
        let run = load_workflow_run_in(&base, session_id, "wf_abc").unwrap().expect("manifest parses");
        assert_eq!(run.run_id, "wf_abc");
        assert_eq!(run.task_id.as_deref(), Some("tk1"));
        assert_eq!(run.status.as_deref(), Some("completed"));
        assert_eq!(run.duration_ms, Some(1234));
        assert_eq!(run.agent_count, Some(2));
        assert_eq!(run.phases.len(), 1);
        assert_eq!(run.phases[0].title, "Review");
        assert_eq!(run.result["ok"], serde_json::json!(true));
        // A bare id (no `wf_`) resolves to the same manifest via the prefix retry.
        assert!(load_workflow_run_in(&base, session_id, "abc").unwrap().is_some());

        std::fs::remove_dir_all(&base).ok();
    }

    /// A session that MOVED its cwd mid-run (EnterWorktree) has its `<session_id>` dir under
    /// TWO project slugs: the original cwd holds early artifacts (e.g. `subagents/`) but no
    /// `workflows/`, while the worktree slug holds the manifest + workflow-agent transcripts.
    /// The readers must probe BOTH and find the artifact under the second slug — the previous
    /// "first match wins" lookup returned the manifest-less dir and reported it as absent.
    #[test]
    fn artifacts_split_across_two_project_slugs_are_found() {
        let base = std::env::temp_dir().join(format!("tosse-sub-split-{}", std::process::id()));
        let session_id = "ssssssss-1111-2222-3333-444444444444";
        // Slug A (original cwd): exists for this session but has only subagents/, no workflows/.
        // Its name sorts BEFORE slug B, so it is the one a first-match lookup would return.
        let slug_a = base.join("projects").join("-repo").join(session_id);
        std::fs::create_dir_all(slug_a.join("subagents")).unwrap();
        // Slug B (worktree cwd): holds the manifest AND the workflow agent transcript.
        let slug_b = base
            .join("projects")
            .join("-repo--claude-worktrees-feat")
            .join(session_id);
        std::fs::create_dir_all(slug_b.join("workflows")).unwrap();
        std::fs::create_dir_all(slug_b.join("subagents/workflows/wf_split")).unwrap();
        std::fs::write(
            slug_b.join("workflows/wf_split.json"),
            r#"{"runId":"wf_split","status":"running"}"#,
        )
        .unwrap();
        std::fs::write(
            slug_b.join("subagents/workflows/wf_split/agent-zzz.jsonl"),
            "{\"type\":\"assistant\",\"isSidechain\":true,\"uuid\":\"a\",\"message\":{\"id\":\"m\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n",
        )
        .unwrap();

        // The manifest is found under slug B even though slug A's session dir matches first.
        let run = load_workflow_run_in(&base, session_id, "wf_split").unwrap().expect("manifest under slug B");
        assert_eq!(run.run_id, "wf_split");
        // The workflow agent transcript is likewise found under slug B.
        let items = load_subagent_transcript_in(&base, session_id, "zzz");
        assert_eq!(items.len(), 1, "workflow agent transcript found across slugs");

        std::fs::remove_dir_all(&base).ok();
    }

    /// The live journal reader counts `started` vs `result` entries (the mid-run "how far
    /// along" signal, since the manifest only lands at the end), tolerates a trailing partial
    /// line (the journal is appended live), and finds the journal across project slugs.
    #[test]
    fn workflow_journal_counts_started_and_done() {
        let base = std::env::temp_dir().join(format!("tosse-sub-journal-{}", std::process::id()));
        let session_id = "ssssssss-1111-2222-3333-444444444444";
        // Slug A matches first but has no journal; the journal lives under slug B.
        std::fs::create_dir_all(base.join("projects").join("-repo").join(session_id)).unwrap();
        let run_dir = base
            .join("projects")
            .join("-repo--claude-worktrees-feat")
            .join(session_id)
            .join("subagents/workflows/wf_j");
        std::fs::create_dir_all(&run_dir).unwrap();
        // 3 started, 2 result, a blank line, and a TRAILING PARTIAL line (live append).
        std::fs::write(
            run_dir.join("journal.jsonl"),
            "{\"type\":\"started\",\"agentId\":\"a\"}\n\
             {\"type\":\"started\",\"agentId\":\"b\"}\n\
             {\"type\":\"result\",\"agentId\":\"a\"}\n\
             \n\
             {\"type\":\"started\",\"agentId\":\"c\"}\n\
             {\"type\":\"result\",\"agentId\":\"b\"}\n\
             {\"type\":\"resu",
        )
        .unwrap();

        let j = load_workflow_journal_in(&base, session_id, "wf_j").unwrap().expect("journal found");
        assert_eq!(j.started, 3);
        assert_eq!(j.done, 2);
        // The agent IDS survive (they key each agent's live transcript) in spawn order, with
        // `c` — started, no result yet — still in flight.
        assert_eq!(
            j.agents.iter().map(|a| (a.agent_id.as_str(), a.done)).collect::<Vec<_>>(),
            [("a", true), ("b", true), ("c", false)],
        );

        // Absent journal (no run dir) → Ok(None), not an error.
        assert!(load_workflow_journal_in(&base, session_id, "wf_absent").unwrap().is_none());

        std::fs::remove_dir_all(&base).ok();
    }

    /// The journal fold: counts come from DISTINCT agent ids, a `result` never regresses to
    /// in-flight, an id-less entry still counts, and a huge `result` payload is skipped by the
    /// parser rather than materialized.
    #[test]
    fn journal_fold_dedups_agents_and_tolerates_shape_drift() {
        // A re-emitted `started` for the same agent must not double-count, and a later stray
        // `started` after the `result` must not resurrect it.
        let j = parse_workflow_journal(
            "{\"type\":\"started\",\"agentId\":\"a\"}\n\
             {\"type\":\"started\",\"agentId\":\"a\"}\n\
             {\"type\":\"result\",\"agentId\":\"a\"}\n\
             {\"type\":\"started\",\"agentId\":\"a\"}\n",
        );
        assert_eq!((j.started, j.done), (1, 1));
        assert_eq!(j.agents.len(), 1);
        assert!(j.agents[0].done);

        // A `result` whose `started` we never saw (resumed/cached run) still registers.
        let j = parse_workflow_journal("{\"type\":\"result\",\"agentId\":\"ghost\"}\n");
        assert_eq!((j.started, j.done), (1, 1));

        // An entry with no `agentId` (shape drift) still moves the tally — degrade to
        // "counts only", never to zero. Unknown types and junk lines are ignored.
        let j = parse_workflow_journal(
            "{\"type\":\"started\"}\n\
             {\"type\":\"started\"}\n\
             {\"type\":\"heartbeat\",\"agentId\":\"z\"}\n\
             not json at all\n",
        );
        assert_eq!((j.started, j.done), (2, 0));

        // A fat `result` payload parses (and is skipped, not kept) — the shape real journals have.
        let fat = format!(
            "{{\"type\":\"result\",\"key\":\"v2:abc\",\"agentId\":\"a\",\"result\":{{\"findings\":\"{}\"}}}}\n",
            "x".repeat(4096)
        );
        let j = parse_workflow_journal(&fat);
        assert_eq!((j.started, j.done), (1, 1));
        assert_eq!(j.agents[0].agent_id, "a");
    }

    /// Reality check against the developer's REAL `~/.claude` artifacts (ignored by default;
    /// no CI dependency). Set `TOSSE_RW_SESSION` + `TOSSE_RW_RUN` and run with
    /// `cargo test --lib realworld_load_workflow_run -- --ignored --nocapture` to confirm the
    /// PUBLIC reader resolves a real manifest end to end (the cwd-split case the unit test
    /// fakes). Prints what it found so a None is diagnosable.
    #[test]
    #[ignore]
    fn realworld_load_workflow_run() {
        let session = std::env::var("TOSSE_RW_SESSION").expect("set TOSSE_RW_SESSION");
        let run = std::env::var("TOSSE_RW_RUN").expect("set TOSSE_RW_RUN");
        let got = super::load_workflow_run(&session, &run);
        match &got {
            Ok(Some(r)) => eprintln!(
                "[realworld] OK run_id={} status={:?} phases={} progress_is_array={}",
                r.run_id,
                r.status,
                r.phases.len(),
                r.workflow_progress.is_array(),
            ),
            Ok(None) => eprintln!("[realworld] None — manifest NOT resolved for session={session} run={run}"),
            Err(e) => eprintln!("[realworld] Err — {e}"),
        }
        assert!(matches!(got, Ok(Some(_))), "expected to resolve the real manifest");
    }

    /// Reality check of the journal reader against the developer's REAL `~/.claude` artifacts
    /// (ignored by default; no CI dependency). Set `TOSSE_RW_SESSION` + `TOSSE_RW_RUN` and run
    /// with `cargo test --lib realworld_load_workflow_journal -- --ignored --nocapture`.
    ///
    /// Prints the parse time as well as the counts: a real journal inlines every agent's full
    /// return value (hundreds of KiB), and the live watcher re-reads it on every append — so
    /// "does it parse" and "is it cheap enough to re-read" are the same question here.
    #[test]
    #[ignore]
    fn realworld_load_workflow_journal() {
        let session = std::env::var("TOSSE_RW_SESSION").expect("set TOSSE_RW_SESSION");
        let run = std::env::var("TOSSE_RW_RUN").expect("set TOSSE_RW_RUN");
        let t0 = std::time::Instant::now();
        let got = super::load_workflow_journal(&session, &run);
        let elapsed = t0.elapsed();
        match &got {
            Ok(Some(j)) => eprintln!(
                "[realworld] OK started={} done={} in_flight={} agents[0..3]={:?} ({elapsed:?})",
                j.started,
                j.done,
                j.started - j.done,
                j.agents.iter().take(3).collect::<Vec<_>>(),
            ),
            Ok(None) => eprintln!("[realworld] None — no journal for session={session} run={run}"),
            Err(e) => eprintln!("[realworld] Err — {e}"),
        }
        let j = got.expect("reader must not fail").expect("expected a real journal");
        assert_eq!(j.started as usize, j.agents.len(), "counts derive from the agent list");
        assert!(j.done <= j.started, "an agent cannot finish before it starts");

        // Same resolution the live watcher does before it can watch anything: if this returns
        // None on a real run, the watcher never attaches and the readout silently never moves.
        let dir = super::workflow_run_dir(&session, &run).expect("watcher must resolve the run dir");
        eprintln!("[realworld] run dir = {}", dir.display());
        assert!(dir.join("journal.jsonl").is_file(), "the journal lives in the watched dir");
    }

    #[test]
    fn missing_artifacts_are_empty_or_none_not_errors() {
        let base = std::env::temp_dir().join("tosse-sub-missing-dir");
        assert!(load_subagent_transcript_in(&base, "nope", "x").is_empty());
        assert!(load_workflow_run_in(&base, "nope", "wf_x").unwrap().is_none());
    }

    #[test]
    fn extract_meta_phases_parses_titles_and_details() {
        // Mirrors a real script's meta (escaped quote + brackets inside a detail).
        let script = r#"
export const meta = {
  name: 'explore',
  description: 'desc with the word phases: tricky',
  phases: [
    { title: 'Explore', detail: '12 explorers [parallel] : a, b, c' },
    { title: 'Synthèse', detail: 'Fusion en une carte d\'architecture { unifiée }' },
    { title: 'Critique' },
  ],
}
phase('Explore')
"#;
        let phases = extract_meta_phases(script);
        assert_eq!(phases.len(), 3, "got {phases:?}");
        assert_eq!(phases[0].title, "Explore");
        assert_eq!(phases[0].detail.as_deref(), Some("12 explorers [parallel] : a, b, c"));
        assert_eq!(phases[1].title, "Synthèse");
        assert_eq!(phases[1].detail.as_deref(), Some("Fusion en une carte d'architecture { unifiée }"));
        assert_eq!(phases[2].title, "Critique");
        assert_eq!(phases[2].detail, None);
    }

    #[test]
    fn extract_meta_phases_handles_double_quotes_and_missing_phases() {
        let dq = r#"export const meta = { name: "x", phases: [ { title: "A" }, { title: "B" } ] }"#;
        let p = extract_meta_phases(dq);
        assert_eq!(p.iter().map(|x| x.title.as_str()).collect::<Vec<_>>(), ["A", "B"]);
        // No phases key → empty (a workflow may declare none).
        assert!(extract_meta_phases("export const meta = { name: 'x', description: 'y' }").is_empty());
        // A "phases" word inside a STRING must not be mistaken for the key.
        assert!(extract_meta_phases("export const meta = { description: 'see phases: none' }").is_empty());
    }

    #[test]
    fn corrupt_manifest_surfaces_error_not_silent_none() {
        let base = std::env::temp_dir().join(format!("tosse-sub-corrupt-{}", std::process::id()));
        let session_id = "ssssssss-1111-2222-3333-444444444444";
        let dir = base.join("projects").join("-repo").join(session_id).join("workflows");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("wf_bad.json"), "{ this is : not json,,, ").unwrap();
        // Present-but-corrupt → Err (must SURFACE), never Ok(None) (which the UI reads as "absent").
        assert!(load_workflow_run_in(&base, session_id, "wf_bad").is_err());
        // Truly absent → Ok(None) (normal).
        assert!(load_workflow_run_in(&base, session_id, "wf_missing").unwrap().is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn read_js_string_decodes_escapes_via_meta() {
        // é → é, \x41 → A, \t → tab, all inside a phase title.
        let script = "export const meta = { phases: [ { title: 'A\\u00e9B\\x41\\tC' } ] }";
        let p = extract_meta_phases(script);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "AéBA\tC");
        // \u{1F680} (rocket) and an UNKNOWN escape \d (backslash preserved).
        let s2 = "export const meta = { phases: [ { title: 'x\\u{1F680}y\\dz' } ] }";
        let p2 = extract_meta_phases(s2);
        assert_eq!(p2[0].title, "x🚀y\\dz");
    }

    #[test]
    fn load_workflow_phases_reads_script_meta_across_slugs() {
        let base = std::env::temp_dir().join(format!("tosse-sub-phases-{}", std::process::id()));
        let session_id = "ssssssss-1111-2222-3333-444444444444";
        std::fs::create_dir_all(base.join("projects").join("-repo").join(session_id)).unwrap();
        let scripts = base
            .join("projects")
            .join("-repo--claude-worktrees-feat")
            .join(session_id)
            .join("workflows/scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(
            scripts.join("review-changes-wf_ph.js"),
            "export const meta = { name: 'r', phases: [ { title: 'Find' }, { title: 'Verify' } ] }\n",
        )
        .unwrap();
        let phases = load_workflow_phases_in(&base, session_id, "wf_ph").unwrap();
        assert_eq!(phases.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), ["Find", "Verify"]);
        // No matching script → empty.
        assert!(load_workflow_phases_in(&base, session_id, "wf_other").unwrap().is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    /// Reading by the CLI-reported ABSOLUTE path (the reliable reader: the CLI writes
    /// background output to a temp dir, not the session dir). Reads a real `tasks/*.output`
    /// file, and refuses any path that is not a `…/tasks/<file>.output` (no arbitrary read).
    #[test]
    fn read_task_output_file_reads_absolute_path_and_guards() {
        let dir = std::env::temp_dir()
            .join(format!("tosse-taskout-{}", std::process::id()))
            .join("tasks");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("by7jmgia3.output");
        std::fs::write(&path, "live tail line\n").unwrap();
        assert_eq!(
            read_task_output_file(path.to_str().unwrap()).as_deref(),
            Some("live tail line\n"),
        );
        // Empty file (a no-output command) reads back as "" — distinct from absent.
        let empty = dir.join("empty.output");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(read_task_output_file(empty.to_str().unwrap()).as_deref(), Some(""));
        // Absent file → None (not an error).
        assert!(read_task_output_file(dir.join("gone.output").to_str().unwrap()).is_none());
        // Guard: a path that isn't a `tasks/*.output` file is refused outright.
        assert!(read_task_output_file("/etc/passwd").is_none());
        assert!(read_task_output_file(dir.join("notes.txt").to_str().unwrap()).is_none());
        let elsewhere = std::env::temp_dir().join("nottasks");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("x.output"), "nope").unwrap();
        assert!(read_task_output_file(elsewhere.join("x.output").to_str().unwrap()).is_none());

        std::fs::remove_dir_all(std::env::temp_dir().join(format!("tosse-taskout-{}", std::process::id()))).ok();
        std::fs::remove_dir_all(&elsewhere).ok();
    }

    #[test]
    fn workflow_manifest_with_explicit_null_phases_still_parses() {
        // Mirror of the stream's `explicit_null_patch_and_usage_do_not_drop_the_line`:
        // an explicit `"phases":null` in the manifest must NOT fail the whole parse
        // (which would blank the entire workflow view) — it degrades to an empty list.
        let run: WorkflowRun = serde_json::from_str(r#"{"runId":"wf_z","phases":null}"#)
            .expect("explicit null phases must be tolerated");
        assert_eq!(run.run_id, "wf_z");
        assert!(run.phases.is_empty());
    }

    #[test]
    fn unsafe_ids_are_rejected_without_touching_disk() {
        // A path-traversal-shaped id never reaches `format!`/`join` — it is refused.
        assert!(!is_safe_id("../../../../etc/passwd"));
        assert!(!is_safe_id("a/b"));
        assert!(!is_safe_id(".."));
        assert!(!is_safe_id(""));
        // Legitimate wire ids (UUID, `wf_`/`tk_` slugs, agent ids) pass unchanged.
        assert!(is_safe_id("ssssssss-1111-2222-3333-444444444444"));
        assert!(is_safe_id("wf_abc"));
        assert!(is_safe_id("tk_bash"));
        let base = std::env::temp_dir().join("tosse-sub-unsafe");
        assert!(load_subagent_transcript_in(&base, "..", "x").is_empty());
        assert!(load_workflow_run_in(&base, "ok", "../escape").unwrap().is_none());
    }
}
