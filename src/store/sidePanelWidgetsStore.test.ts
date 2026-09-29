import { afterEach, describe, expect, it, vi } from "vitest";

/** The store reads localStorage ONCE, at module load — each case boots a fresh copy of the
 *  module against the storage it describes. */
async function bootWith(storage: Record<string, object>) {
  localStorage.clear();
  for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, JSON.stringify(value));
  vi.resetModules();
  const { useSidePanelLayout } = await import("./sidePanelWidgetsStore");
  return useSidePanelLayout;
}

const telemetryOn = (layout: { main: { id: string; on: boolean }[] }) =>
  layout.main.find((e) => e.id === "telemetry")?.on;

describe("side panel layout store", () => {
  afterEach(() => localStorage.clear());

  it("carries the retired telemetry switch over on first run — and saves it at once", async () => {
    const store = await bootWith({ "tosse:display": { conversationTelemetry: true } });
    expect(telemetryOn(store.getState().layout)).toBe(true);
    // Saved immediately: the display store drops the retired key on its next save, so a
    // carry-over kept only in memory would be gone by the following launch.
    const saved = JSON.parse(localStorage.getItem("tosse:sidepanel")!);
    expect(telemetryOn(saved)).toBe(true);
  });

  it("starts from the defaults on a fresh install", async () => {
    const store = await bootWith({});
    expect(telemetryOn(store.getState().layout)).toBe(false);
    expect(store.getState().layout.collapsible).toBe(true);
  });

  it("repairs a stored layout instead of trusting it, and ignores the old switch once it exists", async () => {
    const store = await bootWith({
      "tosse:display": { conversationTelemetry: true },
      "tosse:sidepanel": { main: [{ id: "plan", on: false }, { id: "nope", on: true }], collapsible: false },
    });
    const { layout } = store.getState();
    expect(layout.main.find((e) => e.id === "plan")).toEqual({ id: "plan", on: false });
    expect(layout.main.some((e) => e.id === ("nope" as string))).toBe(false);
    expect(telemetryOn(layout)).toBe(false);
    expect(layout.collapsible).toBe(false);
  });

  it("persists every edit, and never the transient customize flag", async () => {
    const store = await bootWith({});
    store.getState().setOn("git", false);
    store.getState().setCustomizing(true);
    const saved = JSON.parse(localStorage.getItem("tosse:sidepanel")!);
    expect(saved.main.find((e: { id: string }) => e.id === "git").on).toBe(false);
    expect(saved.customizing).toBeUndefined();
  });
});
