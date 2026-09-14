//! WHO an account is — its email address, organization and plan — read with THAT account's
//! own OAuth token.
//!
//! ## Why not `claude auth status`
//! `claude auth status` answers `email` / `orgName` from a profile cache in the CONFIG dir,
//! which every Flight Deck account deliberately SHARES (only the credential store is scoped
//! per account — see `accounts::slot`). With two accounts signed in it names whichever signed
//! in last. Asking the API with the account's own token cannot be confused that way: the
//! answer is about the token, so it is about the account.
//!
//! ## Contract (clean-room, read from the claude 2.1.263 bundle)
//! ```js
//! async function rge(e){ let t=`${BASE_API_URL}/api/oauth/profile`;
//!   let r=await at.get(t,{headers:{Authorization:`Bearer ${e}`,
//!     "Content-Type":"application/json","Cache-Control":"no-cache"},timeout:1e4}); … }
//! // consumer:
//! r = t?.organization?.organization_type
//! Cpe = new Map([["claude_max","max"],["claude_pro","pro"],
//!                ["claude_enterprise","enterprise"],["claude_team","team"]])
//! ```
//! No `anthropic-beta` header on this call (unlike the usage endpoint).
//!
//! VERIFIED live (probe `live_oauth_profile_has_an_address`): the profile carries the address
//! under **`account.email`** (account keys: `uuid, full_name, display_name, email,
//! has_claude_max, has_claude_pro, created_at`). ⚠️ Not `email_address` — that is the key of
//! the CLI's TOKEN-exchange response, an easy one to cross. `email_address` is still accepted
//! as a fallback so a drift between the two degrades to "the other key", not a blank
//! identity. Read-only, like the rest of this module: the token is used as-is and never
//! refreshed or written back.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{
    ensure_crypto_provider, now_unix_ms, read_oauth_token_for, reject_expired_token,
    rejected_token_error, snippet, UsageError, USER_AGENT,
};

const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";

/// The non-sensitive identity of one account, as the API reports it for that account's token.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub email: Option<String>,
    pub org_name: Option<String>,
    /// `max` | `pro` | `team` | `enterprise`, mapped exactly as the CLI maps
    /// `organization.organization_type`. `None` for a type the CLI does not name either.
    pub subscription_type: Option<String>,
}

/// Fetch one account's identity with its own token. Typed [`UsageError`] on failure, so the
/// UI can say what to do (sign in again, allow the Keychain item, …) instead of "unknown".
pub async fn fetch_profile_for(
    slot: &crate::accounts::AccountSlot,
) -> Result<AccountProfile, UsageError> {
    let slot = slot.clone();
    let creds = tokio::task::spawn_blocking(move || read_oauth_token_for(&slot))
        .await
        .map_err(|e| UsageError::Network {
            detail: format!("token read task failed: {e}"),
        })??;
    // Same expiry typing as the usage call: an idle account's lapsed token is not a revoked
    // sign-in, so it must not surface as the terminal `Unauthorized`.
    reject_expired_token(&creds, now_unix_ms())?;

    ensure_crypto_provider();
    // Fallible builder + explicit timeouts, for the same reasons as the usage call: a panic
    // would abort the app, and a stalled connection must not hang the command.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| UsageError::Network {
            detail: format!("HTTP client build failed: {e}"),
        })?;
    let resp = client
        .get(PROFILE_URL)
        .bearer_auth(&creds.access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| UsageError::Network { detail: e.to_string() })?;

    let status = resp.status();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let body = resp.text().await.map_err(|e| UsageError::Network {
        detail: format!("reading body failed: {e}"),
    })?;

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(rejected_token_error(status.as_u16(), &creds, now_unix_ms()));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(UsageError::RateLimited { retry_after });
    }
    if !status.is_success() {
        return Err(UsageError::Http {
            status: status.as_u16(),
            body: snippet(&body),
        });
    }
    parse_profile(&body).ok_or_else(|| UsageError::Parse {
        body: snippet(&body),
    })
}

/// Parse a profile body. `None` only when the body is not a JSON object at all; a missing
/// field is `None` on the profile, never a parse failure (an account can lack an org).
pub(crate) fn parse_profile(body: &str) -> Option<AccountProfile> {
    let v: Value = serde_json::from_str(body).ok()?;
    if !v.is_object() {
        return None;
    }
    let s = |x: &Value| x.as_str().filter(|t| !t.trim().is_empty()).map(str::to_string);
    let account = &v["account"];
    let org = &v["organization"];
    Some(AccountProfile {
        // `email` is the profile's key (verified live); `email_address` only as a fallback.
        email: s(&account["email"]).or_else(|| s(&account["email_address"])),
        org_name: s(&org["name"]),
        subscription_type: org["organization_type"].as_str().and_then(plan_for),
    })
}

/// The CLI's own `organization_type` → plan table, verbatim.
fn plan_for(organization_type: &str) -> Option<String> {
    match organization_type {
        "claude_max" => Some("max"),
        "claude_pro" => Some("pro"),
        "claude_enterprise" => Some("enterprise"),
        "claude_team" => Some("team"),
        _ => None,
    }
    .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_address_organization_and_plan() {
        // The live shape: the address lives under `account.email`.
        let p = parse_profile(
            r#"{"account":{"uuid":"u","email":"a@b.c","display_name":"A"},
                "organization":{"uuid":"o","name":"Acme","organization_type":"claude_max"}}"#,
        )
        .expect("an object parses");
        assert_eq!(p.email.as_deref(), Some("a@b.c"));
        assert_eq!(p.org_name.as_deref(), Some("Acme"));
        assert_eq!(p.subscription_type.as_deref(), Some("max"));
    }

    /// `email` is the profile's key; `email_address` (the token response's key) is the
    /// fallback, and `email` wins when both are present.
    #[test]
    fn prefers_email_and_falls_back_to_email_address() {
        let fallback = parse_profile(r#"{"account":{"email_address":"x@y.z"}}"#).unwrap();
        assert_eq!(fallback.email.as_deref(), Some("x@y.z"));
        let both = parse_profile(r#"{"account":{"email":"a@b.c","email_address":"x@y.z"}}"#).unwrap();
        assert_eq!(both.email.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn maps_every_plan_the_cli_names_and_nothing_else() {
        for (ty, plan) in [
            ("claude_max", Some("max")),
            ("claude_pro", Some("pro")),
            ("claude_team", Some("team")),
            ("claude_enterprise", Some("enterprise")),
            ("free", None),
        ] {
            let body = format!(r#"{{"organization":{{"organization_type":"{ty}"}}}}"#);
            assert_eq!(parse_profile(&body).unwrap().subscription_type.as_deref(), plan, "{ty}");
        }
    }

    /// Missing pieces are `None` on the profile, not a failure: the account is still known.
    #[test]
    fn missing_fields_are_none_and_non_objects_fail() {
        assert_eq!(parse_profile("{}"), Some(AccountProfile::default()));
        assert_eq!(parse_profile(r#"{"account":{"email_address":"  "}}"#).unwrap().email, None);
        assert_eq!(parse_profile("[]"), None);
        assert_eq!(parse_profile("not json"), None);
    }

    /// PROBE (read-only): the live profile for the DEFAULT account. Prints KEYS only (plus the
    /// organization type), never the address, and asserts that an address is found — the one
    /// thing this module exists for.
    /// Run: `cargo test --lib -- --ignored --nocapture live_oauth_profile_has_an_address`.
    #[tokio::test]
    #[ignore = "calls the real Anthropic profile endpoint"]
    async fn live_oauth_profile_has_an_address() {
        let slot = crate::accounts::AccountSlot::default_slot();
        let token = match tokio::task::spawn_blocking(move || read_oauth_token_for(&slot))
            .await
            .expect("token task")
        {
            Ok(c) => c.access_token,
            Err(e) => {
                eprintln!("SKIP: no usable token for the default account: {e:?}");
                return;
            }
        };
        ensure_crypto_provider();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("http client");
        let body = client
            .get(PROFILE_URL)
            .bearer_auth(&token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .send()
            .await
            .expect("profile request")
            .text()
            .await
            .expect("profile body");
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let keys = |o: &Value| {
            o.as_object()
                .map(|m| m.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        eprintln!("top-level keys = {:?}", keys(&v));
        eprintln!("account keys = {:?}", keys(&v["account"]));
        eprintln!("organization keys = {:?}", keys(&v["organization"]));
        eprintln!("organization_type = {}", v["organization"]["organization_type"]);
        let profile = parse_profile(&body).expect("the profile body is an object");
        assert!(profile.email.is_some(), "no address found in the live profile");
        eprintln!("address found; plan = {:?}", profile.subscription_type);
    }
}
