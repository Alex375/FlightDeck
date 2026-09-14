import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsUi } from "./settingsUi";

beforeEach(() => useSettingsUi.setState({ open: false, section: "general" }));

describe("settingsUi store", () => {
  it("opens without changing the current section", () => {
    useSettingsUi.getState().openSettings();
    expect(useSettingsUi.getState().open).toBe(true);
    expect(useSettingsUi.getState().section).toBe("general");
  });

  it("opens directly on a given section (deep-link, e.g. the update banner)", () => {
    useSettingsUi.getState().openSettings("updates");
    const st = useSettingsUi.getState();
    expect(st.open).toBe(true);
    expect(st.section).toBe("updates");
  });

  it("remembers the section across close then reopen", () => {
    useSettingsUi.getState().openSettings("notifications");
    useSettingsUi.getState().closeSettings();
    expect(useSettingsUi.getState().open).toBe(false);
    expect(useSettingsUi.getState().section).toBe("notifications");
    useSettingsUi.getState().openSettings();
    expect(useSettingsUi.getState().section).toBe("notifications");
  });

  it("setSection switches the active tab", () => {
    useSettingsUi.getState().setSection("data");
    expect(useSettingsUi.getState().section).toBe("data");
  });

  // A title no mounted row carries (a page heading, a tile) must not stay armed: the row
  // would otherwise flash out of the blue whenever it appeared later.
  it("disarms a search highlight that no row claimed", () => {
    vi.useFakeTimers();
    try {
      useSettingsUi.getState().revealSetting({ section: "accounts", title: "Claude accounts" });
      expect(useSettingsUi.getState().highlight).toBe("Claude accounts");
      vi.advanceTimersByTime(3000);
      expect(useSettingsUi.getState().highlight).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old reveal's timer clear a newer highlight", () => {
    vi.useFakeTimers();
    try {
      useSettingsUi.getState().revealSetting({ section: "accounts", title: "Switching" });
      vi.advanceTimersByTime(2000);
      useSettingsUi.getState().revealSetting({ section: "data", title: "Data" });
      vi.advanceTimersByTime(1000);
      expect(useSettingsUi.getState().highlight).toBe("Data");
    } finally {
      vi.useRealTimers();
    }
  });
});
