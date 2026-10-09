// Component behaviour for the B12 wizard: every needs_input state renders its own
// inline panel, a failed/paused/cancelled run never leaves a password sitting in
// state or in any store, and the legacy ticket flow stays reachable and renders.
//
// Built with createElement in a `*.test.ts` file (the vitest glob) + react-dom/client,
// same discipline as DeleteConversationDialog.test.ts / ArtifactViewer.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: { payload: unknown }) => void;

// `vi.mock`'s factory is hoisted above the whole module, so every mock it references
// must be created inside `vi.hoisted` rather than as a plain top-level `const`.
const mocks = vi.hoisted(() => {
  function mockEmitter() {
    const listeners = new Set<Listener>();
    return {
      listen: vi.fn(async (cb: Listener) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
      emit: (payload: unknown) => listeners.forEach((cb) => cb({ payload })),
    };
  }
  return {
    bootstrapProgressEvent: mockEmitter(),
    hostKeyFingerprintEvent: mockEmitter(),
    serverLoginPromptEvent: mockEmitter(),
    serverLoginResultEvent: mockEmitter(),
    bootstrapServer: vi.fn(),
    bootstrapResume: vi.fn(),
    bootstrapCancel: vi.fn(),
    bootstrapForgetHostKey: vi.fn(),
    bootstrapCheckHostKey: vi.fn(),
    machineRepair: vi.fn(),
    machineDiagnose: vi.fn(),
    startClaudeLogin: vi.fn(),
    restartClaudeLogin: vi.fn(),
    submitClaudeLoginCode: vi.fn(),
    cancelClaudeLogin: vi.fn(),
    generateMachineKey: vi.fn(),
    loadPersistedState: vi.fn(),
  };
});
const {
  bootstrapServer,
  bootstrapResume,
  bootstrapCancel,
  bootstrapForgetHostKey,
  bootstrapCheckHostKey,
  machineRepair,
  machineDiagnose,
  startClaudeLogin,
  submitClaudeLoginCode,
  cancelClaudeLogin,
  generateMachineKey,
  loadPersistedState,
} = mocks;

vi.mock("../../ipc/client", () => ({
  commands: {
    bootstrapServer: mocks.bootstrapServer,
    bootstrapResume: mocks.bootstrapResume,
    bootstrapCancel: mocks.bootstrapCancel,
    bootstrapForgetHostKey: mocks.bootstrapForgetHostKey,
    bootstrapCheckHostKey: mocks.bootstrapCheckHostKey,
    machineRepair: mocks.machineRepair,
    machineDiagnose: mocks.machineDiagnose,
    startClaudeLogin: mocks.startClaudeLogin,
    restartClaudeLogin: mocks.restartClaudeLogin,
    submitClaudeLoginCode: mocks.submitClaudeLoginCode,
    cancelClaudeLogin: mocks.cancelClaudeLogin,
    generateMachineKey: mocks.generateMachineKey,
    loadPersistedState: mocks.loadPersistedState,
  },
  events: {
    bootstrapProgressEvent: mocks.bootstrapProgressEvent,
    hostKeyFingerprintEvent: mocks.hostKeyFingerprintEvent,
    serverLoginPromptEvent: mocks.serverLoginPromptEvent,
    serverLoginResultEvent: mocks.serverLoginResultEvent,
  },
}));

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ServerBootstrapWizard } from "./ServerBootstrapWizard";
import { useSettingsUi } from "../../store/settingsUi";
import sharedStyles from "./SettingsPanel.module.css";
import wStyles from "./ServerBootstrapWizard.module.css";
import { useClaudeLoginSessions } from "./claudeLoginSessions";

let container: HTMLDivElement;
let root: Root;

const STEP_IDS = [
  "install_key",
  "probe",
  "install_claude",
  "upload_daemon",
  "install_service",
  "escalate_persistence",
  "run_init",
  "claude_auth",
  "add_machine",
  "diagnose",
] as const;

function allOk(overrides: Record<string, { status: string; detail?: string | null }> = {}) {
  return STEP_IDS.map((id) => ({ id, status: overrides[id]?.status ?? "ok", detail: overrides[id]?.detail ?? null }));
}

const NEW_FP = "SHA256:newNewNewKeyFingerprint";
const OLD_FP = "SHA256:oldOldOldKeyFingerprint";

/** `bootstrap_check_host_key`'s answer: the key presented is `NEW_FP` unless `fingerprint` says otherwise. */
function hostKeyCheck(trust: "new" | "known" | "unverified" | "changed", host = "1.2.3.4", fingerprint = NEW_FP) {
  return {
    status: "ok",
    data: {
      host,
      port: 22,
      key_type: "ED25519",
      fingerprint,
      trust,
      saved_fingerprints: trust === "new" ? [] : trust === "changed" ? [OLD_FP] : [fingerprint],
    },
  };
}

function mount() {
  act(() => {
    root.render(createElement(ServerBootstrapWizard, { onClose: () => {} }));
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// React overrides `HTMLInputElement.prototype.value`'s setter with its own tracked
// one — a plain `input.value = x` is invisible to it, so a controlled input's
// onChange never fires and the component's state never updates. Going through the
// NATIVE setter (same trick React Testing Library's `fireEvent` uses internally) is
// what actually gets picked up.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function setValue(input: HTMLInputElement, value: string) {
  act(() => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function fill(name: string, value: string) {
  const input = container.querySelector(`input[placeholder*="${name}"]`) as HTMLInputElement | null;
  if (!input) throw new Error(`no input matching placeholder "${name}"`);
  setValue(input, value);
}

function clickButtonWithText(text: string) {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`no button with text "${text}" — saw: ${Array.from(container.querySelectorAll("button")).map((b) => b.textContent)}`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function passwordInput(): HTMLInputElement | null {
  return container.querySelector('input[type="password"]');
}

/** The innermost `<div>` containing `text` — every ancestor of the real element also
 *  matches a plain `textContent.includes` check (it's a substring of theirs too), and
 *  `querySelectorAll` returns them in document (pre-)order, ancestors before
 *  descendants, so the LAST match is the actual, most specific element. */
function mostSpecificDivWithText(text: string): HTMLElement | undefined {
  const matches = Array.from(container.querySelectorAll("div")).filter((d) => d.textContent?.includes(text));
  return matches[matches.length - 1];
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  bootstrapServer.mockReset();
  bootstrapResume.mockReset();
  bootstrapCancel.mockReset();
  // Default to a plain success — a real IPC binding always resolves to SOMETHING
  // (`Promise<Result<null, string>>`), and the new unmount-while-paused cleanup below
  // now calls this unconditionally whenever a test happens to end paused, so a bare
  // unconfigured mock (which returns `undefined`, not a `Promise`) would crash on the
  // `.catch` call rather than exercising the real "did it get called" assertions.
  // Individual tests still override this per-case where the resolution itself matters.
  bootstrapCancel.mockResolvedValue({ status: "ok", data: null });
  bootstrapForgetHostKey.mockReset();
  bootstrapCheckHostKey.mockReset();
  // A server whose key this Mac already saved, unless a test says otherwise.
  bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("known"));
  machineRepair.mockReset();
  machineDiagnose.mockReset();
  startClaudeLogin.mockReset();
  submitClaudeLoginCode.mockReset();
  cancelClaudeLogin.mockReset();
  generateMachineKey.mockReset();
  loadPersistedState.mockReset();
  loadPersistedState.mockResolvedValue({ status: "ok", data: { machines: [], repos: [], conversations: [], active_id: null } });
  useSettingsUi.setState({ bootstrapGuard: null });
  useClaudeLoginSessions.setState({ active: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ServerBootstrapWizard — form", () => {
  // (B14) The step checklist is entirely data-driven off `STEP_ORDER`/`STEP_LABELS`
  // (serverBootstrapModel.ts) — this is what makes the newly-added InstallClaude step
  // show up here with zero JSX changes, mentioning the install up front so it's not a
  // surprise (see the B14 brief's own "no new setting" requirement).
  it("the step checklist mentions Install Claude Code, right after Check the server", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: { session_id: "s1", host: "1.2.3.4", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: null },
    });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    clickButtonWithText("Install");
    await settle();
    // No password typed: nothing to gate, so no host-key round trip either.
    expect(bootstrapCheckHostKey).not.toHaveBeenCalled();

    const labels = Array.from(container.getElementsByClassName(wStyles.stepLabel)).map((el) => el.textContent);
    expect(labels).toContain("Install Claude Code");
    const checkIdx = labels.indexOf("Check the server");
    const installClaudeIdx = labels.indexOf("Install Claude Code");
    expect(checkIdx).toBeGreaterThanOrEqual(0);
    expect(installClaudeIdx).toBe(checkIdx + 1);
  });

  it("submits the typed password to bootstrap_server, then clears it from state", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "s1",
        host: "1.2.3.4",
        steps: allOk({ install_key: { status: "failed", detail: "wrong password" } }),
        needs_input: null,
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    expect(passwordInput()?.value).toBe("hunter2");
    clickButtonWithText("Install");
    await settle();

    // The key was already saved: the password goes out bound to that very key.
    expect(bootstrapCheckHostKey).toHaveBeenCalledWith("1.2.3.4", 22, "root");
    expect(bootstrapServer).toHaveBeenCalledWith("1.2.3.4", "1.2.3.4", 22, "root", "hunter2", true, null, NEW_FP);
    // The run failed — "Retry" returns to the form, and the password field it shows
    // is EMPTY (cleared the instant it was handed to the IPC call, not lingering
    // because the attempt failed).
    clickButtonWithText("Retry");
    await settle();
    expect(passwordInput()?.value).toBe("");
    // Never touched localStorage at any point in this flow.
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it("defaults the keep-awake toggle ON (opt-out)", () => {
    mount();
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  // CRM holistic-review blocker #3 (chantier A bd7ca709): an ssh-option-shaped user
  // (or host) must never reach `bootstrap_server` — the "Install" button must refuse
  // to submit it, with an inline reason shown, mirroring the Rust
  // `validate_ssh_user`/`validate_address_value` rule (`sshValidation.ts`).
  it("refuses an ssh-option-shaped user: Install stays disabled, shows an inline reason, never calls bootstrap_server", async () => {
    mount();
    fill("Address", "example.com");
    fill("User", "-oProxyCommand=touch /tmp/pwned");
    await settle();

    const installBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Install",
    ) as HTMLButtonElement;
    expect(installBtn.disabled).toBe(true);
    expect(container.textContent).toMatch(/User name cannot start with/);
    expect(bootstrapServer).not.toHaveBeenCalled();
  });

  it("refuses an ssh-option-shaped address the same way", async () => {
    mount();
    fill("Address", "-oProxyCommand=touch /tmp/pwned");
    fill("User", "deploy");
    await settle();

    const installBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Install",
    ) as HTMLButtonElement;
    expect(installBtn.disabled).toBe(true);
    expect(container.textContent).toMatch(/Address cannot start with/);
    expect(bootstrapServer).not.toHaveBeenCalled();
  });

  // Review finding: `isServerBusyError` was defined and unit-tested in
  // `serverBootstrapModel.ts` but never actually called from either UI component, so
  // a `ServerLocks` collision (another bootstrap/repair already running against the
  // same server) only ever rendered as a raw, indistinguishable red error.
  it("gives a server_busy_error collision a distinct, non-error treatment", async () => {
    bootstrapServer.mockResolvedValue({
      status: "error",
      error: 'Another operation ("Repair: restart") is already running on this server. Wait for it to finish, then try again.',
    });
    mount();
    fill("Address", "busy.example.com");
    fill("User", "root");
    clickButtonWithText("Install");
    await settle();

    const busyBox = mostSpecificDivWithText("is already running on this server");
    expect(busyBox).toBeTruthy();
    expect(busyBox?.className).toBe(sharedStyles.hintWarn);
    expect(busyBox?.className).not.toBe(sharedStyles.errorMsg);
  });

  it("still gives an ordinary bootstrap failure the normal error treatment", async () => {
    bootstrapServer.mockResolvedValue({ status: "error", error: "Could not connect: connection refused" });
    mount();
    fill("Address", "unreachable.example.com");
    fill("User", "root");
    clickButtonWithText("Install");
    await settle();

    const errorBox = mostSpecificDivWithText("connection refused");
    expect(errorBox).toBeTruthy();
    expect(errorBox?.className).toBe(sharedStyles.errorMsg);
  });
});

describe("ServerBootstrapWizard — needs_input states", () => {
  it("sudo password: blocks with a labelled password field, Resume calls bootstrap_resume, Cancel calls bootstrap_cancel and clears it", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-sudo",
        host: "sudo.example.com",
        steps: allOk({
          install_service: { status: "ok" },
          escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to finish persistence setup" },
          run_init: { status: "pending" },
          claude_auth: { status: "pending" },
          add_machine: { status: "pending" },
          diagnose: { status: "pending" },
        }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "sudo.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain("needs a sudo password");
    const sudoInput = container.querySelector('input[placeholder="Sudo password"]') as HTMLInputElement;
    expect(sudoInput).not.toBeNull();
    setValue(sudoInput, "rootpw");

    bootstrapResume.mockResolvedValue({
      status: "ok",
      data: { session_id: "sess-sudo", host: "sudo.example.com", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: { state: { kind: "ready" } } },
    });
    clickButtonWithText("Resume");
    await settle();
    expect(bootstrapResume).toHaveBeenCalledWith("sess-sudo", "rootpw");
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it("sudo password: Cancel calls bootstrap_cancel and returns to the empty form", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-sudo-2",
        host: "sudo2.example.com",
        steps: allOk({ escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" } }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "sudo2.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    const sudoInput = container.querySelector('input[placeholder="Sudo password"]') as HTMLInputElement;
    setValue(sudoInput, "typed-but-not-submitted");
    clickButtonWithText("Cancel");
    await settle();

    expect(bootstrapCancel).toHaveBeenCalledWith("sess-sudo-2");
    // Back at the form — its own address field is empty again, proving the whole
    // run (and whatever password was in flight) was abandoned, not resumed silently.
    expect(container.querySelector('input[placeholder*="Address"]')).not.toBeNull();
    expect(passwordInput()?.value).toBe("");
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it("restart pending: shows the confirmed count and offers Restart now / Later", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-restart",
        host: "restart.example.com",
        steps: allOk({ upload_daemon: { status: "needs_input", detail: "restart pending — 2 conversation(s) running" } }),
        needs_input: null,
        machine_id: "m-restart",
        diagnosis: { state: { kind: "ready" } },
      },
    });
    mount();
    fill("Address", "restart.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain("Restart pending");
    expect(container.textContent).toContain("2 conversation(s) running");
    expect(container.querySelector("button")).not.toBeNull();

    clickButtonWithText("Later");
    await settle();
    expect(container.textContent).not.toContain("Restart pending");
  });

  it("Claude sign-in: offers the inline start-sign-in action", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-claude",
        host: "claude.example.com",
        steps: allOk({ claude_auth: { status: "needs_input", detail: "Needs Claude sign-in" } }),
        needs_input: null,
        machine_id: "m-claude",
        diagnosis: { state: { kind: "needs_claude_sign_in" } },
      },
    });
    mount();
    fill("Address", "claude.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain("isn't signed in to Claude Code yet");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Start Claude sign-in")).toBe(true);
  });

  // B-finding #2: `onSignedIn` used to be a no-op shallow array copy — the
  // `claude_auth` step's own `status` never actually flipped off `needs_input`, so
  // this panel kept showing "isn't signed in to Claude Code yet" forever, directly
  // above `ClaudeSignInInline`'s own "Signed in as …" success line, even after a
  // confirmed sign-in.
  it("Claude sign-in: a confirmed inline sign-in flips the stale 'isn't signed in' panel to the success state", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-claude-ok",
        host: "claude-ok.example.com",
        steps: allOk({ claude_auth: { status: "needs_input", detail: "Needs Claude sign-in" } }),
        needs_input: null,
        machine_id: "m-claude-ok",
        diagnosis: { state: { kind: "needs_claude_sign_in" } },
      },
    });
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "login-1", machine_id: "m-claude-ok", owned: true } });

    mount();
    fill("Address", "claude-ok.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();
    expect(container.textContent).toContain("isn't signed in to Claude Code yet");

    clickButtonWithText("Start Claude sign-in");
    await settle();

    // The confirmed result — exactly what a real successful sign-in emits.
    act(() =>
      mocks.serverLoginResultEvent.emit({ session_id: "login-1", machine_id: "m-claude-ok", ok: true, email: "armand@example.com", error: null }),
    );
    await settle();

    // The whole stale panel (header + `ClaudeSignInInline`) is gone — `claudeStep`
    // stops matching once `claude_auth`'s status is no longer `needs_input` — and the
    // checklist row itself now shows the confirmed email as its `ok` detail.
    expect(container.textContent).not.toContain("isn't signed in to Claude Code yet");
    expect(container.textContent).not.toContain("Signed in as");
    expect(container.textContent).toContain("armand@example.com");
  });

  it("host key mismatch: offers to forget the old key and retry, then re-submits", async () => {
    bootstrapServer.mockResolvedValueOnce({
      status: "ok",
      data: {
        session_id: "sess-hostkey",
        host: "hostkey.example.com",
        steps: allOk({
          install_key: { status: "failed", detail: "the server's host key does not match what was expected" },
          probe: { status: "pending" },
          upload_daemon: { status: "pending" },
          install_service: { status: "pending" },
          escalate_persistence: { status: "pending" },
          run_init: { status: "pending" },
          claude_auth: { status: "pending" },
          add_machine: { status: "pending" },
          diagnose: { status: "pending" },
        }),
        needs_input: null,
        machine_id: null,
        diagnosis: null,
      },
    });
    bootstrapForgetHostKey.mockResolvedValue({ status: "ok", data: null });
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("changed", "hostkey.example.com"));
    bootstrapServer.mockResolvedValueOnce({
      status: "ok",
      data: { session_id: "sess-hostkey-2", host: "hostkey.example.com", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: { state: { kind: "ready" } } },
    });

    mount();
    fill("Address", "hostkey.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain("host key changed");
    clickButtonWithText("Review the new key");
    await settle();
    // I6: the saved key and the presented one side by side — nothing replaced yet.
    expect(bootstrapCheckHostKey).toHaveBeenCalledWith("hostkey.example.com", 22, "deploy");
    expect(container.textContent).toContain(`Saved on this Mac: ${OLD_FP}`);
    expect(container.textContent).toContain(`Presented now: ED25519 ${NEW_FP}`);
    expect(bootstrapForgetHostKey).not.toHaveBeenCalled();
    clickButtonWithText("Trust the new key and retry");
    await settle();
    expect(bootstrapForgetHostKey).toHaveBeenCalledWith("hostkey.example.com", 22, "deploy", NEW_FP);
    expect(bootstrapServer).toHaveBeenCalledTimes(2);
    expect(bootstrapServer).toHaveBeenLastCalledWith("hostkey.example.com", "hostkey.example.com", 22, "deploy", null, true, null, NEW_FP);
  });

  it("host key mismatch: keeping the old key replaces nothing and retries nothing", async () => {
    bootstrapServer.mockResolvedValueOnce({
      status: "ok",
      data: {
        session_id: "sess-hostkey-keep",
        host: "hostkey.example.com",
        steps: allOk({ install_key: { status: "failed", detail: "the server's host key does not match what was expected" } }),
        needs_input: null,
        machine_id: null,
        diagnosis: null,
      },
    });
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("changed", "hostkey.example.com"));
    mount();
    fill("Address", "hostkey.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();
    clickButtonWithText("Review the new key");
    await settle();
    clickButtonWithText("Keep the old key");
    await settle();

    expect(bootstrapForgetHostKey).not.toHaveBeenCalled();
    expect(bootstrapServer).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain(NEW_FP);
  });

  // Regression for a shipped bug: filling the form top-to-bottom (the normal order —
  // Address, then User, then Password) and hitting a host-key mismatch used to retry
  // with an EMPTY user/password (a stale closure captured before those fields were
  // typed, on top of `password` itself already being cleared from state the instant
  // the first attempt submitted). See the module doc's "Forget the old key and retry"
  // note.
  it("host key mismatch: retries with the password actually typed, not stale or empty", async () => {
    bootstrapServer.mockResolvedValueOnce({
      status: "ok",
      data: {
        session_id: "sess-hostkey-pw",
        host: "hostkey2.example.com",
        steps: allOk({ install_key: { status: "failed", detail: "the server's host key does not match what was expected" } }),
        needs_input: null,
        machine_id: null,
        diagnosis: null,
      },
    });
    bootstrapForgetHostKey.mockResolvedValue({ status: "ok", data: null });
    // Saved before the run (so the password went out), changed by the time it failed —
    // the race the strict password connection still guards.
    bootstrapCheckHostKey
      .mockResolvedValueOnce(hostKeyCheck("known", "hostkey2.example.com"))
      .mockResolvedValueOnce(hostKeyCheck("changed", "hostkey2.example.com"));
    bootstrapServer.mockResolvedValueOnce({
      status: "ok",
      data: { session_id: "sess-hostkey-pw-2", host: "hostkey2.example.com", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: { state: { kind: "ready" } } },
    });

    mount();
    // Fill order matters: Address, then User, then Password — the order the form
    // actually lists them in, and the one the shipped bug got wrong.
    fill("Address", "hostkey2.example.com");
    fill("User", "deploy");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();

    expect(bootstrapServer).toHaveBeenNthCalledWith(1, "hostkey2.example.com", "hostkey2.example.com", 22, "deploy", "hunter2", true, null, NEW_FP);
    clickButtonWithText("Review the new key");
    await settle();
    clickButtonWithText("Trust the new key and retry");
    await settle();

    expect(bootstrapServer).toHaveBeenNthCalledWith(2, "hostkey2.example.com", "hostkey2.example.com", 22, "deploy", "hunter2", true, null, NEW_FP);
  });

  it("host key mismatch: a failed forget-host-key surfaces an error and skips the retry", async () => {
    bootstrapServer.mockResolvedValueOnce({
      status: "ok",
      data: {
        session_id: "sess-hostkey-fail",
        host: "hostkey-fail.example.com",
        steps: allOk({ install_key: { status: "failed", detail: "the server's host key does not match what was expected" } }),
        needs_input: null,
        machine_id: null,
        diagnosis: null,
      },
    });
    bootstrapForgetHostKey.mockResolvedValue({ status: "error", error: "could not update known_hosts" });
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("changed", "hostkey-fail.example.com"));

    mount();
    fill("Address", "hostkey-fail.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    clickButtonWithText("Review the new key");
    await settle();
    clickButtonWithText("Trust the new key and retry");
    await settle();

    expect(container.textContent).toContain("could not update known_hosts");
    // Never retried against the still-mismatched key.
    expect(bootstrapServer).toHaveBeenCalledTimes(1);
  });

  it("a rejected bootstrap_server call resets busy and surfaces an error instead of hanging forever", async () => {
    bootstrapServer.mockRejectedValueOnce(new Error("ECONNRESET"));
    mount();
    fill("Address", "flaky.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain("ECONNRESET");
    // Busy was reset — no button is stuck reading "Installing…".
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Installing…")).toBe(false);
  });

  it("a rejected bootstrap_resume call resets the sudo-busy state and surfaces an error", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-sudo-reject",
        host: "sudo-reject.example.com",
        steps: allOk({ escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" } }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    bootstrapResume.mockRejectedValueOnce(new Error("socket hang up"));
    mount();
    fill("Address", "sudo-reject.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    const sudoInput = container.querySelector('input[placeholder="Sudo password"]') as HTMLInputElement;
    setValue(sudoInput, "rootpw");
    clickButtonWithText("Resume");
    await settle();

    expect(container.textContent).toContain("socket hang up");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Resuming…")).toBe(false);
  });

  it("Cancel on a paused session awaits bootstrap_cancel and logs a failure instead of pretending it worked", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      bootstrapServer.mockResolvedValue({
        status: "ok",
        data: {
          session_id: "sess-cancel-fail",
          host: "cancel-fail.example.com",
          steps: allOk({ escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" } }),
          needs_input: "escalate_persistence",
          machine_id: null,
          diagnosis: null,
        },
      });
      bootstrapCancel.mockRejectedValueOnce(new Error("session already gone"));
      mount();
      fill("Address", "cancel-fail.example.com");
      fill("User", "deploy");
      clickButtonWithText("Install");
      await settle();

      clickButtonWithText("Cancel");
      await settle();

      expect(bootstrapCancel).toHaveBeenCalledWith("sess-cancel-fail");
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // A B11 review finding, re-checked here: `upload_daemon`'s restart-pending is
  // NON-blocking (`NeedsInputContinue`), so it can be reached while a LATER blocking
  // step (`escalate_persistence`'s sudo prompt) is still open — before `AddMachine`
  // has ever run. `machineId` is null in that combination.
  it("restart pending before the server is persisted: Restart now stays disabled and explains why", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-restart-early",
        host: "restart-early.example.com",
        steps: allOk({
          upload_daemon: { status: "needs_input", detail: "restart pending — 1 conversation(s) running" },
          escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" },
        }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "restart-early.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain("Restart pending");
    expect(container.textContent).toContain("Waiting for the rest of the install to finish");
    const restartBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Restart now"));
    expect(restartBtn).not.toBeUndefined();
    expect(restartBtn?.disabled).toBe(true);
  });

  it("password fields never carry autocomplete hints that could surface a save-password prompt", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-autocomplete",
        host: "autocomplete.example.com",
        steps: allOk({ escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" } }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    const formPassword = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(formPassword.autocomplete).toBe("new-password");
    fill("Address", "autocomplete.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    const sudoInput = container.querySelector('input[placeholder="Sudo password"]') as HTMLInputElement;
    expect(sudoInput.autocomplete).toBe("new-password");
    expect(sudoInput.getAttribute("aria-label")).toBeTruthy();
  });
});

describe("ServerBootstrapWizard — Settings-close guard while paused", () => {
  it("arms the shared guard while paused on the sudo prompt, and clears it once resolved", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-guard",
        host: "guard.example.com",
        steps: allOk({ escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" } }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    expect(useSettingsUi.getState().bootstrapGuard).toBeNull();
    fill("Address", "guard.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    // Paused on the blocking sudo prompt: the guard must be armed so `SettingsPanel`
    // confirms before letting the panel close and silently abandoning this session.
    expect(useSettingsUi.getState().bootstrapGuard).not.toBeNull();

    bootstrapResume.mockResolvedValue({
      status: "ok",
      data: { session_id: "sess-guard", host: "guard.example.com", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: { state: { kind: "ready" } } },
    });
    const sudoInput = container.querySelector('input[placeholder="Sudo password"]') as HTMLInputElement;
    setValue(sudoInput, "rootpw");
    clickButtonWithText("Resume");
    await settle();

    expect(useSettingsUi.getState().bootstrapGuard).toBeNull();
  });

  it("clears the guard on unmount even if it was still paused, and releases the paused session's server lock", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-guard-unmount",
        host: "guard-unmount.example.com",
        steps: allOk({ escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" } }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "guard-unmount.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();
    expect(useSettingsUi.getState().bootstrapGuard).not.toBeNull();

    // Unmounting here simulates `SettingsPanel`'s force-close path (the "Close
    // anyway" confirm dialog's `finishClose` → `onClose`), NOT this wizard's own
    // Cancel button — `cancelPaused` (tested above) already covers that path and
    // already called `bootstrapCancel` itself. Before the fix, this exact path left
    // the backend's per-server `ServerLocks` claim held forever (only
    // `bootstrap_resume`'s own completion or an explicit `bootstrap_cancel` ever
    // releases a paused run's claim), so every later `bootstrap_server`/
    // `bootstrap_resume`/`machine_repair` against the same host got `server_busy_error`
    // even though nothing was actually running.
    act(() => root.unmount());
    expect(useSettingsUi.getState().bootstrapGuard).toBeNull();
    expect(bootstrapCancel).toHaveBeenCalledWith("sess-guard-unmount");
  });

  it("does not double-cancel on unmount after the wizard's own Cancel button already did", async () => {
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "sess-guard-cancel-then-unmount",
        host: "guard-cancel-then-unmount.example.com",
        steps: allOk({ escalate_persistence: { status: "needs_input", detail: "this server needs a sudo password to continue" } }),
        needs_input: "escalate_persistence",
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "guard-cancel-then-unmount.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    clickButtonWithText("Cancel");
    await settle();
    expect(bootstrapCancel).toHaveBeenCalledTimes(1);
    expect(bootstrapCancel).toHaveBeenCalledWith("sess-guard-cancel-then-unmount");

    // The form is back to its empty, un-paused state — a later unmount (Settings
    // actually closing) must not fire a second, stale `bootstrapCancel` for a session
    // that's already been explicitly cancelled.
    act(() => root.unmount());
    expect(bootstrapCancel).toHaveBeenCalledTimes(1);
  });
});

// M12 (security review 2026-10-09): a typed login password never leaves before the
// server's identity is settled — a first contact's fingerprint is shown with the command
// that prints the real one on the server's console, and only an explicit confirmation
// sends the password, bound to exactly that key.
describe("ServerBootstrapWizard — host key before the password", () => {
  it("first contact: shows the fingerprint and the console check BEFORE sending anything", async () => {
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("new"));
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: { session_id: "s-first", host: "1.2.3.4", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: null },
    });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();

    expect(bootstrapServer).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Before your password is sent");
    expect(container.textContent).toContain(`ED25519 ${NEW_FP}`);
    expect(container.textContent).toContain("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub");
    // The password is not sitting in the visible field while the user checks.
    expect(passwordInput()?.value).toBe("");

    clickButtonWithText("It matches — continue");
    await settle();
    expect(bootstrapServer).toHaveBeenCalledWith("1.2.3.4", "1.2.3.4", 22, "root", "hunter2", true, null, NEW_FP);
  });

  it("first contact: Cancel sends nothing and drops the password it was holding", async () => {
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("new"));
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: { session_id: "s-cancel", host: "1.2.3.4", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: null },
    });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();
    clickButtonWithText("Cancel"); // the review's own Cancel comes first in the panel
    await settle();

    expect(bootstrapServer).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(NEW_FP);
    // Installing again without retyping it: the dropped password is not sent.
    clickButtonWithText("Install");
    await settle();
    expect(bootstrapServer).toHaveBeenCalledWith("1.2.3.4", "1.2.3.4", 22, "root", null, true, null, null);
  });

  it("first contact: editing the address withdraws the pending check", async () => {
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("new"));
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();
    expect(container.textContent).toContain(NEW_FP);
    fill("Address", "5.6.7.8");
    expect(container.textContent).not.toContain(NEW_FP);
    expect(bootstrapServer).not.toHaveBeenCalled();
  });

  it("first contact: an answer for an address edited meanwhile opens no review", async () => {
    let answer!: (v: unknown) => void;
    bootstrapCheckHostKey.mockReturnValue(new Promise((r) => (answer = r)));
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    fill("Address", "5.6.7.8");
    answer(hostKeyCheck("new"));
    await settle();
    expect(container.textContent).not.toContain(NEW_FP);
    expect(bootstrapServer).not.toHaveBeenCalled();
  });

  it("a key that changed since it was saved is shown side by side, replaced on confirmation, then installed", async () => {
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("changed"));
    bootstrapForgetHostKey.mockResolvedValue({ status: "ok", data: null });
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: { session_id: "s-changed", host: "1.2.3.4", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: null },
    });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain(`Saved on this Mac: ${OLD_FP}`);
    expect(container.textContent).toContain(`Presented now: ED25519 ${NEW_FP}`);
    expect(bootstrapServer).not.toHaveBeenCalled();
    clickButtonWithText("Trust the new key and retry");
    await settle();
    expect(bootstrapForgetHostKey).toHaveBeenCalledWith("1.2.3.4", 22, "root", NEW_FP);
    expect(bootstrapServer).toHaveBeenCalledWith("1.2.3.4", "1.2.3.4", 22, "root", "hunter2", true, null, NEW_FP);
  });

  // Review finding: a password-less run's keyed attempt saves whatever key answered it
  // (`accept-new` pins even a refused login) — so a saved key that no paired server
  // vouches for ("unverified") must still be shown and confirmed before the password goes.
  it("a key a password-less run saved on its own is still checked before the password goes", async () => {
    bootstrapServer.mockResolvedValueOnce({
      status: "ok",
      data: {
        session_id: "s-nopw",
        host: "1.2.3.4",
        steps: allOk({
          install_key: {
            status: "failed",
            detail: "this server needs its login password to install Flight Deck's key (first contact only)",
          },
        }),
        needs_input: null,
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    clickButtonWithText("Install"); // the Password field is optional
    await settle();
    expect(bootstrapServer).toHaveBeenCalledWith("1.2.3.4", "1.2.3.4", 22, "root", null, true, null, null);
    expect(bootstrapCheckHostKey).not.toHaveBeenCalled();

    // The retry with the password: the key that run saved is not vouched for.
    bootstrapCheckHostKey.mockResolvedValue(hostKeyCheck("unverified"));
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: { session_id: "s-pw", host: "1.2.3.4", steps: allOk(), needs_input: null, machine_id: "m1", diagnosis: null },
    });
    clickButtonWithText("Retry");
    await settle();
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();

    expect(bootstrapServer).toHaveBeenCalledTimes(1); // nothing sent yet
    expect(container.textContent).toContain("isn't paired with this Mac yet");
    expect(container.textContent).toContain("Before your password is sent");
    expect(container.textContent).toContain(`ED25519 ${NEW_FP}`);
    clickButtonWithText("It matches — continue");
    await settle();
    expect(bootstrapServer).toHaveBeenCalledTimes(2);
    expect(bootstrapServer).toHaveBeenLastCalledWith("1.2.3.4", "1.2.3.4", 22, "root", "hunter2", true, null, NEW_FP);
  });

  it("a key already confirmed in this wizard isn't asked for twice — another key is", async () => {
    bootstrapCheckHostKey.mockResolvedValueOnce(hostKeyCheck("new"));
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "s-later",
        host: "1.2.3.4",
        steps: allOk({ probe: { status: "failed", detail: "unsupported OS" } }),
        needs_input: null,
        machine_id: null,
        diagnosis: null,
      },
    });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();
    clickButtonWithText("It matches — continue");
    await settle();
    expect(bootstrapServer).toHaveBeenCalledTimes(1);

    // Same key, now saved but not yet paired: goes straight on, bound to it.
    bootstrapCheckHostKey.mockResolvedValueOnce(hostKeyCheck("unverified"));
    clickButtonWithText("Retry");
    await settle();
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();
    expect(bootstrapServer).toHaveBeenCalledTimes(2);
    expect(bootstrapServer).toHaveBeenLastCalledWith("1.2.3.4", "1.2.3.4", 22, "root", "hunter2", true, null, NEW_FP);

    // A different key at that address: asked again, nothing sent.
    bootstrapCheckHostKey.mockResolvedValueOnce(hostKeyCheck("unverified", "1.2.3.4", OLD_FP));
    clickButtonWithText("Retry");
    await settle();
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();
    expect(bootstrapServer).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(`ED25519 ${OLD_FP}`);
  });

  it("a server whose key can't be read surfaces the reason and sends nothing", async () => {
    bootstrapCheckHostKey.mockResolvedValue({ status: "error", error: "could not reach the server" });
    mount();
    fill("Address", "1.2.3.4");
    fill("User", "root");
    fill("Password", "hunter2");
    clickButtonWithText("Install");
    await settle();

    expect(container.textContent).toContain("could not reach the server");
    expect(bootstrapServer).not.toHaveBeenCalled();
  });
});

describe("ServerBootstrapWizard — legacy flow", () => {
  it("stays reachable and renders (server command step)", async () => {
    generateMachineKey.mockResolvedValue({ status: "ok", data: { identity_file: "/mock/key", public_key: "ssh-ed25519 AAAA mock" } });
    mount();
    clickButtonWithText("Use a command instead (servers with key-only login)");
    await settle();
    expect(container.textContent).toContain("Run this once on your server");
    expect(container.textContent).toContain("ssh-ed25519 AAAA mock");
  });

  // CRM holistic-review blocker #3 (chantier A bd7ca709): a pairing ticket is
  // SERVER-PRINTED — a hostile or compromised server can hand back one that
  // pre-fills an ssh-option-shaped `user`. "Continue" must refuse it and stay on the
  // ticket-paste stage, so the confirm screen (and "Install") never even sees it.
  it("refuses a malicious ticket's user, staying on the ticket-paste stage, and never calls bootstrap_server", async () => {
    generateMachineKey.mockResolvedValue({ status: "ok", data: { identity_file: "/mock/key", public_key: "ssh-ed25519 AAAA mock" } });
    mount();
    clickButtonWithText("Use a command instead (servers with key-only login)");
    await settle();

    const ticket = `fdpair:${btoa(
      JSON.stringify({
        label: "evil",
        host: "example.com",
        port: 22,
        user: "-oProxyCommand=touch /tmp/pwned",
      }),
    )}`;
    fill("fdpair", ticket);
    const continueBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Continue",
    ) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(false); // non-empty ticket text — the CLICK is what must refuse it
    act(() => continueBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    // Still on the ticket-paste stage — "3 · Confirm the connection" (and, with it,
    // "Install") never rendered.
    expect(container.textContent).not.toContain("Confirm the connection");
    expect(container.textContent).toMatch(/isn't safe to use/);
    expect(bootstrapServer).not.toHaveBeenCalled();
  });

  it("manual entry: refuses an ssh-option-shaped user, disabling Install with an inline reason", async () => {
    generateMachineKey.mockResolvedValue({ status: "ok", data: { identity_file: "/mock/key", public_key: "ssh-ed25519 AAAA mock" } });
    mount();
    clickButtonWithText("Use a command instead (servers with key-only login)");
    await settle();
    clickButtonWithText("Enter details manually");
    await settle();

    fill("Host or IP", "example.com");
    fill("User", "-oProxyCommand=touch /tmp/pwned");
    await settle();

    const installBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Install",
    ) as HTMLButtonElement;
    expect(installBtn.disabled).toBe(true);
    expect(container.textContent).toMatch(/User name cannot start with/);
    expect(bootstrapServer).not.toHaveBeenCalled();
  });

  // B12-legacy: the ticket flow used to dead-end here — its own "pair" action called
  // the LEGACY `addMachine` IPC, which hard-blocks with "claude is not installed…" on
  // a fresh server. Now the confirmed connection is handed to `PrimaryBootstrap`
  // (`onInstall`), which runs the SAME full `bootstrap_server` pipeline that installs
  // everything — see the module doc's top paragraph.
  it("pasting a valid ticket then clicking Install switches to the primary view and installs with no password", async () => {
    generateMachineKey.mockResolvedValue({ status: "ok", data: { identity_file: "/mock/key", public_key: "ssh-ed25519 AAAA mock" } });
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "s-legacy",
        host: "my-vps.tailnet.ts.net",
        steps: allOk(),
        needs_input: null,
        machine_id: "m-legacy",
        diagnosis: null,
      },
    });
    mount();
    clickButtonWithText("Use a command instead (servers with key-only login)");
    await settle();

    // Deliberately give the ticket a `host` DIFFERENT from its tailscale address, so a
    // pass on this assertion actually proves the tailscale-preferred candidate won —
    // not just whatever the ticket's raw `host` field happened to hold.
    const ticket = `fdpair:${btoa(
      JSON.stringify({
        label: "my-vps",
        host: "203.0.113.5",
        port: 2222,
        user: "deploy",
        addresses: [
          { kind: "lan", value: "192.168.1.50" },
          { kind: "tailscale", value: "my-vps.tailnet.ts.net" },
        ],
      }),
    )}`;
    fill("fdpair", ticket);
    clickButtonWithText("Continue");
    await settle();
    expect(container.textContent).toContain("Confirm the connection");

    clickButtonWithText("Install");
    await settle();

    expect(bootstrapServer).toHaveBeenCalledTimes(1);
    expect(bootstrapServer).toHaveBeenCalledWith("my-vps", "my-vps.tailnet.ts.net", 2222, "deploy", null, true, null, null);
    // No password involved: nothing to gate on a host key.
    expect(bootstrapCheckHostKey).not.toHaveBeenCalled();
    // Switched to the primary view's live checklist — the ticket-paste stage is gone.
    expect(container.textContent).not.toContain("Confirm the connection");
    expect(container.textContent).toContain("Using the key your server just authorized");
  });

  // React StrictMode double-invokes a freshly-mounted component's effects (call →
  // cleanup → call again) in dev, to surface effects that aren't idempotent.
  // `PrimaryBootstrap`'s auto-install effect is exactly that kind of effect — without
  // the `autoInstallStarted` ref guard, this would fire `bootstrap_server` twice and
  // spawn two overlapping sessions against the same server.
  it("does not double-start the install under React StrictMode's double-invoked mount effect", async () => {
    generateMachineKey.mockResolvedValue({ status: "ok", data: { identity_file: "/mock/key", public_key: "ssh-ed25519 AAAA mock" } });
    bootstrapServer.mockResolvedValue({
      status: "ok",
      data: {
        session_id: "s-strict",
        host: "strict.example.com",
        steps: allOk(),
        needs_input: null,
        machine_id: "m-strict",
        diagnosis: null,
      },
    });

    act(() => {
      root.render(createElement(StrictMode, null, createElement(ServerBootstrapWizard, { onClose: () => {} })));
    });
    clickButtonWithText("Use a command instead (servers with key-only login)");
    await settle();

    const ticket = `fdpair:${btoa(
      JSON.stringify({ label: "strict-vps", host: "strict.example.com", port: 22, user: "deploy", addresses: [] }),
    )}`;
    fill("fdpair", ticket);
    clickButtonWithText("Continue");
    await settle();

    clickButtonWithText("Install");
    await settle();

    expect(bootstrapServer).toHaveBeenCalledTimes(1);
  });
});
