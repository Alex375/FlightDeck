//! This Mac's OWN local Tailscale state — read ON DEMAND, never polled. The one
//! question this module answers: "is Tailscale itself the reason a paired server
//! just went unreachable?" (CRM `c9bf1482` — the real incident had Tailscale off on
//! the Mac at first). It is a narrow, local-only complement to
//! `bootstrap::orchestrator::diagnose`'s REMOTE checks: this never touches the
//! network, only asks this machine's own `tailscale` client for its current backend
//! state.
//!
//! Deliberately bounded and gated: [`local_status`] never blocks longer than 2s and
//! never guesses — a spawn failure, a timeout, unparsable output, or a missing binary
//! all degrade to [`LocalTailscaleState::Unknown`], never a false "off" claim (that
//! would send someone hunting for a Tailscale problem that isn't there). Callers gate
//! it further on [`host_looks_like_tailnet`] first — a cheap, local, synchronous
//! check — so a LAN or public server never pays for a `tailscale` subprocess at all.

use std::time::Duration;

use serde::Deserialize;

/// This Mac's local Tailscale backend state, as last observed by [`local_status`].
/// Never sent over IPC on its own (see that function's doc) — purely an internal
/// signal folded into [`crate::bootstrap::orchestrator::ServerDiagnosis::
/// tailscale_off_locally`] and the live reconnect notice's Tailscale clause.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalTailscaleState {
    /// The backend is up (`Running`/`Starting`/`InUseOtherUser` — all "on" for this
    /// purpose: the daemon is doing something other than sitting stopped).
    Running,
    /// The backend is confirmed stopped (`Stopped`/`NeedsLogin`/`NeedsMachineAuth`) —
    /// the one POSITIVE signal this module ever reports.
    NotRunning,
    /// Reserved: nothing in [`local_status`] currently distinguishes "no `tailscale`
    /// binary anywhere" from any other spawn failure — both degrade to
    /// [`Self::Unknown`] today (see that function's doc), never a guessed
    /// [`Self::NotRunning`]. Kept as its own variant for a future caller that CAN
    /// tell the two apart.
    NotInstalled,
    /// Nothing was confirmed either way (spawn failed, the binary was missing, the
    /// 2s deadline elapsed, or the output could not be parsed). The safe default —
    /// never treated as "off".
    Unknown,
}

/// Does `host` LOOK like a Tailscale address — the CGNAT range Tailscale assigns
/// (`100.64.0.0/10`, IPv4 only) or a `*.ts.net` MagicDNS name (case-insensitive)?
/// Pure, synchronous, no network — cheap enough to run unconditionally before ever
/// touching the local `tailscale` binary, so a LAN/public server's outage never pays
/// for [`local_status`] at all.
pub fn host_looks_like_tailnet(host: &str) -> bool {
    if host.to_lowercase().ends_with(".ts.net") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        let o = ip.octets();
        // 100.64.0.0/10: the fixed first octet 100, and the second octet's top 6
        // bits fixed at 01 — i.e. the second octet in 64..=127.
        return o[0] == 100 && (64..=127).contains(&o[1]);
    }
    false
}

/// The one field this module reads out of `tailscale status --json` — every other
/// field is ignored (serde drops unknown keys by default).
#[derive(Debug, Deserialize)]
struct TailscaleStatusJson {
    #[serde(rename = "BackendState")]
    backend_state: Option<String>,
}

/// Pure JSON half of [`local_status`], separated so it is directly testable against
/// canned output with no subprocess involved. `stdout` need not even be well-formed —
/// any parse failure (empty string, garbled JSON, a missing/unrecognized
/// `BackendState`) degrades to [`LocalTailscaleState::Unknown`].
fn parse_backend_state(stdout: &str) -> LocalTailscaleState {
    let Ok(v) = serde_json::from_str::<TailscaleStatusJson>(stdout) else {
        return LocalTailscaleState::Unknown;
    };
    // Real values observed live on this dev Mac (19/09): `Running`/`Stopped`/
    // `NeedsLogin`/`NeedsMachineAuth`/`Starting`/`InUseOtherUser`/`NoState`.
    match v.backend_state.as_deref() {
        Some("Stopped") | Some("NeedsLogin") | Some("NeedsMachineAuth") => LocalTailscaleState::NotRunning,
        Some("Running") | Some("Starting") | Some("InUseOtherUser") => LocalTailscaleState::Running,
        _ => LocalTailscaleState::Unknown,
    }
}

/// The standalone macOS app bundle's own binary — tried FIRST. Confirmed live on this
/// dev Mac: `/usr/local/bin/tailscale` is only a shell shim the app installs
/// conditionally (a user setting), so it cannot be relied on via `PATH` alone; the
/// bundle's binary is always there once the app is installed.
const STANDALONE_TAILSCALE_BIN: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/// Runs `<bin> status --self --peers=false --json`, `None` on any spawn failure
/// (binary missing, not executable, …) — never a distinct error type, since every
/// caller here only ever wants to know whether output is available to parse.
/// `tokio::process::Command`, never `std::process::Command`: this can run inside
/// `supervisor::session::run_actor`'s own tokio task, where a blocking spawn+wait
/// would stall that session's whole actor loop.
async fn run_status(bin: &str) -> Option<std::process::Output> {
    tokio::process::Command::new(bin)
        .args(["status", "--self", "--peers=false", "--json"])
        .output()
        .await
        .ok()
}

/// This Mac's local Tailscale state right now, bounded at a single 2s deadline
/// covering BOTH attempts below — this must never make a caller (in particular
/// `run_actor`'s reconnect loop) wait meaningfully longer than that. Tries the
/// standalone app bundle's binary first, falls back to bare `tailscale` on `PATH`
/// (a Homebrew/other install). The exit status is NOT checked before parsing:
/// `tailscale status --json` can exit non-zero while still printing a perfectly
/// valid, meaningful `BackendState` (e.g. `Stopped`) — gating on success first would
/// silently turn that positive signal into a false `Unknown`. Any failure along the
/// way (neither binary spawns, the deadline elapses, the output does not parse)
/// degrades to [`LocalTailscaleState::Unknown`] — see the module doc.
pub async fn local_status() -> LocalTailscaleState {
    let attempt = async {
        match run_status(STANDALONE_TAILSCALE_BIN).await {
            Some(out) => Some(out),
            None => run_status("tailscale").await,
        }
    };
    match tokio::time::timeout(Duration::from_secs(2), attempt).await {
        Ok(Some(out)) => parse_backend_state(&String::from_utf8_lossy(&out.stdout)),
        Ok(None) | Err(_) => LocalTailscaleState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_looks_like_tailnet_cgnat_boundaries() {
        assert!(host_looks_like_tailnet("100.64.0.1"));
        assert!(host_looks_like_tailnet("100.127.255.255"));
        assert!(!host_looks_like_tailnet("100.63.255.255"));
        assert!(!host_looks_like_tailnet("100.128.0.0"));
    }

    #[test]
    fn host_looks_like_tailnet_ts_net_suffix_case_insensitive() {
        assert!(host_looks_like_tailnet("foo.ts.net"));
        assert!(host_looks_like_tailnet("FOO.TS.NET"));
        assert!(host_looks_like_tailnet("my-box.tailnet-name.ts.net"));
    }

    #[test]
    fn host_looks_like_tailnet_false_for_ordinary_hosts() {
        assert!(!host_looks_like_tailnet("example.com"));
        assert!(!host_looks_like_tailnet("192.168.1.1"));
        assert!(!host_looks_like_tailnet(""));
    }

    #[test]
    fn parse_backend_state_maps_every_real_observed_value() {
        for (state, expected) in [
            ("Running", LocalTailscaleState::Running),
            ("Starting", LocalTailscaleState::Running),
            ("InUseOtherUser", LocalTailscaleState::Running),
            ("Stopped", LocalTailscaleState::NotRunning),
            ("NeedsLogin", LocalTailscaleState::NotRunning),
            ("NeedsMachineAuth", LocalTailscaleState::NotRunning),
            ("NoState", LocalTailscaleState::Unknown),
        ] {
            let stdout = format!(r#"{{"BackendState":"{state}"}}"#);
            assert_eq!(parse_backend_state(&stdout), expected, "state: {state}");
        }
    }

    #[test]
    fn parse_backend_state_malformed_or_empty_is_unknown_never_a_false_off() {
        assert_eq!(parse_backend_state(""), LocalTailscaleState::Unknown);
        assert_eq!(parse_backend_state("not json"), LocalTailscaleState::Unknown);
        assert_eq!(parse_backend_state("{}"), LocalTailscaleState::Unknown);
        assert_eq!(parse_backend_state(r#"{"BackendState":null}"#), LocalTailscaleState::Unknown);
    }

    #[test]
    fn run_status_against_a_missing_binary_is_none_not_a_panic() {
        // No async runtime needed beyond a plain block_on — this exercises the real
        // spawn-failure path with an absolute path that cannot exist.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt.block_on(run_status("/nonexistent/definitely-not-a-real-binary-xyz"));
        assert!(out.is_none());
    }

    /// Live: the real Tailscale install on a dev Mac, already confirmed `Running`
    /// this session (see the spec's live-test notes) — bounded, so it never hangs
    /// CI even if run there by mistake. `#[ignore]`d: depends on this machine's own
    /// Tailscale state, which a CI runner does not have.
    #[tokio::test]
    #[ignore]
    async fn live_local_status_against_the_real_tailscale_install() {
        let state = local_status().await;
        println!("[tailscale live test] local_status() = {state:?}");
        assert_ne!(state, LocalTailscaleState::NotInstalled, "this dev Mac has Tailscale installed");
    }
}
