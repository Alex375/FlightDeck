// `DiagnosisSummary` renders the right headline + repair action for a CANNED
// diagnosis, one per headline state — no IPC mocking needed, it's a pure(ish)
// presentational component (`ServerStatusPanel` itself owns the fetching).
//
// Built with createElement in a `*.test.ts` file + react-dom/client, same discipline
// as the wizard's own test file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiagnosisSummary } from "./ServerStatusPanel";
import type { RepairAction, ServerDiagnosis } from "../../ipc/client";

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
    claude_installed: true,
    claude_logged_in: true,
    claude_email: "demo@example.com",
    tailscale_name: "box.tail1234.ts.net",
    last_boot: "2026-09-15 08:00:00",
    busy_conversations: 0,
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DiagnosisSummary — the 4 headline states", () => {
  it("Ready — green headline, no repair buttons for a fully healthy server", () => {
    mount(baseDiagnosis());
    expect(container.textContent).toContain("Ready");
    expect(container.querySelector('[data-tone="ready"]')).not.toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("Needs Claude sign-in — amber headline (its own repair lives outside repairSuggestionsFor)", () => {
    mount(baseDiagnosis({ claude_installed: false, claude_logged_in: null, claude_email: null, state: { kind: "needs_claude_sign_in" } }));
    expect(container.textContent).toContain("Needs Claude sign-in");
    expect(container.querySelector('[data-tone="attention"]')).not.toBeNull();
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
      claude_installed: null,
      claude_logged_in: null,
      claude_email: null,
      tailscale_name: null,
      last_boot: null,
      busy_conversations: null,
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
