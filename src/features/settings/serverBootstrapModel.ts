// Pure view-model helpers for the B12 server bootstrap wizard + status panel — kept
// separate from the components (same split as `parseTicket`/`buildServerCommand` in
// ControlSection.tsx) so the state machine is unit-testable without mounting React.
//
// Wire reference: `src-tauri/src/bootstrap/orchestrator.rs` — read its module doc
// before changing this file, it explains the two different "needs more input" shapes
// this file interprets (`NeedsInputBlocking` vs `NeedsInputContinue`).
import type {
  BootstrapProgressStep,
  BootstrapReport,
  DiagnosisState,
  RepairAction,
  ServerDiagnosis,
  StepId,
  StepState,
  StepStatus,
} from "../../ipc/client";

/** Human label for each pipeline step, in [`STEP_ORDER`] — the checklist's fixed row
 *  order, mirroring `orchestrator::build_pipeline`'s own fixed order exactly (see the
 *  module doc: "Order is FIXED — the whole point of the pipeline"). */
export const STEP_LABELS: Record<StepId, string> = {
  install_key: "Authorize this Mac's key",
  probe: "Check the server",
  install_claude: "Install Claude Code",
  upload_daemon: "Install the Flight Deck daemon",
  run_init: "Initialize the daemon",
  install_service: "Set up the background service",
  escalate_persistence: "Enable persistence (survive logout & reboot)",
  claude_auth: "Check Claude Code sign-in",
  add_machine: "Save this server",
  diagnose: "Final check",
};

export const STEP_ORDER: readonly StepId[] = [
  "install_key",
  "probe",
  "install_claude",
  "upload_daemon",
  "run_init",
  "install_service",
  "escalate_persistence",
  "claude_auth",
  "add_machine",
  "diagnose",
];

/** One checklist row — a step's identity plus its label, ready to render. */
export interface StepRowVM {
  id: StepId;
  label: string;
  status: StepStatus;
  detail: string | null;
}

/** Maps the wire's [`StepState`] array onto display rows. Always returns exactly
 *  [`STEP_ORDER`]'s 9 rows, defaulting an ABSENT step (a report from before the run
 *  even started, or a fake/partial fixture) to `pending` with no detail — never fewer
 *  rows than the fixed pipeline, so the checklist can't silently miss a step. */
export function toStepRows(steps: readonly StepState[]): StepRowVM[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  return STEP_ORDER.map((id) => {
    const s = byId.get(id);
    return { id, label: STEP_LABELS[id], status: s?.status ?? "pending", detail: s?.detail ?? null };
  });
}

function stepById(steps: readonly StepState[], id: StepId): StepState | null {
  return steps.find((s) => s.id === id) ?? null;
}

/** [`BootstrapProgressEvent.steps`] carries `id`/`status` as plain wire strings
 *  (`BootstrapProgressStep`, not the checked [`StepState`] union `BootstrapReport`
 *  itself uses) — this is the one place that trusts the backend's fixed spellings
 *  (`StepId::wire_str`/`StepStatus::wire_str`) and narrows them back, so every OTHER
 *  helper in this file can work with a single, checked [`StepState`] shape regardless
 *  of whether it came from a live event or a resolved report. */
export function stepStateFromProgress(steps: readonly BootstrapProgressStep[]): StepState[] {
  return steps.map((s) => ({ id: s.id as StepId, status: s.status as StepStatus, detail: s.detail }));
}

/** Whether the WHOLE pipeline is paused waiting for a sudo password —
 *  [`StepId.EscalatePersistence`]'s own `NeedsInputBlocking` (see the module doc's
 *  "two different kinds of needs-input"). This is the ONLY case the pipeline actually
 *  stops running; the two below let it keep going. */
export function needsSudoPassword(report: Pick<BootstrapReport, "needs_input">): boolean {
  return report.needs_input === "escalate_persistence";
}

/** The non-blocking "restart pending" pause on [`StepId.UploadDaemon`], if the
 *  pipeline reached it this run (see the module doc's RESTART RULE) — `null` when the
 *  step hasn't run yet, succeeded, or was skipped. */
export function restartPendingStep(steps: readonly StepState[]): StepState | null {
  const s = stepById(steps, "upload_daemon");
  return s && s.status === "needs_input" ? s : null;
}

/** The non-blocking "needs Claude sign-in" pause on [`StepId.ClaudeAuth`], if the
 *  pipeline reached it this run — `null` otherwise (not reached yet, or already
 *  signed in). */
export function claudeSignInStep(steps: readonly StepState[]): StepState | null {
  const s = stepById(steps, "claude_auth");
  return s && s.status === "needs_input" ? s : null;
}

/** Whether [`StepId.InstallKey`]'s own failure text is the backend's
 *  `BootstrapError::HostKeyMismatch` — its `Display` renders the fixed string "the
 *  server's host key does not match what was expected" (`askpass.rs`), which
 *  `step_install_key` forwards verbatim as the step's `detail` on that error path. The
 *  front's cue to offer "Review the new key" (I6) instead of a bare error. */
export function isHostKeyMismatch(detail: string | null): boolean {
  return !!detail && detail.includes("host key does not match what was expected");
}

/** The command that prints a server's own host-key fingerprint — run on ITS console
 *  (not over the connection being checked, which an interceptor would answer) to compare
 *  with what `bootstrap_check_host_key` reports. `keyType` is that report's `key_type`
 *  (`ED25519`, `ECDSA`, `RSA`, …); anything unexpected falls back to the ed25519 key,
 *  the one every current OpenSSH server offers first. */
export function hostKeyConsoleCommand(keyType: string): string {
  const name = keyType.toLowerCase().replace(/-sk$/, "");
  const file = /^[a-z0-9]+$/.test(name) ? name : "ed25519";
  return `ssh-keygen -lf /etc/ssh/ssh_host_${file}_key.pub`;
}

/** Whether an `add_machine` failure is ssh refusing a CHANGED host key — that probe
 *  forwards ssh's own last stderr line ("Host key verification failed."), not the
 *  bootstrap's `HostKeyMismatch` wording {@link isHostKeyMismatch} matches. The cue to
 *  offer "Review the new key" (`bootstrap_forget_host_key` replaces the key in the same
 *  known_hosts file both flows pin into). */
export function isHostKeyRejected(message: string | null): boolean {
  return !!message && message.includes("Host key verification failed");
}

/** Whether a `machine_repair`/`bootstrap_resume` error string is the backend's
 *  `BootstrapError::NeedsSudoPassword` wording ("this server needs a sudo password to
 *  continue") — the front's cue to prompt for one rather than just showing the raw
 *  error. `machine_repair` returns a plain `String` error (no discriminated variant on
 *  the wire), so matching the fixed `Display` text is the only way to tell the two
 *  apart. */
export function isSudoPasswordError(message: string | null): boolean {
  return !!message && message.includes("needs a sudo password");
}

/** Whether a `machine_repair` error string is the backend's
 *  `BootstrapError::NeedsConnectionPassword` wording ("this server needs its login
 *  password to reconnect") — the front's cue to prompt for THIS server's SSH login
 *  password (never a `sudo` password) for {@link RepairAction} `"reconnect_mac"`.
 *  Mirrors {@link isSudoPasswordError}'s own wording-contract pattern; deliberately
 *  worded so the two never match each other's message (a repair dispatch must show
 *  the right password prompt, not either one guessed from the other). */
export function isNeedsConnectionPasswordError(message: string | null): boolean {
  return !!message && message.includes("needs its login password to reconnect");
}

/** Whether a `bootstrap_server`/`bootstrap_resume`/`machine_repair` error string is
 *  the backend's per-server lock rejection (`server_busy_error`, `orchestrator.rs`) —
 *  another one of the three is already running against this same server. Wording
 *  contract with the Rust side's `server_busy_error`: keep the two in sync (same
 *  discipline as `isSudoPasswordError` above, or TOSSE's `SESSION_GONE_MARKERS`) — a
 *  reworded message here silently stops this from being told apart from any other
 *  failure. */
export function isServerBusyError(message: string | null): boolean {
  return !!message && message.includes("is already running on this server");
}

/** https + one of Claude's own sign-in domains (exact host or a subdomain) — the
 *  wizard's gate before ever calling `openUrl` on a URL the remote server handed back
 *  over SSH via [`ServerLoginPromptEvent`]. Anything else (a plain host mismatch, an
 *  unparsable string, a non-https scheme) is rejected — the code-paste fallback stays
 *  available either way, so refusing to auto-open never blocks the sign-in itself. */
const TRUSTED_SIGNIN_HOSTS = ["claude.ai", "claude.com", "anthropic.com"];
export function isTrustedSignInUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return TRUSTED_SIGNIN_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

// ---- ServerStatusPanel ------------------------------------------------------------

/** The repairs that need Flight Deck's OWN key file — never offered for a server
 *  connected with this Mac's own SSH keys. Mirror of `KEY_ONLY_REPAIRS` in
 *  `orchestrator.rs` (the backend refuses them up front); the Rust test
 *  `key_only_repairs_match_the_front` keeps the two lists identical, in order. One
 *  exception, decided by the backend too: `install_service`'s PATH fix of a user unit
 *  (`installed_as: "user"` with `user_unit_missing_path: true`) needs no key. */
export const KEY_ONLY_REPAIRS = ["reupload_daemon", "install_service", "reconnect_mac"] as const satisfies readonly RepairAction[];

/** A tri-state fact rendered as one of three words — `unknown` is a real, distinct
 *  outcome (a missing/garbled probe marker — see `ServerDiagnosis`'s own doc), never
 *  folded into "no". */
export type Tri = "yes" | "no" | "unknown";
export function tri(v: boolean | null | undefined): Tri {
  return v === true ? "yes" : v === false ? "no" : "unknown";
}

/** Which of the app's semantic status hues a headline [`DiagnosisState`] renders with
 *  — `ready` (green), `attention` (amber — needs Claude sign-in, actionable now),
 *  `caution` (blue — running fine but wouldn't survive a reboot), `error` (red). */
export type HeadlineTone = "ready" | "attention" | "caution" | "error";

export function headlineTone(state: DiagnosisState): HeadlineTone {
  switch (state.kind) {
    case "ready":
      return "ready";
    case "needs_claude_install":
    case "needs_claude_sign_in":
      return "attention";
    case "running_not_reboot_safe":
      return "caution";
    case "failed":
      return "error";
  }
}

export function headlineLabel(state: DiagnosisState): string {
  switch (state.kind) {
    case "ready":
      return "Ready";
    case "needs_claude_install":
      // (B14 fix round 3 — minor) `needs_claude_install` also covers a PRESENT but
      // broken `claude` binary (wrong arch/libc, a truncated download — see
      // `collapse_state`'s own doc in orchestrator.rs, which folds both into this one
      // state on purpose). "not installed" would be literally false for that case —
      // this wording is accurate either way.
      return "Claude Code isn't working on this server";
    case "needs_claude_sign_in":
      return "Needs Claude sign-in";
    case "running_not_reboot_safe":
      return "Running — not reboot-safe";
    case "failed":
      return `Failed — ${state.reason}`;
  }
}

/** One actionable fix the panel can offer for a canned [`ServerDiagnosis`], paired
 *  with the exact [`RepairAction`] `machine_repair` expects. */
export interface RepairSuggestion {
  action: RepairAction;
  title: string;
  reason: string;
}

/**
 * Derives which repairs are worth offering from a diagnosis's independent tri-state
 * facts — never from the single headline `state` alone, so e.g. a `Ready` server that
 * happens to have `sleep_masked: false` (the pairing checkbox was off) still offers to
 * mask sleep. Order is stable (matches the rows the panel lists above it) so the
 * buttons don't reshuffle between refreshes. `unknown` facts never suggest a
 * repair — only a CONFIRMED problem does (never guessing from a missing probe marker).
 *
 * `sign_in_claude` deliberately never appears here: unlike every other action, the
 * front cannot complete that flow through `machine_repair` (its `RepairOutcome` only
 * carries a human summary string, not the `LoginSession` handle
 * `submit_claude_login_code` needs) — `ServerStatusPanel` drives it directly through
 * `start_claude_login` instead, the same inline flow the wizard itself uses. See
 * `deviations_from_brief` in the B12 report.
 *
 * `install_claude` (B14) is the OPPOSITE case: unlike `sign_in_claude` it needs no
 * interactive handle back — `machine_repair` running the installer and returning a
 * plain summary string is all this needs — so it DOES appear here.
 */
export function repairSuggestionsFor(
  d: ServerDiagnosis,
  /** `dedicatedKey: false` — the server was connected with this Mac's own SSH keys
   *  ("Connect an existing server"), so Flight Deck holds no key of its own for it:
   *  no action that needs one is offered (the backend refuses every one of them —
   *  see {@link repairNeedsDedicatedKey}); {@link keyOnlyManualSteps} lists them
   *  instead, saying how to get the key. */
  opts: { dedicatedKey?: boolean } = {},
): RepairSuggestion[] {
  const all = everyRepairSuggestion(d);
  return opts.dedicatedKey === false ? all.filter((s) => !repairNeedsDedicatedKey(s.action, d)) : all;
}

/** Whether `action`, offered for a server diagnosed as `d`, needs Flight Deck's own key
 *  — {@link KEY_ONLY_REPAIRS} minus `install_service`'s PATH fix of a user unit
 *  ({@link installServiceIsPathFix}), which runs over plain SSH. Mirror of
 *  `repair_needs_dedicated_key` (`orchestrator.rs`). */
export function repairNeedsDedicatedKey(action: RepairAction, d: ServerDiagnosis): boolean {
  if (action === "install_service" && installServiceIsPathFix(d)) return false;
  return (KEY_ONLY_REPAIRS as readonly RepairAction[]).includes(action);
}

/** `install_service` on `d` is the PATH fix of a confirmed user unit missing its
 *  `Environment=PATH=` line — offered as "Fix the background service's PATH", and the
 *  one `install_service` that needs no key of Flight Deck's. Mirror of
 *  `install_service_repair_needs_path_fix` (`orchestrator.rs`). */
export function installServiceIsPathFix(d: ServerDiagnosis): boolean {
  return d.installed_as === "user" && d.user_unit_missing_path === true;
}

/** The daemon is CONFIRMED stopped: its status reached nothing AND no `flightdeckd run`
 *  process or active unit was seen on the server. Only then is a stopped-daemon
 *  restart offered — the backend (`restart_plan`) refuses any other, since a status
 *  this SSH login can't read may belong to a live daemon (another user's, or one whose
 *  socket or binary is gone) that a restart would kill. */
export function daemonConfirmedStopped(d: ServerDiagnosis): boolean {
  return d.daemon_running === false && d.daemon_process_seen === false;
}

/** Every repair `d` calls for, whatever key Flight Deck holds for the server —
 *  {@link repairSuggestionsFor} filters it down to what can actually run. */
function everyRepairSuggestion(d: ServerDiagnosis): RepairSuggestion[] {
  // (CRM `c9bf1482`) Nothing below this point is CONFIRMED about an unreachable
  // server — every one of `claude_installed`/`installed_as`/`daemon_running`/…
  // is `null` ("unknown"), never `false`, for a diagnosis that never even got an
  // ssh answer (see `ServerDiagnosis::unreachable_with`, Rust). Falling through to
  // the body below used to read `claude_installed !== true` as "not installed" and
  // offer "Install Claude Code" for a server that was simply unreachable — the
  // real incident's bogus suggestion. `key_refused` is the one classification with
  // an actual fix this Mac can apply on its own; every other unreachable case has
  // nothing to suggest here (the Settings card's own informational text/fact row
  // covers `host_key_changed`/Tailscale instead — see `ServerStatusPanel.tsx`).
  // `reconnect_mac` re-pushes Flight Deck's own key: on a server without one it is
  // filtered out, and the card explains the refusal instead (`DiagnosisSummary`).
  if (!d.reachable) {
    return d.link_issue === "key_refused"
      ? [{ action: "reconnect_mac", title: "Reconnect this Mac", reason: "this server refused this Mac's saved key" }]
      : [];
  }
  // A Mac server is set up by hand (LaunchAgent): every systemd fix below would run
  // commands that don't exist there, and the backend refuses them anyway. What's left
  // is installing Claude (the official installer supports macOS) and restarting the
  // LaunchAgent; the rest is listed as steps to do on the Mac — see `macManualSteps`.
  if (isMacServer(d)) {
    const mac: RepairSuggestion[] = [];
    if (d.claude_installed !== true) {
      mac.push({
        action: "install_claude",
        title: "Install Claude Code",
        reason: "Claude Code isn't installed or isn't working on this Mac",
      });
    }
    // Several agents: Restart refuses to pick one — `macManualSteps` says to keep one.
    if (d.installed_as === "launch_agent" && !hasSeveralLaunchAgents(d)) {
      if (d.restart_pending) {
        mac.push({ action: "restart_daemon", title: "Restart the daemon", reason: "a newer version is installed but not running yet" });
      } else if (daemonConfirmedStopped(d)) {
        mac.push({ action: "restart_daemon", title: "Restart the daemon", reason: "the LaunchAgent isn't running" });
      }
    }
    return mac;
  }
  const out: RepairSuggestion[] = [];
  if (d.claude_installed !== true) {
    out.push({
      action: "install_claude",
      title: "Install Claude Code",
      // (B14 fix round 3 — minor) `claude_installed !== true` also covers a PRESENT
      // but broken binary (see `headlineLabel`'s own note above) — worded to be
      // accurate for both, since `install_claude` (reinstalling) fixes either.
      reason: "Claude Code isn't installed or isn't working on this server",
    });
  }
  if (installServiceIsPathFix(d)) {
    out.push({
      action: "install_service",
      title: "Fix the background service's PATH",
      reason: "the background service was set up before this app knew to add claude's install location to its PATH",
    });
  }
  if (d.installed_as === "none") {
    out.push({
      action: "reupload_daemon",
      title: "Re-upload the daemon",
      reason: "the Flight Deck daemon isn't on this server",
    });
  }
  if (d.daemon_outdated && d.installed_as !== "none") {
    out.push({
      action: "reupload_daemon",
      title: "Update the daemon",
      reason: d.bundled_daemon_version
        ? `this server runs an older daemon than the one bundled with this app (${d.bundled_daemon_version})`
        : "this server runs an older daemon than the one bundled with this app",
    });
  }
  if (d.restart_pending) {
    out.push({
      action: "restart_daemon",
      title: "Restart the daemon",
      reason: "a newer version is installed but not running yet",
    });
  } else if (daemonConfirmedStopped(d) && d.installed_as !== "none") {
    out.push({ action: "restart_daemon", title: "Restart the daemon", reason: "the daemon isn't running" });
  }
  if (d.reboot_safe === false) {
    if (d.installed_as === "user") {
      out.push({
        action: "enable_linger",
        title: "Enable linger",
        reason: "this user's session won't survive a reboot yet",
      });
    } else if (d.installed_as === "detached" || d.installed_as === "system") {
      out.push({
        action: "install_service",
        title: "Install the persistence service",
        reason: "this server won't survive a reboot yet",
      });
    }
  }
  if (d.sleep_masked === false) {
    out.push({
      action: "mask_sleep",
      title: "Mask sleep / suspend",
      reason: "this server could sleep and drop its connections",
    });
  }
  return out;
}

/** Whether Claude is INSTALLED but needs signing in (logged out, or unconfirmed
 *  either way) — drives the panel's own inline sign-in action, kept apart from
 *  {@link repairSuggestionsFor} for the reason documented there.
 *
 * (B14) Deliberately requires `claude_installed === true`: `ClaudeSignInInline` must
 * never be offered while claude is missing (that case is `install_claude`'s job
 * instead, in {@link repairSuggestionsFor}) — offering a sign-in flow for a server
 * with no `claude` to sign in with was never actionable, it just failed on the first
 * click. See {@link claudeNeedsInstall} for the complementary check. */
export function claudeNeedsSignIn(d: ServerDiagnosis): boolean {
  // Never on a Mac: the inline flow signs in over SSH, which can't reach the Keychain
  // the daemon's claude reads — `macManualSteps` says to sign in on the Mac instead.
  return !isMacServer(d) && d.claude_installed === true && d.claude_logged_in !== true;
}

/** `uname -s` of a Mac, as `ServerDiagnosis.host_os` reports it. */
const MACOS_UNAME = "Darwin";

/** Whether the diagnosed server is a Mac (a hand-made LaunchAgent, never installed by
 *  this app — its installer is Linux-only). */
export function isMacServer(d: ServerDiagnosis): boolean {
  return d.host_os === MACOS_UNAME;
}

/** More than one `~/Library/LaunchAgents` plist runs flightdeckd on this Mac — none of
 *  them is "the" agent, so the backend leaves its login/reboot facts unknown and
 *  refuses to restart it (`ServerDiagnosis.launch_agent_plists`). */
export function hasSeveralLaunchAgents(d: ServerDiagnosis): boolean {
  return d.launch_agent_plists.length > 1;
}

/** `s` as one shell word: as is when it's plainly safe, single-quoted otherwise. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** The plain `ssh` command that reaches a server with this Mac's own SSH setup — what
 *  the card tells the user to try in Terminal when that setup was refused. */
export function sshCommandFor(target: { user: string; host: string; port: number }): string {
  const port = target.port === 22 ? "" : `-p ${target.port} `;
  return `ssh ${port}${target.user}@${target.host}`;
}

/** Something the user does by hand — shown as text, never a button: Flight Deck can't
 *  (or must not) do it itself. Which kind decides the lead line it is listed under
 *  ({@link MANUAL_STEP_LEADS}). */
export interface ManualStep {
  title: string;
  detail: string;
  /** A command to run in Terminal ON the server, when there is one. */
  command?: string;
}

/** `mac` — done on a Mac server itself ({@link macManualSteps}); `key` — a fix Flight
 *  Deck could run, but only with a key of its own ({@link keyOnlyManualSteps}). */
export type ManualStepKind = "key" | "mac";

/** The line each kind of {@link ManualStep} is listed under — it carries what the steps
 *  have in common, so each step only says what is wrong. */
export const MANUAL_STEP_LEADS: Record<ManualStepKind, string> = {
  key: "These fixes need a key Flight Deck holds, and this server was connected with this Mac's own SSH keys. To get them here, reconnect it with “Connect an existing server” and choose “A key for Flight Deck”:",
  mac: "On the Mac itself — Flight Deck can't change these over SSH:",
};

/** One lead line and the steps listed under it. */
export interface ManualStepGroup {
  kind: ManualStepKind;
  lead: string;
  steps: ManualStep[];
}

/** Every non-empty group of manual steps for `d`, in the order the card lists them:
 *  the repairs that are waiting on a key first (they sit right under the repair
 *  buttons they would have been), then a Mac's own steps. */
export function manualStepGroups(d: ServerDiagnosis, opts: { dedicatedKey?: boolean } = {}): ManualStepGroup[] {
  const groups: ManualStepGroup[] = [
    { kind: "key", lead: MANUAL_STEP_LEADS.key, steps: keyOnlyManualSteps(d, opts) },
    { kind: "mac", lead: MANUAL_STEP_LEADS.mac, steps: macManualSteps(d) },
  ];
  return groups.filter((g) => g.steps.length > 0);
}

/** The repairs `d` calls for that {@link repairSuggestionsFor} withholds from a server
 *  without Flight Deck's own key (`dedicatedKey: false`) — the backend would refuse
 *  every one of them. Listed as steps instead, so the problem they fix is never
 *  hidden, under the `key` lead saying how to get the key. Empty with a key, and for an
 *  unreachable server (its refused key gets its own note — `DiagnosisSummary`). */
export function keyOnlyManualSteps(d: ServerDiagnosis, opts: { dedicatedKey?: boolean } = {}): ManualStep[] {
  if (opts.dedicatedKey !== false || !d.reachable) return [];
  return everyRepairSuggestion(d)
    .filter((s) => repairNeedsDedicatedKey(s.action, d))
    .map((s) => ({ title: s.title, detail: `${s.reason.charAt(0).toUpperCase()}${s.reason.slice(1)}.` }));
}

/** The fixes a Mac server needs that only its owner can apply, in the order the
 *  panel's fact rows list them. Empty for a Linux server (its fixes are repair
 *  buttons, see {@link repairSuggestionsFor}) and for an unreachable one (nothing is
 *  known). A CONFIRMED problem produces a step — and so does a fact the diagnosis
 *  could not read when it decides whether the Mac works (Claude's sign-in, automatic
 *  login, whether the agent starts at login): left unexplained, it would leave the
 *  headline amber or blue with nothing to act on. */
export function macManualSteps(d: ServerDiagnosis): ManualStep[] {
  if (!d.reachable || !isMacServer(d)) return [];
  const steps: ManualStep[] = [];
  if (d.installed_as === "none") {
    steps.push({
      title: "Install flightdeckd on the Mac",
      detail:
        "Flight Deck only installs its daemon on Linux. Put a macOS build of flightdeckd in ~/.local/bin and run it as a LaunchAgent of this user.",
    });
  }
  // Usually the agent the user meant to set up — so it comes before "no LaunchAgent".
  const invalid = d.invalid_launch_agent_plists;
  if (invalid.length > 0) {
    const one = invalid.length === 1;
    steps.push({
      title: one ? "Fix the LaunchAgent's plist" : "Fix the LaunchAgent plists",
      detail: `${invalid.join(", ")} ${one ? "mentions" : "mention"} flightdeckd but can't be parsed: launchd can't load ${one ? "it" : "them"}, and Flight Deck can't tell what ${one ? "it runs" : "they run"}. plutil -lint says what's wrong (often an unescaped & in a command — write it &amp;); fix it, then refresh.`,
      command: `plutil -lint ${invalid.map(shellWord).join(" ")}`,
    });
  }
  if (d.installed_as === "detached") {
    steps.push({
      title: "Run flightdeckd as a LaunchAgent",
      detail:
        // `detached` is also a binary that is only on disk: never claim it runs.
        d.daemon_running === true
          ? "It runs, but not as a LaunchAgent of the logged-in user: it won't come back after a restart, and a daemon started over SSH can't read Claude's login from the Keychain."
          : d.daemon_running === false
            ? "flightdeckd is installed but not running, and no LaunchAgent starts it. Set it up as a LaunchAgent of the logged-in user — Flight Deck can't start it over SSH: a daemon started that way can't read Claude's login from the Keychain, and wouldn't come back after a restart."
            : "flightdeckd is on the Mac, but no LaunchAgent of the logged-in user runs it: it won't come back after a restart, and a daemon started over SSH can't read Claude's login from the Keychain.",
    });
  }
  const several = hasSeveralLaunchAgents(d);
  if (d.installed_as === "launch_agent" && several) {
    steps.push({
      title: "Keep only one LaunchAgent",
      detail: `Several LaunchAgents run flightdeckd: ${d.launch_agent_plists.join(", ")}. Flight Deck can't tell which one launchd keeps running, so it can't restart the daemon or tell whether it survives a reboot. Unload and delete all but one in ~/Library/LaunchAgents, then refresh.`,
    });
  }
  // Every fact below is about THE agent — with several, the step above comes first.
  const oneAgent = d.installed_as === "launch_agent" && !several;
  const plist = d.launch_agent_plists.length === 1 ? ` (${d.launch_agent_plists[0]})` : "";
  if (oneAgent && d.agent_starts_at_login === false) {
    steps.push({
      title: "Start the LaunchAgent at login",
      detail: `Its plist${plist} sets neither RunAtLoad nor KeepAlive to true, so launchd won't start it when the user logs in. Set RunAtLoad to true in it.`,
    });
  }
  if (oneAgent && d.agent_starts_at_login === null) {
    steps.push({
      title: "Make sure the LaunchAgent starts at login",
      detail: `Flight Deck couldn't tell whether launchd starts it when the user logs in — its plist${plist} may only keep it alive under conditions (KeepAlive with NetworkState, PathState…). Setting RunAtLoad to true in it makes sure it does.`,
    });
  }
  if (oneAgent && d.auto_login === false) {
    steps.push({
      title: "Turn on automatic login",
      detail:
        "The LaunchAgent only runs while someone is logged into the Mac. To come back by itself after a restart: System Settings → Users & Groups → Automatically log in as this user (needs FileVault off).",
    });
  }
  if (oneAgent && d.auto_login === null) {
    steps.push({
      title: "Check automatic login",
      detail:
        "Flight Deck couldn't read the Mac's automatic-login setting, so it can't tell whether the daemon comes back after a restart: the LaunchAgent only runs while someone is logged into the Mac. For it to come back by itself: System Settings → Users & Groups → Automatically log in as this user (needs FileVault off).",
    });
  }
  if (d.sleep_masked === false) {
    steps.push({
      title: "Keep the Mac awake",
      detail: "It can go to sleep and drop its connections — a closed laptop lid included.",
      command: "sudo pmset -a sleep 0 disablesleep 1",
    });
  }
  if (d.daemon_outdated) {
    steps.push({
      title: "Update flightdeckd by hand",
      detail: d.bundled_daemon_version
        ? `This app ships flightdeckd ${d.bundled_daemon_version}, but only Linux builds of it — copy a newer macOS build onto the Mac.`
        : "This app only ships Linux builds of flightdeckd — copy a newer macOS build onto the Mac.",
    });
  }
  if (d.claude_installed === true && d.claude_logged_in === false) {
    steps.push({
      title: "Sign in to Claude on the Mac",
      detail:
        "Open Terminal on the Mac itself — not over SSH — run claude, then /login. Claude keeps its login in the Mac's Keychain, which an SSH session can't reach.",
      command: "claude",
    });
  }
  if (d.claude_installed === true && d.claude_logged_in === null) {
    // Over SSH the Keychain can't be read, only checked for Claude's item — when even
    // that failed, the backend says why (`claude_login_check_error`).
    const why = d.claude_login_check_error ? ` — ${d.claude_login_check_error}` : "";
    steps.push({
      title: "Check Claude's sign-in on the Mac",
      detail: `Flight Deck couldn't check whether Claude is signed in on this Mac${why}. If conversations on this server fail, sign in on the Mac itself: open Terminal there — not over SSH — run claude, then /login.`,
      command: "claude",
    });
  }
  return steps;
}

/** (B14) Whether Claude Code itself is missing (or unconfirmed either way) — the
 *  complementary check to {@link claudeNeedsSignIn}, for callers that need to tell
 *  the two apart explicitly rather than just consulting {@link repairSuggestionsFor}. */
export function claudeNeedsInstall(d: ServerDiagnosis): boolean {
  return d.claude_installed !== true;
}

/** Parses a "restart pending — N conversation(s) running" detail (or the "an unknown
 *  number of" fallback — see `fetch_busy_conversations`'s doc) back into the count,
 *  purely for display; `null` when it wasn't confirmable. Never re-derives policy from
 *  it — the backend's own busy check is what actually gates a restart. */
export function restartPendingCount(detail: string | null): number | null {
  if (!detail) return null;
  const m = detail.match(/(\d+) conversation/);
  return m ? Number(m[1]) : null;
}
