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
/// Key generations a node keeps per device: the current one and the one it replaces
/// (a phone still on the old one until it hears of the new).
pub const MAX_KEY_GENERATIONS: usize = 2;

/// When a generation issued at `issued_at_ms` is due for renewal.
pub fn renew_after_ms(issued_at_ms: i64) -> i64 {
    issued_at_ms.saturating_add(RENEW_AFTER_MS)
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
