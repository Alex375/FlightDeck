//! What user-facing text calls the machine the app runs on — the Rust twin of the front's
//! `MACHINE` (`src/ui/platform.ts`), so a message the core writes reads the same as the UI
//! around it.

/// "Mac" on macOS, "computer" elsewhere. Write it into the message (`this {MACHINE}`) wherever
/// the words mean THIS machine, never "Mac" by hand. A paired server that is a Mac stays "the
/// Mac" on every OS: those words are about the server, not about this machine.
pub const MACHINE: &str = if cfg!(target_os = "macos") { "Mac" } else { "computer" };
