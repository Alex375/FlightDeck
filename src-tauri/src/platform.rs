//! What user-facing text calls the machine the app runs on — the Rust twin of the front's
//! `MACHINE` (`src/ui/platform.ts`), so a message the core writes reads the same as the UI
//! around it.

/// "Mac" on macOS, "computer" elsewhere. Write it into the message (`this {MACHINE}`) wherever
/// the words mean THIS machine, never "Mac" by hand. A paired server that is a Mac stays "the
/// Mac" on every OS: those words are about the server, not about this machine.
pub const MACHINE: &str = if cfg!(target_os = "macos") { "Mac" } else { "computer" };

/// The name this machine goes by for its user — macOS's Computer Name ("Armand's MacBook
/// Pro") when it has one, else the host name. For what the UI and a remote agent are TOLD
/// (where a conversation came from), never as an identity: the user can rename it any time.
pub fn this_machine_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return name;
        }
    }
    this_host_name()
}

/// A name for this machine that stays put: macOS's Local Host Name (set once, in Sharing),
/// not `gethostname`, which follows the network a Mac is on (DHCP, `.local` suffixes). For
/// what a server remembers this Mac by (`server_launch`). Elsewhere, the host name.
pub fn this_host_id() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "LocalHostName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return name;
        }
    }
    this_host_name()
}

/// This machine's host name (`gethostname`), `"localhost"` when it cannot be read.
pub fn this_host_name() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: `buf` is a valid, writable buffer of the length passed.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "localhost".to_string()
}
