//! Voice-agent credentials + session minting — the ONE module that touches the
//! user's OpenAI API key.
//!
//! The in-app voice agent (OpenAI Realtime, WebRTC from the webview) must never
//! hold the long-lived key: it lives in the macOS Keychain (written here with a
//! read-back check, mirroring the TOSSE credential store), and the front only
//! ever receives a SHORT-LIVED client secret minted server-side
//! (`POST /v1/realtime/client_secrets`), which is all WebRTC needs.
//!
//! Strictly OPTIONAL by design (Armand's constraint): with no key stored the
//! status reports `configured: false`, the UI locks the voice features behind
//! "add an OpenAI key", and nothing else in the app touches this module. No
//! background polling, no startup cost, no error — absence is a normal state.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Keychain identity of the stored key. Distinct service name so it can never
/// collide with the TOSSE credentials or Claude's own items.
const KEYCHAIN_SERVICE: &str = "Flight Deck OpenAI";
const KEYCHAIN_ACCOUNT: &str = "api-key";
const PRODUCTION_IDENTIFIER: &str = "com.tosse.desktop";

/// This build's bundle identifier, published once at setup (same discipline as
/// `tosse::set_bundle_identifier`). ⚠️ Without the per-identity suffix below, a
/// `/build-app` test build and the production app would read, overwrite (`-U`)
/// and delete the SAME Keychain item — the exact cross-talk bug class the TOSSE
/// store documents as previously shipped and fixed.
static BUNDLE_IDENTIFIER: Mutex<Option<String>> = Mutex::new(None);

pub fn set_bundle_identifier(identifier: String) {
    if let Ok(mut guard) = BUNDLE_IDENTIFIER.lock() {
        *guard = Some(identifier);
    }
}

/// The Keychain item name for THIS build: production keeps the bare name, every
/// other identity (dev build, per-feature test builds) gets its own suffixed item.
fn keychain_service() -> String {
    service_name_for(BUNDLE_IDENTIFIER.lock().ok().and_then(|g| g.clone()).as_deref())
}

/// The naming rule, split out for tests. `None` (identifier never published,
/// e.g. a unit test) keeps the production name.
fn service_name_for(identifier: Option<&str>) -> String {
    match identifier {
        Some(id) if id != PRODUCTION_IDENTIFIER => format!("{KEYCHAIN_SERVICE} ({id})"),
        _ => KEYCHAIN_SERVICE.to_string(),
    }
}

/// Realtime session defaults. The model is OpenAI's GA speech-to-speech model.
const REALTIME_MODEL: &str = "gpt-realtime";
const MINT_URL: &str = "https://api.openai.com/v1/realtime/client_secrets";

/// The voices the GA Realtime model can speak with, in the order the picker
/// shows them: the two purpose-built for `gpt-realtime` first (OpenAI's own
/// recommendation), then the earlier presets. This list is the ONE place that
/// decides what a valid voice is — the front passes a key, we sanitize it here,
/// so a stale preference can never reach OpenAI as a 400.
const VOICES: &[(&str, &str)] = &[
    ("marin", "Marin — warm, recommended"),
    ("cedar", "Cedar — calm, recommended"),
    ("alloy", "Alloy — neutral"),
    ("ash", "Ash — soft"),
    ("ballad", "Ballad — expressive"),
    ("coral", "Coral — bright"),
    ("echo", "Echo — even"),
    ("sage", "Sage — measured"),
    ("shimmer", "Shimmer — light"),
    ("verse", "Verse — narrative"),
];

/// The voice used when the user has never picked one (and the fallback for a
/// key we do not know).
const DEFAULT_VOICE: &str = "marin";

/// One entry of the voice picker (same shape as the wake-word phrase catalogue,
/// so Settings renders both the same way).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceOption {
    pub key: String,
    pub label: String,
}

fn voice_catalogue() -> Vec<VoiceOption> {
    VOICES
        .iter()
        .map(|(key, label)| VoiceOption { key: key.to_string(), label: label.to_string() })
        .collect()
}

/// Normalize a requested voice to a known key. An unknown / absent one falls
/// back to the default rather than failing the session: the voice is cosmetic,
/// and a mint that 400s would cost the user their whole voice session.
fn sanitize_voice(requested: Option<&str>) -> &'static str {
    let Some(want) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return DEFAULT_VOICE;
    };
    VOICES
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(want))
        .map(|(key, _)| *key)
        .unwrap_or(DEFAULT_VOICE)
}

/// What the Settings card needs to render the voice-agent state: whether a key
/// is stored, and a masked hint so the user can tell WHICH key without ever
/// seeing it again.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VoiceAgentStatus {
    pub configured: bool,
    /// e.g. `"sk-…d4f2"` — never more than the tail of the key.
    pub key_hint: Option<String>,
    /// The voices the picker can offer (the catalogue above — the front never
    /// hard-codes its own list).
    pub voices: Vec<VoiceOption>,
    /// The voice used when the user has not picked one.
    pub default_voice: String,
}

/// A short-lived Realtime client secret, safe to hand to the webview: it opens
/// exactly one WebRTC session and expires on its own.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClientSecret {
    pub value: String,
    /// Unix seconds, as reported by OpenAI.
    pub expires_at: i64,
    pub model: String,
    /// The voice this session will actually speak with — the sanitized answer to
    /// what was asked for, so the front never has to guess whether its stored
    /// preference survived.
    pub voice: String,
}

/// Mask a key down to its identifying tail (`sk-…d4f2`).
fn key_hint(key: &str) -> String {
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("sk-…{tail}")
}

/// Sanity-check a key BEFORE storing it. Deliberately loose (OpenAI key formats
/// evolve — `sk-`, `sk-proj-`, …): we only reject what can never be a key, and
/// let the first mint surface a wrong-but-plausible one as a clear 401.
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("the key is empty".to_string());
    }
    if key.len() < 20 {
        return Err("that is too short to be an OpenAI API key".to_string());
    }
    if key.chars().any(char::is_whitespace) {
        return Err("the key contains whitespace — check the copy/paste".to_string());
    }
    Ok(())
}

/// Store the key in the Keychain (`-U` = update in place), then VERIFY by
/// reading it back — "saved" must mean "stored intact", never a truncated item
/// discovered at the next session (same discipline as the TOSSE store).
pub fn set_key(key: &str) -> Result<VoiceAgentStatus, String> {
    let key = key.trim();
    validate_key(key)?;
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            &keychain_service(),
            "-a",
            KEYCHAIN_ACCOUNT,
            "-D",
            "Flight Deck voice-agent OpenAI key",
            "-w",
            key,
        ])
        .output()
        .map_err(|e| format!("failed to run /usr/bin/security: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Keychain write failed (exit {}): {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    match read_key() {
        Some(stored) if stored == key => Ok(status()),
        Some(_) => Err("the key came back altered after saving — not trusting the stored copy".to_string()),
        None => Err("the key vanished right after being saved".to_string()),
    }
}

/// Forget the stored key. An absent item is SUCCESS (the goal state), not an
/// error — only a real Keychain failure surfaces.
pub fn clear_key() -> Result<VoiceAgentStatus, String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-s", &keychain_service(), "-a", KEYCHAIN_ACCOUNT])
        .output()
        .map_err(|e| format!("failed to run /usr/bin/security: {e}"))?;
    // Exit 44 = item not found — already the state we want.
    if !out.status.success() && out.status.code() != Some(44) {
        return Err(format!(
            "Keychain delete failed (exit {}): {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(status())
}

/// Read the stored key, `None` when absent/denied (both read as "not
/// configured" — the UI's locked state; a denied ACL resolves itself the next
/// time macOS re-prompts).
fn read_key() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            &keychain_service(),
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!key.is_empty()).then_some(key)
}

/// The Settings read-back.
pub fn status() -> VoiceAgentStatus {
    let (configured, key_hint) = match read_key() {
        Some(key) => (true, Some(key_hint(&key))),
        None => (false, None),
    };
    VoiceAgentStatus {
        configured,
        key_hint,
        voices: voice_catalogue(),
        default_voice: DEFAULT_VOICE.to_string(),
    }
}

/// Mint a short-lived Realtime client secret for one voice session. The only
/// place the long-lived key is used; errors carry a response snippet but NEVER
/// the key itself.
///
/// ⚠️ The voice is fixed HERE, at mint time, for the whole session — the GA
/// Realtime API will not swap it once the model has produced audio. Changing the
/// preference therefore takes effect on the next session (the front re-arms an
/// idle one so the change is felt immediately).
pub async fn mint_client_secret(voice: Option<String>) -> Result<ClientSecret, String> {
    let Some(key) = read_key() else {
        return Err("no OpenAI key configured — add one in Settings → Control".to_string());
    };
    ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client build failed: {e}"))?;
    let body = serde_json::json!({
        "session": {
            "type": "realtime",
            "model": REALTIME_MODEL,
            "audio": { "output": { "voice": sanitize_voice(voice.as_deref()) } }
        }
    });
    let resp = client
        .post(MINT_URL)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("could not reach OpenAI: {e}"))?;
    let status_code = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status_code == reqwest::StatusCode::UNAUTHORIZED {
        return Err("OpenAI rejected the key (401) — check it in Settings → Control".to_string());
    }
    if !status_code.is_success() {
        return Err(format!("OpenAI answered {status_code}: {}", snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("unreadable OpenAI response: {e}"))?;
    let value = parsed
        .get("value")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("no client secret in the OpenAI response: {}", snippet(&text)))?
        .to_string();
    let expires_at = parsed.get("expires_at").and_then(serde_json::Value::as_i64).unwrap_or(0);
    Ok(ClientSecret {
        value,
        expires_at,
        model: REALTIME_MODEL.to_string(),
        voice: sanitize_voice(voice.as_deref()).to_string(),
    })
}

/// First ~300 chars of a response body for error details (mirrors `usage/`).
fn snippet(body: &str) -> String {
    body.chars().take(300).collect()
}

/// reqwest is built with `rustls-no-provider`: install the process-wide `ring`
/// provider before the first client builds. Idempotent (no-op if the updater or
/// `usage/` already installed it).
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The hint shows only the tail — enough to recognize the key, never it.
    #[test]
    fn key_hint_masks_all_but_the_tail() {
        let hint = key_hint("sk-proj-abcdefghijklmnopqrstuvwx-d4f2");
        assert_eq!(hint, "sk-…d4f2");
        assert!(!hint.contains("abcdef"));
    }

    /// A voice the catalogue doesn't know (stale preference, typo, a voice OpenAI
    /// retired) degrades to the default instead of failing the whole session.
    #[test]
    fn unknown_voices_fall_back_to_the_default() {
        assert_eq!(sanitize_voice(Some("cedar")), "cedar");
        assert_eq!(sanitize_voice(Some("  Cedar  ")), "cedar");
        assert_eq!(sanitize_voice(Some("nope")), DEFAULT_VOICE);
        assert_eq!(sanitize_voice(Some("")), DEFAULT_VOICE);
        assert_eq!(sanitize_voice(None), DEFAULT_VOICE);
    }

    /// The picker's catalogue must contain the default — otherwise Settings would
    /// show a selection the user cannot reproduce.
    #[test]
    fn the_catalogue_holds_the_default_voice() {
        let catalogue = voice_catalogue();
        assert!(catalogue.iter().any(|v| v.key == DEFAULT_VOICE));
        assert!(catalogue.iter().all(|v| !v.label.is_empty()));
    }

    /// Validation rejects only the never-a-key shapes; plausible keys pass and
    /// let the first mint judge them (a 401 with a clear message).
    #[test]
    fn key_validation_is_loose_but_not_blind() {
        assert!(validate_key("").is_err());
        assert!(validate_key("sk-short").is_err());
        assert!(validate_key("sk-proj with space padding-here").is_err());
        assert!(validate_key("sk-proj-abcdefghijklmnopqrstuvwxyz012345").is_ok());
        // Unknown future prefixes must not be rejected on format alone.
        assert!(validate_key("op-key-abcdefghijklmnopqrstuvwxyz").is_ok());
    }
}
