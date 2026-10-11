import { describe, expect, it } from "vitest";
import {
  awakeHold,
  BATTERY_FLOOR_MAX,
  BATTERY_FLOOR_MIN,
  BATTERY_REARM_MARGIN,
  CAFFEINATE_MODES,
  CAFFEINATE_MODE_META,
  caffeineDesired,
  DEFAULT_BATTERY_FLOOR,
  followsActivity,
  isCaffeinateMode,
  lidAllowedByBattery,
  LIGHT_RELEASE_GRACE_MS,
  openLidTwin,
  permanentTwin,
  releaseGraceMs,
  resistsLid,
  sanitizeBatteryFloor,
} from "./caffeinate";

describe("releaseGraceMs", () => {
  it("lingers only for the activity-driven releases (Light, Night Watch)", () => {
    expect(releaseGraceMs(true, "light")).toBe(LIGHT_RELEASE_GRACE_MS);
    expect(releaseGraceMs(true, "nightwatch")).toBe(LIGHT_RELEASE_GRACE_MS);
  });

  it("releases at once when the user turns Caffeinate off", () => {
    for (const m of CAFFEINATE_MODES) expect(releaseGraceMs(false, m)).toBe(0);
  });

  it("does not linger in the permanent modes (their only release is being turned off)", () => {
    expect(releaseGraceMs(true, "hard")).toBe(0);
    expect(releaseGraceMs(true, "insomnia")).toBe(0);
  });
});

describe("caffeineDesired", () => {
  it("never holds when disabled, whatever the mode or activity", () => {
    for (const m of CAFFEINATE_MODES) {
      expect(caffeineDesired(false, m, true)).toBe(false);
      expect(caffeineDesired(false, m, false)).toBe(false);
    }
  });

  it("Light and Night Watch follow fleet activity", () => {
    expect(caffeineDesired(true, "light", true)).toBe(true); // an agent is working
    expect(caffeineDesired(true, "light", false)).toBe(false); // everything idle → sleep
    expect(caffeineDesired(true, "nightwatch", true)).toBe(true);
    expect(caffeineDesired(true, "nightwatch", false)).toBe(false);
  });

  it("Hard and Insomnia hold permanently while enabled, ignoring activity", () => {
    expect(caffeineDesired(true, "hard", false)).toBe(true); // idle but still awake
    expect(caffeineDesired(true, "hard", true)).toBe(true);
    expect(caffeineDesired(true, "insomnia", false)).toBe(true);
    expect(caffeineDesired(true, "insomnia", true)).toBe(true);
  });
});

describe("the two axes", () => {
  it("classify the four modes", () => {
    expect(CAFFEINATE_MODES.filter(followsActivity)).toEqual(["light", "nightwatch"]);
    expect(CAFFEINATE_MODES.filter(resistsLid)).toEqual(["nightwatch", "insomnia"]);
  });

  it("the display meta flags exactly the closed-lid modes and warns on Insomnia only", () => {
    expect(CAFFEINATE_MODES.filter((m) => CAFFEINATE_MODE_META[m].lid)).toEqual(["nightwatch", "insomnia"]);
    expect(CAFFEINATE_MODES.filter((m) => CAFFEINATE_MODE_META[m].warning)).toEqual(["insomnia"]);
  });

  it("openLidTwin drops only the closed-lid part", () => {
    expect(CAFFEINATE_MODES.map(openLidTwin)).toEqual(["light", "hard", "light", "hard"]);
    for (const m of CAFFEINATE_MODES) {
      expect(resistsLid(openLidTwin(m))).toBe(false);
      expect(followsActivity(openLidTwin(m))).toBe(followsActivity(m));
    }
  });

  it("permanentTwin makes a mode permanent and keeps its lid behaviour", () => {
    expect(CAFFEINATE_MODES.map(permanentTwin)).toEqual(["hard", "hard", "insomnia", "insomnia"]);
    for (const m of CAFFEINATE_MODES) {
      expect(followsActivity(permanentTwin(m))).toBe(false);
      expect(resistsLid(permanentTwin(m))).toBe(resistsLid(m));
    }
  });

  it("isCaffeinateMode guards a stored value from an older or newer build", () => {
    expect(isCaffeinateMode("light")).toBe(true);
    expect(isCaffeinateMode("insomnia")).toBe(true);
    expect(isCaffeinateMode("mega")).toBe(false);
    expect(isCaffeinateMode(undefined)).toBe(false);
  });
});

describe("awakeHold", () => {
  it("is off whenever nothing should be held", () => {
    expect(awakeHold(false, "insomnia", true, true)).toBe("off");
    expect(awakeHold(true, "light", false, true)).toBe("off");
    expect(awakeHold(true, "nightwatch", false, true)).toBe("off");
  });

  it("the open-lid modes never ask for the system flag", () => {
    expect(awakeHold(true, "light", true, true)).toBe("idle");
    expect(awakeHold(true, "hard", false, true)).toBe("idle");
  });

  it("the closed-lid modes ask for the system flag while the battery allows it", () => {
    expect(awakeHold(true, "nightwatch", true, true)).toBe("lid");
    expect(awakeHold(true, "insomnia", false, true)).toBe("lid");
  });

  it("under the battery floor a closed-lid mode degrades to the open-lid hold, never to off", () => {
    expect(awakeHold(true, "nightwatch", true, false)).toBe("idle");
    expect(awakeHold(true, "insomnia", false, false)).toBe("idle");
  });
});

describe("lidAllowedByBattery", () => {
  const floor = 20;
  const batt = (percent: number | null, on_battery = true) => ({
    on_battery,
    percent,
    low_power_mode: false,
  });

  it("keeps the last decision when there is no reading", () => {
    expect(lidAllowedByBattery(true, null, floor)).toBe(true);
    expect(lidAllowedByBattery(false, null, floor)).toBe(false);
  });

  it("always allows on power", () => {
    expect(lidAllowedByBattery(false, batt(3, false), floor)).toBe(true);
  });

  it("cuts at or under the floor on battery", () => {
    expect(lidAllowedByBattery(true, batt(21), floor)).toBe(true);
    expect(lidAllowedByBattery(true, batt(20), floor)).toBe(false);
    expect(lidAllowedByBattery(true, batt(5), floor)).toBe(false);
  });

  it("re-arms only a margin above the floor (hysteresis)", () => {
    expect(lidAllowedByBattery(false, batt(21), floor)).toBe(false);
    expect(lidAllowedByBattery(false, batt(floor + BATTERY_REARM_MARGIN - 1), floor)).toBe(false);
    expect(lidAllowedByBattery(false, batt(floor + BATTERY_REARM_MARGIN), floor)).toBe(true);
  });

  it("never cuts on an unreadable charge (the user chose the mode)", () => {
    expect(lidAllowedByBattery(true, batt(null), floor)).toBe(true);
    expect(lidAllowedByBattery(false, batt(null), floor)).toBe(true);
  });
});

describe("sanitizeBatteryFloor", () => {
  it("clamps to the range and falls back on garbage", () => {
    expect(sanitizeBatteryFloor(BATTERY_FLOOR_MIN - 1)).toBe(BATTERY_FLOOR_MIN);
    expect(sanitizeBatteryFloor(BATTERY_FLOOR_MAX + 1)).toBe(BATTERY_FLOOR_MAX);
    expect(sanitizeBatteryFloor(25)).toBe(25);
    expect(sanitizeBatteryFloor("25")).toBe(DEFAULT_BATTERY_FLOOR);
    expect(sanitizeBatteryFloor(12.5)).toBe(DEFAULT_BATTERY_FLOOR);
    expect(sanitizeBatteryFloor(undefined)).toBe(DEFAULT_BATTERY_FLOOR);
  });
});
