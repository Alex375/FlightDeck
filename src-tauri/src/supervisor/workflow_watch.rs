//! Live watch on a RUNNING workflow's journal — the push side of the workflow display.
//!
//! Why a watcher and not a poll: a workflow's per-agent state exists ONLY on disk while it
//! runs (the wire aggregates a whole run into a single task, and the rich manifest is written
//! at the END). The journal was previously read by a 1.5 s poll that ran only while the detail
//! modal was open, so every other surface — the pinned bar, the inline card, the Flight Deck
//! card — was stuck with the wire's coarse `"<phase>: <label>"` string. Watching the run's
//! directory instead pushes a fresh [`WorkflowJournal`] to the webview whenever the CLI appends
//! to it, so every surface can show the real "N running · M done" without any of them polling.
//!
//! Shape mirrors [`crate::fs::FsWatcher`] (notify + a debounce thread), with three differences
//! this case forces:
//!  - **Many concurrent watches, ref-counted.** Several surfaces can watch the same run at
//!    once (bar + card + modal), and several runs can be live across conversations — so
//!    watches are keyed by `(session_id, run_id)` with a refcount, not "one active watch".
//!  - **The directory may not exist yet.** The CLI creates the run dir with its FIRST agent,
//!    which can be seconds after the run starts. `notify` cannot watch a missing path, so the
//!    loop probes for it on a short cadence until it appears, then installs the watch.
//!  - **A slow heartbeat behind the watch.** Even once watching, the loop wakes on a long
//!    timeout as a safety net, so a missed FS event degrades to a few seconds of staleness
//!    rather than a permanently frozen readout.
//!
//! Errors are never swallowed: a journal that exists but won't parse/read is emitted as an
//! `error` on the event, which the front surfaces in the app error banner.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri_specta::Event;

use super::model::WorkflowJournal;
use super::subagents::{load_workflow_journal, workflow_run_dir};
use crate::ipc::events::WorkflowJournalEvent;

/// How long to coalesce a burst of FS events before re-reading the journal. The CLI appends
/// one line per agent transition; a fan-out of a dozen agents lands as a burst.
const DEBOUNCE: Duration = Duration::from_millis(200);

/// Cadence for probing a run directory that does not exist yet (the window between the run
/// starting and its first agent spawning).
const PROBE: Duration = Duration::from_millis(500);

/// Safety-net wake-up once the watch is installed: bounds staleness if an FS event is missed.
/// Long enough that an idle run costs essentially nothing.
const HEARTBEAT: Duration = Duration::from_secs(5);

type Key = (String, String);

/// Every live workflow-journal watch, keyed by `(session_id, run_id)`. Tauri managed state.
#[derive(Default)]
pub struct WorkflowWatchers {
    inner: Mutex<HashMap<Key, Entry>>,
}

struct Entry {
    /// How many front-end surfaces asked for this run. The thread stops at zero.
    refs: usize,
    stop: Arc<AtomicBool>,
    /// Asks the loop to re-emit even if the journal has not changed — how a LATE subscriber
    /// gets a snapshot (see [`WorkflowWatchers::watch`]).
    resend: Arc<AtomicBool>,
    /// Wakes the loop immediately, so a joining subscriber is served now rather than at the
    /// next heartbeat.
    wake: Sender<()>,
}

impl WorkflowWatchers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start watching `run_id` (or join an existing watch), pushing a `WorkflowJournalEvent`
    /// whenever its journal changes. Idempotent per caller: each `watch` must be paired with
    /// one [`Self::unwatch`].
    ///
    /// A snapshot is always emitted promptly — including when joining a watch already running —
    /// so a surface that mounts mid-run doesn't sit blank until the next FS event.
    ///
    /// ⚠️ A joining subscriber is served by WAKING THE EXISTING LOOP, never by a second emitter.
    /// Two threads emitting for the same run would each hold their own "has it changed?" state,
    /// so which snapshot the UI ends on would be decided by event arrival order — and neither
    /// thread would correct it, since each believes it already sent the latest. That is how a
    /// cleared error could silently come back, or a stale one stick: exactly the class of
    /// failure this module is supposed to remove.
    pub fn watch(&self, app: tauri::AppHandle, session_id: String, run_id: String) {
        let key = (session_id.clone(), run_id.clone());
        let mut map = self.inner.lock().unwrap();
        match map.get_mut(&key) {
            Some(entry) => {
                entry.refs += 1;
                // Force the next emit through even if the journal has not moved, so the new
                // subscriber gets the current state instead of waiting for the run to change.
                entry.resend.store(true, Ordering::SeqCst);
                let _ = entry.wake.send(());
            }
            None => {
                let stop = Arc::new(AtomicBool::new(false));
                let resend = Arc::new(AtomicBool::new(false));
                let (tx, rx) = channel::<()>();
                map.insert(
                    key,
                    Entry { refs: 1, stop: stop.clone(), resend: resend.clone(), wake: tx.clone() },
                );
                drop(map);
                std::thread::spawn(move || {
                    watch_loop(app, session_id, run_id, stop, resend, tx, rx)
                });
            }
        }
    }

    /// Drop one reference to a run's watch; the last one stops it. An unknown or unbalanced
    /// unwatch is a no-op: this is called from a component teardown, and a panic there would
    /// take down an IPC command over a bookkeeping slip.
    pub fn unwatch(&self, session_id: &str, run_id: &str) {
        let key = (session_id.to_string(), run_id.to_string());
        let mut map = self.inner.lock().unwrap();
        let Some(entry) = map.get_mut(&key) else { return };
        entry.refs = entry.refs.saturating_sub(1);
        if entry.refs == 0 {
            if let Some(entry) = map.remove(&key) {
                // The loop sees this on its next wake and exits (worst case one HEARTBEAT).
                entry.stop.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// Read the journal once and emit it if it differs from `last` (which it updates). Sending an
/// unchanged snapshot would re-render every subscribed surface for nothing, so equality gates
/// the emit — `None` as `last` means "emit whatever you find" (a fresh subscriber).
fn emit_snapshot(
    app: &tauri::AppHandle,
    session_id: &str,
    run_id: &str,
    last: &mut Option<Result<Option<WorkflowJournal>, String>>,
) {
    let now = load_workflow_journal(session_id, run_id);
    if last.as_ref() == Some(&now) {
        return;
    }
    let event = match &now {
        Ok(journal) => WorkflowJournalEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            journal: journal.clone(),
            error: None,
        },
        // A journal that exists but can't be read is a REAL failure (permission/IO), not the
        // normal "not written yet" — surface it instead of showing a frozen readout.
        Err(e) => WorkflowJournalEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            journal: None,
            error: Some(e.clone()),
        },
    };
    *last = Some(now);
    if let Err(e) = event.emit(app) {
        eprintln!("[workflow watch] failed to emit journal event: {e}");
    }
}

fn watch_loop(
    app: tauri::AppHandle,
    session_id: String,
    run_id: String,
    stop: Arc<AtomicBool>,
    resend: Arc<AtomicBool>,
    // `tx` is kept alive for the whole loop (it is also cloned into the watcher and held by the
    // registry entry), so `rx` cannot disconnect while the run directory is still missing — the
    // window where no watcher exists yet.
    tx: Sender<()>,
    rx: Receiver<()>,
) {
    let mut watcher: Option<RecommendedWatcher> = None;
    let mut last: Option<Result<Option<WorkflowJournal>, String>> = None;

    loop {
        // Install the watch as soon as the CLI has created the run directory (it does so with
        // the first agent, i.e. after the run has already started).
        if watcher.is_none() {
            if let Some(dir) = workflow_run_dir(&session_id, &run_id) {
                match install_watch(dir, tx.clone()) {
                    Ok(w) => watcher = Some(w),
                    // Watching failed (rare: FS backend limits). Don't give up — the heartbeat
                    // below keeps the readout live, just less promptly. Logged, never silent.
                    Err(e) => eprintln!("[workflow watch] cannot watch {run_id}: {e}"),
                }
            }
        }

        // A subscriber that joined since the last emit needs the current state even if the
        // journal has not moved: clearing `last` makes the next emit unconditional.
        if resend.swap(false, Ordering::SeqCst) {
            last = None;
        }
        emit_snapshot(&app, &session_id, &run_id, &mut last);

        // Check `stop` AFTER emitting, never before: the teardown is triggered by the run's own
        // end, so the final appends and the stop flag arrive together. Breaking first would
        // discard the very snapshot that closes the run out, and since nothing else ever writes
        // that store entry, every surface would sit on "N running" forever. Paying one extra
        // read per watch closes the race outright.
        if stop.load(Ordering::SeqCst) {
            break;
        }

        // Without a watch, probe briskly for the directory; with one, sleep long and rely on
        // FS events, waking on the heartbeat only as a safety net.
        let wait = if watcher.is_some() { HEARTBEAT } else { PROBE };
        match rx.recv_timeout(wait) {
            // A change: keep draining while the burst continues, then loop to re-read once.
            Ok(()) => while rx.recv_timeout(DEBOUNCE).is_ok() {},
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Whether an FS event is worth a journal re-read. The run directory holds the journal AND every
/// agent's transcript (`agent-<id>.jsonl`, real ones reach 400 KB and are appended to constantly
/// while the fleet works) — they are SIBLINGS, so a non-recursive watch delivers their writes too.
/// Without this filter, every token an agent wrote re-read and re-parsed the whole journal (up to
/// 1 MB on a real run), several times a second, for counts that had not moved.
///
/// Two things besides a journal write must get through, or the filter would trade a perf win for
/// a correctness loss:
///  - **The watched directory itself.** FSEvents reports its overflow signal (`MustScanSubDirs`,
///    "I dropped events, re-read everything") with the DIRECTORY as its path — verified live.
///    Discarding it would drop the one event that means "you are now out of date", precisely
///    when the fleet is busiest.
///  - **A path-less event**, defensively: a backend that coalesces without paths would otherwise
///    go unheard. (Not reachable on macOS, where notify always attaches a path.)
///
/// Re-reading once too often is harmless; missing an append is not.
fn event_touches_journal(paths: &[PathBuf], dir: &Path) -> bool {
    paths.is_empty()
        || paths.iter().any(|p| {
            p.file_name().and_then(|n| n.to_str()) == Some("journal.jsonl") || p == dir
        })
}

fn install_watch(dir: PathBuf, tx: Sender<()>) -> notify::Result<RecommendedWatcher> {
    let watched = dir.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        match res {
            // Only the journal's own writes (and the backend's "you missed events" signal) mean
            // the counts may have moved. The receiver is only gone once the loop has exited;
            // ignore that race.
            Ok(event) => {
                if event_touches_journal(&event.paths, &watched) {
                    let _ = tx.send(());
                }
            }
            // A backend error would otherwise strand the readout silently; log it and let the
            // loop's heartbeat carry on.
            Err(e) => eprintln!("[workflow watch] event error: {e}"),
        }
    })?;
    // Non-recursive: everything we care about (the journal) sits directly in this directory.
    // ⚠️ This does NOT keep the per-agent transcripts out — they are siblings of the journal,
    // not children of a subdirectory; `event_touches_journal` is what excludes them.
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The refcount is what lets bar + card + modal watch the same run without one closing
    /// the others' watch: the entry survives until the LAST unwatch, and an unbalanced or
    /// unknown unwatch is a no-op rather than a panic.
    #[test]
    fn watch_entries_are_refcounted() {
        let watchers = WorkflowWatchers::new();
        let key = ("s".to_string(), "wf_a".to_string());
        {
            let mut map = watchers.inner.lock().unwrap();
            let (tx, _rx) = channel::<()>();
            map.insert(
                key.clone(),
                Entry {
                    refs: 2,
                    stop: Arc::new(AtomicBool::new(false)),
                    resend: Arc::new(AtomicBool::new(false)),
                    wake: tx,
                },
            );
        }
        watchers.unwatch("s", "wf_a");
        assert!(
            watchers.inner.lock().unwrap().contains_key(&key),
            "a second subscriber still holds the watch",
        );
        watchers.unwatch("s", "wf_a");
        assert!(!watchers.inner.lock().unwrap().contains_key(&key), "last unwatch stops it");
        // Unknown / already-dropped key: a no-op, never a panic.
        watchers.unwatch("s", "wf_a");
        watchers.unwatch("nope", "wf_none");
    }

    /// A subscriber joining a live watch must be served by the EXISTING loop (resend flag +
    /// wake), never by a second emitter: two emitters keep independent "has it changed?" state,
    /// so the snapshot the UI ends on would depend on arrival order, and neither would correct
    /// it. This is what keeps a cleared error from silently coming back.
    #[test]
    fn a_joining_subscriber_wakes_the_existing_loop() {
        let watchers = WorkflowWatchers::new();
        let key = ("s".to_string(), "wf_a".to_string());
        let (tx, rx) = channel::<()>();
        let resend = Arc::new(AtomicBool::new(false));
        {
            let mut map = watchers.inner.lock().unwrap();
            map.insert(
                key.clone(),
                Entry {
                    refs: 1,
                    stop: Arc::new(AtomicBool::new(false)),
                    resend: resend.clone(),
                    wake: tx,
                },
            );
        }
        // Join (the AppHandle is unreachable in a unit test, so drive the registry directly —
        // this is precisely the branch `watch` takes for an existing key).
        {
            let mut map = watchers.inner.lock().unwrap();
            let entry = map.get_mut(&key).unwrap();
            entry.refs += 1;
            entry.resend.store(true, Ordering::SeqCst);
            let _ = entry.wake.send(());
        }
        assert!(resend.load(Ordering::SeqCst), "the loop is told to re-emit unconditionally");
        assert!(rx.try_recv().is_ok(), "and is woken now, not at the next heartbeat");
        assert_eq!(watchers.inner.lock().unwrap()[&key].refs, 2);
        // Consuming the flag is what makes the next emit unconditional exactly once.
        assert!(resend.swap(false, Ordering::SeqCst));
        assert!(!resend.load(Ordering::SeqCst));
    }

    /// The run dir holds the journal AND every agent transcript, side by side. Only the journal
    /// may wake the loop — otherwise a busy fleet re-parses a 1 MB file several times a second
    /// for counts that never moved. What must still get through is the backend's overflow
    /// signal, which arrives pathed at the DIRECTORY.
    #[test]
    fn only_journal_writes_wake_the_watcher() {
        let dir = PathBuf::from("/x/subagents/workflows/wf_1");
        let child = |name: &str| dir.join(name);
        assert!(event_touches_journal(&[child("journal.jsonl")], &dir));
        // The transcripts and their meta files are the noise this filter exists for.
        assert!(!event_touches_journal(&[child("agent-a7e93ddb5.jsonl")], &dir));
        assert!(!event_touches_journal(&[child("agent-a7e93ddb5.meta.json")], &dir));
        // A batch that touches both still counts (the journal moved).
        assert!(event_touches_journal(
            &[child("agent-a7e93ddb5.jsonl"), child("journal.jsonl")],
            &dir,
        ));
        // ⚠️ FSEvents reports its "I dropped events, rescan" signal with the WATCHED DIRECTORY
        // as the path (verified against notify on macOS). Filtering it out would discard the one
        // event meaning "you are out of date" — exactly when the fleet is busiest.
        assert!(event_touches_journal(&[dir.clone()], &dir));
        // A path-less event is kept defensively (a backend that coalesces without paths).
        assert!(event_touches_journal(&[], &dir));
        // A file merely CONTAINING the name is not the journal. (An atomic replace still wakes
        // us: the DESTINATION rename events carry `journal.jsonl` itself.)
        assert!(!event_touches_journal(&[child("journal.jsonl.tmp")], &dir));
        // A same-named file in ANOTHER directory is not ours either.
        assert!(!event_touches_journal(
            &[PathBuf::from("/x/subagents/workflows/wf_other")],
            &dir,
        ));
    }
}
