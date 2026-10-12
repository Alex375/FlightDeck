import { describe, expect, it } from "vitest";
import type { BootstrapProgressStep, HostKeyCheck, HostKeyTrust, ServerDiagnosis, StepState } from "../../ipc/client";
import {
  hostKeyConsoleCommand,
  hostKeyGoesStraightOn,
  hostKeyServerId,
  claudeNeedsInstall,
  claudeNeedsSignIn,
  claudeSignInStep,
  daemonConfirmedStopped,
  headlineLabel,
  headlineTone,
  isHostKeyMismatch,
  isHostKeyRejected,
  isMacServer,
  isNeedsConnectionPasswordError,
  macManualSteps,
  isServerBusyError,
  isSudoPasswordError,
  isTrustedSignInUrl,
  KEY_ONLY_REPAIRS,
  keyOnlyManualSteps,
  MANUAL_STEP_LEADS,
  manualStepGroups,
  needsSudoPassword,
  installServiceIsPathFix,
  repairNeedsDedicatedKey,
  repairSuggestionsFor,
  restartPendingCount,
  restartPendingStep,
  sshCommandFor,
  STEP_ORDER,
  stepStateFromProgress,
  toStepRows,
  tri,
} from "./serverBootstrapModel";
import { readyDiagnosis, unreachableDiagnosis } from "../../ipc/mock/diagnosisFixtures";

function step(id: StepState["id"], status: StepState["status"], detail: string | null = null): StepState {
  return { id, status, detail };
}

function baseDiagnosis(over: Partial<ServerDiagnosis> = {}): ServerDiagnosis {
  return readyDiagnosis({ tailscale_name: null, last_boot: null, bundled_daemon_version: "0.4.2", ...over });
}

describe("repairSuggestionsFor — outdated daemon", () => {
  it("suggests updating the daemon when the bundled one is newer", () => {
    const out = repairSuggestionsFor(baseDiagnosis({ daemon_outdated: true, bundled_daemon_version: "0.5.0" }));
    const update = out.find((r) => r.action === "reupload_daemon");
    expect(update?.title).toBe("Update the daemon");
    expect(update?.reason).toContain("0.5.0");
  });

  it("does not suggest it when the daemon is current, and never twice when none is installed", () => {
    expect(repairSuggestionsFor(baseDiagnosis()).some((r) => r.action === "reupload_daemon")).toBe(false);
    const none = repairSuggestionsFor(baseDiagnosis({ installed_as: "none", daemon_outdated: true }));
    expect(none.filter((r) => r.action === "reupload_daemon")).toHaveLength(1);
  });
});

describe("toStepRows", () => {
  it("returns all 10 steps in the fixed pipeline order, even from a partial/empty report", () => {
    const rows = toStepRows([]);
    expect(rows.map((r) => r.id)).toEqual(STEP_ORDER);
    expect(rows.every((r) => r.status === "pending" && r.detail === null)).toBe(true);
  });

  it("maps every StepStatus through untouched, keyed by the right step", () => {
    const rows = toStepRows([
      step("install_key", "ok", "Installed"),
      step("probe", "running"),
      step("upload_daemon", "needs_input", "restart pending — 2 conversation(s) running"),
      step("install_service", "failed", "no systemd"),
      step("escalate_persistence", "skipped", "already enabled"),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("install_key")).toMatchObject({ status: "ok", detail: "Installed" });
    expect(byId.get("probe")).toMatchObject({ status: "running", detail: null });
    expect(byId.get("upload_daemon")).toMatchObject({ status: "needs_input" });
    expect(byId.get("install_service")).toMatchObject({ status: "failed", detail: "no systemd" });
    expect(byId.get("escalate_persistence")).toMatchObject({ status: "skipped", detail: "already enabled" });
    // Steps the report never reached stay pending, not silently dropped.
    expect(byId.get("run_init")).toMatchObject({ status: "pending", detail: null });
    expect(byId.get("diagnose")).toMatchObject({ status: "pending", detail: null });
  });

  it("gives every row a non-empty human label", () => {
    for (const row of toStepRows([])) expect(row.label.length).toBeGreaterThan(0);
  });
});

describe("stepStateFromProgress", () => {
  it("narrows the wire's loosely-typed progress steps into checked StepState", () => {
    const wire: BootstrapProgressStep[] = [{ id: "probe", status: "ok", detail: "arch=x86_64" }];
    const states = stepStateFromProgress(wire);
    expect(states).toEqual([{ id: "probe", status: "ok", detail: "arch=x86_64" }]);
  });
});

describe("needsSudoPassword", () => {
  it("is true only when needs_input names escalate_persistence — the ONE blocking step", () => {
    expect(needsSudoPassword({ needs_input: "escalate_persistence" })).toBe(true);
  });
  it("is false for every other step id, and for null", () => {
    expect(needsSudoPassword({ needs_input: "upload_daemon" })).toBe(false);
    expect(needsSudoPassword({ needs_input: "claude_auth" })).toBe(false);
    expect(needsSudoPassword({ needs_input: null })).toBe(false);
  });
});

describe("restartPendingStep", () => {
  it("finds the non-blocking restart-pending pause on upload_daemon", () => {
    const steps = [step("install_key", "ok"), step("upload_daemon", "needs_input", "restart pending — 3 conversation(s) running")];
    expect(restartPendingStep(steps)?.detail).toContain("restart pending");
  });
  it("is null when upload_daemon succeeded, or hasn't run yet", () => {
    expect(restartPendingStep([step("upload_daemon", "ok")])).toBeNull();
    expect(restartPendingStep([])).toBeNull();
  });
});

describe("claudeSignInStep", () => {
  it("finds the non-blocking needs-Claude-sign-in pause on claude_auth", () => {
    const steps = [step("claude_auth", "needs_input", "Needs Claude sign-in")];
    expect(claudeSignInStep(steps)?.detail).toBe("Needs Claude sign-in");
  });
  it("is null once Claude is confirmed signed in", () => {
    expect(claudeSignInStep([step("claude_auth", "ok", "demo@example.com")])).toBeNull();
  });
});

describe("isHostKeyMismatch", () => {
  it("recognizes BootstrapError::HostKeyMismatch's exact Display text", () => {
    expect(isHostKeyMismatch("the server's host key does not match what was expected")).toBe(true);
  });
  it("rejects an unrelated failure and null", () => {
    expect(isHostKeyMismatch("wrong password")).toBe(false);
    expect(isHostKeyMismatch(null)).toBe(false);
  });
});

describe("isSudoPasswordError", () => {
  it("recognizes BootstrapError::NeedsSudoPassword's exact Display text", () => {
    expect(isSudoPasswordError("this server needs a sudo password to continue")).toBe(true);
  });
  it("rejects an unrelated error and null", () => {
    expect(isSudoPasswordError("could not reach the server")).toBe(false);
    expect(isSudoPasswordError(null)).toBe(false);
  });
});

// CRM `c9bf1482`: wording-contract test with the Rust `BootstrapError::
// NeedsConnectionPassword` — keep the two in sync (mirrors `isSudoPasswordError`'s
// own discipline above).
describe("isNeedsConnectionPasswordError", () => {
  it("recognizes BootstrapError::NeedsConnectionPassword's exact Display text", () => {
    expect(isNeedsConnectionPasswordError("this server needs its login password to reconnect")).toBe(true);
  });
  it("never matches isSudoPasswordError's wording, and vice versa", () => {
    expect(isNeedsConnectionPasswordError("this server needs a sudo password to continue")).toBe(false);
    expect(isSudoPasswordError("this server needs its login password to reconnect")).toBe(false);
  });
  it("rejects an unrelated error and null", () => {
    expect(isNeedsConnectionPasswordError("could not reach the server")).toBe(false);
    expect(isNeedsConnectionPasswordError(null)).toBe(false);
  });
});

// B_lifecycle-#7: wording-contract test with the Rust `server_busy_error` in
// orchestrator.rs — keep the two in sync (see that function's own doc).
describe("isServerBusyError", () => {
  it("recognizes the Rust side's server_busy_error wording, naming the running op", () => {
    expect(
      isServerBusyError(
        'Another operation ("Add a server") is already running on this server. Wait for it to finish, then try again.',
      ),
    ).toBe(true);
    expect(
      isServerBusyError(
        'Another operation ("Re-upload the flightdeckd binary") is already running on this server. Wait for it to finish, then try again.',
      ),
    ).toBe(true);
  });
  it("rejects an unrelated error and null", () => {
    expect(isServerBusyError("could not reach the server")).toBe(false);
    expect(isServerBusyError("this server needs a sudo password to continue")).toBe(false);
    expect(isServerBusyError(null)).toBe(false);
  });
});

describe("isTrustedSignInUrl", () => {
  it("accepts https URLs on Claude's own sign-in domains, including subdomains", () => {
    expect(isTrustedSignInUrl("https://claude.ai/oauth/authorize?x=1")).toBe(true);
    expect(isTrustedSignInUrl("https://console.anthropic.com/login")).toBe(true);
    expect(isTrustedSignInUrl("https://claude.com/")).toBe(true);
  });
  it("rejects a non-https scheme even on a trusted host", () => {
    expect(isTrustedSignInUrl("http://claude.ai/oauth")).toBe(false);
  });
  it("rejects a look-alike or unrelated host", () => {
    expect(isTrustedSignInUrl("https://claude.ai.evil.example.com/")).toBe(false);
    expect(isTrustedSignInUrl("https://notclaude.ai/")).toBe(false);
    expect(isTrustedSignInUrl("https://example.com/")).toBe(false);
  });
  it("rejects an unparsable string instead of throwing", () => {
    expect(isTrustedSignInUrl("not a url")).toBe(false);
    expect(isTrustedSignInUrl("")).toBe(false);
  });
});

describe("tri", () => {
  it("renders true/false/null|undefined as three distinct, never-folded outcomes", () => {
    expect(tri(true)).toBe("yes");
    expect(tri(false)).toBe("no");
    expect(tri(null)).toBe("unknown");
    expect(tri(undefined)).toBe("unknown");
  });
});

describe("headlineTone / headlineLabel", () => {
  it("maps every DiagnosisState kind to its own tone and a readable label", () => {
    expect(headlineTone({ kind: "ready" })).toBe("ready");
    expect(headlineLabel({ kind: "ready" })).toBe("Ready");
    // (B14) Distinct from needs_claude_sign_in — see collapse_state's own doc.
    expect(headlineTone({ kind: "needs_claude_install" })).toBe("attention");
    // (B14 fix round 3) Worded to also be accurate for a PRESENT but broken binary —
    // see `headlineLabel`'s own doc.
    expect(headlineLabel({ kind: "needs_claude_install" })).toBe("Claude Code isn't working on this server");
    expect(headlineTone({ kind: "needs_claude_sign_in" })).toBe("attention");
    expect(headlineLabel({ kind: "needs_claude_sign_in" })).toBe("Needs Claude sign-in");
    expect(headlineTone({ kind: "running_not_reboot_safe" })).toBe("caution");
    expect(headlineLabel({ kind: "running_not_reboot_safe" })).toBe("Running — not reboot-safe");
    expect(headlineTone({ kind: "failed", reason: "could not reach the server" })).toBe("error");
    expect(headlineLabel({ kind: "failed", reason: "could not reach the server" })).toBe("Failed — could not reach the server");
  });
});

describe("STEP_ORDER (B14)", () => {
  it("inserts install_claude right after probe, before upload_daemon", () => {
    const probeIdx = STEP_ORDER.indexOf("probe");
    const installClaudeIdx = STEP_ORDER.indexOf("install_claude");
    const uploadIdx = STEP_ORDER.indexOf("upload_daemon");
    expect(installClaudeIdx).toBe(probeIdx + 1);
    expect(uploadIdx).toBe(installClaudeIdx + 1);
  });
});

// CRM `c9bf1482`: an UNREACHABLE diagnosis carries every OTHER tri-state fact as
// `null` ("unknown") — before this gate, that null fell through to the body below and
// misread `claude_installed !== true` as "not installed", offering a bogus "Install
// Claude Code" for a server that was simply out of reach (the real incident).
describe("repairSuggestionsFor — unreachable (early gate)", () => {
  it("offers ONLY Reconnect this Mac when the server refused this Mac's key", () => {
    expect(repairSuggestionsFor(unreachableDiagnosis({ link_issue: "key_refused" }))).toEqual([
      { action: "reconnect_mac", title: "Reconnect this Mac", reason: "this server refused this Mac's saved key" },
    ]);
  });

  it("offers nothing for a changed host identity — informational only, no repair button", () => {
    expect(repairSuggestionsFor(unreachableDiagnosis({ link_issue: "host_key_changed" }))).toEqual([]);
  });

  it("offers nothing for a plain unreachable — never 'Install Claude Code' (the real incident's bogus suggestion)", () => {
    expect(repairSuggestionsFor(unreachableDiagnosis({ link_issue: "unreachable" }))).toEqual([]);
  });

  it("never falls through to the reachable-only body below, even with stale-looking tri-state fields", () => {
    // A defensive case: even if some field looked like "false" rather than "null",
    // the early `!d.reachable` return must still win — nothing below it runs.
    const actions = repairSuggestionsFor(
      unreachableDiagnosis({ link_issue: "unreachable", sleep_masked: false, restart_pending: true }),
    ).map((s) => s.action);
    expect(actions).toEqual([]);
  });

  it("a REACHABLE diagnosis is unaffected by the gate (regression guard)", () => {
    expect(repairSuggestionsFor(baseDiagnosis())).toEqual([]);
    expect(repairSuggestionsFor(baseDiagnosis({ sleep_masked: false })).map((s) => s.action)).toContain("mask_sleep");
  });
});

describe("repairSuggestionsFor", () => {
  it("suggests nothing for a fully healthy diagnosis", () => {
    expect(repairSuggestionsFor(baseDiagnosis())).toEqual([]);
  });

  it("suggests restart when a newer version is uploaded but not running (restart_pending)", () => {
    const actions = repairSuggestionsFor(baseDiagnosis({ restart_pending: true })).map((s) => s.action);
    expect(actions).toContain("restart_daemon");
  });

  it("suggests restart when the daemon simply isn't running (and IS installed)", () => {
    const actions = repairSuggestionsFor(baseDiagnosis({ daemon_running: false, daemon_process_seen: false })).map(
      (s) => s.action,
    );
    expect(actions).toContain("restart_daemon");
  });

  // Regression: a status this SSH login can't read may belong to a live daemon (another
  // user's, or one whose socket or binary is gone) — restarting it would kill its
  // conversations, and the backend refuses. Never offered unless confirmed stopped.
  it("never suggests restart for a daemon seen running, or a stop the process list couldn't confirm", () => {
    for (const daemon_process_seen of [true, null]) {
      for (const daemon_running of [false, null]) {
        const d = baseDiagnosis({ daemon_running, daemon_process_seen });
        expect(daemonConfirmedStopped(d)).toBe(false);
        expect(repairSuggestionsFor(d).map((s) => s.action)).not.toContain("restart_daemon");
        expect(repairSuggestionsFor(macDiagnosis({ daemon_running, daemon_process_seen })).map((s) => s.action)).not.toContain(
          "restart_daemon",
        );
      }
    }
  });

  it("never suggests restart from an unknown (null) daemon_running — no confirmed problem", () => {
    const actions = repairSuggestionsFor(baseDiagnosis({ daemon_running: null })).map((s) => s.action);
    expect(actions).not.toContain("restart_daemon");
  });

  it("suggests enable_linger (not install_service) for a user-level install that isn't reboot-safe", () => {
    const actions = repairSuggestionsFor(baseDiagnosis({ installed_as: "user", reboot_safe: false })).map((s) => s.action);
    expect(actions).toEqual(["enable_linger"]);
  });

  it("suggests install_service for a system/detached install that isn't reboot-safe", () => {
    expect(repairSuggestionsFor(baseDiagnosis({ installed_as: "system", reboot_safe: false })).map((s) => s.action)).toEqual([
      "install_service",
    ]);
    expect(repairSuggestionsFor(baseDiagnosis({ installed_as: "detached", reboot_safe: false })).map((s) => s.action)).toEqual([
      "install_service",
    ]);
  });

  it("suggests reupload_daemon when nothing is installed at all", () => {
    const actions = repairSuggestionsFor(baseDiagnosis({ installed_as: "none", daemon_running: false })).map((s) => s.action);
    expect(actions).toContain("reupload_daemon");
  });

  it("suggests mask_sleep when sleep isn't masked", () => {
    const actions = repairSuggestionsFor(baseDiagnosis({ sleep_masked: false })).map((s) => s.action);
    expect(actions).toEqual(["mask_sleep"]);
  });

  it("never suggests sign_in_claude — that flow is driven directly, not through machine_repair (see the doc)", () => {
    const d = baseDiagnosis({ claude_installed: false, claude_logged_in: null, state: { kind: "needs_claude_install" } });
    expect(repairSuggestionsFor(d).map((s) => s.action)).not.toContain("sign_in_claude");
  });

  it("can suggest several repairs at once for a multiply-broken server", () => {
    const d = baseDiagnosis({ restart_pending: true, reboot_safe: false, installed_as: "user", sleep_masked: false });
    const actions = repairSuggestionsFor(d).map((s) => s.action);
    expect(actions).toEqual(expect.arrayContaining(["restart_daemon", "enable_linger", "mask_sleep"]));
  });

  // ---- install_claude (B14) ----

  it("suggests install_claude whenever claude isn't confirmed installed, ahead of every other repair", () => {
    expect(repairSuggestionsFor(baseDiagnosis({ claude_installed: false })).map((s) => s.action)).toEqual(["install_claude"]);
    expect(repairSuggestionsFor(baseDiagnosis({ claude_installed: null })).map((s) => s.action)).toEqual(["install_claude"]);
  });

  it("never suggests install_claude once it's confirmed installed", () => {
    expect(repairSuggestionsFor(baseDiagnosis({ claude_installed: true })).map((s) => s.action)).not.toContain("install_claude");
  });

  it("suggests fixing the background service's PATH for a user install whose unit predates the PATH fix", () => {
    const d = baseDiagnosis({ installed_as: "user", user_unit_missing_path: true });
    const suggestion = repairSuggestionsFor(d).find((s) => s.action === "install_service");
    expect(suggestion?.title).toBe("Fix the background service's PATH");
  });

  it("never suggests the PATH fix for a system/detached install, or a user install whose unit already has it", () => {
    expect(
      repairSuggestionsFor(baseDiagnosis({ installed_as: "system", user_unit_missing_path: true })).map((s) => s.action),
    ).not.toContain("install_service");
    expect(
      repairSuggestionsFor(baseDiagnosis({ installed_as: "user", user_unit_missing_path: false })).map((s) => s.action),
    ).not.toContain("install_service");
  });
});

describe("claudeNeedsSignIn / claudeNeedsInstall", () => {
  it("claudeNeedsSignIn is false unless claude is CONFIRMED installed", () => {
    expect(claudeNeedsSignIn(baseDiagnosis())).toBe(false);
    // (B14) A missing claude is `claudeNeedsInstall`'s job, never the sign-in flow's.
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_installed: false, claude_logged_in: null }))).toBe(false);
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_installed: null }))).toBe(false);
  });
  it("claudeNeedsSignIn is true once installed but not (confirmed) logged in", () => {
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_installed: true, claude_logged_in: false }))).toBe(true);
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_installed: true, claude_logged_in: null }))).toBe(true);
  });
  it("claudeNeedsInstall is true unless claude is CONFIRMED installed", () => {
    expect(claudeNeedsInstall(baseDiagnosis())).toBe(false);
    expect(claudeNeedsInstall(baseDiagnosis({ claude_installed: false }))).toBe(true);
    expect(claudeNeedsInstall(baseDiagnosis({ claude_installed: null }))).toBe(true);
  });
});

describe("restartPendingCount", () => {
  it("parses the confirmed conversation count out of the detail text", () => {
    expect(restartPendingCount("restart pending — 3 conversation(s) running")).toBe(3);
    expect(restartPendingCount("restart pending — 0 conversation(s) running")).toBe(0);
  });
  it("returns null for the unconfirmed-count wording and for no detail at all", () => {
    expect(restartPendingCount("restart pending — could not restart automatically: some error")).toBeNull();
    expect(restartPendingCount(null)).toBeNull();
  });
});

// ---- A Mac server (hand-made LaunchAgent, "Connect an existing server") ----

function macDiagnosis(over: Partial<ServerDiagnosis> = {}): ServerDiagnosis {
  return baseDiagnosis({
    host_os: "Darwin",
    installed_as: "launch_agent",
    reboot_safe: true,
    auto_login: true,
    agent_starts_at_login: true,
    claude_email: null,
    ...over,
  });
}

describe("a Mac server", () => {
  it("is told apart by its uname only", () => {
    expect(isMacServer(macDiagnosis())).toBe(true);
    expect(isMacServer(baseDiagnosis())).toBe(false);
    expect(isMacServer(baseDiagnosis({ host_os: "Linux" }))).toBe(false);
  });

  it("never gets a systemd repair, whatever its facts say", () => {
    const worst = macDiagnosis({
      reboot_safe: false,
      auto_login: false,
      sleep_masked: false,
      daemon_outdated: true,
      user_unit_missing_path: true,
      state: { kind: "running_not_reboot_safe" },
    });
    const actions = repairSuggestionsFor(worst).map((s) => s.action);
    for (const banned of ["install_service", "enable_linger", "mask_sleep", "reupload_daemon"] as const) {
      expect(actions).not.toContain(banned);
    }
  });

  it("still gets the two repairs that work on a Mac: install Claude, restart the LaunchAgent", () => {
    expect(repairSuggestionsFor(macDiagnosis({ claude_installed: false })).map((s) => s.action)).toEqual(["install_claude"]);
    expect(
      repairSuggestionsFor(macDiagnosis({ daemon_running: false, daemon_process_seen: false })).map((s) => s.action),
    ).toEqual(["restart_daemon"]);
    expect(repairSuggestionsFor(macDiagnosis({ restart_pending: true })).map((s) => s.action)).toEqual(["restart_daemon"]);
    // A daemon started by hand can't be restarted from SSH on a Mac (Keychain).
    expect(repairSuggestionsFor(macDiagnosis({ installed_as: "detached", daemon_running: false }))).toEqual([]);
  });

  it("lists one manual step per CONFIRMED problem — none for a healthy Mac", () => {
    expect(macManualSteps(macDiagnosis())).toEqual([]);
    const titles = macManualSteps(
      macDiagnosis({ auto_login: false, sleep_masked: false, claude_logged_in: false, reboot_safe: false }),
    ).map((s) => s.title);
    expect(titles).toEqual(["Turn on automatic login", "Keep the Mac awake", "Sign in to Claude on the Mac"]);
    // An unknown sleep setting is not a step — but a check the headline depends on that
    // could not be read is explained, never left as a bare amber/blue headline.
    expect(
      macManualSteps(macDiagnosis({ auto_login: null, sleep_masked: null, claude_logged_in: null })).map((s) => s.title),
    ).toEqual(["Check automatic login", "Check Claude's sign-in on the Mac"]);
  });

  it("explains a sign-in it couldn't check, with the Keychain failure when there is one", () => {
    const [step] = macManualSteps(
      macDiagnosis({
        claude_logged_in: null,
        claude_login_check_error: "the Keychain lookup failed (security exit 36)",
      }),
    );
    expect(step.title).toBe("Check Claude's sign-in on the Mac");
    expect(step.detail).toContain("the Keychain lookup failed (security exit 36)");
    expect(step.detail).toContain("sign in on the Mac itself");
    expect(step.command).toBe("claude");
    // Unknown because claude itself isn't confirmed: that is install_claude's job, not a step.
    expect(macManualSteps(macDiagnosis({ claude_installed: null, claude_logged_in: null }))).toEqual([]);
  });

  it("explains an automatic-login setting it couldn't read, and what it means for a restart", () => {
    const [step] = macManualSteps(macDiagnosis({ auto_login: null, reboot_safe: null }));
    expect(step.title).toBe("Check automatic login");
    expect(step.detail).toContain("couldn't read");
    expect(step.detail).toContain("after a restart");
    // Only a LaunchAgent comes back with automatic login.
    expect(macManualSteps(macDiagnosis({ installed_as: "detached", auto_login: null })).map((s) => s.title)).toEqual([
      "Run flightdeckd as a LaunchAgent",
    ]);
  });

  it("several LaunchAgents: one step naming them all, and no per-agent step or restart", () => {
    const plists = [
      "/Users/admin/Library/LaunchAgents/com.example.flightdeckd.plist",
      "/Users/admin/Library/LaunchAgents/flightdeckd.old.plist",
    ];
    const d = macDiagnosis({
      launch_agent_plists: plists,
      agent_starts_at_login: null,
      auto_login: false,
      reboot_safe: null,
      daemon_running: false,
      state: { kind: "failed", reason: "flightdeckd is not running" },
    });
    const steps = macManualSteps(d);
    expect(steps.map((s) => s.title)).toEqual(["Keep only one LaunchAgent"]);
    expect(steps[0].detail).toContain(plists[0]);
    expect(steps[0].detail).toContain(plists[1]);
    // The backend refuses to restart an ambiguous agent: never offered.
    expect(repairSuggestionsFor(d).map((s) => s.action)).not.toContain("restart_daemon");
    // One agent listed is not ambiguous.
    expect(macManualSteps(macDiagnosis({ launch_agent_plists: [plists[0]], auto_login: false })).map((s) => s.title)).toEqual([
      "Turn on automatic login",
    ]);
  });

  it("a LaunchAgent whose start at login is unknown is told how to make sure", () => {
    const [step] = macManualSteps(
      macDiagnosis({ agent_starts_at_login: null, reboot_safe: null, launch_agent_plists: ["/L/fd.plist"] }),
    );
    expect(step.title).toBe("Make sure the LaunchAgent starts at login");
    expect(step.detail).toContain("/L/fd.plist");
    expect(step.detail).toContain("RunAtLoad");
  });

  it("a daemon only on disk is never said to run", () => {
    const running = macManualSteps(macDiagnosis({ installed_as: "detached", daemon_running: true, reboot_safe: false }))[0];
    expect(running.detail).toContain("It runs");
    const stopped = macManualSteps(macDiagnosis({ installed_as: "detached", daemon_running: false, reboot_safe: false }))[0];
    expect(stopped.title).toBe("Run flightdeckd as a LaunchAgent");
    expect(stopped.detail).toContain("installed but not running");
    expect(stopped.detail).not.toContain("It runs");
    const unknown = macManualSteps(macDiagnosis({ installed_as: "detached", daemon_running: null, reboot_safe: false }))[0];
    expect(unknown.detail).not.toContain("It runs");
  });

  it("names the daemon fixes the installer can't do on a Mac", () => {
    expect(macManualSteps(macDiagnosis({ installed_as: "detached", reboot_safe: false })).map((s) => s.title)).toEqual([
      "Run flightdeckd as a LaunchAgent",
    ]);
    expect(macManualSteps(macDiagnosis({ installed_as: "none" })).map((s) => s.title)).toEqual([
      "Install flightdeckd on the Mac",
    ]);
    const atLogin = macManualSteps(macDiagnosis({ agent_starts_at_login: false }));
    expect(atLogin.map((s) => s.title)).toEqual(["Start the LaunchAgent at login"]);
    expect(atLogin[0].detail).toContain("neither RunAtLoad nor KeepAlive to true");
    expect(macManualSteps(macDiagnosis({ daemon_outdated: true, bundled_daemon_version: "0.3.0" }))[0].detail).toContain(
      "0.3.0",
    );
  });

  it("is never offered the SSH sign-in flow — it can't reach the Mac's Keychain", () => {
    expect(claudeNeedsSignIn(macDiagnosis({ claude_logged_in: false }))).toBe(false);
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_logged_in: false }))).toBe(true);
  });

  it("a Linux server's diagnosis gets no manual steps", () => {
    expect(macManualSteps(baseDiagnosis({ sleep_masked: false, reboot_safe: false }))).toEqual([]);
  });
});

describe("repairSuggestionsFor — a server without a Flight Deck key", () => {
  const keyRefused = unreachableDiagnosis({
    link_issue: "key_refused",
    state: { kind: "failed", reason: "this Mac's saved key was refused" },
  });

  it("offers Reconnect only when Flight Deck holds a key to re-push", () => {
    expect(repairSuggestionsFor(keyRefused).map((s) => s.action)).toEqual(["reconnect_mac"]);
    expect(repairSuggestionsFor(keyRefused, { dedicatedKey: false })).toEqual([]);
    // Unreachable: the card's own note explains the refusal, not a key step.
    expect(keyOnlyManualSteps(keyRefused, { dedicatedKey: false })).toEqual([]);
  });

  const needsKey: Array<[string, ServerDiagnosis, string]> = [
    ["an outdated daemon", baseDiagnosis({ daemon_outdated: true, bundled_daemon_version: "0.5.0" }), "Update the daemon"],
    ["no daemon at all", baseDiagnosis({ installed_as: "none", daemon_running: false }), "Re-upload the daemon"],
    ["a detached daemon that won't survive a reboot", baseDiagnosis({ installed_as: "detached", reboot_safe: false }), "Install the persistence service"],
    ["a system install that won't survive a reboot", baseDiagnosis({ installed_as: "system", reboot_safe: false }), "Install the persistence service"],
  ];

  it.each(needsKey)("never offers a repair the backend refuses without the key — %s", (_, d, title) => {
    // With the key, the repair is a button.
    expect(repairSuggestionsFor(d).map((s) => s.title)).toContain(title);
    const actions = repairSuggestionsFor(d, { dedicatedKey: false }).map((s) => s.action);
    for (const keyOnly of KEY_ONLY_REPAIRS) expect(actions).not.toContain(keyOnly);
    // ...and without it, the same fix is a step under the key lead, never dropped.
    expect(keyOnlyManualSteps(d, { dedicatedKey: false }).map((s) => s.title)).toEqual([title]);
    const groups = manualStepGroups(d, { dedicatedKey: false });
    expect(groups.map((g) => g.kind)).toEqual(["key"]);
    expect(groups[0].lead).toContain("A key for Flight Deck");
    expect(groups[0].lead).toContain("Connect an existing server");
  });

  it("keeps the user unit's PATH fix — it runs over plain SSH", () => {
    const d = baseDiagnosis({ installed_as: "user", user_unit_missing_path: true });
    expect(repairNeedsDedicatedKey("install_service", d)).toBe(false);
    expect(repairSuggestionsFor(d, { dedicatedKey: false }).map((s) => s.title)).toEqual(["Fix the background service's PATH"]);
    expect(keyOnlyManualSteps(d, { dedicatedKey: false })).toEqual([]);
  });

  it("keeps every repair that needs no key, in the same order", () => {
    const d = baseDiagnosis({
      installed_as: "user",
      claude_installed: false,
      daemon_outdated: true,
      daemon_running: false,
      daemon_process_seen: false,
      reboot_safe: false,
      sleep_masked: false,
    });
    expect(repairSuggestionsFor(d, { dedicatedKey: false }).map((s) => s.action)).toEqual([
      "install_claude",
      "restart_daemon",
      "enable_linger",
      "mask_sleep",
    ]);
    expect(keyOnlyManualSteps(d, { dedicatedKey: false }).map((s) => s.title)).toEqual(["Update the daemon"]);
  });

  it("a server with Flight Deck's key gets no key step", () => {
    const d = baseDiagnosis({ daemon_outdated: true });
    expect(keyOnlyManualSteps(d)).toEqual([]);
    expect(keyOnlyManualSteps(d, { dedicatedKey: true })).toEqual([]);
    expect(manualStepGroups(d)).toEqual([]);
  });

  it("repairNeedsDedicatedKey is exactly KEY_ONLY_REPAIRS outside the PATH fix", () => {
    const d = baseDiagnosis();
    for (const action of KEY_ONLY_REPAIRS) expect(repairNeedsDedicatedKey(action, d)).toBe(true);
    for (const action of ["restart_daemon", "enable_linger", "mask_sleep", "install_claude", "sign_in_claude"] as const) {
      expect(repairNeedsDedicatedKey(action, d)).toBe(false);
    }
  });

  // One definition of "the PATH fix" for both the key rule and the suggestion it names —
  // the two used to spell the condition out separately.
  it("the PATH fix is one condition: the suggestion it offers is the one that needs no key", () => {
    const pathFix = baseDiagnosis({ installed_as: "user", user_unit_missing_path: true, reboot_safe: false });
    expect(installServiceIsPathFix(pathFix)).toBe(true);
    const offered = repairSuggestionsFor(pathFix).filter((s) => s.action === "install_service");
    expect(offered.map((s) => s.title)).toEqual(["Fix the background service's PATH"]);
    expect(offered.every((s) => !repairNeedsDedicatedKey(s.action, pathFix))).toBe(true);

    for (const d of [
      baseDiagnosis({ installed_as: "user", user_unit_missing_path: false }),
      baseDiagnosis({ installed_as: "user", user_unit_missing_path: null }),
      baseDiagnosis({ installed_as: "system", user_unit_missing_path: true }),
    ]) {
      expect(installServiceIsPathFix(d)).toBe(false);
      expect(repairNeedsDedicatedKey("install_service", d)).toBe(true);
    }
  });
});

describe("macManualSteps — a LaunchAgent plist launchd can't parse", () => {
  const broken = "/Users/admin/Library/LaunchAgents/com.tosse.flightdeckd.plist";

  it("names it, says why it counts for nothing, and how to check it — before the no-LaunchAgent step", () => {
    const steps = macManualSteps(
      macDiagnosis({
        installed_as: "detached",
        daemon_running: true,
        launch_agent_plists: [],
        invalid_launch_agent_plists: [broken],
        agent_starts_at_login: null,
        reboot_safe: false,
      }),
    );
    expect(steps.map((s) => s.title).slice(0, 2)).toEqual(["Fix the LaunchAgent's plist", "Run flightdeckd as a LaunchAgent"]);
    expect(steps[0].detail).toContain(broken);
    expect(steps[0].detail).toContain("can't be parsed: launchd can't load it");
    expect(steps[0].command).toBe(`plutil -lint ${broken}`);
    // Never a false "set RunAtLoad" step off the file's error text.
    expect(steps.some((s) => s.title === "Start the LaunchAgent at login")).toBe(false);
  });

  it("lists several, quoting a path the shell would split", () => {
    const spaced = "/Users/admin/Library/LaunchAgents/my agent.plist";
    const [step] = macManualSteps(macDiagnosis({ invalid_launch_agent_plists: [broken, spaced] }));
    expect(step.title).toBe("Fix the LaunchAgent plists");
    expect(step.detail).toContain("can't load them");
    expect(step.command).toBe(`plutil -lint ${broken} '${spaced}'`);
  });
});

describe("manualStepGroups", () => {
  it("lists a Mac's own steps under the Mac lead", () => {
    const groups = manualStepGroups(macDiagnosis({ sleep_masked: false }), { dedicatedKey: false });
    expect(groups.map((g) => [g.kind, g.lead])).toEqual([["mac", MANUAL_STEP_LEADS.mac]]);
    expect(MANUAL_STEP_LEADS.mac).toContain("On the Mac itself");
  });
});

describe("sshCommandFor", () => {
  it("names the port only when it isn't the default", () => {
    expect(sshCommandFor({ user: "admin", host: "studio", port: 22 })).toBe("ssh admin@studio");
    expect(sshCommandFor({ user: "admin", host: "studio", port: 2222 })).toBe("ssh -p 2222 admin@studio");
  });
});

describe("isHostKeyRejected", () => {
  it("recognizes ssh's own changed-host-key line as add_machine forwards it", () => {
    expect(
      isHostKeyRejected("Could not pair — every address failed. h: Could not connect over SSH: Host key verification failed."),
    ).toBe(true);
    expect(isHostKeyRejected("Could not connect over SSH: Permission denied (publickey).")).toBe(false);
    expect(isHostKeyRejected(null)).toBe(false);
  });
});

describe("hostKeyConsoleCommand", () => {
  it("names the server's own public host key file for the reported type", () => {
    expect(hostKeyConsoleCommand("ED25519")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub");
    expect(hostKeyConsoleCommand("ECDSA")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub");
    expect(hostKeyConsoleCommand("RSA")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub");
  });

  it("never builds a path from anything but a plain type name", () => {
    expect(hostKeyConsoleCommand("ED25519-SK")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub");
    expect(hostKeyConsoleCommand("../../x; rm -rf ~")).toBe("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub");
  });
});

describe("hostKeyGoesStraightOn", () => {
  const check = (trust: HostKeyTrust, fingerprint = "SHA256:presented"): HostKeyCheck => ({
    host: "10.1.2.3",
    port: 2200,
    key_type: "ED25519",
    fingerprint,
    trust,
    saved_fingerprints: trust === "new" ? [] : [fingerprint],
  });

  it("only a paired server's saved key skips the review on its own", () => {
    expect(hostKeyGoesStraightOn(check("known"), undefined)).toBe(true);
    // Saved, but nobody vouches for it (a password-less attempt may have saved it).
    expect(hostKeyGoesStraightOn(check("unverified"), undefined)).toBe(false);
    expect(hostKeyGoesStraightOn(check("new"), undefined)).toBe(false);
    expect(hostKeyGoesStraightOn(check("changed"), undefined)).toBe(false);
  });

  it("a key the user already confirmed here skips it — that exact key only, never a changed one", () => {
    expect(hostKeyGoesStraightOn(check("unverified"), "SHA256:presented")).toBe(true);
    expect(hostKeyGoesStraightOn(check("new"), "SHA256:presented")).toBe(true);
    expect(hostKeyGoesStraightOn(check("unverified"), "SHA256:other")).toBe(false);
    expect(hostKeyGoesStraightOn(check("changed"), "SHA256:presented")).toBe(false);
  });

  it("keys the memory by host and port", () => {
    expect(hostKeyServerId(check("new"))).toBe("10.1.2.3:2200");
    expect(hostKeyServerId({ host: "10.1.2.3", port: 22 })).not.toBe(hostKeyServerId(check("new")));
  });
});
