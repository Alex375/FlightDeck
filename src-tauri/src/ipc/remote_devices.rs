//! Settings ↔ phones paired on the Tarmac sealed channel
//! (`docs/tarmac-sealed-channel.md` §7): pair one, list them, revoke one, retire
//! the legacy shared pairing — plus the [`DeviceSink`] a phone's own sealed calls
//! (forget, push, renew) persist through.
//!
//! This Mac is every device's issuer: it mints the device id, relay token and
//! master secret, keeps the secret (SQLite, like the mac token), shows it once in
//! the pairing QR's fragment, and provisions each paired server with that server's
//! own node key (`appmcp::device_provision`).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tarmac_e2e::keys::{random_relay_token, DeviceId, DeviceSecret};
use tarmac_e2e::push::PushPrefs;
use tarmac_e2e::rand::SystemRandom;
use tauri::Manager;

use crate::appmcp::device_provision::{sync_devices_on_all_machines, DeviceProvisionRegistry, DeviceServerOutcome};
use crate::appmcp::devices::{now_ms, DeviceSink, LiveDevice, LiveKey, LivePush, KEY_LIFETIME_MS, RENEW_AFTER_MS};
use crate::appmcp::ControlHub;
use crate::store::{RemoteDevice, RemoteDeviceKey, RemoteDevicePush, Store};

/// A device's push prefs as stored (`{question, error, review}` JSON).
fn prefs_from_json(text: &str) -> PushPrefs {
    PushPrefs::default().merged(&serde_json::from_str::<Value>(text).unwrap_or(Value::Null))
}

/// The store's device as the relay's live book holds it. A corrupt secret (never
/// written by this code) drops that generation, logged, rather than the whole book.
fn to_live(d: &RemoteDevice) -> LiveDevice {
    let keys = d
        .keys
        .iter()
        .filter_map(|k| match DeviceSecret::from_b64(&k.secret) {
            Ok(secret) => Some(LiveKey {
                generation: k.generation,
                secret,
                issued_at_ms: k.issued_at,
                expires_at_ms: k.expires_at,
            }),
            Err(e) => {
                eprintln!("[devices] {}: key generation {} is unreadable ({e}) — skipped", d.device_id, k.generation);
                None
            }
        })
        .collect();
    let push = d
        .push
        .iter()
        .map(|p| LivePush {
            endpoint: p.endpoint.clone(),
            p256dh: p.p256dh.clone(),
            auth: p.auth.clone(),
            prefs: prefs_from_json(&p.prefs),
        })
        .collect();
    LiveDevice { device_id: d.device_id.clone(), label: d.label.clone(), relay_token: d.relay_token.clone(), keys, push }
}

/// Every paired device, as the relay's live book — loaded at launch.
pub fn load_live_devices(store: &Store) -> Vec<LiveDevice> {
    match store.remote_devices() {
        Ok(devices) => devices.iter().map(to_live).collect(),
        Err(e) => {
            eprintln!("[devices] could not load the paired phones: {e}");
            Vec::new()
        }
    }
}

/// Bring every paired server up to date with the devices, in the background.
pub(crate) fn spawn_device_sync(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let store = app.state::<Store>();
        let known_hosts = crate::ipc::commands::remote_known_hosts_path(&app);
        let registry = (*app.state::<Arc<DeviceProvisionRegistry>>()).clone();
        sync_devices_on_all_machines(&store, known_hosts.as_deref(), &registry).await;
    });
}

/// One paired phone, as Settings lists it. Never a secret nor its relay token.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RemoteDeviceView {
    pub device_id: String,
    pub label: String,
    pub added_at: i64,
    /// Last sealed session with THIS Mac; `None` = never connected yet.
    pub last_seen_at: Option<i64>,
    /// The newest key generation, when it stops being accepted, and when the
    /// phone asks for the next one.
    pub generation: u32,
    pub expires_at: i64,
    pub renew_after: i64,
    pub push_subscriptions: u32,
    /// Where the device stands on each paired server.
    pub servers: Vec<DeviceServerView>,
}

/// A device on one paired server.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DeviceServerView {
    pub machine_id: String,
    pub machine_label: String,
    /// The newest generation that server confirmed; `None` = not provisioned yet.
    pub generation: Option<u32>,
    /// The last attempt this run, if any (a failure's reason, a too-old daemon).
    pub last_outcome: Option<DeviceServerOutcome>,
}

/// A revoked device a server has not confirmed removing yet (retried automatically).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PendingDeviceRemoval {
    pub device_id: String,
    pub machine_id: String,
    pub machine_label: String,
    pub last_outcome: Option<DeviceServerOutcome>,
}

/// Settings' read-back of the sealed-channel phones.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RemoteDevicesStatus {
    pub devices: Vec<RemoteDeviceView>,
    pub pending_removals: Vec<PendingDeviceRemoval>,
}

/// A freshly paired phone: the link and QR it scans, shown ONCE.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PairedDevice {
    pub device_id: String,
    pub label: String,
    pub pairing_url: String,
    pub pairing_qr_svg: Option<String>,
    pub expires_at: i64,
}

fn devices_status(store: &Store, registry: &DeviceProvisionRegistry) -> Result<RemoteDevicesStatus, String> {
    let devices = store.remote_devices().map_err(|e| e.to_string())?;
    let servers = store.remote_device_servers().map_err(|e| e.to_string())?;
    let machines = store.all_machines().map_err(|e| e.to_string())?;
    let attempts = registry.all();
    let last = |device: &str, machine: &str| {
        attempts.iter().find(|a| a.device_id == device && a.machine_id == machine).map(|a| a.outcome.clone())
    };
    let label_of = |machine: &str| {
        machines.iter().find(|m| m.id == machine).map(|m| m.label.clone()).unwrap_or_else(|| machine.to_string())
    };
    let views = devices
        .iter()
        .map(|d| {
            let newest = d.keys.last();
            RemoteDeviceView {
                device_id: d.device_id.clone(),
                label: d.label.clone(),
                added_at: d.added_at,
                last_seen_at: d.last_seen_at,
                generation: newest.map(|k| k.generation).unwrap_or(0),
                expires_at: newest.map(|k| k.expires_at).unwrap_or(0),
                renew_after: newest.map(|k| k.issued_at + RENEW_AFTER_MS).unwrap_or(0),
                push_subscriptions: d.push.len() as u32,
                servers: machines
                    .iter()
                    .map(|m| DeviceServerView {
                        machine_id: m.id.clone(),
                        machine_label: m.label.clone(),
                        generation: servers
                            .iter()
                            .find(|s| s.device_id == d.device_id && s.machine_id == m.id)
                            .and_then(|s| s.generation),
                        last_outcome: last(&d.device_id, &m.id),
                    })
                    .collect(),
            }
        })
        .collect();
    let pending_removals = servers
        .iter()
        .filter(|s| s.remove_pending)
        .map(|s| PendingDeviceRemoval {
            device_id: s.device_id.clone(),
            machine_id: s.machine_id.clone(),
            machine_label: label_of(&s.machine_id),
            last_outcome: last(&s.device_id, &s.machine_id),
        })
        .collect();
    Ok(RemoteDevicesStatus { devices: views, pending_removals })
}

/// The paired phones and where each stands on every server.
#[tauri::command]
#[specta::specta]
pub fn list_remote_devices(app: tauri::AppHandle) -> Result<RemoteDevicesStatus, String> {
    let registry = (*app.state::<Arc<DeviceProvisionRegistry>>()).clone();
    devices_status(&app.state::<Store>(), &registry)
}

/// A device label as typed: trimmed, at most 64 characters, no control
/// characters; empty means "Phone".
fn clean_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.chars().any(char::is_control) {
        return Err("The phone's name cannot contain control characters.".into());
    }
    if label.chars().count() > 64 {
        return Err("The phone's name is limited to 64 characters.".into());
    }
    Ok(if label.is_empty() { "Phone".to_string() } else { label.to_string() })
}

/// Mint a device (id, relay token, master secret, first key generation) and record it.
pub(crate) fn mint_device(store: &Store, label: &str, now: i64) -> Result<(RemoteDevice, DeviceSecret), String> {
    let rng = SystemRandom::new();
    let fail = |e: tarmac_e2e::Error| e.to_string();
    let secret = DeviceSecret::generate(&rng).map_err(fail)?;
    let device = RemoteDevice {
        device_id: DeviceId::generate(&rng).map_err(fail)?.to_b64(),
        label: clean_label(label)?,
        relay_token: random_relay_token(&rng).map_err(fail)?,
        added_at: now,
        last_seen_at: None,
        keys: vec![RemoteDeviceKey { generation: 1, secret: secret.to_b64(), issued_at: now, expires_at: now + KEY_LIFETIME_MS }],
        push: vec![],
    };
    store.insert_remote_device(&device).map_err(|e| e.to_string())?;
    Ok((device, secret))
}

/// Pair a new phone: mint it, authorize it on the live relay link, provision every
/// paired server in the background, and return the link + QR to scan (shown once —
/// it carries the device's master secret).
#[tauri::command]
#[specta::specta]
pub async fn pair_remote_device(app: tauri::AppHandle, label: String) -> Result<PairedDevice, String> {
    let cfg = crate::ipc::commands::load_remote_config(&app.state::<Store>());
    if !cfg.enabled {
        return Err("Turn on “Reach your agents from your phone” first.".into());
    }
    let (device, secret) = mint_device(&app.state::<Store>(), &label, now_ms())?;
    let hub = (*app.state::<Arc<ControlHub>>()).clone();
    hub.add_device_live(to_live(&device));
    spawn_device_sync(&app);
    let url = crate::appmcp::relay::pairing_url_v2(
        &cfg.relay_url,
        &cfg.mac_id,
        &device.device_id,
        &device.relay_token,
        &secret.to_b64(),
        1,
    );
    Ok(PairedDevice {
        device_id: device.device_id.clone(),
        label: device.label.clone(),
        pairing_qr_svg: crate::appmcp::relay::qr_svg(&url),
        pairing_url: url,
        expires_at: device.keys[0].expires_at,
    })
}

/// Revoke one phone: forgotten here (keys, pushes), its relay token revoked (now on
/// the live link, and durably queued for the next connect), its sealed sessions
/// closed, and its removal owed by every server it was provisioned on.
pub(crate) fn revoke_device(store: &Store, hub: &ControlHub, device_id: &str) -> Result<(), String> {
    let device = store
        .delete_remote_device(device_id, now_ms())
        .map_err(|e| e.to_string())?
        .ok_or("This phone is not paired with this Mac.")?;
    store.queue_relay_phone_revocation(&device.relay_token, now_ms()).map_err(|e| e.to_string())?;
    hub.remove_device_live(device_id);
    Ok(())
}

/// Settings → Revoke on one phone.
#[tauri::command]
#[specta::specta]
pub fn revoke_remote_device(app: tauri::AppHandle, device_id: String) -> Result<(), String> {
    let hub = (*app.state::<Arc<ControlHub>>()).clone();
    revoke_device(&app.state::<Store>(), &hub, &device_id)?;
    spawn_device_sync(&app);
    Ok(())
}

/// Settings → Retire the legacy (unencrypted, shared-token) pairing: revoked on the
/// relay and on every server, never minted again, and from then on this Mac takes
/// no cleartext phone frame. Returns the post-apply status.
#[tauri::command]
#[specta::specta]
pub async fn retire_legacy_pairing(app: tauri::AppHandle) -> Result<crate::appmcp::RemoteStatus, String> {
    let hub = (*app.state::<Arc<ControlHub>>()).clone();
    let (old, cfg) = {
        let store = app.state::<Store>();
        let old = crate::ipc::commands::retire_legacy_phone_token(&store)?;
        (old, crate::ipc::commands::load_remote_config(&store))
    };
    hub.apply_remote(cfg).await;
    if let Some(token) = old {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let store = app2.state::<Store>();
            let known_hosts = crate::ipc::commands::remote_known_hosts_path(&app2);
            let registry = (*app2.state::<Arc<crate::appmcp::provision::RevokeRegistry>>()).clone();
            let results =
                crate::appmcp::provision::revoke_phone_on_all_machines(&store, known_hosts.as_deref(), &token).await;
            for (machine_id, outcome) in results {
                registry.record(&machine_id, outcome);
            }
        });
    }
    Ok(hub.remote_status())
}

/// Settings → Retry: bring every server up to date now, then read back.
#[tauri::command]
#[specta::specta]
pub async fn retry_device_provisioning(app: tauri::AppHandle) -> Result<RemoteDevicesStatus, String> {
    let registry = (*app.state::<Arc<DeviceProvisionRegistry>>()).clone();
    let known_hosts = crate::ipc::commands::remote_known_hosts_path(&app);
    {
        let store = app.state::<Store>();
        sync_devices_on_all_machines(&store, known_hosts.as_deref(), &registry).await;
    }
    devices_status(&app.state::<Store>(), &registry)
}

/// The next key generation of a device, persisted (two kept). Pure store work, so
/// it is tested without an app.
pub(crate) fn renew_device_in_store(store: &Store, device_id: &str, now: i64) -> Result<LiveKey, String> {
    let device = store
        .remote_devices()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|d| d.device_id == device_id)
        .ok_or("This phone is not paired with this Mac.")?;
    let generation = device.keys.last().map(|k| k.generation).unwrap_or(0) + 1;
    let secret = DeviceSecret::generate(&SystemRandom::new()).map_err(|e| e.to_string())?;
    let key = RemoteDeviceKey { generation, secret: secret.to_b64(), issued_at: now, expires_at: now + KEY_LIFETIME_MS };
    store.add_remote_device_key(device_id, &key).map_err(|e| e.to_string())?;
    Ok(LiveKey { generation, secret, issued_at_ms: now, expires_at_ms: key.expires_at })
}

/// A phone's own sealed calls, persisted in the store (and, for what changes a
/// server's books, followed by a background server sync).
pub struct DeviceStoreSink {
    pub app: tauri::AppHandle,
}

impl DeviceSink for DeviceStoreSink {
    fn device_seen(&self, device_id: &str, at_ms: i64) {
        if let Err(e) = self.app.state::<Store>().set_remote_device_last_seen(device_id, at_ms) {
            eprintln!("[devices] could not record that {device_id} connected: {e}");
        }
    }

    fn forget_device(&self, device_id: &str) -> Result<(), String> {
        let store = self.app.state::<Store>();
        let device = store
            .delete_remote_device(device_id, now_ms())
            .map_err(|e| e.to_string())?
            .ok_or("This phone is not paired with this Mac.")?;
        // The hub revokes it on the live link right after answering; this makes
        // sure a link that is down meanwhile still gets it on the next connect.
        store.queue_relay_phone_revocation(&device.relay_token, now_ms()).map_err(|e| e.to_string())?;
        spawn_device_sync(&self.app);
        Ok(())
    }

    fn register_push(&self, device_id: &str, push: &LivePush) -> Result<(), String> {
        let record = RemoteDevicePush {
            endpoint: push.endpoint.clone(),
            p256dh: push.p256dh.clone(),
            auth: push.auth.clone(),
            prefs: push.prefs.to_json().to_string(),
        };
        self.app.state::<Store>().upsert_remote_device_push(device_id, &record).map_err(|e| e.to_string())
    }

    fn set_push_prefs(&self, device_id: &str, prefs: PushPrefs) -> Result<(), String> {
        self.app
            .state::<Store>()
            .set_remote_device_push_prefs(device_id, &prefs.to_json().to_string())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn unregister_push(&self, device_id: &str, endpoint: Option<&str>) -> Result<usize, String> {
        self.app.state::<Store>().delete_remote_device_push(device_id, endpoint).map_err(|e| e.to_string())
    }

    fn renew_device(&self, device_id: &str) -> Result<LiveKey, String> {
        let key = renew_device_in_store(&self.app.state::<Store>(), device_id, now_ms())?;
        spawn_device_sync(&self.app);
        Ok(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_device_is_stored_with_a_90_day_first_generation() {
        let store = Store::open_in_memory().unwrap();
        let (device, secret) = mint_device(&store, "  Alex's iPhone ", 1_000).unwrap();
        assert_eq!(device.label, "Alex's iPhone");
        assert_eq!(device.keys[0].generation, 1);
        assert_eq!(device.keys[0].expires_at, 1_000 + KEY_LIFETIME_MS);
        assert_eq!(device.keys[0].secret, secret.to_b64());
        assert_eq!(store.remote_devices().unwrap(), vec![device.clone()]);
        let live = to_live(&device);
        assert_eq!(live.keys[0].secret, secret);
        assert_eq!(mint_device(&store, "", 1).unwrap().0.label, "Phone");
        assert!(mint_device(&store, &"x".repeat(65), 1).is_err());
        assert!(mint_device(&store, "a\u{7}b", 1).is_err());
    }

    #[test]
    fn revoking_queues_the_relay_token_and_empties_the_book() {
        let store = Store::open_in_memory().unwrap();
        let hub = ControlHub::new();
        let (device, _) = mint_device(&store, "iPhone", 1).unwrap();
        hub.set_devices(load_live_devices(&store));
        revoke_device(&store, &hub, &device.device_id).unwrap();
        assert!(store.remote_devices().unwrap().is_empty());
        assert_eq!(store.pending_relay_phone_revocations().unwrap(), vec![device.relay_token.clone()]);
        assert!(hub.devices().is_empty());
        assert!(revoke_device(&store, &hub, &device.device_id).is_err());
    }

    #[test]
    fn renewing_adds_the_next_generation_and_keeps_two() {
        let store = Store::open_in_memory().unwrap();
        let (device, _) = mint_device(&store, "iPhone", 1).unwrap();
        let k2 = renew_device_in_store(&store, &device.device_id, 50).unwrap();
        let k3 = renew_device_in_store(&store, &device.device_id, 60).unwrap();
        assert_eq!((k2.generation, k3.generation), (2, 3));
        assert_eq!(k3.expires_at_ms, 60 + KEY_LIFETIME_MS);
        let gens: Vec<u32> = store.remote_devices().unwrap()[0].keys.iter().map(|k| k.generation).collect();
        assert_eq!(gens, vec![2, 3]);
        assert!(renew_device_in_store(&store, "ghost", 1).is_err());
    }

    #[test]
    fn the_status_lists_every_server_and_the_removals_still_owed() {
        let store = Store::open_in_memory().unwrap();
        let registry = DeviceProvisionRegistry::new();
        let m = crate::appmcp::provision::test_support::machine("m1");
        store.upsert_machine(&m).unwrap();
        let (keep, _) = mint_device(&store, "iPhone", 1).unwrap();
        let (gone, _) = mint_device(&store, "Pixel", 2).unwrap();
        store.set_remote_device_server_generation(&keep.device_id, "m1", 1, 3).unwrap();
        store.set_remote_device_server_generation(&gone.device_id, "m1", 1, 3).unwrap();
        store.delete_remote_device(&gone.device_id, 4).unwrap();
        registry.record(&gone.device_id, "m1", DeviceServerOutcome::Failed { reason: "unreachable".into() });

        let status = devices_status(&store, &registry).unwrap();
        assert_eq!(status.devices.len(), 1);
        assert_eq!(status.devices[0].servers[0].generation, Some(1));
        assert_eq!(status.devices[0].renew_after, 1 + RENEW_AFTER_MS);
        assert_eq!(status.pending_removals.len(), 1);
        assert_eq!(status.pending_removals[0].machine_label, "m1");
        assert_eq!(
            status.pending_removals[0].last_outcome,
            Some(DeviceServerOutcome::Failed { reason: "unreachable".into() })
        );
        // Nothing secret in what Settings reads.
        let text = serde_json::to_string(&status).unwrap();
        assert!(!text.contains(&keep.relay_token) && !text.contains(&keep.keys[0].secret));
    }
}
