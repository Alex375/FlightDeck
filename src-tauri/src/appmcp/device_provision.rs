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
//! - A binary older than 0.5.0 rejects the subcommand with clap's usage error
//!   (`unrecognized subcommand`): [`DeviceServerOutcome::DaemonTooOld`]. A new
//!   binary talking to an older RUNNING daemon fails with the daemon's own "restart
//!   it" sentence, surfaced verbatim.
//!
//! Where each device stands on each server is durable (`Store::remote_device_servers`):
//! a server is (re)provisioned whenever it holds less than the device's newest key
//! generation, and a revoked device is removed wherever a removal is still owed —
//! both retried by [`sync_devices_on_all_machines`] (at launch, after pairing or
//! revoking, after a renewal).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tarmac_e2e::keys::DeviceSecret;

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
/// lives in the store; this only adds the last failure's reason.
#[derive(Default)]
pub struct DeviceProvisionRegistry {
    status: Mutex<HashMap<(String, String), DeviceServerStatus>>,
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
}

#[derive(Debug, Deserialize)]
struct WhoamiIdentity {
    mac_id: String,
    relay_url: String,
    label: String,
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
    if stderr.contains("unrecognized subcommand") {
        return Err(DeviceServerOutcome::DaemonTooOld);
    }
    if !success {
        let lines: Vec<String> = stderr.lines().map(str::to_string).collect();
        let reason = crate::ssh_link::classify_transport_close(exit_code, &lines)
            .map(crate::ssh_link::describe)
            .unwrap_or_else(|| {
                lines
                    .iter()
                    .find(|l| l.starts_with("Error: "))
                    .or_else(|| lines.iter().rev().find(|l| !l.trim().is_empty()))
                    .cloned()
                    .unwrap_or_else(|| "ssh command failed".to_string())
            });
        return Err(DeviceServerOutcome::Failed { reason });
    }
    Err(DeviceServerOutcome::Failed { reason: format!("unexpected daemon response: {}", stdout.trim()) })
}

/// The daemon's relay identity, from the store, refreshed by `whoami` when unknown.
async fn daemon_mac_id(store: &Store, known_hosts: Option<&str>, machine: &MachineRecord) -> Result<String, DeviceServerOutcome> {
    if let Some(id) = machine.daemon_mac_id.as_deref().filter(|s| !s.is_empty()) {
        return Ok(id.to_string());
    }
    let bin = resolve_daemon_bin_expr("flightdeckd");
    let stdout = run_ssh_on_machine(machine, known_hosts, &format!("{bin} whoami"))
        .await
        .map_err(|reason| DeviceServerOutcome::Failed { reason })?;
    let identity: WhoamiIdentity = serde_json::from_str(stdout.trim()).map_err(|_| DeviceServerOutcome::Failed {
        reason: "the server did not say which relay identity it uses (flightdeckd whoami)".into(),
    })?;
    let _ = store.set_machine_daemon_identity(&machine.id, &identity.mac_id, &identity.relay_url, &identity.label);
    Ok(identity.mac_id)
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
    match classify(&out.stdout, out.success, out.exit_code, &out.stderr) {
        Ok(_) => match store.set_remote_device_server_generation(&device.device_id, &machine.id, newest, now_ms()) {
            Ok(()) => DeviceServerOutcome::Provisioned { generation: newest },
            Err(e) => DeviceServerOutcome::Failed { reason: format!("provisioned, but recording it failed: {e}") },
        },
        Err(outcome) => outcome,
    }
}

/// Remove a revoked device from one server.
pub async fn remove_device_from_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
    device_id: &str,
) -> DeviceServerOutcome {
    let cmd = format!("{} remove-device --device {}", resolve_daemon_bin_expr("flightdeckd"), shq(device_id));
    let out = match run_ssh_on_machine_stdin(machine, known_hosts, &cmd, b"", None, DEVICE_ROUND_TRIP_TIMEOUT).await {
        Ok(out) => out,
        Err(reason) => return DeviceServerOutcome::Failed { reason },
    };
    match classify(&out.stdout, out.success, out.exit_code, &out.stderr) {
        Ok(_) => match store.clear_remote_device_server(device_id, &machine.id) {
            Ok(()) => DeviceServerOutcome::Removed,
            Err(e) => DeviceServerOutcome::Failed { reason: format!("removed, but recording it failed: {e}") },
        },
        // A server too old to know devices never held one: nothing left to remove.
        Err(DeviceServerOutcome::DaemonTooOld) => {
            let _ = store.clear_remote_device_server(device_id, &machine.id);
            DeviceServerOutcome::Removed
        }
        Err(outcome) => outcome,
    }
}

/// Bring one server up to date: provision every device it holds an older generation
/// of (or none), remove every revoked device still owed. Returns each attempt.
pub async fn sync_devices_on_machine(
    store: &Store,
    known_hosts: Option<&str>,
    machine: &MachineRecord,
) -> Vec<(String, DeviceServerOutcome)> {
    let (devices, servers) = match (store.remote_devices(), store.remote_device_servers()) {
        (Ok(d), Ok(s)) => (d, s),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("[devices] could not read the paired devices: {e}");
            return Vec::new();
        }
    };
    let mut results = Vec::new();
    for device in &devices {
        let newest = device.keys.last().map(|k| k.generation).unwrap_or(0);
        let held = servers
            .iter()
            .find(|s| s.device_id == device.device_id && s.machine_id == machine.id)
            .and_then(|s| s.generation)
            .unwrap_or(0);
        if held < newest {
            let outcome = provision_device_on_machine(store, known_hosts, machine, device).await;
            results.push((device.device_id.clone(), outcome));
        }
    }
    for row in servers.iter().filter(|s| s.machine_id == machine.id && s.remove_pending) {
        let outcome = remove_device_from_machine(store, known_hosts, machine, &row.device_id).await;
        results.push((row.device_id.clone(), outcome));
    }
    results
}

/// [`sync_devices_on_machine`] on every paired server, one after another,
/// recording every outcome into `registry`.
pub async fn sync_devices_on_all_machines(store: &Store, known_hosts: Option<&str>, registry: &DeviceProvisionRegistry) {
    for machine in store.all_machines().unwrap_or_default() {
        for (device_id, outcome) in sync_devices_on_machine(store, known_hosts, &machine).await {
            if let DeviceServerOutcome::Failed { reason } = &outcome {
                eprintln!("[devices] {}: {reason}", machine.label);
            }
            registry.record(&device_id, &machine.id, outcome);
        }
    }
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
        store.machine_by_id(id).unwrap().unwrap()
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

    #[tokio::test]
    async fn sync_provisions_what_a_server_lacks_and_removes_what_is_owed() {
        let _g = PathGuard::install("device-sync");
        let dir = std::env::temp_dir().join(format!("tosse-devsync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let stdin_log = dir.join("stdin");
        std::env::set_var("FAKE_SSH_STDIN_LOG", &stdin_log);
        std::env::set_var("FAKE_SSH_ADDDEVICE_OUT", r#"{"type":"fd_device_added","ok":true,"added":true}"#);
        std::env::set_var("FAKE_SSH_REMOVEDEVICE_OUT", r#"{"type":"fd_device_removed","ok":true,"removed":true}"#);

        let store = Store::open_in_memory().unwrap();
        let m = known_machine(&store, "m1");
        store.insert_remote_device(&device("d1", &[1])).unwrap();
        store.insert_remote_device(&device("gone", &[1])).unwrap();
        store.set_remote_device_server_generation("gone", "m1", 1, 1).unwrap();
        store.delete_remote_device("gone", 2).unwrap();

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
        // The node key went on stdin (the remove ran last, with empty stdin) — and
        // a second sync has nothing left to do.
        let registry = DeviceProvisionRegistry::new();
        sync_devices_on_all_machines(&store, None, &registry).await;
        assert!(registry.all().is_empty());
        let _ = m;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_old_daemon_is_reported_and_retried_next_time() {
        let _g = PathGuard::install("device-old");
        std::env::set_var("FAKE_SSH_ADDDEVICE_EXIT", "2");
        std::env::set_var("FAKE_SSH_ADDDEVICE_ERR", "error: unrecognized subcommand 'add-device'\n");
        let store = Store::open_in_memory().unwrap();
        let m = known_machine(&store, "m1");
        store.insert_remote_device(&device("d1", &[1])).unwrap();
        let results = sync_devices_on_machine(&store, None, &m).await;
        assert_eq!(results, vec![("d1".to_string(), DeviceServerOutcome::DaemonTooOld)]);
        assert!(store.remote_device_servers().unwrap().is_empty(), "nothing recorded: the next sync retries");
    }
}
