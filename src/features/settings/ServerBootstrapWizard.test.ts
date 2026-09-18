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
    machineRepair: vi.fn(),
    machineDiagnose: vi.fn(),
    startClaudeLogin: vi.fn(),
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
    machineRepair: mocks.machineRepair,
    machineDiagnose: mocks.machineDiagnose,
    startClaudeLogin: mocks.startClaudeLogin,
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

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ServerBootstrapWizard } from "./ServerBootstrapWizard";
import { useSettingsUi } from "../../store/settingsUi";

let container: HTMLDivElement;
let root: Root;

const STEP_IDS = [
  "install_key",
  "probe",
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  bootstrapServer.mockReset();
  bootstrapResume.mockReset();
  bootstrapCancel.mockReset();
  bootstrapForgetHostKey.mockReset();
  machineRepair.mockReset();
  machineDiagnose.mockReset();
  startClaudeLogin.mockReset();
  submitClaudeLoginCode.mockReset();
  cancelClaudeLogin.mockReset();
  generateMachineKey.mockReset();
  loadPersistedState.mockReset();
  loadPersistedState.mockResolvedValue({ status: "ok", data: { machines: [], repos: [], conversations: [], active_id: null } });
  useSettingsUi.setState({ bootstrapGuard: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ServerBootstrapWizard — form", () => {
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

    expect(bootstrapServer).toHaveBeenCalledWith("1.2.3.4", "1.2.3.4", 22, "root", "hunter2", true, null);
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
    clickButtonWithText("Forget the old key and retry");
    await settle();
    expect(bootstrapForgetHostKey).toHaveBeenCalledWith("hostkey.example.com", 22);
    expect(bootstrapServer).toHaveBeenCalledTimes(2);
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

    expect(bootstrapServer).toHaveBeenNthCalledWith(1, "hostkey2.example.com", "hostkey2.example.com", 22, "deploy", "hunter2", true, null);
    clickButtonWithText("Forget the old key and retry");
    await settle();

    expect(bootstrapServer).toHaveBeenNthCalledWith(2, "hostkey2.example.com", "hostkey2.example.com", 22, "deploy", "hunter2", true, null);
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

    mount();
    fill("Address", "hostkey-fail.example.com");
    fill("User", "deploy");
    clickButtonWithText("Install");
    await settle();

    clickButtonWithText("Forget the old key and retry");
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

  it("clears the guard on unmount even if it was still paused", async () => {
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

    act(() => root.unmount());
    expect(useSettingsUi.getState().bootstrapGuard).toBeNull();
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
  // ticket-paste stage, so the confirm screen (and "Test & pair") never even sees it.
  it("refuses a malicious ticket's user, staying on the ticket-paste stage", async () => {
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
    // "Test & pair") never rendered.
    expect(container.textContent).not.toContain("Confirm the connection");
    expect(container.textContent).toMatch(/isn't safe to use/);
  });

  it("manual entry: refuses an ssh-option-shaped user, disabling Test & pair with an inline reason", async () => {
    generateMachineKey.mockResolvedValue({ status: "ok", data: { identity_file: "/mock/key", public_key: "ssh-ed25519 AAAA mock" } });
    mount();
    clickButtonWithText("Use a command instead (servers with key-only login)");
    await settle();
    clickButtonWithText("Enter details manually");
    await settle();

    fill("Host or IP", "example.com");
    fill("User", "-oProxyCommand=touch /tmp/pwned");
    await settle();

    const pairBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Test & pair",
    ) as HTMLButtonElement;
    expect(pairBtn.disabled).toBe(true);
    expect(container.textContent).toMatch(/User name cannot start with/);
  });
});
