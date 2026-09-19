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
 *  front's cue to offer "forget the old key and retry" instead of a bare error. */
export function isHostKeyMismatch(detail: string | null): boolean {
  return !!detail && detail.includes("host key does not match what was expected");
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
export function repairSuggestionsFor(d: ServerDiagnosis): RepairSuggestion[] {
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
  if (d.installed_as === "user" && d.user_unit_missing_path === true) {
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
  } else if (d.daemon_running === false && d.installed_as !== "none") {
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
  return d.claude_installed === true && d.claude_logged_in !== true;
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
