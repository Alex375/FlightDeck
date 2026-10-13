//! The per-socket handshake (contract §4): a pre-shared [`NodeKey`] mixed with
//! an ephemeral ECDH P-256, in the spirit of TLS 1.3 `psk_dhe_ke`.
//!
//! ```text
//! phone → node  {type:"e2e_hello",  v:1, d, g, e, n}
//! node  → phone {type:"e2e_accept", v:1, e, n, p}     or {type:"e2e_reject", v:1, reason}
//!
//! TH   = SHA-256( lp("tarmac-e2e/v1") ‖ lp(macId) ‖ lp(d) ‖ lp(u32be(g))
//!                 ‖ lp(e_phone) ‖ lp(n_phone) ‖ lp(e_node) ‖ lp(n_node) )   lp(x) = u16be(len x) ‖ x
//! OKM  = HKDF-SHA256(salt = K_node, ikm = ECDH(e_phone, e_node), info = "keys" ‖ TH, L = 96)
//!      = k_up ‖ k_down ‖ k_conf
//! p    = HMAC-SHA256(k_conf, "node-accept" ‖ TH)
//! ```
//!
//! Without `K_node` the relay can run the ECDH but derive nothing, so it cannot
//! answer a hello (the phone checks `p`) nor speak for the phone (the node only
//! acts on frames that open under `k_up`). Fresh ephemerals per socket give
//! forward secrecy. `macId` is bound into the transcript, so a hello cannot be
//! redirected to another node.

use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::digest;
use ring::hmac;
use ring::rand::SecureRandom;
use serde_json::{json, Value};

use crate::kdf::hkdf_sha256;
use crate::keys::{DeviceId, NodeKey};
use crate::session::{Role, Session};
use crate::{b64, Error, LABEL, VERSION};

/// Length of an uncompressed P-256 public key (`0x04 ‖ x ‖ y`), as WebCrypto's
/// `exportKey("raw")` produces it.
pub const EPHEMERAL_LEN: usize = 65;
/// Length of each side's handshake nonce.
pub const NONCE_LEN: usize = 16;
/// Length of the node's proof `p`.
pub const PROOF_LEN: usize = 32;

/// The phone's opening frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    /// Which paired device this is (`d`).
    pub device_id: DeviceId,
    /// Which key generation the phone is using (`g`, ≥ 1).
    pub generation: u32,
    /// The phone's ephemeral public key (`e`).
    pub ephemeral: [u8; EPHEMERAL_LEN],
    /// The phone's nonce (`n`).
    pub nonce: [u8; NONCE_LEN],
}

impl Hello {
    /// The wire frame `{type:"e2e_hello", v, d, g, e, n}`.
    pub fn to_frame(&self) -> Value {
        json!({
            "type": "e2e_hello",
            "v": VERSION,
            "d": self.device_id.to_b64(),
            "g": self.generation,
            "e": b64::encode(&self.ephemeral),
            "n": b64::encode(&self.nonce),
        })
    }

    /// Parses an `e2e_hello` frame, refusing other versions.
    pub fn from_frame(frame: &Value) -> Result<Self, Error> {
        expect_type(frame, "e2e_hello")?;
        let generation = frame
            .get("g")
            .and_then(Value::as_u64)
            .and_then(|g| u32::try_from(g).ok())
            .filter(|g| *g >= 1)
            .ok_or(Error::Malformed("generation"))?;
        Ok(Self {
            device_id: DeviceId::from_b64(str_field(frame, "d")?)?,
            generation,
            ephemeral: b64::decode_exact(str_field(frame, "e")?, "ephemeral key")?,
            nonce: b64::decode_exact(str_field(frame, "n")?, "nonce")?,
        })
    }
}

/// The node's answer when it holds the device's key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accept {
    /// The node's ephemeral public key (`e`).
    pub ephemeral: [u8; EPHEMERAL_LEN],
    /// The node's nonce (`n`).
    pub nonce: [u8; NONCE_LEN],
    /// Proof that the node holds `K_node` (`p`).
    pub proof: [u8; PROOF_LEN],
}

impl Accept {
    /// The wire frame `{type:"e2e_accept", v, e, n, p}`.
    pub fn to_frame(&self) -> Value {
        json!({
            "type": "e2e_accept",
            "v": VERSION,
            "e": b64::encode(&self.ephemeral),
            "n": b64::encode(&self.nonce),
            "p": b64::encode(&self.proof),
        })
    }

    /// Parses an `e2e_accept` frame, refusing other versions.
    pub fn from_frame(frame: &Value) -> Result<Self, Error> {
        expect_type(frame, "e2e_accept")?;
        Ok(Self {
            ephemeral: b64::decode_exact(str_field(frame, "e")?, "ephemeral key")?,
            nonce: b64::decode_exact(str_field(frame, "n")?, "nonce")?,
            proof: b64::decode_exact(str_field(frame, "p")?, "proof")?,
        })
    }
}

/// Why a node refuses a hello. A reject is NOT authenticated (the relay can
/// forge one), so a phone shows it and never deletes keys because of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// The node has no record of this device: revoked, forgotten, or not
    /// provisioned on this node yet.
    UnknownDevice,
    /// The device is known but not under this generation (rotated away, or not
    /// yet provisioned with the new one): the phone retries its other one.
    UnknownGeneration,
    /// The generation is past its `expires_at`.
    Expired,
    /// Too many handshakes right now: retry later.
    Busy,
}

impl RejectReason {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            RejectReason::UnknownDevice => "unknown_device",
            RejectReason::UnknownGeneration => "unknown_generation",
            RejectReason::Expired => "expired",
            RejectReason::Busy => "busy",
        }
    }

    /// Parses the wire spelling; an unknown reason is `None` (shown verbatim).
    pub fn parse(reason: &str) -> Option<Self> {
        Some(match reason {
            "unknown_device" => RejectReason::UnknownDevice,
            "unknown_generation" => RejectReason::UnknownGeneration,
            "expired" => RejectReason::Expired,
            "busy" => RejectReason::Busy,
            _ => return None,
        })
    }

    /// The wire frame `{type:"e2e_reject", v, reason}`.
    pub fn to_frame(self) -> Value {
        json!({ "type": "e2e_reject", "v": VERSION, "reason": self.as_str() })
    }
}

/// Node side: answers a hello for which the caller found `key` (the device's
/// key for `generation` on this node). Returns the frame to send back and the
/// established session.
pub fn node_accept(
    hello: &Hello,
    mac_id: &str,
    key: &NodeKey,
    rng: &dyn SecureRandom,
) -> Result<(Accept, Session), Error> {
    let private = EphemeralPrivateKey::generate(&ECDH_P256, rng)?;
    let ephemeral = public_bytes(&private)?;
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce)?;
    let shared = agree(private, &hello.ephemeral)?;
    let th = transcript(
        mac_id,
        &hello.device_id,
        hello.generation,
        &hello.ephemeral,
        &hello.nonce,
        &ephemeral,
        &nonce,
    )?;
    let keys = derive(&shared, key, &th);
    let proof = node_proof(&keys.k_conf, &th);
    Ok((Accept { ephemeral, nonce, proof }, Session::new(Role::Node, &keys.k_up, &keys.k_down)))
}

/// Phone side of one handshake, between `e2e_hello` and `e2e_accept`.
pub struct PhoneHandshake {
    hello: Hello,
    private: EphemeralPrivateKey,
}

impl PhoneHandshake {
    /// Starts a handshake: returns the state to keep and the hello to send.
    pub fn start(
        device_id: DeviceId,
        generation: u32,
        rng: &dyn SecureRandom,
    ) -> Result<(Self, Hello), Error> {
        if generation == 0 {
            return Err(Error::Malformed("generation"));
        }
        let private = EphemeralPrivateKey::generate(&ECDH_P256, rng)?;
        let ephemeral = public_bytes(&private)?;
        let mut nonce = [0u8; NONCE_LEN];
        rng.fill(&mut nonce)?;
        let hello = Hello { device_id, generation, ephemeral, nonce };
        Ok((Self { hello: hello.clone(), private }, hello))
    }

    /// Completes the handshake against the node `mac_id`. Fails with
    /// [`Error::BadProof`] when whoever answered does not hold `key`.
    pub fn finish(self, accept: &Accept, mac_id: &str, key: &NodeKey) -> Result<Session, Error> {
        let shared = agree(self.private, &accept.ephemeral)?;
        let th = transcript(
            mac_id,
            &self.hello.device_id,
            self.hello.generation,
            &self.hello.ephemeral,
            &self.hello.nonce,
            &accept.ephemeral,
            &accept.nonce,
        )?;
        let keys = derive(&shared, key, &th);
        let mut msg = Vec::with_capacity(11 + th.len());
        msg.extend_from_slice(b"node-accept");
        msg.extend_from_slice(&th);
        hmac::verify(&hmac::Key::new(hmac::HMAC_SHA256, &keys.k_conf), &msg, &accept.proof)
            .map_err(|_| Error::BadProof)?;
        Ok(Session::new(Role::Phone, &keys.k_up, &keys.k_down))
    }
}

struct DerivedKeys {
    k_up: [u8; 32],
    k_down: [u8; 32],
    k_conf: [u8; 32],
}

fn derive(shared: &[u8], key: &NodeKey, th: &[u8; 32]) -> DerivedKeys {
    let mut okm = [0u8; 96];
    hkdf_sha256(key.as_bytes(), shared, &[b"keys", th], &mut okm);
    let part = |i: usize| -> [u8; 32] { okm[i * 32..(i + 1) * 32].try_into().expect("32 bytes") };
    DerivedKeys { k_up: part(0), k_down: part(1), k_conf: part(2) }
}

fn node_proof(k_conf: &[u8; 32], th: &[u8; 32]) -> [u8; PROOF_LEN] {
    let mut ctx = hmac::Context::with_key(&hmac::Key::new(hmac::HMAC_SHA256, k_conf));
    ctx.update(b"node-accept");
    ctx.update(th);
    ctx.sign().as_ref().try_into().expect("HMAC-SHA256 is 32 bytes")
}

fn transcript(
    mac_id: &str,
    device_id: &DeviceId,
    generation: u32,
    e_phone: &[u8],
    n_phone: &[u8],
    e_node: &[u8],
    n_node: &[u8],
) -> Result<[u8; 32], Error> {
    let mut ctx = digest::Context::new(&digest::SHA256);
    let g = generation.to_be_bytes();
    for field in [
        LABEL.as_bytes(),
        mac_id.as_bytes(),
        device_id.as_bytes(),
        &g,
        e_phone,
        n_phone,
        e_node,
        n_node,
    ] {
        let len = u16::try_from(field.len()).map_err(|_| Error::Malformed("transcript field"))?;
        ctx.update(&len.to_be_bytes());
        ctx.update(field);
    }
    Ok(ctx.finish().as_ref().try_into().expect("SHA-256 is 32 bytes"))
}

fn agree(private: EphemeralPrivateKey, peer: &[u8; EPHEMERAL_LEN]) -> Result<Vec<u8>, Error> {
    // ring validates that the peer's point is on the curve.
    Ok(agree_ephemeral(private, &UnparsedPublicKey::new(&ECDH_P256, peer), |s| s.to_vec())?)
}

fn public_bytes(private: &EphemeralPrivateKey) -> Result<[u8; EPHEMERAL_LEN], Error> {
    private
        .compute_public_key()?
        .as_ref()
        .try_into()
        .map_err(|_| Error::Malformed("ephemeral key"))
}

fn expect_type(frame: &Value, kind: &'static str) -> Result<(), Error> {
    if frame.get("type").and_then(Value::as_str) != Some(kind) {
        return Err(Error::Malformed(kind));
    }
    if frame.get("v").and_then(Value::as_u64) != Some(VERSION) {
        return Err(Error::Malformed("version"));
    }
    Ok(())
}

fn str_field<'a>(frame: &'a Value, key: &'static str) -> Result<&'a str, Error> {
    frame.get(key).and_then(Value::as_str).ok_or(Error::Malformed(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::DeviceSecret;
    use ring::rand::SystemRandom;

    const MAC: &str = "6f0c3a9e-9b1d-4c47-8f4e-1d2a3b4c5d6e";

    fn device() -> (DeviceId, DeviceSecret) {
        (DeviceId::from_bytes([0x11; 16]), DeviceSecret::from_bytes([0x22; 32]))
    }

    /// Runs a full handshake through the JSON frames, as the relay carries them.
    fn handshake(node_mac: &str, node_key: &NodeKey) -> Result<(Session, Session), Error> {
        let rng = SystemRandom::new();
        let (d, s) = device();
        let (phone_hs, hello) = PhoneHandshake::start(d, 1, &rng)?;
        let hello = Hello::from_frame(&hello.to_frame())?;
        let (accept, node) = node_accept(&hello, node_mac, node_key, &rng)?;
        let accept = Accept::from_frame(&accept.to_frame())?;
        let phone = phone_hs.finish(&accept, MAC, &s.node_key(MAC))?;
        Ok((phone, node))
    }

    #[test]
    fn a_node_with_the_right_key_establishes_a_working_channel() {
        let key = device().1.node_key(MAC);
        let (mut phone, mut node) = handshake(MAC, &key).unwrap();
        let up = phone.seal_json(&json!({"type": "rpc", "id": "r1", "method": "ping"})).unwrap();
        assert_eq!(node.open_json(&up).unwrap()["method"], "ping");
        let down = node.seal_json(&json!({"type": "rpc_result", "id": "r1"})).unwrap();
        assert_eq!(phone.open_json(&down).unwrap()["id"], "r1");
    }

    #[test]
    fn the_relay_without_the_key_cannot_answer_a_hello() {
        // It can run the ECDH, but its proof never verifies.
        let wrong = DeviceSecret::from_bytes([0x33; 32]).node_key(MAC);
        assert!(matches!(handshake(MAC, &wrong), Err(Error::BadProof)));
    }

    #[test]
    fn another_nodes_key_does_not_open_this_node() {
        // A compromised daemon holds its own K_node only.
        let other = device().1.node_key("some-other-node");
        assert!(matches!(handshake(MAC, &other), Err(Error::BadProof)));
    }

    #[test]
    fn a_hello_redirected_to_another_node_fails() {
        // The node binds ITS macId into the transcript; the phone binds the one
        // it meant to reach.
        let key = device().1.node_key(MAC);
        assert!(matches!(handshake("other-mac", &key), Err(Error::BadProof)));
    }

    #[test]
    fn a_tampered_accept_is_refused() {
        let rng = SystemRandom::new();
        let (d, s) = device();
        let (phone_hs, hello) = PhoneHandshake::start(d, 1, &rng).unwrap();
        let (mut accept, _) = node_accept(&hello, MAC, &s.node_key(MAC), &rng).unwrap();
        accept.nonce[0] ^= 1;
        assert!(matches!(phone_hs.finish(&accept, MAC, &s.node_key(MAC)), Err(Error::BadProof)));
    }

    #[test]
    fn an_invalid_peer_point_is_refused() {
        let rng = SystemRandom::new();
        let (d, s) = device();
        let (_, mut hello) = PhoneHandshake::start(d, 1, &rng).unwrap();
        hello.ephemeral = [0x04; EPHEMERAL_LEN];
        assert_eq!(node_accept(&hello, MAC, &s.node_key(MAC), &rng).err(), Some(Error::Crypto));
    }

    #[test]
    fn frames_refuse_other_versions_and_bad_fields() {
        let rng = SystemRandom::new();
        let (_, hello) = PhoneHandshake::start(device().0, 2, &rng).unwrap();
        let mut f = hello.to_frame();
        assert_eq!(Hello::from_frame(&f).unwrap(), hello);
        f["v"] = json!(2);
        assert_eq!(Hello::from_frame(&f), Err(Error::Malformed("version")));
        let mut f = hello.to_frame();
        f["g"] = json!(0);
        assert_eq!(Hello::from_frame(&f), Err(Error::Malformed("generation")));
        let mut f = hello.to_frame();
        f["e"] = json!("AAAA");
        assert_eq!(Hello::from_frame(&f), Err(Error::Malformed("ephemeral key")));
        assert!(PhoneHandshake::start(device().0, 0, &rng).is_err());
    }

    #[test]
    fn reject_reasons_round_trip() {
        for r in [
            RejectReason::UnknownDevice,
            RejectReason::UnknownGeneration,
            RejectReason::Expired,
            RejectReason::Busy,
        ] {
            let f = r.to_frame();
            assert_eq!(f["type"], "e2e_reject");
            assert_eq!(RejectReason::parse(f["reason"].as_str().unwrap()), Some(r));
        }
        assert_eq!(RejectReason::parse("something new"), None);
    }
}
