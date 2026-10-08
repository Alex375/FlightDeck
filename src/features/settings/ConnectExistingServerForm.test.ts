// "Connect an existing server": the form hands the typed coordinates to `add_machine`
// (this Mac's own SSH keys by default, or Flight Deck's dedicated key once authorized),
// shows every failure verbatim, and offers "forget the old key" only for a changed
// host key. Same createElement + react-dom/client harness as ServerBootstrapWizard.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMachine: vi.fn(),
  generateMachineKey: vi.fn(),
  bootstrapForgetHostKey: vi.fn(),
}));

vi.mock("../../ipc/client", () => ({
  commands: {
    addMachine: mocks.addMachine,
    generateMachineKey: mocks.generateMachineKey,
    bootstrapForgetHostKey: mocks.bootstrapForgetHostKey,
  },
  events: {},
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectExistingServerForm } from "./ConnectExistingServerForm";
import { useConversationsStore, type Machine } from "../../store/conversationsStore";
import sharedStyles from "./SettingsPanel.module.css";

let container: HTMLDivElement;
let root: Root;
let onConnected: ReturnType<typeof vi.fn<(machine: Machine, matchedExisting: boolean) => void>>;

const machineRecord = {
  id: "m1",
  label: "Target",
  host: "100.71.28.97",
  port: 22,
  user: "admin",
  identity_file: null,
  added_at: 1,
  addresses: [],
};

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
function fill(placeholder: string, value: string) {
  const input = container.querySelector(`input[placeholder*="${placeholder}"]`) as HTMLInputElement | null;
  if (!input) throw new Error(`no input matching placeholder "${placeholder}"`);
  act(() => {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text));
  if (!btn) throw new Error(`no button "${text}" — saw: ${Array.from(container.querySelectorAll("button")).map((b) => b.textContent)}`);
  return btn;
}

function click(text: string) {
  const btn = button(text);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function mount() {
  act(() => {
    root.render(createElement(ConnectExistingServerForm, { onClose: () => {}, onConnected }));
  });
}

function fillTarget() {
  fill("Name", "Target");
  fill("Address", "100.71.28.97");
  fill("User", "admin");
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.addMachine.mockReset();
  mocks.generateMachineKey.mockReset();
  mocks.bootstrapForgetHostKey.mockReset();
  onConnected = vi.fn<(machine: Machine, matchedExisting: boolean) => void>();
  useConversationsStore.setState({ machines: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectExistingServerForm", () => {
  it("connects with this Mac's own SSH keys by default — no key minted, identity null", async () => {
    mocks.addMachine.mockResolvedValue({ status: "ok", data: { machine: machineRecord, matched_existing: false } });
    mount();
    expect(button("Connect").disabled).toBe(true);
    fillTarget();
    click("Connect");
    await settle();

    expect(mocks.generateMachineKey).not.toHaveBeenCalled();
    expect(mocks.addMachine).toHaveBeenCalledWith("Target", "100.71.28.97", 22, "admin", null, null);
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", label: "Target" }), false);
    expect(useConversationsStore.getState().machines.map((m) => m.id)).toEqual(["m1"]);
  });

  it("shows the probe's failure exactly as the backend words it, and stays open", async () => {
    const msg =
      "Could not pair — every address failed. 100.71.28.97: Connected over SSH, but pairing can't proceed: flightdeckd is not installed";
    mocks.addMachine.mockResolvedValue({ status: "error", error: msg });
    mount();
    fillTarget();
    click("Connect");
    await settle();

    expect(container.querySelector(`.${sharedStyles.errorMsg}`)?.textContent).toBe(msg);
    expect(onConnected).not.toHaveBeenCalled();
    expect(button("Connect").disabled).toBe(false);
    // Not a host-key problem: no "forget" offer.
    expect(container.textContent).not.toContain("Forget the old key");
  });

  it("with a dedicated key: mints it, shows the one-line authorize command, connects with it", async () => {
    mocks.generateMachineKey.mockResolvedValue({
      status: "ok",
      data: { identity_file: "/data/ssh_keys/pending", public_key: "ssh-ed25519 AAAAkey flightdeck-target" },
    });
    mocks.addMachine.mockResolvedValue({ status: "ok", data: { machine: machineRecord, matched_existing: true } });
    mount();
    fillTarget();
    click("A key for Flight Deck");
    await settle();

    const command = container.querySelector("pre")?.textContent ?? "";
    expect(command).toContain('"ssh-ed25519 AAAAkey flightdeck-target" >> ~/.ssh/authorized_keys');
    expect(command).not.toContain("\n");
    click("Connect");
    await settle();

    expect(mocks.addMachine).toHaveBeenCalledWith("Target", "100.71.28.97", 22, "admin", "/data/ssh_keys/pending", null);
    expect(onConnected).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("a key that can't be made is said, and Connect stays off until there is one", async () => {
    mocks.generateMachineKey.mockResolvedValue({ status: "error", error: "ssh-keygen not found" });
    mount();
    fillTarget();
    click("A key for Flight Deck");
    await settle();

    expect(container.textContent).toContain("ssh-keygen not found");
    expect(button("Connect").disabled).toBe(true);
  });

  it("a changed host key offers to forget it, then retries the same connection", async () => {
    mocks.addMachine
      .mockResolvedValueOnce({
        status: "error",
        error: "Could not pair — every address failed. 100.71.28.97: Could not connect over SSH: Host key verification failed.",
      })
      .mockResolvedValueOnce({ status: "ok", data: { machine: machineRecord, matched_existing: false } });
    mocks.bootstrapForgetHostKey.mockResolvedValue({ status: "ok", data: null });
    mount();
    fillTarget();
    click("Connect");
    await settle();
    click("Forget the old key and retry");
    await settle();

    expect(mocks.bootstrapForgetHostKey).toHaveBeenCalledWith("100.71.28.97", 22);
    expect(mocks.addMachine).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("refuses an ssh-option-shaped user before any round trip", () => {
    mount();
    fill("Address", "100.71.28.97");
    fill("User", "-oProxyCommand=evil");
    expect(container.querySelector(`.${sharedStyles.errorMsg}`)).not.toBeNull();
    expect(button("Connect").disabled).toBe(true);
  });
});
