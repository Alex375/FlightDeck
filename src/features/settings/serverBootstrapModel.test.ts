import { describe, expect, it } from "vitest";
import type { BootstrapProgressStep, ServerDiagnosis, StepState } from "../../ipc/client";
import {
  claudeNeedsInstall,
  claudeNeedsSignIn,
  claudeSignInStep,
  headlineLabel,
  headlineTone,
  isHostKeyMismatch,
  isNeedsConnectionPasswordError,
  isServerBusyError,
  isSudoPasswordError,
  isTrustedSignInUrl,
  needsSudoPassword,
  repairSuggestionsFor,
  restartPendingCount,
  restartPendingStep,
  STEP_ORDER,
  stepStateFromProgress,
  toStepRows,
  tri,
} from "./serverBootstrapModel";

function step(id: StepState["id"], status: StepState["status"], detail: string | null = null): StepState {
  return { id, status, detail };
}

function baseDiagnosis(over: Partial<ServerDiagnosis> = {}): ServerDiagnosis {
  return {
    state: { kind: "ready" },
    reachable: true,
    link_issue: null,
    tailscale_off_locally: null,
    installed_as: "system",
    daemon_running: true,
    daemon_version_disk: "0.4.2",
    daemon_version_running: "0.4.2",
    restart_pending: false,
    reboot_safe: true,
    linger: null,
    sleep_masked: true,
    user_unit_missing_path: null,
    claude_installed: true,
    claude_logged_in: true,
    claude_email: "demo@example.com",
    tailscale_name: null,
    last_boot: null,
    busy_conversations: 0,
    bundled_daemon_version: "0.4.2",
    daemon_outdated: false,
    ...over,
  };
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
  function unreachableDiagnosis(over: Partial<ServerDiagnosis> = {}): ServerDiagnosis {
    return baseDiagnosis({
      state: { kind: "failed", reason: "could not reach the server" },
      reachable: false,
      installed_as: "unknown",
      daemon_running: null,
      daemon_version_disk: null,
      daemon_version_running: null,
      restart_pending: false,
      reboot_safe: null,
      sleep_masked: null,
      claude_installed: null,
      claude_logged_in: null,
      claude_email: null,
      bundled_daemon_version: null,
      ...over,
    });
  }

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
    const actions = repairSuggestionsFor(baseDiagnosis({ daemon_running: false })).map((s) => s.action);
    expect(actions).toContain("restart_daemon");
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
