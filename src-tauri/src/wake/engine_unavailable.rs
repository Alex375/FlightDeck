//! Stand-in for the wake-word engine on Intel Macs, where `ort` (ONNX Runtime)
//! ships no prebuilt library and `Cargo.toml` leaves it out. Same surface as
//! `engine.rs`, so the controller, capture and IPC compile unchanged; the
//! controller never asks for an engine here (`super::require_engine`), and if
//! anything ever did, `new` fails with the reason instead of pretending.

use super::Detection;

/// No value of this type can exist: `new` always fails.
pub enum Engine {}

impl Engine {
    pub fn new(_phrase: &str, _sensitivity: f32, _debug: bool) -> Result<Self, String> {
        Err(super::UNAVAILABLE.unwrap_or("no wake-word engine in this build").to_string())
    }

    pub fn phrase(&self) -> &str {
        match *self {}
    }

    pub fn feed(&mut self, _samples: &[f32]) -> Option<Detection> {
        match *self {}
    }
}
