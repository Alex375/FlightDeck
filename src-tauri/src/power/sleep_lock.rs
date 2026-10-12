//! The closed-lid keep-awake: macOS's hidden `pmset disablesleep` flag (`SleepDisabled`).
//!
//! `caffeinate` (see [`super::Caffeinate`]) holds an idle-sleep ASSERTION, and macOS treats
//! a lid close as an explicit sleep no assertion can override. The one knob that survives a
//! closed lid is the system-wide `SleepDisabled` flag: `sudo pmset -a disablesleep 1`
//! ("all sleep functions are disabled; the Sleep item in the Apple menu is dimmed" — Apple
//! KB 101114). Two things make it a different animal from `caffeinate`, and shape everything
//! in this file:
//!
//! 1. **It needs root.** The flag is owned by `powerd`; no user-space API bypasses that. A
//!    password prompt at every toggle is unusable for a mode that follows fleet activity, so
//!    the ONE-TIME setup drops a sudoers rule (`/etc/sudoers.d/flightdeck`) that lets the
//!    current user run EXACTLY two literal commands as root without a password —
//!    `pmset -a disablesleep 0` and `… 1`, absolute path, no wildcard, no shell — and every
//!    toggle after that is `sudo -n …` (`-n` = never prompt, fail fast). Installing the rule
//!    goes through the standard macOS admin sheet (`osascript … with administrator
//!    privileges`) and is validated with `visudo -cf` BEFORE it lands: a malformed sudoers
//!    file breaks `sudo` for the whole Mac. The same pattern as the open-source Sleepless app;
//!    no privileged helper, no daemon.
//!
//! 2. **It is SYSTEM STATE, not a child process.** `caffeinate -w <pid>` dies with us; this
//!    flag outlives a crash, a force-quit, a dead battery. So the flag is never armed without
//!    its safety net: an OWNERSHIP MARKER (a file in the app data dir holding our pid, written
//!    before arming, removed after disarming), a detached DEADMAN process that waits for our
//!    pid to vanish and then re-enables sleep (our own `-w <pid>`), a RECONCILE AT LAUNCH
//!    (marker + flag still set → a previous run died armed → re-enable), and the explicit
//!    release at quit. Reboot persistence of the flag is disputed between sources, so the net
//!    covers both cases.
//!
//! OWNERSHIP is the core invariant: Flight Deck only ever re-enables sleep that IT disabled.
//! A flag that is already set when we would arm it (a `sudo pmset` the user ran by hand,
//! another Flight Deck identity such as a test build with its own data dir) is reported and
//! never adopted, so it is never undone either. The marker is written only on the path that
//! flips the flag 0 → 1 ourselves (or re-arms a flag our own marker already claims).
//!
//! MECHANISM, not policy: the front decides when the lid-proof hold is wanted (mode ×
//! fleet activity × battery floor) and pushes `set(true|false)`; this type converges the
//! system flag and reports the REAL state back, so the UI can show what is, not what was
//! asked. Every OS interaction goes through [`PowerBackend`] (Apple's own `/usr/bin/pmset`,
//! `/usr/bin/sudo`, `/usr/sbin/visudo`, `/usr/bin/osascript`, all on the sealed system volume)
//! so the state machine itself is unit-tested against a fake.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The sudoers drop-in this feature installs. The file name carries no `.` or `~` (sudo
/// silently ignores such files in `sudoers.d`).
pub const SUDOERS_PATH: &str = "/etc/sudoers.d/flightdeck";
/// Name of the ownership marker inside the app data dir.
const MARKER_FILE: &str = "sleep_lock_armed";
/// What to tell the user when only a manual command can bring sleep back.
const MANUAL_FIX: &str = "run `sudo pmset -a disablesleep 0` in Terminal";

#[cfg(target_os = "macos")]
const PMSET: &str = "/usr/bin/pmset";
#[cfg(target_os = "macos")]
const SUDO: &str = "/usr/bin/sudo";
#[cfg(target_os = "macos")]
const OSASCRIPT: &str = "/usr/bin/osascript";

/// The real, system-level picture — what the UI shows and what the policy reacts to.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct SleepLockStatus {
    /// `false` off macOS: the feature does not exist there (never silently a no-op).
    pub supported: bool,
    /// The account the sudoers rule is (or would be) written for.
    pub user: String,
    /// The one-time authorization is installed and works: our sudoers file exists AND
    /// `sudo -n -l` accepts both literal commands without a password.
    pub granted: bool,
    /// `pmset -g` reports `SleepDisabled 1` right now — whoever set it.
    pub system_sleep_disabled: bool,
    /// Our ownership marker is present: Flight Deck armed the flag (and will re-enable sleep).
    pub owned: bool,
    /// The detached deadman that re-enables sleep if this process dies is alive.
    pub deadman_alive: bool,
    /// Where the rule lives, for the Settings explanation.
    pub sudoers_path: String,
    /// The exact rule line, shown verbatim before asking for the admin password.
    pub sudoers_line: String,
    /// A probe that could not run at all (not "no grant" — that is `granted: false`).
    pub probe_error: Option<String>,
    /// The launch reconcile (re-enabling sleep a previous run left disabled) failed, and no
    /// release has succeeded since. Cleared by the first successful release of our flag.
    pub reconcile_error: Option<String>,
}

/// Battery / power-source snapshot for the battery-floor policy (front-owned).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct PowerSource {
    /// Drawing from the internal battery (no AC).
    pub on_battery: bool,
    /// Battery charge, when a battery is present and readable.
    pub percent: Option<u8>,
    /// `pmset -g` `lowpowermode 1`.
    pub low_power_mode: bool,
}

/// The detached watchdog that re-enables sleep if this process dies armed.
pub trait Deadman: Send {
    fn alive(&mut self) -> bool;
    /// Kill and reap it. Never fails (a dead deadman is the goal).
    fn kill(&mut self);
}

impl Deadman for Child {
    fn alive(&mut self) -> bool {
        // `try_wait` reaps an exited child (no zombie) and is `Ok(None)` while it runs.
        matches!(self.try_wait(), Ok(None))
    }
    fn kill(&mut self) {
        let _ = Child::kill(self);
        let _ = self.wait();
    }
}

/// Every OS interaction of the closed-lid feature. [`MacBackend`] in the app; a fake in tests
/// so the ownership state machine is exercised without root.
pub trait PowerBackend: Send + Sync {
    /// The feature exists on this OS.
    fn supported(&self) -> bool;
    /// The account the rule is written for (validated, never root).
    fn current_user(&self) -> Result<String, String>;
    /// `SleepDisabled` is set system-wide right now.
    fn sleep_disabled(&self) -> Result<bool, String>;
    /// Our rule is installed and usable without a password.
    fn grant_installed(&self) -> Result<bool, String>;
    /// Flip the flag through the rule, then re-read it ("written" ≠ "taken into account").
    fn apply(&self, on: bool) -> Result<(), String>;
    /// Spawn the deadman watching THIS process, guarding `marker`.
    fn spawn_deadman(&self, marker: &Path) -> Result<Box<dyn Deadman>, String>;
    /// Run a shell script as root through the admin sheet. Blocks until it is answered.
    fn run_privileged(&self, script: &str) -> Result<(), String>;
}

/// The real backend: Apple's tools on macOS, an explicit "not supported" elsewhere.
pub struct MacBackend;

impl PowerBackend for MacBackend {
    fn supported(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn current_user(&self) -> Result<String, String> {
        #[cfg(target_os = "macos")]
        {
            current_user()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(UNSUPPORTED.to_string())
        }
    }

    fn sleep_disabled(&self) -> Result<bool, String> {
        #[cfg(target_os = "macos")]
        {
            run_capture(PMSET, &["-g"]).map(|s| parse_sleep_disabled(&s))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(false)
        }
    }

    fn grant_installed(&self) -> Result<bool, String> {
        #[cfg(target_os = "macos")]
        {
            // Our file must exist: `sudo -n -l` alone also says yes for an unrelated, broader
            // NOPASSWD entry (common on dev Macs), and Settings would then claim "Installed"
            // for a rule that is not ours (and that Remove cannot remove).
            let present = Path::new(SUDOERS_PATH)
                .try_exists()
                .map_err(|e| format!("cannot check {SUDOERS_PATH}: {e}"))?;
            if !present {
                return Ok(false);
            }
            probe_grant()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(false)
        }
    }

    fn apply(&self, on: bool) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            apply_flag(on)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = on;
            Err(UNSUPPORTED.to_string())
        }
    }

    fn spawn_deadman(&self, marker: &Path) -> Result<Box<dyn Deadman>, String> {
        #[cfg(target_os = "macos")]
        {
            let child = deadman_command(
                std::process::id(),
                marker,
                &[SUDO, "-n", PMSET, "-a", "disablesleep", "0"],
            )
            .spawn()
            .map_err(|e| format!("cannot spawn the sleep deadman: {e}"))?;
            Ok(Box::new(child))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = marker;
            Err(UNSUPPORTED.to_string())
        }
    }

    fn run_privileged(&self, script: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            run_privileged(script)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = script;
            Err(UNSUPPORTED.to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "closed-lid modes need macOS";

/// Holds the closed-lid flag's safety net. Tauri managed state (as an `Arc`, so blocking IPC
/// commands can take it off-thread).
pub struct SleepLock {
    marker: PathBuf,
    backend: Box<dyn PowerBackend>,
    /// Serializes every flag mutation AND tracks the deadman (spawned on arm, killed on
    /// disarm; on a crash it is simply never killed — that is the point). Never held across
    /// the admin sheet, so quitting while the sheet is open does not hang.
    deadman: Mutex<Option<Box<dyn Deadman>>>,
    /// An admin sheet (install / remove) is open. Arming is refused meanwhile, so a removal
    /// can never race a fresh arm into a flag nobody can release any more.
    privileged_busy: AtomicBool,
    /// See [`SleepLockStatus::reconcile_error`].
    reconcile_error: Mutex<Option<String>>,
}

/// Clears `privileged_busy` when the sheet step ends, whatever the outcome.
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl SleepLock {
    pub fn new(data_dir: &Path) -> Self {
        Self::with_backend(data_dir, Box::new(MacBackend))
    }

    pub fn with_backend(data_dir: &Path, backend: Box<dyn PowerBackend>) -> Self {
        Self {
            marker: data_dir.join(MARKER_FILE),
            backend,
            deadman: Mutex::new(None),
            privileged_busy: AtomicBool::new(false),
            reconcile_error: Mutex::new(None),
        }
    }

    /// The exact rule the setup installs for `user`.
    pub fn sudoers_line(user: &str) -> String {
        format!(
            "{user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1"
        )
    }

    /// Whether we currently hold the ownership marker.
    pub fn owned(&self) -> bool {
        self.marker.exists()
    }

    fn lock_deadman(&self) -> std::sync::MutexGuard<'_, Option<Box<dyn Deadman>>> {
        // A panic while holding the lock must not disable the safety net for the rest of the
        // run: the guarded data (an optional child handle) stays valid whatever happened.
        self.deadman.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn deadman_alive(guard: &mut Option<Box<dyn Deadman>>) -> bool {
        guard.as_mut().map(|d| d.alive()).unwrap_or(false)
    }

    fn kill_deadman(guard: &mut Option<Box<dyn Deadman>>) {
        if let Some(mut d) = guard.take() {
            d.kill();
        }
    }

    fn write_marker(&self) -> Result<(), String> {
        // The deadman compares this pid with the one it watches: a deadman left by a CRASHED
        // run must not clear a flag (or delete a marker) a relaunched instance now owns.
        std::fs::write(&self.marker, format!("{}\n", std::process::id()))
            .map_err(|e| format!("cannot write the ownership marker: {e}"))
    }

    fn drop_marker(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot remove the ownership marker: {e}")),
        }
    }

    /// Read the real state. Never errors: a probe that cannot run is reported in
    /// `probe_error` with `granted: false`, so the UI degrades visibly instead of guessing.
    pub fn status(&self) -> SleepLockStatus {
        let mut guard = self.lock_deadman();
        self.status_locked(&mut guard)
    }

    fn status_locked(&self, guard: &mut Option<Box<dyn Deadman>>) -> SleepLockStatus {
        let supported = self.backend.supported();
        let (user, mut probe_error) = match self.backend.current_user() {
            Ok(u) => (u, None),
            Err(e) => (String::new(), Some(e)),
        };
        let granted = if user.is_empty() {
            false
        } else {
            match self.backend.grant_installed() {
                Ok(g) => g,
                Err(e) => {
                    probe_error = Some(e);
                    false
                }
            }
        };
        let system_sleep_disabled = match self.backend.sleep_disabled() {
            Ok(v) => v,
            Err(e) => {
                probe_error.get_or_insert(e);
                false
            }
        };
        SleepLockStatus {
            supported,
            sudoers_line: if user.is_empty() { String::new() } else { Self::sudoers_line(&user) },
            user,
            granted,
            system_sleep_disabled,
            owned: self.owned(),
            deadman_alive: Self::deadman_alive(guard),
            sudoers_path: SUDOERS_PATH.to_string(),
            probe_error,
            reconcile_error: self
                .reconcile_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        }
    }

    /// Converge the system flag to `on`. IDEMPOTENT (the front pushes its desired state on
    /// every change and on a heartbeat). Arming only takes a flag that is clear (or one our
    /// own marker already claims): marker first, then deadman, then the flag, so there is
    /// never a moment where our flag is set without its net — and a failed arm rolls the net
    /// back. Disarming only touches a flag WE armed. Returns the real state after the attempt;
    /// `Err` when the flag could not be set or cleared, so the caller can fall back and tell
    /// the user — never a silent "on" while the Mac quietly sleeps.
    pub fn set(&self, on: bool) -> Result<SleepLockStatus, String> {
        let mut guard = self.lock_deadman();
        let outcome = self.set_locked(&mut guard, on);
        if !on && outcome.is_ok() {
            // A release went through: whatever the launch reconcile could not do is done.
            *self.reconcile_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
        let status = self.status_locked(&mut guard);
        outcome.map(|_| status)
    }

    fn set_locked(&self, guard: &mut Option<Box<dyn Deadman>>, on: bool) -> Result<(), String> {
        if !on {
            if !self.owned() {
                // Not ours (or already released): nothing to undo. A flag set by hand stays.
                Self::kill_deadman(guard);
                return Ok(());
            }
            if self.backend.sleep_disabled()? {
                self.backend.apply(false)?;
            }
            // Flag is clear: drop the net. Deadman first (it would otherwise race us on the
            // marker), marker last (it is the "still armed" truth for the next launch).
            Self::kill_deadman(guard);
            return self.drop_marker();
        }

        if self.privileged_busy.load(Ordering::SeqCst) {
            return Err(
                "the closed-lid authorization is being changed — the Mac will be lid-proof once the admin sheet is closed"
                    .to_string(),
            );
        }
        let disabled_now = self.backend.sleep_disabled()?;
        let owned = self.owned();
        if disabled_now && !owned {
            // Someone else's flag (set by hand, or by another Flight Deck identity): the Mac is
            // already lid-proof. Never adopt it — adopting would make our next release undo it.
            return Ok(());
        }
        // Ours to (re)arm. Marker (with OUR pid) BEFORE the flag: dying between the two leaves
        // a marker over a clear flag, which the launch reconcile just removes. The reverse
        // order would leave a flag with no owner, i.e. a Mac nobody re-enables.
        self.write_marker()?;
        if !Self::deadman_alive(guard) {
            match self.backend.spawn_deadman(&self.marker) {
                Ok(d) => *guard = Some(d),
                Err(e) => {
                    if !disabled_now {
                        let _ = self.drop_marker(); // nothing armed: nothing to own
                    }
                    return Err(e);
                }
            }
        }
        if !disabled_now {
            if let Err(e) = self.backend.apply(true) {
                // Roll the net back only when the flag is confirmed clear; an unreadable flag
                // may be set, and dropping the marker then would orphan it.
                if matches!(self.backend.sleep_disabled(), Ok(false)) {
                    Self::kill_deadman(guard);
                    let _ = self.drop_marker();
                }
                return Err(e);
            }
        }
        Ok(())
    }

    /// At launch: a marker left behind means a previous run died armed (crash, force-quit,
    /// dead battery). If the flag is still set, re-enable sleep; either way drop the stale
    /// marker. The failure (typically: authorization gone, or a transient `pmset`/`sudo`
    /// error — the Mac is STILL sleepless) is kept in the status for the front to shout and
    /// retry, and returned for the log.
    pub fn reconcile_at_launch(&self) -> Result<(), String> {
        let mut guard = self.lock_deadman();
        let res = if self.owned() { self.set_locked(&mut guard, false) } else { Ok(()) };
        *self.reconcile_error.lock().unwrap_or_else(|p| p.into_inner()) = res.as_ref().err().cloned();
        res
    }

    /// Install the one-time authorization through the macOS admin sheet. BLOCKS until the
    /// user answers the sheet (run it off the UI thread) — without holding the state lock, so
    /// quitting meanwhile still releases cleanly. Validates the rule with `visudo -cf` before
    /// installing, then re-probes: "written" ≠ "taken into account".
    pub fn install_grant(&self) -> Result<SleepLockStatus, String> {
        self.privileged_busy.store(true, Ordering::SeqCst);
        let _busy = BusyGuard(&self.privileged_busy);
        let user = self.backend.current_user()?;
        self.backend.run_privileged(&install_grant_script(&user))?;
        let mut guard = self.lock_deadman();
        let status = self.status_locked(&mut guard);
        if !status.granted {
            return Err(match &status.probe_error {
                Some(e) => format!("the rule was written but sudo still refuses it: {e}"),
                None => "the rule was written but sudo still refuses it".to_string(),
            });
        }
        Ok(status)
    }

    /// Remove the authorization through the admin sheet. When the flag is ours, the SAME
    /// privileged step re-enables sleep first (under `set -e`: a failed re-enable aborts
    /// before the rule is removed), and the flag is re-read afterwards — removing the feature
    /// must never leave the Mac sleepless with no way left to fix it. If it somehow still is,
    /// the marker is KEPT (so the "still disabled" warning keeps showing) and the error names
    /// the manual fix.
    pub fn remove_grant(&self) -> Result<SleepLockStatus, String> {
        self.privileged_busy.store(true, Ordering::SeqCst);
        let _busy = BusyGuard(&self.privileged_busy);
        // Arming is refused from here on, so `owned` cannot flip to true behind our back.
        let ours = self.owned();
        self.backend.run_privileged(&remove_grant_script(ours))?;
        let mut guard = self.lock_deadman();
        if self.owned() {
            match self.backend.sleep_disabled() {
                Ok(false) => {
                    Self::kill_deadman(&mut guard);
                    self.drop_marker()?;
                }
                Ok(true) => {
                    return Err(format!(
                        "the authorization was removed but sleep is still disabled — {MANUAL_FIX}"
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "the authorization was removed but sleep could not be confirmed back on ({e}) — if the Apple-menu Sleep item is still greyed out, {MANUAL_FIX}"
                    ));
                }
            }
        }
        Ok(self.status_locked(&mut guard))
    }

    /// The battery / power-source snapshot. Errors when `pmset` cannot be read (the front
    /// then keeps its last reading rather than inventing one, and says so).
    pub fn power_source() -> Result<PowerSource, String> {
        #[cfg(target_os = "macos")]
        {
            let batt = run_capture(PMSET, &["-g", "batt"])?;
            let settings = run_capture(PMSET, &["-g"])?;
            Ok(parse_power_source(&batt, &settings))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("power source reading needs macOS".to_string())
        }
    }
}

impl Drop for SleepLock {
    /// Belt: on any teardown path that is not a crash, re-enable sleep we disabled. The app
    /// also does this explicitly at quit (`RunEvent::Exit`); a crash never runs `Drop`, which
    /// is exactly what the deadman and the launch reconcile are for.
    fn drop(&mut self) {
        let _ = self.set(false);
    }
}

// ─── Parsing & script building (pure, unit-tested) ──────────────────────────────────

/// `pmset -g` prints a `SleepDisabled 1` line while the flag is set; the line is absent (or
/// `0`) otherwise. Last token wins, case-insensitive key — the output format is undocumented.
pub fn parse_sleep_disabled(pmset_g: &str) -> bool {
    pmset_g
        .lines()
        .find(|l| l.to_ascii_lowercase().contains("sleepdisabled"))
        .and_then(|l| l.split_whitespace().last())
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Parse `pmset -g batt` (power source + charge) and `pmset -g` (`lowpowermode`).
/// `Battery Power` in the first line = on battery; the charge is the first `NN%` token.
pub fn parse_power_source(batt: &str, settings: &str) -> PowerSource {
    let on_battery = batt
        .lines()
        .next()
        .map(|l| l.contains("Battery Power"))
        .unwrap_or(false);
    let percent = batt
        .split_whitespace()
        .find_map(|tok| tok.strip_suffix("%;").or_else(|| tok.strip_suffix('%')))
        .and_then(|n| n.parse::<u8>().ok())
        .map(|n| n.min(100));
    let low_power_mode = settings
        .lines()
        .find(|l| l.trim_start().starts_with("lowpowermode"))
        .and_then(|l| l.split_whitespace().last())
        .map(|v| v == "1")
        .unwrap_or(false);
    PowerSource {
        on_battery,
        percent,
        low_power_mode,
    }
}

/// A sudoers user token we are willing to write: a conservative short-name shape. Anything
/// else is refused outright rather than quoted — the rule is pasted into a root-owned file.
/// `ALL` is a sudoers reserved word: refused too (it would grant every user).
pub fn valid_username(user: &str) -> bool {
    let mut chars = user.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    user.len() <= 32
        && !user.eq_ignore_ascii_case("all")
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Escape a string for an AppleScript double-quoted literal.
pub fn applescript_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The shell run as root by the admin sheet to install the rule. The username is validated
/// (see [`valid_username`]) so it needs no quoting; the rule is checked by `visudo -cf` on
/// a temp copy BEFORE being installed root:wheel 0440 — never written straight into place.
pub fn install_grant_script(user: &str) -> String {
    debug_assert!(valid_username(user));
    let line = SleepLock::sudoers_line(user);
    format!(
        "set -eu\n\
         t=\"$(/usr/bin/mktemp /tmp/flightdeck-sudoers.XXXXXX)\"\n\
         /usr/bin/printf '%s\\n' '{line}' > \"$t\"\n\
         if ! /usr/sbin/visudo -cf \"$t\" >/dev/null; then /bin/rm -f \"$t\"; echo 'visudo rejected the rule' >&2; exit 1; fi\n\
         /usr/bin/install -o root -g wheel -m 0440 \"$t\" '{SUDOERS_PATH}'\n\
         /bin/rm -f \"$t\"\n"
    )
}

/// The shell run as root by the admin sheet to remove the rule. When the flag is ours it
/// re-enables sleep FIRST, unconditionally (idempotent when already clear — no probe whose
/// failure could skip it), and `set -e` aborts before the `rm` if that fails: the rule then
/// stays, so the app can still release the flag itself.
pub fn remove_grant_script(reenable_sleep: bool) -> String {
    let reenable = if reenable_sleep {
        "/usr/bin/pmset -a disablesleep 0\n"
    } else {
        ""
    };
    format!("set -eu\n{reenable}/bin/rm -f '{SUDOERS_PATH}'\n")
}

/// The deadman's shell: wait for `pid` to vanish (gone, or reused by another process —
/// detected by its start time changing), then — ONLY if the marker still names that pid, so a
/// relaunched instance's fresh arm is never undone by the crashed run's watchdog — run the
/// release command and drop the marker. Polls every second: a `kill -0` + `ps` per second is
/// negligible, and a crash is undone almost at once.
const DEADMAN_SCRIPT: &str = r#"pid="$1"; marker="$2"; shift 2
start="$(/bin/ps -o lstart= -p "$pid" 2>/dev/null)"
while /bin/kill -0 "$pid" 2>/dev/null && [ "$(/bin/ps -o lstart= -p "$pid" 2>/dev/null)" = "$start" ]; do
  /bin/sleep 1
done
[ "$(/bin/cat "$marker" 2>/dev/null)" = "$pid" ] || exit 0
"$@" && /bin/rm -f "$marker"
"#;

/// The deadman command: a detached `/bin/sh` in its own process group (no group-wide
/// teardown of ours sweeps it), no stdio (never blocks on a closed pipe). `release` is the
/// command run once `pid` is gone — the sudoers-allowed `pmset -a disablesleep 0` in the app.
pub fn deadman_command(pid: u32, marker: &Path, release: &[&str]) -> Command {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(DEADMAN_SCRIPT)
        .arg("flightdeck-sleep-deadman")
        .arg(pid.to_string())
        .arg(marker)
        .args(release)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    cmd
}

// ─── Shell-outs (macOS) ─────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn run_capture(bin: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run {bin}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{bin} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The login name, from the kernel (`id -un` = effective uid), never from `$USER`: an
/// environment variable is whatever launched us said it is, and it ends up in a root file.
#[cfg(target_os = "macos")]
fn current_user() -> Result<String, String> {
    let user = run_capture("/usr/bin/id", &["-un"])?.trim().to_string();
    if user == "root" {
        return Err("refusing to write a sudoers rule for root".to_string());
    }
    if !valid_username(&user) {
        return Err(format!("unsupported account name for a sudoers rule: {user:?}"));
    }
    Ok(user)
}

/// `sudo -n -l <command>` answers "may this user run exactly this, without a password?"
/// WITHOUT running it. Both directions must be allowed.
#[cfg(target_os = "macos")]
fn probe_grant() -> Result<bool, String> {
    for value in ["1", "0"] {
        let out = Command::new(SUDO)
            .args(["-n", "-l", PMSET, "-a", "disablesleep", value])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot run sudo: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
            // The shapes of "no rule": a password would be needed, the command is not allowed
            // (sudo prints NOTHING in list mode for a plain "not permitted"). Anything else is
            // a probe failure worth surfacing.
            if err.trim().is_empty()
                || err.contains("password")
                || err.contains("not allowed")
                || err.contains("may not run")
            {
                return Ok(false);
            }
            return Err(format!("sudo probe failed: {}", err.trim()));
        }
    }
    Ok(true)
}

/// Flip the flag via the sudoers rule. `-n`: never prompt; a missing grant fails fast with
/// `a password is required`, which is the signal the front degrades on.
#[cfg(target_os = "macos")]
fn apply_flag(on: bool) -> Result<(), String> {
    let out = Command::new(SUDO)
        .args(["-n", PMSET, "-a", "disablesleep", if on { "1" } else { "0" }])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run sudo: {e}"))?;
    if out.status.success() {
        // "Written" ≠ "taken into account": re-read the flag.
        let now = run_capture(PMSET, &["-g"]).map(|s| parse_sleep_disabled(&s))?;
        if now == on {
            Ok(())
        } else {
            Err("pmset accepted the change but the flag did not follow".to_string())
        }
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        if err.contains("password is required") {
            Err("the closed-lid authorization is missing (sudo: a password is required)".to_string())
        } else {
            Err(format!("sudo pmset failed: {err}"))
        }
    }
}

/// Run `script` as root through the macOS administrator sheet. Blocks until the sheet is
/// answered. A cancelled sheet is a plain error (`cancelled by the user`), never a success.
#[cfg(target_os = "macos")]
fn run_privileged(script: &str) -> Result<(), String> {
    let apple = format!(
        "do shell script {} with administrator privileges",
        applescript_quote(script)
    );
    let out = Command::new(OSASCRIPT)
        .args(["-e", &apple])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run osascript: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let err = err.trim();
    if err.contains("User canceled") || err.contains("-128") {
        Err("cancelled by the user".to_string())
    } else {
        Err(format!("the privileged step failed: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // ── Fake backend: the system flag, the grant, scripted failures ──────────────────

    #[derive(Default)]
    struct FakeState {
        flag: bool,
        granted: bool,
        fail_read: bool,
        fail_apply: bool,
        /// `apply` "succeeds" but the flag does not move (and the re-read then fails).
        apply_leaves_flag_unknown: bool,
        fail_spawn: bool,
        fail_privileged: bool,
        /// The root `pmset -a disablesleep 0` inside the removal script fails.
        privileged_reenable_fails: bool,
        applies: Vec<bool>,
        scripts: Vec<String>,
        deadmen_spawned: usize,
        deadmen_alive: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<FakeState>>);

    impl Fake {
        fn st(&self) -> std::sync::MutexGuard<'_, FakeState> {
            self.0.lock().unwrap()
        }
        fn live_deadmen(&self) -> usize {
            let st = self.st();
            let v = st.deadmen_alive.lock().unwrap();
            v.iter().filter(|a| a.load(Ordering::SeqCst)).count()
        }
    }

    struct FakeDeadman(Arc<AtomicBool>);
    impl Deadman for FakeDeadman {
        fn alive(&mut self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
        fn kill(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }

    impl PowerBackend for Fake {
        fn supported(&self) -> bool {
            true
        }
        fn current_user(&self) -> Result<String, String> {
            Ok("alex".into())
        }
        fn sleep_disabled(&self) -> Result<bool, String> {
            let st = self.st();
            if st.fail_read {
                Err("pmset -g failed".into())
            } else {
                Ok(st.flag)
            }
        }
        fn grant_installed(&self) -> Result<bool, String> {
            Ok(self.st().granted)
        }
        fn apply(&self, on: bool) -> Result<(), String> {
            let mut st = self.st();
            st.applies.push(on);
            if st.fail_apply {
                return Err("sudo: a password is required".into());
            }
            if st.apply_leaves_flag_unknown {
                st.fail_read = true;
                return Err("pmset -g failed".into());
            }
            st.flag = on;
            Ok(())
        }
        fn spawn_deadman(&self, _marker: &Path) -> Result<Box<dyn Deadman>, String> {
            let mut st = self.st();
            if st.fail_spawn {
                return Err("cannot spawn".into());
            }
            st.deadmen_spawned += 1;
            let alive = Arc::new(AtomicBool::new(true));
            st.deadmen_alive.lock().unwrap().push(alive.clone());
            Ok(Box::new(FakeDeadman(alive)))
        }
        fn run_privileged(&self, script: &str) -> Result<(), String> {
            let mut st = self.st();
            st.scripts.push(script.to_string());
            if st.fail_privileged {
                return Err("cancelled by the user".into());
            }
            if script.contains("disablesleep 0") {
                if st.privileged_reenable_fails {
                    // `set -e`: the script aborts before removing the rule.
                    return Err("the privileged step failed: pmset".into());
                }
                st.flag = false;
            }
            if script.contains("/bin/rm -f '/etc/sudoers.d/flightdeck'") {
                st.granted = false;
            }
            if script.contains("/usr/bin/install") {
                st.granted = true;
            }
            Ok(())
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sleeplock-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lock_with(tag: &str, setup: impl FnOnce(&mut FakeState)) -> (SleepLock, Fake, PathBuf) {
        let fake = Fake::default();
        setup(&mut fake.st());
        let dir = temp_dir(tag);
        let lock = SleepLock::with_backend(&dir, Box::new(fake.clone()));
        (lock, fake, dir)
    }

    // ── Ownership state machine ─────────────────────────────────────────────────────

    #[test]
    fn arm_then_release_round_trips_with_its_net() {
        let (lock, fake, _d) = lock_with("roundtrip", |s| s.granted = true);
        let st = lock.set(true).expect("arm");
        assert!(st.system_sleep_disabled && st.owned && st.deadman_alive);
        assert_eq!(fake.st().applies, vec![true]);
        // Idempotent: no second flip, no second deadman.
        lock.set(true).unwrap();
        assert_eq!(fake.st().applies, vec![true]);
        assert_eq!(fake.st().deadmen_spawned, 1);

        let st = lock.set(false).expect("release");
        assert!(!st.system_sleep_disabled && !st.owned && !st.deadman_alive);
        assert_eq!(fake.st().applies, vec![true, false]);
        assert_eq!(fake.live_deadmen(), 0);
    }

    #[test]
    fn a_flag_set_outside_flight_deck_is_never_adopted_nor_undone() {
        let (lock, fake, _d) = lock_with("foreign", |s| {
            s.granted = true;
            s.flag = true; // `sudo pmset -a disablesleep 1` by hand, or another identity
        });
        let st = lock.set(true).expect("arming over a foreign flag is a quiet success");
        assert!(st.system_sleep_disabled, "the Mac is lid-proof anyway");
        assert!(!st.owned, "but the flag is not ours");
        assert_eq!(fake.st().deadmen_spawned, 0);
        lock.set(false).unwrap();
        assert!(fake.st().flag, "our release never touches someone else's flag");
        assert!(fake.st().applies.is_empty());
    }

    #[test]
    fn a_failed_arm_leaves_no_marker_and_no_deadman() {
        let (lock, fake, _d) = lock_with("armfail", |s| s.fail_apply = true);
        let err = lock.set(true).unwrap_err();
        assert!(err.contains("password is required"));
        assert!(!lock.owned(), "nothing armed, nothing owned");
        assert_eq!(fake.live_deadmen(), 0);
        // So a flag the user sets afterwards is theirs, and stays.
        fake.st().flag = true;
        fake.st().fail_apply = false;
        lock.set(false).unwrap();
        assert!(fake.st().flag);
    }

    #[test]
    fn a_failed_arm_with_an_unreadable_flag_keeps_the_net() {
        let (lock, fake, _d) = lock_with("armunknown", |s| s.apply_leaves_flag_unknown = true);
        assert!(lock.set(true).is_err());
        assert!(lock.owned(), "the flag may be set: dropping the marker could orphan it");
        assert_eq!(fake.live_deadmen(), 1);
    }

    #[test]
    fn a_deadman_that_cannot_spawn_aborts_the_arm() {
        let (lock, fake, _d) = lock_with("spawnfail", |s| s.fail_spawn = true);
        assert!(lock.set(true).is_err());
        assert!(!lock.owned());
        assert!(fake.st().applies.is_empty(), "never arm the flag without its net");
    }

    #[test]
    fn a_failed_release_keeps_ownership_so_it_can_be_retried() {
        let (lock, fake, _d) = lock_with("relfail", |_| {});
        lock.set(true).unwrap();
        fake.st().fail_apply = true;
        assert!(lock.set(false).is_err());
        assert!(lock.owned(), "still ours: the next release retries");
        fake.st().fail_apply = false;
        lock.set(false).unwrap();
        assert!(!fake.st().flag && !lock.owned());
    }

    #[test]
    fn a_previous_runs_marker_is_readopted_with_our_pid() {
        let (lock, fake, dir) = lock_with("readopt", |s| s.flag = true);
        std::fs::write(dir.join(MARKER_FILE), "999999\n").unwrap();
        lock.set(true).unwrap();
        let pid = std::fs::read_to_string(dir.join(MARKER_FILE)).unwrap();
        assert_eq!(pid.trim(), std::process::id().to_string());
        assert_eq!(fake.st().deadmen_spawned, 1);
        assert!(fake.st().applies.is_empty(), "already set: no flip");
    }

    #[test]
    fn launch_reconcile_reenables_a_flag_a_dead_run_left_behind() {
        let (lock, fake, dir) = lock_with("reconcile", |s| s.flag = true);
        std::fs::write(dir.join(MARKER_FILE), "999999\n").unwrap();
        lock.reconcile_at_launch().unwrap();
        assert!(!fake.st().flag);
        assert!(!lock.owned());
        assert_eq!(lock.status().reconcile_error, None);
    }

    #[test]
    fn launch_reconcile_failure_is_kept_in_the_status_until_a_release_succeeds() {
        let (lock, fake, dir) = lock_with("reconcilefail", |s| {
            s.flag = true;
            s.fail_apply = true;
        });
        std::fs::write(dir.join(MARKER_FILE), "999999\n").unwrap();
        assert!(lock.reconcile_at_launch().is_err());
        let st = lock.status();
        assert!(st.owned && st.system_sleep_disabled);
        assert!(st.reconcile_error.is_some(), "shown, not just logged");
        fake.st().fail_apply = false;
        lock.set(false).unwrap();
        assert_eq!(lock.status().reconcile_error, None);
    }

    #[test]
    fn launch_reconcile_leaves_a_foreign_flag_alone() {
        let (lock, fake, _d) = lock_with("reconcileforeign", |s| s.flag = true);
        lock.reconcile_at_launch().unwrap();
        assert!(fake.st().flag);
    }

    // ── Authorization install / remove ──────────────────────────────────────────────

    #[test]
    fn install_runs_the_sheet_and_reprobes() {
        let (lock, fake, _d) = lock_with("install", |_| {});
        let st = lock.install_grant().unwrap();
        assert!(st.granted);
        assert!(fake.st().scripts[0].contains("visudo -cf"));
        assert!(!lock.privileged_busy.load(Ordering::SeqCst));
    }

    #[test]
    fn a_cancelled_sheet_is_an_error_and_clears_the_busy_flag() {
        let (lock, _f, _d) = lock_with("cancel", |s| s.fail_privileged = true);
        assert_eq!(lock.install_grant().unwrap_err(), "cancelled by the user");
        assert!(!lock.privileged_busy.load(Ordering::SeqCst));
    }

    #[test]
    fn remove_reenables_our_flag_in_the_same_privileged_step() {
        let (lock, fake, _d) = lock_with("remove", |s| s.granted = true);
        lock.set(true).unwrap();
        fake.st().fail_read = false;
        let st = lock.remove_grant().unwrap();
        let script = fake.st().scripts.last().unwrap().clone();
        let reenable = script.find("disablesleep 0").expect("re-enables sleep");
        let rm = script.find("/bin/rm").unwrap();
        assert!(reenable < rm, "sleep first, rule second");
        assert!(script.starts_with("set -eu"));
        assert!(!st.granted && !st.owned && !st.system_sleep_disabled && !st.deadman_alive);
    }

    #[test]
    fn remove_does_not_depend_on_a_probe_to_reenable() {
        // A transient `pmset -g` failure must not skip the re-enable.
        let (lock, fake, _d) = lock_with("removeprobe", |s| s.granted = true);
        lock.set(true).unwrap();
        fake.st().fail_read = true;
        let _ = lock.remove_grant();
        assert!(fake.st().scripts.last().unwrap().contains("disablesleep 0"));
    }

    #[test]
    fn remove_never_drops_the_marker_while_sleep_may_still_be_disabled() {
        let (lock, fake, _d) = lock_with("removefail", |s| s.granted = true);
        lock.set(true).unwrap();
        fake.st().privileged_reenable_fails = true;
        assert!(lock.remove_grant().is_err());
        assert!(lock.owned(), "the rule stays and the flag is still ours to release");
        assert!(fake.st().granted);

        // Re-read after the sheet fails: the marker stays and the error names the manual fix.
        fake.st().privileged_reenable_fails = false;
        fake.st().fail_read = true;
        let err = lock.remove_grant().unwrap_err();
        assert!(err.contains("sudo pmset -a disablesleep 0"), "{err}");
        assert!(lock.owned());
    }

    #[test]
    fn remove_leaves_a_foreign_flag_alone() {
        let (lock, fake, _d) = lock_with("removeforeign", |s| {
            s.granted = true;
            s.flag = true;
        });
        lock.remove_grant().unwrap();
        assert!(!fake.st().scripts.last().unwrap().contains("disablesleep"));
        assert!(fake.st().flag);
    }

    #[test]
    fn arming_is_refused_while_an_admin_sheet_is_open() {
        let (lock, fake, _d) = lock_with("busy", |s| s.granted = true);
        lock.privileged_busy.store(true, Ordering::SeqCst);
        assert!(lock.set(true).is_err());
        assert!(fake.st().applies.is_empty());
        // Releasing is never refused (quit must always work).
        assert!(lock.set(false).is_ok());
    }

    // ── Deadman script (real /bin/sh; release command swapped for a harmless `touch`) ─

    fn wait_until(mut ok: impl FnMut() -> bool, secs: u64) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if ok() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        ok()
    }

    /// A short-lived process to watch; reaped on a thread so it does not linger as a zombie
    /// (`kill -0` succeeds on a zombie).
    fn short_lived_pid() -> u32 {
        let mut child = Command::new("/bin/sleep").arg("0.5").spawn().unwrap();
        let pid = child.id();
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        pid
    }

    #[cfg(unix)]
    #[test]
    fn deadman_releases_once_the_watched_process_is_gone() {
        let dir = temp_dir("deadman");
        let marker = dir.join(MARKER_FILE);
        let released = dir.join("released");
        let pid = short_lived_pid();
        std::fs::write(&marker, format!("{pid}\n")).unwrap();
        let mut dm = deadman_command(pid, &marker, &["/usr/bin/touch", released.to_str().unwrap()])
            .spawn()
            .unwrap();
        assert!(wait_until(|| released.exists() && !marker.exists(), 8), "release ran, marker dropped");
        let _ = dm.wait();
    }

    #[cfg(unix)]
    #[test]
    fn deadman_stands_down_when_the_marker_names_another_instance() {
        let dir = temp_dir("deadmanstale");
        let marker = dir.join(MARKER_FILE);
        let released = dir.join("released");
        let pid = short_lived_pid();
        std::fs::write(&marker, "424242\n").unwrap(); // a relaunched instance re-armed
        let mut dm = deadman_command(pid, &marker, &["/usr/bin/touch", released.to_str().unwrap()])
            .spawn()
            .unwrap();
        assert!(wait_until(|| matches!(dm.try_wait(), Ok(Some(_))), 8), "deadman exited");
        assert!(!released.exists(), "never undoes the new instance's flag");
        assert!(marker.exists(), "nor deletes its marker");
    }

    // ── Pure helpers ────────────────────────────────────────────────────────────────

    #[test]
    fn parses_the_sleep_disabled_line_whatever_the_surrounding_output() {
        let on = "System-wide power settings:\nCurrently in use:\n standby 1\n SleepDisabled 1\n sleep 1\n";
        let off = "System-wide power settings:\nCurrently in use:\n SleepDisabled 0\n sleep 1\n";
        let absent = " standby 1\n sleep 1 (sleep prevented by caffeinate)\n";
        assert!(parse_sleep_disabled(on));
        assert!(!parse_sleep_disabled(off));
        assert!(!parse_sleep_disabled(absent), "no line = flag clear, never a guess at 'on'");
    }

    #[test]
    fn parses_the_power_source_snapshot() {
        let batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=35455075)\t27%; discharging; 3:14 remaining present: true\n";
        let settings = " lowpowermode         0\n sleep 1\n";
        assert_eq!(
            parse_power_source(batt, settings),
            PowerSource { on_battery: true, percent: Some(27), low_power_mode: false }
        );
        let ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n";
        let lpm = " lowpowermode         1\n";
        assert_eq!(
            parse_power_source(ac, lpm),
            PowerSource { on_battery: false, percent: Some(100), low_power_mode: true }
        );
        assert_eq!(
            parse_power_source("Now drawing from 'AC Power'\n", ""),
            PowerSource { on_battery: false, percent: None, low_power_mode: false }
        );
    }

    #[test]
    fn username_validation_is_conservative() {
        assert!(valid_username("alexandrejosien"));
        assert!(valid_username("alex.josien-2"));
        assert!(valid_username("_svc"));
        assert!(!valid_username(""));
        assert!(!valid_username("9lives"));
        assert!(!valid_username("bad user"));
        assert!(!valid_username("a'b"));
        assert!(!valid_username("ALL=(root)"));
        assert!(!valid_username("ALL"), "sudoers reserved word");
        assert!(!valid_username("all"));
        assert!(!valid_username(&"a".repeat(33)));
    }

    #[test]
    fn the_rule_names_two_literal_commands_and_nothing_else() {
        let line = SleepLock::sudoers_line("alex");
        assert_eq!(
            line,
            "alex ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1"
        );
        assert!(!line.contains('*'), "no wildcard, ever");
    }

    #[test]
    fn install_script_validates_before_installing() {
        let s = install_grant_script("alex");
        let visudo = s.find("visudo -cf").expect("validates with visudo");
        let install = s.find("/usr/bin/install").expect("installs with install(1)");
        assert!(visudo < install, "visudo runs BEFORE the file lands");
        assert!(s.contains("-o root -g wheel -m 0440"));
        assert!(s.contains(SUDOERS_PATH));
        assert!(s.contains("alex ALL=(root) NOPASSWD:"));
    }

    #[test]
    fn remove_script_reenables_sleep_only_when_we_own_it() {
        assert!(remove_grant_script(true).contains("disablesleep 0"));
        assert!(!remove_grant_script(false).contains("disablesleep"));
        assert!(remove_grant_script(false).contains(SUDOERS_PATH));
        assert!(remove_grant_script(true).starts_with("set -eu"));
    }

    #[test]
    fn applescript_quoting_escapes_backslashes_and_quotes() {
        assert_eq!(applescript_quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        let s = install_grant_script("alex");
        let q = applescript_quote(&s);
        assert!(q.starts_with('"') && q.ends_with('"'));
        assert!(q.contains("$t"));
    }

    #[test]
    fn fresh_lock_owns_nothing_and_release_is_a_safe_noop() {
        let (lock, fake, _d) = lock_with("fresh", |_| {});
        assert!(!lock.owned());
        let status = lock.set(false).expect("release when unowned is a no-op");
        assert!(!status.owned && !status.deadman_alive);
        assert!(lock.reconcile_at_launch().is_ok());
        assert!(fake.st().applies.is_empty());
    }
}
