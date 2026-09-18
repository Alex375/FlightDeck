//! flightdeckd — the Flight Deck server daemon.
//!
//! Owns detached `claude` sessions (they survive client disconnects) and
//! presents itself to the Flight Deck relay as a node so a phone drives the
//! server DIRECTLY (the Mac can be off). The Mac attaches over SSH through the
//! `attach` subcommand.
//!
//!   flightdeckd init      mint identity + config, print the phone pairing link
//!   flightdeckd run       the daemon (relay client + attach socket)
//!   flightdeckd attach    stdio bridge to a session (what the Mac runs via ssh)
//!   flightdeckd status    one-line JSON snapshot of the sessions
//!   flightdeckd add-phone / remove-phone   authorize / revoke a phone live
//!   flightdeckd whoami    this node's relay identity (no daemon needed)

mod attach;
mod config;
mod events;
mod frames;
mod registry;
mod relay;
mod rpc;
mod session;
#[cfg(test)]
mod testutil;
mod transcript;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use config::Config;
use std::path::PathBuf;

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
        /// The phone's secret token; `-` reads it from stdin (keeps it out of
        /// the process list).
        #[arg(long)]
        token: String,
        #[arg(long, default_value = "")]
        label: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Revoke a phone on this node (persisted + pushed to the relay live).
    RemovePhone {
        /// The phone's secret token; `-` reads it from stdin.
        #[arg(long)]
        token: String,
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

/// `--token -` reads the secret from stdin's first line.
fn token_arg(token: String) -> Result<String> {
    if token != "-" {
        return Ok(token);
    }
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_string())
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
        Cmd::Init { relay, label, force } => {
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
            let cfg = Config {
                relay_url: relay,
                mac_id: uuid::Uuid::new_v4().to_string(),
                mac_token: uuid::Uuid::new_v4().to_string(),
                phone_tokens: vec![config::PhoneToken {
                    token: uuid::Uuid::new_v4().to_string(),
                    label: "phone".into(),
                }],
                revoked_phone_tokens: vec![],
                label: label.or(host).unwrap_or_else(|| "flightdeckd".into()),
                default_workdir: None,
                claude_bin: "claude".into(),
                permission_mode: "bypassPermissions".into(),
            };
            cfg.save_locked(&path, &lock)?;
            drop(lock);
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
            let cfg = Config::load(&path)
                .with_context(|| "run `flightdeckd init` first to create the config")?;
            let registry = registry::Registry::open(&config::registry_path())?;
            let manager = session::SessionManager::new(cfg, registry, path);
            if let Some(link) = pairing_link(&manager.cfg) {
                tracing::info!("phone pairing link: {link}");
            }
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
            tokio::select! {
                r = attach_srv => r?.context("attach server ended")?,
                _ = relay_srv => {},
                _ = tokio::signal::ctrl_c() => {
                    tracing::info!("shutting down");
                }
            }
            Ok(())
        }
        Cmd::Attach { conversation, cwd, resume_session, epoch, cursor, socket, title, claude_args } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            attach::attach_client(&socket, conversation, cwd, resume_session, epoch, cursor, claude_args, title)
                .await
        }
        Cmd::AddPhone { token, label, socket } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            println!("{}", attach::add_phone_client(&socket, &token_arg(token)?, &label).await?);
            Ok(())
        }
        Cmd::RemovePhone { token, socket } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            println!("{}", attach::remove_phone_client(&socket, &token_arg(token)?).await?);
            Ok(())
        }
        Cmd::Whoami { config: cfg_path } => {
            let path = cfg_path.unwrap_or_else(config::default_config_path);
            let cfg = Config::load(&path)?;
            println!(
                "{}",
                serde_json::json!({"mac_id": cfg.mac_id, "relay_url": cfg.relay_url, "label": cfg.label})
            );
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
    fn version_flag_prints_name_and_package_version() {
        // `ssh host flightdeckd --version` is the Mac's on-disk version probe.
        let v = Cli::command().render_version().to_string();
        assert_eq!(v.trim(), format!("flightdeckd {}", env!("CARGO_PKG_VERSION")));
    }
}
