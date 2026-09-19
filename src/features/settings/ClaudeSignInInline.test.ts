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

  it("a same-caller Cancel clears the shared active flag locally, without waiting for the backend's own event", async () => {
    startClaudeLogin.mockResolvedValue({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);

    click("Cancel");
    expect(cancelClaudeLoginCalledWith()).toEqual({ session_id: "s1", machine_id: "m1", owned: true });
    expect(useClaudeLoginSessions.getState().active.m1).toBe(false);

    // The backend now DOES emit a terminal event for this cancel too (residual defect
    // A8/R1) — the owner's own belated echo of its own cancel must render NOTHING when
    // it arrives (see the dedicated describe block below for the full spec).
    act(() =>
      serverLoginResultEvent.emit({ session_id: "s1", machine_id: "m1", ok: false, email: null, error: "cancelled", reason: "cancelled" }),
    );
    await settle();
    expect(container.textContent).not.toContain("Sign-in failed");
    expect(container.textContent).not.toContain("cancelled from another panel");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Start Claude sign-in")).toBe(true);
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
        reason: "superseded",
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

// Counter-verification of the fix wave (residual defect A8/R1, CRM `1abfc028`): the
// follow-up review above only closed the ATTACHED→owner teardown direction. This
// closes the reverse — the OWNER cancelling/unmounting while another surface is still
// ATTACHED to the same session must not leave that surface stuck forever.
describe("ClaudeSignInInline — owner cancel/unmount leaves an attached sibling informed, not stuck (residual defect A8/R1)", () => {
  it("owner cancels: the OWNER shows no error, the ATTACHED sibling gets a neutral 'cancelled elsewhere' message and Start again", async () => {
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-3", machine_id: "m1", owned: true } });
    mount(); // instance A — the owner
    click("Start Claude sign-in");
    await settle();

    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-3", machine_id: "m1", owned: false } });
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const rootB = createRoot(containerB);
    act(() => rootB.render(createElement(ClaudeSignInInline, { machineId: "m1" })));
    click("Start Claude sign-in", containerB);
    await settle();

    // The owner (A) cancels — this DOES call the backend now (unlike an attached
    // instance's own Cancel).
    click("Cancel", container);
    expect(cancelClaudeLoginCalledWith()).toEqual({ session_id: "shared-3", machine_id: "m1", owned: true });

    // The backend's own terminal event for that cancel arrives at BOTH mounted
    // instances (they share the same mock emitter) — exactly what `run_login_actor`
    // now emits for every `Cancelled` outcome, owner-initiated or not.
    act(() =>
      serverLoginResultEvent.emit({
        session_id: "shared-3",
        machine_id: "m1",
        ok: false,
        email: null,
        error: "cancelled",
        reason: "cancelled",
      }),
    );
    await settle();

    // Owner (A): already reset itself locally on Cancel and recognizes this as its OWN
    // echo — shows no error at all, just its ordinary Start button.
    expect(container.textContent).not.toContain("Sign-in failed");
    expect(container.textContent).not.toContain("cancelled from another panel");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Start Claude sign-in")).toBe(true);

    // Attached sibling (B): did NOT initiate this cancel — must exit its stuck
    // "waiting for the sign-in link" view for the neutral message, never the alarming
    // "Sign-in failed" wording, and be offered a way to start over.
    expect(containerB.querySelector('input[placeholder="Authorization code"]')).toBeNull();
    expect(containerB.textContent).toContain("Sign-in was cancelled from another panel.");
    expect(containerB.textContent).not.toContain("Sign-in failed");
    expect(Array.from(containerB.querySelectorAll("button")).some((b) => b.textContent === "Start again")).toBe(true);

    act(() => rootB.unmount());
    containerB.remove();
  });

  it("owner unmounts: the ATTACHED sibling gets the same neutral 'cancelled elsewhere' message and Start again", async () => {
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-4", machine_id: "m1", owned: true } });
    const containerA = document.createElement("div");
    document.body.appendChild(containerA);
    const rootA = createRoot(containerA);
    act(() => rootA.render(createElement(ClaudeSignInInline, { machineId: "m1" })));
    click("Start Claude sign-in", containerA);
    await settle();

    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-4", machine_id: "m1", owned: false } });
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const rootB = createRoot(containerB);
    act(() => rootB.render(createElement(ClaudeSignInInline, { machineId: "m1" })));
    click("Start Claude sign-in", containerB);
    await settle();

    // The owner (A) unmounts instead of clicking Cancel — its cleanup effect cancels
    // the backend session exactly like a Cancel click would.
    act(() => rootA.unmount());
    containerA.remove();
    expect(cancelClaudeLoginCalledWith()).toEqual({ session_id: "shared-4", machine_id: "m1", owned: true });

    act(() =>
      serverLoginResultEvent.emit({
        session_id: "shared-4",
        machine_id: "m1",
        ok: false,
        email: null,
        error: "cancelled",
        reason: "cancelled",
      }),
    );
    await settle();

    // The now-unmounted owner has no listener left to react (nothing to assert there);
    // the still-attached sibling must be informed instead of left stuck.
    expect(containerB.querySelector('input[placeholder="Authorization code"]')).toBeNull();
    expect(containerB.textContent).toContain("Sign-in was cancelled from another panel.");
    expect(containerB.textContent).not.toContain("Sign-in failed");
    expect(Array.from(containerB.querySelectorAll("button")).some((b) => b.textContent === "Start again")).toBe(true);

    act(() => rootB.unmount());
    containerB.remove();
  });

  it("regression guard (899ccf7): an ATTACHED instance's own cancel/unmount still never touches the owner's session", async () => {
    // This exact behavior is already covered by the "ownership & stale-event
    // filtering" describe block above — asserted again here, explicitly, as the
    // regression guard this residual-fix task calls for.
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-5", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();

    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "shared-5", machine_id: "m1", owned: false } });
    const containerB = document.createElement("div");
    document.body.appendChild(containerB);
    const rootB = createRoot(containerB);
    act(() => rootB.render(createElement(ClaudeSignInInline, { machineId: "m1" })));
    click("Start Claude sign-in", containerB);
    await settle();

    act(() => rootB.unmount());
    containerB.remove();
    await settle();

    expect(cancelClaudeLogin).not.toHaveBeenCalled();
    expect(useClaudeLoginSessions.getState().active.m1).toBe(true);
  });
});

// Counter-verification of the residual-defect fix above found a further gap: a quick
// owner Cancel-then-Start can reattach to the exact same (still dying) `session_id`
// (`attach_or_reserve` hands back whatever is still registered) before the backend
// actor finishes tearing it down — the belated `cancelled` event for the OLD cancel
// must not be swallowed as an echo of that old intent once THIS instance has moved on
// to a freshly (re-)attached view of the same id.
describe("ClaudeSignInInline — quick Cancel-then-Start reusing the same session_id (residual defect, CRM 1abfc028)", () => {
  it("does not swallow the belated cancelled event as its own echo after re-attaching to the same reused session_id", async () => {
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: true } });
    mount();
    click("Start Claude sign-in");
    await settle();

    // Owner cancels — resets its own view synchronously, before the backend actor has
    // necessarily finished tearing the session down.
    click("Cancel");
    expect(cancelClaudeLoginCalledWith()).toEqual({ session_id: "s1", machine_id: "m1", owned: true });
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Start Claude sign-in")).toBe(true);

    // Same instance clicks Start again immediately — `attach_or_reserve` hands back the
    // SAME (still dying) session_id, this time as a non-owning attach.
    startClaudeLogin.mockResolvedValueOnce({ status: "ok", data: { session_id: "s1", machine_id: "m1", owned: false } });
    click("Start Claude sign-in");
    await settle();
    // Now viewing the (re-)attached session, waiting for its prompt.
    expect(container.textContent).toContain("Waiting for the sign-in link…");

    // The OLD cancel's belated terminal event finally arrives, for the same session_id.
    act(() =>
      serverLoginResultEvent.emit({ session_id: "s1", machine_id: "m1", ok: false, email: null, error: "cancelled", reason: "cancelled" }),
    );
    await settle();

    // Must be treated as live, truthful information about the NEW attached view, not
    // silently dropped as the old cancel's own echo — never stuck on "Waiting…".
    expect(container.textContent).not.toContain("Waiting for the sign-in link…");
    expect(container.textContent).toContain("Sign-in was cancelled from another panel.");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Start again")).toBe(true);
  });
});

function cancelClaudeLoginCalledWith() {
  const calls = mocks.cancelClaudeLogin.mock.calls;
  return calls[calls.length - 1]?.[0];
}
