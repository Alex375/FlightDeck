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

mod attach;
mod config;
mod events;
mod frames;
mod registry;
mod relay;
mod rpc;
mod session;
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
    /// Print the phone pairing link for the current config.
    Pairing {
        #[arg(long)]
        config: Option<PathBuf>,
    },
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
                label: label.or(host).unwrap_or_else(|| "flightdeckd".into()),
                default_workdir: None,
                claude_bin: "claude".into(),
                permission_mode: "bypassPermissions".into(),
            };
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(&path, serde_json::to_string_pretty(&cfg)?)?;
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
            let cfg = Config::load(&path)
                .with_context(|| "run `flightdeckd init` first to create the config")?;
            let registry = registry::Registry::open(&config::registry_path())?;
            let manager = session::SessionManager::new(cfg, registry);
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
        Cmd::Attach { conversation, cwd, resume_session, epoch, cursor, socket, claude_args } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            attach::attach_client(&socket, conversation, cwd, resume_session, epoch, cursor, claude_args)
                .await
        }
        Cmd::Status { socket } => {
            let socket = socket.unwrap_or_else(config::socket_path);
            println!("{}", attach::status_client(&socket).await?);
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
