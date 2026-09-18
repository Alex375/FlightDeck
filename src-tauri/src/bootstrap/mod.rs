//! Provisioning a fresh remote server into a `flightdeckd` install: the systemd unit
//! text (`templates`) and the local SSH_ASKPASS relay for the ONE interactive prompt
//! the flow needs — the local `ssh` client's own login-password prompt on a server
//! that has no key installed yet (`askpass`).
//!
//! Both modules are pure/self-contained on purpose: `templates` never touches a
//! process or the filesystem (golden-string tested), and `askpass` never touches the
//! network itself (it only shapes the local `ssh` invocation and feeds its prompt) —
//! neither one runs `sudo` or knows the daemon's own protocol. Later bootstrap steps
//! compose these primitives; they do not live here.

pub mod askpass;
pub mod templates;
