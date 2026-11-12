//! The front's handle on a server launch (`crate::server_launch`): begin one, run each step
//! (and run it again after a failure), finish it — the context header saved on the
//! conversation — and end it, cleaning up what it left on the server.
//!
//! The launch's state lives HERE, keyed by its id, so the front only says which step to run:
//! it never carries the repository's snapshot or the server's facts back and forth.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_specta::Event;

use crate::server_launch::{
    self as sl, stream::Cancel, CopyOutcome, Ctx, Launch, ServerFacts, TransferOutcome, WorktreeOutcome, LAUNCHES,
};
use crate::store::{MachineRecord, Store};

/// Bytes sent by a launch step, as it goes.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ServerLaunchProgressEvent {
    pub launch_id: String,
    /// `transfer` or `copy`.
    pub step: String,
    pub sent: u64,
    pub total: u64,
}

/// What the conversation becomes once the launch is finished.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTarget {
    /// The managed clone: the server folder the conversation is filed under.
    pub clone: String,
    /// The worktree.
    pub worktree: String,
    /// Where it runs: the worktree, or the same subfolder of it the repository was opened at.
    pub cwd: String,
    pub branch: Option<String>,
    /// The context header saved on the conversation.
    pub header: String,
}

const GONE: &str = "This launch is no longer in progress — start it again.";

/// How a step that finished after its launch was cancelled says it could NOT remove what it
/// made (the front shows that one even though nobody waits on the step any more). ⚠️ The
/// front matches on this exact opening: `serverLaunchStore.ts` (`LEFT_BEHIND`).
const LEFT_BEHIND: &str = "A cancelled move left something on the server:";

/// The SQLite config key of this install's id on servers (see `LocalState::host_id`).
const MAC_ID_KEY: &str = "server_launch_mac_id";

/// This install's stable id, minted (and kept) the first time it is needed.
fn mac_id(app: &tauri::AppHandle) -> Result<String, String> {
    let store = app.state::<Store>();
    if let Some(id) = store.get_config(MAC_ID_KEY).map_err(|e| e.to_string())?.filter(|s| !s.is_empty()) {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    store.set_config(MAC_ID_KEY, &id).map_err(|e| format!("Couldn't save this {}'s id: {e}", crate::platform::MACHINE))?;
    Ok(id)
}

/// A launch's scratch folder on this Mac: `<temp>/flightdeck-launch-<id>`.
const SCRATCH_PREFIX: &str = "flightdeck-launch-";

/// Remove the scratch folders of launches more than a day old — one the app never ended
/// (quit or crash in the middle) can hold a bundle and a staged archive with secrets.
fn sweep_stale_scratch(temp: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(temp) else { return };
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for e in rd.flatten() {
        let stale = e.file_name().to_string_lossy().starts_with(SCRATCH_PREFIX)
            && e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age > day));
        if stale {
            if let Err(err) = std::fs::remove_dir_all(e.path()) {
                eprintln!("[server_launch] could not remove the stale {}: {err}", e.path().display());
            }
        }
    }
}

fn machine(app: &tauri::AppHandle, machine_id: &str) -> Result<MachineRecord, String> {
    app.state::<Store>()
        .machine_by_id(machine_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This server is no longer paired with Flight Deck.".to_string())
}

/// Read what a step needs from the launch (never holding the lock across the step).
fn with_launch<T>(launch_id: &str, f: impl FnOnce(&mut Launch) -> T) -> Result<T, String> {
    let mut map = LAUNCHES.lock().unwrap();
    map.get_mut(launch_id).map(f).ok_or_else(|| GONE.to_string())
}

fn emitter(app: &tauri::AppHandle, launch_id: &str, step: &str) -> impl Fn(u64, u64) + Send + Sync {
    let (app, launch_id, step) = (app.clone(), launch_id.to_string(), step.to_string());
    move |sent, total| {
        let _ = ServerLaunchProgressEvent { launch_id: launch_id.clone(), step: step.clone(), sent, total }.emit(&app);
    }
}

/// Start a launch of `conversation_id` (an empty conversation in the repository at
/// `repo_path`, on this Mac) on server `machine_id`. Returns its id.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_begin(
    app: tauri::AppHandle,
    conversation_id: String,
    machine_id: String,
    repo_path: String,
) -> Result<String, String> {
    machine(&app, &machine_id)?;
    let mac_id = mac_id(&app)?;
    sweep_stale_scratch(&std::env::temp_dir());
    let id = uuid::Uuid::new_v4().to_string();
    let tmp = std::env::temp_dir().join(format!("{SCRATCH_PREFIX}{id}"));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Couldn't prepare the launch: {e}"))?;
    LAUNCHES.lock().unwrap().insert(
        id.clone(),
        Launch {
            conversation_id,
            machine_id,
            repo_path,
            mac_id,
            cancel: Cancel::new(),
            tmp,
            facts: None,
            transfer: None,
            copy: None,
            worktree: None,
        },
    );
    Ok(id)
}

/// Align the server with this Mac before moving a repository onto it: the ONE call point of
/// task 763ae7f2's `bootstrap::align::align_machine(app, machine_id) -> Result<AlignReport,
/// String>` (an explicit call aligns whatever the server's "Keep aligned" toggle says; `Err`
/// only when the pass cannot start — unknown server, another operation on it, out of reach).
/// It takes the server's lock itself: called BEFORE any step of the launch touches the
/// server, never during one. A pass already running on that server (an automatic one) is
/// waited for, not refused: passes are single-file per server.
///
/// A server whose "Keep this server aligned with this Mac" toggle is OFF is not aligned by a
/// launch either (`None`: the step shows the link check only) — the user chose to keep its
/// own config, version and daemon; "Sync now" in its panel still aligns it on demand.
async fn align_hook(app: &tauri::AppHandle, machine_id: &str) -> Result<Option<sl::AlignSummary>, String> {
    if !crate::bootstrap::align::keep_aligned(app, machine_id) {
        return Ok(None);
    }
    let report = crate::bootstrap::align::align_machine(app.clone(), machine_id.to_string()).await?;
    Ok(Some(align_summary(&report)))
}

/// Pure: an alignment pass as step 1 shows it — one line per part, in the order the pass
/// runs them, its versions moved (`2.1.278 → 2.1.312`) ahead of its own sentence.
fn align_summary(r: &crate::bootstrap::align::AlignReport) -> sl::AlignSummary {
    use crate::bootstrap::align::{AlignPart, AlignStatus};
    let line = |part: &str, p: &AlignPart| {
        let status = match p.status {
            AlignStatus::Current => "current",
            AlignStatus::Updated => "updated",
            AlignStatus::Deferred => "deferred",
            AlignStatus::Skipped => "skipped",
            AlignStatus::Failed => "failed",
        };
        let versions = match (&p.before, &p.after) {
            (Some(b), Some(a)) if b != a => Some(format!("{b} → {a}")),
            (b, a) => a.clone().or_else(|| b.clone()),
        };
        let detail = match (versions, &p.detail) {
            (Some(v), Some(d)) => Some(format!("{v} — {d}")),
            (v, d) => v.or_else(|| d.clone()),
        };
        sl::AlignLine { part: part.to_string(), status: status.to_string(), detail }
    };
    sl::AlignSummary {
        ok: r.ok,
        parts: vec![
            line("Claude Code", &r.claude),
            line("Claude Code config", &r.config),
            line("flightdeckd", &r.daemon),
            line("Running conversations", &r.sessions),
        ],
    }
}

#[cfg(test)]
mod align_hook_tests {
    use super::*;
    use crate::bootstrap::align::{AlignPart, AlignReport, AlignStatus, AlignTrigger, ConfigChanges};

    /// The alignment's real report reaches step 1: every part, its status word, the versions
    /// it moved and its own sentence — and a failed part makes the summary not ok.
    #[test]
    fn the_alignment_report_reaches_step_one() {
        let part = |status, before: Option<&str>, after: Option<&str>, detail: Option<&str>| AlignPart {
            status,
            before: before.map(str::to_string),
            after: after.map(str::to_string),
            detail: detail.map(str::to_string),
        };
        let report = AlignReport {
            machine_id: "m".into(),
            trigger: AlignTrigger::Manual,
            claude: part(AlignStatus::Updated, Some("2.1.278"), Some("2.1.312"), None),
            daemon: part(AlignStatus::Deferred, Some("0.6.0"), Some("0.6.0"), Some("restarts once no conversation works")),
            config: part(AlignStatus::Failed, None, None, Some("couldn't write .claude/x")),
            config_changes: ConfigChanges::default(),
            sessions: part(AlignStatus::Current, None, None, None),
            mac_claude_version: Some("2.1.312".into()),
            server_claude_version: Some("2.1.312".into()),
            ok: false,
            finished_at: 0,
        };
        let s = align_summary(&report);
        assert!(!s.ok);
        let lines: Vec<(&str, &str, Option<&str>)> =
            s.parts.iter().map(|l| (l.part.as_str(), l.status.as_str(), l.detail.as_deref())).collect();
        assert_eq!(
            lines,
            vec![
                ("Claude Code", "updated", Some("2.1.278 → 2.1.312")),
                ("Claude Code config", "failed", Some("couldn't write .claude/x")),
                ("flightdeckd", "deferred", Some("0.6.0 — restarts once no conversation works")),
                ("Running conversations", "current", None),
            ]
        );
    }
}

/// Step 1 — align the server with this Mac, then reach it and read its facts. A failed part
/// of the alignment does not stop the launch: it is shown, before the conversation starts.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_check(app: tauri::AppHandle, launch_id: String) -> Result<ServerFacts, String> {
    let machine_id = with_launch(&launch_id, |l| l.machine_id.clone())?;
    let m = machine(&app, &machine_id)?;
    let align = align_hook(&app, &machine_id).await?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let mut facts = sl::check(&Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None }).await?;
    facts.align = align;
    with_launch(&launch_id, |l| l.facts = Some(facts.clone()))?;
    Ok(facts)
}

/// Step 2 — the commits and refs into the server's managed clone.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_transfer(app: tauri::AppHandle, launch_id: String) -> Result<TransferOutcome, String> {
    let (machine_id, repo, mac_id, tmp, cancel, checked) = with_launch(&launch_id, |l| {
        (l.machine_id.clone(), l.repo_path.clone(), l.mac_id.clone(), l.tmp.clone(), l.cancel.clone(), l.facts.is_some())
    })?;
    if !checked {
        return Err("Check the server first.".to_string());
    }
    let m = machine(&app, &machine_id)?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let ctx = Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None };
    let progress = emitter(&app, &launch_id, "transfer");
    let out = sl::transfer(&ctx, &launch_id, &repo, &mac_id, &tmp, &progress, &cancel).await?;
    with_launch(&launch_id, |l| {
        l.transfer = Some(out.clone());
        // A new transfer invalidates what was staged against the old one.
        l.copy = None;
        l.worktree = None;
    })?;
    Ok(out)
}

/// Step 3 — the uncommitted state, staged on the server.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_copy(app: tauri::AppHandle, launch_id: String) -> Result<CopyOutcome, String> {
    let (machine_id, tmp, cancel, transfer) =
        with_launch(&launch_id, |l| (l.machine_id.clone(), l.tmp.clone(), l.cancel.clone(), l.transfer.clone()))?;
    let transfer = transfer.ok_or_else(|| "Transfer the repository first.".to_string())?;
    let m = machine(&app, &machine_id)?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let ctx = Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None };
    let progress = emitter(&app, &launch_id, "copy");
    let out = sl::copy(&ctx, &launch_id, &transfer.local, &tmp, &progress, &cancel).await?;
    if with_launch(&launch_id, |l| l.copy = Some(out.clone())).is_err() {
        // Ended while this step ran: what it just staged there (secrets among it) goes too.
        return Err(abandoned(&ctx, &launch_id, None).await);
    }
    Ok(out)
}

/// A step finished after its launch was ended (cancelled while it ran): remove what it left
/// on the server, and say so.
async fn abandoned(ctx: &Ctx<'_>, launch_id: &str, made: Option<(&str, &WorktreeOutcome)>) -> String {
    match sl::cleanup(ctx, launch_id, made).await {
        Ok(()) => GONE.to_string(),
        Err(e) => format!("{LEFT_BEHIND} {e}"),
    }
}

/// Step 4 — the worktree, with the uncommitted state laid over it.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_worktree(app: tauri::AppHandle, launch_id: String) -> Result<WorktreeOutcome, String> {
    let (machine_id, transfer, copy, made) =
        with_launch(&launch_id, |l| (l.machine_id.clone(), l.transfer.clone(), l.copy.clone(), l.worktree.clone()))?;
    // Already made (a retry of the step after the front lost its answer): the same one.
    if let Some(w) = made {
        return Ok(w);
    }
    let transfer = transfer.ok_or_else(|| "Transfer the repository first.".to_string())?;
    let copy = copy.ok_or_else(|| "Copy the uncommitted files first.".to_string())?;
    let m = machine(&app, &machine_id)?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let ctx = Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None };
    let out = sl::worktree(&ctx, &launch_id, &transfer, &copy).await?;
    if with_launch(&launch_id, |l| l.worktree = Some(out.clone())).is_err() {
        // Ended while this step ran: the worktree it just made (and its branch) go too.
        return Err(abandoned(&ctx, &launch_id, Some((&transfer.clone, &out))).await);
    }
    Ok(out)
}

/// Step 5's first half — build the context header and save it on the conversation, so its
/// first spawn (and every later one) carries it. The front then files the conversation under
/// the server folder and starts it.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_finish(app: tauri::AppHandle, launch_id: String) -> Result<LaunchTarget, String> {
    let (conv, machine_id, facts, transfer, copy, worktree) = with_launch(&launch_id, |l| {
        (
            l.conversation_id.clone(),
            l.machine_id.clone(),
            l.facts.clone(),
            l.transfer.clone(),
            l.copy.clone(),
            l.worktree.clone(),
        )
    })?;
    let (Some(facts), Some(transfer), Some(copy), Some(worktree)) = (facts, transfer, copy, worktree) else {
        return Err("The worktree isn't ready yet.".to_string());
    };
    let m = machine(&app, &machine_id)?;
    let header = sl::context_header(&crate::remote_files::server_name(&m), &facts, &transfer, &copy, &worktree);
    let n = app
        .state::<Store>()
        .set_conversation_launch_header(&conv, Some(&header))
        .map_err(|e| format!("Couldn't save where this conversation runs: {e}"))?;
    if n == 0 {
        return Err("This conversation no longer exists.".to_string());
    }
    Ok(LaunchTarget { clone: transfer.clone, worktree: worktree.worktree, cwd: worktree.cwd, branch: worktree.branch, header })
}

/// End a launch — finished, or abandoned (`discard`: the worktree it made, and the branch it
/// created, are removed too). Stops a step still sending, removes what the launch left on
/// the server and on this Mac. `Err` when the server could not be cleaned (the launch is
/// forgotten anyway).
#[tauri::command]
#[specta::specta]
pub async fn server_launch_end(app: tauri::AppHandle, launch_id: String, discard: bool) -> Result<(), String> {
    let Some(launch) = LAUNCHES.lock().unwrap().remove(&launch_id) else {
        return Ok(());
    };
    launch.cancel.cancel();
    // What could not be removed here (a bundle, an archive with secrets) is said, not left.
    let local = match std::fs::remove_dir_all(&launch.tmp) {
        Err(e) if launch.tmp.exists() => Some(format!("{} could not be removed on this {}: {e}", launch.tmp.display(), crate::platform::MACHINE)),
        _ => None,
    };
    let m = machine(&app, &launch.machine_id)?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let ctx = Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None };
    let clone = launch.transfer.as_ref().map(|t| t.clone.clone());
    let discard = match (discard, clone.as_deref(), launch.worktree.as_ref()) {
        (true, Some(c), Some(w)) => Some((c, w)),
        _ => None,
    };
    let remote = sl::cleanup(&ctx, &launch_id, discard).await;
    match (remote, local) {
        (Ok(()), None) => Ok(()),
        (Ok(()), Some(l)) => Err(l),
        (Err(r), None) => Err(r),
        (Err(r), Some(l)) => Err(format!("{r} {l}")),
    }
}

/// This machine's name, as its user knows it ("Armand's MacBook Pro").
#[tauri::command]
#[specta::specta]
pub async fn this_machine_name() -> String {
    tokio::task::spawn_blocking(crate::platform::this_machine_name).await.unwrap_or_else(|_| crate::platform::this_host_name())
}

#[cfg(test)]
mod tests {
    /// The front recognizes a cancelled step's failed cleanup by this exact opening.
    #[test]
    fn the_left_behind_wording_is_the_one_the_front_matches_on() {
        let ts = include_str!("../../../src/features/conversation/serverLaunch/serverLaunchStore.ts");
        assert!(ts.contains(&format!("LEFT_BEHIND = \"{}\"", super::LEFT_BEHIND)), "serverLaunchStore.ts must match");
    }
}
