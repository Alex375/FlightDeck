// "Connect an existing server": the form hands the typed coordinates to `add_machine`
// (this Mac's own SSH keys by default, or Flight Deck's dedicated key once authorized),
// shows every failure verbatim, and offers "forget the old key" only for a changed
// host key. Same createElement + react-dom/client harness as ServerBootstrapWizard.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMachine: vi.fn(),
  generateMachineKey: vi.fn(),
  generateConnectKey: vi.fn(),
  bootstrapForgetHostKey: vi.fn(),
}));

vi.mock("../../ipc/client", () => ({
  commands: {
    addMachine: mocks.addMachine,
    generateMachineKey: mocks.generateMachineKey,
    generateConnectKey: mocks.generateConnectKey,
    bootstrapForgetHostKey: mocks.bootstrapForgetHostKey,
  },
  events: {},
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ConnectExistingServerForm,
  connectedNotice,
  lateConnectFailure,
  lateConnectProblem,
  type ConnectOutcome,
} from "./ConnectExistingServerForm";
import { useAppErrors } from "../../store/appErrors";
import { useConversationsStore, type Machine } from "../../store/conversationsStore";
import sharedStyles from "./SettingsPanel.module.css";

let container: HTMLDivElement;
let root: Root;
let onConnected: ReturnType<typeof vi.fn<(machine: Machine, outcome: ConnectOutcome) => void>>;

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

function saved(
  over: {
    matched_existing?: boolean;
    previous_key_dropped?: boolean;
    machine?: Omit<typeof machineRecord, "identity_file"> & { identity_file: string | null };
  } = {},
) {
  return {
    status: "ok",
    data: {
      machine: over.machine ?? machineRecord,
      matched_existing: over.matched_existing ?? false,
      previous_key_dropped: over.previous_key_dropped ?? false,
    },
  };
}

const HOST_KEY_FAILURE = {
  status: "error",
  error: "Could not pair — every address failed. 100.71.28.97: Could not connect over SSH: Host key verification failed.",
};

/** A promise the test settles by hand — to hold a round trip open across a Cancel, an
 *  unmount or an edit. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
  mocks.generateConnectKey.mockReset();
  mocks.bootstrapForgetHostKey.mockReset();
  onConnected = vi.fn<(machine: Machine, outcome: ConnectOutcome) => void>();
  useConversationsStore.setState({ machines: [] });
  useAppErrors.setState({ errors: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectExistingServerForm", () => {
  it("connects with this Mac's own SSH keys by default — no key minted, identity null", async () => {
    mocks.addMachine.mockResolvedValue(saved());
    mount();
    expect(button("Connect").disabled).toBe(true);
    fillTarget();
    click("Connect");
    await settle();

    expect(mocks.generateConnectKey).not.toHaveBeenCalled();
    expect(mocks.generateMachineKey).not.toHaveBeenCalled();
    expect(mocks.addMachine).toHaveBeenCalledWith("Target", "100.71.28.97", 22, "admin", null, null);
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", label: "Target" }), {
      matchedExisting: false,
      previousKeyDropped: false,
      keptFlightDeckKey: false,
    });
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

  it("with a dedicated key: mints it in the form's own slot, shows the one-line authorize command, connects with it", async () => {
    mocks.generateConnectKey.mockResolvedValue({
      status: "ok",
      data: { identity_file: "/data/ssh_keys/pending-connect", public_key: "ssh-ed25519 AAAAkey flightdeck-target" },
    });
    mocks.addMachine.mockResolvedValue(saved({ matched_existing: true }));
    mount();
    fillTarget();
    click("A key for Flight Deck");
    await settle();

    // Never the wizard's shared pending key: a wizard run still holding it would be
    // handed the same file.
    expect(mocks.generateConnectKey).toHaveBeenCalledTimes(1);
    expect(mocks.generateMachineKey).not.toHaveBeenCalled();
    const command = container.querySelector("pre")?.textContent ?? "";
    expect(command).toContain('"ssh-ed25519 AAAAkey flightdeck-target" >> ~/.ssh/authorized_keys');
    expect(command).not.toContain("\n");
    click("Connect");
    await settle();

    expect(mocks.addMachine).toHaveBeenCalledWith("Target", "100.71.28.97", 22, "admin", "/data/ssh_keys/pending-connect", null);
    expect(onConnected).toHaveBeenCalledWith(expect.anything(), {
      matchedExisting: true,
      previousKeyDropped: false,
      keptFlightDeckKey: false,
    });
  });

  it("a key that can't be made is said, and Connect stays off until there is one", async () => {
    mocks.generateConnectKey.mockResolvedValue({ status: "error", error: "ssh-keygen not found" });
    mount();
    fillTarget();
    click("A key for Flight Deck");
    await settle();

    expect(container.textContent).toContain("ssh-keygen not found");
    expect(button("Connect").disabled).toBe(true);
  });

  it("a blank Name is sent blank — the backend keeps a listed server's name or names it after its address", async () => {
    mocks.addMachine.mockResolvedValue(saved({ matched_existing: true, machine: { ...machineRecord, label: "Studio Mac" } }));
    mount();
    fill("Address", "100.71.28.97");
    fill("User", "admin");
    click("Connect");
    await settle();

    expect(mocks.addMachine).toHaveBeenCalledWith("", "100.71.28.97", 22, "admin", null, null);
    // The name shown afterwards is the one the backend saved.
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ label: "Studio Mac" }), expect.anything());
  });

  it("reports a dropped Flight Deck key through onConnected", async () => {
    mocks.addMachine.mockResolvedValue(saved({ matched_existing: true, previous_key_dropped: true }));
    mount();
    fillTarget();
    click("Connect");
    await settle();

    expect(onConnected).toHaveBeenCalledWith(expect.anything(), {
      matchedExisting: true,
      previousKeyDropped: true,
      keptFlightDeckKey: false,
    });
  });

  // Regression: a listed server reconnected with "This Mac's SSH keys" keeps its Flight
  // Deck key while that key works — and that went unsaid, so the user took the switch
  // as done and removed the key the server still logs in with.
  it("reports that a listed server kept its Flight Deck key when this Mac's keys were chosen", async () => {
    mocks.addMachine.mockResolvedValue(
      saved({ matched_existing: true, machine: { ...machineRecord, identity_file: "/data/ssh_keys/m1" } }),
    );
    mount();
    fillTarget();
    click("Connect");
    await settle();

    expect(mocks.addMachine).toHaveBeenCalledWith("Target", "100.71.28.97", 22, "admin", null, null);
    expect(onConnected).toHaveBeenCalledWith(expect.anything(), {
      matchedExisting: true,
      previousKeyDropped: false,
      keptFlightDeckKey: true,
    });
  });

  it("a changed host key offers to forget it, then retries the same connection", async () => {
    mocks.addMachine.mockResolvedValueOnce(HOST_KEY_FAILURE).mockResolvedValueOnce(saved());
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

  it("editing the Address or Port withdraws the forget offer and its error", async () => {
    mocks.addMachine.mockResolvedValue(HOST_KEY_FAILURE);
    mount();
    fillTarget();
    click("Connect");
    await settle();
    expect(container.textContent).toContain("Forget the old key");

    fill("Address", "100.71.28.98");
    expect(container.textContent).not.toContain("Forget the old key");
    expect(container.textContent).not.toContain("Host key verification failed");

    fill("Address", "100.71.28.97");
    click("Connect");
    await settle();
    expect(container.textContent).toContain("Forget the old key");
    fill("Port", "2222");
    expect(container.textContent).not.toContain("Forget the old key");
    expect(mocks.bootstrapForgetHostKey).not.toHaveBeenCalled();
  });

  it("forgets and retries the host that was refused, even when the Address changes during the round trip", async () => {
    const forget = deferred<{ status: "ok"; data: null }>();
    mocks.addMachine.mockResolvedValueOnce(HOST_KEY_FAILURE).mockResolvedValueOnce(saved());
    mocks.bootstrapForgetHostKey.mockReturnValue(forget.promise);
    mount();
    fillTarget();
    click("Connect");
    await settle();
    click("Forget the old key and retry");
    // Connect stays off for the whole round trip, not just the add_machine half.
    expect(button("Checking the server").disabled).toBe(true);

    fill("Address", "other.example");
    forget.resolve({ status: "ok", data: null });
    await settle();

    expect(mocks.bootstrapForgetHostKey).toHaveBeenCalledWith("100.71.28.97", 22);
    expect(mocks.addMachine).toHaveBeenLastCalledWith("Target", "100.71.28.97", 22, "admin", null, null);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("shows the backend's 'no saved host key' answer verbatim, and does not retry", async () => {
    const msg = "no saved host key for 100.71.28.97 in Flight Deck's known hosts";
    mocks.addMachine.mockResolvedValue(HOST_KEY_FAILURE);
    mocks.bootstrapForgetHostKey.mockResolvedValue({ status: "error", error: msg });
    mount();
    fillTarget();
    click("Connect");
    await settle();
    click("Forget the old key and retry");
    await settle();

    expect(container.querySelector(`.${sharedStyles.errorMsg}`)?.textContent).toBe(msg);
    expect(container.textContent).not.toContain("Forget the old key");
    expect(mocks.addMachine).toHaveBeenCalledTimes(1);
    expect(button("Connect").disabled).toBe(false);
  });

  it("an attempt that answers after Cancel never reports — a newer attempt does", async () => {
    const late = deferred<ReturnType<typeof saved>>();
    mocks.addMachine.mockReturnValueOnce(late.promise).mockResolvedValueOnce(saved({ matched_existing: true }));
    mount();
    fillTarget();
    click("Connect");
    expect(button("Checking the server").disabled).toBe(true);
    click("Cancel");
    // The parent normally unmounts the form here; this one stays, so a new attempt runs.
    click("Connect");
    await settle();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenLastCalledWith(expect.anything(), {
      matchedExisting: true,
      previousKeyDropped: false,
      keptFlightDeckKey: false,
    });

    late.resolve(saved());
    await settle();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("an attempt that answers after the form is gone never reports", async () => {
    const late = deferred<ReturnType<typeof saved>>();
    mocks.addMachine.mockReturnValue(late.promise);
    mount();
    fillTarget();
    click("Connect");
    act(() => root.unmount());

    late.resolve(saved());
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    expect(useAppErrors.getState().errors).toEqual([]);
  });

  // Regression: a late save is still a save — when it cost the server Flight Deck's key
  // (it fell back to this Mac's keys), dropping the answer left that loss unsaid.
  it("a late save after Cancel that lost Flight Deck's key is still said, on the app banner", async () => {
    const late = deferred<ReturnType<typeof saved>>();
    mocks.addMachine.mockReturnValue(late.promise);
    mount();
    fillTarget();
    click("Connect");
    click("Cancel");

    late.resolve(saved({ matched_existing: true, previous_key_dropped: true }));
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    const banner = useAppErrors.getState().errors.map((e) => e.message);
    expect(banner).toHaveLength(1);
    expect(banner[0]).toContain("“Target” you cancelled went through anyway");
    expect(banner[0]).toContain("Flight Deck's own key for it no longer worked");
  });

  // Regression: closing Settings (or opening another tab) mid-check is not a Cancel —
  // the banner blamed "the connection you cancelled".
  it("a late save that lost Flight Deck's key is said even once the form is gone — never as a cancel", async () => {
    const late = deferred<ReturnType<typeof saved>>();
    mocks.addMachine.mockReturnValue(late.promise);
    mount();
    fillTarget();
    click("Connect");
    act(() => root.unmount());

    late.resolve(saved({ matched_existing: true, previous_key_dropped: true }));
    await settle();
    expect(onConnected).not.toHaveBeenCalled();
    const banner = useAppErrors.getState().errors.map((e) => e.message);
    expect(banner).toHaveLength(1);
    expect(banner[0]).toContain("Connecting “Target” finished after the form was closed.");
    expect(banner[0]).not.toContain("cancelled");
  });

  // Regression: a failure that landed once the form had closed (without a Cancel) was
  // dropped without a word — coming back, no server and no explanation.
  it("a failure that lands once the form is gone goes to the app banner", async () => {
    const late = deferred<{ status: string; error: string }>();
    mocks.addMachine.mockReturnValue(late.promise);
    mount();
    fillTarget();
    click("Connect");
    act(() => root.unmount());

    late.resolve({ status: "error", error: "Could not pair — every address failed. 100.71.28.97: flightdeckd is outdated" });
    await settle();
    const banner = useAppErrors.getState().errors.map((e) => e.message);
    expect(banner).toEqual([
      "Connecting 100.71.28.97 failed after the “Connect an existing server” form was closed: Could not pair — every address failed. 100.71.28.97: flightdeckd is outdated",
    ]);
  });

  it("a throw that lands once the form is gone goes to the app banner too", async () => {
    let reject!: (e: unknown) => void;
    mocks.addMachine.mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    mount();
    fillTarget();
    click("Connect");
    act(() => root.unmount());

    reject(new Error("IPC channel closed"));
    await settle();
    const banner = useAppErrors.getState().errors.map((e) => e.message);
    expect(banner).toHaveLength(1);
    expect(banner[0]).toContain("Connecting 100.71.28.97 failed after");
    expect(banner[0]).toContain("IPC channel closed");
  });

  it("a failure of an attempt the user cancelled stays unsaid", async () => {
    const late = deferred<{ status: string; error: string }>();
    mocks.addMachine.mockReturnValue(late.promise);
    mount();
    fillTarget();
    click("Connect");
    click("Cancel");
    act(() => root.unmount());

    late.resolve({ status: "error", error: "ssh command timed out" });
    await settle();
    expect(useAppErrors.getState().errors).toEqual([]);
  });

  it("refuses an ssh-option-shaped user before any round trip", () => {
    mount();
    fill("Address", "100.71.28.97");
    fill("User", "-oProxyCommand=evil");
    expect(container.querySelector(`.${sharedStyles.errorMsg}`)).not.toBeNull();
    expect(button("Connect").disabled).toBe(true);
  });
});

describe("connectedNotice", () => {
  const machine = (identityFile: string | null): Machine => ({
    id: "m1",
    label: "Target",
    host: "100.71.28.97",
    port: 22,
    user: "admin",
    identityFile,
    addedAt: 1,
    addresses: [],
  });

  const outcome = (over: Partial<ConnectOutcome> = {}): ConnectOutcome => ({
    matchedExisting: true,
    previousKeyDropped: false,
    keptFlightDeckKey: false,
    ...over,
  });

  it("confirms a new server and an update without any key note", () => {
    expect(connectedNotice(machine(null), outcome({ matchedExisting: false }))).toEqual({
      text: "Connected “Target” — it's listed above.",
      isProblem: false,
    });
    expect(connectedNotice(machine(null), outcome()).text).toBe("Updated the existing server “Target”.");
  });

  it("says a listed server kept its Flight Deck key when this Mac's keys were chosen — not a problem", () => {
    const note = connectedNotice(machine("/data/ssh_keys/m1"), outcome({ keptFlightDeckKey: true }));
    expect(note.isProblem).toBe(false);
    expect(note.text).toBe(
      "Updated the existing server “Target”. It keeps using Flight Deck's own key, which still works for this server — not this Mac's SSH keys.",
    );
  });

  it("says so, as a problem, when Flight Deck's key stopped working and this Mac's keys took over", () => {
    const note = connectedNotice(machine(null), outcome({ previousKeyDropped: true }));
    expect(note.isProblem).toBe(true);
    expect(note.text).toContain("Flight Deck's own key for it no longer worked");
    expect(note.text).toContain("this Mac's SSH keys");
    expect(note.text).toContain("A key for Flight Deck");
  });

  // Regression: it used to say the old key "is deleted the next time Flight Deck
  // starts" — but the new key is usually claimed onto the old one's own file,
  // overwriting it on the spot, and nothing is left for a later launch to delete.
  it("says a new Flight Deck key replaced the old one — not a problem, and no claim about when the old one goes", () => {
    const note = connectedNotice(machine("/data/ssh_keys/m1"), outcome({ previousKeyDropped: true }));
    expect(note.isProblem).toBe(false);
    expect(note.text).toBe("Updated the existing server “Target”. It now uses the new Flight Deck key in place of the old one.");
    expect(note.text).not.toMatch(/deleted|next time|starts/);
  });
});

describe("lateConnectProblem", () => {
  const machine = (identityFile: string | null): Machine => ({
    id: "m1",
    label: "Target",
    host: "100.71.28.97",
    port: 22,
    user: "admin",
    identityFile,
    addedAt: 1,
    addresses: [],
  });

  const outcome = (over: Partial<ConnectOutcome> = {}): ConnectOutcome => ({
    matchedExisting: true,
    previousKeyDropped: false,
    keptFlightDeckKey: false,
    ...over,
  });

  it("only when the save cost the server Flight Deck's key", () => {
    expect(lateConnectProblem(machine(null), outcome(), "cancelled")).toBeNull();
    expect(lateConnectProblem(machine("/data/ssh_keys/m1"), outcome({ keptFlightDeckKey: true }), "closed")).toBeNull();
    expect(lateConnectProblem(machine("/data/ssh_keys/m1"), outcome({ previousKeyDropped: true }), "cancelled")).toBeNull();
    const problem = lateConnectProblem(machine(null), outcome({ previousKeyDropped: true }), "cancelled");
    expect(problem).toContain("The connection to “Target” you cancelled went through anyway.");
    expect(problem).toContain("A key for Flight Deck");
  });

  it("blames a Cancel only when there was one", () => {
    const problem = lateConnectProblem(machine(null), outcome({ previousKeyDropped: true }), "closed");
    expect(problem).toContain("Connecting “Target” finished after the form was closed.");
    expect(problem).not.toContain("cancelled");
  });
});

describe("lateConnectFailure", () => {
  it("names the address dialed, with its port off 22, and the backend's words", () => {
    expect(lateConnectFailure({ host: "h.example", port: 22 }, "ssh command timed out")).toBe(
      "Connecting h.example failed after the “Connect an existing server” form was closed: ssh command timed out",
    );
    expect(lateConnectFailure({ host: "h.example", port: 2222 }, "x")).toContain("Connecting h.example:2222 failed");
  });
});
