//! Persistence layer.
//!
//! [`model`] holds the plain domain records the whole app speaks; [`db`] is the
//! single SQLite-backed service that loads and stores them. Nothing outside
//! `db` touches SQL — swap the engine there and the rest of the core is
//! untouched.

pub mod db;
pub mod model;

pub use db::Store;
pub use model::{
    validate_address_value, validate_ssh_port, validate_ssh_user, AddressCandidate, AddressKind,
    ClaudeAccountRecord, ConversationRecord, MachineRecord, PersistedState, RepoRecord, TosseProjectRepo,
};
