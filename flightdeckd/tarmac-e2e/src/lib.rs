//! Tarmac sealed channel: the end-to-end layer between a paired phone and a
//! Flight Deck node (the Mac or a `flightdeckd` daemon), so the relay in between
//! only ever routes ciphertext it can neither read, alter, forge nor replay.
//!
//! Contract: `docs/tarmac-sealed-channel.md` (destined for Tarmac's
//! `PROTOCOL.md`). Every byte layout below is part of that contract: the PWA
//! re-implements it with WebCrypto, and `vectors/` pins the two together.
//!
//! - [`keys`]: device secret, per-node key derivation, ids and relay tokens.
//! - [`handshake`]: PSK + ephemeral ECDH P-256, one per phone socket.
//! - [`session`]: AES-256-GCM sealed frames with per-direction counters.
//! - [`node`]: a node's table of sessions, one per phone socket (`_cid`).
//! - [`push`]: which events notify, and the notification payload.
//! - [`webpush`]: RFC 8291 payload encryption, so a node seals its own pushes.
//!
//! Shared by `src-tauri` and `flightdeckd` as a path dependency. It lives under
//! `flightdeckd/` because the daemon's musl build mounts only that directory
//! (`scripts/build-musl.sh`); it moves to the repo root with everything else
//! when the repo becomes a Cargo workspace (`docs/MONOREPO-MOVE.md`).

pub mod b64;
pub mod handshake;
pub mod keys;
pub mod node;
pub mod push;
pub mod session;
pub mod webpush;

mod kdf;

/// The randomness source callers hand to the minting and handshake functions.
pub mod rand {
    pub use ring::rand::{SecureRandom, SystemRandom};
}
#[cfg(test)]
mod vectors;

use std::fmt;

/// Version label bound into every derivation, transcript and AAD.
pub const LABEL: &str = "tarmac-e2e/v1";

/// The `v` field carried by the handshake frames.
pub const VERSION: u64 = 1;

/// Everything that can go wrong in this crate. None of these is ever a reason
/// to act on a frame: the caller drops it (and counts it, see
/// [`session::Session::should_close`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// A frame or field does not have the expected shape.
    Malformed(&'static str),
    /// A cryptographic operation failed: invalid peer public key, or a
    /// ciphertext that does not authenticate under the session key.
    Crypto,
    /// The node's handshake proof does not verify: it does not hold this
    /// device's key for this node (the relay answered in its place).
    BadProof,
    /// A sealed frame whose counter is not above the last one accepted.
    Replay {
        /// Counter carried by the rejected frame.
        n: u64,
        /// Highest counter accepted so far in this direction.
        last: u64,
    },
    /// The sending counter reached the protocol maximum; the session must be
    /// re-established.
    CounterExhausted,
    /// A payload larger than the protocol allows.
    TooLarge {
        /// Size that was offered.
        len: usize,
        /// Maximum allowed.
        max: usize,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Malformed(what) => write!(f, "malformed sealed-channel frame: {what}"),
            Error::Crypto => f.write_str("sealed-channel frame failed authentication"),
            Error::BadProof => f.write_str("the node's handshake proof does not verify"),
            Error::Replay { n, last } => {
                write!(f, "sealed-channel frame replayed or reordered (n={n}, last={last})")
            }
            Error::CounterExhausted => f.write_str("sealed-channel counter exhausted"),
            Error::TooLarge { len, max } => {
                write!(f, "sealed-channel payload too large ({len} > {max} bytes)")
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<ring::error::Unspecified> for Error {
    fn from(_: ring::error::Unspecified) -> Self {
        Error::Crypto
    }
}
