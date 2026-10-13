//! Phones paired on the Tarmac sealed channel (`docs/tarmac-sealed-channel.md`),
//! as THIS Mac's relay connection sees them: the live book the relay checks a
//! hello against, the sealed sessions of the current link, and the side effects
//! a phone's own sealed calls trigger.
//!
//! Like the rest of the hub, nothing here touches the store: the IPC layer loads
//! the book (`ControlHub::set_devices`) and persists what changes, through the
//! [`DeviceSink`] for what a PHONE asks (forget, push, renew) and directly for
//! what the Settings UI does (pair, revoke).
//!
//! This Mac is the devices' issuer: it holds each device's master secret `S`,
//! derives its own node key from it (`S.node_key(mac_id)`), and is the only node
//! that renews keys (`renew_device`).

use std::time::Instant;

use serde_json::{json, Value};
use tarmac_e2e::keys::{DeviceId, DeviceSecret};
use tarmac_e2e::node::{KeyGeneration, Lookup};
use tarmac_e2e::push::PushPrefs;
use tokio_tungstenite::tungstenite::Message;

use super::ControlHub;

pub use tarmac_e2e::keys::{KEY_LIFETIME_MS, RENEW_AFTER_MS};

/// One paired device in the live book.
#[derive(Debug, Clone)]
pub struct LiveDevice {
    pub device_id: String,
    pub label: String,
    pub relay_token: String,
    /// Oldest generation first; at most two.
    pub keys: Vec<LiveKey>,
    pub push: Vec<LivePush>,
}

/// One generation of a device's master secret.
#[derive(Debug, Clone)]
pub struct LiveKey {
    pub generation: u32,
    pub secret: DeviceSecret,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
}

impl LiveKey {
    /// When the phone should ask for the next generation.
    pub fn renew_after_ms(&self) -> i64 {
        self.issued_at_ms + RENEW_AFTER_MS
    }
}

/// A push subscription a device registered with this Mac.
#[derive(Debug, Clone)]
pub struct LivePush {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub prefs: PushPrefs,
}

/// What a phone's sealed calls change durably, implemented by the IPC layer (it
/// owns the store and the server provisioning). Every method answers whether it
/// was persisted: the phone is only told "done" when it is.
pub trait DeviceSink: Send + Sync {
    /// The device just opened a sealed session with this Mac.
    fn device_seen(&self, device_id: &str, at_ms: i64);
    /// The phone unpaired itself: delete the device, queue its relay-token
    /// revocation and its removal from every server.
    fn forget_device(&self, device_id: &str) -> Result<(), String>;
    /// Store (or refresh) a push subscription.
    fn register_push(&self, device_id: &str, push: &LivePush) -> Result<(), String>;
    /// Set the prefs of every push subscription of the device.
    fn set_push_prefs(&self, device_id: &str, prefs: PushPrefs) -> Result<(), String>;
    /// Drop one push subscription, or all of them. Returns how many went.
    fn unregister_push(&self, device_id: &str, endpoint: Option<&str>) -> Result<usize, String>;
    /// Mint, persist and start provisioning the device's next key generation.
    fn renew_device(&self, device_id: &str) -> Result<LiveKey, String>;
}

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ControlHub {
    /// Install the [`DeviceSink`] (once, at app setup).
    pub fn set_device_sink(&self, sink: std::sync::Arc<dyn DeviceSink>) {
        let _ = self.device_sink.set(sink);
    }

    pub(crate) fn device_sink(&self) -> Result<&std::sync::Arc<dyn DeviceSink>, String> {
        self.device_sink.get().ok_or_else(|| "the app is still starting — try again in a moment".to_string())
    }

    /// Replace the whole book (at launch, from the store).
    pub fn set_devices(&self, devices: Vec<LiveDevice>) {
        *self.devices.lock().expect("devices lock") = devices;
    }

    /// The book as it is (for the Settings read-back and tests).
    pub fn devices(&self) -> Vec<LiveDevice> {
        self.devices.lock().expect("devices lock").clone()
    }

    /// Add a freshly paired device and authorize its relay token on the live link
    /// (the next connect authorizes it anyway).
    pub fn add_device_live(&self, device: LiveDevice) {
        let frame = json!({"type": "authorize_phone", "phoneToken": device.relay_token, "label": device.label});
        {
            let mut book = self.devices.lock().expect("devices lock");
            book.retain(|d| d.device_id != device.device_id);
            book.push(device);
        }
        self.send_relay_live(frame);
    }

    /// Drop a device from the book, close its sealed sessions and revoke its relay
    /// token: on the live link now, and on every later connect of THIS run (added to
    /// the config's revocations, so a link that is down meanwhile — or reconnecting
    /// right now — still sends it). The caller has also queued it durably
    /// (`pending_relay_phone_revocations`) for the next launch. `relay_token` is the
    /// caller's copy, used when the book no longer has the device. Returns the token
    /// revoked, `None` if neither knows it.
    pub fn remove_device_live(&self, device_id: &str, relay_token: Option<&str>) -> Option<String> {
        let removed = {
            let mut book = self.devices.lock().expect("devices lock");
            book.iter().position(|d| d.device_id == device_id).map(|i| book.remove(i))
        };
        let token = removed.map(|d| d.relay_token).or_else(|| relay_token.map(str::to_string))?;
        {
            let mut remote = self.remote.lock().expect("remote lock");
            if !remote.cfg.revoke_phone_tokens.contains(&token) {
                remote.cfg.revoke_phone_tokens.push(token.clone());
            }
        }
        if let Ok(id) = DeviceId::from_b64(device_id) {
            self.channel.lock().expect("channel lock").drop_device(&id);
        }
        self.send_relay_live(json!({"type": "revoke_phone", "phoneToken": token}));
        Some(token)
    }

    /// Record a new key generation in the book (two kept).
    pub fn add_device_key_live(&self, device_id: &str, key: LiveKey) {
        let mut book = self.devices.lock().expect("devices lock");
        if let Some(d) = book.iter_mut().find(|d| d.device_id == device_id) {
            d.keys.retain(|k| k.generation != key.generation);
            d.keys.push(key);
            d.keys.sort_by_key(|k| k.generation);
            let excess = d.keys.len().saturating_sub(2);
            d.keys.drain(..excess);
        }
    }

    /// The key generations `device_id` has on THIS node, for a hello.
    pub(crate) fn device_lookup(&self, device_id: &DeviceId) -> Lookup {
        let id = device_id.to_b64();
        let mac_id = self.remote.lock().expect("remote lock").cfg.mac_id.clone();
        let book = self.devices.lock().expect("devices lock");
        match book.iter().find(|d| d.device_id == id) {
            None => Lookup::Unknown,
            Some(d) => Lookup::Known(
                d.keys
                    .iter()
                    .map(|k| KeyGeneration {
                        generation: k.generation,
                        key: k.secret.node_key(&mac_id),
                        expires_at_ms: k.expires_at_ms.max(0) as u64,
                    })
                    .collect(),
            ),
        }
    }

    /// The relay tokens to authorize on every connect, with their labels.
    pub(crate) fn device_relay_tokens(&self) -> Vec<(String, String)> {
        self.devices
            .lock()
            .expect("devices lock")
            .iter()
            .map(|d| (d.relay_token.clone(), d.label.clone()))
            .collect()
    }

    /// The device's label and the key generation `generation`, for `ready`.
    pub(crate) fn device_key(&self, device_id: &DeviceId, generation: u32) -> Option<(String, LiveKey)> {
        let id = device_id.to_b64();
        let book = self.devices.lock().expect("devices lock");
        let d = book.iter().find(|d| d.device_id == id)?;
        let k = d.keys.iter().find(|k| k.generation == generation)?;
        Some((d.label.clone(), k.clone()))
    }

    /// The device's newest key generation.
    pub(crate) fn newest_device_key(&self, device_id: &str) -> Option<LiveKey> {
        let book = self.devices.lock().expect("devices lock");
        book.iter().find(|d| d.device_id == device_id)?.keys.last().cloned()
    }

    /// Every push subscription that wants `state`: (endpoint, p256dh, auth).
    pub(crate) fn push_targets(&self, state: tarmac_e2e::push::PushState) -> Vec<(String, String, String)> {
        self.devices
            .lock()
            .expect("devices lock")
            .iter()
            .flat_map(|d| d.push.iter())
            .filter(|p| p.prefs.wants(state))
            .map(|p| (p.endpoint.clone(), p.p256dh.clone(), p.auth.clone()))
            .collect()
    }

    /// Apply `edit` to a device's push subscriptions in the book (oldest first), then
    /// keep at most [`tarmac_e2e::push::MAX_PUSH_SUBSCRIPTIONS`] — the newest, the same
    /// rule as the store and `flightdeckd`.
    pub(crate) fn edit_device_push(&self, device_id: &str, edit: impl FnOnce(&mut Vec<LivePush>)) {
        let mut book = self.devices.lock().expect("devices lock");
        if let Some(d) = book.iter_mut().find(|d| d.device_id == device_id) {
            edit(&mut d.push);
            let excess = d.push.len().saturating_sub(tarmac_e2e::push::MAX_PUSH_SUBSCRIPTIONS);
            d.push.drain(..excess);
        }
    }

    /// Queue one relay-level frame on the live link, if any. Never retried here:
    /// the next connect replays the authorizations and queued revocations.
    fn send_relay_live(&self, frame: Value) {
        if let Some(tx) = self.remote_out.lock().expect("remote_out lock").as_ref() {
            let _ = tx.send(Message::Text(frame.to_string()));
        }
    }

    /// Run a hello for socket `cid` against the book. Returns the frame to send back.
    pub(crate) fn on_device_hello(&self, cid: &str, frame: &Value) -> Result<(Value, Option<DeviceId>), String> {
        let device_id = frame
            .get("d")
            .and_then(Value::as_str)
            .and_then(|d| DeviceId::from_b64(d).ok())
            .ok_or_else(|| "malformed e2e_hello".to_string())?;
        // Resolved before taking `channel` (lock order: devices, then channel).
        let lookup = self.device_lookup(&device_id);
        let reply = self
            .channel
            .lock()
            .expect("channel lock")
            .on_hello(cid, frame, |_| lookup, now_ms().max(0) as u64, Instant::now())
            .map_err(|e| e.to_string())?;
        let accepted = reply["type"] == "e2e_accept";
        Ok((reply, accepted.then_some(device_id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(generation: u32, issued_at_ms: i64) -> LiveKey {
        LiveKey {
            generation,
            secret: DeviceSecret::from_bytes([generation as u8; 32]),
            issued_at_ms,
            expires_at_ms: issued_at_ms + KEY_LIFETIME_MS,
        }
    }

    fn device(n: u8) -> LiveDevice {
        LiveDevice {
            device_id: DeviceId::from_bytes([n; 16]).to_b64(),
            label: format!("phone {n}"),
            relay_token: format!("rt-{n}"),
            keys: vec![key(1, 1_000)],
            push: vec![],
        }
    }

    #[test]
    fn the_book_resolves_hellos_with_this_macs_own_node_key() {
        let hub = ControlHub::new();
        hub.remote.lock().unwrap().cfg.mac_id = "mac-1".into();
        hub.set_devices(vec![device(1)]);
        match hub.device_lookup(&DeviceId::from_bytes([1; 16])) {
            Lookup::Known(gens) => {
                assert_eq!(gens.len(), 1);
                assert_eq!(gens[0].key, DeviceSecret::from_bytes([1; 32]).node_key("mac-1"));
            }
            Lookup::Unknown => panic!("known device"),
        }
        assert!(matches!(hub.device_lookup(&DeviceId::from_bytes([9; 16])), Lookup::Unknown));
    }

    #[test]
    fn key_generations_are_capped_at_two_newest() {
        let hub = ControlHub::new();
        hub.set_devices(vec![device(1)]);
        let id = device(1).device_id;
        hub.add_device_key_live(&id, key(2, 2_000));
        hub.add_device_key_live(&id, key(3, 3_000));
        let gens: Vec<u32> = hub.devices()[0].keys.iter().map(|k| k.generation).collect();
        assert_eq!(gens, vec![2, 3]);
        assert_eq!(hub.newest_device_key(&id).unwrap().generation, 3);
        assert_eq!(key(1, 0).renew_after_ms(), RENEW_AFTER_MS);
    }

    #[test]
    fn removing_a_device_revokes_its_relay_token_on_every_later_connect() {
        let hub = ControlHub::new();
        hub.set_devices(vec![device(1), device(2)]);
        assert_eq!(hub.remove_device_live(&device(1).device_id, None).as_deref(), Some("rt-1"));
        assert_eq!(hub.remove_device_live(&device(1).device_id, None), None);
        // Already gone from the book (forgotten by the store first): the caller's copy.
        assert_eq!(hub.remove_device_live(&device(1).device_id, Some("rt-1")).as_deref(), Some("rt-1"));
        assert_eq!(hub.device_relay_tokens(), vec![("rt-2".to_string(), "phone 2".to_string())]);
        // With no link up, the revocation still rides the next connect, once.
        assert_eq!(hub.remote.lock().unwrap().cfg.revoke_phone_tokens, vec!["rt-1".to_string()]);
    }

    #[test]
    fn the_live_book_keeps_the_newest_push_subscriptions_only() {
        let hub = ControlHub::new();
        hub.set_devices(vec![device(1)]);
        let id = device(1).device_id;
        for n in 0..tarmac_e2e::push::MAX_PUSH_SUBSCRIPTIONS + 2 {
            hub.edit_device_push(&id, |subs| {
                subs.push(LivePush {
                    endpoint: format!("https://p/{n}"),
                    p256dh: String::new(),
                    auth: String::new(),
                    prefs: PushPrefs::default(),
                })
            });
        }
        let kept: Vec<String> = hub.devices()[0].push.iter().map(|p| p.endpoint.clone()).collect();
        assert_eq!(kept.len(), tarmac_e2e::push::MAX_PUSH_SUBSCRIPTIONS);
        assert_eq!(kept[0], "https://p/2");
    }

    #[test]
    fn push_targets_follow_each_subscriptions_prefs() {
        use tarmac_e2e::push::PushState;
        let hub = ControlHub::new();
        let mut d = device(1);
        d.push = vec![
            LivePush { endpoint: "https://a".into(), p256dh: "p".into(), auth: "x".into(), prefs: PushPrefs::default() },
            LivePush {
                endpoint: "https://b".into(),
                p256dh: "p".into(),
                auth: "x".into(),
                prefs: PushPrefs { question: true, error: true, review: false },
            },
        ];
        hub.set_devices(vec![d]);
        assert_eq!(hub.push_targets(PushState::Review).len(), 1);
        assert_eq!(hub.push_targets(PushState::Question).len(), 2);
    }
}
