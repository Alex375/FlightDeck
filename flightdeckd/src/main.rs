//! flightdeckd — the Flight Deck server daemon.
//!
//! Owns detached `claude` sessions (they survive client disconnects) and
//! presents itself to the Flight Deck relay as a node so a phone drives the
//! server DIRECTLY (the Mac can be off). The Mac attaches over SSH through the
//! `attach` subcommand.
//!
//!   flightdeckd init      mint identity + config, print the phone pairing link
//!                         (`--no-phone-token`: no phone token, no link — the
//!                         Mac app authorizes its own with `add-phone`)
//!   flightdeckd run       the daemon (relay client + attach socket)
//!   flightdeckd attach    stdio bridge to a session (what the Mac runs via ssh)
//!   flightdeckd status    one-line JSON snapshot of the sessions
//!   flightdeckd add-phone / remove-phone   authorize / revoke a phone live
//!                         (`remove-phone --init-minted --keep -`: revoke the
//!                         token plain `init` minted, never the caller's own)
//!   flightdeckd whoami    this node's relay identity (no daemon needed)

mod attach;
mod config;
mod events;
mod frames;
mod registry;
mod relay;
mod replay;
mod rpc;
mod session;
#[cfg(test)]
mod testutil;
mod transcript;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use config::Config;
use std::path::PathBuf;

/// Bound on a graceful shutdown (every session's stop ladder is ~4 s at
/// worst). Keep the unit's TimeoutStopSec above it (20 s recommended).
const SHUTDOWN_WITHIN: std::time::Duration = std::time::Duration::from_secs(10);

const DEFAULT_RELAY: &str = "https://relay-production-8fd4.up.railway.app";

#[derive(Parser)]
#[command(name = "flightdeckd", version, about = "Flight Deck server daemon")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create ~/.flightdeckd/config.json with a fresh relay identity and a
    /// phone pairing token, then print the pairing link.
    Init {
        #[arg(long, default_value = DEFAULT_RELAY)]
        relay: String,
        #[arg(long)]
        label: Option<String>,
        /// Overwrite an existing config.
        #[arg(long)]
        force: bool,
        /// Authorize no phone and print no pairing link: for an installer that
        /// authorizes its own phone token afterwards (`add-phone`). Prints the
        /// node's identity instead, as `whoami` does.
        #[arg(long)]
        no_phone_token: bool,
    },
    /// Run the daemon.
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Bridge stdio to a session on the local daemon (run by the Mac over SSH).
    Attach {
        #[arg(long)]
        conversation: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long)]
        resume_session: Option<String>,
        #[arg(long)]
        epoch: Option<String>,
        #[arg(long, default_value_t = 0)]
        cursor: u64,
        #[arg(long)]
        socket: Option<PathBuf>,
        /// The client's title for the conversation (authoritative: it
        /// overwrites the daemon's; blank is ignored).
        #[arg(long)]
        title: Option<String>,
        /// The client understands `fd_skip`: the replay may leave out the
        /// partial-message deltas of messages it replays complete.
        #[arg(long)]
        supports_skip: bool,
        /// Everything after `--` is the claude argv used if the daemon must
        /// spawn the session.
        #[arg(last = true)]
        claude_args: Vec<String>,
    },
    /// Print a JSON snapshot of the daemon's sessions.
    Status {
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Stop one conversation's claude process (the Mac's explicit Stop path
    /// when its attach link is already gone).
    Stop {
        #[arg(long)]
        conversation: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Print the phone pairing link for the current config.
    Pairing {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Authorize a phone on this node: persisted to the config and pushed to
    /// the relay live by the running daemon.
    AddPhone {
        /// The phone's secret token. Recommended: `--token -` and the token on
        /// stdin — a value given here is visible to every user in `ps`.
        #[arg(long, value_name = "-|TOKEN")]
        token: String,
        #[arg(long, default_value = "")]
        label: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Revoke a phone on this node (persisted + pushed to the relay live).
    RemovePhone {
        /// The phone's secret token. Recommended: `--token -` and the token on
        /// stdin — a value given here is visible to every user in `ps`.
        #[arg(long, value_name = "-|TOKEN", required_unless_present = "init_minted", conflicts_with = "init_minted")]
        token: Option<String>,
        /// Instead of `--token`: revoke the phone token plain `init` minted
        /// (the first authorized token, still labelled "phone") — never the
        /// `--keep` one, nor any token added later with `add-phone`. Prints
        /// `{"type":"fd_init_phone_removed","ok":true,"removed":<0|1>}`.
        #[arg(long, requires = "keep")]
        init_minted: bool,
        /// With `--init-minted`: `-`, and the caller's own authorized phone
        /// token on stdin. Stdin only — a token never goes on the command line.
        #[arg(long, value_name = "-", requires = "init_minted")]
        keep: Option<String>,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Print this node's relay identity `{mac_id, relay_url, label}` as JSON,
    /// straight from the config (works without a running daemon; never prints
    /// a secret).
    Whoami {
        #[arg(long)]
        config: Option<PathBuf>,
    },
}

/// `--token -` reads the secret from stdin's first line. A token given on
/// the command line still works (compatibility) but is flagged: argv is
/// world-readable through `ps` / `/proc` for the process's lifetime.
fn token_arg(token: String) -> Result<String> {
    if token != "-" {
        eprintln!(
            "flightdeckd: warning: a phone token passed with --token <value> is visible to every \
             user on this machine (ps); prefer `--token -` with the token on stdin"
        );
        return Ok(token);
    }
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

/// `--keep -`: the caller's own token, from stdin only (argv is visible in `ps`).
fn keep_arg(keep: &str) -> Result<String> {
    if keep != "-" {
        anyhow::bail!("--keep takes `-` only: the phone token to keep is read from stdin, never the command line");
    }
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let token = line.trim().to_string();
    if token.is_empty() {
        anyhow::bail!("no phone token to keep on stdin");
    }
    Ok(token)
}

/// The node's relay identity — never a secret (`whoami`, `init --no-phone-token`).
fn identity_json(cfg: &Config) -> serde_json::Value {
    serde_json::json!({"mac_id": cfg.mac_id, "relay_url": cfg.relay_url, "label": cfg.label})
}

fn pairing_link(cfg: &Config) -> Option<String> {
    let token = cfg.phone_tokens.first()?;
    Some(format!(
        "{}/#macId={}&pt={}",
        cfg.relay_url.trim_end_matches('/'),
        cfg.mac_id,
        token.token
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Init { relay, label, force, no_phone_token } => {
            let path = config::default_config_path();
            // Held across check-and-write: a live daemon (phone tokens) or a
            // second `init` can't interleave with this one (see ConfigLock).
            config::harden_state_dir(&config::state_dir())?;
            let lock = config::ConfigLock::acquire(&path)?;
            if path.exists() && !force {
                anyhow::bail!("{} already exists (use --force to overwrite)", path.display());
            }
            let host = std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            // A token minted here and never handed to the caller would stay
            // authorized on the relay for good, invisible to whoever pairs
            // phones through `add-phone` — so `--no-phone-token` mints none.
            let phone_tokens = if no_phone_token {
                vec![]
            } else {
                vec![config::PhoneToken {
                    token: uuid::Uuid::new_v4().to_string(),
                    label: config::INIT_PHONE_LABEL.into(),
                    init_minted: true,
                }]
            };
            let cfg = Config {
                relay_url: relay,
                mac_id: uuid::Uuid::new_v4().to_string(),
                mac_token: uuid::Uuid::new_v4().to_string(),
                phone_tokens,
                revoked_phone_tokens: vec![],
                delivered_phone_revocations: vec![],
                label: label.or(host).unwrap_or_else(|| "flightdeckd".into()),
                default_workdir: None,
                claude_bin: "claude".into(),
                permission_mode: config::default_permission_mode(),
                // Provenance recorded from the start: `remove-phone --init-minted`
                // then goes by the token's flag, never by its label or place.
                init_phone_tracked: true,
            };
            cfg.save_locked(&path, &lock)?;
            drop(lock);
            if no_phone_token {
                println!("{}", identity_json(&cfg));
                return Ok(());
            }
            println!("config written to {}", path.display());
            println!("node label: {}", cfg.label);
            println!("macId:      {}", cfg.mac_id);
            if let Some(link) = pairing_link(&cfg) {
                println!("\nPair a phone by opening:\n\n  {link}\n");
            }
            Ok(())
        }
        Cmd::Run { config: cfg_path } => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "info".into()),
                )
                .init();
            let path = cfg_path.unwrap_or_else(config::default_config_path);
            config::harden_state_dir(&config::state_dir())?;
            config::harden_private_file(&path)?;
            let cfg = Config::load(&path)
                .with_context(|| "run `flightdeckd init` first to create the config")?;
            let registry = registry::Registry::open(&config::registry_path())?;
            let manager = session::SessionManager::new(cfg, registry, path);
            // Never the pairing link (it embeds a phone token): this goes to the
            // journal. `flightdeckd pairing` prints it on demand.
            let phones = manager.phones.lock().expect("phones lock").tokens.len();
            tracing::info!("node {} starting, {phones} phone(s) authorized", manager.cfg.mac_id);
            let socket = config::socket_path();
            let attach_srv = {
                let manager = manager.clone();
                let socket = socket.clone();
                tokio::spawn(async move { attach::serve(manager, &socket).await })
            };
            let relay_srv = {
                let manager = manager.clone();
                tokio::spawn(async move { relay::serve(manager).await })
            };
            // SIGTERM (systemctl stop/restart) exactly like SIGINT: the
            // sessions die with the daemon either way (their pipes are ours),
            // but through their stop ladder, with every attached client told
            // (fd_detach exited) — not by a SIGKILL of the whole cgroup.
            let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            let signal = tokio::select! {
                r = attach_srv => {
                    r?.context("attach server ended")?;
                    None
                }
                _ = relay_srv => None,
                _ = tokio::signal::ctrl_c() => Some("SIGINT"),
                _ = sigterm.recv() => Some("SIGTERM"),
            };
            if let Some(sig) = signal {
                tracing::info!("{sig}: stopping every session, then exiting");
                let left = manager.shutdown(SHUTDOWN_WITHIN).await;
                if left > 0 {
                    tracing::warn!("{left} session(s) still alive after {SHUTDOWN_WITHIN:?} — exiting anyway");
                }
                // Let the attach writers flush the fd_detach frames.
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                std::fs::remove_file(&socket).ok();
            }
            Ok(())
        }
        Cmd::Attach { conversation, cwd, resume_session, epoch, cursor, socket, title, supports_skip, claude_args } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            let params = attach::AttachArgs { conversation, cwd, resume_session, epoch, cursor, claude_args, title, supports_skip };
            attach::attach_client(&socket, params).await
        }
        Cmd::AddPhone { token, label, socket } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            println!("{}", attach::add_phone_client(&socket, &token_arg(token)?, &label).await?);
            Ok(())
        }
        Cmd::RemovePhone { token, init_minted, keep, socket } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            if init_minted {
                let keep = keep_arg(keep.as_deref().unwrap_or_default())?;
                println!("{}", attach::remove_init_phone_client(&socket, &keep).await?);
                return Ok(());
            }
            let token = token.context("--token is required")?;
            println!("{}", attach::remove_phone_client(&socket, &token_arg(token)?).await?);
            Ok(())
        }
        Cmd::Whoami { config: cfg_path } => {
            let path = cfg_path.unwrap_or_else(config::default_config_path);
            let cfg = Config::load(&path)?;
            println!("{}", identity_json(&cfg));
            Ok(())
        }
        Cmd::Status { socket } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            println!("{}", attach::status_client(&socket).await?);
            Ok(())
        }
        Cmd::Stop { conversation, socket } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            println!("{}", attach::stop_client(&socket, &conversation).await?);
            Ok(())
        }
        Cmd::Pairing { config: cfg_path } => {
            let path = cfg_path.unwrap_or_else(config::default_config_path);
            let cfg = Config::load(&path)?;
            match pairing_link(&cfg) {
                Some(link) => println!("{link}"),
                None => anyhow::bail!("no phone token in the config"),
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn init_takes_an_explicit_no_phone_token_flag() {
        let parse = |args: &[&str]| match Cli::try_parse_from(args).unwrap().cmd {
            Cmd::Init { no_phone_token, .. } => no_phone_token,
            _ => unreachable!(),
        };
        assert!(!parse(&["flightdeckd", "init"]), "plain init keeps minting a phone token");
        assert!(parse(&["flightdeckd", "init", "--label", "box", "--no-phone-token"]));
    }

    #[test]
    fn remove_phone_takes_a_token_or_the_init_minted_cleanup_never_both() {
        let parse = |args: &[&str]| Cli::try_parse_from(args).map(|cli| match cli.cmd {
            Cmd::RemovePhone { token, init_minted, keep, .. } => (token, init_minted, keep),
            _ => unreachable!(),
        });
        let s = |v: &str| Some(v.to_string());
        assert_eq!(parse(&["flightdeckd", "remove-phone", "--token", "-"]).unwrap(), (s("-"), false, None));
        assert_eq!(
            parse(&["flightdeckd", "remove-phone", "--init-minted", "--keep", "-"]).unwrap(),
            (None, true, s("-"))
        );
        use clap::error::ErrorKind;
        let kind = |args: &[&str]| parse(args).err().map(|e| e.kind());
        assert_eq!(kind(&["flightdeckd", "remove-phone"]), Some(ErrorKind::MissingRequiredArgument));
        assert_eq!(kind(&["flightdeckd", "remove-phone", "--init-minted"]), Some(ErrorKind::MissingRequiredArgument));
        assert_eq!(kind(&["flightdeckd", "remove-phone", "--keep", "-"]), Some(ErrorKind::MissingRequiredArgument));
        assert_eq!(
            kind(&["flightdeckd", "remove-phone", "--init-minted", "--keep", "-", "--token", "-"]),
            Some(ErrorKind::ArgumentConflict)
        );
    }

    #[test]
    fn version_flag_prints_name_and_package_version() {
        // `ssh host flightdeckd --version` is the Mac's on-disk version probe.
        let v = Cli::command().render_version().to_string();
        assert_eq!(v.trim(), format!("flightdeckd {}", env!("CARGO_PKG_VERSION")));
    }
}
