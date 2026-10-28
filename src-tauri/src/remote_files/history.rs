//! The History panel's view of a PAIRED SERVER: every Claude conversation transcript under that
//! server's `<config>/projects`, listed and searchable on this Mac exactly like this Mac's own
//! ([`crate::supervisor::history`]). A conversation closed (×) in Flight Deck keeps its
//! transcript on its server (and its `flightdeckd` row, archived): without this, nothing but the
//! in-memory ⌘Z could find it again.
//!
//! ## Pre-filtered on the server
//! A transcript is mostly tool output, thinking and attachments — on real ones, 97 % of the
//! bytes. What a listing row and the search index read is only the human prompts, the
//! assistant's prose and the `ai-title` lines, so the scan script ([`scan_script`]) ships only
//! those: raw substring tests on each line BEFORE anything is parsed, the discipline of the
//! `/goal` pre-filter. The Mac then runs the SAME row scanner and indexer as for its own disk
//! ([`scan_conversation_lines`], [`index_conversation_lines`]) over the lines it received. The
//! tests rely on what the CLI writes: one content block per line, and a `tool_result` never on
//! the same line as a human prompt (checked over 163 real transcripts) — a line holding a
//! `tool_result`, or an assistant line with no `text` block, carries nothing searchable.
//!
//! ## One round trip, incremental
//! The Mac sends what it already holds (size + mtime per transcript, see [`ScanState`]) inside
//! the script; the server answers `same` for those, and ships only the new or changed ones —
//! most recent first, within a byte and a time budget per round ([`ScanLimits`]). A round cut by
//! its budget says so (`more`): the next round goes on from where it stopped, the files it
//! already completed now answering `same`. Only a COMPLETE round prunes what the server no
//! longer has. Nothing here polls: the History panel and the agents' history tools ask.
//!
//! ## Framing
//! ```text
//! FDHIST1 begin
//! FDHIST1 count <n>                         ← transcripts listed on the server
//! FDHIST1 same <size> <mtime> <rel>         ← unchanged since the Mac's copy
//! FDHIST1 file <size> <mtime> <rel>         ← changed: its pre-filtered lines follow…
//! {…}
//! FDHIST1 done <rel>                        ← …and are complete
//! FDHIST1 unreadable <size> <mtime> <rel> <reason>
//! FDHIST1 more                              ← budget spent: the rest on the next round
//! FDHIST1 end                               ← every listed transcript was answered
//! FDHIST1 error <reason>                    ← `projects/` itself could not be read
//! ```
//! `<rel>` is `<project slug>/<session id>.jsonl`. A content line always opens on `{` (the
//! filter ships nothing else), so it can never be read as a header.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use serde::Serialize;
use specta::Type;

use super::{is_safe_component, run_script, sanitize, FileReadError, Server};
use crate::ipc::commands::shq;
use crate::supervisor::history::{
    index_conversation_lines, scan_conversation_lines, DiskConversation, IndexedConversation,
};
use crate::supervisor::subagents::is_safe_id;

/// The framing tag. Versioned so a future change can never be misread by this one.
const FRAME: &str = "FDHIST1 ";

/// How much one listing may cost the server and the link.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ScanLimits {
    /// Pre-filtered bytes one transcript may ship once its first human prompt is in — room for
    /// the index's whole body ([`crate::supervisor::history::INDEX_BODY_CAP`] of text) on all
    /// but the longest conversations.
    pub file_max: u64,
    /// A single line past this is never shipped (a pasted log the size of a file).
    pub line_max: u64,
    /// Pre-filtered bytes one round ships before it stops (`more`) for the next.
    pub round_max: u64,
    /// Seconds one round may spend reading transcripts before it stops (`more`).
    pub round_seconds: u64,
    /// Rounds one listing chains before handing back what it has (the rest is `pending`).
    pub max_rounds: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            file_max: 512 * 1024,
            line_max: 2 * 1024 * 1024,
            round_max: 24 * 1024 * 1024,
            round_seconds: 20,
            max_rounds: 6,
        }
    }
}

impl ScanLimits {
    /// The most one round's answer can weigh: its budget, plus the last transcript it let
    /// through, plus the headers of every transcript it lists.
    fn round_stdout_max(&self, known: usize) -> u64 {
        self.round_max + self.file_max + self.line_max + (known as u64 + 4096) * 256
    }
}

/// How long one round may take, handshake and transfer included (compressed).
const SCAN_TIMEOUT: Duration = Duration::from_secs(120);

/// The longest `ai-title` line kept (a title is a few dozen bytes).
const TITLE_LINE_MAX: u64 = 4096;

/// The per-line pre-filter, run by `awk` on the server over one transcript (byte semantics,
/// `LC_ALL=C`). Ships the lines the row scanner and the indexer read — `ai-title`, human
/// prompts, assistant prose — and nothing else: sub-agent lines, injected ones (`isMeta`, a
/// compact summary), tool results and tool calls / thinking are dropped; an image's base64 is
/// emptied (its block stays, so an image-only prompt still lists as `[image]`). Once the first
/// human prompt is in, it stops at `max` bytes; before it, at `max + lmax`. Writes how many bytes
/// it shipped to `nf` (the round's budget).
const FILTER_AWK: &str = r#"BEGIN { out = 0; u = 0 }
{
  l = $0
  if (substr(l, 1, 1) != "{") next
  if (index(l, "\"isSidechain\":true")) next
  if (index(l, "\"type\":\"ai-title\"")) {
    n = length(l) + 1
    if (n <= tmax) { print l; out += n }
    next
  }
  isu = 0
  if (index(l, "\"type\":\"assistant\"")) {
    if (!index(l, "\"type\":\"text\"")) next
  } else if (index(l, "\"type\":\"user\"")) {
    if (index(l, "\"isMeta\":true") || index(l, "\"isCompactSummary\":true") || index(l, "\"isVisibleInTranscriptOnly\":true")) next
    if (index(l, "\"type\":\"tool_result\"")) next
    if (index(l, "\"type\":\"image\"")) gsub(/"data":"[A-Za-z0-9+\/=]*"/, "\"data\":\"\"", l)
    isu = 1
  } else next
  n = length(l) + 1
  if (u && out + n > max) exit
  if (out + n > max + lmax) exit
  if (n > lmax) next
  print l
  out += n
  if (isu) u = 1
}
END { print out > nf }
"#;

/// The listing script: POSIX sh on `sh -s`, every value single-quoted by [`shq`]. `known` is
/// what the Mac holds, as `<size> <mtime> <rel>` lines — each one validated by [`ScanState`]
/// (digits and a safe `rel` only), inside a QUOTED here-document, so nothing in it is ever
/// expanded. Answers one framed listing (see the module doc) and exits 0 on every handled path.
///
/// Portability: GNU `stat -c` (Linux, busybox) or BSD `stat -f` (a macOS server); `find
/// -mindepth/-maxdepth`; no `-printf`. A symbolic link under `projects/` is not followed
/// (`find -type f`), like every other server read.
pub(crate) fn scan_script(known: &[String], limits: &ScanLimits) -> String {
    let mut known_lines = String::new();
    for k in known {
        known_lines.push_str(k);
        known_lines.push('\n');
    }
    format!(
        r#"export LC_ALL=C
fh() {{ printf 'FDHIST1 %s\n' "$*"; }}
C=${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}
P=$C/projects
FMAX={file_max}
LMAX={line_max}
TMAX={title_max}
RMAX={round_max}
SMAX={round_seconds}
AWK={awk}
NAME='????????-????-????-????-????????????.jsonl'
fh begin
if [ ! -e "$P" ]; then fh count 0; fh end; exit 0; fi
if [ ! -d "$P" ] || [ ! -r "$P" ] || [ ! -x "$P" ]; then fh error "cannot read $P"; exit 0; fi
D=$(mktemp -d "${{TMPDIR:-/tmp}}/fdhist.XXXXXX") || {{ fh error "cannot create a temporary directory"; exit 0; }}
trap 'rm -rf "$D"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$D/known" <<'FDKNOWN'
#
{known_lines}FDKNOWN
if stat -c %s / >/dev/null 2>&1; then
  find "$P" -mindepth 2 -maxdepth 2 -type f -name "$NAME" -exec stat -c '%Y %s %n' {{}} + 2>/dev/null
else
  find "$P" -mindepth 2 -maxdepth 2 -type f -name "$NAME" -exec stat -f '%m %z %N' {{}} + 2>/dev/null
fi | sort -rn > "$D/list"
fh count "$(wc -l < "$D/list" | tr -d ' ')"
S0=$(date +%s)
awk -v p="$P/" 'NR == FNR {{ k[$0] = 1; next }}
{{ path = substr($0, length($1) + length($2) + 3)
  if (substr(path, 1, length(p)) != p) next
  rel = substr(path, length(p) + 1)
  if (($2 " " $1 " " rel) in k) print "S " $2 " " $1 " " rel
  else print "F " $2 " " $1 " " path }}' "$D/known" "$D/list" | {{
T=0
N=0
while IFS= read -r L; do
  case "$L" in
    "S "*) fh same "${{L#S }}" ;;
    "F "*)
      R=${{L#F }}; SZ=${{R%% *}}; R=${{R#* }}; MT=${{R%% *}}; F=${{R#* }}
      REL=${{F#"$P"/}}
      if [ "$N" -gt 0 ] && {{ [ "$T" -ge "$RMAX" ] || [ $(($(date +%s) - S0)) -ge "$SMAX" ]; }}; then fh more; exit 3; fi
      N=$((N + 1))
      if [ ! -r "$F" ]; then fh unreadable "$SZ" "$MT" "$REL" permission denied; continue; fi
      : > "$D/n"
      fh file "$SZ" "$MT" "$REL"
      if awk -v max="$FMAX" -v lmax="$LMAX" -v tmax="$TMAX" -v nf="$D/n" "$AWK" "$F" && read -r B < "$D/n"; then
        fh done "$REL"
        case "$B" in ''|*[!0-9]*) B=0 ;; esac
        T=$((T + B))
      else
        fh unreadable "$SZ" "$MT" "$REL" could not read the file
      fi
      ;;
  esac
done
exit 0
}}
[ $? -eq 3 ] || fh end
"#,
        file_max = limits.file_max,
        line_max = limits.line_max,
        title_max = TITLE_LINE_MAX,
        round_max = limits.round_max,
        round_seconds = limits.round_seconds,
        awk = shq(FILTER_AWK),
    )
}

// ---- the answer ----------------------------------------------------------------------------

/// One transcript in a round's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ScanItem {
    /// Unchanged since the Mac's copy.
    Same { rel: String },
    /// New or changed: its pre-filtered lines, complete.
    File { size: u64, mtime_s: i64, rel: String, lines: String },
    /// Listed, but the server could not read it.
    Unreadable { rel: String, reason: String },
}

/// How a round's answer ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanEnd {
    /// Every transcript listed on the server was answered.
    Complete,
    /// The round's budget was spent: the rest comes on the next round.
    More,
    /// The answer stopped without saying either (the link, a size refusal): unknown rest.
    Cut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScanAnswer {
    /// Transcripts listed on the server (`None` = it never said).
    count: Option<u64>,
    items: Vec<ScanItem>,
    end: ScanEnd,
    /// Transcripts named in a form no CLI writes (`<slug>/<session id>.jsonl`), or a block left
    /// incomplete: never listed, and not an error.
    skipped: u32,
}

/// Is `rel` a transcript path the CLI writes — `<slug>/<session id>.jsonl`?
fn session_of_rel(rel: &str) -> Option<&str> {
    let (slug, file) = rel.split_once('/')?;
    let stem = file.strip_suffix(".jsonl")?;
    (is_safe_component(slug) && is_session_uuid(stem)).then_some(stem)
}

/// A session id as the CLI mints them: a UUID (`8-4-4-4-12` hex) — the shape the scan's `find`
/// asks for, re-checked here (and a valid [`is_safe_id`] for the reads that follow).
fn is_session_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
        && is_safe_id(s)
}

/// Parse one round's stdout. Everything before the `begin` line (a login script that prints) is
/// skipped. `Err` = not a listing at all, or the server's own `error`.
fn parse_scan(raw: &[u8]) -> Result<ScanAnswer, String> {
    let text = String::from_utf8_lossy(raw);
    let mut lines = text.split('\n');
    let begin = format!("{FRAME}begin");
    if !lines.by_ref().any(|l| l.trim_end_matches('\r') == begin) {
        return Err("the server's answer carries no history listing".to_string());
    }
    let mut answer = ScanAnswer { count: None, items: Vec::new(), end: ScanEnd::Cut, skipped: 0 };
    // The block being received: (size, mtime, rel, lines).
    let mut open: Option<(u64, i64, String, String)> = None;
    for line in lines {
        let Some(header) = line.strip_prefix(FRAME) else {
            if let Some((.., body)) = open.as_mut() {
                if line.starts_with('{') {
                    body.push_str(line);
                    body.push('\n');
                }
            }
            continue;
        };
        let header = header.trim_end_matches('\r');
        let (status, args) = header.split_once(' ').unwrap_or((header, ""));
        if status != "done" && open.take().is_some() {
            // A block another header interrupted never completed.
            answer.skipped += 1;
        }
        let mut parts = args.splitn(3, ' ');
        let num = |s: Option<&str>| s.and_then(|v| v.trim().parse::<u64>().ok());
        match status {
            "count" => answer.count = num(Some(args)),
            "same" => {
                let (_size, _mtime, rel) = (parts.next(), parts.next(), parts.next().unwrap_or(""));
                match session_of_rel(rel) {
                    Some(_) => answer.items.push(ScanItem::Same { rel: rel.to_string() }),
                    None => answer.skipped += 1,
                }
            }
            "file" => {
                let (size, mtime) = (num(parts.next()), num(parts.next()));
                let rel = parts.next().unwrap_or("").to_string();
                match (size, mtime, session_of_rel(&rel)) {
                    (Some(size), Some(mtime), Some(_)) => {
                        open = Some((size, i64::try_from(mtime).unwrap_or(i64::MAX), rel, String::new()))
                    }
                    _ => answer.skipped += 1,
                }
            }
            "done" => match open.take() {
                Some((size, mtime_s, rel, lines)) if rel == args => {
                    answer.items.push(ScanItem::File { size, mtime_s, rel, lines })
                }
                Some(_) => answer.skipped += 1,
                None => {}
            },
            "unreadable" => {
                let mut rest = args.splitn(4, ' ').skip(2);
                let rel = rest.next().unwrap_or("").to_string();
                let reason = sanitize(rest.next().unwrap_or(""));
                if session_of_rel(&rel).is_some() {
                    answer.items.push(ScanItem::Unreadable { rel, reason });
                } else {
                    answer.skipped += 1;
                }
            }
            "more" => {
                answer.end = ScanEnd::More;
                break;
            }
            "end" => {
                answer.end = ScanEnd::Complete;
                break;
            }
            "error" => return Err(sanitize(args)),
            other => return Err(format!("unknown history status {:?}", sanitize(other))),
        }
    }
    if open.is_some() {
        answer.skipped += 1;
    }
    Ok(answer)
}

// ---- the cache -----------------------------------------------------------------------------

/// One transcript as the last scan left it.
#[derive(Clone)]
struct CachedFile {
    size: u64,
    mtime_s: i64,
    /// `None` = no human message (an aborted session): known, so never re-shipped while it does
    /// not change, but never listed — the same noise filter as this Mac's own listing.
    conv: Option<(DiskConversation, Arc<IndexedConversation>)>,
}

/// What this Mac holds of one server's transcripts, by `rel`.
#[derive(Default)]
pub(crate) struct ScanState {
    files: HashMap<String, CachedFile>,
    /// Transcripts the server listed but could not read, as of the last round that reached them.
    unreadable: HashSet<String>,
}

/// What one round changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RoundSummary {
    end: ScanEnd,
    /// Transcripts shipped and read this round.
    completed: usize,
    /// Transcripts listed on the server this round did not reach (`0` once complete).
    pending: u64,
}

impl ScanState {
    /// The `known` lines of the next round's script.
    fn known(&self) -> Vec<String> {
        let mut out: Vec<String> =
            self.files.iter().map(|(rel, f)| format!("{} {} {}", f.size, f.mtime_s, rel)).collect();
        out.sort();
        out
    }

    /// Fold one round's answer in. A round that ended `Complete` saw every transcript the
    /// server has: what it did not mention is gone there, and is dropped here too.
    fn apply(&mut self, answer: ScanAnswer, machine_id: &str) -> RoundSummary {
        let mut seen: HashSet<String> = HashSet::new();
        let mut completed = 0usize;
        for item in answer.items {
            match item {
                ScanItem::Same { rel } => {
                    seen.insert(rel);
                }
                ScanItem::File { size, mtime_s, rel, lines } => {
                    let conv = session_of_rel(&rel).and_then(|sid| conversation_of(sid, mtime_s, &lines, machine_id));
                    self.unreadable.remove(&rel);
                    self.files.insert(rel.clone(), CachedFile { size, mtime_s, conv });
                    seen.insert(rel);
                    completed += 1;
                }
                ScanItem::Unreadable { rel, reason } => {
                    eprintln!("[remote-history] {machine_id}: {rel} unreadable on the server: {reason}");
                    self.files.remove(&rel);
                    self.unreadable.insert(rel.clone());
                    seen.insert(rel);
                }
            }
        }
        let pending = match answer.end {
            ScanEnd::Complete => {
                self.files.retain(|rel, _| seen.contains(rel));
                self.unreadable.retain(|rel| seen.contains(rel));
                0
            }
            ScanEnd::More | ScanEnd::Cut => {
                answer.count.unwrap_or(0).saturating_sub(seen.len() as u64 + u64::from(answer.skipped))
            }
        };
        RoundSummary { end: answer.end, completed, pending }
    }

    /// The listing rows and the search index, one per session — the most recently written
    /// transcript of a session that left one under two project slugs (its cwd moved), the same
    /// pick as the server's own history read — most recent first.
    fn publish(&self) -> Published {
        let mut best: HashMap<&str, (&str, &CachedFile)> = HashMap::new();
        for (rel, f) in &self.files {
            let Some((row, _)) = &f.conv else { continue };
            let sid = row.session_id.as_str();
            let better = match best.get(sid) {
                None => true,
                Some((held_rel, held)) => (f.mtime_s, rel.as_str()) > (held.mtime_s, *held_rel),
            };
            if better {
                best.insert(sid, (rel.as_str(), f));
            }
        }
        let mut picked: Vec<&(DiskConversation, Arc<IndexedConversation>)> =
            best.values().filter_map(|(_, f)| f.conv.as_ref()).collect();
        picked.sort_by(|a, b| b.0.mtime_ms.cmp(&a.0.mtime_ms).then_with(|| a.0.session_id.cmp(&b.0.session_id)));
        Published {
            rows: picked.iter().map(|(row, _)| row.clone()).collect(),
            index: picked.iter().map(|(_, idx)| idx.clone()).collect(),
            unreadable: self.unreadable.len() as u32,
        }
    }
}

/// A transcript's listing row and index entry from its pre-filtered lines, stamped with the
/// server it lives on. `None` = no human message (noise, never listed).
fn conversation_of(
    session_id: &str,
    mtime_s: i64,
    lines: &str,
    machine_id: &str,
) -> Option<(DiskConversation, Arc<IndexedConversation>)> {
    let mtime_ms = mtime_s.saturating_mul(1000);
    let mut row = scan_conversation_lines(session_id.to_string(), mtime_ms, lines.lines())?;
    let mut index = index_conversation_lines(session_id.to_string(), mtime_ms, lines.lines())?;
    row.machine_id = Some(machine_id.to_string());
    index.machine_id = Some(machine_id.to_string());
    Some((row, Arc::new(index)))
}

/// What the last listing of a server produced.
#[derive(Default)]
pub(crate) struct Published {
    rows: Vec<DiskConversation>,
    index: Vec<Arc<IndexedConversation>>,
    unreadable: u32,
}

impl Published {
    /// The search index entries.
    pub(crate) fn index(&self) -> impl Iterator<Item = &IndexedConversation> {
        self.index.iter().map(Arc::as_ref)
    }
}

#[derive(Default)]
struct ServerEntry {
    /// Held across a listing's round trips: one listing of a server at a time, the next one
    /// waits and then costs one round of `same`.
    scan: tokio::sync::Mutex<ScanState>,
    /// The last listing's result, read by the search without waiting on a listing in flight.
    published: std::sync::Mutex<Option<Arc<Published>>>,
}

/// Every paired server's cached listing, by machine id.
#[derive(Default)]
pub struct ServerHistoryCache {
    servers: std::sync::Mutex<HashMap<String, Arc<ServerEntry>>>,
}

/// The app-wide cache (the IPC commands share it). Memory only: a relaunch re-reads each server
/// once, then incrementally again.
pub static SERVER_HISTORY: LazyLock<ServerHistoryCache> = LazyLock::new(ServerHistoryCache::default);

impl ServerHistoryCache {
    fn entry(&self, machine_id: &str) -> Arc<ServerEntry> {
        let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        servers.entry(machine_id.to_string()).or_default().clone()
    }

    /// The last listing of each of `machine_ids` that has one — the search's input. A server
    /// no longer paired is simply not asked for.
    pub(crate) fn published(&self, machine_ids: &[String]) -> Vec<Arc<Published>> {
        let servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        machine_ids
            .iter()
            .filter_map(|id| servers.get(id))
            .filter_map(|e| e.published.lock().unwrap_or_else(|p| p.into_inner()).clone())
            .collect()
    }
}

// ---- the listing ---------------------------------------------------------------------------

/// One paired server's conversations, as the History panel lists them.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ServerConversations {
    pub machine_id: String,
    /// Most recent first, each stamped with `machine_id`.
    pub conversations: Vec<DiskConversation>,
    /// Transcripts listed on the server that this listing's bounds did not reach yet — the next
    /// listing goes on from there. Said in the panel, never dropped silently.
    pub pending: u32,
    /// Transcripts the server could not read (permission, I/O): not listed, said in the panel.
    pub unreadable: u32,
}

/// List every conversation transcript on `server` (see the module doc): the cached copy brought
/// up to date in as few rounds as its changes need, then published for the search. `Err` = the
/// server could not be asked (unreachable, `projects/` unreadable, an answer that is no
/// listing): nothing of it is listed, and the caller says so.
pub async fn list_server_conversations(
    server: &Server<'_>,
    cache: &ServerHistoryCache,
) -> Result<ServerConversations, FileReadError> {
    list_server_conversations_with(server, cache, &ScanLimits::default()).await
}

/// [`list_server_conversations`] with explicit bounds — the testable core.
pub(crate) async fn list_server_conversations_with(
    server: &Server<'_>,
    cache: &ServerHistoryCache,
    limits: &ScanLimits,
) -> Result<ServerConversations, FileReadError> {
    let machine_id = server.machine.id.clone();
    let entry = cache.entry(&machine_id);
    let mut state = entry.scan.lock().await;
    let mut pending = 0u64;
    for _ in 0..limits.max_rounds.max(1) {
        let known = state.known();
        let script = scan_script(&known, limits);
        let raw = run_script(server, &script, SCAN_TIMEOUT, true, limits.round_stdout_max(known.len())).await?;
        let answer = parse_scan(&raw).map_err(|e| server.io(e))?;
        let summary = state.apply(answer, &machine_id);
        pending = summary.pending;
        if summary.end == ScanEnd::Complete || summary.completed == 0 {
            break;
        }
    }
    let published = Arc::new(state.publish());
    *entry.published.lock().unwrap_or_else(|e| e.into_inner()) = Some(published.clone());
    Ok(ServerConversations {
        machine_id,
        conversations: published.rows.clone(),
        pending: u32::try_from(pending).unwrap_or(u32::MAX),
        unreadable: published.unreadable,
    })
}

#[cfg(test)]
mod tests;
