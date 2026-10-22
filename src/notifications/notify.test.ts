import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock every side-effecting boundary so we can assert exactly which channels fire.
vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(),
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
}));
vi.mock("../ipc/client", () => ({
  commands: {
    requestUserAttention: vi.fn(async () => ({ status: "ok", data: null })),
    playAlertSound: vi.fn(async () => ({ status: "ok", data: true })),
  },
}));
vi.mock("./sound", () => ({ playComposed: vi.fn(() => true) }));

import type { AgentNotification } from "./notify";
import {
  armAgentNotification,
  armedAgentNotificationKind,
  cancelAgentNotification,
  dispatchAgentNotification,
  noteInterrupt,
  initNotifications,
  notifyFromAgent,
  testSound,
} from "./notify";
import { playComposed } from "./sound";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { commands } from "../ipc/client";
import { useNotifications } from "../store/notifications";

const ev = (o: Partial<AgentNotification> = {}): AgentNotification => ({
  kind: "done",
  convId: "c1",
  title: "Ma conv",
  repoName: "repo",
  activeId: null,
  ...o,
});

let hasFocus: { mockReturnValue(v: boolean): unknown; mockRestore(): void };

beforeEach(async () => {
  vi.clearAllMocks();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  useNotifications.setState({
    systemNotification: true,
    sound: true,
    dockBounce: true,
    doneSound: "flightdeck:rise",
    attentionSound: "flightdeck:fall",
    soundVolume: 1,
  });
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await initNotifications(); // grants OS permission (mocked) → sendNotification fires synchronously
  vi.clearAllMocks(); // drop init's calls so each test counts from zero
});

afterEach(() => {
  hasFocus.mockRestore();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("dispatchAgentNotification — channels", () => {
  it("fires all three channels when not watching and every pref is on", () => {
    dispatchAgentNotification(ev());
    expect(playComposed).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(commands.requestUserAttention).toHaveBeenCalledOnce();
  });

  it("respects the sound toggle", () => {
    useNotifications.setState({ sound: false });
    dispatchAgentNotification(ev());
    expect(playComposed).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it("respects the system-notification toggle", () => {
    useNotifications.setState({ systemNotification: false });
    dispatchAgentNotification(ev());
    expect(sendNotification).not.toHaveBeenCalled();
    expect(playComposed).toHaveBeenCalledOnce();
  });

  it("respects the dock-bounce toggle", () => {
    useNotifications.setState({ dockBounce: false });
    dispatchAgentNotification(ev());
    expect(commands.requestUserAttention).not.toHaveBeenCalled();
    expect(playComposed).toHaveBeenCalledOnce();
  });

  it("dock bounce is critical for attention, informational for done", () => {
    dispatchAgentNotification(ev({ kind: "attention" }));
    expect(commands.requestUserAttention).toHaveBeenLastCalledWith(true);
    dispatchAgentNotification(ev({ kind: "done" }));
    expect(commands.requestUserAttention).toHaveBeenLastCalledWith(false);
  });
});

describe("dispatchAgentNotification — focus suppression", () => {
  it("plays the SOUND but suppresses banner + dock when watching (active conv + focused)", () => {
    // The sound is decoupled from focus: the user asked to hear the chime even
    // while looking at the very conversation. Banner + Dock stay suppressed.
    hasFocus.mockReturnValue(true);
    dispatchAgentNotification(ev({ convId: "c1", activeId: "c1" }));
    expect(playComposed).toHaveBeenCalledOnce();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(commands.requestUserAttention).not.toHaveBeenCalled();
  });

  it("honours the sound toggle even while watching (no chime when sound off)", () => {
    hasFocus.mockReturnValue(true);
    useNotifications.setState({ sound: false });
    dispatchAgentNotification(ev({ convId: "c1", activeId: "c1" }));
    expect(playComposed).not.toHaveBeenCalled();
  });

  it("fires every channel for a background conversation while another is focused", () => {
    hasFocus.mockReturnValue(true);
    dispatchAgentNotification(ev({ convId: "c2", activeId: "c1" }));
    expect(playComposed).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(commands.requestUserAttention).toHaveBeenCalledOnce();
  });

  it("fires every channel for the active conversation when the window is not focused", () => {
    hasFocus.mockReturnValue(false);
    dispatchAgentNotification(ev({ convId: "c1", activeId: "c1" }));
    expect(playComposed).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(commands.requestUserAttention).toHaveBeenCalledOnce();
  });
});

describe("dispatchAgentNotification — interrupt suppression", () => {
  it("swallows the 'done' that follows a user-initiated interrupt", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playComposed).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(commands.requestUserAttention).not.toHaveBeenCalled();
  });

  it("only suppresses 'done', never 'attention'", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "attention", convId: "c1" }));
    expect(playComposed).toHaveBeenCalledOnce();
  });

  it("is one-shot: a second 'done' notifies normally", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" })); // consumes the flag
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playComposed).toHaveBeenCalledOnce();
  });

  it("an interrupt on one conversation doesn't mute another", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "done", convId: "c2" }));
    expect(playComposed).toHaveBeenCalledOnce();
  });
});

describe("dispatchAgentNotification — interrupt window", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suppresses a 'done' within the 15s window", () => {
    vi.setSystemTime(0);
    noteInterrupt("c1");
    vi.setSystemTime(5_000);
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playComposed).not.toHaveBeenCalled();
  });

  it("does NOT suppress a 'done' that arrives after the window (stale flag)", () => {
    vi.setSystemTime(0);
    noteInterrupt("c1");
    vi.setSystemTime(20_000);
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playComposed).toHaveBeenCalledOnce();
  });
});

// The settle window: a state edge ARMS a notification, and the conversation has a
// short grace period to disprove it before the user hears anything. This table only
// holds the timers — the policy that cancels lives in transition.ts.
describe("armAgentNotification — settle window", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelAgentNotification("c1");
    cancelAgentNotification("c2");
    vi.useRealTimers();
  });

  it("fires only once the delay has elapsed", () => {
    const fire = vi.fn();
    armAgentNotification("c1", "done", 3_000, fire);
    vi.advanceTimersByTime(2_999);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledOnce();
  });

  it("cancelling before the delay keeps it silent — the resumed-turn case", () => {
    const fire = vi.fn();
    armAgentNotification("c1", "done", 3_000, fire);
    cancelAgentNotification("c1");
    vi.advanceTimersByTime(10_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("exposes what is armed, so the caller can re-check it", () => {
    expect(armedAgentNotificationKind("c1")).toBeNull();
    armAgentNotification("c1", "attention", 1_000, vi.fn());
    expect(armedAgentNotificationKind("c1")).toBe("attention");
    vi.advanceTimersByTime(1_000);
    expect(armedAgentNotificationKind("c1")).toBeNull(); // cleared once delivered
  });

  it("a newer edge replaces the armed one — only the latest fires", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    armAgentNotification("c1", "done", 3_000, stale);
    vi.advanceTimersByTime(500);
    armAgentNotification("c1", "attention", 1_000, fresh);
    vi.advanceTimersByTime(10_000);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });

  it("is per conversation — cancelling one leaves the other armed", () => {
    const a = vi.fn();
    const b = vi.fn();
    armAgentNotification("c1", "done", 3_000, a);
    armAgentNotification("c2", "done", 3_000, b);
    cancelAgentNotification("c1");
    vi.advanceTimersByTime(3_000);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it("cancelling nothing is a no-op", () => {
    expect(() => cancelAgentNotification("nope")).not.toThrow();
  });

  it("the fired callback may arm again (the entry is already dropped)", () => {
    const second = vi.fn();
    armAgentNotification("c1", "done", 1_000, () =>
      armAgentNotification("c1", "done", 1_000, second),
    );
    vi.advanceTimersByTime(1_000);
    expect(armedAgentNotificationKind("c1")).toBe("done");
    vi.advanceTimersByTime(1_000);
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("notification sounds — the per-event choice", () => {
  it("plays the chosen sound of each event at the chosen volume", () => {
    useNotifications.setState({ doneSound: "flightdeck:cabin", attentionSound: "flightdeck:taps", soundVolume: 0.5 });
    dispatchAgentNotification(ev({ kind: "done" }));
    dispatchAgentNotification(ev({ kind: "attention" }));
    expect(playComposed).toHaveBeenNthCalledWith(1, "flightdeck:cabin", 0.5);
    expect(playComposed).toHaveBeenNthCalledWith(2, "flightdeck:taps", 0.5);
  });

  it("a finished turn flagged as an alert plays the attention sound", () => {
    dispatchAgentNotification(ev({ kind: "done", sound: "attention" }));
    expect(playComposed).toHaveBeenCalledWith("flightdeck:fall", 1);
  });

  it("'none' silences that event only — the banner and Dock still fire", () => {
    useNotifications.setState({ doneSound: "none" });
    dispatchAgentNotification(ev({ kind: "done" }));
    expect(playComposed).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledOnce();
    dispatchAgentNotification(ev({ kind: "attention" }));
    expect(playComposed).toHaveBeenCalledWith("flightdeck:fall", 1);
  });

  it("a macOS sound file goes to the Rust player", async () => {
    useNotifications.setState({ doneSound: "system:Glass.aiff", soundVolume: 1.5 });
    dispatchAgentNotification(ev({ kind: "done" }));
    expect(commands.playAlertSound).toHaveBeenCalledWith("system:Glass.aiff", 1.5);
    await Promise.resolve();
    expect(playComposed).not.toHaveBeenCalled();
  });

  it("a file that can't play falls back to the factory chime, never to silence", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(commands.playAlertSound).mockResolvedValueOnce({
      status: "error",
      error: "gone",
    } as never);
    useNotifications.setState({ attentionSound: "user:Deleted.wav" });
    dispatchAgentNotification(ev({ kind: "attention" }));
    await new Promise((r) => setTimeout(r));
    expect(playComposed).toHaveBeenCalledWith("flightdeck:fall", 1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("an unknown Flight Deck id plays the factory chime", () => {
    vi.mocked(playComposed).mockReturnValueOnce(false);
    useNotifications.setState({ doneSound: "flightdeck:renamed" });
    dispatchAgentNotification(ev({ kind: "done" }));
    expect(playComposed).toHaveBeenNthCalledWith(1, "flightdeck:renamed", 1);
    expect(playComposed).toHaveBeenNthCalledWith(2, "flightdeck:rise", 1);
  });

  it("notify_user reports no sound when that event's sound is 'none'", () => {
    useNotifications.setState({ attentionSound: "none" });
    expect(notifyFromAgent("hi", true).sound).toBe(false);
    expect(notifyFromAgent("hi", false).sound).toBe(true);
  });

  it("the Settings test plays even while the sound channel is off", () => {
    useNotifications.setState({ sound: false });
    testSound("attention");
    testSound("done", "flightdeck:bubble");
    expect(playComposed).toHaveBeenNthCalledWith(1, "flightdeck:fall", 1);
    expect(playComposed).toHaveBeenNthCalledWith(2, "flightdeck:bubble", 1);
  });
});
