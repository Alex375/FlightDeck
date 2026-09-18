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
});
