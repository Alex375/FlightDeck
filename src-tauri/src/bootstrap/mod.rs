//! Provisioning a fresh remote server into a `flightdeckd` install: the systemd unit
//! text (`templates`), the local SSH_ASKPASS relay for the ONE interactive prompt the
//! FIRST-contact flow needs (`askpass`), the actual first-contact handshake — install
//! the app's key, pin/read the host key, probe for install-mode facts (`connect`,
//! B7) — and — once the server is already PAIRED (a key is installed) — actually
//! running `flightdeckd init` and driving the server-side `claude` sign-in
//! (`server_setup`).
//!
//! `templates` and `askpass` are pure/self-contained on purpose: `templates` never
//! touches a process or the filesystem (golden-string tested), and `askpass` never
//! touches the network itself (it only shapes the local `ssh` invocation and feeds its
//! prompt) — neither one runs `sudo` or knows the daemon's own protocol. `connect` and
//! `server_setup` are the two modules here that actually drive a real connection end to
//! end; both reuse [`askpass::BootstrapError`] as their error type (one canonical
//! bootstrap error shape across the whole flow) — `connect` for the FIRST contact
//! (`askpass`'s password-only path, then the crate's normal keyed path once the key
//! is in), `server_setup` once a machine is already paired (keyed path only, never
//! `askpass`'s — see that module's doc for why).

pub mod askpass;
pub mod connect;
pub mod server_setup;
pub mod templates;
