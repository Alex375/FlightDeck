//! Server-side file reads — the ONLY reader of a file that lives on a PAIRED SERVER rather than
//! on this Mac.
//!
//! A conversation running under `flightdeckd` on a server writes everything a drill-in wants to
//! show into THAT server's filesystem: a background command's or a Monitor's output
//! (`/tmp/claude-<uid>/<slug>/<session>/tasks/<id>.output`), a sub-agent's or a workflow agent's
//! transcript (`<config>/projects/<slug>/<session>/subagents/…/agent-<id>.jsonl`), a workflow's
//! end-of-run report (`…/<session>/workflows/<run>.json`), and the `/goal` state (`goal_status`
//! lines of the session transcript). The stream carries only their paths and ids. Reading this
//! Mac's disk for them answered "absent" — "no output yet", "no transcript written", no goal —
//! for files that were sitting on the server all along.
//!
//! Transport: ONE `ssh … sh -s` round trip per read, the script on STDIN — never through the
//! login shell's own parser (a fish or zsh login shell would mangle POSIX quoting), and every
//! value in it single-quoted by [`shq`]. Bounded on both ends: the script caps what it prints
//! (`head -c`), the Mac caps the wait ([`READ_TIMEOUT`]). No daemon frame: it works with any
//! deployed `flightdeckd` (0.2.0 included) and with the conversation's stream turned off. The
//! IPC layer ([`crate::ipc::commands`]) resolves conversation → server; this module never
//! touches the Store, and a conversation on this Mac never reaches it.
//!
//! Framing: the script's stdout opens with ONE header line, then (for `found`) the raw bytes:
//!
//! ```text
//! FDREAD1 found <size> <start>[ <path>]   ← bytes follow, read from <start>
//! FDREAD1 absent                          ← the file does not exist (not written yet / cleaned up)
//! FDREAD1 refused <reason>                ← the server-side guard refused the path
//! FDREAD1 error <reason>                  ← the file exists but could not be read
//! ```
//!
//! Absent (a normal state) and unreadable (permission, I/O) are distinct answers, never folded
//! together — the same contract as this Mac's own readers ([`crate::supervisor::subagents`]).
//!
//! Battery: every read is ONE ssh handshake, so nothing here polls. The callers bound how often
//! they ask (an open popover, a selected agent, a turn edge of a goal-bearing conversation), and
//! transcripts are read INCREMENTALLY: a per-(conversation, kind, id) cache keeps the bytes
//! already fetched, and each refresh asks only for what was appended since.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use serde::Serialize;
use specta::Type;

use crate::ipc::commands::shq;
use crate::store::MachineRecord;
use crate::supervisor::history::active_goal_from_transcript_str;
use crate::supervisor::model::{ConversationItem, GoalState, WorkflowRun};
use crate::supervisor::subagents::{
    finish_task_output_chunk, is_safe_id, parse_subagent_transcript_str, parse_workflow_run_str,
    TaskOutputChunk,
};

/// Most bytes one read ships: a chunk of a task's output, or of a transcript. A ~1 MB sub-agent
/// transcript (the size real ones reach) arrives in one round trip; a bigger one in a few.
pub const CHUNK_MAX: u64 = 1024 * 1024;

/// How many chunks ONE transcript read may chain (one ssh each) before it hands back what it has
/// — with a notice saying the rest comes on the next read. Bounds a single open of a huge
/// transcript to a few seconds of round trips instead of an open-ended crawl.
const MAX_TRANSCRIPT_CHUNKS: usize = 8;

/// A workflow manifest larger than this is refused rather than shipped (real ones are tens to
/// hundreds of KB, the run's return value included).
const MANIFEST_MAX: u64 = 8 * 1024 * 1024;

/// Cap on what the `/goal` pre-filter may ship. Goal lines are tiny; hitting this means the
/// filter matched something it should not have, and the scan would be built on a cut list —
/// reported as an error, never guessed from a partial one.
const GOAL_LINES_MAX: u64 = 4 * 1024 * 1024;

/// Longest line the `/goal` pre-filter keeps. A `goal_status` attachment or a `/goal` stdout is
/// a few hundred bytes; a line past this is a tool result that merely QUOTES the marker (reading
/// this very codebase, say) — it can carry no goal state, and shipping it would cost megabytes.
const GOAL_LINE_MAX: u64 = 64 * 1024;

/// How long one read may take, handshake included, before it is reported as unreachable.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Total bytes the transcript cache keeps across every entry, least-recently-used evicted first.
const CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// Where the CLI writes a background task's output on the server (`<root>/claude-<uid>/…`).
/// `/private/tmp` is `/tmp` resolved on macOS, the form the CLI reports there.
const TMP_ROOTS: &[&str] = &["/tmp", "/private/tmp"];

/// The header tag. Versioned so a future framing change can never be misread by this one.
const FRAME_TAG: &str = "FDREAD1 ";

/// Why a read routed by conversation failed — typed so the UI can say WHERE and WHAT, with the
/// server's name, instead of "couldn't load it". "Not found" is not an error: an absent file is
/// the value's own `None` / empty list, exactly as for this Mac's readers. Tagged on `kind` → a
/// clean TS union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileReadError {
    /// The conversation id is not one this Mac knows. Never read as "a local conversation":
    /// that fallback is exactly how a server's path would be read on this Mac's disk.
    UnknownConversation { conversation_id: String },
    /// The server could not be reached over SSH (down, offline, key refused, host identity
    /// changed — `reason` says which).
    Unreachable { server: String, reason: String },
    /// The read was refused — by a guard on this Mac (an id or a path that is not what the
    /// stream gives) or by the server-side script's own guard. `server` is `None` for a refusal
    /// about a conversation on this Mac.
    Refused { server: Option<String>, reason: String },
    /// The file exists but could not be read (permission, I/O, an unparseable answer or file).
    /// `server` is `None` for this Mac.
    Io { server: Option<String>, reason: String },
}

impl FileReadError {
    /// An I/O failure on THIS Mac.
    pub fn local_io(reason: impl Into<String>) -> Self {
        Self::Io { server: None, reason: reason.into() }
    }
}

/// The paired server a read goes to, plus Flight Deck's own `known_hosts` (TOFU pinning).
pub struct Server<'a> {
    pub machine: &'a MachineRecord,
    pub known_hosts: Option<&'a str>,
}

impl Server<'_> {
    /// The name the UI knows this server by.
    fn name(&self) -> String {
        if self.machine.label.trim().is_empty() {
            self.machine.host.clone()
        } else {
            self.machine.label.clone()
        }
    }

    fn refused(&self, reason: impl Into<String>) -> FileReadError {
        FileReadError::Refused { server: Some(self.name()), reason: reason.into() }
    }

    fn io(&self, reason: impl Into<String>) -> FileReadError {
        FileReadError::Io { server: Some(self.name()), reason: reason.into() }
    }

    fn unreachable(&self, reason: impl Into<String>) -> FileReadError {
        FileReadError::Unreachable { server: self.name(), reason: reason.into() }
    }
}

// ---- framing ------------------------------------------------------------------------------

/// One parsed answer of a read script.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Found { size: u64, start: u64, path: Option<String>, payload: Vec<u8> },
    Absent,
    Refused(String),
    Error(String),
}

/// Parse a read script's stdout. The header is the first line opening on [`FRAME_TAG`]: anything
/// before it (a login script that prints to stdout) is skipped, never mistaken for content.
fn parse_answer(raw: &[u8]) -> Result<Answer, String> {
    let tag = FRAME_TAG.as_bytes();
    let mut at = 0usize;
    let header_start = loop {
        if raw[at..].starts_with(tag) {
            break at;
        }
        match raw[at..].iter().position(|&b| b == b'\n') {
            Some(i) => at += i + 1,
            None => return Err("the server's answer carries no read header".to_string()),
        }
    };
    let rest = &raw[header_start + tag.len()..];
    let Some(eol) = rest.iter().position(|&b| b == b'\n') else {
        return Err("the server's answer was cut short".to_string());
    };
    let header = String::from_utf8_lossy(&rest[..eol]).into_owned();
    let payload = rest[eol + 1..].to_vec();
    let (status, args) = header.split_once(' ').unwrap_or((header.as_str(), ""));
    match status {
        "found" => {
            let mut parts = args.splitn(3, ' ');
            let num = |s: Option<&str>| s.and_then(|v| v.trim().parse::<u64>().ok());
            let (Some(size), Some(start)) = (num(parts.next()), num(parts.next())) else {
                return Err(format!("malformed read header: {}", sanitize(&header)));
            };
            let path = parts.next().map(str::to_string).filter(|p| !p.is_empty());
            Ok(Answer::Found { size, start, path, payload })
        }
        "absent" => Ok(Answer::Absent),
        "refused" => Ok(Answer::Refused(sanitize(args))),
        "error" => Ok(Answer::Error(sanitize(args))),
        other => Err(format!("unknown read status {:?}", sanitize(other))),
    }
}

/// Server-supplied text bound for the UI: control characters dropped, length capped.
fn sanitize(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(300).collect::<String>().trim().to_string()
}

// ---- guards (this Mac's side; each script re-checks on the server) -------------------------

/// A path component the CLI could have written: non-empty, not `.`/`..`, and only the bytes of
/// a cwd slug / session id / task id (`[A-Za-z0-9._-]`).
fn is_safe_component(c: &str) -> bool {
    !c.is_empty()
        && c != "."
        && c != ".."
        && c.len() <= 255
        && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// Is `path` a background task's output as the CLI reports it —
/// `<root>/claude-<digits>/<slug>[/<session>]/tasks/<id>.output` under one of `roots`? Refuses
/// anything else BEFORE a round trip (the server-side script re-checks, and also requires the
/// `claude-<uid>` to be the login user's own and the file to be a regular file, not a link).
fn validate_task_output_path(path: &str, roots: &[&str]) -> Result<(), String> {
    let bad = || format!("not a Claude Code task output path: {path:?}");
    if path.len() > 4096 || path.contains(['\0', '\n', '\r']) {
        return Err(bad());
    }
    let root = roots
        .iter()
        .find(|r| path.starts_with(&format!("{r}/")))
        .ok_or_else(bad)?;
    let parts: Vec<&str> = path[root.len() + 1..].split('/').collect();
    // claude-<uid> / 1..=2 dirs / tasks / <id>.output
    if parts.len() < 4 || parts.len() > 5 {
        return Err(bad());
    }
    let uid_dir = parts[0];
    let uid_ok = uid_dir
        .strip_prefix("claude-")
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
    let n = parts.len();
    let middle_ok = parts[1..n - 2].iter().all(|c| is_safe_component(c));
    let file_ok = parts[n - 1].strip_suffix(".output").is_some_and(is_safe_id);
    if uid_ok && middle_ok && parts[n - 2] == "tasks" && file_ok {
        Ok(())
    } else {
        Err(bad())
    }
}

/// A stream-given location hint, kept only if it is a plain absolute path (no `.`/`..`
/// component, no control character). An unusable hint is DROPPED, never an error: the read
/// falls back to searching the session's `subagents/` directory.
fn sanitize_hint(hint: Option<&str>) -> Option<String> {
    let h = hint?.trim();
    let plain = h.starts_with('/')
        && h.len() <= 4096
        && !h.chars().any(char::is_control)
        && h.split('/').skip(1).all(|c| !c.is_empty() && c != "." && c != "..");
    plain.then(|| h.to_string())
}

/// Does `path` (as the server resolved it) name THIS agent's transcript of THIS session?
fn is_transcript_path_for(path: &str, session_id: &str, agent_id: &str) -> bool {
    path.starts_with('/')
        && !path.contains(['\0', '\n', '\r'])
        && path.ends_with(&format!("/agent-{agent_id}.jsonl"))
        && path.contains(&format!("/{session_id}/subagents/"))
        && path.split('/').all(|c| c != "..")
}

// ---- scripts --------------------------------------------------------------------------------
//
// POSIX sh, run with `sh -s`. Every interpolated value is single-quoted by `shq` (ids are also
// validated as `[A-Za-z0-9_-]` first). Each script answers EXACTLY one header and exits 0 on
// every handled path, so a non-zero exit always means ssh or the shell itself failed.

/// Shared head of every script: byte semantics, the header printer, the file sizer, Claude's
/// config dir (`$CLAUDE_CONFIG_DIR`, else `~/.claude` — the CLI's own resolution) and a guard
/// that tells an unreadable `projects/` apart from an absent one.
const PRELUDE: &str = r#"export LC_ALL=C
fd_say() { printf 'FDREAD1 %s\n' "$*"; }
fd_size() { wc -c < "$1" | tr -d ' \t'; }
C=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
fd_projects() {
  if [ -d "$C/projects" ] && ! { [ -r "$C/projects" ] && [ -x "$C/projects" ]; }; then
    fd_say error "cannot read $C/projects"; exit 0
  fi
}
"#;

/// Measure `$F` into `$S`, or answer an error.
const MEASURE: &str = r#"S=$(fd_size "$F")
case "$S" in ''|*[!0-9]*) fd_say error "could not measure the file"; exit 0 ;; esac
"#;

/// A background task's output from `offset` (`None` = the caller holds nothing yet), at most
/// `max` bytes, with the start rule of [`crate::supervisor::subagents::task_output_read_start`].
fn task_output_script(path: &str, offset: Option<u64>, max: u64, roots: &[&str]) -> String {
    let patterns = roots
        .iter()
        .map(|r| format!("{}/claude-\"$U\"/*", shq(r)))
        .collect::<Vec<_>>()
        .join("|");
    let offset = offset.map(|o| o.to_string()).unwrap_or_else(|| "-1".to_string());
    format!(
        r#"{PRELUDE}F={f}
O={offset}
M={max}
U=$(id -u) || {{ fd_say error "cannot determine the login user"; exit 0; }}
case "$F" in
  {patterns}) ;;
  *) fd_say refused "not under this user's Claude Code temp directory"; exit 0 ;;
esac
if [ -L "$F" ]; then fd_say refused "the output path is a symbolic link"; exit 0; fi
if [ ! -e "$F" ]; then fd_say absent; exit 0; fi
if [ ! -f "$F" ]; then fd_say refused "the output path is not a regular file"; exit 0; fi
if [ ! -r "$F" ]; then fd_say error "permission denied"; exit 0; fi
{MEASURE}if [ "$O" -ge 0 ] && [ "$O" -le "$S" ] && [ $((S - O)) -le "$M" ]; then B=$O
elif [ "$S" -gt "$M" ]; then B=$((S - M))
else B=0
fi
fd_say found "$S" "$B"
tail -c +$((B + 1)) "$F" | head -c "$M"
"#,
        f = shq(path),
    )
}

/// A sub-agent's / workflow agent's transcript from `offset`. Where it is, in order: the path a
/// previous read resolved (`known`), the stream's own hint (an `Agent` task's `output_file` —
/// a symlink to the transcript — or a workflow's "Transcript dir"), else a depth-bounded search
/// of the session's `subagents/` dirs (across every project slug: a session that moved its cwd
/// splits its artifacts). Whatever is used must name `…/projects/…/<session>/subagents/…/
/// agent-<id>.jsonl` — a hint can only ever point at this agent's own transcript.
fn transcript_script(
    session_id: &str,
    agent_id: &str,
    known: Option<&str>,
    hint: Option<&str>,
    offset: u64,
    max: u64,
) -> String {
    format!(
        r#"{PRELUDE}SID={sid}
ID={id}
P={known}
H={hint}
O={offset}
M={max}
fd_ok() {{
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in */../*|*/./*) return 1 ;; esac
  case "$1" in
    */projects/*/"$SID"/subagents/agent-"$ID".jsonl|*/projects/*/"$SID"/subagents/*/agent-"$ID".jsonl) return 0 ;;
  esac
  return 1
}}
F=
if [ -n "$P" ] && fd_ok "$P" && [ -f "$P" ]; then F=$P; fi
if [ -z "$F" ] && [ -n "$H" ]; then
  case "$H" in
    *.output) T=$(readlink "$H" 2>/dev/null) || T= ;;
    *.jsonl) T=$H ;;
    *) T=$H/agent-$ID.jsonl ;;
  esac
  if [ -n "$T" ] && fd_ok "$T" && [ -f "$T" ]; then F=$T; fi
fi
if [ -z "$F" ]; then
  fd_projects
  F=$(find "$C"/projects/*/"$SID"/subagents -maxdepth 4 -type f -name "agent-$ID.jsonl" 2>/dev/null | head -n 1)
fi
if [ -z "$F" ]; then fd_say absent; exit 0; fi
if [ -L "$F" ]; then fd_say refused "the transcript path is a symbolic link"; exit 0; fi
if [ ! -r "$F" ]; then fd_say error "permission denied"; exit 0; fi
{MEASURE}if [ "$O" -gt "$S" ]; then B=0; else B=$O; fi
fd_say found "$S" "$B" "$F"
tail -c +$((B + 1)) "$F" | head -c "$M"
"#,
        sid = shq(session_id),
        id = shq(agent_id),
        known = shq(known.unwrap_or("")),
        hint = shq(hint.unwrap_or("")),
    )
}

/// A workflow run's manifest, whole (or an error past `max`), under any project slug holding
/// the session. `names` are the candidate file names (`<run>.json`, `wf_<run>.json`).
fn manifest_script(session_id: &str, names: &[String], max: u64) -> String {
    let candidates = names
        .iter()
        .map(|n| format!("\"$C\"/projects/*/\"$SID\"/workflows/{}", shq(n)))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"{PRELUDE}SID={sid}
M={max}
fd_projects
F=
for G in {candidates}; do
  if [ -f "$G" ] && [ ! -L "$G" ]; then F=$G; break; fi
done
if [ -z "$F" ]; then fd_say absent; exit 0; fi
if [ ! -r "$F" ]; then fd_say error "permission denied"; exit 0; fi
{MEASURE}if [ "$S" -gt "$M" ]; then fd_say error "the report is too large to read ($S bytes)"; exit 0; fi
fd_say found "$S" 0 "$F"
head -c "$M" "$F"
"#,
        sid = shq(session_id),
    )
}

/// The `/goal` pre-filter of [`crate::supervisor::history::load_active_goal`], run ON THE
/// SERVER: only the session transcript's lines that spell `goal_status` or
/// `local-command-stdout` (and are short enough to be goal state, see [`GOAL_LINE_MAX`]) are
/// shipped, in file order — never the transcript itself. One byte past `max` is printed so the
/// Mac can tell "exactly at the cap" from "cut".
fn goal_script(session_id: &str, max: u64, line_max: u64) -> String {
    format!(
        r#"{PRELUDE}SID={sid}
M={max}
L={line_max}
fd_projects
F=
for G in "$C"/projects/*/"$SID".jsonl; do
  if [ -f "$G" ]; then F=$G; break; fi
done
if [ -z "$F" ]; then fd_say absent; exit 0; fi
if [ ! -r "$F" ]; then fd_say error "permission denied"; exit 0; fi
{MEASURE}fd_say found "$S" 0 "$F"
grep -F -e goal_status -e local-command-stdout "$F" | awk -v max="$L" 'length($0) <= max' | head -c $((M + 1))
"#,
        sid = shq(session_id),
    )
}

// ---- transport -----------------------------------------------------------------------------

/// Run one read script on `server` and parse its answer. ssh-level failures (exit 255) are
/// classified by [`crate::ssh_link`] — the one place that tells a refused key or a changed host
/// identity from a plain network failure — and reported as unreachable with that reason.
async fn run_read(server: &Server<'_>, script: &str) -> Result<Answer, FileReadError> {
    let m = server.machine;
    // A record on disk could predate the validators (older app version, manual DB edit):
    // refuse BEFORE any ssh runs, same discipline as every keyed helper.
    if let Err(e) = crate::store::validate_ssh_user(&m.user)
        .and_then(|_| crate::store::validate_address_value(&m.host))
        .and_then(|_| crate::store::validate_ssh_port(m.port))
    {
        return Err(server.refused(format!("this server's saved connection details are invalid: {e}")));
    }
    let out = crate::ipc::commands::run_ssh_on_machine_stdin_raw(
        m,
        server.known_hosts,
        "sh -s",
        script.as_bytes(),
        None,
        READ_TIMEOUT,
    )
    .await
    .map_err(|e| {
        if e.contains("timed out") {
            server.unreachable("the server did not answer in time")
        } else {
            server.io(e)
        }
    })?;
    if !out.success {
        let stderr: Vec<String> = out.stderr.lines().map(str::to_string).collect();
        return Err(match crate::ssh_link::classify_transport_close(out.exit_code, &stderr) {
            Some(issue) => server.unreachable(crate::ssh_link::describe(issue)),
            None => server.io(
                stderr
                    .iter()
                    .rev()
                    .find(|l| !l.trim().is_empty())
                    .map(|l| sanitize(l))
                    .unwrap_or_else(|| format!("the read failed on the server (exit code {:?})", out.exit_code)),
            ),
        });
    }
    parse_answer(&out.stdout).map_err(|e| server.io(e))
}

// ---- reads ---------------------------------------------------------------------------------

/// Read a background task's output on `server` from `offset` (see [`TaskOutputChunk`]): at most
/// [`CHUNK_MAX`] bytes, starting over at the tail when the caller holds nothing yet or fell more
/// than a chunk behind. `Ok(None)` = the file is absent on the server.
pub async fn read_task_output(
    server: &Server<'_>,
    path: &str,
    offset: Option<u64>,
) -> Result<Option<TaskOutputChunk>, FileReadError> {
    read_task_output_under(server, path, offset, TMP_ROOTS).await
}

/// [`read_task_output`] with explicit temp roots — the testable core.
async fn read_task_output_under(
    server: &Server<'_>,
    path: &str,
    offset: Option<u64>,
    roots: &[&str],
) -> Result<Option<TaskOutputChunk>, FileReadError> {
    validate_task_output_path(path, roots).map_err(|e| server.refused(e))?;
    match run_read(server, &task_output_script(path, offset, CHUNK_MAX, roots)).await? {
        Answer::Absent => Ok(None),
        Answer::Found { size, start, mut payload, .. } => {
            payload.truncate(CHUNK_MAX as usize);
            Ok(Some(finish_task_output_chunk(start, size, &payload, offset)))
        }
        Answer::Refused(r) => Err(server.refused(r)),
        Answer::Error(r) => Err(server.io(r)),
    }
}

/// Read a sub-agent's (or a workflow agent's) transcript on `server`, normalized into the same
/// items the live path produces. INCREMENTAL: the bytes already fetched for (conversation,
/// session, agent) are kept in `cache`, and each read asks only for what was appended since —
/// re-opening a ~1 MB transcript costs one round trip and a few bytes, not a megabyte. Empty =
/// not written yet (absent on the server), the same as this Mac's reader.
pub async fn read_subagent_transcript(
    server: &Server<'_>,
    cache: &TranscriptCache,
    conversation_id: &str,
    session_id: &str,
    agent_id: &str,
    hint: Option<&str>,
) -> Result<Vec<ConversationItem>, FileReadError> {
    if !is_safe_id(session_id) || !is_safe_id(agent_id) {
        return Err(server.refused(format!(
            "not a session or agent id the stream gives (session={session_id:?}, agent={agent_id:?})"
        )));
    }
    let hint = sanitize_hint(hint);
    let key: CacheKey = (conversation_id.to_string(), "transcript", format!("{session_id}/{agent_id}"));
    let slot = cache.slot(&key);
    // Held across the round trips: two surfaces reading the same transcript at once (the
    // inline card and a popover) must not both append the same bytes.
    let mut entry = slot.lock().await;
    let mut last_size = 0u64;
    let mut rounds = 0usize;
    while rounds < MAX_TRANSCRIPT_CHUNKS {
        rounds += 1;
        let offset = entry.bytes.len() as u64;
        let script = transcript_script(session_id, agent_id, entry.path.as_deref(), hint.as_deref(), offset, CHUNK_MAX);
        let (size, start, path, payload) = match run_read(server, &script).await? {
            Answer::Absent => {
                entry.path = None;
                entry.bytes.clear();
                cache.record(&key, 0);
                return Ok(Vec::new());
            }
            Answer::Refused(r) => return Err(server.refused(r)),
            Answer::Error(r) => return Err(server.io(r)),
            Answer::Found { size, start, path, payload } => (size, start, path, payload),
        };
        let path = path
            .filter(|p| is_transcript_path_for(p, session_id, agent_id))
            .ok_or_else(|| server.io("the server named an unexpected transcript path"))?;
        last_size = size;
        if entry.path.as_deref() != Some(path.as_str()) {
            // A different file than the bytes held came from (first read, or the old one is
            // gone): start over from ITS beginning — the bytes just read began at our offset.
            entry.path = Some(path);
            entry.bytes.clear();
            if start != 0 {
                continue;
            }
        } else if start != offset {
            // The server started over (the file shrank — rewritten): drop what we held.
            entry.bytes.clear();
            if start != 0 {
                continue;
            }
        }
        let take = payload.len().min(CHUNK_MAX as usize);
        entry.bytes.extend_from_slice(&payload[..take]);
        cache.record(&key, entry.bytes.len());
        if entry.bytes.len() as u64 >= size || take == 0 {
            break;
        }
    }
    // Parse whole lines only: a transcript being appended to can end mid-line.
    let whole = entry.bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let text = String::from_utf8_lossy(&entry.bytes[..whole]);
    let origin = format!("{} on {}", entry.path.as_deref().unwrap_or("transcript"), server.name());
    let mut items = parse_subagent_transcript_str(&text, &origin);
    if (entry.bytes.len() as u64) < last_size {
        let read_mib = entry.bytes.len() as f64 / (1024.0 * 1024.0);
        items.push(ConversationItem::Notice {
            subtype: "history_error".to_string(),
            detail: serde_json::json!({
                "message": format!(
                    "Only the first {read_mib:.1} MB of this transcript have been read from {} so far — open it again to read the rest.",
                    server.name()
                ),
            }),
        });
    }
    Ok(items)
}

/// Read a workflow run's manifest on `server` (`workflows/<run_id>.json`; a bare id also tries
/// `wf_<id>.json`). `Ok(None)` = absent (the run is still going, or never wrote one); an
/// unparseable manifest is an error, never "absent".
pub async fn read_workflow_run(
    server: &Server<'_>,
    session_id: &str,
    run_id: &str,
) -> Result<Option<WorkflowRun>, FileReadError> {
    if !is_safe_id(session_id) || !is_safe_id(run_id) {
        return Err(server.refused(format!(
            "not a session or run id the stream gives (session={session_id:?}, run={run_id:?})"
        )));
    }
    let mut names = vec![format!("{run_id}.json")];
    if !run_id.starts_with("wf_") {
        names.push(format!("wf_{run_id}.json"));
    }
    match run_read(server, &manifest_script(session_id, &names, MANIFEST_MAX)).await? {
        Answer::Absent => Ok(None),
        Answer::Refused(r) => Err(server.refused(r)),
        Answer::Error(r) => Err(server.io(r)),
        Answer::Found { path, payload, .. } => {
            let origin = format!("{} on {}", path.as_deref().unwrap_or("manifest"), server.name());
            let text = String::from_utf8(payload)
                .map_err(|_| server.io(format!("unreadable manifest {origin}: not UTF-8")))?;
            parse_workflow_run_str(&text, &origin).map(Some).map_err(|e| server.io(e))
        }
    }
}

/// Read a conversation's active `/goal` on `server`: the server pre-filters its transcript (see
/// [`goal_script`]) and the Mac runs the SAME scan as for a local conversation
/// ([`active_goal_from_transcript_str`]) over the lines it ships. `Ok(None)` = no goal active,
/// or no transcript yet.
pub async fn read_active_goal(server: &Server<'_>, session_id: &str) -> Result<Option<GoalState>, FileReadError> {
    if !is_safe_id(session_id) {
        return Err(server.refused(format!("not a session id the stream gives ({session_id:?})")));
    }
    match run_read(server, &goal_script(session_id, GOAL_LINES_MAX, GOAL_LINE_MAX)).await? {
        Answer::Absent => Ok(None),
        Answer::Refused(r) => Err(server.refused(r)),
        Answer::Error(r) => Err(server.io(r)),
        Answer::Found { payload, .. } => {
            if payload.len() as u64 > GOAL_LINES_MAX {
                return Err(server.io("too many goal lines in this conversation's transcript to read its goal"));
            }
            Ok(active_goal_from_transcript_str(&String::from_utf8_lossy(&payload)))
        }
    }
}

// ---- cache ---------------------------------------------------------------------------------

/// (conversation id, kind, id) — the session id is part of the id, so a rewind/fork (a new
/// session) never reads another session's bytes.
type CacheKey = (String, &'static str, String);

/// What one transcript read has fetched so far: the server path it resolved, and the bytes from
/// the file's start.
#[derive(Default)]
pub struct TranscriptEntry {
    path: Option<String>,
    bytes: Vec<u8>,
}

struct Slot {
    entry: Arc<tokio::sync::Mutex<TranscriptEntry>>,
    last_used: u64,
    bytes: usize,
}

#[derive(Default)]
struct CacheInner {
    slots: HashMap<CacheKey, Slot>,
    clock: u64,
}

/// The incremental-read cache for server transcripts, bounded at [`CACHE_MAX_BYTES`] across all
/// entries (least recently used evicted first — an evicted transcript is simply fetched whole
/// again on its next read). Each entry has its own async lock, so reads of different
/// transcripts never wait on each other.
#[derive(Default)]
pub struct TranscriptCache {
    inner: std::sync::Mutex<CacheInner>,
}

/// The app-wide cache (one per process; the IPC commands share it).
pub static TRANSCRIPT_CACHE: LazyLock<TranscriptCache> = LazyLock::new(TranscriptCache::default);

impl TranscriptCache {
    fn slot(&self, key: &CacheKey) -> Arc<tokio::sync::Mutex<TranscriptEntry>> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.clock += 1;
        let now = inner.clock;
        let slot = inner.slots.entry(key.clone()).or_insert_with(|| Slot {
            entry: Arc::default(),
            last_used: now,
            bytes: 0,
        });
        slot.last_used = now;
        slot.entry.clone()
    }

    /// Note how many bytes `key` holds now, and evict the least recently used OTHER entries
    /// while the total is over the cap. An evicted entry that is mid-read keeps its own `Arc`;
    /// its bytes are just no longer reachable for the next read.
    fn record(&self, key: &CacheKey, bytes: usize) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = inner.slots.get_mut(key) {
            slot.bytes = bytes;
        }
        loop {
            let total: usize = inner.slots.values().map(|s| s.bytes).sum();
            if total <= CACHE_MAX_BYTES {
                break;
            }
            let victim = inner
                .slots
                .iter()
                .filter(|(k, _)| *k != key)
                .min_by_key(|(_, s)| s.last_used)
                .map(|(k, _)| k.clone());
            match victim {
                Some(k) => {
                    inner.slots.remove(&k);
                }
                None => break,
            }
        }
    }

    #[cfg(test)]
    fn holds(&self, key: &CacheKey) -> bool {
        self.inner.lock().unwrap().slots.contains_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn machine() -> MachineRecord {
        MachineRecord {
            id: "m1".into(),
            label: "Target".into(),
            host: "target.example".into(),
            port: 22,
            user: "agent".into(),
            identity_file: None,
            added_at: 1,
            addresses: Vec::new(),
            daemon_mac_id: None,
            daemon_relay_url: None,
            daemon_label: None,
            phone_provisioned_at: None,
        }
    }

    /// A scratch dir unique to one test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fd-remote-files-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake `ssh` that ignores its connection arguments and runs the script it is fed with
    /// THIS Mac's `sh -s` — so the real scripts run end to end against a scratch "server" tree.
    /// `config` becomes the remote `$CLAUDE_CONFIG_DIR`.
    fn fake_ssh(dir: &Path, config: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let bin = dir.join("ssh");
        std::fs::write(
            &bin,
            format!("#!/bin/sh\nCLAUDE_CONFIG_DIR={}\nexport CLAUDE_CONFIG_DIR\nexec /bin/sh -s\n", shq(&config.to_string_lossy())),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    /// Point every keyed ssh on this test's thread at `bin` for the closure's lifetime.
    struct SshSeam;
    impl SshSeam {
        fn install(bin: &Path) -> Self {
            crate::ipc::commands::TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(bin.to_string_lossy().into_owned()));
            SshSeam
        }
    }
    impl Drop for SshSeam {
        fn drop(&mut self) {
            crate::ipc::commands::TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
        }
    }

    fn uid() -> String {
        String::from_utf8(std::process::Command::new("id").arg("-u").output().unwrap().stdout)
            .unwrap()
            .trim()
            .to_string()
    }

    // ---- framing ----

    #[test]
    fn parse_answer_reads_every_status_and_skips_login_noise() {
        assert_eq!(
            parse_answer(b"FDREAD1 found 12 4 /x/agent-a.jsonl\nhello").unwrap(),
            Answer::Found { size: 12, start: 4, path: Some("/x/agent-a.jsonl".into()), payload: b"hello".to_vec() }
        );
        // A path with spaces survives (it is the header's tail).
        assert_eq!(
            parse_answer(b"FDREAD1 found 3 0 /my dir/agent-a.jsonl\nabc").unwrap(),
            Answer::Found { size: 3, start: 0, path: Some("/my dir/agent-a.jsonl".into()), payload: b"abc".to_vec() }
        );
        assert_eq!(
            parse_answer(b"FDREAD1 found 0 0\n").unwrap(),
            Answer::Found { size: 0, start: 0, path: None, payload: Vec::new() }
        );
        assert_eq!(parse_answer(b"FDREAD1 absent\n").unwrap(), Answer::Absent);
        assert_eq!(parse_answer(b"FDREAD1 refused symbolic link\n").unwrap(), Answer::Refused("symbolic link".into()));
        assert_eq!(parse_answer(b"FDREAD1 error permission denied\n").unwrap(), Answer::Error("permission denied".into()));
        // A login script that prints to stdout first is skipped, never taken for content.
        assert_eq!(parse_answer(b"Welcome to box!\nFDREAD1 absent\n").unwrap(), Answer::Absent);
        // Payload bytes that LOOK like a header are content, not a second answer.
        assert_eq!(
            parse_answer(b"FDREAD1 found 15 0\nFDREAD1 absent\n").unwrap(),
            Answer::Found { size: 15, start: 0, path: None, payload: b"FDREAD1 absent\n".to_vec() }
        );
    }

    #[test]
    fn parse_answer_rejects_what_is_not_an_answer() {
        assert!(parse_answer(b"").is_err());
        assert!(parse_answer(b"bash: sh: command not found\n").is_err());
        assert!(parse_answer(b"FDREAD1 found 12").is_err(), "header cut before its newline");
        assert!(parse_answer(b"FDREAD1 found x y\n").is_err());
        assert!(parse_answer(b"FDREAD1 maybe\n").is_err());
        // Server text bound for the UI loses its control characters.
        assert_eq!(
            parse_answer(b"FDREAD1 error bad\x1b[31m thing\n").unwrap(),
            Answer::Error("bad[31m thing".into())
        );
    }

    // ---- guards ----

    #[test]
    fn task_output_paths_are_validated_before_any_round_trip() {
        for ok in [
            "/tmp/claude-501/-Users-admin-Projects-FlightDeck/206b30ad-40ad-42c8-9dfd-d2159cde31b2/tasks/bl4ovck33.output",
            "/private/tmp/claude-501/-work-demo/8ddbcc7f-1d1f-4392-9d14-aaf7cb27198d/tasks/bk5y3rqjw.output",
            "/tmp/claude-1000/-srv-proj/tasks/w0rccnqy2.output",
        ] {
            assert!(validate_task_output_path(ok, TMP_ROOTS).is_ok(), "{ok}");
        }
        for bad in [
            "/etc/passwd",
            "/tmp/claude-501/../../etc/passwd.output",
            "/tmp/claude-501/x/s/tasks/../../../etc/x.output",
            "/tmp/claude-abc/x/s/tasks/a.output",
            "/tmp/claude-/x/s/tasks/a.output",
            "/tmp/claude-501/tasks/a.output",
            "/tmp/claude-501/x/s/t/u/tasks/a.output",
            "/tmp/claude-501/x/s/tasks/a.log",
            "/tmp/claude-501/x/s/notes/a.output",
            "/tmp/claude-501/x/s/tasks/a b.output",
            "/tmp/claude-501/x/./tasks/a.output",
            "/var/tmp/claude-501/x/s/tasks/a.output",
            "/Users/x/.claude/projects/-x/s/tasks/task_bash_1.output",
            "/tmp/claude-501/x/s/tasks/a.output\n/etc/passwd",
            "tmp/claude-501/x/s/tasks/a.output",
        ] {
            assert!(validate_task_output_path(bad, TMP_ROOTS).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn hints_are_kept_only_when_plain_and_transcript_paths_must_be_this_agents() {
        assert_eq!(sanitize_hint(Some("/a/b/tasks/x.output")).as_deref(), Some("/a/b/tasks/x.output"));
        assert_eq!(sanitize_hint(Some("relative/dir")), None);
        assert_eq!(sanitize_hint(Some("/a/../b")), None);
        assert_eq!(sanitize_hint(Some("/a/./b")), None);
        assert_eq!(sanitize_hint(Some("/a/b\n")).as_deref(), Some("/a/b"), "trimmed");
        assert_eq!(sanitize_hint(Some("/a/\x07b")), None);
        assert_eq!(sanitize_hint(None), None);

        let p = "/home/u/.claude/projects/-w/sid-1/subagents/workflows/wf_1/agent-a1.jsonl";
        assert!(is_transcript_path_for(p, "sid-1", "a1"));
        assert!(!is_transcript_path_for(p, "sid-2", "a1"));
        assert!(!is_transcript_path_for(p, "sid-1", "a2"));
        assert!(!is_transcript_path_for("/etc/passwd", "sid-1", "a1"));
    }

    // ---- scripts: quoting ----

    #[test]
    fn scripts_single_quote_every_interpolated_value() {
        let s = task_output_script("/tmp/claude-1/x'; rm -rf ~; '/s/tasks/a.output", Some(7), 99, TMP_ROOTS);
        assert!(s.contains(r#"F='/tmp/claude-1/x'\''; rm -rf ~; '\''/s/tasks/a.output'"#), "{s}");
        assert!(s.contains("O=7\n") && s.contains("M=99\n"));
        assert!(task_output_script("/tmp/claude-1/x/tasks/a.output", None, 5, TMP_ROOTS).contains("O=-1\n"));
        assert!(s.contains(r#"'/tmp'/claude-"$U"/*|'/private/tmp'/claude-"$U"/*)"#), "{s}");

        let t = transcript_script("sid", "aid", Some("/p q/agent-aid.jsonl"), Some("/h'h"), 3, 9);
        assert!(t.contains("SID='sid'\n") && t.contains("ID='aid'\n"));
        assert!(t.contains("P='/p q/agent-aid.jsonl'\n"));
        assert!(t.contains(r#"H='/h'\''h'"#));
        assert!(transcript_script("sid", "aid", None, None, 0, 9).contains("P=''\nH=''\n"));

        let m = manifest_script("sid", &["wf_1.json".to_string(), "x'y.json".to_string()], 9);
        assert!(m.contains(r#""$C"/projects/*/"$SID"/workflows/'wf_1.json' "$C"/projects/*/"$SID"/workflows/'x'\''y.json'"#), "{m}");
    }

    // ---- end to end through the fake ssh ----

    /// A task output read: absent, a found chunk, an incremental delta, the tail-first first
    /// read of a large file, and the server's own refusals (symlink, another user's dir).
    #[tokio::test]
    async fn task_output_reads_run_the_real_script() {
        let dir = scratch("task");
        let root = dir.join("tmp");
        let tasks = root.join(format!("claude-{}", uid())).join("-w").join("sid-1").join("tasks");
        std::fs::create_dir_all(&tasks).unwrap();
        let _seam = SshSeam::install(&fake_ssh(&dir, &dir.join("config")));
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };
        let root_s = root.to_string_lossy().into_owned();
        let roots = [root_s.as_str()];
        let path_of = |name: &str| tasks.join(name).to_string_lossy().into_owned();

        // Absent.
        assert_eq!(read_task_output_under(&server, &path_of("nope.output"), None, &roots).await.unwrap(), None);

        // Found, whole.
        std::fs::write(tasks.join("b1.output"), "line one\nline two\n").unwrap();
        let first = read_task_output_under(&server, &path_of("b1.output"), None, &roots).await.unwrap().unwrap();
        assert_eq!(first.data, "line one\nline two\n");
        assert_eq!((first.start, first.next_offset, first.size, first.eof), (0, 18, 18, true));

        // Incremental: only the appended bytes come back, starting where the caller is.
        std::fs::write(tasks.join("b1.output"), "line one\nline two\nline three\n").unwrap();
        let delta = read_task_output_under(&server, &path_of("b1.output"), Some(18), &roots).await.unwrap().unwrap();
        assert_eq!(delta.data, "line three\n");
        assert_eq!((delta.start, delta.next_offset), (18, 29));

        // A file larger than a chunk: the first read starts at the tail, on a whole line.
        let big: String = (0..200_000).map(|i| format!("{i:07}\n")).collect(); // 1.6 MB
        std::fs::write(tasks.join("big.output"), &big).unwrap();
        let tail = read_task_output_under(&server, &path_of("big.output"), None, &roots).await.unwrap().unwrap();
        assert!(tail.start > 0, "earlier output skipped");
        assert!(tail.data.len() as u64 <= CHUNK_MAX);
        assert!(tail.data.ends_with("0199999\n"));
        assert_eq!(tail.data.len() % 8, 0, "opens on a whole line");
        assert!(tail.eof);

        // Server-side guards: a symlink, and a path under another user's temp dir.
        std::os::unix::fs::symlink(tasks.join("b1.output"), tasks.join("link.output")).unwrap();
        let link = read_task_output_under(&server, &path_of("link.output"), None, &roots).await.unwrap_err();
        assert!(matches!(&link, FileReadError::Refused { server: Some(s), reason } if s == "Target" && reason.contains("symbolic link")), "{link:?}");
        let other = root.join("claude-0").join("-w").join("s").join("tasks");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("x.output"), "secret").unwrap();
        if uid() != "0" {
            let err = read_task_output_under(&server, &other.join("x.output").to_string_lossy(), None, &roots)
                .await
                .unwrap_err();
            assert!(matches!(&err, FileReadError::Refused { reason, .. } if reason.contains("temp directory")), "{err:?}");
        }
        // This Mac's own guard refuses before any round trip.
        let err = read_task_output_under(&server, "/etc/passwd", None, &roots).await.unwrap_err();
        assert!(matches!(err, FileReadError::Refused { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn line(i: usize) -> String {
        format!(
            "{{\"type\":\"assistant\",\"uuid\":\"u{i}\",\"isSidechain\":true,\"message\":{{\"id\":\"m{i}\",\"model\":\"claude-opus-5-5\",\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"step {i}\"}}]}}}}\n"
        )
    }

    /// A transcript read finds the file by search, caches what it fetched, and the next read
    /// asks only for the appended bytes; a stream hint (the `Agent` task's `.output` symlink)
    /// resolves straight to the transcript; a partial last line waits for its newline.
    #[tokio::test]
    async fn transcript_reads_are_incremental_and_use_the_stream_hint() {
        let dir = scratch("transcript");
        let config = dir.join("config");
        let sub = config.join("projects").join("-w").join("sid-1").join("subagents").join("workflows").join("wf_1");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("agent-a1.jsonl");
        std::fs::write(&file, format!("{}{}", line(1), line(2))).unwrap();
        let _seam = SshSeam::install(&fake_ssh(&dir, &config));
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };
        let cache = TranscriptCache::default();

        // Absent agent → empty, not an error.
        assert!(read_subagent_transcript(&server, &cache, "c1", "sid-1", "zz", None).await.unwrap().is_empty());

        let items = read_subagent_transcript(&server, &cache, "c1", "sid-1", "a1", None).await.unwrap();
        assert_eq!(items.len(), 2, "{items:?}");
        let key: CacheKey = ("c1".into(), "transcript", "sid-1/a1".into());
        {
            let slot = cache.slot(&key);
            let held = slot.lock().await;
            assert_eq!(held.bytes.len(), line(1).len() + line(2).len());
            assert_eq!(held.path.as_deref(), Some(file.to_string_lossy().as_ref()));
        }

        // Appended: one complete line and a partial one (a writer mid-line).
        let partial = &line(4)[..20];
        std::fs::write(&file, format!("{}{}{}{}", line(1), line(2), line(3), partial)).unwrap();
        let items = read_subagent_transcript(&server, &cache, "c1", "sid-1", "a1", None).await.unwrap();
        assert_eq!(items.len(), 3, "the partial line is not parsed yet");

        // The hint: an Agent task's output symlink resolves to the transcript (no search).
        let tasks = dir.join("tmp").join("tasks");
        std::fs::create_dir_all(&tasks).unwrap();
        let other = config.join("projects").join("-w").join("sid-1").join("subagents").join("agent-b2.jsonl");
        std::fs::write(&other, line(9)).unwrap();
        std::os::unix::fs::symlink(&other, tasks.join("b2.output")).unwrap();
        let hinted = read_subagent_transcript(
            &server,
            &cache,
            "c1",
            "sid-1",
            "b2",
            Some(&tasks.join("b2.output").to_string_lossy()),
        )
        .await
        .unwrap();
        assert_eq!(hinted.len(), 1);

        // A hint pointing at ANOTHER agent's transcript is never followed: the search wins.
        let wrong = read_subagent_transcript(&server, &cache, "c2", "sid-1", "a1", Some(&other.to_string_lossy()))
            .await
            .unwrap();
        assert_eq!(wrong.len(), 3, "read a1's own transcript, not b2's");

        // A rewritten (shrunk) file is re-read from its start.
        std::fs::write(&file, line(7)).unwrap();
        let items = read_subagent_transcript(&server, &cache, "c1", "sid-1", "a1", None).await.unwrap();
        assert_eq!(items.len(), 1);

        // Unsafe ids never reach the server.
        let err = read_subagent_transcript(&server, &cache, "c1", "../x", "a1", None).await.unwrap_err();
        assert!(matches!(err, FileReadError::Refused { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A transcript bigger than one chunk arrives over several round trips in ONE read.
    #[tokio::test]
    async fn a_large_transcript_is_chained_over_several_chunks() {
        let dir = scratch("bigtranscript");
        let config = dir.join("config");
        let sub = config.join("projects").join("-w").join("sid-1").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let body: String = (0..20_000).map(line).collect(); // ~3 MB
        assert!(body.len() as u64 > 2 * CHUNK_MAX);
        std::fs::write(sub.join("agent-a1.jsonl"), &body).unwrap();
        let _seam = SshSeam::install(&fake_ssh(&dir, &config));
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };
        let cache = TranscriptCache::default();
        let items = read_subagent_transcript(&server, &cache, "c1", "sid-1", "a1", None).await.unwrap();
        assert_eq!(items.len(), 20_000);
        assert!(!items.iter().any(|i| matches!(i, ConversationItem::Notice { .. })));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The manifest: absent → None, present → parsed, corrupt → an error (never "absent").
    #[tokio::test]
    async fn manifest_reads_parse_or_fail_loudly() {
        let dir = scratch("manifest");
        let config = dir.join("config");
        let wf = config.join("projects").join("-w").join("sid-1").join("workflows");
        std::fs::create_dir_all(&wf).unwrap();
        let _seam = SshSeam::install(&fake_ssh(&dir, &config));
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };

        assert_eq!(read_workflow_run(&server, "sid-1", "wf_1").await.unwrap(), None);
        std::fs::write(wf.join("wf_1.json"), r#"{"runId":"wf_1","workflowName":"review","status":"completed"}"#).unwrap();
        let run = read_workflow_run(&server, "sid-1", "1").await.unwrap().expect("bare id tries wf_");
        assert_eq!(run.workflow_name.as_deref(), Some("review"));
        std::fs::write(wf.join("wf_2.json"), "{not json").unwrap();
        let err = read_workflow_run(&server, "sid-1", "wf_2").await.unwrap_err();
        assert!(matches!(&err, FileReadError::Io { server: Some(s), reason } if s == "Target" && reason.contains("unreadable manifest")), "{err:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The goal: the server's grep ships only goal lines, and the Mac's scan over them reaches
    /// the same verdict as over the whole transcript; a giant line quoting the marker is dropped.
    #[tokio::test]
    async fn goal_reads_ship_only_goal_lines() {
        let dir = scratch("goal");
        let config = dir.join("config");
        let proj = config.join("projects").join("-w");
        std::fs::create_dir_all(&proj).unwrap();
        let quoting = format!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"content\":\"{}goal_status\"}}]}}}}\n",
            "x".repeat(GOAL_LINE_MAX as usize)
        );
        let transcript = [
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,"condition":"ship it"}}"#.to_string() + "\n",
            r#"{"type":"assistant","uuid":"a","message":{"model":"claude-opus-4-8"}}"#.to_string() + "\n",
            quoting,
            r#"{"type":"attachment","attachment":{"type":"goal_status","met":false,"condition":"ship it","reason":"2 failing"}}"#.to_string() + "\n",
        ]
        .concat();
        std::fs::write(proj.join("sid-1.jsonl"), &transcript).unwrap();
        let _seam = SshSeam::install(&fake_ssh(&dir, &config));
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };

        let goal = read_active_goal(&server, "sid-1").await.unwrap().expect("goal active");
        assert_eq!(goal.condition, "ship it");
        assert_eq!(goal.reason.as_deref(), Some("2 failing"));
        assert_eq!(Some(goal), active_goal_from_transcript_str(&transcript));
        assert_eq!(read_active_goal(&server, "sid-unknown").await.unwrap(), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An ssh-level failure (exit 255) is "unreachable", with the server's name — never a fake
    /// "absent"; a script that fails another way is an I/O error carrying its stderr.
    #[tokio::test]
    async fn transport_failures_are_typed() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = scratch("transport");
        let bin = dir.join("ssh");
        std::fs::write(&bin, "#!/bin/sh\ncat >/dev/null\necho 'ssh: connect to host target.example port 22: Connection refused' >&2\nexit 255\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let m = machine();
        let server = Server { machine: &m, known_hosts: None };
        {
            let _seam = SshSeam::install(&bin);
            let err = read_active_goal(&server, "sid-1").await.unwrap_err();
            assert_eq!(
                err,
                FileReadError::Unreachable { server: "Target".into(), reason: "could not reach the server".into() }
            );
        }
        std::fs::write(&bin, "#!/bin/sh\ncat >/dev/null\necho 'sh: syntax error' >&2\nexit 2\n").unwrap();
        {
            let _seam = SshSeam::install(&bin);
            let err = read_active_goal(&server, "sid-1").await.unwrap_err();
            assert_eq!(err, FileReadError::Io { server: Some("Target".into()), reason: "sh: syntax error".into() });
        }
        // A server record that fails validation never spawns ssh at all.
        let mut bad = machine();
        bad.user = "-oProxyCommand=evil".into();
        let server = Server { machine: &bad, known_hosts: None };
        assert!(matches!(read_active_goal(&server, "sid-1").await.unwrap_err(), FileReadError::Refused { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_cache_evicts_least_recently_used_entries_over_its_cap() {
        let cache = TranscriptCache::default();
        let a: CacheKey = ("c".into(), "transcript", "a".into());
        let b: CacheKey = ("c".into(), "transcript", "b".into());
        let c: CacheKey = ("c".into(), "transcript", "c".into());
        cache.slot(&a);
        cache.record(&a, CACHE_MAX_BYTES / 2);
        cache.slot(&b);
        cache.record(&b, CACHE_MAX_BYTES / 2);
        cache.slot(&a); // a is now more recent than b
        cache.slot(&c);
        cache.record(&c, 10);
        assert!(cache.holds(&a) && cache.holds(&c));
        assert!(!cache.holds(&b), "the least recently used entry goes first");
    }
}
