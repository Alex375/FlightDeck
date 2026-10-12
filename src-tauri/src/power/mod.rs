//! The single service that holds the macOS "keep awake" power assertion.
//!
//! Same shell-out encapsulation as `usage/` (→ `/usr/bin/security`) and `git/` (→ the
//! `git` binary): the rest of the core and the IPC layer go through `Caffeinate` and
//! never touch `caffeinate` directly, so the mechanism stays swappable (e.g. an IOKit
//! `IOPMAssertionCreateWithName` FFI backend later) without touching a single caller.
//!
//! MECHANISM, not policy. We hold ONE managed `caffeinate -i` child while "awake" is
//! desired and kill it when it isn't — a single assertion for the whole app, not one per
//! conversation. The FRONT owns the policy (the toolbar on/off + the Light/Hard mode +
//! fleet activity): it computes the desired `awake` boolean and pushes it here via the
//! `set_awake` IPC command. This service just spawns/kills accordingly.
//!
//! We pass `-i` (prevent idle SYSTEM sleep — works on battery AND AC) and deliberately
//! NOT `-d` (display): the screen may sleep and the session may lock, only the machine
//! must stay awake. Note `caffeinate` does NOT keep the Mac awake with the lid CLOSED
//! (macOS treats a lid close as an explicit sleep the assertion can't override) — this
//! covers lid-open + screen-off/locked only.
//!
//! TEARDOWN is mandatory: an orphaned `caffeinate` child would hold the Mac awake
//! forever. The app releases explicitly at quit (`RunEvent::Exit`), and `Drop` is a belt
//! in case the managed state is torn down another way — same no-orphan discipline as the
//! terminal service.

use std::process::Child;
use std::sync::Mutex;

/// The closed-lid mechanism (`pmset disablesleep` + its safety net). Same service, second
/// knob: `Caffeinate` covers an open lid, `SleepLock` a closed one.
pub mod sleep_lock;
pub use sleep_lock::{PowerSource, SleepLock, SleepLockStatus};

/// The macOS power tool, present on every install (nothing to bundle/install).
#[cfg(target_os = "macos")]
const CAFFEINATE_BIN: &str = "/usr/bin/caffeinate";

/// Holds the single live `caffeinate` child (the app-wide keep-awake assertion), or
/// `None` when the Mac is free to sleep. Held as Tauri managed state.
#[derive(Default)]
pub struct Caffeinate {
    child: Mutex<Option<Child>>,
}

impl Caffeinate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drive the desired power state: `true` holds the assertion (spawns the child if not
    /// already held), `false` releases it (kills + reaps the child). IDEMPOTENT — calling
    /// it repeatedly with the same value is a no-op, so the front can push its computed
    /// desired state on every change without tracking transitions itself.
    ///
    /// Returns `Err(msg)` ONLY when asked to hold and the spawn fails — so the caller can
    /// surface "the Mac you told me to keep awake may sleep" to the user instead of it
    /// being an invisible `eprintln!`. Releasing never fails.
    pub fn set_awake(&self, awake: bool) -> Result<(), String> {
        if awake {
            self.hold()
        } else {
            self.release();
            Ok(())
        }
    }

    /// Ensure a live `caffeinate` child is holding the assertion, spawning one if needed.
    /// Idempotent: a no-op when a child is already ALIVE. But a child that died out from
    /// under us (killed externally, `killall caffeinate`, OS-reaped under pressure) must
    /// NOT count as "held" — we prune it (`try_wait`) and re-spawn, otherwise the Mac would
    /// silently start sleeping again with the guard still believing it's held. Returns
    /// `Err` on spawn failure (surfaced by the caller), never a silent swallow.
    fn hold(&self) -> Result<(), String> {
        let mut guard = self.child.lock().unwrap();
        // Is the tracked child still alive? `try_wait` reaps it if it has exited (so no
        // zombie), and returns `Ok(None)` while it's still running. Absent / exited /
        // un-queryable all mean "not alive" → fall through to (re)spawn.
        let alive = matches!(guard.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
        if alive {
            return Ok(()); // already holding a live assertion
        }
        *guard = None; // drop any dead handle before replacing it

        #[cfg(target_os = "macos")]
        {
            // `-w <our pid>` ties the child's lifetime to THIS process: caffeinate exits on
            // its own once our pid vanishes. That closes the orphan gap `release()`/`Drop`
            // can't — a crash, SIGKILL, force-quit or OOM never runs them, and a bare
            // `caffeinate -i` would then be reparented to launchd and hold the Mac awake
            // forever. Normal toggles still kill it eagerly via `release()`.
            let pid = std::process::id();
            match std::process::Command::new(CAFFEINATE_BIN)
                .arg("-i")
                .arg("-w")
                .arg(pid.to_string())
                .spawn()
            {
                Ok(child) => {
                    *guard = Some(child);
                    Ok(())
                }
                Err(e) => Err(format!("failed to spawn caffeinate: {e}")),
            }
        }
        // Off macOS there is no `caffeinate`: the assertion is a no-op success (this app
        // targets macOS; the branch keeps the service cross-compilable).
        #[cfg(not(target_os = "macos"))]
        {
            Ok(())
        }
    }

    /// Kill and reap the managed child, releasing the assertion. No-op when not held.
    /// `caffeinate -i` (spawned with no command to wrap) is a leaf process, so killing the
    /// direct child is enough — no process group to sweep. Reaping (`wait`) prevents a
    /// zombie: std does not reap on drop.
    fn release(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Whether a `caffeinate` child is currently tracked. For tests and diagnostics.
    #[cfg(test)]
    pub fn is_held(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    /// The pid of the tracked child, if any — lets a test tell "same child" (idempotent
    /// hold) from "a second child was spawned" (a leak), which `is_held` alone cannot.
    #[cfg(test)]
    pub fn child_pid(&self) -> Option<u32> {
        self.child.lock().unwrap().as_ref().map(|c| c.id())
    }
}

impl Drop for Caffeinate {
    /// Belt: never leave a `caffeinate` child orphaned holding the Mac awake forever. The
    /// app also releases explicitly at quit (`RunEvent::Exit`); this covers any other
    /// teardown path.
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spawn-free, so it runs in the DEFAULT `cargo test --lib` (CI). Covers the default
    /// state and that releasing when nothing is held is a safe, successful no-op — at least
    /// this much of the mechanism gets automated coverage even though the real-spawn test
    /// below is `#[ignore]`d.
    #[test]
    fn fresh_is_unheld_and_release_is_a_safe_noop() {
        let c = Caffeinate::new();
        assert!(!c.is_held(), "a fresh instance holds nothing");
        assert!(c.set_awake(false).is_ok(), "releasing when unheld succeeds");
        assert!(!c.is_held(), "still nothing held");
    }

    /// Real spawn of `/usr/bin/caffeinate` — `#[ignore]` so the default run never spawns a
    /// process (run with `-- --ignored`). Verifies hold/release round-trips, hold is
    /// idempotent WITHOUT leaking a second child (asserted by pid stability, which
    /// `is_held` alone can't prove), and the child is actually dead after release.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn hold_is_idempotent_without_leaking_a_child() {
        let c = Caffeinate::new();
        assert!(!c.is_held(), "starts released");

        c.set_awake(true).expect("spawn caffeinate");
        assert!(c.is_held(), "held after set_awake(true)");
        let pid = c.child_pid().expect("a child pid once held");

        // Holding again must NOT spawn a second child — same pid, no leak.
        c.set_awake(true).expect("idempotent hold");
        assert_eq!(c.child_pid(), Some(pid), "idempotent hold kept the SAME child");

        c.set_awake(false).unwrap();
        assert!(!c.is_held(), "released after set_awake(false)");
        assert!(!pid_alive(pid), "the caffeinate child was actually killed on release");

        // Releasing again is a no-op.
        c.set_awake(false).unwrap();
        assert!(!c.is_held(), "still released (idempotent release)");
    }

    /// True iff a process with `pid` still exists. `kill(pid, 0)` sends no signal but
    /// returns success when the pid is signalable and `ESRCH` when it's gone.
    #[cfg(target_os = "macos")]
    fn pid_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
