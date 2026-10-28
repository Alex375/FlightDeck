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
    /// The worktree: where it runs.
    pub worktree: String,
    pub branch: Option<String>,
    /// The context header saved on the conversation.
    pub header: String,
}

const GONE: &str = "This launch is no longer in progress — start it again.";

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
    let id = uuid::Uuid::new_v4().to_string();
    let tmp = std::env::temp_dir().join(format!("flightdeck-launch-{id}"));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Couldn't prepare the launch: {e}"))?;
    LAUNCHES.lock().unwrap().insert(
        id.clone(),
        Launch {
            conversation_id,
            machine_id,
            repo_path,
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

/// Step 1 — reach the server, read its facts, align it.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_check(app: tauri::AppHandle, launch_id: String) -> Result<ServerFacts, String> {
    let machine_id = with_launch(&launch_id, |l| l.machine_id.clone())?;
    let m = machine(&app, &machine_id)?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let facts = sl::check(&Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None }).await?;
    with_launch(&launch_id, |l| l.facts = Some(facts.clone()))?;
    Ok(facts)
}

/// Step 2 — the commits and refs into the server's managed clone.
#[tauri::command]
#[specta::specta]
pub async fn server_launch_transfer(app: tauri::AppHandle, launch_id: String) -> Result<TransferOutcome, String> {
    let (machine_id, repo, tmp, cancel, checked) =
        with_launch(&launch_id, |l| (l.machine_id.clone(), l.repo_path.clone(), l.tmp.clone(), l.cancel.clone(), l.facts.is_some()))?;
    if !checked {
        return Err("Check the server first.".to_string());
    }
    let m = machine(&app, &machine_id)?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let ctx = Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None };
    let progress = emitter(&app, &launch_id, "transfer");
    let out = sl::transfer(&ctx, &launch_id, &repo, &tmp, &progress, &cancel).await?;
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
    with_launch(&launch_id, |l| l.copy = Some(out.clone()))?;
    Ok(out)
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
    let out = sl::worktree(&ctx, &transfer, copy.stage.as_deref()).await?;
    with_launch(&launch_id, |l| l.worktree = Some(out.clone()))?;
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
    Ok(LaunchTarget { clone: transfer.clone, worktree: worktree.worktree, branch: worktree.branch, header })
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
    let _ = std::fs::remove_dir_all(&launch.tmp);
    if !sl::is_launch_id(&launch_id) {
        return Ok(());
    }
    let m = machine(&app, &launch.machine_id)?;
    let kh = crate::ipc::commands::remote_known_hosts_path(&app);
    let ctx = Ctx { machine: &m, known_hosts: kh.as_deref(), ssh_bin: None };
    let clone = launch.transfer.as_ref().map(|t| t.clone.clone());
    let discard = match (discard, clone.as_deref(), launch.worktree.as_ref()) {
        (true, Some(c), Some(w)) => Some((c, w)),
        _ => None,
    };
    sl::cleanup(&ctx, &launch_id, discard).await
}

/// This machine's name, as its user knows it ("Armand's MacBook Pro").
#[tauri::command]
#[specta::specta]
pub async fn this_machine_name() -> String {
    tokio::task::spawn_blocking(crate::platform::this_machine_name).await.unwrap_or_else(|_| crate::platform::this_host_name())
}
