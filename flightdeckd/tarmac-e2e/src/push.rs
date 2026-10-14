//! Which events become a push, and what the push says (contract §8).
//!
//! The relay used to decide this from cleartext events (`pushStateFor` and
//! `_payload` in Tarmac's `server/push.mjs`); with the sealed channel it can no
//! longer read them, so each node decides for its own devices. These are ports,
//! kept identical so a legacy (relay-built) and a sealed (node-built)
//! notification look the same on the phone.

use ring::rand::SecureRandom;
use serde_json::{json, Map, Value};

use crate::kdf::hkdf_sha256;
use crate::keys::NodeKey;
use crate::{b64, webpush, Error, LABEL};

/// Push subscriptions a node keeps per device (one per browser); past it, the
/// oldest registration goes.
pub const MAX_PUSH_SUBSCRIPTIONS: usize = 4;

/// How long a push service keeps an undelivered notification.
pub const PUSH_TTL_SECS: u64 = 600;

/// Where to push: a browser subscription's endpoint and keys (base64url).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushTarget {
    /// The push service URL (never sent to the relay, only its hash).
    pub endpoint: String,
    /// `keys.p256dh`.
    pub p256dh: String,
    /// `keys.auth`.
    pub auth: String,
}

/// What a node signs a push with: the device's key on THIS node, under one
/// generation. Every node holds the browser's subscription keys (a browser has one
/// subscription), so RFC 8291 alone cannot tell which node wrote a notification:
/// the signature can — only this node (and the phone) holds this key.
#[derive(Debug, Clone, Copy)]
pub struct PushSigner<'a> {
    /// The generation `key` belongs to (the phone picks the matching secret).
    pub generation: u32,
    /// This node's key for the device under that generation.
    pub key: &'a NodeKey,
}

/// The push-signing key: `HKDF-SHA256(ikm = K_node, salt = "tarmac-e2e/v1", info = "push", L = 32)`.
pub fn push_key(node_key: &NodeKey) -> [u8; 32] {
    let mut key = [0u8; 32];
    hkdf_sha256(LABEL.as_bytes(), node_key.as_bytes(), &[b"push"], &mut key);
    key
}

/// The bytes a push signature covers, from a signed payload: `"push"`, `data.macId`,
/// `data.g` (u32be), `data.at` (u64be), `data.id`, `tag`, `title`, `body`, `kind`,
/// `state`, `data.conversationId`, `data.url`, `data.sessionId` — each string as
/// `u32be(len) ‖ UTF-8`, an absent one as the empty string.
pub fn push_signed_bytes(payload: &Value) -> Vec<u8> {
    fn put(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&(s.len() as u32).to_be_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    let text = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_owned();
    let data = payload.get("data");
    let d = |k: &str| data.and_then(|d| d.get(k));
    let mut out = Vec::new();
    put(&mut out, "push");
    put(&mut out, &text(d("macId")));
    out.extend_from_slice(&(d("g").and_then(Value::as_u64).unwrap_or(0) as u32).to_be_bytes());
    out.extend_from_slice(&d("at").and_then(Value::as_u64).unwrap_or(0).to_be_bytes());
    put(&mut out, &text(d("id")));
    for k in ["tag", "title", "body", "kind", "state"] {
        put(&mut out, &text(payload.get(k)));
    }
    for k in ["conversationId", "url", "sessionId"] {
        put(&mut out, &text(d(k)));
    }
    out
}

/// [`payload`], plus what lets the phone trust it: `data.g` / `data.at` (when the
/// node wrote it, ms) / `data.id` (random, for replay detection) / `data.sig` =
/// `base64url(HMAC-SHA256(push_key(K_node), push_signed_bytes))`. The service worker
/// recomputes the signature for `data.macId` and drops a push that does not verify,
/// one older than [`PUSH_TTL_SECS`], or an `id` it has already shown.
pub fn signed_payload(mac_id: &str, event: &Value, state: PushState, signer: PushSigner<'_>, at_ms: u64, id: &str) -> Value {
    let mut p = payload(mac_id, event, state);
    p["data"]["g"] = json!(signer.generation);
    p["data"]["at"] = json!(at_ms);
    p["data"]["id"] = json!(id);
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &push_key(signer.key));
    let sig = ring::hmac::sign(&key, &push_signed_bytes(&p));
    p["data"]["sig"] = json!(b64::encode(sig.as_ref()));
    p
}

/// Whether `payload` carries a valid signature by `node_key` (what the service worker
/// checks; here for tests and interop vectors).
pub fn verify_push(payload: &Value, node_key: &NodeKey) -> bool {
    let Some(sig) = payload.get("data").and_then(|d| d.get("sig")).and_then(Value::as_str) else { return false };
    let Ok(sig) = b64::decode(sig, "sig") else { return false };
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &push_key(node_key));
    ring::hmac::verify(&key, &push_signed_bytes(payload), &sig).is_ok()
}

/// The `push_send` frame a node hands the relay for one subscription: the
/// notification for `event` (in `state`), signed by this node ([`signed_payload`],
/// `now_ms`) and sealed for that browser (RFC 8291), named by the endpoint's hash.
/// The relay sees neither the content nor the keys, and can neither forge one nor
/// replay one past its freshness window.
pub fn push_send_frame(
    mac_id: &str,
    event: &Value,
    state: PushState,
    target: &PushTarget,
    signer: PushSigner<'_>,
    now_ms: u64,
    rng: &dyn SecureRandom,
) -> Result<Value, Error> {
    let ua = b64::decode(&target.p256dh, "p256dh")?;
    let auth = b64::decode(&target.auth, "auth")?;
    let mut id = [0u8; 16];
    rng.fill(&mut id)?;
    let content = signed_payload(mac_id, event, state, signer, now_ms, &b64::encode(&id));
    let body = webpush::encrypt(&ua, &auth, content.to_string().as_bytes(), rng)?;
    Ok(json!({
        "type": "push_send",
        "endpoint": endpoint_hash(&target.endpoint),
        "body": b64::encode(&body),
        "ttl": PUSH_TTL_SECS,
        "urgency": if state == PushState::Review { "normal" } else { "high" },
    }))
}

/// The Flight Deck state a notification is about: the key of the phone's
/// per-state toggles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushState {
    /// An agent is blocked on you, or ended its turn on an open question.
    Question,
    /// A turn ended in error.
    Error,
    /// A clean finish, ready for review.
    Review,
}

impl PushState {
    /// The wire spelling (`state` field, and the prefs key).
    pub fn as_str(self) -> &'static str {
        match self {
            PushState::Question => "question",
            PushState::Error => "error",
            PushState::Review => "review",
        }
    }

    fn copy(self) -> (&'static str, &'static str) {
        match self {
            PushState::Question => ("Waiting on you", "Your agent needs an answer."),
            PushState::Error => ("Turn ended in error", "Your agent stopped on an error."),
            PushState::Review => ("Ready for review", "Your agent finished a turn."),
        }
    }
}

/// A device's per-state toggles. A missing state is ON (as on the relay).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushPrefs {
    /// Notify on [`PushState::Question`].
    pub question: bool,
    /// Notify on [`PushState::Error`].
    pub error: bool,
    /// Notify on [`PushState::Review`].
    pub review: bool,
}

impl Default for PushPrefs {
    fn default() -> Self {
        Self { question: true, error: true, review: true }
    }
}

impl PushPrefs {
    /// Applies the booleans present in `value` (`{question?, error?, review?}`)
    /// on top of `self`; anything else is ignored.
    pub fn merged(mut self, value: &Value) -> Self {
        let get = |k: &str| value.get(k).and_then(Value::as_bool);
        if let Some(b) = get("question") {
            self.question = b;
        }
        if let Some(b) = get("error") {
            self.error = b;
        }
        if let Some(b) = get("review") {
            self.review = b;
        }
        self
    }

    /// Whether this device wants a push for `state`.
    pub fn wants(&self, state: PushState) -> bool {
        match state {
            PushState::Question => self.question,
            PushState::Error => self.error,
            PushState::Review => self.review,
        }
    }

    /// The JSON form `{question, error, review}`.
    pub fn to_json(&self) -> Value {
        json!({ "question": self.question, "error": self.error, "review": self.review })
    }
}

/// The state an event notifies about, or `None` when it must never push
/// (`task_finished`, `attention_cleared`, unknown kinds). An error beats an
/// open question, which beats a clean finish.
pub fn push_state(event: &Value) -> Option<PushState> {
    let detail = event.get("detail").filter(|d| d.is_object());
    let field = |k: &str| detail.and_then(|d| d.get(k));
    match event.get("kind").and_then(Value::as_str)? {
        "needs_attention" => Some(PushState::Question),
        "turn_completed" => {
            let errored = field("outcome").and_then(Value::as_str) == Some("error")
                || field("subtype").and_then(Value::as_str).is_some_and(|s| s.starts_with("error"));
            if errored {
                return Some(PushState::Error);
            }
            let open = match field("open_question").and_then(Value::as_bool) {
                Some(b) => b,
                None => looks_like_question(field("last_assistant_text").and_then(Value::as_str)),
            };
            Some(if open { PushState::Question } else { PushState::Review })
        }
        _ => None,
    }
}

/// Port of `looksLikeQuestion`: the text, stripped of trailing whitespace and
/// closing markup, ends with `?`.
fn looks_like_question(text: Option<&str>) -> bool {
    let Some(text) = text else { return false };
    text.trim_end_matches(|c: char| c.is_whitespace() || "*_)]\"'`~>".contains(c)).ends_with('?')
}

/// How a node names a subscription to the relay in `push_send`: the lowercase
/// hex SHA-256 of its `endpoint` (the relay keys its subscriptions the same way).
pub fn endpoint_hash(endpoint: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, endpoint.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The notification the service worker shows:
/// `{title, body, kind, state, tag, data:{macId, conversationId, kind, state, url, sessionId?}}`.
pub fn payload(mac_id: &str, event: &Value, state: PushState) -> Value {
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("status");
    let conversation_id = event.get("conversationId").and_then(Value::as_str).filter(|s| !s.is_empty());
    let session_id = event.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    let tag = match (session_id, conversation_id) {
        (Some(s), _) => format!("session:{s}"),
        (None, Some(c)) => format!("conv:{mac_id}:{c}"),
        (None, None) => format!("mac:{mac_id}"),
    };
    let (title, fallback) = state.copy();
    let body: String =
        event.get("text").and_then(Value::as_str).unwrap_or("").chars().take(140).collect();
    let mut data = Map::new();
    data.insert("macId".into(), json!(mac_id));
    data.insert("conversationId".into(), json!(conversation_id));
    data.insert("kind".into(), json!(kind));
    data.insert("state".into(), json!(state.as_str()));
    let url = conversation_id.map_or_else(|| "/".to_owned(), |c| format!("/#conv={c}"));
    data.insert("url".into(), json!(url));
    if let Some(s) = session_id {
        data.insert("sessionId".into(), json!(s));
    }
    json!({
        "title": title,
        "body": if body.is_empty() { fallback.to_owned() } else { body },
        "kind": kind,
        "state": state.as_str(),
        "tag": tag,
        "data": Value::Object(data),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(detail: Value) -> Value {
        json!({"kind": "turn_completed", "detail": detail})
    }

    #[test]
    fn states_follow_the_relays_precedence() {
        assert_eq!(push_state(&json!({"kind": "needs_attention"})), Some(PushState::Question));
        assert_eq!(push_state(&turn(json!({"outcome": "error", "open_question": true}))), Some(PushState::Error));
        assert_eq!(push_state(&turn(json!({"subtype": "error_max_turns"}))), Some(PushState::Error));
        assert_eq!(push_state(&turn(json!({"open_question": true}))), Some(PushState::Question));
        assert_eq!(push_state(&turn(json!({"open_question": false, "last_assistant_text": "ok?"}))), Some(PushState::Review));
        assert_eq!(push_state(&turn(json!({"outcome": "success"}))), Some(PushState::Review));
        for kind in ["task_finished", "attention_cleared", "whatever"] {
            assert_eq!(push_state(&json!({"kind": kind})), None);
        }
        assert_eq!(push_state(&json!({})), None);
    }

    #[test]
    fn an_older_mac_falls_back_on_the_question_heuristic() {
        assert_eq!(push_state(&turn(json!({"last_assistant_text": "Shall I go on?** "}))), Some(PushState::Question));
        assert_eq!(push_state(&turn(json!({"last_assistant_text": "Done."}))), Some(PushState::Review));
        assert_eq!(push_state(&turn(json!({"last_assistant_text": "Clipped tail…"}))), Some(PushState::Review));
    }

    #[test]
    fn payload_matches_the_relays_shape() {
        let ev = json!({"kind": "turn_completed", "conversationId": "c1", "text": "All green.", "session_id": "s9"});
        let p = payload("mac-1", &ev, PushState::Review);
        assert_eq!(p["title"], "Ready for review");
        assert_eq!(p["body"], "All green.");
        assert_eq!(p["tag"], "session:s9");
        assert_eq!(p["data"], json!({"macId": "mac-1", "conversationId": "c1", "kind": "turn_completed",
                                      "state": "review", "url": "/#conv=c1", "sessionId": "s9"}));
        let p = payload("mac-1", &json!({"kind": "needs_attention", "conversationId": "c1"}), PushState::Question);
        assert_eq!(p["tag"], "conv:mac-1:c1");
        assert_eq!(p["body"], "Your agent needs an answer.");
        let p = payload("mac-1", &json!({"kind": "needs_attention"}), PushState::Question);
        assert_eq!(p["tag"], "mac:mac-1");
        assert_eq!(p["data"]["url"], "/");
        assert_eq!(p["data"]["conversationId"], Value::Null);
    }

    #[test]
    fn the_body_is_clipped_on_characters_never_mid_emoji() {
        let text = "✈️".repeat(100);
        let p = payload("m", &json!({"kind": "turn_completed", "text": text}), PushState::Review);
        assert_eq!(p["body"].as_str().unwrap().chars().count(), 140);
    }

    #[test]
    fn a_push_send_frame_names_the_endpoint_by_hash_and_seals_the_payload() {
        let rng = ring::rand::SystemRandom::new();
        // A valid P-256 point: any handshake ephemeral.
        let (_, hello) =
            crate::handshake::PhoneHandshake::start(crate::keys::DeviceId::from_bytes([1; 16]), 1, &rng).unwrap();
        let target = PushTarget {
            endpoint: "https://web.push.apple.com/abc".into(),
            p256dh: b64::encode(&hello.ephemeral),
            auth: b64::encode(&[3u8; 16]),
        };
        let ev = json!({"kind": "turn_completed", "text": "secret prompt text"});
        let key = crate::keys::DeviceSecret::from_bytes([5; 32]).node_key("m");
        let signer = PushSigner { generation: 2, key: &key };
        let f = push_send_frame("m", &ev, PushState::Review, &target, signer, 1_000, &rng).unwrap();
        assert_eq!(f["type"], "push_send");
        assert_eq!(f["endpoint"], endpoint_hash(&target.endpoint));
        assert_eq!(f["urgency"], "normal");
        assert_eq!(f["ttl"], PUSH_TTL_SECS);
        let text = f.to_string();
        assert!(!text.contains("web.push.apple.com") && !text.contains("secret prompt"), "nothing readable leaks: {text}");
        assert_eq!(push_send_frame("m", &ev, PushState::Question, &target, signer, 1_000, &rng).unwrap()["urgency"], "high");
        let bad = PushTarget { p256dh: "AA".into(), ..target };
        assert!(push_send_frame("m", &ev, PushState::Review, &bad, signer, 1_000, &rng).is_err());
    }

    #[test]
    fn a_push_is_signed_by_its_node_and_only_verifies_with_that_nodes_key() {
        let secret = crate::keys::DeviceSecret::from_bytes([5; 32]);
        let (mac, server) = (secret.node_key("mac"), secret.node_key("server"));
        let ev = json!({"kind": "needs_attention", "conversationId": "c1"});
        let p = signed_payload("mac", &ev, PushState::Question, PushSigner { generation: 2, key: &mac }, 7, "id-1");
        assert_eq!((p["data"]["g"].clone(), p["data"]["at"].clone(), p["data"]["id"].clone()), (json!(2), json!(7), json!("id-1")));
        assert!(verify_push(&p, &mac));
        assert!(!verify_push(&p, &server), "another node's key does not verify it");
        // A server posing as the Mac signs with ITS key: the phone checks the Mac's.
        let forged = signed_payload("mac", &ev, PushState::Question, PushSigner { generation: 2, key: &server }, 7, "id-1");
        assert!(!verify_push(&forged, &mac));
        // Any edit to a covered field breaks it.
        for (path, value) in [("title", json!("Approve now")), ("tag", json!("conv:x")), ("body", json!("x"))] {
            let mut edited = p.clone();
            edited[path] = value;
            assert!(!verify_push(&edited, &mac), "{path}");
        }
        let mut edited = p.clone();
        edited["data"]["url"] = json!("https://evil.example");
        assert!(!verify_push(&edited, &mac));
        let mut edited = p.clone();
        edited["data"]["at"] = json!(8);
        assert!(!verify_push(&edited, &mac));
        assert!(!verify_push(&payload("mac", &ev, PushState::Question), &mac), "unsigned");
    }

    #[test]
    fn endpoint_hash_is_lowercase_hex_sha256() {
        // sha256("abc"), the FIPS 180-2 example.
        assert_eq!(endpoint_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn prefs_default_on_and_merge_only_known_booleans() {
        let p = PushPrefs::default().merged(&json!({"review": false, "error": "no", "other": false}));
        assert!(p.wants(PushState::Question) && p.wants(PushState::Error) && !p.wants(PushState::Review));
        assert_eq!(p.to_json(), json!({"question": true, "error": true, "review": false}));
    }
}
