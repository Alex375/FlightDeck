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

const { serverLoginPromptEvent, serverLoginResultEvent, startClaudeLogin, restartClaudeLogin, submitClaudeLoginCode, cancelClaudeLogin, openUrl } =
  mocks;

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
function click(text: string, scope: ParentNode = container) {
  const btn = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
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
  cancelClaudeLogin.mockReset();
  cancelClaudeLogin.mockResolvedValue({ status: "ok", data: null });
  openUrl.mockReset();
  openUrl.mockResolvedValue(undefined);
  useClaudeLoginSessions.setState({ active: {}, sessionIds: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ClaudeSignInInline — URL trust gate", () => {
  it("opens a trusted claude.ai URL", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();
    act(() => serverLoginPromptEvent.emit({ session_id: "s1", machine_id: "m1", url: "https://claude.ai/oauth/authorize?x=1" }));
    await settle();
    click("Open sign-in page");
    expect(openUrl).toHaveBeenCalledWith("https://claude.ai/oauth/authorize?x=1");
  });

  it("refuses to open an untrusted URL, and never calls openUrl", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();
    act(() => serverLoginPromptEvent.emit({ session_id: "s1", machine_id: "m1", url: "https://not-claude.example.com/steal" }));
    await settle();
    click("Open sign-in page");
    expect(openUrl).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Refused to open an untrusted sign-in link");
  });
});

describe("ClaudeSignInInline — code handling", () => {
  it("clears the pasted code from state the instant it's submitted", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    submitClaudeLoginCode.mockResolvedValue({ status: "ok", data: null });
    mount();
    click("Start Claude sign-in");
    await settle();
    act(() => serverLoginPromptEvent.emit({ session_id: "s1", machine_id: "m1", url: "https://claude.ai/oauth" }));
    await settle();

    const input = codeInput()!;
    setValue(input, "123456");
    expect(input.value).toBe("123456");
    click("Submit");
    // Cleared synchronously on submit — before the IPC call even resolves.
    expect(codeInput()?.value).toBe("");
    expect(submitClaudeLoginCode).toHaveBeenCalledWith({ session_id: "s1", machine_id: "m1", owned: true }, "123456");
    await settle();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});

// B-finding #4: single-flight semantics — a plain Start attaches (never kills a live
// session), only the explicit "Restart sign-in" replaces one, and the shared `active`
// flag other surfaces read is kept in sync with all of that.
describe("ClaudeSignInInline — single-flight (B-finding #4)", () => {
  it("marks the shared session active the instant Start succeeds", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    mount();
    expect(useClaudeLoginSessions.getState().active.m1).not.toBe(true);
    click("Start Claude sign-in");
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);
  });

  it("a same-caller Cancel clears the shared active flag locally, with no backend event needed", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    click("Cancel");
    expect(cancelClaudeLoginCalledWith()).toEqual({ session_id: "s1", machine_id: "m1", owned: true });
    expect(useClaudeLoginSessions.getState().active.m1).toBe(false);
  });

  it("offers Restart sign-in once a session is in flight, and it calls restart_claude_login (never start_claude_login again)", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    restartClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s2", machine_id: "m1", owned: true } });
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
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    // Exactly what `run_login_actor` emits for the REPLACED session on an explicit
    // "Restart sign-in" started elsewhere (never for a same-caller Cancel).
    act(() =>
      serverLoginResultEvent.emit({
        session_id: "s1",
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

// Follow-up review of B-finding #4: reference-counting ownership (attach vs. reserve)
// and session-id-scoped event filtering — closing the "silently killed, zero UI
// feedback" bug class the single-flight fix was meant to eliminate, reproduced instead
// through an ATTACHED surface's teardown and a "Restart sign-in" self-race.
describe("ClaudeSignInInline — ownership & stale-event filtering (follow-up review of B-finding #4)", () => {
  it("an ATTACHED instance's unmount does NOT cancel the shared session or clear the active flag", async () => {
    // Instance A reserves the session (owned:true) — deliberately NOT the shared
    // `container`/`root` from `beforeEach` (left untouched, still cleaned up by
    // `afterEach` as usual), so both instances here are managed fully locally.
    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    const rootA = createRoot(containerA);
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-1", machine_id: "m1", owned: true } });
    act(() => rootA.render(createElement(ClaudeSignInInline, { machineId: "m1" })));
    click("Start Claude sign-in", containerA);
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    // … instance B (e.g. the other surface) ATTACHES to the SAME session (owned:false).
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-1", machine_id: "m1", owned: false } });
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const rootB = createRoot(containerB);
    act(() => rootB.render(createElement(ClaudeSignInInline, { machineId: "m1" })));
    click("Start Claude sign-in", containerB);
    await settle();

    // Unmounting the ATTACHED instance (B) must be a local-only detach: no cancel, and
    // the shared flag stays true for A, which still owns the session.
    act(() => rootB.unmount());
    containerB.remove();
    await settle();

    expect(cancelClaudeLogin).not.toHaveBeenCalled();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    act(() => rootA.unmount());
    containerA.remove();
  });

  it("an ATTACHED instance's Cancel click does NOT cancel the shared session or clear the active flag", async () => {
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-2", machine_id: "m1", owned: true } });
    mount(); // instance A — the owner
    click("Start Claude sign-in");
    await settle();

    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-2", machine_id: "m1", owned: false } });
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const rootB = createRoot(containerB);
    act(() => rootB.render(createElement(ClaudeSignInInline, { machineId: "m1" })));
    click("Start Claude sign-in", containerB);
    await settle();

    // B clicks its OWN Cancel — must not touch the backend session A still owns.
    click("Cancel", containerB);
    expect(cancelClaudeLogin).not.toHaveBeenCalled();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);
    // B's own view goes back to offering its own Start button (a local-only reset).
    expect(Array.from(containerB.querySelectorAll("button")).some((b) => b.textContent === "Start Claude sign-in")).toBe(true);

    act(() => rootB.unmount());
    containerB.remove();
  });

  it("Restart sign-in: the OLD session's belated terminal event does not clobber the NEW session's state", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    restartClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s2", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();

    click("Restart sign-in");
    await settle();
    // The panel is showing the NEW session (s2) now — still in the "in flight" view,
    // not a result.
    expect(container.querySelector('input[placeholder="Authorization code"]')).not.toBeNull();

    // The OLD session's own belated "superseded" result arrives AFTER the restart
    // already resolved — exactly the real backend's ordering (`restart_claude_login`
    // returns the new session before the old actor's kill+wait completes). Without
    // session-id filtering this used to wipe out the brand-new session and show a
    // false "Sign-in failed: superseded…".
    act(() =>
      serverLoginResultEvent.emit({
        session_id: "s1",
        machine_id: "m1",
        ok: false,
        email: null,
        error: "superseded by another sign-in for this server",
      }),
    );
    await settle();

    expect(container.textContent).not.toContain("Sign-in failed");
    expect(container.querySelector('input[placeholder="Authorization code"]')).not.toBeNull();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    // The NEW session's own terminal event still works normally afterward.
    act(() => serverLoginResultEvent.emit({ session_id: "s2", machine_id: "m1", ok: true, email: "demo@example.com", error: null }));
    await settle();
    expect(container.textContent).toContain("Signed in as demo@example.com");
    expect(useClaudeLoginSessions.getState().active.m1).toBe(false);
  });
});

function cancelClaudeLoginCalledWith() {
  const calls = mocks.cancelClaudeLogin.mock.calls;
  return calls[calls.length - 1]?.[0];
}
