import { describe, expect, it } from "vitest";
import type { CopyOutcome } from "../../../ipc/client";
import {
  copyDetail,
  failedStep,
  formatBytes,
  freshSteps,
  inviteVisible,
  nextStep,
  progressFraction,
  skippedByReason,
} from "./serverLaunchModel";

const base = { pref: true, kind: "claude" as const, local: true, empty: true, launching: false, dismissed: false, servers: 1 };

describe("inviteVisible", () => {
  it("shows on an empty local Claude conversation when a server is paired", () => {
    expect(inviteVisible(base)).toBe(true);
  });
  it("hides for anything else", () => {
    for (const k of ["pref", "local", "empty"] as const) expect(inviteVisible({ ...base, [k]: false })).toBe(false);
    for (const k of ["launching", "dismissed"] as const) expect(inviteVisible({ ...base, [k]: true })).toBe(false);
    expect(inviteVisible({ ...base, kind: "codex" })).toBe(false);
    expect(inviteVisible({ ...base, servers: 0 })).toBe(false);
  });
});

describe("steps", () => {
  it("picks up at the first step not done, and names the failed one", () => {
    const s = freshSteps();
    expect(nextStep(s)).toBe("check");
    s.check.status = "done";
    s.transfer.status = "failed";
    expect(nextStep(s)).toBe("transfer");
    expect(failedStep(s)).toBe("transfer");
    for (const k of Object.keys(s) as (keyof typeof s)[]) s[k].status = "done";
    expect(nextStep(s)).toBeNull();
  });
});

describe("report", () => {
  const copy: CopyOutcome = {
    staged: 2,
    unstaged: 1,
    copied: [{ path: ".env", bytes: 10, why: "secret" }],
    skipped: [
      { path: "debug.log", why: "ignored" },
      { path: "node_modules/", why: "regenerable" },
      { path: "big.bin", why: "tooLarge" },
    ],
    skippedMore: 2,
    bytes: 100,
    stage: "/x",
  };
  it("summarizes the copy", () => {
    expect(copyDetail(copy)).toBe("2 staged · 1 unstaged · 1 file copied · 5 left behind");
  });
  it("groups what was left behind, most telling first", () => {
    expect(skippedByReason(copy).map((g) => g.why)).toEqual(["tooLarge", "regenerable", "ignored"]);
  });
});

describe("formatting", () => {
  it("formats sizes and progress", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(progressFraction(5, 10)).toBe(0.5);
    expect(progressFraction(5, 0)).toBeNull();
    expect(progressFraction(20, 10)).toBe(1);
  });
});
