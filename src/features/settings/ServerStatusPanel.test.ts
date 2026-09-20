// `DiagnosisSummary` renders the right headline + repair action for a CANNED
// diagnosis, one per headline state — no IPC mocking needed, it's a pure(ish)
// presentational component (`ServerStatusPanel` itself owns the fetching). A second
// describe block below mounts `ServerStatusPanel` itself (with `commands` mocked) to
// cover the fetching/error-surfacing it owns.
//
// Built with createElement in a `*.test.ts` file + react-dom/client, same discipline
// as the wizard's own test file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (e: { payload: unknown }) => void;

// `vi.mock`'s factory is hoisted above the whole module, so every mock it references
// must be created inside `vi.hoisted` rather than as a plain top-level `const` — same
// discipline as ServerBootstrapWizard.test.ts.
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
    serverLoginPromptEvent: mockEmitter(),
    serverLoginResultEvent: mockEmitter(),
    machineDiagnose: vi.fn(),
    machineRepair: vi.fn(),
    startClaudeLogin: vi.fn(),
    restartClaudeLogin: vi.fn(),
    submitClaudeLoginCode: vi.fn(),
    cancelClaudeLogin: vi.fn(),
    // Defaults to "nothing running on this server" — the Remove-confirm tests below
    // override this per-case to drive the gate.
    useMachineActiveConversationIds: vi.fn(() => [] as string[]),
  };
});
const { machineDiagnose, machineRepair, useMachineActiveConversationIds, startClaudeLogin } = mocks;

vi.mock("../../ipc/client", () => ({
  commands: {
    machineDiagnose: mocks.machineDiagnose,
    machineRepair: mocks.machineRepair,
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
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
// Real `useMachineActiveConversationIds` pulls from the live conversations/message
// stores (repos, sessions, background-task counts) — irrelevant plumbing for this
// component's own tests, which only care how the count it returns gates Remove.
vi.mock("../../agent/fleet", () => ({
  useMachineActiveConversationIds: mocks.useMachineActiveConversationIds,
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiagnosisSummary, ServerStatusPanel } from "./ServerStatusPanel";
import type { Machine } from "../../store/conversationsStore";
import type { RepairAction, ServerDiagnosis } from "../../ipc/client";
import type { ProvisionStatusLabel } from "./provisionStatus";
import sharedStyles from "./SettingsPanel.module.css";
import { useClaudeLoginSessions } from "./claudeLoginSessions";

let container: HTMLDivElement;
let root: Root;

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
    user_unit_missing_path: null,
    claude_installed: true,
    claude_logged_in: true,
    claude_email: "demo@example.com",
    tailscale_name: "box.tail1234.ts.net",
    last_boot: "2026-09-15 08:00:00",
    busy_conversations: 0,
    bundled_daemon_version: "0.4.2",
    daemon_outdated: false,
    ...over,
  };
}

function mount(diagnosis: ServerDiagnosis, onRepair: (a: RepairAction) => void = () => {}, repairBusy: RepairAction | null = null) {
  act(() => {
    root.render(createElement(DiagnosisSummary, { diagnosis, repairBusy, onRepair }));
  });
}

function repairButtonTitles(): string[] {
  return Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  machineDiagnose.mockReset();
  machineRepair.mockReset();
  useMachineActiveConversationIds.mockReset();
  useMachineActiveConversationIds.mockReturnValue([]);
  startClaudeLogin.mockReset();
  useClaudeLoginSessions.setState({ active: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DiagnosisSummary — the 5 headline states", () => {
  it("Ready — green headline, no repair buttons for a fully healthy server", () => {
    mount(baseDiagnosis());
    expect(container.textContent).toContain("Ready");
    expect(container.querySelector('[data-tone="ready"]')).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  // (B14) Distinct from "Needs Claude sign-in" below — a missing `claude` gets its
  // OWN headline + repair suggestion (`install_claude`, via `repairSuggestionsFor`),
  // never routed through the sign-in flow (see `claudeNeedsSignIn`'s own doc).
  it("Claude Code is not installed — amber headline, offers Install Claude Code via repairSuggestionsFor", () => {
    mount(baseDiagnosis({ claude_installed: false, claude_logged_in: null, claude_email: null, state: { kind: "needs_claude_install" } }));
    // (B14 fix round 3) Worded to also be accurate for a PRESENT but broken binary.
    expect(container.textContent).toContain("Claude Code isn't working on this server");
    expect(container.querySelector('[data-tone="attention"]')).not.toBeNull();
    expect(repairButtonTitles().some((t) => t.includes("Install Claude Code"))).toBe(true);
  });

  it("Needs Claude sign-in — amber headline (its own repair lives outside repairSuggestionsFor)", () => {
    mount(baseDiagnosis({ claude_installed: true, claude_logged_in: false, claude_email: null, state: { kind: "needs_claude_sign_in" } }));
    expect(container.textContent).toContain("Needs Claude sign-in");
    expect(container.querySelector('[data-tone="attention"]')).not.toBeNull();
    // Installed already — must NOT also offer Install Claude Code.
    expect(repairButtonTitles().some((t) => t.includes("Install Claude Code"))).toBe(false);
  });

  it("Running — not reboot-safe — blue headline, offers the matching repair for a user-level install", () => {
    mount(baseDiagnosis({ installed_as: "user", reboot_safe: false, state: { kind: "running_not_reboot_safe" } }));
    expect(container.textContent).toContain("Running — not reboot-safe");
    expect(container.querySelector('[data-tone="caution"]')).not.toBeNull();
    expect(repairButtonTitles().some((t) => t.includes("Enable linger"))).toBe(true);
  });

  it("Failed — red headline with the reason, tri-state facts render as Unknown (never a false No)", () => {
    mount({
      state: { kind: "failed", reason: "could not reach the server" },
      installed_as: "unknown",
      daemon_running: null,
      daemon_version_disk: null,
      daemon_version_running: null,
      restart_pending: false,
      reboot_safe: null,
      linger: null,
      sleep_masked: null,
      user_unit_missing_path: null,
      claude_installed: null,
      claude_logged_in: null,
      claude_email: null,
      tailscale_name: null,
      last_boot: null,
      busy_conversations: null,
      bundled_daemon_version: null,
      daemon_outdated: false,
    });
    expect(container.textContent).toContain("Failed — could not reach the server");
    expect(container.querySelector('[data-tone="error"]')).not.toBeNull();
    const unknownValues = container.querySelectorAll('[data-tri="unknown"]');
    expect(unknownValues.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-tri="no"]')).toHaveLength(0);
  });
});

describe("DiagnosisSummary — repair suggestions", () => {
  it("offers Restart the daemon when restart_pending is true, and calls onRepair with restart_daemon", () => {
    const onRepair = vi.fn();
    mount(baseDiagnosis({ restart_pending: true }), onRepair);
    expect(repairButtonTitles().some((t) => t.includes("Restart the daemon"))).toBe(true);
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Restart the daemon"))!;
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRepair).toHaveBeenCalledWith("restart_daemon");
  });

  it("disables every repair button while one is busy, and shows Working… on the busy one", () => {
    mount(baseDiagnosis({ sleep_masked: false, reboot_safe: false, installed_as: "user" }), () => {}, "enable_linger");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(buttons.some((b) => b.textContent?.includes("Working…"))).toBe(true);
  });

  it("shows nothing to repair for a fully healthy diagnosis", () => {
    mount(baseDiagnosis());
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

// `ServerStatusPanel` itself: the `machine_diagnose` fetch (mount + Refresh) and the
// repair-sudo prompt's own dismiss path — everything `DiagnosisSummary` above doesn't
// own.
function baseMachine(over: Partial<Machine> = {}): Machine {
  return { id: "m1", label: "box", host: "box.example.com", port: 22, user: "deploy", addedAt: 0, addresses: [], ...over };
}

const NEUTRAL_LABEL: ProvisionStatusLabel = { text: "not checked yet", canRetry: false, isProblem: false };

function mountPanel(machine: Machine = baseMachine(), onRemove: () => void = () => {}) {
  act(() => {
    root.render(
      createElement(ServerStatusPanel, {
        machine,
        provisionLabel: NEUTRAL_LABEL,
        revokeLabel: null,
        isRetrying: false,
        onRetryProvisioning: () => {},
        onNewConversation: () => {},
        onRemove,
      }),
    );
  });
}

function clickButtonWithText(text: string) {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`no button with text "${text}" — saw: ${Array.from(container.querySelectorAll("button")).map((b) => b.textContent)}`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** The innermost `<div>` containing `text` — every ancestor of the real element also
 *  matches a plain `textContent.includes` check (it's a substring of theirs too), and
 *  `querySelectorAll` returns them in document (pre-)order, ancestors before
 *  descendants, so the LAST match is the actual, most specific element. */
function mostSpecificDivWithText(text: string): HTMLElement | undefined {
  const matches = Array.from(container.querySelectorAll("div")).filter((d) => d.textContent?.includes(text));
  return matches[matches.length - 1];
}

describe("ServerStatusPanel — fetching machine_diagnose", () => {
  it("shows the status chip once — next to the server's name, not a second copy above the facts", async () => {
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    mountPanel();
    await settle();
    expect(container.querySelectorAll("[data-tone]")).toHaveLength(1);
    expect(container.textContent?.match(/Ready/g) ?? []).toHaveLength(1);
  });

  it("a failed initial diagnose is surfaced with the error and a working Retry, never a blank card", async () => {
    machineDiagnose.mockResolvedValueOnce({ status: "error", error: "ssh timed out" });
    mountPanel();
    await settle();

    expect(container.textContent).toContain("ssh timed out");
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    clickButtonWithText("Retry");
    await settle();

    expect(container.textContent).toContain("Ready");
    expect(container.textContent).not.toContain("ssh timed out");
  });

  it("a rejected machine_diagnose promise is treated the same as a returned error, not left silent", async () => {
    machineDiagnose.mockRejectedValueOnce(new Error("network unreachable"));
    mountPanel();
    await settle();

    expect(container.textContent).toContain("network unreachable");
  });

  it("a failed Refresh keeps the last-known diagnosis on screen but surfaces the failure", async () => {
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    mountPanel();
    await settle();
    expect(container.textContent).toContain("Ready");

    machineDiagnose.mockResolvedValueOnce({ status: "error", error: "connection reset" });
    const refreshBtn = container.querySelector('button[title="Refresh this server\'s status"]') as HTMLButtonElement;
    act(() => refreshBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    // The stale-but-last-known diagnosis is still shown…
    expect(container.textContent).toContain("Ready");
    // …with the failure surfaced rather than silently reverting with no indication.
    expect(container.textContent).toContain("connection reset");
  });
});

describe("ServerStatusPanel — repair sudo-password prompt", () => {
  it("Cancel clears the prompt and the typed password, without submitting it", async () => {
    machineDiagnose.mockResolvedValueOnce({
      status: "ok",
      data: baseDiagnosis({ sleep_masked: false }),
    });
    mountPanel();
    await settle();

    machineRepair.mockResolvedValueOnce({ status: "error", error: "needs a sudo password to continue" });
    const maskSleepBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Mask sleep / suspend"))!;
    act(() => maskSleepBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    const sudoInput = container.querySelector('input[placeholder="Sudo password"]') as HTMLInputElement;
    expect(sudoInput).not.toBeNull();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      nativeSetter.call(sudoInput, "hunter2");
      sudoInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    clickButtonWithText("Cancel");
    await settle();

    expect(container.querySelector('input[placeholder="Sudo password"]')).toBeNull();
    // Never submitted with the typed password.
    expect(machineRepair).toHaveBeenCalledTimes(1);
  });

  // Review finding: `isServerBusyError` was defined and unit-tested in
  // `serverBootstrapModel.ts` but never actually called from either UI component, so a
  // `ServerLocks` collision (e.g. the "+ Add a server" wizard already running against
  // this same host) only ever rendered as a raw, indistinguishable red error here too.
  it("gives a server_busy_error repair collision a distinct, non-error treatment", async () => {
    machineDiagnose.mockResolvedValueOnce({
      status: "ok",
      data: baseDiagnosis({ sleep_masked: false }),
    });
    mountPanel();
    await settle();

    machineRepair.mockResolvedValueOnce({
      status: "error",
      error: 'Another operation ("Add a server") is already running on this server. Wait for it to finish, then try again.',
    });
    const maskSleepBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Mask sleep / suspend"))!;
    act(() => maskSleepBtn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    const busyBox = mostSpecificDivWithText("is already running on this server");
    expect(busyBox).toBeTruthy();
    expect(busyBox?.className).toBe(sharedStyles.hintWarn);
    expect(busyBox?.className).not.toBe(sharedStyles.errorMsg);
  });
});

// B_lifecycle-#0: the Remove button used to have no isActivelyRunning gate at all,
// unlike ConductorSidebar/StreamCard's conversation delete. These lock in the confirm
// gate: friction-free when the server is idle, a ConfirmDialog naming how many live
// conversations will be stopped otherwise, and onRemove only fires on the explicit
// "Remove anyway" (never on the bare click, never on Cancel).
//
// `ConfirmDialog` portals to `document.body` (not into `container`), so these query/
// click the whole document rather than the mount `container`, mirroring
// DeleteConversationDialog.test.ts's own discipline for the same reason.
function confirmDialog(): HTMLElement | null {
  return document.querySelector('[role="alertdialog"]');
}
function clickDocumentButtonWithText(text: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`no button with text "${text}" anywhere in the document`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("ServerStatusPanel — Remove confirm gate", () => {
  it("nothing running on this server: Remove calls onRemove immediately, no dialog", async () => {
    useMachineActiveConversationIds.mockReturnValue([]);
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    const onRemove = vi.fn();
    mountPanel(baseMachine(), onRemove);
    await settle();

    clickButtonWithText("Remove");
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(confirmDialog()).toBeNull();
  });

  it("one live conversation on this server: Remove asks first and does not call onRemove yet", async () => {
    useMachineActiveConversationIds.mockReturnValue(["c1"]);
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    const onRemove = vi.fn();
    mountPanel(baseMachine({ label: "prod box" }), onRemove);
    await settle();

    clickButtonWithText("Remove");
    expect(onRemove).not.toHaveBeenCalled();
    const dlg = confirmDialog();
    expect(dlg).not.toBeNull();
    expect(dlg!.textContent).toContain('Remove "prod box"?');
    expect(dlg!.textContent).toContain("1 conversation on this server is actively running");
  });

  it("names how many conversations will be stopped when more than one is running", async () => {
    useMachineActiveConversationIds.mockReturnValue(["c1", "c2", "c3"]);
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    mountPanel();
    await settle();

    clickButtonWithText("Remove");
    expect(confirmDialog()!.textContent).toContain(
      "3 conversations on this server are actively running",
    );
  });

  it("Cancel closes the confirm without ever calling onRemove", async () => {
    useMachineActiveConversationIds.mockReturnValue(["c1"]);
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    const onRemove = vi.fn();
    mountPanel(baseMachine(), onRemove);
    await settle();

    clickButtonWithText("Remove");
    clickDocumentButtonWithText("Cancel");
    expect(onRemove).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
  });

  it('"Remove anyway" confirms — onRemove fires exactly once', async () => {
    useMachineActiveConversationIds.mockReturnValue(["c1"]);
    machineDiagnose.mockResolvedValueOnce({ status: "ok", data: baseDiagnosis() });
    const onRemove = vi.fn();
    mountPanel(baseMachine(), onRemove);
    await settle();

    clickButtonWithText("Remove");
    clickDocumentButtonWithText("Remove anyway");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// B-finding #4: this card must never offer a SECOND "Sign in to Claude" button while
// another surface (e.g. the bootstrap wizard's own inline step) already has one live
// for the same machine — `claudeLoginSessions.ts`'s shared `active` flag is what lets
// it know that before the user ever clicks anything here.
describe("ServerStatusPanel — Claude sign-in single-flight (B-finding #4)", () => {
  it("shows the Sign in to Claude button when nothing else has a session for this machine", async () => {
    machineDiagnose.mockResolvedValueOnce({
      status: "ok",
      data: baseDiagnosis({ claude_installed: true, claude_logged_in: false, claude_email: null, state: { kind: "needs_claude_sign_in" } }),
    });
    mountPanel();
    await settle();

    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Sign in to Claude"))).toBe(true);
    expect(container.textContent).not.toContain("Sign-in in progress");
  });

  it("shows 'Sign-in in progress…' instead of its own button while another surface's session is live for this machine", async () => {
    machineDiagnose.mockResolvedValueOnce({
      status: "ok",
      data: baseDiagnosis({ claude_installed: true, claude_logged_in: false, claude_email: null, state: { kind: "needs_claude_sign_in" } }),
    });
    // Simulates the wizard's OWN ClaudeSignInInline already having started a session
    // for this exact machine — never anything this panel itself triggered.
    useClaudeLoginSessions.getState().setActive("m1", true);
    mountPanel();
    await settle();

    expect(container.textContent).toContain("Sign-in in progress…");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Sign in to Claude"))).toBe(false);
  });

  it("flips back to offering its own button once the other surface's session resolves", async () => {
    machineDiagnose.mockResolvedValueOnce({
      status: "ok",
      data: baseDiagnosis({ claude_installed: true, claude_logged_in: false, claude_email: null, state: { kind: "needs_claude_sign_in" } }),
    });
    useClaudeLoginSessions.getState().setActive("m1", true);
    mountPanel();
    await settle();
    expect(container.textContent).toContain("Sign-in in progress…");

    act(() => useClaudeLoginSessions.getState().setActive("m1", false));
    await settle();

    expect(container.textContent).not.toContain("Sign-in in progress");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Sign in to Claude"))).toBe(true);
  });
});
