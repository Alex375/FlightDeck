// The Plan usage widget's COST contract, rendered for real: it is shown by default in every
// conversation's side panel, so mounting it must not fetch (no credentials read, no Keychain
// prompt), must not add a poller, and must only run its minute clock while its body is on screen
// with a reset to count down to. What each state SAYS is pinned by planWidgetState.test.ts; the
// few text checks here only prove the right state reached the screen.
//
// Rendered through react-dom/client rather than the server renderer: the zustand stores and the
// query cache are read through subscriptions the SSR path only sees at their initial state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { commands } from "../../../ipc/client";
import { planUsageKey } from "../../../store/planUsage";
import { useCodexPlanUsageStore } from "../../../store/codexPlanUsage";
import { useConversationsStore, type Conversation } from "../../../store/conversationsStore";
import { useSidePanelLayout } from "../../../store/sidePanelWidgetsStore";
import { MINUTE_MS } from "../../../ui/useMinuteTick";
import type { PlanUsageInfo } from "../../../ui/kit";
import { PlanUsageWidget } from "./PlanUsageWidget";

// Whether Codex is installed decides the footer's « Claude » / « Codex » label. The real hook
// probes once and caches process-wide, so a test could not change its answer: pin it here.
const availability = vi.hoisted(() => ({ codex: false }));
vi.mock("../../../store/binaryAvailable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../store/binaryAvailable")>()),
  useCodexAvailable: () => availability.codex,
}));

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  name: "Plan",
  repoId: "r1",
  cwd: "/tmp/r1",
  createdAt: 1,
  lastActivityAt: 1,
  sessionId: null,
  handle: null,
  liveCwd: null,
  bypassAllowed: false,
  model: "opus",
  effort: "xhigh",
  ultracode: false,
  permissionMode: "default",
  pendingReminder: null,
  tosseTaskId: null,
  tosseTaskTitle: null,
  tosseTaskStatus: null,
  claudeAccountId: null,
  cleanOutput: null,
  kind: "claude",
  ...over,
});

const USAGE = (): PlanUsageInfo => ({
  five_hour: { used_percentage: 42, resets_at: new Date(Date.now() + 130 * 60_000).toISOString() },
  seven_day: { used_percentage: 83, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() },
  scoped: [],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSidePanelLayout.getState().setCollapsed("plan", false);
  useCodexPlanUsageStore.getState().clear();
  availability.codex = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Fake only the clock the widget reads (`Date`) and its minute interval. TanStack's notify
 *  batching runs on `setTimeout`, which stays real so cache writes still reach the screen. */
function fakeClock() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

/** Let a query settle and its notification (a real `setTimeout(0)`) reach React. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

/** The header's reading, through the tooltip trigger that carries it as its accessible name. */
function headerReading(): { label: string; level: string | null; stale: boolean } | null {
  const trigger = container.querySelector("section [aria-label$='windows'], section [aria-label*='— ']");
  if (!trigger) return null;
  const capsule = trigger.firstElementChild;
  return {
    label: trigger.getAttribute("aria-label") ?? "",
    level: capsule?.getAttribute("data-level") ?? null,
    stale: capsule?.hasAttribute("data-stale") ?? false,
  };
}

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

function mount(c: Conversation, machineId: string | null = null) {
  useConversationsStore.setState({
    conversations: [c],
    repos: [{ id: "r1", path: "/tmp/r1", addedAt: 1, machineId }],
  });
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(PlanUsageWidget, { conv: c })),
    );
  });
}

/** The minute intervals currently alive (TanStack and React create none at this period). */
function minuteIntervals(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter((call: unknown[]) => call[1] === MINUTE_MS).length;
}

const text = () => container.textContent ?? "";

describe("PlanUsageWidget — never the one that fetches", () => {
  it("mounting with an empty cache fetches nothing and starts no clock", async () => {
    const fetch = vi.spyOn(commands, "getPlanUsage");
    const every = vi.spyOn(globalThis, "setInterval");
    mount(conv());
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(minuteIntervals(every)).toBe(0);
    expect(text()).toContain("Not loaded yet");
    // The header reads « — », never a fake 0 %.
    expect(container.querySelector("section")?.textContent).toContain("—");
    expect(text()).not.toContain("0%");
  });

  it("fetches only on a deliberate Load, for the conversation's account", async () => {
    const fetch = vi.spyOn(commands, "getPlanUsage");
    mount(conv({ claudeAccountId: "acc-2" }));
    const load = [...container.querySelectorAll("button")].find((b) => b.textContent === "Load");
    expect(load).toBeTruthy();
    await act(async () => {
      load!.click();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("acc-2");
  });

  it("a remote conversation shows no local figure and offers no fetch", async () => {
    const fetch = vi.spyOn(commands, "getPlanUsage");
    qc.setQueryData(planUsageKey(null), USAGE());
    mount(conv(), "machine-1");
    await act(async () => {});
    expect(text()).toContain("server's own Claude account");
    expect(text()).not.toContain("42%");
    expect(container.querySelectorAll("button[aria-label^='Refresh']")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("PlanUsageWidget — the cached figures", () => {
  it("reads the warm cache: every window, the peak in the header, a minute clock", async () => {
    const fetch = vi.spyOn(commands, "getPlanUsage");
    const every = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    qc.setQueryData(planUsageKey(null), USAGE());
    mount(conv());
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    expect(text()).toContain("5-hour");
    expect(text()).toContain("42%");
    expect(text()).toContain("Weekly");
    expect(text()).toContain("resets in 2h");
    expect(text()).toContain("Updated just now");
    // Peak of the two account windows.
    expect(container.querySelector("section")?.textContent).toContain("83%");
    expect(minuteIntervals(every)).toBe(1);

    // Unmounting the body takes the clock with it.
    const id = every.mock.results.find((_, i) => every.mock.calls[i][1] === MINUTE_MS)?.value;
    act(() => root.unmount());
    expect(clear).toHaveBeenCalledWith(id);
    root = createRoot(container); // afterEach unmounts again
  });

  it("the refresh button is a click, not a poll", async () => {
    const fetch = vi.spyOn(commands, "getPlanUsage");
    qc.setQueryData(planUsageKey(null), USAGE());
    mount(conv());
    const refresh = container.querySelector<HTMLButtonElement>("button[aria-label^='Refresh']");
    expect(refresh).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      refresh!.click();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a folded section keeps its header reading and runs no clock", async () => {
    const every = vi.spyOn(globalThis, "setInterval");
    useSidePanelLayout.getState().setCollapsed("plan", true);
    qc.setQueryData(planUsageKey(null), USAGE());
    mount(conv());
    await act(async () => {});
    expect(container.querySelector("section")?.textContent).toContain("83%");
    expect(text()).not.toContain("5-hour");
    expect(minuteIntervals(every)).toBe(0);
  });

  it("a Codex conversation waits for its push, then reads the Codex store only", async () => {
    const fetch = vi.spyOn(commands, "getPlanUsage");
    qc.setQueryData(planUsageKey(null), USAGE()); // the Claude plan: must not leak in
    mount(conv({ kind: "codex" }));
    await act(async () => {});
    expect(text()).toContain("Codex reports its limits");
    expect(text()).not.toContain("42%");
    act(() => {
      useCodexPlanUsageStore.getState().set({
        five_hour: { used_percentage: 12, resets_at: String(Math.floor(Date.now() / 1000) + 630) },
        seven_day: null,
        scoped: [],
      });
    });
    expect(text()).toContain("12%");
    expect(text()).toContain("resets in 10min");
    expect(container.querySelectorAll("button[aria-label^='Refresh']")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("PlanUsageWidget — the minute clock", () => {
  it("moves the header off a window the moment it resets, in the same render as its row", () => {
    fakeClock();
    qc.setQueryData(planUsageKey(null), {
      five_hour: { used_percentage: 95, resets_at: iso(90_000) },
      seven_day: { used_percentage: 40, resets_at: iso(3 * 86400_000) },
      scoped: [],
    } satisfies PlanUsageInfo);
    mount(conv());
    // 95 % is near the limit: the header says so in amber.
    expect(headerReading()).toMatchObject({ label: expect.stringMatching(/^95%/), level: "warn" });
    expect(text()).toContain("resets in 1min");

    act(() => {
      vi.advanceTimersByTime(2 * MINUTE_MS);
    });
    expect(text()).toContain("resetting…");
    expect(headerReading()).toMatchObject({ label: expect.stringMatching(/^40%/), level: null });
    expect(text()).toContain("Updated 2 min ago");
  });

  it("keeps « Updated … ago » true when no reset is known (it never freezes on « just now »)", () => {
    fakeClock();
    const every = vi.spyOn(globalThis, "setInterval");
    qc.setQueryData(planUsageKey(null), {
      five_hour: { used_percentage: 10, resets_at: null },
      seven_day: null,
      scoped: [],
    } satisfies PlanUsageInfo);
    mount(conv());
    expect(text()).toContain("Updated just now");
    expect(minuteIntervals(every)).toBe(1);
    act(() => {
      vi.advanceTimersByTime(3 * MINUTE_MS);
    });
    expect(text()).toContain("Updated 3 min ago");
  });

  it("runs no clock while the page is hidden, and catches up the moment it shows", () => {
    fakeClock();
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      const every = vi.spyOn(globalThis, "setInterval");
      qc.setQueryData(planUsageKey(null), USAGE());
      mount(conv());
      expect(minuteIntervals(every)).toBe(0);
      expect(text()).toContain("Updated just now");

      // Five minutes pass off screen; nothing ticks.
      vi.setSystemTime(Date.now() + 5 * MINUTE_MS);
      expect(minuteIntervals(every)).toBe(0);

      hidden = false;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(minuteIntervals(every)).toBe(1);
      // Caught up at once, not a minute later.
      expect(text()).toContain("Updated 5 min ago");
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });
});

describe("PlanUsageWidget — failures are never silent", () => {
  it("a failed refresh keeps the bars, strips them as stale, and dims the header", async () => {
    qc.setQueryData(planUsageKey(null), USAGE());
    vi.spyOn(commands, "getPlanUsage").mockResolvedValue({
      status: "error",
      error: { kind: "rate_limited", retry_after: null },
    });
    mount(conv());
    const refresh = container.querySelector<HTMLButtonElement>("button[aria-label^='Refresh']");
    await act(async () => {
      refresh!.click();
    });
    await settle();
    expect(text()).toContain("Refresh failed — figures may be stale.");
    expect(text()).toContain("42%");
    expect(headerReading()).toMatchObject({ label: expect.stringMatching(/^83%/), stale: true });
    // A rate limit can heal: the footer's button is now a Retry.
    expect(container.querySelector("button[aria-label^='Retry']")).toBeTruthy();
  });

  it("a failure a retry cannot fix offers no retry and leaves no empty footer", async () => {
    vi.spyOn(commands, "getPlanUsage").mockResolvedValue({
      status: "error",
      error: { kind: "parse", body: "{" },
    });
    mount(conv());
    const load = [...container.querySelectorAll("button")].find((b) => b.textContent === "Load");
    await act(async () => {
      load!.click();
    });
    await settle();
    expect(text()).toContain("Unreadable response from the usage service.");
    expect(container.querySelector("button[aria-label^='Retry']")).toBeNull();
    expect(container.querySelector("button[aria-label^='Refresh']")).toBeNull();
    // One account, no Codex, never fetched: nothing to date, name or retry → no footer row.
    expect(container.querySelector("[class*='foot']")).toBeNull();
  });

  it("with Codex installed, the same footer names the plan instead", async () => {
    availability.codex = true;
    vi.spyOn(commands, "getPlanUsage").mockResolvedValue({
      status: "error",
      error: { kind: "parse", body: "{" },
    });
    mount(conv());
    const load = [...container.querySelectorAll("button")].find((b) => b.textContent === "Load");
    await act(async () => {
      load!.click();
    });
    await settle();
    expect(container.querySelector("[class*='foot']")?.textContent).toBe("Claude");
  });
});

describe("PlanUsageWidget — whose figures", () => {
  it("while an account switch is pending, reads the account the live process is billed to", async () => {
    const fetch = vi.spyOn(commands, "getPlanUsage");
    mount(
      conv({ handle: "session-1", liveClaudeAccountId: "acc-live", claudeAccountId: "acc-next" }),
    );
    const load = [...container.querySelectorAll("button")].find((b) => b.textContent === "Load");
    await act(async () => {
      load!.click();
    });
    expect(fetch).toHaveBeenCalledWith("acc-live");
  });
});
