// What a paired phone can still reach once this Mac lets go of something (security
// review 2026-10-09): the M10 removal warning and the M11 remote-access-off notice —
// their pure wording, and both cards actually showing them with a working
// "Regenerate pairing". Same createElement + react-dom/client harness as
// ServerBootstrapWizard.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setRemote: vi.fn(),
  remoteStatus: vi.fn(),
  listRemoteDevices: vi.fn(),
  deleteMachine: vi.fn(),
  setActiveConversation: vi.fn(),
  phoneProvisioningStatus: vi.fn(),
  phoneRevocationStatus: vi.fn(),
}));

vi.mock("../../ipc/client", () => ({
  commands: {
    setRemote: mocks.setRemote,
    remoteStatus: mocks.remoteStatus,
    listRemoteDevices: mocks.listRemoteDevices,
    deleteMachine: mocks.deleteMachine,
    setActiveConversation: mocks.setActiveConversation,
    phoneProvisioningStatus: mocks.phoneProvisioningStatus,
    phoneRevocationStatus: mocks.phoneRevocationStatus,
  },
  events: {},
}));

// The server card itself (live diagnosis, repairs) is not what these tests are about:
// a stand-in with just its Remove button.
vi.mock("./ServerStatusPanel", async () => {
  const { createElement } = await import("react");
  return {
    ServerStatusPanel: ({ machine, onRemove }: { machine: { label: string }; onRemove: () => void }) =>
      createElement("button", { onClick: onRemove }, `Remove ${machine.label}`),
  };
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RemoteAccessGroup, RemoteServersGroup } from "./ControlSection";
import { PAIRING_REGENERATED, regeneratePhonePairing, remoteOffNotice, removalPhoneWarning } from "./phoneAccess";
import { useConversationsStore, type Machine } from "../../store/conversationsStore";

const REMOTE_ON = {
  enabled: true,
  connected: true,
  relay_url: "wss://relay.example",
  mac_id: "mac",
  mac_label: "MacBook",
  phone_token: "tok",
  pairing_url: "https://relay.example/#x",
  pairing_qr_svg: null,
  error: null,
  legacy_active: true,
};

function machine(id: string, label: string): Machine {
  return { id, label, host: `${id}.example`, port: 22, user: "u", addedAt: 1, addresses: [], phoneProvisionedAt: 1 };
}

let container: HTMLDivElement;
let root: Root;

function button(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text));
  if (!btn) throw new Error(`no button "${text}" — saw: ${Array.from(container.querySelectorAll("button")).map((b) => b.textContent)}`);
  return btn;
}

function click(el: HTMLElement) {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.remoteStatus.mockResolvedValue(REMOTE_ON);
  mocks.listRemoteDevices.mockResolvedValue({ status: "ok", data: { devices: [], pending_removals: [], legacy_revocations_owed: [], sync_error: null } });
  mocks.setActiveConversation.mockResolvedValue({ status: "ok", data: null });
  mocks.phoneProvisioningStatus.mockResolvedValue([]);
  mocks.phoneRevocationStatus.mockResolvedValue([]);
  useConversationsStore.setState({ machines: [], repos: [], conversations: [], activeId: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("removalPhoneWarning (M10)", () => {
  it("is silent when the pairing was withdrawn, or never there", () => {
    expect(removalPhoneWarning("vps", { phone_revoke: { kind: "removed" }, retry_pending: false, devices_unconfirmed: 0 })).toBeNull();
    expect(removalPhoneWarning("vps", { phone_revoke: null, retry_pending: false, devices_unconfirmed: 0 })).toBeNull();
    // Only an OLDER pairing left behind: already useless anywhere else, retried quietly.
    expect(removalPhoneWarning("vps", { phone_revoke: null, retry_pending: true, devices_unconfirmed: 0 })).toBeNull();
    expect(removalPhoneWarning("vps", null)).toBeNull();
  });

  it("says why, what the server can still do with it, and what regenerating does", () => {
    const queued = removalPhoneWarning("vps", { phone_revoke: { kind: "queued" }, retry_pending: true, devices_unconfirmed: 0 })!;
    expect(queued).toContain("“vps” was removed");
    expect(queued).toContain("it couldn't be reached");
    expect(queued).toContain("reach this Mac and your other servers");
    expect(queued).toContain("regenerating the pairing");
    expect(removalPhoneWarning("vps", { phone_revoke: { kind: "daemon_too_old" }, retry_pending: true, devices_unconfirmed: 0 })).toContain(
      "too old",
    );
    expect(
      removalPhoneWarning("vps", { phone_revoke: { kind: "failed", reason: "disk full" }, retry_pending: true, devices_unconfirmed: 0 }),
    ).toContain("it refused: disk full");
  });

  it("warns about encrypted phones the removed server hasn't confirmed forgetting", () => {
    const only = removalPhoneWarning("vps", { phone_revoke: null, retry_pending: true, devices_unconfirmed: 2 })!;
    expect(only).toContain("“vps” was removed.");
    expect(only).toContain("2 encrypted phones");
    expect(only).toContain("keeps trying on its own");
    const both = removalPhoneWarning("vps", { phone_revoke: { kind: "queued" }, retry_pending: true, devices_unconfirmed: 1 })!;
    expect(both).toContain("an encrypted phone");
    expect(both).toContain("regenerating the pairing");
  });
});

describe("remoteOffNotice (M11)", () => {
  it("says nothing without a paired server, and names what keeps answering otherwise", () => {
    expect(remoteOffNotice(0, true)).toBeNull();
    expect(remoteOffNotice(1, false)).toContain("Your paired server keeps its own connection");
    expect(remoteOffNotice(3, false)).toContain("Your 3 paired servers keep their own connection");
    expect(remoteOffNotice(1, false)).toContain("off for this Mac only");
    expect(remoteOffNotice(1, false)).toContain("revoke that phone in the Phones list");
    expect(remoteOffNotice(1, false)).not.toContain("legacy");
    expect(remoteOffNotice(1, true)).toContain("regenerating that pairing");
  });
});

describe("regeneratePhonePairing", () => {
  it("is set_remote's regenerate, changing nothing else", async () => {
    mocks.setRemote.mockResolvedValue({ status: "ok", data: REMOTE_ON });
    expect(await regeneratePhonePairing()).toEqual({ ok: true });
    expect(mocks.setRemote).toHaveBeenCalledWith(null, null, true, null);
    mocks.setRemote.mockResolvedValue({ status: "error", error: "store locked" });
    expect(await regeneratePhonePairing()).toEqual({ ok: false, error: "store locked" });
  });
});

describe("Remote servers card — removing a server (M10)", () => {
  it("warns when the server kept the pairing, and Regenerate pairing goes through", async () => {
    useConversationsStore.setState({ machines: [machine("m1", "vps")] });
    mocks.deleteMachine.mockResolvedValue({ status: "ok", data: { phone_revoke: { kind: "queued" }, retry_pending: true, devices_unconfirmed: 0 } });
    mocks.setRemote.mockResolvedValue({ status: "ok", data: REMOTE_ON });
    act(() => root.render(createElement(RemoteServersGroup)));
    await settle();

    click(button("Remove vps"));
    await settle();
    expect(mocks.deleteMachine).toHaveBeenCalledWith("m1");
    expect(container.textContent).toContain("“vps” was removed, but its phone access couldn't be withdrawn");

    click(button("Regenerate pairing"));
    await settle();
    expect(mocks.setRemote).toHaveBeenCalledWith(null, null, true, null);
    expect(container.textContent).not.toContain("couldn't be withdrawn");
    expect(container.textContent).toContain(PAIRING_REGENERATED);
  });

  it("says nothing when the server confirmed it dropped the pairing", async () => {
    useConversationsStore.setState({ machines: [machine("m1", "vps")] });
    mocks.deleteMachine.mockResolvedValue({ status: "ok", data: { phone_revoke: { kind: "removed" }, retry_pending: false, devices_unconfirmed: 0 } });
    act(() => root.render(createElement(RemoteServersGroup)));
    await settle();

    click(button("Remove vps"));
    await settle();
    expect(container.textContent).not.toContain("couldn't be withdrawn");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Regenerate pairing")).toBe(
      false,
    );
  });
});

describe("Remote access card — turning it off (M11)", () => {
  function toggle(): HTMLButtonElement {
    const t = container.querySelector('[role="switch"][aria-label="Reach your agents from your phone"]');
    if (!t) throw new Error("no remote access switch");
    return t as HTMLButtonElement;
  }

  it("says the switch disconnects this Mac only", async () => {
    act(() => root.render(createElement(RemoteAccessGroup)));
    await settle();
    expect(container.textContent).toContain("Turning it off disconnects this Mac only");
  });

  it("with servers paired and the legacy pairing in use: offers to regenerate it once off — never on its own", async () => {
    useConversationsStore.setState({ machines: [machine("m1", "vps"), machine("m2", "box")] });
    mocks.setRemote.mockResolvedValue({ status: "ok", data: { ...REMOTE_ON, enabled: false, connected: false } });
    act(() => root.render(createElement(RemoteAccessGroup)));
    await settle();

    click(toggle());
    await settle();
    expect(mocks.setRemote).toHaveBeenCalledTimes(1);
    expect(mocks.setRemote).toHaveBeenCalledWith(false, null, false, null);
    expect(container.textContent).toContain("Your 2 paired servers keep their own connection");

    expect(container.textContent).toContain("revoke that phone in the Phones list");
    click(button("Regenerate legacy pairing"));
    await settle();
    expect(mocks.setRemote).toHaveBeenLastCalledWith(null, null, true, null);
    expect(container.textContent).toContain(PAIRING_REGENERATED);
  });

  it("with the legacy pairing retired: points at revoking the phone, nothing to regenerate", async () => {
    useConversationsStore.setState({ machines: [machine("m1", "vps")] });
    const off = { ...REMOTE_ON, enabled: false, connected: false, legacy_active: false, pairing_url: null };
    mocks.setRemote.mockResolvedValue({ status: "ok", data: off });
    act(() => root.render(createElement(RemoteAccessGroup)));
    await settle();
    click(toggle());
    await settle();
    expect(container.textContent).toContain("revoke that phone in the Phones list");
    expect(container.textContent).not.toContain("legacy pairing");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.startsWith("Regenerate"))).toBe(false);
  });

  it("without a paired server: no notice", async () => {
    mocks.setRemote.mockResolvedValue({ status: "ok", data: { ...REMOTE_ON, enabled: false, connected: false } });
    act(() => root.render(createElement(RemoteAccessGroup)));
    await settle();
    click(toggle());
    await settle();
    expect(container.textContent).not.toContain("off for this Mac only");
  });
});
