//! Provisioning sealed-channel devices on the paired servers
//! (`docs/tarmac-sealed-channel.md` §7, `flightdeckd` ≥ 0.5.0) — the device-key
//! counterpart of [`super::provision`]'s legacy phone token, driven the same way
//! (keyed SSH through the crate's one invoker, secrets on stdin, never argv).
//!
//! Wire to a daemon:
//! - `flightdeckd add-device`, one JSON object on stdin:
//!   `{device_id, label, relay_token, keys:[{generation, key, issued_at_ms, expires_at_ms}]}`
//!   where each `key` is THAT server's node key (`S.node_key(<daemon macId>)`) — a
//!   server never sees the device's master secret. Answers
//!   `{type:"fd_device_added", ok:true, added:bool}` | `{ok:false, error}`.
//! - `flightdeckd remove-device --device <id>` (the id is not a secret) →
//!   `{type:"fd_device_removed", ok:true, removed:bool}` | `{ok:false, error}`.
//! - `flightdeckd status` → `fd_status.devices`: what the RUNNING daemon really holds,
//!   checked on every sync — a server shown "ready" is never taken on faith.
//! - A binary older than 0.5.0 rejects the subcommand with clap's usage error
//!   (`unrecognized subcommand`): [`DeviceServerOutcome::DaemonTooOld`]. A new
//!   binary talking to an older RUNNING daemon fails with the daemon's own "restart
//!   it" sentence, surfaced verbatim.
//!
//! Where each device stands on each server is durable (`Store::remote_device_servers`):
//! a server is (re)provisioned whenever it holds less than the device's newest key
//! generation, and a revoked device is removed wherever a removal is still owed. Syncs
//! never run concurrently ([`DeviceProvisionRegistry`] serializes them): a revoke that
//! lands while a provisioning is in flight is honoured by the store
//! (`Store::set_remote_device_server_generation` records the removal owed) and acted on
//! by the same pass.
//!
//! A server is only ever given the key derived for ITS OWN relay identity, and an
//! identity that is this Mac's or another paired server's is refused: otherwise a
//! compromised server could obtain the key a phone uses with another node and pose as
//! that phone there.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tarmac_e2e::keys::DeviceSecret;

use super::provision::{failed_round_trip_reason, WhoamiIdentity};
use crate::ipc::commands::{resolve_daemon_bin_expr, run_ssh_on_machine, run_ssh_on_machine_stdin, shq};
use crate::store::{MachineRecord, RemoteDevice, Store};

const DEVICE_ROUND_TRIP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

fn now_ms() -> i64 {
    super::devices::now_ms()
}

/// One device's outcome on one server, as Settings reads it back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceServerOutcome {
    /// The server holds the device's keys up to `generation`.
    Provisioned { generation: u32 },
    /// The server confirmed it no longer holds the (revoked) device.
    Removed,
    /// The round trip failed (unreachable, refused): the reason, in words.
    Failed { reason: String },
    /// The server's `flightdeckd` predates sealed-channel devices (< 0.5.0).
    DaemonTooOld,
}

/// [`DeviceServerOutcome`] plus which device, which server and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DeviceServerStatus {
    pub device_id: String,
    pub machine_id: String,
    pub outcome: DeviceServerOutcome,
    pub checked_at_ms: i64,
}

/// In-memory, per-run record of the last outcome per (device, server) — the same
/// "runtime status the Settings UI reads back" shape as [`super::provision::ProvisionRegistry`].
/// What is durable (which generation a server confirmed, which removals are owed)
/// lives in the store; this adds the last failure's reason, the last error that
/// stopped a whole pass, and the lock that keeps syncs from overlapping.
#[derive(Default)]
pub struct DeviceProvisionRegistry {
    status: Mutex<HashMap<(String, String), DeviceServerStatus>>,
    /// Why the last pass could not run at all (the paired devices unreadable), shown
    /// in Settings; cleared by the next pass that runs.
    pass_error: Mutex<Option<String>>,
    /// Servers whose RUNNING daemon still takes unencrypted phone commands, with why
    /// (an older flightdeckd, or a legacy pairing still on it) — as of their last check.
    cleartext: Mutex<HashMap<String, String>>,
    /// Held for a whole pass: two passes never provision/remove the same device at once.
    sync_lock: tokio::sync::Mutex<()>,
    /// Another pass was asked for while one was running: the running one does it.
    again: AtomicBool,
}

impl DeviceProvisionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every (device, server) attempted this run.
    pub fn all(&self) -> Vec<DeviceServerStatus> {
        self.status.lock().expect("device registry lock").values().cloned().collect()
    }

    /// Record an outcome, stamped now.
    pub fn record(&self, device_id: &str, machine_id: &str, outcome: DeviceServerOutcome) {
        let row = DeviceServerStatus {
            device_id: device_id.to_string(),
            machine_id: machine_id.to_string(),
            outcome,
            checked_at_ms: now_ms(),
        };
        self.status
            .lock()
            .expect("device registry lock")
            .insert((device_id.to_string(), machine_id.to_string()), row);
    }

    /// Why the last pass could not run, if it could not.
    pub fn pass_error(&self) -> Option<String> {
        self.pass_error.lock().expect("device registry lock").clone()
    }

    fn set_pass_error(&self, error: Option<String>) {
        *self.pass_error.lock().expect("device registry lock") = error;
    }

    /// Every server last seen taking unencrypted commands: (machine id, why).
    pub fn cleartext_servers(&self) -> Vec<(String, String)> {
        let mut v: Vec<_> = self.cleartext.lock().expect("device registry lock").clone().into_iter().collect();
        v.sort();
        v
    }

    fn set_cleartext(&self, machine_id: &str, reason: Option<String>) {
        let mut map = self.cleartext.lock().expect("device registry lock");
        match reason {
            Some(r) => map.insert(machine_id.to_string(), r),
            None => map.remove(machine_id),
        };
    }
}

/// The `add-device` stdin payload for a daemon whose relay identity is `daemon_mac_id`:
/// every key generation of the device, each derived for THAT daemon.
fn add_device_payload(device: &RemoteDevice, daemon_mac_id: &str) -> Result<Value, String> {
    let keys = device
        .keys
        .iter()
        .map(|k| {
            let secret = DeviceSecret::from_b64(&k.secret).map_err(|e| format!("stored device secret is corrupt: {e}"))?;
            Ok(json!({
                "generation": k.generation,
                "key": secret.node_key(daemon_mac_id).to_b64(),
                "issued_at_ms": k.issued_at.max(0),
                "expires_at_ms": k.expires_at.max(0),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "device_id": device.device_id,
        "label": device.label,
        "relay_token": device.relay_token,
        "keys": keys,
    }))
}

/// A daemon refused the subcommand itself: its binary predates sealed-channel devices.
fn is_unknown_subcommand(stderr: &str) -> bool {
    stderr.contains("unrecognized subcommand")
}

/// Classify a daemon's answer to `add-device` / `remove-device`.
fn classify(stdout: &str, success: bool, exit_code: Option<i32>, stderr: &str) -> Result<bool, DeviceServerOutcome> {
    if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
        match v.get("ok").and_then(Value::as_bool) {
            Some(true) => return Ok(v.get("added").or_else(|| v.get("removed")).and_then(Value::as_bool).unwrap_or(true)),
            Some(false) => {
                let reason = v.get("error").and_then(Value::as_str).unwrap_or("the server refused").to_string();
                return Err(DeviceServerOutcome::Failed { reason });
            }
            None => {}
        }
    }
    if is_unknown_subcommand(stderr) {
        return Err(DeviceServerOutcome::DaemonTooOld);
    }
    if !success {
        return Err(DeviceServerOutcome::Failed { reason: failed_round_trip_reason(exit_code, stderr) });
    }
    Err(DeviceServerOutcome::Failed { reason: format!("unexpected daemon response: {}", stdout.trim()) })
}

/// Refuse a relay identity that is not this server's own: this Mac's, or another paired
/// server's. Deriving a key for it would hand this server the key a phone uses with that
/// other node.
fn check_daemon_identity(store: &Store, machine: &MachineRecord, mac_id: &str) -> Result<(), String> {
    if mac_id.trim().is_empty() {
        return Err("the server reported an empty relay identity".into());
    }
    let own = crate::ipc::commands::load_remote_config(store).mac_id;
    if mac_id == own {
        return Err(format!(
            "“{}” claims this Mac's own relay identity — refusing to give it this Mac's phone keys. \
             If it was reinstalled from a copy of this Mac, remove and pair it again.",
            machine.label
        ));
    }
    let others = store.all_machines().map_err(|e| format!("could not check the server's identity: {e}"))?;
    if let Some(other) = others.iter().find(|m| m.id != machine.id && m.daemon_mac_id.as_deref() == Some(mac_id)) {
        return Err(format!(
            "“{}” claims the relay identity of “{}” — refusing to give it that server's phone keys.",
            machine.label, other.label
        ));
    }
    Ok(())
}

/// The daemon's relay identity: the one recorded for this server (pinned), else asked
/// with `whoami` and recorded — either way checked by [`check_daemon_identity`].
async fn daemon_mac_id(store: &Store, known_hosts: Option<&str>, machine: &MachineRecord) -> Result<String, DeviceServerOutcome> {
    let failed = |reason: String| DeviceServerOutcome::Failed { reason };
    let mac_id = match machine.daemon_mac_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => id.to_string(),
        None => {
            let bin = resolve_daemon_bin_expr("flightdeckd");
            let stdout = run_ssh_on_machine(machine, known_hosts, &format!("{bin} whoami")).await.map_err(failed)?;
            let identity: WhoamiIdentity = serde_json::from_str(stdout.trim()).map_err(|_| {
                failed("the server did not say which relay identity it uses (flightdeckd whoami)".into())
            })?;
            check_daemon_identity(store, machine, &identity.mac_id).map_err(failed)?;
            store
                .set_machine_daemon_identity(&machine.id, &identity.mac_id, &identity.relay_url, &identity.label)
                .map_err(|e| failed(format!("could not record the server's identity: {e}")))?;
            identity.mac_id
        }
    };
    check_daemon_identity(store, machine, &mac_id).map_err(failed)?;
    Ok(mac_id)
}

/// What the RUNNING daemon says (`flightdeckd status`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct DaemonView {
    /// Device id → the key generations it holds there; `None` for a daemon older than
    /// 0.5.0 (no `devices` in its status: it knows no sealed-channel device).
    devices: Option<HashMap<String, Vec<u32>>>,
    /// Why it still takes unencrypted phone commands, if it does.
    cleartext: Option<String>,
}

/// The first daemon version that refuses unencrypted commands once no legacy phone
/// is authorized on it.
const SEALED_DAEMON_VERSION: &str = "0.5.0";

fn version_at_least(version: &str, min: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.trim().split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    parse(version) >= parse(min)
}

/// Read a daemon's `fd_status` line. `own_legacy_active`: whether THIS Mac still uses
/// its legacy shared token — when it doesn't, a legacy pairing left on the server is
/// not this Mac's (another Mac paired that server too) and retiring here can't remove it.
fn parse_daemon_view(stdout: &str, own_legacy_active: bool) -> Option<DaemonView> {
    let status: Value = serde_json::from_str(stdout.trim()).ok()?;
    if status.get("type").and_then(Value::as_str) != Some("fd_status") {
        return None;
    }
    let version = status.get("version").and_then(Value::as_str).unwrap_or("0");
    let devices = status.get("devices").and_then(Value::as_array).map(|rows| {
        rows.iter()
            .filter_map(|d| {
                let id = d.get("device_id")?.as_str()?.to_string();
                let mut gens: Vec<u32> = d
                    .get("keys")?
                    .as_array()?
                    .iter()
                    .filter_map(|k| u32::try_from(k.get("generation")?.as_u64()?).ok())
                    .collect();
                gens.sort_unstable();
                Some((id, gens))
            })
            .collect()
    });
    let legacy = status.get("legacy_phones").and_then(Value::as_u64).unwrap_or(0);
    let cleartext = if devices.is_none() || !version_at_least(version, SEALED_DAEMON_VERSION) {
        Some(format!(
            "it runs flightdeckd {version}, which carries out unencrypted commands the relay could forge — update it \
             (Settings → Servers), and restart it if it was updated but not restarted"
        ))
    } else if legacy > 0 {
        let plural = if legacy == 1 { "" } else { "s" };
        Some(if own_legacy_active {
            format!("it still holds {legacy} unencrypted phone pairing{plural} — retire the legacy pairing above so it is removed")
        } else {
            format!(
                "it still holds {legacy} unencrypted phone pairing{plural} that {} not this Mac's (this Mac's is \
                 retired) — another Mac paired this server too: retire the legacy pairing on that Mac, or remove it \
                 on the server (`flightdeckd remove-phone`)",
                if legacy == 1 { "is" } else { "are" }
            )
        })
    } else {
        None
    };
    Some(DaemonView { devices, cleartext })
}

/// What the RUNNING daemon holds and whether it still takes unencrypted commands.
/// `None` when it can't be told (unreachable, not running): the caller then trusts
/// the store, and makes no claim about cleartext.
async fn daemon_view(store: &Store, known_hosts: Option<&str>, machine: &MachineRecord) -> Option<DaemonView> {
    let bin = resolve_daemon_bin_expr("flightdeckd");
    let stdout = run_ssh_on_machine(machine, known_hosts, &format!("{bin} status")).await.ok()?;
    parse_daemon_view(&stdout, !crate::ipc::commands::load_remote_config(store).phone_token.is_empty())
}

/// Provision `device` (all its key generations) on one server.
pub async fn provision_device_on_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    device: &RemoteDevice,
) -> DeviceServerOutcome {
    let Some(newest) = device.keys.last().map(|k| k.generation) else {
        return DeviceServerOutcome::Failed { reason: "this device has no key".into() };
    };
    let mac_id = match daemon_mac_id(store, known_hosts, machine).await {
        Ok(id) => id,
        Err(outcome) => return outcome,
    };
    let payload = match add_device_payload(device, &mac_id) {
        Ok(p) => format!("{p}\n"),
        Err(reason) => return DeviceServerOutcome::Failed { reason },
    };
    let cmd = format!("{} add-device", resolve_daemon_bin_expr("flightdeckd"));
    let out = match run_ssh_on_machine_stdin(machine, known_hosts, &cmd, payload.as_bytes(), None, DEVICE_ROUND_TRIP_TIMEOUT).await {
        Ok(out) => out,
        Err(reason) => return DeviceServerOutcome::Failed { reason },
    };
    if let Err(outcome) = classify(&out.stdout, out.success, out.exit_code, &out.stderr) {
        return outcome;
    }
    match store.set_remote_device_server_generation(&device.device_id, &machine.id, newest, now_ms()) {
        Ok(true) => DeviceServerOutcome::Provisioned { generation: newest },
        // Revoked while this round trip was in flight: the store recorded the removal
        // owed — do it now rather than leave the key there until the next pass.
        Ok(false) => remove_device_from_machine(store, known_hosts, machine, &device.device_id).await,
        Err(e) => DeviceServerOutcome::Failed {
            reason: format!("the server took the phone's key, but recording it failed: {e} — it is checked again next sync"),
        },
    }
}

/// Remove a revoked device from one server.
pub async fn remove_device_from_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    device_id: &str,
) -> DeviceServerOutcome {
    remove_device(store, known_hosts, machine, device_id, false).await
}

/// [`remove_device_from_machine`] for a REMOVED server's tombstone (audit sec-keys#3):
/// the tombstone itself proves the device was held there — the `remote_device_servers`
/// row that a paired server's "too old" answer is checked against was deleted with the
/// server — so "too old" leaves the removal owed instead of reading as "never held".
pub async fn remove_owed_device_from_removed_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    device_id: &str,
) -> DeviceServerOutcome {
    remove_device(store, known_hosts, machine, device_id, true).await
}

/// Both of the above. `owed`: the removal is known to be owed, whatever the store's
/// per-server rows say.
async fn remove_device(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    device_id: &str,
    owed: bool,
) -> DeviceServerOutcome {
    let cmd = format!("{} remove-device --device {}", resolve_daemon_bin_expr("flightdeckd"), shq(device_id));
    let out = match run_ssh_on_machine_stdin(machine, known_hosts, &cmd, b"", None, DEVICE_ROUND_TRIP_TIMEOUT).await {
        Ok(out) => out,
        Err(reason) => return DeviceServerOutcome::Failed { reason },
    };
    let cleared = |store: &Store| match store.clear_remote_device_server(device_id, &machine.id) {
        Ok(()) => DeviceServerOutcome::Removed,
        Err(e) => DeviceServerOutcome::Failed {
            reason: format!("the server forgot the phone, but recording it failed: {e} — it is asked again next sync"),
        },
    };
    match classify(&out.stdout, out.success, out.exit_code, &out.stderr) {
        Ok(_) => cleared(store),
        // A binary too old to know devices: it never held one — unless this server was
        // provisioned with it before (rolled back, or an older binary shadowing the
        // daemon's): then the removal stays owed and says so.
        Err(DeviceServerOutcome::DaemonTooOld) => {
            let ever_held = owed
                || store
                    .remote_device_servers()
                    .map(|rows| {
                        rows.iter().any(|r| r.device_id == device_id && r.machine_id == machine.id && r.generation.is_some())
                    })
                    .unwrap_or(true);
            if ever_held {
                DeviceServerOutcome::DaemonTooOld
            } else {
                cleared(store)
            }
        }
        Err(outcome) => outcome,
    }
}

/// Bring one server up to date: settle what it owes about the legacy token, then
/// provision every device whose key set there differs from this Mac's (a generation
/// missing, or one pruned here still held there) and remove every revoked device still
/// owed — judged against what the RUNNING daemon reports when it can, else against the
/// store. Also records whether that daemon still takes unencrypted commands. Returns
/// each attempt, or why the pass could not run.
pub async fn sync_devices_on_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    registry: &DeviceProvisionRegistry,
) -> Result<Vec<(String, DeviceServerOutcome)>, String> {
    super::provision::settle_legacy_on_machine(store, known_hosts, machine).await;
    let devices = store.remote_devices().map_err(|e| format!("could not read the paired phones: {e}"))?;
    let servers = store.remote_device_servers().map_err(|e| format!("could not read where the phones stand: {e}"))?;
    // Always asked, even with no phone to sync: an older daemon takes unencrypted
    // commands whether or not a sealed phone exists, and Settings must say so.
    let view = daemon_view(store, known_hosts, machine).await;
    if let Some(v) = &view {
        registry.set_cleartext(&machine.id, v.cleartext.clone());
    }
    let on_daemon = view.and_then(|v| v.devices);
    let mut results = Vec::new();
    for device in &devices {
        let newest = device.keys.last().map(|k| k.generation).unwrap_or(0);
        let mut ours: Vec<u32> = device.keys.iter().map(|k| k.generation).collect();
        ours.sort_unstable();
        let recorded = servers
            .iter()
            .find(|s| s.device_id == device.device_id && s.machine_id == machine.id)
            .and_then(|s| s.generation)
            .unwrap_or(0);
        let (stale, held) = match &on_daemon {
            Some(map) => {
                let theirs = map.get(&device.device_id).cloned().unwrap_or_default();
                (theirs != ours, theirs.last().copied().unwrap_or(0))
            }
            None => (recorded < newest, recorded),
        };
        if stale {
            let outcome = provision_device_on_machine(store, known_hosts, machine, device).await;
            results.push((device.device_id.clone(), outcome));
        } else if held != recorded {
            // The daemon holds it but the store had lost track: record what is true.
            if let Err(e) = store.set_remote_device_server_generation(&device.device_id, &machine.id, held, now_ms()) {
                results.push((
                    device.device_id.clone(),
                    DeviceServerOutcome::Failed { reason: format!("could not record what the server holds: {e}") },
                ));
            }
        }
    }
    for row in servers.iter().filter(|s| s.machine_id == machine.id && s.remove_pending) {
        let gone = on_daemon.as_ref().is_some_and(|map| !map.contains_key(&row.device_id));
        let outcome = if gone {
            // The running daemon does not hold it: nothing to remove.
            match store.clear_remote_device_server(&row.device_id, &machine.id) {
                Ok(()) => DeviceServerOutcome::Removed,
                Err(e) => DeviceServerOutcome::Failed { reason: format!("could not record the removal: {e}") },
            }
        } else {
            remove_device_from_machine(store, known_hosts, machine, &row.device_id).await
        };
        results.push((row.device_id.clone(), outcome));
    }
    Ok(results)
}

/// [`sync_devices_on_machine`] on every paired server, one after another, recording
/// every outcome into `registry`. Passes never overlap: a call that arrives while one
/// runs makes that one go round again, and returns at once.
pub async fn sync_devices_on_all_machines(store: &Store, known_hosts: Option<&str>, registry: &DeviceProvisionRegistry) {
    registry.again.store(true, Ordering::SeqCst);
    loop {
        let Ok(guard) = registry.sync_lock.try_lock() else { return };
        while registry.again.swap(false, Ordering::SeqCst) {
            one_pass(store, known_hosts, registry).await;
        }
        drop(guard);
        if !registry.again.load(Ordering::SeqCst) {
            return;
        }
    }
}

async fn one_pass(store: &Store, known_hosts: Option<&str>, registry: &DeviceProvisionRegistry) {
    let machines = match store.all_machines() {
        Ok(m) => m,
        Err(e) => {
            let reason = format!("could not read the paired servers: {e}");
            eprintln!("[devices] {reason}");
            registry.set_pass_error(Some(reason));
            return;
        }
    };
    let mut pass_error = None;
    for machine in machines {
        match sync_devices_on_machine(store, known_hosts, &machine, registry).await {
            Ok(results) => {
                for (device_id, outcome) in results {
                    if let DeviceServerOutcome::Failed { reason } = &outcome {
                        eprintln!("[devices] {}: {reason}", machine.label);
                    }
                    registry.record(&device_id, &machine.id, outcome);
                }
            }
            Err(reason) => {
                eprintln!("[devices] {}: {reason}", machine.label);
                pass_error = Some(reason);
            }
        }
    }
    registry.set_pass_error(pass_error);
}

/// Whether anything is still owed somewhere: a device a server lacks (by the store's
/// books), a removal owed, a legacy revocation owed, or a server last seen taking
/// unencrypted commands (checked again until it no longer does). Drives the periodic
/// retry.
pub fn sync_owed(store: &Store, registry: &DeviceProvisionRegistry) -> bool {
    if !registry.cleartext_servers().is_empty() {
        return true;
    }
    let (Ok(devices), Ok(servers), Ok(machines)) = (store.remote_devices(), store.remote_device_servers(), store.all_machines())
    else {
        return true; // can't tell: try
    };
    if servers.iter().any(|s| s.remove_pending) {
        return true;
    }
    if store.machines_owing_phone_revocations().map(|m| !m.is_empty()).unwrap_or(true) {
        return true;
    }
    devices.iter().any(|d| {
        let newest = d.keys.last().map(|k| k.generation).unwrap_or(0);
        machines.iter().any(|m| {
            servers
                .iter()
                .find(|s| s.device_id == d.device_id && s.machine_id == m.id)
                .and_then(|s| s.generation)
                .unwrap_or(0)
                < newest
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appmcp::provision::test_support::{machine, PathGuard};
    use crate::store::{RemoteDeviceKey, Store};

    fn device(id: &str, generations: &[u32]) -> RemoteDevice {
        RemoteDevice {
            device_id: id.into(),
            label: "iPhone".into(),
            relay_token: format!("rt-{id}"),
            added_at: 1,
            last_seen_at: None,
            keys: generations
                .iter()
                .map(|g| RemoteDeviceKey {
                    generation: *g,
                    secret: DeviceSecret::from_bytes([*g as u8; 32]).to_b64(),
                    issued_at: 10,
                    expires_at: 20,
                })
                .collect(),
            push: vec![],
        }
    }

    fn known_machine(store: &Store, id: &str) -> MachineRecord {
        let mut m = machine(id);
        m.daemon_mac_id = Some(format!("daemon-{id}"));
        store.upsert_machine(&m).unwrap();
        store
            .set_machine_daemon_identity(id, &format!("daemon-{id}"), "https://relay", id)
            .unwrap();
        store.machine_by_id(id).unwrap().unwrap()
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tosse-devsync-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_payload_carries_this_servers_node_keys_never_the_master_secret() {
        let d = device("d1", &[1, 2]);
        let p = add_device_payload(&d, "daemon-x").unwrap();
        let text = p.to_string();
        for k in &d.keys {
            assert!(!text.contains(&k.secret), "a master secret leaked into the payload");
        }
        assert_eq!(p["keys"][1]["key"], DeviceSecret::from_bytes([2; 32]).node_key("daemon-x").to_b64());
        assert_eq!(p["relay_token"], "rt-d1");
        assert_eq!(p["keys"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn replies_are_classified() {
        assert_eq!(classify(r#"{"type":"fd_device_added","ok":true,"added":true}"#, true, Some(0), ""), Ok(true));
        assert_eq!(
            classify(r#"{"ok":false,"error":"too many paired devices"}"#, false, Some(1), ""),
            Err(DeviceServerOutcome::Failed { reason: "too many paired devices".into() })
        );
        assert_eq!(
            classify("", false, Some(2), "error: unrecognized subcommand 'add-device'\n"),
            Err(DeviceServerOutcome::DaemonTooOld)
        );
        assert_eq!(
            classify("", false, Some(1), "Error: the running flightdeckd predates `add-device` — restart it\n"),
            Err(DeviceServerOutcome::Failed { reason: "Error: the running flightdeckd predates `add-device` — restart it".into() })
        );
    }

    #[test]
    fn a_server_claiming_another_nodes_identity_is_refused() {
        let store = Store::open_in_memory().unwrap();
        let mac_id = crate::ipc::commands::load_remote_config(&store).mac_id;
        let a = known_machine(&store, "a");
        let b = known_machine(&store, "b");
        assert!(check_daemon_identity(&store, &a, "daemon-a").is_ok());
        let err = check_daemon_identity(&store, &a, &mac_id).unwrap_err();
        assert!(err.contains("this Mac's own relay identity"), "{err}");
        let err = check_daemon_identity(&store, &a, "daemon-b").unwrap_err();
        assert!(err.contains("“b”"), "{err}");
        assert!(check_daemon_identity(&store, &b, "").is_err());
    }

    #[tokio::test]
    async fn sync_provisions_what_a_server_lacks_and_removes_what_is_owed() {
        let _g = PathGuard::install("device-sync");
        let dir = scratch("sync");
        let calls = dir.join("calls");
        std::env::set_var("FAKE_SSH_CALL_LOG", &calls);
        std::env::set_var("FAKE_SSH_ADDDEVICE_OUT", r#"{"type":"fd_device_added","ok":true,"added":true}"#);
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_OUT", r#"{"type":"fd_device_removed","ok":true,"removed":true}"#);

        let store = Store::open_in_memory().unwrap();
        known_machine(&store, "m1");
        store.insert_remote_device(&device("d1", &[1])).unwrap();
        store.insert_remote_device(&device("gone", &[1])).unwrap();
        store.set_remote_device_server_generation("gone", "m1", 1, 1).unwrap();
        store.revoke_remote_device("gone", 2).unwrap();

        let registry = DeviceProvisionRegistry::new();
        sync_devices_on_all_machines(&store, None, &registry).await;
        let mut got: Vec<(String, DeviceServerOutcome)> =
            registry.all().into_iter().map(|s| (s.device_id, s.outcome)).collect();
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            got,
            vec![
                ("d1".to_string(), DeviceServerOutcome::Provisioned { generation: 1 }),
                ("gone".to_string(), DeviceServerOutcome::Removed),
            ]
        );
        let servers = store.remote_device_servers().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!((servers[0].device_id.as_str(), servers[0].generation), ("d1", Some(1)));
        // Nothing secret on any command line (the key travels on stdin).
        let log = std::fs::read_to_string(&calls).unwrap();
        assert!(!log.contains(&device("d1", &[1]).keys[0].secret));
        assert!(!log.contains(&DeviceSecret::from_bytes([1; 32]).node_key("daemon-m1").to_b64()));
        assert!(registry.pass_error().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn the_node_key_goes_on_stdin_never_the_master_secret() {
        let _g = PathGuard::install("device-stdin");
        let dir = scratch("stdin");
        let stdin = dir.join("stdin");
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin);
        std::env::set_var("FAKE_SSH_ADDDEVICE_OUT", r#"{"type":"fd_device_added","ok":true,"added":true}"#);
        let store = Store::open_in_memory().unwrap();
        let m = known_machine(&store, "m1");
        let d = device("d1", &[1]);
        store.insert_remote_device(&d).unwrap();
        assert_eq!(provision_device_on_machine(&store, None, &m, &d).await, DeviceServerOutcome::Provisioned { generation: 1 });
        let sent = std::fs::read_to_string(&stdin).unwrap();
        assert!(sent.contains(&DeviceSecret::from_bytes([1; 32]).node_key("daemon-m1").to_b64()));
        assert!(!sent.contains(&d.keys[0].secret), "the master secret went to the server");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_revoke_during_provisioning_still_removes_the_device() {
        let _g = PathGuard::install("device-race");
        std::env::set_var("FAKE_SSH_ADDDEVICE_OUT", r#"{"type":"fd_device_added","ok":true,"added":true}"#);
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_OUT", r#"{"type":"fd_device_removed","ok":true,"removed":true}"#);
        let store = Store::open_in_memory().unwrap();
        let m = known_machine(&store, "m1");
        let d = device("d1", &[1]);
        store.insert_remote_device(&d).unwrap();
        // The revoke lands before the add-device answer is recorded.
        store.revoke_remote_device("d1", 5).unwrap();
        assert_eq!(provision_device_on_machine(&store, None, &m, &d).await, DeviceServerOutcome::Removed);
        assert!(store.remote_device_servers().unwrap().is_empty(), "nothing left on that server's books");
    }

    #[tokio::test]
    async fn a_revoked_device_is_owed_by_every_server_even_never_provisioned_ones() {
        let store = Store::open_in_memory().unwrap();
        known_machine(&store, "m1");
        known_machine(&store, "m2");
        store.insert_remote_device(&device("d1", &[1])).unwrap();
        store.set_remote_device_server_generation("d1", "m1", 1, 1).unwrap();
        store.revoke_remote_device("d1", 2).unwrap();
        let owed: Vec<String> =
            store.remote_device_servers().unwrap().into_iter().filter(|s| s.remove_pending).map(|s| s.machine_id).collect();
        assert_eq!(owed, vec!["m1".to_string(), "m2".to_string()]);
        assert!(sync_owed(&store, &DeviceProvisionRegistry::new()));
    }

    #[tokio::test]
    async fn an_old_daemon_is_reported_and_retried_next_time() {
        let _g = PathGuard::install("device-old");
        std::env::set_var("FAKE_SSH_ADDDEVICE_EXIT", "2");
        std::env::set_var("FAKE_SSH_ADDDEVICE_ERR", "error: unrecognized subcommand 'add-device'\n");
        let store = Store::open_in_memory().unwrap();
        let m = known_machine(&store, "m1");
        store.insert_remote_device(&device("d1", &[1])).unwrap();
        let registry = DeviceProvisionRegistry::new();
        let results = sync_devices_on_machine(&store, None, &m, &registry).await.unwrap();
        assert_eq!(results, vec![("d1".to_string(), DeviceServerOutcome::DaemonTooOld)]);
        assert!(store.remote_device_servers().unwrap().is_empty(), "nothing recorded: the next sync retries");
        assert!(sync_owed(&store, &registry));
    }

    #[test]
    fn a_daemon_that_still_takes_cleartext_is_named() {
        let old = parse_daemon_view(r#"{"type":"fd_status","version":"0.4.2","label":"x","conversations":[]}"#, true).unwrap();
        assert!(old.devices.is_none());
        assert!(old.cleartext.unwrap().contains("flightdeckd 0.4.2"));
        let status = r#"{"type":"fd_status","version":"0.5.0","conversations":[],"devices":[],"legacy_phones":2}"#;
        let legacy = parse_daemon_view(status, true).unwrap();
        assert!(legacy.cleartext.unwrap().contains("2 unencrypted phone pairings — retire the legacy pairing above"));
        // This Mac's own legacy pairing is retired: what is left is another Mac's.
        let foreign = parse_daemon_view(status, false).unwrap().cleartext.unwrap();
        assert!(foreign.contains("are not this Mac's") && foreign.contains("on that Mac"), "{foreign}");
        let sealed = parse_daemon_view(
            r#"{"type":"fd_status","version":"0.5.1","conversations":[],"legacy_phones":0,
                "devices":[{"device_id":"d1","keys":[{"generation":3},{"generation":2}]}]}"#,
            true,
        )
        .unwrap();
        assert_eq!(sealed.cleartext, None);
        assert_eq!(sealed.devices.unwrap()["d1"], vec![2, 3]);
        assert_eq!(parse_daemon_view("{}", true), None, "not a status line: no claim either way");
        assert!(version_at_least("0.10.0", "0.5.0") && !version_at_least("0.4.9", "0.5.0"));
    }

    #[tokio::test]
    async fn a_generation_pruned_here_is_pruned_on_the_server_and_cleartext_is_tracked() {
        let _g = PathGuard::install("device-prune");
        let dir = scratch("prune");
        let stdin = dir.join("stdin");
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin);
        std::env::set_var("FAKE_SSH_ADDDEVICE_OUT", r#"{"type":"fd_device_added","ok":true,"added":false}"#);
        let store = Store::open_in_memory().unwrap();
        let m = known_machine(&store, "m1");
        let d = device("d1", &[2]);
        store.insert_remote_device(&d).unwrap();
        store.set_remote_device_server_generation("d1", "m1", 2, 1).unwrap();
        // The server still holds generation 1 next to 2: it is sent the pruned set.
        std::env::set_var(
            "FAKE_SSH_STATUS_OUT",
            r#"{"type":"fd_status","version":"0.5.0","conversations":[],"legacy_phones":1,
               "devices":[{"device_id":"d1","keys":[{"generation":1},{"generation":2}]}]}"#,
        );
        let registry = DeviceProvisionRegistry::new();
        let results = sync_devices_on_machine(&store, None, &m, &registry).await.unwrap();
        assert_eq!(results, vec![("d1".to_string(), DeviceServerOutcome::Provisioned { generation: 2 })]);
        let sent: Value = serde_json::from_str(std::fs::read_to_string(&stdin).unwrap().trim()).unwrap();
        assert_eq!(sent["keys"].as_array().unwrap().len(), 1);
        assert_eq!(registry.cleartext_servers().len(), 1, "its legacy pairing is reported");
        assert!(sync_owed(&store, &registry), "rechecked until it is closed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_too_old_daemon_that_once_held_the_device_keeps_its_removal_owed() {
        let _g = PathGuard::install("device-rollback");
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_EXIT", "2");
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_ERR", "error: unrecognized subcommand 'remove-device'\n");
        let store = Store::open_in_memory().unwrap();
        let m = known_machine(&store, "m1");
        known_machine(&store, "m2");
        store.insert_remote_device(&device("d1", &[1])).unwrap();
        store.set_remote_device_server_generation("d1", "m1", 1, 1).unwrap();
        store.revoke_remote_device("d1", 2).unwrap();
        // m1 held it: the removal stays owed. m2 never did: nothing to remove there.
        assert_eq!(remove_device_from_machine(&store, None, &m, "d1").await, DeviceServerOutcome::DaemonTooOld);
        let m2 = store.machine_by_id("m2").unwrap().unwrap();
        assert_eq!(remove_device_from_machine(&store, None, &m2, "d1").await, DeviceServerOutcome::Removed);
        let left: Vec<String> = store.remote_device_servers().unwrap().into_iter().map(|s| s.machine_id).collect();
        assert_eq!(left, vec!["m1".to_string()]);
    }

    /// One server that accepts the connection and never answers `status` (a wedged
    /// daemon, a login shell stuck on a stale NFS home) used to hold the pass — and with it
    /// `sync_lock` — forever: every later revoke and Settings "Retry" then returned at once
    /// without reaching ANY server. The pass must give up on that server and finish the
    /// others.
    #[tokio::test]
    async fn a_sync_pass_survives_one_server_that_never_answers() {
        let _g = PathGuard::install("device-hang");
        std::env::set_var("FAKE_SSH_HANG_ON", "*-p 2201*status");
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_OUT", r#"{"type":"fd_device_removed","ok":true,"removed":true}"#);
        crate::ipc::commands::TEST_SSH_DEADLINE.with(|d| d.set(Some(std::time::Duration::from_millis(300))));

        let store = Store::open_in_memory().unwrap();
        let mut stuck = known_machine(&store, "a");
        stuck.port = 2201;
        store.upsert_machine(&stuck).unwrap();
        known_machine(&store, "b");
        store.insert_remote_device(&device("gone", &[1])).unwrap();
        store.set_remote_device_server_generation("gone", "b", 1, 1).unwrap();
        store.revoke_remote_device("gone", 2).unwrap();

        let registry = DeviceProvisionRegistry::new();
        let pass = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            sync_devices_on_all_machines(&store, None, &registry),
        )
        .await;
        crate::ipc::commands::TEST_SSH_DEADLINE.with(|d| d.set(None));
        pass.expect("the pass must not wait forever on the server that never answers");
        let on_b = registry.all().into_iter().find(|s| s.device_id == "gone" && s.machine_id == "b");
        assert_eq!(on_b.map(|s| s.outcome), Some(DeviceServerOutcome::Removed));
        assert!(registry.sync_lock.try_lock().is_ok(), "the pass released its lock");
    }

    #[tokio::test]
    async fn passes_never_overlap_and_a_late_request_is_not_lost() {
        let store = Store::open_in_memory().unwrap();
        let registry = DeviceProvisionRegistry::new();
        let guard = registry.sync_lock.try_lock().unwrap();
        // A pass is "running": this call returns at once but leaves a pass owed…
        sync_devices_on_all_machines(&store, None, &registry).await;
        assert!(registry.again.load(Ordering::SeqCst));
        drop(guard);
        // …which the next caller (or the running pass's loop) picks up.
        sync_devices_on_all_machines(&store, None, &registry).await;
        assert!(!registry.again.load(Ordering::SeqCst));
    }
}
