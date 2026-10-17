//! Remote-access secrets at rest — this Mac's relay identity (`meta.remote_mac_token`, the
//! token a rotation is moving to, the legacy shared phone token) and every sealed-channel
//! device's master secrets (`remote_device_keys.secret`).
//!
//! They stay in SQLite, ENCRYPTED (ChaCha20-Poly1305) under one 256-bit data key that lives
//! in the system keychain. On macOS that is the login Keychain reached through the NATIVE
//! Security framework (`SecItem*`), so the item's access list names this app: it reads the
//! key by its own code signature, any other process gets a Keychain prompt. That is the
//! point. The database is a plain file that every agent this app runs can read, and the
//! secrets this app already keeps in the Keychain go through `/usr/bin/security`, whose
//! access list lets any process of the user read them back (`tosse/mod.rs`) — copying these
//! secrets there would have protected nothing.
//!
//! One key rather than one Keychain item per secret: a device's keys are written in the same
//! SQLite transaction as the rest of its record, a launch reads the Keychain once, and an
//! access list that ever stops matching (a re-signed build) costs one prompt, not sixty-four.
//!
//! What it does not cover: the relay tokens a phone connects with (`remote_devices.
//! relay_token`, the revocation queues) stay in clear — one opens a relay socket, never a
//! sealed session. A process that can run code INSIDE this app reads everything, as before.
//!
//! On Linux the key goes to the Secret Service ([`crate::linux_secrets`]), like the other
//! secrets there; elsewhere there is no keychain yet and secrets stay as written
//! ([`SecretVault::Plain`]).

use std::fmt;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use tarmac_e2e::b64;

/// Prefix of a sealed value: `fdv1:` + base64url(nonce ‖ ciphertext ‖ tag). A stored value
/// without it is plaintext written before this build — sealed in place at launch.
pub const SEALED_PREFIX: &str = "fdv1:";

/// Keychain identity of the data key. Production keeps the bare service name; every other
/// build identity gets its own item (same rule as `voice::service_name_for`), so a test build
/// never reads or replaces production's key.
const KEYCHAIN_SERVICE: &str = "Flight Deck remote-access key";
const KEYCHAIN_ACCOUNT: &str = "data-key";
const PRODUCTION_IDENTIFIER: &str = "com.tosse.desktop";

/// Whether `stored` is a sealed value (as opposed to legacy plaintext, or empty).
pub fn is_sealed(stored: &str) -> bool {
    stored.starts_with(SEALED_PREFIX)
}

/// A secret that could not be sealed or opened, in words the user can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultError(pub String);

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for VaultError {}

/// ChaCha20-Poly1305 under the data key. Every value is bound to its SLOT (`aad`: a meta key,
/// or a device key's id and generation), so a ciphertext copied into another row never opens.
pub struct SecretCipher {
    key: LessSafeKey,
    rng: SystemRandom,
}

impl SecretCipher {
    pub fn new(key: &[u8; 32]) -> Self {
        let unbound = UnboundKey::new(&CHACHA20_POLY1305, key).expect("a 32-byte key is a valid ChaCha20 key");
        Self { key: LessSafeKey::new(unbound), rng: SystemRandom::new() }
    }

    pub fn seal(&self, slot: &str, plaintext: &str) -> Result<String, VaultError> {
        let mut nonce = [0u8; NONCE_LEN];
        self.rng.fill(&mut nonce).map_err(|_| VaultError("the system random generator failed".into()))?;
        let mut sealed = plaintext.as_bytes().to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(slot.as_bytes()), &mut sealed)
            .map_err(|_| VaultError("could not encrypt a secret".into()))?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&sealed);
        Ok(format!("{SEALED_PREFIX}{}", b64::encode(&out)))
    }

    pub fn open(&self, slot: &str, stored: &str) -> Result<String, VaultError> {
        let corrupt = || VaultError(format!("a stored secret ({slot}) does not open with this Mac's key — it is corrupt or from another database"));
        let body = stored.strip_prefix(SEALED_PREFIX).ok_or_else(corrupt)?;
        let raw = b64::decode(body, "sealed secret").map_err(|_| corrupt())?;
        if raw.len() < NONCE_LEN {
            return Err(corrupt());
        }
        let (nonce, sealed) = raw.split_at(NONCE_LEN);
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| corrupt())?;
        let mut sealed = sealed.to_vec();
        let plain = self.key.open_in_place(nonce, Aad::from(slot.as_bytes()), &mut sealed).map_err(|_| corrupt())?;
        String::from_utf8(plain.to_vec()).map_err(|_| corrupt())
    }
}

/// How the store treats secrets.
pub enum SecretVault {
    /// No keychain on this platform, or a test store: secrets are kept as written.
    Plain,
    /// The data key is loaded: secrets are sealed on write, opened on read.
    Sealed(SecretCipher),
    /// The data key could not be loaded. Sealed secrets stay closed and no secret is written
    /// (never in clear next to sealed ones). `lost`: the key is GONE while the database still
    /// holds secrets sealed with it — nothing will ever open them again, which only a reset
    /// of remote access gets out of (the other reasons can pass: a locked keychain, a denied
    /// prompt).
    Unavailable { reason: String, lost: bool },
}

impl SecretVault {
    pub fn seal(&self, slot: &str, plaintext: &str) -> Result<String, VaultError> {
        // Empty means "none" (a retired legacy token): nothing to protect, and it must read
        // back as empty without a key.
        if plaintext.is_empty() {
            return Ok(String::new());
        }
        match self {
            SecretVault::Plain => Ok(plaintext.to_string()),
            SecretVault::Sealed(cipher) => cipher.seal(slot, plaintext),
            SecretVault::Unavailable { reason, .. } => Err(VaultError(reason.clone())),
        }
    }

    pub fn open(&self, slot: &str, stored: &str) -> Result<String, VaultError> {
        if !is_sealed(stored) {
            return Ok(stored.to_string());
        }
        match self {
            SecretVault::Sealed(cipher) => cipher.open(slot, stored),
            SecretVault::Unavailable { reason, .. } => Err(VaultError(reason.clone())),
            SecretVault::Plain => Err(VaultError(
                "a stored secret is encrypted, but no keychain key is loaded on this build".into(),
            )),
        }
    }

    /// Why secrets can't be used right now, if they can't.
    pub fn problem(&self) -> Option<(&str, bool)> {
        match self {
            SecretVault::Unavailable { reason, lost } => Some((reason.as_str(), *lost)),
            _ => None,
        }
    }
}

/// The slot (AEAD associated data) of a `meta` secret.
pub fn meta_slot(key: &str) -> String {
    format!("meta:{key}")
}

/// The slot of one generation of a device's master secret.
pub fn device_key_slot(device_id: &str, generation: u32) -> String {
    format!("device_key:{device_id}:{generation}")
}

/// Where the data key lives. A trait so the decision logic ([`open_vault`]) is tested without
/// the real keychain — no test may touch it.
pub trait KeyStore {
    /// The stored key: `Ok(None)` ONLY when there is no such item.
    fn read(&self) -> Result<Option<[u8; 32]>, String>;
    fn write(&self, key: &[u8; 32]) -> Result<(), String>;
}

/// Load (or, on first use, create) the data key and say how the store must treat secrets.
/// `has_sealed`: the database already holds sealed secrets — a missing key is then a LOST
/// key, never replaced by a new one that would make them unreadable for good.
pub fn open_vault(keys: &dyn KeyStore, has_sealed: bool) -> SecretVault {
    match keys.read() {
        Ok(Some(key)) => SecretVault::Sealed(SecretCipher::new(&key)),
        Ok(None) if has_sealed => SecretVault::Unavailable {
            reason: "This Mac's remote-access secrets were encrypted with a keychain key that is gone \
                     (deleted, or this database comes from another Mac). They can't be read: reset remote \
                     access in Settings → Control, then pair your phones again."
                .into(),
            lost: true,
        },
        Ok(None) => {
            let mut key = [0u8; 32];
            if SystemRandom::new().fill(&mut key).is_err() {
                return unavailable("the system random generator failed".into());
            }
            // Written, then read back: a key that did not land would seal secrets nothing opens.
            match keys.write(&key).and_then(|_| keys.read()) {
                Ok(Some(stored)) if stored == key => SecretVault::Sealed(SecretCipher::new(&key)),
                Ok(_) => unavailable("the key came back altered or missing right after it was saved".into()),
                Err(e) => unavailable(e),
            }
        }
        Err(e) => unavailable(e),
    }
}

fn unavailable(cause: String) -> SecretVault {
    SecretVault::Unavailable {
        reason: format!("Flight Deck could not open its remote-access key in the keychain: {cause}"),
        lost: false,
    }
}

/// The keychain service name for build `identifier`.
fn service_name_for(identifier: &str) -> String {
    if identifier == PRODUCTION_IDENTIFIER {
        KEYCHAIN_SERVICE.to_string()
    } else {
        format!("{KEYCHAIN_SERVICE} ({identifier})")
    }
}

/// The platform keychain for build `identifier`, or `None` where there is none yet.
pub fn system_key_store(identifier: &str) -> Option<Box<dyn KeyStore>> {
    platform::store(service_name_for(identifier))
}

fn decode_key(text: &str) -> Result<[u8; 32], String> {
    b64::decode_exact::<32>(text.trim(), "remote-access key")
        .map_err(|_| "the stored remote-access key is malformed".to_string())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{decode_key, KeyStore, KEYCHAIN_ACCOUNT};
    use security_framework::passwords::{generic_password, set_generic_password, PasswordOptions};
    use tarmac_e2e::b64;

    /// `errSecItemNotFound`.
    const ITEM_NOT_FOUND: i32 = -25300;

    /// The login Keychain through `SecItem*`, called from this process: the item it creates
    /// trusts this app's signature only.
    struct Keychain {
        service: String,
    }

    impl KeyStore for Keychain {
        fn read(&self) -> Result<Option<[u8; 32]>, String> {
            match generic_password(PasswordOptions::new_generic_password(&self.service, KEYCHAIN_ACCOUNT)) {
                Ok(bytes) => {
                    let text = String::from_utf8(bytes).map_err(|_| "the stored remote-access key is malformed".to_string())?;
                    decode_key(&text).map(Some)
                }
                Err(e) if e.code() == ITEM_NOT_FOUND => Ok(None),
                Err(e) => Err(format!("{e} (OSStatus {})", e.code())),
            }
        }

        fn write(&self, key: &[u8; 32]) -> Result<(), String> {
            set_generic_password(&self.service, KEYCHAIN_ACCOUNT, b64::encode(key).as_bytes())
                .map_err(|e| format!("{e} (OSStatus {})", e.code()))
        }
    }

    pub(super) fn store(service: String) -> Option<Box<dyn KeyStore>> {
        Some(Box::new(Keychain { service }))
    }

    /// A REAL login-Keychain round trip through `SecItem*`: absent reads as `None` (the
    /// "not found" code is the one [`ITEM_NOT_FOUND`] names), written reads back. Ignored
    /// by default — it writes to the user's Keychain (then deletes the item). Run:
    /// `cargo test --lib -- --ignored --nocapture keychain_round_trip`.
    #[test]
    #[ignore = "writes to the login Keychain"]
    fn keychain_round_trip() {
        use security_framework::passwords::delete_generic_password;
        let service = "Flight Deck remote-access key (test probe)".to_string();
        let _ = delete_generic_password(&service, KEYCHAIN_ACCOUNT);
        let keys = Keychain { service: service.clone() };
        assert_eq!(keys.read().unwrap(), None);
        keys.write(&[9; 32]).unwrap();
        assert_eq!(keys.read().unwrap(), Some([9; 32]));
        keys.write(&[3; 32]).unwrap();
        assert_eq!(keys.read().unwrap(), Some([3; 32]), "a second write replaces the key");
        delete_generic_password(&service, KEYCHAIN_ACCOUNT).unwrap();
        assert_eq!(keys.read().unwrap(), None);
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{decode_key, KeyStore, KEYCHAIN_ACCOUNT};
    use tarmac_e2e::b64;

    struct SecretService {
        service: String,
    }

    impl KeyStore for SecretService {
        fn read(&self) -> Result<Option<[u8; 32]>, String> {
            crate::linux_secrets::read(&self.service, KEYCHAIN_ACCOUNT)?.map(|t| decode_key(&t)).transpose()
        }

        fn write(&self, key: &[u8; 32]) -> Result<(), String> {
            crate::linux_secrets::write(&self.service, KEYCHAIN_ACCOUNT, &b64::encode(key))
        }
    }

    pub(super) fn store(service: String) -> Option<Box<dyn KeyStore>> {
        Some(Box::new(SecretService { service }))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::KeyStore;

    pub(super) fn store(_service: String) -> Option<Box<dyn KeyStore>> {
        None
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// An in-memory keychain.
    #[derive(Default)]
    pub(crate) struct MemoryKeys {
        pub key: Mutex<Option<[u8; 32]>>,
        pub fail_read: Option<String>,
        pub fail_write: Option<String>,
    }

    impl KeyStore for MemoryKeys {
        fn read(&self) -> Result<Option<[u8; 32]>, String> {
            match &self.fail_read {
                Some(e) => Err(e.clone()),
                None => Ok(*self.key.lock().unwrap()),
            }
        }
        fn write(&self, key: &[u8; 32]) -> Result<(), String> {
            if let Some(e) = &self.fail_write {
                return Err(e.clone());
            }
            *self.key.lock().unwrap() = Some(*key);
            Ok(())
        }
    }

    pub(crate) fn test_vault() -> SecretVault {
        SecretVault::Sealed(SecretCipher::new(&[7; 32]))
    }

    #[test]
    fn a_sealed_secret_opens_only_in_its_slot_and_with_its_key() {
        let cipher = SecretCipher::new(&[1; 32]);
        let sealed = cipher.seal("meta:remote_mac_token", "mac-secret").unwrap();
        assert!(is_sealed(&sealed));
        assert!(!sealed.contains("mac-secret"));
        assert_eq!(cipher.open("meta:remote_mac_token", &sealed).unwrap(), "mac-secret");
        // Two seals of the same value differ (fresh nonce).
        assert_ne!(sealed, cipher.seal("meta:remote_mac_token", "mac-secret").unwrap());
        // Moved to another row, or opened with another key: refused, never garbage.
        assert!(cipher.open("meta:remote_phone_token", &sealed).is_err());
        assert!(SecretCipher::new(&[2; 32]).open("meta:remote_mac_token", &sealed).is_err());
        let mut tampered = sealed.clone();
        tampered.pop();
        tampered.push(if sealed.ends_with('A') { 'B' } else { 'A' });
        assert!(cipher.open("meta:remote_mac_token", &tampered).is_err());
    }

    #[test]
    fn plaintext_and_empty_values_read_back_as_they_are() {
        for vault in [SecretVault::Plain, test_vault(), SecretVault::Unavailable { reason: "x".into(), lost: false }] {
            assert_eq!(vault.open("s", "legacy-plain").unwrap(), "legacy-plain");
            assert_eq!(vault.open("s", "").unwrap(), "");
            assert_eq!(vault.seal("s", "").unwrap(), "", "empty stays empty (a retired token)");
        }
    }

    #[test]
    fn without_a_key_nothing_is_written_and_nothing_sealed_opens() {
        let down = SecretVault::Unavailable { reason: "the keychain is locked".into(), lost: false };
        let sealed = test_vault().seal("s", "v").unwrap();
        assert_eq!(down.seal("s", "v").unwrap_err().0, "the keychain is locked");
        assert_eq!(down.open("s", &sealed).unwrap_err().0, "the keychain is locked");
        assert!(SecretVault::Plain.open("s", &sealed).is_err(), "a sealed value never reads as its ciphertext");
    }

    #[test]
    fn the_first_launch_creates_the_key_and_the_next_one_reads_it() {
        let keys = MemoryKeys::default();
        let SecretVault::Sealed(first) = open_vault(&keys, false) else { panic!("sealed") };
        let sealed = first.seal("s", "v").unwrap();
        let SecretVault::Sealed(again) = open_vault(&keys, true) else { panic!("sealed") };
        assert_eq!(again.open("s", &sealed).unwrap(), "v");
    }

    #[test]
    fn a_missing_key_with_sealed_secrets_is_lost_and_never_replaced() {
        let keys = MemoryKeys::default();
        let vault = open_vault(&keys, true);
        assert!(matches!(vault, SecretVault::Unavailable { lost: true, .. }));
        assert!(keys.key.lock().unwrap().is_none(), "no new key over secrets it can't open");
    }

    #[test]
    fn a_keychain_error_is_unavailable_not_lost() {
        let keys = MemoryKeys { fail_read: Some("User interaction is not allowed.".into()), ..Default::default() };
        match open_vault(&keys, true) {
            SecretVault::Unavailable { reason, lost } => {
                assert!(!lost);
                assert!(reason.contains("User interaction is not allowed."), "{reason}");
            }
            _ => panic!("unavailable"),
        }
        let keys = MemoryKeys { fail_write: Some("denied".into()), ..Default::default() };
        assert!(matches!(open_vault(&keys, false), SecretVault::Unavailable { lost: false, .. }));
    }

    #[test]
    fn test_builds_get_their_own_keychain_item() {
        assert_eq!(service_name_for("com.tosse.desktop"), "Flight Deck remote-access key");
        assert_eq!(service_name_for("com.tosse.desktop.dev"), "Flight Deck remote-access key (com.tosse.desktop.dev)");
    }
}
