// What a platform cannot offer (the Rust `platform_limits`, Linux for now): read once at boot,
// a failed read surfaced, and keep-awake never asked for where it does not exist — while an
// unread or empty answer (macOS) leaves the app exactly as before.
//
// Rendered through react-dom/client (zustand's SSR path would only ever see initial state).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformLimits } from "../ipc/client";

const LINUX: PlatformLimits = {
  keep_awake: "Not available on Linux yet: Flight Deck cannot keep the computer awake there.",
  open_in_terminal: "Not available on Linux yet.",
  browser_open_unconfirmed: "Flight Deck can't tell whether a browser actually opened.",
};

const ipc = vi.hoisted(() => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      platformLimits: vi.fn(async (): Promise<unknown> => ({ keep_awake: null, open_in_terminal: null })),
      setAwake: vi.fn((_awake: boolean) => ok()),
      setSleepDisabled: vi.fn(() => Promise.resolve({ status: "error", error: "unused" })),
      sleepLockStatus: vi.fn(() => Promise.resolve({ status: "error", error: "unused" })),
      powerSource: vi.fn(() => Promise.resolve({ status: "error", error: "unused" })),
    },
  };
});
vi.mock("../ipc/client", () => ipc);
const opener = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppErrors } from "./appErrors";
import { useCaffeinate } from "./caffeinate";
import { __resetPlatformLimitsForTests, loadPlatformLimits, usePlatformLimits } from "./platformLimits";
import { CaffeinateHost } from "../features/power/CaffeinateHost";
import { __resetAwakeDriverForTests } from "../features/power/useAwakeAssertion";
import { useAuthUrlOpener } from "../features/settings/ConnectionCard";

const flush = () => act(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  __resetPlatformLimitsForTests();
  __resetAwakeDriverForTests();
  useAppErrors.setState({ errors: [] });
});

describe("loadPlatformLimits", () => {
  it("stores the core's answer, read once however often it is asked", async () => {
    ipc.commands.platformLimits.mockResolvedValueOnce(LINUX);
    loadPlatformLimits();
    loadPlatformLimits();
    await flush();
    expect(ipc.commands.platformLimits).toHaveBeenCalledTimes(1);
    expect(usePlatformLimits.getState().limits).toEqual(LINUX);
  });

  it("a failed read is surfaced, and leaves nothing limited", async () => {
    ipc.commands.platformLimits.mockRejectedValueOnce(new Error("ipc down"));
    loadPlatformLimits();
    await flush();
    expect(usePlatformLimits.getState().limits).toBeNull();
    expect(useAppErrors.getState().errors.map((e) => e.message)).toEqual([
      "Couldn't read which features this platform supports.",
    ]);
  });
});

describe("CaffeinateHost on a platform without keep-awake", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Armed in a permanent mode: on macOS this holds the assertion straight away.
    useCaffeinate.setState({ enabled: true, mode: "hard" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useCaffeinate.setState({ enabled: false, mode: "light" });
  });

  it("nothing limited (macOS, or not read yet): the hold goes out as before", async () => {
    act(() => root.render(createElement(CaffeinateHost)));
    await flush();
    expect(ipc.commands.setAwake).toHaveBeenCalledWith(true);
  });

  it("keep-awake unavailable: never asks for a hold, so no error banner either", async () => {
    usePlatformLimits.setState({ limits: LINUX });
    act(() => root.render(createElement(CaffeinateHost)));
    await flush();
    expect(ipc.commands.setAwake).not.toHaveBeenCalledWith(true);
    expect(useAppErrors.getState().errors).toEqual([]);
  });
});

describe("sign-in link where a browser open cannot be confirmed (Linux)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: ReturnType<typeof useAuthUrlOpener> | null = null;
  function Probe() {
    seen = useAuthUrlOpener();
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    seen = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const openLink = async () => {
    await act(async () => seen!.open("https://claude.ai/oauth/authorize?x=1"));
  };

  it("elsewhere: a successful open shows nothing — exactly as before", async () => {
    await openLink();
    expect(seen!.notice).toBeNull();
  });

  it("Linux: a 'successful' open still shows the link, as a caveat rather than an error", async () => {
    usePlatformLimits.setState({ limits: LINUX });
    await openLink();
    expect(seen!.error).toBeNull();
    expect(seen!.notice).toBe(LINUX.browser_open_unconfirmed);
    expect(seen!.url).toBe("https://claude.ai/oauth/authorize?x=1");
  });

  it("a failed open is still the error, on every platform", async () => {
    usePlatformLimits.setState({ limits: LINUX });
    opener.openUrl.mockRejectedValueOnce(new Error("no handler"));
    await openLink();
    expect(seen!.notice).toBe("Unable to open the browser: no handler");
  });
});
