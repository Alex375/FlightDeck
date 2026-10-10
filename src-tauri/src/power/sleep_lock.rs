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
//!    its safety net: an OWNERSHIP MARKER (a file in the app data dir, written before arming,
//!    removed after disarming — we only ever re-enable sleep we disabled ourselves; a
//!    `sudo pmset` the user ran by hand is reported, never undone), a detached DEADMAN
//!    process that waits for our pid to vanish and then re-enables sleep (our own `-w <pid>`),
//!    a RECONCILE AT LAUNCH (marker + flag still set → a previous run died armed → re-enable),
//!    and the explicit release at quit. Reboot persistence of the flag is disputed between
//!    sources, so the net covers both cases.
//!
//! MECHANISM, not policy: the front decides when the lid-proof hold is wanted (mode ×
//! fleet activity × battery floor) and pushes `set(true|false)`; this type just converges
//! the system flag and reports the REAL state back, so the UI can show what is, not what
//! was asked. Everything here is a shell-out to Apple's own tools (`/usr/bin/pmset`,
//! `/usr/bin/sudo`, `/usr/sbin/visudo`, `/usr/bin/osascript`), all on the sealed system
//! volume — nothing to bundle, nothing a user-level process can swap.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// The sudoers drop-in this feature installs. The file name carries no `.` or `~` (sudo
/// silently ignores such files in `sudoers.d`).
pub const SUDOERS_PATH: &str = "/etc/sudoers.d/flightdeck";
/// Name of the ownership marker inside the app data dir.
const MARKER_FILE: &str = "sleep_lock_armed";

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
    /// The one-time authorization is installed and works (`sudo -n -l` accepts BOTH commands).
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

/// Holds the closed-lid flag's safety net. Tauri managed state (as an `Arc`, so blocking IPC
/// commands can take it off-thread).
pub struct SleepLock {
    marker: PathBuf,
    /// Serializes every mutation AND tracks the deadman child (spawned on the first arm,
    /// killed on disarm; on a crash it is simply never killed — that is the point).
    deadman: Mutex<Option<Child>>,
}

impl SleepLock {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            marker: data_dir.join(MARKER_FILE),
            deadman: Mutex::new(None),
        }
    }

    /// The exact rule the setup installs for `user`.
    pub fn sudoers_line(user: &str) -> String {
        format!(
            "{user} ALL=(root) NOPASSWD: {PMSET_PATH} -a disablesleep 0, {PMSET_PATH} -a disablesleep 1",
            PMSET_PATH = "/usr/bin/pmset"
        )
    }

    /// Whether we currently hold the ownership marker.
    pub fn owned(&self) -> bool {
        self.marker.exists()
    }

    fn deadman_alive_locked(guard: &mut Option<Child>) -> bool {
        matches!(guard.as_mut().map(|c| c.try_wait()), Some(Ok(None)))
    }

    /// Read the real state. Never errors: a probe that cannot run is reported in
    /// `probe_error` with `granted: false`, so the UI degrades visibly instead of guessing.
    pub fn status(&self) -> SleepLockStatus {
        let mut guard = self.deadman.lock().unwrap();
        self.status_locked(&mut guard)
    }

    #[cfg(target_os = "macos")]
    fn status_locked(&self, guard: &mut Option<Child>) -> SleepLockStatus {
        let (user, mut probe_error) = match current_user() {
            Ok(u) => (u, None),
            Err(e) => (String::new(), Some(e)),
        };
        let granted = if user.is_empty() {
            false
        } else {
            match probe_grant() {
                Ok(g) => g,
                Err(e) => {
                    probe_error = Some(e);
                    false
                }
            }
        };
        let system_sleep_disabled = match system_sleep_disabled() {
            Ok(v) => v,
            Err(e) => {
                probe_error.get_or_insert(e);
                false
            }
        };
        SleepLockStatus {
            supported: true,
            sudoers_line: Self::sudoers_line(&user),
            user,
            granted,
            system_sleep_disabled,
            owned: self.owned(),
            deadman_alive: Self::deadman_alive_locked(guard),
            sudoers_path: SUDOERS_PATH.to_string(),
            probe_error,
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn status_locked(&self, guard: &mut Option<Child>) -> SleepLockStatus {
        SleepLockStatus {
            supported: false,
            user: String::new(),
            granted: false,
            system_sleep_disabled: false,
            owned: self.owned(),
            deadman_alive: Self::deadman_alive_locked(guard),
            sudoers_path: SUDOERS_PATH.to_string(),
            sudoers_line: String::new(),
            probe_error: Some("closed-lid modes need macOS".to_string()),
        }
    }

    /// Converge the system flag to `on`. IDEMPOTENT (the front pushes its desired state on
    /// every change and on a heartbeat). Arming: marker first, then the flag, then the
    /// deadman — so there is never a moment where the flag is set without its net. Disarming
    /// only touches a flag WE armed (marker present); a flag someone else set is left alone
    /// and reported. Returns the real state after the attempt; `Err` when the flag could not
    /// be set (grant missing/revoked, `sudo` failure) so the caller can fall back and tell
    /// the user — never a silent "on" while the Mac quietly sleeps.
    pub fn set(&self, on: bool) -> Result<SleepLockStatus, String> {
        let mut guard = self.deadman.lock().unwrap();
        let outcome = self.set_locked(&mut guard, on);
        let status = self.status_locked(&mut guard);
        outcome.map(|_| status)
    }

    #[cfg(target_os = "macos")]
    fn set_locked(&self, guard: &mut Option<Child>, on: bool) -> Result<(), String> {
        if !on && !self.owned() {
            // Not ours (or already released): nothing to undo, nothing to read. A flag set
            // by hand stays; a stray deadman (none expected) is dropped.
            Self::kill_deadman(guard);
            return Ok(());
        }
        let disabled_now = system_sleep_disabled()?;
        if on {
            // Marker BEFORE the flag: if we die between the two, the launch reconcile sees
            // a marker with the flag clear and just removes the marker — harmless. The
            // reverse order would leave a flag with no owner, i.e. a Mac nobody re-enables.
            std::fs::write(&self.marker, format!("{}\n", std::process::id()))
                .map_err(|e| format!("cannot write the ownership marker: {e}"))?;
            if !Self::deadman_alive_locked(guard) {
                *guard = Some(spawn_deadman(&self.marker)?);
            }
            if !disabled_now {
                apply_flag(true)?;
            }
            Ok(())
        } else {
            if disabled_now {
                apply_flag(false)?;
            }
            // Flag is clear: drop the net. Deadman first (it would otherwise race us on the
            // marker), marker last (it is the "still armed" truth for the next launch).
            Self::kill_deadman(guard);
            let _ = std::fs::remove_file(&self.marker);
            Ok(())
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn set_locked(&self, _guard: &mut Option<Child>, on: bool) -> Result<(), String> {
        if on {
            Err("closed-lid modes need macOS".to_string())
        } else {
            Ok(())
        }
    }

    fn kill_deadman(guard: &mut Option<Child>) {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// At launch: a marker left behind means a previous run died armed (crash, force-quit,
    /// dead battery). If the flag is still set, re-enable sleep; either way drop the stale
    /// marker. Best-effort and quiet on success; the error (typically: grant missing, so
    /// the Mac is STILL sleepless) is returned so the caller can surface it — the front's
    /// first status read will show `owned && system_sleep_disabled && !granted` too.
    pub fn reconcile_at_launch(&self) -> Result<(), String> {
        let mut guard = self.deadman.lock().unwrap();
        if !self.owned() {
            return Ok(());
        }
        self.set_locked(&mut guard, false)
    }

    /// Install the one-time authorization through the macOS admin sheet. BLOCKS until the
    /// user answers the sheet (run it off the UI thread). Validates the rule with
    /// `visudo -cf` before installing, then re-probes: "written" ≠ "taken into account".
    pub fn install_grant(&self) -> Result<SleepLockStatus, String> {
        let mut guard = self.deadman.lock().unwrap();
        #[cfg(target_os = "macos")]
        {
            let user = current_user()?;
            run_privileged(&install_grant_script(&user))?;
            let status = self.status_locked(&mut guard);
            if !status.granted {
                return Err(match status.probe_error.clone() {
                    Some(e) => format!("the rule was written but sudo still refuses it: {e}"),
                    None => "the rule was written but sudo still refuses it".to_string(),
                });
            }
            Ok(status)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = &mut guard;
            Err("closed-lid modes need macOS".to_string())
        }
    }

    /// Remove the authorization through the admin sheet. The same privileged step also
    /// re-enables sleep if WE had disabled it — removing the feature must never leave the
    /// Mac sleepless with no way left to fix it.
    pub fn remove_grant(&self) -> Result<SleepLockStatus, String> {
        let mut guard = self.deadman.lock().unwrap();
        #[cfg(target_os = "macos")]
        {
            let reenable = self.owned() && system_sleep_disabled().unwrap_or(false);
            run_privileged(&remove_grant_script(reenable))?;
            Self::kill_deadman(&mut guard);
            let _ = std::fs::remove_file(&self.marker);
            Ok(self.status_locked(&mut guard))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = &mut guard;
            Err("closed-lid modes need macOS".to_string())
        }
    }

    /// The battery / power-source snapshot. Errors when `pmset` cannot be read (the front
    /// then keeps its last reading rather than inventing one).
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

// ─── Parsing (pure, unit-tested) ────────────────────────────────────────────────────

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
pub fn valid_username(user: &str) -> bool {
    let mut chars = user.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    user.len() <= 32
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

/// The shell run as root by the admin sheet to remove the rule, re-enabling sleep first
/// when we are the ones who disabled it.
pub fn remove_grant_script(reenable_sleep: bool) -> String {
    let reenable = if reenable_sleep {
        "/usr/bin/pmset -a disablesleep 0\n"
    } else {
        ""
    };
    format!("set -u\n{reenable}/bin/rm -f '{SUDOERS_PATH}'\n")
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

#[cfg(target_os = "macos")]
fn current_user() -> Result<String, String> {
    let user = match std::env::var("USER") {
        Ok(u) if !u.is_empty() => u,
        _ => run_capture("/usr/bin/id", &["-un"])?.trim().to_string(),
    };
    if user == "root" {
        return Err("refusing to write a sudoers rule for root".to_string());
    }
    if !valid_username(&user) {
        return Err(format!("unsupported account name for a sudoers rule: {user:?}"));
    }
    Ok(user)
}

#[cfg(target_os = "macos")]
fn system_sleep_disabled() -> Result<bool, String> {
    run_capture(PMSET, &["-g"]).map(|s| parse_sleep_disabled(&s))
}

/// `sudo -n -l <command>` answers "may this user run exactly this, without a password?"
/// WITHOUT running it. Both directions must be allowed, or the rule is not ours.
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
            // The two shapes of "no rule": a password would be needed, or the command is
            // not allowed at all. Anything else is a probe failure worth surfacing.
            if err.contains("password") || err.contains("not allowed") || err.contains("may not run")
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
        if system_sleep_disabled()? == on {
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

/// Spawn the deadman: a detached `/bin/sh` that waits for THIS process to vanish (pid gone,
/// or the pid reused by another process — detected by its start time changing), then runs
/// the sudoers-allowed `pmset -a disablesleep 0` and drops the marker. Its own process
/// group so no group-wide teardown of ours sweeps it; no stdio so it never blocks on a
/// closed pipe. Our `-w <pid>`.
#[cfg(target_os = "macos")]
fn spawn_deadman(marker: &Path) -> Result<Child, String> {
    use std::os::unix::process::CommandExt;
    const SCRIPT: &str = r#"pid="$1"; marker="$2"
start="$(/bin/ps -o lstart= -p "$pid" 2>/dev/null)"
while /bin/kill -0 "$pid" 2>/dev/null && [ "$(/bin/ps -o lstart= -p "$pid" 2>/dev/null)" = "$start" ]; do
  /bin/sleep 3
done
/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0 && /bin/rm -f "$marker"
"#;
    Command::new("/bin/sh")
        .arg("-c")
        .arg(SCRIPT)
        .arg("flightdeck-sleep-deadman")
        .arg(std::process::id().to_string())
        .arg(marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("cannot spawn the sleep deadman: {e}"))
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
        // A desktop: no battery line at all → no percent, not on battery.
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
    }

    #[test]
    fn applescript_quoting_escapes_backslashes_and_quotes() {
        assert_eq!(applescript_quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        // A real install script round-trips through the quoting without losing its `$` or
        // newlines (AppleScript leaves them alone; only `\` and `"` are special).
        let s = install_grant_script("alex");
        let q = applescript_quote(&s);
        assert!(q.starts_with('"') && q.ends_with('"'));
        assert!(q.contains("$t"));
    }

    #[test]
    fn fresh_lock_owns_nothing_and_release_is_a_safe_noop() {
        let dir = std::env::temp_dir().join(format!("sleeplock-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lock = SleepLock::new(&dir);
        assert!(!lock.owned());
        // Releasing an unowned lock never touches sudo (no marker → early return) and
        // reports the real state without error.
        let status = lock.set(false).expect("release when unowned is a no-op");
        assert!(!status.owned);
        assert!(!status.deadman_alive);
        assert!(lock.reconcile_at_launch().is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
