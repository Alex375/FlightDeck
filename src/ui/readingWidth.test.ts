import { describe, expect, it } from "vitest";
import {
  DEFAULT_READING_WIDTH,
  MAX_READING_WIDTH,
  MIN_READING_WIDTH,
  READING_WIDTH_STEP,
  sanitizeReadingWidth,
} from "./readingWidth";
import { MIN_COMPOSER_PX } from "../features/conversation/composerLayout";

describe("sanitizeReadingWidth", () => {
  it("falls back to the default for anything that is not a finite number", () => {
    for (const bad of [undefined, null, "800", NaN, Infinity, {}]) {
      expect(sanitizeReadingWidth(bad)).toBe(DEFAULT_READING_WIDTH);
    }
  });

  it("clamps to the offered range", () => {
    expect(sanitizeReadingWidth(10)).toBe(MIN_READING_WIDTH);
    expect(sanitizeReadingWidth(5000)).toBe(MAX_READING_WIDTH);
  });

  it("snaps onto the stepper's grid, so − / + land on the values they offer", () => {
    expect(sanitizeReadingWidth(771)).toBe(760);
    expect(sanitizeReadingWidth(781)).toBe(800);
  });

  it("keeps the default and both ends ON the grid", () => {
    for (const v of [DEFAULT_READING_WIDTH, MIN_READING_WIDTH, MAX_READING_WIDTH]) {
      expect(sanitizeReadingWidth(v)).toBe(v);
      expect((v - MIN_READING_WIDTH) % READING_WIDTH_STEP).toBe(0);
    }
  });

  it("never offers a column narrower than the composer's own floor", () => {
    expect(MIN_READING_WIDTH).toBeGreaterThanOrEqual(MIN_COMPOSER_PX);
  });
});
