//! Linux secret storage — the single service that reads and writes the app's secrets on
//! Linux (the TOSSE sign-in, the voice agent's OpenAI key), in the freedesktop Secret
//! Service (GNOME Keyring, KWallet…) through the `keyring` crate.
//!
//! The Linux counterpart of the macOS Keychain, which `tosse/` and `voice/` still reach
//! through `/usr/bin/security` on macOS: this module is compiled on Linux only, so nothing
//! here can change the Mac. Items are keyed by the SAME (service, account) pairs the Keychain
//! uses, so the per-build isolation (`tosse::keychain_service`) carries over unchanged.
//!
//! Contract, the same as the Keychain readers': [`read`] answers `Ok(None)` ONLY for "no such
//! item"; a store that cannot be reached or read is an `Err`, never an empty slate a caller
//! could overwrite real credentials with. No Secret Service running (a bare window manager,
//! a headless session) is such an error, worded so the user knows what is missing.

use keyring::{Entry, Error};

/// The stored secret for (`service`, `account`): `Ok(None)` when there is no such item.
pub fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(describe(&e)),
    }
}

/// Store (create or replace) the secret for (`service`, `account`).
pub fn write(service: &str, account: &str, secret: &str) -> Result<(), String> {
    entry(service, account)?.set_password(secret).map_err(|e| describe(&e))
}

/// Remove the secret for (`service`, `account`). An absent item is success: it is already
/// the state asked for.
pub fn delete(service: &str, account: &str) -> Result<(), String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(describe(&e)),
    }
}

fn entry(service: &str, account: &str) -> Result<Entry, String> {
    Entry::new(service, account).map_err(|e| describe(&e))
}

/// A `keyring` error in words a user can act on.
fn describe(e: &Error) -> String {
    match e {
        Error::NoStorageAccess(cause) => format!(
            "the system keyring is not available — Flight Deck stores secrets in the Secret \
             Service (GNOME Keyring, KWallet…); make sure one is installed, running and \
             unlocked ({cause})"
        ),
        Error::PlatformFailure(cause) => format!("the system keyring failed: {cause}"),
        Error::BadEncoding(_) => "the stored secret is not valid text".to_string(),
        Error::Ambiguous(found) => format!(
            "the system keyring holds {} matching items for this secret — remove the extra ones",
            found.len()
        ),
        other => format!("the system keyring refused the request: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_secret_service_says_what_to_install() {
        let msg = describe(&Error::NoStorageAccess("no D-Bus session".into()));
        assert!(msg.contains("Secret Service"), "{msg}");
        assert!(msg.contains("no D-Bus session"), "keeps the cause: {msg}");
    }

    /// A REAL Secret Service round-trip. Ignored by default: it needs a running, unlocked
    /// keyring daemon on a D-Bus session (a Linux desktop), which CI runners do not have.
    /// Run: `cargo test --lib -- --ignored --nocapture secret_service_round_trip`.
    #[test]
    #[ignore = "needs a running Secret Service (a Linux desktop session)"]
    fn secret_service_round_trip() {
        const SERVICE: &str = "Flight Deck (test probe)";
        // Bigger than the 128-char `getpass` cap that once truncated the macOS item.
        let secret = "x".repeat(600);
        delete(SERVICE, "probe").unwrap();
        assert_eq!(read(SERVICE, "probe").unwrap(), None, "absent reads as None");
        write(SERVICE, "probe", &secret).unwrap();
        assert_eq!(read(SERVICE, "probe").unwrap().as_deref(), Some(secret.as_str()));
        delete(SERVICE, "probe").unwrap();
        delete(SERVICE, "probe").unwrap(); // absent: still Ok
        assert_eq!(read(SERVICE, "probe").unwrap(), None);
    }
}
