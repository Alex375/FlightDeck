// The shared Claude sign-in inline flow: refuses to `openUrl` an untrusted link, and
// clears the pasted code out of state the instant it's submitted (success or failure).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Listener = (e: { payload: unknown }) => void;
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
    serverLoginPromptEvent: mockEmitter(),
    serverLoginResultEvent: mockEmitter(),
    startClaudeLogin: vi.fn(),
    restartClaudeLogin: vi.fn(),
    submitClaudeLoginCode: vi.fn(),
    cancelClaudeLogin: vi.fn(),
    openUrl: vi.fn(async () => {}),
  };
});

vi.mock("../../ipc/client", () => ({
  commands: {
    startClaudeLogin: mocks.startClaudeLogin,
    restartClaudeLogin: mocks.restartClaudeLogin,
    submitClaudeLoginCode: mocks.submitClaudeLoginCode,
    cancelClaudeLogin: mocks.cancelClaudeLogin,
  },
  events: {
    serverLoginPromptEvent: mocks.serverLoginPromptEvent,
    serverLoginResultEvent: mocks.serverLoginResultEvent,
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClaudeSignInInline } from "./ClaudeSignInInline";
import { useClaudeLoginSessions } from "./claudeLoginSessions";

const { serverLoginPromptEvent, serverLoginResultEvent, startClaudeLogin, restartClaudeLogin, submitClaudeLoginCode, openUrl } = mocks;

let container: HTMLDivElement;
let root: Root;

function mount() {
  act(() => {
    root.render(createElement(ClaudeSignInInline, { machineId: "m1" }));
  });
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
function click(text: string) {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`no button "${text}"`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function setValue(input: HTMLInputElement, value: string) {
  act(() => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function codeInput(): HTMLInputElement | null {
  return container.querySelector('input[placeholder="Authorization code"]');
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  startClaudeLogin.mockReset();
  restartClaudeLogin.mockReset();
  submitClaudeLoginCode.mockReset();
  openUrl.mockReset();
  openUrl.mockResolvedValue(undefined);
  useClaudeLoginSessions.setState({ active: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ClaudeSignInInline — URL trust gate", () => {
  it("opens a trusted claude.ai URL", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1" } });
    mount();
    click("Start Claude sign-in");
    await settle();
    act(() => serverLoginPromptEvent.emit({ machine_id: "m1", url: "https://claude.ai/oauth/authorize?x=1" }));
    await settle();
    click("Open sign-in page");
    expect(openUrl).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?x=1");
  });

  it("refuses to open an untrusted URL, and never calls openUrl", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1" } });
    mount();
    click("Start Claude sign-in");
    await settle();
    act(() => serverLoginPromptEvent.emit({ machine_id: "m1", url: "https://not-claude.example.com/steal" }));
    await settle();
    click("Open sign-in page");
    expect(openUrl).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Refused to open an untrusted sign-in link");
  });
});

describe("ClaudeSignInInline — code handling", () => {
  it("clears the pasted code from state the instant it's submitted", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1" } });
    submitClaudeLoginCode.mockResolvedValue({ status: "ok", data: null });
    mount();
    click("Start Claude sign-in");
    await settle();
    act(() => serverLoginPromptEvent.emit({ machine_id: "m1", url: "https://claude.ai/oauth" }));
    await settle();

    const input = codeInput()!;
    setValue(input, "123456");
    expect(input.value).toBe("123456");
    click("Submit");
    // Cleared synchronously on submit — before the IPC call even resolves.
    expect(codeInput()?.value).toBe("");
    expect(submitClaudeLoginCode).toHaveBeenCalledWith({ session_id: "s1", machine_id: "m1" }, "123456");
    await settle();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});

// B-finding #4: single-flight semantics — a plain Start attaches (never kills a live
// session), only the explicit "Restart sign-in" replaces one, and the shared `active`
// flag other surfaces read is kept in sync with all of that.
describe("ClaudeSignInInline — single-flight (B-finding #4)", () => {
  it("marks the shared session active the instant Start succeeds", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1" } });
    mount();
    expect(useClaudeLoginSessions.getState().active.m1).not.toBe(true);
    click("Start Claude sign-in");
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);
  });

  it("a same-caller Cancel clears the shared active flag locally, with no backend event needed", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1" } });
    mount();
    click("Start Claude sign-in");
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    click("Cancel");
    expect(cancelClaudeLoginCalledWith()).toEqual({ session_id: "s1", machine_id: "m1" });
    expect(useClaudeLoginSessions.getState().active.m1).toBe(false);
  });

  it("offers Restart sign-in once a session is in flight, and it calls restart_claude_login (never start_claude_login again)", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1" } });
    restartClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s2", machine_id: "m1" } });
    mount();
    click("Start Claude sign-in");
    await settle();

    click("Restart sign-in");
    await settle();

    expect(restartClaudeLogin).toHaveBeenCalledWith("m1");
    expect(startClaudeLogin).toHaveBeenCalledTimes(1); // never called again by the restart
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true); // still active, under the NEW session
  });

  it("renders a 'superseded' result exactly like any other failure, and clears the shared active flag", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1" } });
    mount();
    click("Start Claude sign-in");
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    // Exactly what `run_login_actor` emits for the REPLACED session on an explicit
    // "Restart sign-in" started elsewhere (never for a same-caller Cancel).
    act(() =>
      serverLoginResultEvent.emit({
        machine_id: "m1",
        ok: false,
        email: null,
        error: "superseded by another sign-in for this server",
      }),
    );
    await settle();

    expect(container.textContent).toContain("Sign-in failed: superseded by another sign-in for this server.");
    expect(useClaudeLoginSessions.getState().active.m1).toBe(false);
  });
});

function cancelClaudeLoginCalledWith() {
  const calls = mocks.cancelClaudeLogin.mock.calls;
  return calls[calls.length - 1]?.[0];
}
