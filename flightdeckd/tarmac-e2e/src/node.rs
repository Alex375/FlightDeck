//! A node's side of the sealed channel: one [`Session`] per phone socket,
//! keyed by the relay's connection id (`_cid`).
//!
//! The node never learns that a phone left except through the relay's
//! `phone_left` frame, so the table is also capped (oldest first). Handshakes
//! cost an ECDH each and anyone reaching the relay can send one, so they are
//! rate-limited per socket and in total.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use ring::rand::SystemRandom;
use serde_json::Value;

use crate::handshake::{node_accept, Hello, RejectReason};
use crate::keys::{DeviceId, NodeKey};
use crate::session::{Sealed, Session};
use crate::Error;

/// The answer to a cleartext `rpc` on a node that takes no cleartext (no legacy
/// phone authorized). The PWA shows it verbatim.
pub const ENCRYPTION_REQUIRED: &str = "this machine only accepts encrypted connections — re-pair your phone";

/// What a node's sealed `ready` says about the device on that socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyDevice {
    /// The device's label on this node.
    pub label: String,
    /// The key generation the socket handshook with.
    pub generation: u32,
    /// When that generation stops being accepted (ms since the Unix epoch).
    pub expires_at_ms: i64,
    /// When the phone should ask its issuer for the next one.
    pub renew_after_ms: i64,
}

/// The sealed `ready` frame: `{type:"ready", label, device:{label, generation,
/// expires_at_ms, renew_after_ms}, caps}` (every device field null when unknown).
pub fn ready_frame(node_label: &str, device: Option<&ReadyDevice>, caps: &[&str]) -> Value {
    serde_json::json!({
        "type": "ready",
        "label": node_label,
        "device": {
            "label": device.map(|d| d.label.clone()),
            "generation": device.map(|d| d.generation),
            "expires_at_ms": device.map(|d| d.expires_at_ms),
            "renew_after_ms": device.map(|d| d.renew_after_ms),
        },
        "caps": caps,
    })
}

/// `frame` targeted at socket `cid`.
pub fn to_socket(mut frame: Value, cid: &str) -> Value {
    frame["_cid"] = Value::String(cid.to_owned());
    frame
}

/// The cleartext answer to a sealed frame on a socket with no session here (never
/// opened, or just dropped): the phone handshakes again. Unauthenticated, like every
/// reject.
pub fn no_session_frame(cid: &str) -> Value {
    to_socket(RejectReason::NoSession.to_frame(), cid)
}

/// The cleartext refusal of a cleartext `rpc` on a node that takes none.
pub fn encryption_required_frame(rpc: &Value, cid: Option<&str>) -> Value {
    let mut f = serde_json::json!({
        "type": "rpc_error",
        "id": rpc.get("id").cloned().unwrap_or(Value::Null),
        "error": ENCRYPTION_REQUIRED,
    });
    if let Some(c) = cid {
        f["_cid"] = Value::String(c.to_owned());
    }
    f
}

/// Most live sessions a node keeps (the relay allows 8 phones per node).
pub const MAX_SESSIONS: usize = 16;
/// Least time between two handshakes on the same socket.
pub const HELLO_INTERVAL: Duration = Duration::from_secs(2);
/// How long a session that never proved itself (no frame opened under its key) is
/// kept. Anyone who saw a hello can replay it and get an accept: such entries must
/// neither linger nor push out sessions that did prove themselves.
pub const UNPROVEN_TTL: Duration = Duration::from_secs(10);
/// Most handshakes a node runs per second, all sockets together.
pub const HELLOS_PER_SECOND: u32 = 10;

/// What the node knows about a device's key under one generation.
#[derive(Debug, Clone)]
pub struct KeyGeneration {
    /// The generation number (`g`, ≥ 1).
    pub generation: u32,
    /// This node's key for the device under that generation.
    pub key: NodeKey,
    /// When the generation stops being accepted (ms since the Unix epoch).
    pub expires_at_ms: u64,
}

/// The answer of a node's device registry to a hello.
#[derive(Debug, Clone)]
pub enum Lookup {
    /// The device has these generations on this node (≤ 2).
    Known(Vec<KeyGeneration>),
    /// No such device (revoked, forgotten, or not provisioned here).
    Unknown,
}

/// The session an inbound frame came in on. A reply is sealed for THIS session
/// ([`NodeChannel::seal_for`]) — never for whatever session holds the socket by the
/// time the reply is ready: the relay picks every `_cid`, and could otherwise swap
/// in another device's session mid-request and read the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionRef {
    serial: u64,
    /// The key generation the session handshook with.
    pub generation: u32,
}

/// The outcome of a frame received on a phone socket.
#[derive(Debug)]
pub enum Inbound {
    /// An authenticated app frame from this device: act on it.
    App {
        /// The device that sent it (proved by the session key).
        device_id: DeviceId,
        /// The decrypted app frame (`rpc`, `subscribe`, `ping`…).
        frame: Value,
        /// The session it came in on: seal the reply for it.
        session: SessionRef,
        /// This is the first frame the session opened: the phone has just proved it
        /// holds the key (the moment to record it as seen, never at the hello).
        first_proof: bool,
    },
    /// The session's key generation expired: it was dropped. Answer
    /// [`RejectReason::Expired`] so the phone renews or re-pairs.
    Expired,
    /// No session on this socket — never opened, or just dropped after too many
    /// failures: answer [`RejectReason::NoSession`] so the phone handshakes again.
    NoSession,
    /// Nothing to act on. `closed` says the session was dropped after too many
    /// failures (the phone will handshake again).
    Dropped {
        /// Why the frame was refused.
        error: Error,
        /// Whether the socket's session was torn down because of it.
        closed: bool,
    },
}

struct Entry {
    device_id: DeviceId,
    generation: u32,
    serial: u64,
    /// When the generation stops being accepted — checked on every frame, not only
    /// at the hello: a session must not outlive its key.
    expires_at_ms: u64,
    opened_at: Instant,
    session: Session,
    /// The phone has sent a frame that opened under the session key: it holds
    /// the device key. Only then does it receive broadcast events.
    proven: bool,
    last_used: u64,
}

/// All of a node's sealed sessions.
pub struct NodeChannel {
    mac_id: String,
    sessions: HashMap<String, Entry>,
    last_hello: HashMap<String, Instant>,
    window_start: Option<Instant>,
    window_count: u32,
    tick: u64,
    next_serial: u64,
    rng: SystemRandom,
}

impl NodeChannel {
    /// A channel for the node `mac_id` (bound into every handshake).
    pub fn new(mac_id: impl Into<String>) -> Self {
        Self {
            mac_id: mac_id.into(),
            sessions: HashMap::new(),
            last_hello: HashMap::new(),
            window_start: None,
            window_count: 0,
            tick: 0,
            next_serial: 0,
            rng: SystemRandom::new(),
        }
    }

    /// Handles an `e2e_hello` from socket `cid`. `lookup` resolves the device;
    /// `now_ms` is wall-clock time for expiry; `now` is a monotonic instant for
    /// rate limiting. Returns the frame to send back (accept or reject).
    pub fn on_hello(
        &mut self,
        cid: &str,
        frame: &Value,
        lookup: impl FnOnce(&DeviceId) -> Lookup,
        now_ms: u64,
        now: Instant,
    ) -> Result<Value, Error> {
        let hello = Hello::from_frame(frame)?;
        // A phone socket never changes device: a hello for another device on a socket
        // whose session proved itself is the relay trying to take that socket over.
        if self.sessions.get(cid).is_some_and(|e| e.proven && e.device_id != hello.device_id) {
            return Ok(RejectReason::Busy.to_frame());
        }
        if !self.admit_hello(cid, now) {
            return Ok(RejectReason::Busy.to_frame());
        }
        let generations = match lookup(&hello.device_id) {
            Lookup::Known(g) => g,
            Lookup::Unknown => return Ok(RejectReason::UnknownDevice.to_frame()),
        };
        let Some(gen) = generations.iter().find(|g| g.generation == hello.generation) else {
            return Ok(RejectReason::UnknownGeneration.to_frame());
        };
        if gen.expires_at_ms <= now_ms {
            return Ok(RejectReason::Expired.to_frame());
        }
        let (accept, session) = node_accept(&hello, &self.mac_id, &gen.key, &self.rng)?;
        self.next_serial += 1;
        let entry = Entry {
            device_id: hello.device_id,
            generation: gen.generation,
            serial: self.next_serial,
            expires_at_ms: gen.expires_at_ms,
            opened_at: now,
            session,
            proven: false,
            last_used: 0,
        };
        self.insert(cid, entry, now);
        Ok(accept.to_frame())
    }

    /// Handles an `e2e` frame from socket `cid`. `now_ms` is wall-clock time: a
    /// session whose generation has expired is dropped ([`Inbound::Expired`]).
    pub fn on_sealed(&mut self, cid: &str, frame: &Value, now_ms: u64) -> Inbound {
        let sealed = match Sealed::from_frame(frame) {
            Ok(s) => s,
            Err(error) => return Inbound::Dropped { error, closed: false },
        };
        self.tick += 1;
        let tick = self.tick;
        let Some(entry) = self.sessions.get_mut(cid) else {
            return Inbound::NoSession;
        };
        if entry.expires_at_ms <= now_ms {
            self.sessions.remove(cid);
            return Inbound::Expired;
        }
        match entry.session.open_json(&sealed) {
            Ok(frame) => {
                let first_proof = !entry.proven;
                entry.proven = true;
                entry.last_used = tick;
                let session = SessionRef { serial: entry.serial, generation: entry.generation };
                Inbound::App { device_id: entry.device_id, frame, session, first_proof }
            }
            Err(error) => {
                let closed = entry.session.should_close();
                if closed {
                    self.sessions.remove(cid);
                }
                Inbound::Dropped { error, closed }
            }
        }
    }

    /// The relay said socket `cid` closed.
    pub fn on_phone_left(&mut self, cid: &str) {
        self.sessions.remove(cid);
        self.last_hello.remove(cid);
    }

    /// Whether socket `cid` speaks the sealed channel (its replies must be sealed).
    pub fn has_session(&self, cid: &str) -> bool {
        self.sessions.contains_key(cid)
    }

    /// Seals a reply for the session `session` on socket `cid`, returning the wire
    /// frame with `_cid`. Refused when that socket no longer holds that very session
    /// (it was replaced, dropped or expired meanwhile): the reply is dropped, never
    /// sealed for another session.
    pub fn seal_for(&mut self, cid: &str, session: SessionRef, frame: &Value) -> Result<Value, Error> {
        let entry = self.sessions.get_mut(cid).ok_or(Error::Malformed("no session on this socket"))?;
        if entry.serial != session.serial {
            return Err(Error::Malformed("the session on this socket changed since the request"));
        }
        let mut out = entry.session.seal_json(frame)?.to_frame();
        out["_cid"] = Value::String(cid.to_owned());
        Ok(out)
    }

    /// Seals an app frame (an event) for every proven session, one wire frame
    /// each, each targeted with its `_cid`. A session that cannot seal (counter
    /// exhausted) or whose generation expired (`now_ms`) is dropped: the phone
    /// handshakes again.
    pub fn seal_broadcast(&mut self, frame: &Value, now_ms: u64) -> Vec<Value> {
        let mut out = Vec::new();
        let mut dead: Vec<String> =
            self.sessions.iter().filter(|(_, e)| e.expires_at_ms <= now_ms).map(|(c, _)| c.clone()).collect();
        for (cid, entry) in self.sessions.iter_mut().filter(|(_, e)| e.proven && e.expires_at_ms > now_ms) {
            match entry.session.seal_json(frame) {
                Ok(sealed) => {
                    let mut f = sealed.to_frame();
                    f["_cid"] = Value::String(cid.clone());
                    out.push(f);
                }
                Err(_) => dead.push(cid.clone()),
            }
        }
        for cid in dead {
            self.sessions.remove(&cid);
        }
        out
    }

    /// Drops every session of `device_id` (revoked or forgotten). Returns how
    /// many sockets lost their session.
    pub fn drop_device(&mut self, device_id: &DeviceId) -> usize {
        let before = self.sessions.len();
        self.sessions.retain(|_, e| e.device_id != *device_id);
        before - self.sessions.len()
    }

    /// The device's key book changed: drop every session of `device_id` whose
    /// generation is not in `keep` (rotated away, or replaced by different key bytes
    /// — the caller passes only the generations whose key is unchanged). Returns how
    /// many sockets lost their session.
    pub fn retain_generations(&mut self, device_id: &DeviceId, keep: &[u32]) -> usize {
        let before = self.sessions.len();
        self.sessions.retain(|_, e| e.device_id != *device_id || keep.contains(&e.generation));
        before - self.sessions.len()
    }

    /// Drops every session whose generation has expired. Returns how many.
    pub fn drop_expired(&mut self, now_ms: u64) -> usize {
        let before = self.sessions.len();
        self.sessions.retain(|_, e| e.expires_at_ms > now_ms);
        before - self.sessions.len()
    }

    /// The device behind socket `cid`, if it has a session.
    pub fn device_of(&self, cid: &str) -> Option<DeviceId> {
        self.sessions.get(cid).map(|e| e.device_id)
    }

    /// The key generation socket `cid` handshook with, if it has a session.
    pub fn generation_of(&self, cid: &str) -> Option<u32> {
        self.sessions.get(cid).map(|e| e.generation)
    }

    /// How many live, PROVEN sessions `device_id` has (one per connected socket). A
    /// session that never opened a frame proves nothing — its hello can be replayed.
    pub fn sessions_of(&self, device_id: &DeviceId) -> usize {
        self.sessions.values().filter(|e| e.device_id == *device_id && e.proven).count()
    }

    /// Number of live sessions.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// Whether there is no live session.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    fn admit_hello(&mut self, cid: &str, now: Instant) -> bool {
        if self.last_hello.get(cid).is_some_and(|t| now.duration_since(*t) < HELLO_INTERVAL) {
            return false;
        }
        match self.window_start {
            Some(start) if now.duration_since(start) < Duration::from_secs(1) => {
                if self.window_count >= HELLOS_PER_SECOND {
                    return false;
                }
                self.window_count += 1;
            }
            _ => {
                self.window_start = Some(now);
                self.window_count = 1;
            }
        }
        if self.last_hello.len() >= MAX_SESSIONS * 4 {
            // Sockets that left without a `phone_left` (older relay): forget the oldest.
            let cutoff = now.checked_sub(HELLO_INTERVAL).unwrap_or(now);
            self.last_hello.retain(|_, t| *t > cutoff);
        }
        self.last_hello.insert(cid.to_owned(), now);
        true
    }

    fn insert(&mut self, cid: &str, mut entry: Entry, now: Instant) {
        self.tick += 1;
        entry.last_used = self.tick;
        // Unproven sessions past their short life go first; when the table is still
        // full, the oldest UNPROVEN one makes room — a proven one only when every
        // session is proven (replayed hellos never push out a phone that proved itself).
        self.sessions.retain(|c, e| e.proven || c == cid || now.duration_since(e.opened_at) < UNPROVEN_TTL);
        if !self.sessions.contains_key(cid) && self.sessions.len() >= MAX_SESSIONS {
            let victim = self
                .sessions
                .iter()
                .min_by_key(|(_, e)| (e.proven, e.last_used))
                .map(|(c, _)| c.clone());
            if let Some(victim) = victim {
                self.sessions.remove(&victim);
            }
        }
        self.sessions.insert(cid.to_owned(), entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handshake::{Accept, PhoneHandshake};
    use crate::keys::DeviceSecret;
    use serde_json::json;

    const MAC: &str = "node-1";
    const NOW_MS: u64 = 1_800_000_000_000;

    struct Phone {
        id: DeviceId,
        secret: DeviceSecret,
    }

    impl Phone {
        fn new(n: u8) -> Self {
            Self { id: DeviceId::from_bytes([n; 16]), secret: DeviceSecret::from_bytes([n; 32]) }
        }
        fn known(&self, generation: u32, expires_at_ms: u64) -> Lookup {
            Lookup::Known(vec![KeyGeneration { generation, key: self.secret.node_key(MAC), expires_at_ms }])
        }
        /// Full handshake against `node` on socket `cid`; returns the phone's session.
        fn connect(&self, node: &mut NodeChannel, cid: &str, now: Instant) -> Session {
            let rng = SystemRandom::new();
            let (hs, hello) = PhoneHandshake::start(self.id, 1, &rng).unwrap();
            let reply = node
                .on_hello(cid, &hello.to_frame(), |_| self.known(1, NOW_MS + 1), NOW_MS, now)
                .unwrap();
            hs.finish(&Accept::from_frame(&reply).unwrap(), MAC, &self.secret.node_key(MAC)).unwrap()
        }
    }

    fn hello_frame(phone: &Phone, generation: u32) -> Value {
        PhoneHandshake::start(phone.id, generation, &SystemRandom::new()).unwrap().1.to_frame()
    }

    #[test]
    fn an_authenticated_frame_reaches_the_node_with_its_device() {
        let (mut node, phone) = (NodeChannel::new(MAC), Phone::new(1));
        let mut s = phone.connect(&mut node, "c1", Instant::now());
        let f = s.seal_json(&json!({"type": "rpc", "id": "r1"})).unwrap().to_frame();
        let session = match node.on_sealed("c1", &f, NOW_MS) {
            Inbound::App { device_id, frame, session, first_proof } => {
                assert_eq!(device_id, phone.id);
                assert_eq!(frame["id"], "r1");
                assert!(first_proof);
                assert_eq!(session.generation, 1);
                session
            }
            other => panic!("{other:?}"),
        };
        let reply = node.seal_for("c1", session, &json!({"type": "rpc_result", "id": "r1"})).unwrap();
        assert_eq!(reply["_cid"], "c1");
        assert_eq!(s.open_json(&Sealed::from_frame(&reply).unwrap()).unwrap()["id"], "r1");
        let f = s.seal_json(&json!({"type": "ping"})).unwrap().to_frame();
        assert!(matches!(node.on_sealed("c1", &f, NOW_MS), Inbound::App { first_proof: false, .. }));
    }

    /// Proves the session on `cid` (its first frame) and returns its ref.
    fn prove(node: &mut NodeChannel, s: &mut Session, cid: &str) -> SessionRef {
        let f = s.seal_json(&json!({"type": "subscribe"})).unwrap().to_frame();
        match node.on_sealed(cid, &f, NOW_MS) {
            Inbound::App { session, .. } => session,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_reply_is_never_sealed_for_a_session_that_replaced_the_requesting_one() {
        let (mut node, a) = (NodeChannel::new(MAC), Phone::new(1));
        let t = Instant::now();
        let mut s1 = a.connect(&mut node, "c1", t);
        let first = prove(&mut node, &mut s1, "c1");
        // The same phone handshakes again on that socket (a reconnect): a new session.
        let _s2 = a.connect(&mut node, "c1", t + HELLO_INTERVAL);
        assert!(node.seal_for("c1", first, &json!({"type": "rpc_result"})).is_err(), "the old request's reply is dropped");
    }

    #[test]
    fn a_proven_socket_cannot_be_taken_over_by_another_device() {
        let (mut node, a, b) = (NodeChannel::new(MAC), Phone::new(1), Phone::new(2));
        let t = Instant::now();
        let mut sa = a.connect(&mut node, "c1", t);
        let ra = prove(&mut node, &mut sa, "c1");
        let later = t + HELLO_INTERVAL;
        let r = node.on_hello("c1", &hello_frame(&b, 1), |_| b.known(1, NOW_MS + 1), NOW_MS, later).unwrap();
        assert_eq!(r["reason"], "busy");
        assert_eq!(node.device_of("c1"), Some(a.id));
        assert!(node.seal_for("c1", ra, &json!({"type": "rpc_result"})).is_ok());
    }

    #[test]
    fn a_session_dies_with_its_key_generation() {
        let (mut node, a) = (NodeChannel::new(MAC), Phone::new(1));
        let t = Instant::now();
        let mut s = a.connect(&mut node, "c1", t);
        prove(&mut node, &mut s, "c1");
        // Past expiry: no more events, and the next frame is answered `expired`.
        assert!(node.seal_broadcast(&json!({"type": "event"}), NOW_MS + 1).is_empty());
        assert!(!node.has_session("c1"));
        let mut s = a.connect(&mut node, "c2", t + HELLO_INTERVAL);
        let f = s.seal_json(&json!({"type": "rpc"})).unwrap().to_frame();
        assert!(matches!(node.on_sealed("c2", &f, NOW_MS + 1), Inbound::Expired));
        assert!(!node.has_session("c2"));
        a.connect(&mut node, "c3", t + HELLO_INTERVAL * 2);
        assert_eq!(node.drop_expired(NOW_MS + 1), 1);
    }

    #[test]
    fn a_rotated_away_generation_loses_its_sessions() {
        let (mut node, a, b) = (NodeChannel::new(MAC), Phone::new(1), Phone::new(2));
        let t = Instant::now();
        a.connect(&mut node, "a1", t);
        b.connect(&mut node, "b1", t);
        assert_eq!(node.retain_generations(&a.id, &[2, 3]), 1);
        assert!(!node.has_session("a1"));
        assert!(node.has_session("b1"), "other devices are untouched");
        assert_eq!(node.retain_generations(&b.id, &[1]), 0);
    }

    #[test]
    fn replayed_hellos_neither_count_as_connected_nor_evict_proven_sessions() {
        let (mut node, a) = (NodeChannel::new(MAC), Phone::new(1));
        let mut t = Instant::now();
        let mut s = a.connect(&mut node, "real", t);
        prove(&mut node, &mut s, "real");
        assert_eq!(node.sessions_of(&a.id), 1);
        for i in 0..MAX_SESSIONS * 2 {
            t += Duration::from_millis(200);
            a.connect(&mut node, &format!("replay{i}"), t);
        }
        assert!(node.has_session("real"), "a proven session survives a flood of unproven ones");
        assert_eq!(node.sessions_of(&a.id), 1, "unproven sessions are not counted");
        // Unproven entries do not linger.
        a.connect(&mut node, "late", t + UNPROVEN_TTL * 2);
        assert_eq!(node.len(), 2);
    }

    #[test]
    fn unknown_wrong_generation_and_expired_devices_are_rejected() {
        let (mut node, phone) = (NodeChannel::new(MAC), Phone::new(1));
        let t = Instant::now();
        let r = node.on_hello("a", &hello_frame(&phone, 1), |_| Lookup::Unknown, NOW_MS, t).unwrap();
        assert_eq!(r["reason"], "unknown_device");
        let r = node.on_hello("b", &hello_frame(&phone, 2), |_| phone.known(1, NOW_MS + 1), NOW_MS, t).unwrap();
        assert_eq!(r["reason"], "unknown_generation");
        let r = node.on_hello("c", &hello_frame(&phone, 1), |_| phone.known(1, NOW_MS), NOW_MS, t).unwrap();
        assert_eq!(r["reason"], "expired");
        assert!(node.is_empty());
    }

    #[test]
    fn a_frame_on_a_socket_without_a_session_asks_for_a_handshake() {
        let mut node = NodeChannel::new(MAC);
        let f = json!({"type": "e2e", "n": 0, "c": "AAAAAAAAAAAAAAAAAAAAAA"});
        assert!(matches!(node.on_sealed("ghost", &f, NOW_MS), Inbound::NoSession));
        assert_eq!(RejectReason::NoSession.to_frame()["reason"], "no_session");
    }

    #[test]
    fn a_session_cannot_be_used_from_another_socket() {
        // The relay swapping connection ids gains nothing.
        let (mut node, a, b) = (NodeChannel::new(MAC), Phone::new(1), Phone::new(2));
        let t = Instant::now();
        let mut sa = a.connect(&mut node, "ca", t);
        let _sb = b.connect(&mut node, "cb", t);
        let f = sa.seal_json(&json!({"type": "rpc"})).unwrap().to_frame();
        assert!(matches!(node.on_sealed("cb", &f, NOW_MS), Inbound::Dropped { .. }));
    }

    #[test]
    fn repeated_failures_tear_the_session_down() {
        let (mut node, phone) = (NodeChannel::new(MAC), Phone::new(1));
        let _s = phone.connect(&mut node, "c1", Instant::now());
        let junk = json!({"type": "e2e", "n": 0, "c": "AAAAAAAAAAAAAAAAAAAAAA"});
        assert!(matches!(node.on_sealed("c1", &junk, NOW_MS), Inbound::Dropped { closed: false, .. }));
        assert!(matches!(node.on_sealed("c1", &junk, NOW_MS), Inbound::Dropped { closed: false, .. }));
        assert!(matches!(node.on_sealed("c1", &junk, NOW_MS), Inbound::Dropped { closed: true, .. }));
        assert!(!node.has_session("c1"));
    }

    #[test]
    fn events_go_only_to_proven_sessions_one_frame_each() {
        let (mut node, a, b) = (NodeChannel::new(MAC), Phone::new(1), Phone::new(2));
        let t = Instant::now();
        let mut sa = a.connect(&mut node, "ca", t);
        let mut sb = b.connect(&mut node, "cb", t);
        assert!(node.seal_broadcast(&json!({"type": "event"}), NOW_MS).is_empty(), "nobody proven yet");
        for (s, cid) in [(&mut sa, "ca"), (&mut sb, "cb")] {
            let f = s.seal_json(&json!({"type": "subscribe"})).unwrap().to_frame();
            assert!(matches!(node.on_sealed(cid, &f, NOW_MS), Inbound::App { .. }));
        }
        let frames = node.seal_broadcast(&json!({"type": "event", "event": {"kind": "turn_completed"}}), NOW_MS);
        assert_eq!(frames.len(), 2);
        for f in frames {
            let s = if f["_cid"] == "ca" { &mut sa } else { &mut sb };
            assert_eq!(s.open_json(&Sealed::from_frame(&f).unwrap()).unwrap()["type"], "event");
        }
    }

    #[test]
    fn revoking_a_device_drops_all_its_sockets_and_nothing_else() {
        let (mut node, a, b) = (NodeChannel::new(MAC), Phone::new(1), Phone::new(2));
        let t = Instant::now();
        a.connect(&mut node, "a1", t);
        a.connect(&mut node, "a2", t);
        b.connect(&mut node, "b1", t);
        assert_eq!(node.drop_device(&a.id), 2);
        assert_eq!(node.device_of("b1"), Some(b.id));
        assert_eq!(node.len(), 1);
    }

    #[test]
    fn phone_left_ends_the_session() {
        let (mut node, phone) = (NodeChannel::new(MAC), Phone::new(1));
        phone.connect(&mut node, "c1", Instant::now());
        node.on_phone_left("c1");
        assert!(!node.has_session("c1"));
    }

    #[test]
    fn handshakes_are_rate_limited_per_socket_and_in_total() {
        let (mut node, phone) = (NodeChannel::new(MAC), Phone::new(1));
        let t = Instant::now();
        let ok = |r: &Value| r["type"] == "e2e_accept";
        let known = || phone.known(1, NOW_MS + 1);
        assert!(ok(&node.on_hello("c", &hello_frame(&phone, 1), |_| known(), NOW_MS, t).unwrap()));
        let again = node.on_hello("c", &hello_frame(&phone, 1), |_| known(), NOW_MS, t).unwrap();
        assert_eq!(again["reason"], "busy");
        let later = t + HELLO_INTERVAL;
        assert!(ok(&node.on_hello("c", &hello_frame(&phone, 1), |_| known(), NOW_MS, later).unwrap()));

        let mut node = NodeChannel::new(MAC);
        for i in 0..HELLOS_PER_SECOND {
            let r = node.on_hello(&format!("s{i}"), &hello_frame(&phone, 1), |_| known(), NOW_MS, t).unwrap();
            assert!(ok(&r));
        }
        let r = node.on_hello("one-too-many", &hello_frame(&phone, 1), |_| known(), NOW_MS, t).unwrap();
        assert_eq!(r["reason"], "busy");
    }

    #[test]
    fn the_table_is_capped_oldest_first() {
        let (mut node, phone) = (NodeChannel::new(MAC), Phone::new(1));
        let mut t = Instant::now();
        for i in 0..=MAX_SESSIONS {
            t += Duration::from_secs(1);
            let cid = format!("c{i}");
            let mut s = phone.connect(&mut node, &cid, t);
            prove(&mut node, &mut s, &cid);
        }
        assert_eq!(node.len(), MAX_SESSIONS);
        assert!(!node.has_session("c0"));
        assert!(node.has_session(&format!("c{MAX_SESSIONS}")));
    }

    #[test]
    fn helper_frames_have_the_wire_shape() {
        let d = ReadyDevice { label: "iPhone".into(), generation: 2, expires_at_ms: 9, renew_after_ms: 5 };
        assert_eq!(
            ready_frame("Mac", Some(&d), &["sealed-push"]),
            json!({"type": "ready", "label": "Mac", "device": {"label": "iPhone", "generation": 2,
                   "expires_at_ms": 9, "renew_after_ms": 5}, "caps": ["sealed-push"]})
        );
        assert_eq!(ready_frame("Mac", None, &[])["device"]["generation"], Value::Null);
        assert_eq!(no_session_frame("c1"), json!({"type": "e2e_reject", "v": 1, "reason": "no_session", "_cid": "c1"}));
        assert_eq!(
            encryption_required_frame(&json!({"type": "rpc", "id": "x"}), Some("c2")),
            json!({"type": "rpc_error", "id": "x", "error": ENCRYPTION_REQUIRED, "_cid": "c2"})
        );
        assert_eq!(encryption_required_frame(&json!({}), None)["id"], Value::Null);
    }

    #[test]
    fn a_malformed_hello_is_an_error_not_a_session() {
        let mut node = NodeChannel::new(MAC);
        let r = node.on_hello("c", &json!({"type": "e2e_hello", "v": 1}), |_| Lookup::Unknown, NOW_MS, Instant::now());
        assert!(r.is_err());
        assert!(node.is_empty());
    }
}
