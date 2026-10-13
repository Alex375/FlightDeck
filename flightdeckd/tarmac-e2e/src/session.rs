//! Sealed frames (contract §5): `{type:"e2e", n, c}`.
//!
//! AES-256-GCM, one key per direction, nonce = `0x00000000 ‖ u64be(n)`, AAD =
//! `"tarmac-e2e/v1/up"` (phone → node) or `"tarmac-e2e/v1/down"` (node → phone).
//! `n` starts at 0 and strictly increases per direction; the receiver drops any
//! `n` not above the last one it accepted (gaps are fine: the relay may drop a
//! frame, and each frame stands alone). The plaintext is an existing app frame
//! (`rpc`, `rpc_result`, `event`…), byte for byte.

use std::fmt;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use serde_json::{json, Value};

use crate::{b64, Error};

/// Largest counter: the PWA reads `n` as a JavaScript number, exact up to 2^53 − 1.
pub const MAX_COUNTER: u64 = (1 << 53) - 1;

/// Largest plaintext a sealed frame may carry. With the GCM tag and base64 it
/// stays under the relay's 512 KiB frame cap.
pub const MAX_PLAINTEXT: usize = 384 * 1024;

/// Authentication failures (bad tag, replay) after which a session must be
/// dropped and the phone made to handshake again.
pub const MAX_FAILURES: u32 = 3;

const TAG_LEN: usize = 16;
const AAD_UP: &[u8] = b"tarmac-e2e/v1/up";
const AAD_DOWN: &[u8] = b"tarmac-e2e/v1/down";

/// Which end of the channel a [`Session`] belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The PWA: seals upward, opens downward.
    Phone,
    /// The Mac or a daemon: seals downward, opens upward.
    Node,
}

/// One sealed frame as it travels: counter + base64url ciphertext and tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// Per-direction counter (the AEAD nonce).
    pub n: u64,
    /// base64url(ciphertext ‖ 16-byte GCM tag).
    pub c: String,
}

impl Sealed {
    /// The wire frame `{type:"e2e", n, c}`. Routing fields (`_cid`) are the
    /// caller's to add, outside the seal, exactly as for cleartext frames.
    pub fn to_frame(&self) -> Value {
        json!({ "type": "e2e", "n": self.n, "c": self.c })
    }

    /// Parses `{type:"e2e", n, c}`, refusing anything else before any decoding.
    pub fn from_frame(frame: &Value) -> Result<Self, Error> {
        if frame.get("type").and_then(Value::as_str) != Some("e2e") {
            return Err(Error::Malformed("not an e2e frame"));
        }
        let n = frame.get("n").and_then(Value::as_u64).ok_or(Error::Malformed("counter"))?;
        if n > MAX_COUNTER {
            return Err(Error::Malformed("counter"));
        }
        let c = frame.get("c").and_then(Value::as_str).ok_or(Error::Malformed("ciphertext"))?;
        let max = b64::encoded_len(MAX_PLAINTEXT + TAG_LEN);
        if c.len() > max {
            return Err(Error::TooLarge { len: c.len(), max });
        }
        Ok(Self { n, c: c.to_owned() })
    }
}

/// An established channel between one phone socket and one node. Not `Clone`:
/// two copies would reuse nonces.
pub struct Session {
    seal_key: LessSafeKey,
    open_key: LessSafeKey,
    seal_aad: &'static [u8],
    open_aad: &'static [u8],
    next_n: u64,
    last_n: Option<u64>,
    failures: u32,
}

impl Session {
    /// Builds a session from the handshake's direction keys.
    pub(crate) fn new(role: Role, k_up: &[u8; 32], k_down: &[u8; 32]) -> Self {
        let key = |k: &[u8; 32]| {
            LessSafeKey::new(UnboundKey::new(&AES_256_GCM, k).expect("32-byte AES-256 key"))
        };
        let (seal_key, open_key, seal_aad, open_aad) = match role {
            Role::Phone => (key(k_up), key(k_down), AAD_UP, AAD_DOWN),
            Role::Node => (key(k_down), key(k_up), AAD_DOWN, AAD_UP),
        };
        Self { seal_key, open_key, seal_aad, open_aad, next_n: 0, last_n: None, failures: 0 }
    }

    /// Seals one app frame's bytes.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Sealed, Error> {
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(Error::TooLarge { len: plaintext.len(), max: MAX_PLAINTEXT });
        }
        if self.next_n > MAX_COUNTER {
            return Err(Error::CounterExhausted);
        }
        let n = self.next_n;
        let mut buf = Vec::with_capacity(plaintext.len() + TAG_LEN);
        buf.extend_from_slice(plaintext);
        self.seal_key.seal_in_place_append_tag(nonce(n), Aad::from(self.seal_aad), &mut buf)?;
        self.next_n += 1;
        Ok(Sealed { n, c: b64::encode(&buf) })
    }

    /// Seals a JSON app frame (the usual case).
    pub fn seal_json(&mut self, frame: &Value) -> Result<Sealed, Error> {
        self.seal(frame.to_string().as_bytes())
    }

    /// Opens one sealed frame. Every refusal (replay, bad tag, bad encoding)
    /// counts toward [`Session::should_close`]; the frame must then be dropped,
    /// never acted on.
    pub fn open(&mut self, sealed: &Sealed) -> Result<Vec<u8>, Error> {
        let result = self.try_open(sealed);
        if result.is_err() {
            self.failures = self.failures.saturating_add(1);
        }
        result
    }

    /// Opens one sealed frame and parses its plaintext as a JSON app frame.
    pub fn open_json(&mut self, sealed: &Sealed) -> Result<Value, Error> {
        let bytes = self.open(sealed)?;
        serde_json::from_slice(&bytes).map_err(|_| {
            self.failures = self.failures.saturating_add(1);
            Error::Malformed("sealed plaintext is not JSON")
        })
    }

    fn try_open(&mut self, sealed: &Sealed) -> Result<Vec<u8>, Error> {
        if sealed.n > MAX_COUNTER {
            return Err(Error::Malformed("counter"));
        }
        if let Some(last) = self.last_n {
            if sealed.n <= last {
                return Err(Error::Replay { n: sealed.n, last });
            }
        }
        let mut buf = b64::decode(&sealed.c, "ciphertext")?;
        if buf.len() < TAG_LEN || buf.len() > MAX_PLAINTEXT + TAG_LEN {
            return Err(Error::TooLarge { len: buf.len(), max: MAX_PLAINTEXT + TAG_LEN });
        }
        let len = self
            .open_key
            .open_in_place(nonce(sealed.n), Aad::from(self.open_aad), &mut buf)?
            .len();
        buf.truncate(len);
        self.last_n = Some(sealed.n);
        Ok(buf)
    }

    /// Authentication failures seen so far in this session.
    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// Whether the session has seen enough failures that it must be dropped.
    pub fn should_close(&self) -> bool {
        self.failures >= MAX_FAILURES
    }
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("next_n", &self.next_n)
            .field("last_n", &self.last_n)
            .field("failures", &self.failures)
            .finish_non_exhaustive()
    }
}

fn nonce(n: u64) -> Nonce {
    let mut bytes = [0u8; NONCE_LEN];
    bytes[4..].copy_from_slice(&n.to_be_bytes());
    Nonce::assume_unique_for_key(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Session, Session) {
        let (up, down) = ([1u8; 32], [2u8; 32]);
        (Session::new(Role::Phone, &up, &down), Session::new(Role::Node, &up, &down))
    }

    #[test]
    fn both_directions_round_trip() {
        let (mut phone, mut node) = pair();
        let up = phone.seal(b"{\"type\":\"rpc\"}").unwrap();
        assert_eq!(node.open(&up).unwrap(), b"{\"type\":\"rpc\"}");
        let down = node.seal_json(&json!({"type": "event"})).unwrap();
        assert_eq!(phone.open_json(&down).unwrap(), json!({"type": "event"}));
    }

    #[test]
    fn a_frame_cannot_be_reflected_back_to_its_sender() {
        // Same keys on both sides, but direction-bound keys + AAD make a
        // phone's own frame useless when the relay bounces it back.
        let (mut phone, _) = pair();
        let up = phone.seal(b"x").unwrap();
        assert_eq!(phone.open(&up), Err(Error::Crypto));
    }

    #[test]
    fn replays_and_reorders_are_refused_gaps_are_not() {
        let (mut phone, mut node) = pair();
        let f0 = phone.seal(b"0").unwrap();
        let f1 = phone.seal(b"1").unwrap();
        let f2 = phone.seal(b"2").unwrap();
        assert!(node.open(&f0).is_ok());
        assert!(node.open(&f2).is_ok(), "a dropped frame leaves a gap, which is fine");
        assert_eq!(node.open(&f1), Err(Error::Replay { n: 1, last: 2 }));
        assert_eq!(node.open(&f2), Err(Error::Replay { n: 2, last: 2 }));
    }

    #[test]
    fn a_tampered_frame_is_refused_and_counted() {
        let (mut phone, mut node) = pair();
        let mut f = phone.seal(b"hello").unwrap();
        let mut raw = b64::decode(&f.c, "c").unwrap();
        raw[0] ^= 1;
        f.c = b64::encode(&raw);
        assert_eq!(node.open(&f), Err(Error::Crypto));
        assert_eq!(node.failures(), 1);
        // A forged frame does not advance the counter: the genuine one still opens.
        let mut phone2 = pair().0;
        let genuine = phone2.seal(b"hello").unwrap();
        assert!(node.open(&genuine).is_ok());
    }

    #[test]
    fn a_counter_moved_to_another_slot_fails() {
        // The relay cannot renumber a frame: n is the nonce.
        let (mut phone, mut node) = pair();
        let mut f = phone.seal(b"x").unwrap();
        f.n = 5;
        assert_eq!(node.open(&f), Err(Error::Crypto));
    }

    #[test]
    fn three_failures_close_the_session() {
        let (_, mut node) = pair();
        let junk = Sealed { n: 0, c: b64::encode(&[0u8; 20]) };
        for _ in 0..MAX_FAILURES {
            assert!(!node.should_close());
            let _ = node.open(&junk);
        }
        assert!(node.should_close());
    }

    #[test]
    fn oversized_payloads_are_refused_both_ways() {
        let (mut phone, _) = pair();
        let big = vec![0u8; MAX_PLAINTEXT + 1];
        assert!(matches!(phone.seal(&big), Err(Error::TooLarge { .. })));
        let frame = json!({"type": "e2e", "n": 0, "c": "A".repeat(b64::encoded_len(MAX_PLAINTEXT + 17))});
        assert!(matches!(Sealed::from_frame(&frame), Err(Error::TooLarge { .. })));
    }

    #[test]
    fn frame_parsing_is_strict() {
        assert!(Sealed::from_frame(&json!({"type": "rpc", "n": 0, "c": ""})).is_err());
        assert!(Sealed::from_frame(&json!({"type": "e2e", "n": -1, "c": ""})).is_err());
        assert!(Sealed::from_frame(&json!({"type": "e2e", "n": MAX_COUNTER + 1, "c": ""})).is_err());
        assert!(Sealed::from_frame(&json!({"type": "e2e", "n": 0})).is_err());
        let s = Sealed { n: 3, c: "abc".into() };
        assert_eq!(Sealed::from_frame(&s.to_frame()).unwrap(), s);
    }

    #[test]
    fn the_counter_never_wraps() {
        let (mut phone, _) = pair();
        phone.next_n = MAX_COUNTER + 1;
        assert_eq!(phone.seal(b"x"), Err(Error::CounterExhausted));
    }
}
