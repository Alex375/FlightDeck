//! Device identity and key material (contract §3).
//!
//! The Mac mints a [`DeviceSecret`] per paired phone and hands it over only in
//! the QR fragment. Each node — the Mac itself or a daemon — authenticates the
//! phone with its own [`NodeKey`], derived from that secret and the node's
//! `macId`: a daemon is provisioned with its key alone, so a compromised server
//! can never pose as the phone to another node.

use std::fmt;

use ring::rand::SecureRandom;

use crate::kdf::hkdf_sha256;
use crate::{b64, Error, LABEL};

/// Length of a [`DeviceSecret`] and of a [`NodeKey`].
pub const KEY_LEN: usize = 32;
/// Length of a [`DeviceId`].
pub const DEVICE_ID_LEN: usize = 16;
/// Length of a relay token (see [`random_relay_token`]).
pub const RELAY_TOKEN_LEN: usize = 32;

/// How long a key generation is accepted (decision D2: 90 days).
pub const KEY_LIFETIME_MS: i64 = 90 * 24 * 3600 * 1000;
/// When a phone asks its issuer for the next generation (~30 days in).
pub const RENEW_AFTER_MS: i64 = 30 * 24 * 3600 * 1000;
/// Most devices a node keeps paired (the relay authorizes at most 64 phone tokens
/// per node; the issuer Mac and every daemon apply the same cap).
pub const MAX_DEVICES: usize = 32;
/// Key generations a node keeps per device: the current one and the one it replaces
/// (a phone still on the old one until it hears of the new).
pub const MAX_KEY_GENERATIONS: usize = 2;

/// How long the FIRST generation — the one the pairing QR carries — is accepted.
/// It is a bootstrap key: due for renewal at once, so the secret anyone may have
/// seen on screen, in a photo or in a clipboard is worthless once the phone has
/// connected; and a pairing that is never scanned dies on its own.
pub const BOOTSTRAP_LIFETIME_MS: i64 = 24 * 3600 * 1000;

/// How long generation `generation` is accepted once issued.
pub fn key_lifetime_ms(generation: u32) -> i64 {
    if generation <= 1 {
        BOOTSTRAP_LIFETIME_MS
    } else {
        KEY_LIFETIME_MS
    }
}

/// When generation `generation`, issued at `issued_at_ms`, is due for renewal: at
/// once for the bootstrap generation, ~30 days in for the others.
pub fn renew_after_ms(generation: u32, issued_at_ms: i64) -> i64 {
    if generation <= 1 {
        issued_at_ms
    } else {
        issued_at_ms.saturating_add(RENEW_AFTER_MS)
    }
}

/// One generation of a device's key, as the issuer's renewal rule reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenerationInfo {
    /// The generation number.
    pub generation: u32,
    /// When it was issued (ms since the Unix epoch).
    pub issued_at_ms: i64,
    /// When it stops being accepted.
    pub expires_at_ms: i64,
}

/// What the issuer answers to `renew_device` from a session on generation `g`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewDecision {
    /// Mint the next generation and hand it out.
    Mint,
    /// Hand out generation `n` again: it was minted for this device but never used
    /// yet (its reply may have been lost), and the asking session is on the one it
    /// replaces.
    Redeliver(u32),
    /// The newest generation is not due yet: nothing to hand out.
    NotDue,
    /// Refused: the asking session's generation is no longer the device's current
    /// one, or has expired. Only a session on the newest (or the one a still-unused
    /// newest replaces) may renew — otherwise an old secret (a photographed QR, an
    /// old backup) would buy fresh keys forever and lock the real phone out.
    Refuse,
}

/// The issuer's renewal rule. `book` is the device's generations (any order);
/// `session_generation` the one the asking session handshook with. A generation
/// older than the newest is pruned as soon as the newest is used (see the Mac's
/// `confirm_device_generation`), so when the book still holds one, the newest has
/// not been used yet.
pub fn renew_decision(book: &[GenerationInfo], session_generation: u32, now_ms: i64) -> RenewDecision {
    let Some(newest) = book.iter().max_by_key(|g| g.generation) else { return RenewDecision::Refuse };
    let Some(own) = book.iter().find(|g| g.generation == session_generation) else { return RenewDecision::Refuse };
    if own.expires_at_ms <= now_ms {
        return RenewDecision::Refuse;
    }
    if own.generation == newest.generation {
        return if now_ms >= renew_after_ms(newest.generation, newest.issued_at_ms) {
            RenewDecision::Mint
        } else {
            RenewDecision::NotDue
        };
    }
    if own.generation + 1 == newest.generation && newest.expires_at_ms > now_ms {
        return RenewDecision::Redeliver(newest.generation);
    }
    RenewDecision::Refuse
}

/// A paired phone's master secret for one key generation. Held by the Mac and
/// the phone only; never sent to the relay, never provisioned to a daemon.
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceSecret([u8; KEY_LEN]);

impl DeviceSecret {
    /// Mints a fresh secret.
    pub fn generate(rng: &dyn SecureRandom) -> Result<Self, Error> {
        let mut bytes = [0u8; KEY_LEN];
        rng.fill(&mut bytes)?;
        Ok(Self(bytes))
    }

    /// Wraps raw secret bytes.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Parses the base64url form used in the pairing link (`k=`) and in storage.
    pub fn from_b64(text: &str) -> Result<Self, Error> {
        b64::decode_exact(text, "device secret").map(Self)
    }

    /// The base64url form used in the pairing link and in storage.
    pub fn to_b64(&self) -> String {
        b64::encode(&self.0)
    }

    /// The key this device uses with the node `mac_id`:
    /// `HKDF-SHA256(ikm = S, salt = "tarmac-e2e/v1", info = "node:" ‖ macId, L = 32)`.
    pub fn node_key(&self, mac_id: &str) -> NodeKey {
        let mut key = [0u8; KEY_LEN];
        hkdf_sha256(LABEL.as_bytes(), &self.0, &[b"node:", mac_id.as_bytes()], &mut key);
        NodeKey(key)
    }
}

impl fmt::Debug for DeviceSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceSecret(..)")
    }
}

/// One node's key for one device and generation: the handshake's pre-shared
/// key. A daemon stores only this, never the [`DeviceSecret`] it comes from.
#[derive(Clone, PartialEq, Eq)]
pub struct NodeKey([u8; KEY_LEN]);

impl NodeKey {
    /// Wraps raw key bytes.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Parses the base64url form a daemon is provisioned with.
    pub fn from_b64(text: &str) -> Result<Self, Error> {
        b64::decode_exact(text, "node key").map(Self)
    }

    /// The base64url form a daemon is provisioned with.
    pub fn to_b64(&self) -> String {
        b64::encode(&self.0)
    }

    pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl fmt::Debug for NodeKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NodeKey(..)")
    }
}

/// A paired phone's id (`d`): random, not secret, stable for the device's life.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct DeviceId([u8; DEVICE_ID_LEN]);

impl DeviceId {
    /// Mints a fresh id.
    pub fn generate(rng: &dyn SecureRandom) -> Result<Self, Error> {
        let mut bytes = [0u8; DEVICE_ID_LEN];
        rng.fill(&mut bytes)?;
        Ok(Self(bytes))
    }

    /// Wraps raw id bytes.
    pub fn from_bytes(bytes: [u8; DEVICE_ID_LEN]) -> Self {
        Self(bytes)
    }

    /// Parses the base64url form carried by the pairing link and `e2e_hello`.
    pub fn from_b64(text: &str) -> Result<Self, Error> {
        b64::decode_exact(text, "device id").map(Self)
    }

    /// The base64url form carried by the pairing link and `e2e_hello`.
    pub fn to_b64(&self) -> String {
        b64::encode(&self.0)
    }

    pub(crate) fn as_bytes(&self) -> &[u8; DEVICE_ID_LEN] {
        &self.0
    }
}

impl fmt::Debug for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DeviceId({})", self.to_b64())
    }
}

/// Mints a relay token (`rt`): the phone's routing credential toward the
/// relay. The relay sees it by design, so it guards routing and abuse limits,
/// never the channel's security.
pub fn random_relay_token(rng: &dyn SecureRandom) -> Result<String, Error> {
    let mut bytes = [0u8; RELAY_TOKEN_LEN];
    rng.fill(&mut bytes)?;
    Ok(b64::encode(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_keys_differ_per_node_and_per_secret() {
        let s1 = DeviceSecret::from_bytes([1; KEY_LEN]);
        let s2 = DeviceSecret::from_bytes([2; KEY_LEN]);
        assert_ne!(s1.node_key("mac-a"), s1.node_key("mac-b"));
        assert_ne!(s1.node_key("mac-a"), s2.node_key("mac-a"));
        assert_eq!(s1.node_key("mac-a"), s1.node_key("mac-a"));
    }

    #[test]
    fn the_mac_id_is_bound_byte_for_byte() {
        // A prefix of the macId is a different node, never a collision.
        let s = DeviceSecret::from_bytes([7; KEY_LEN]);
        assert_ne!(s.node_key("abc"), s.node_key("abcd"));
    }

    #[test]
    fn secrets_never_print() {
        let s = DeviceSecret::from_bytes([9; KEY_LEN]);
        assert_eq!(format!("{s:?}"), "DeviceSecret(..)");
        assert_eq!(format!("{:?}", s.node_key("m")), "NodeKey(..)");
    }

    fn gen(generation: u32, issued_at_ms: i64) -> GenerationInfo {
        GenerationInfo { generation, issued_at_ms, expires_at_ms: issued_at_ms + key_lifetime_ms(generation) }
    }

    #[test]
    fn the_bootstrap_generation_is_short_lived_and_due_at_once() {
        assert_eq!(renew_after_ms(1, 50), 50);
        assert_eq!(key_lifetime_ms(1), BOOTSTRAP_LIFETIME_MS);
        assert_eq!(renew_after_ms(2, 50), 50 + RENEW_AFTER_MS);
        assert_eq!(key_lifetime_ms(2), KEY_LIFETIME_MS);
        assert_eq!(renew_decision(&[gen(1, 0)], 1, 1), RenewDecision::Mint);
    }

    #[test]
    fn only_the_current_holder_renews() {
        let book = [gen(2, 0), gen(3, 10)];
        // The newest's holder, before and after it is due.
        assert_eq!(renew_decision(&book, 3, 11), RenewDecision::NotDue);
        assert_eq!(renew_decision(&book, 3, 10 + RENEW_AFTER_MS), RenewDecision::Mint);
        // A session on the generation an unused newest replaces: the same key again.
        assert_eq!(renew_decision(&book, 2, 10 + RENEW_AFTER_MS), RenewDecision::Redeliver(3));
        // Unknown or expired generations never renew.
        assert_eq!(renew_decision(&book, 1, 11), RenewDecision::Refuse);
        assert_eq!(renew_decision(&book, 2, KEY_LIFETIME_MS), RenewDecision::Refuse);
        assert_eq!(renew_decision(&[], 1, 0), RenewDecision::Refuse);
        // Two generations behind (a book that kept a gap) is refused too.
        assert_eq!(renew_decision(&[gen(2, 0), gen(4, 10)], 2, 11), RenewDecision::Refuse);
    }

    #[test]
    fn encodings_round_trip_and_reject_wrong_lengths() {
        let s = DeviceSecret::from_bytes([3; KEY_LEN]);
        assert_eq!(DeviceSecret::from_b64(&s.to_b64()).unwrap(), s);
        let d = DeviceId::from_bytes([4; DEVICE_ID_LEN]);
        assert_eq!(DeviceId::from_b64(&d.to_b64()).unwrap(), d);
        assert!(DeviceSecret::from_b64(&d.to_b64()).is_err());
        assert!(DeviceId::from_b64(&s.to_b64()).is_err());
    }
}
