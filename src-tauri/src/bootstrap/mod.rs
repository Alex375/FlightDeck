//! Provisioning a fresh remote server into a `flightdeckd` install: the systemd unit
//! text (`templates`), the local SSH_ASKPASS relay for the ONE interactive prompt the
//! FIRST-contact flow needs (`askpass`), and — once the server is already PAIRED (a key
//! is installed) — actually running `flightdeckd init` and driving the server-side
//! `claude` sign-in (`server_setup`).
//!
//! `templates` and `askpass` are pure/self-contained on purpose: `templates` never
//! touches a process or the filesystem (golden-string tested), and `askpass` never
//! touches the network itself (it only shapes the local `ssh` invocation and feeds its
//! prompt) — neither one runs `sudo` or knows the daemon's own protocol. `server_setup`
//! is the first module here that actually drives a paired machine end to end; it reuses
//! [`askpass::BootstrapError`] as its own error type (one canonical bootstrap error
//! shape across the whole flow) and the crate's existing KEYED ssh path (see that
//! module's doc) rather than `askpass`'s first-contact one.

pub mod askpass;
pub mod server_setup;
pub mod templates;
