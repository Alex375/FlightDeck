import { describe, expect, it } from "vitest";
import type { BootstrapProgressStep, ServerDiagnosis, StepState } from "../../ipc/client";
import {
  claudeNeedsSignIn,
  claudeSignInStep,
  headlineLabel,
  headlineTone,
  isHostKeyMismatch,
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
    installed_as: "system",
    daemon_running: true,
    daemon_version_disk: "0.4.2",
    daemon_version_running: "0.4.2",
    restart_pending: false,
    reboot_safe: true,
    linger: null,
    sleep_masked: true,
    claude_installed: true,
    claude_logged_in: true,
    claude_email: "demo@example.com",
    tailscale_name: null,
    last_boot: null,
    busy_conversations: 0,
    ...over,
  };
}

describe("toStepRows", () => {
  it("returns all 9 steps in the fixed pipeline order, even from a partial/empty report", () => {
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
    expect(headlineTone({ kind: "needs_claude_sign_in" })).toBe("attention");
    expect(headlineLabel({ kind: "needs_claude_sign_in" })).toBe("Needs Claude sign-in");
    expect(headlineTone({ kind: "running_not_reboot_safe" })).toBe("caution");
    expect(headlineLabel({ kind: "running_not_reboot_safe" })).toBe("Running — not reboot-safe");
    expect(headlineTone({ kind: "failed", reason: "could not reach the server" })).toBe("error");
    expect(headlineLabel({ kind: "failed", reason: "could not reach the server" })).toBe("Failed — could not reach the server");
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
    const d = baseDiagnosis({ claude_installed: false, claude_logged_in: null, state: { kind: "needs_claude_sign_in" } });
    expect(repairSuggestionsFor(d).map((s) => s.action)).not.toContain("sign_in_claude");
  });

  it("can suggest several repairs at once for a multiply-broken server", () => {
    const d = baseDiagnosis({ restart_pending: true, reboot_safe: false, installed_as: "user", sleep_masked: false });
    const actions = repairSuggestionsFor(d).map((s) => s.action);
    expect(actions).toEqual(expect.arrayContaining(["restart_daemon", "enable_linger", "mask_sleep"]));
  });
});

describe("claudeNeedsSignIn", () => {
  it("is false only when both installed and logged in are confirmed true", () => {
    expect(claudeNeedsSignIn(baseDiagnosis())).toBe(false);
  });
  it("is true when not installed, not logged in, or either is unknown", () => {
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_installed: false }))).toBe(true);
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_logged_in: false }))).toBe(true);
    expect(claudeNeedsSignIn(baseDiagnosis({ claude_logged_in: null }))).toBe(true);
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
