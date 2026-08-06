import { beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_PRESETS,
  buildCodexControls,
  codexConvControls,
  useCodexControls,
} from "./codexControls";
import { DEFAULT_CODEX_MODEL } from "./models";
import { clampEffort, effortLevelsForModel } from "./EffortGauge";
import type { Conversation } from "../../store/conversationsStore";

// A minimal Codex conversation stub — only the fields buildCodexControls reads.
function codexConv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    name: "x",
    repoId: "r",
    cwd: "/tmp",
    createdAt: 0,
    lastActivityAt: 0,
    sessionId: null,
    kind: "codex",
    handle: null,
    liveCwd: null,
    model: "gpt-5.5",
    effort: "high",
    ultracode: false,
    permissionMode: null,
    cleanOutput: null,
    pendingReminder: null,
    tosseTaskId: null,
    tosseTaskTitle: null,
    tosseTaskStatus: null,
    ...over,
  };
}

beforeEach(() => {
  useCodexControls.getState().clearAll();
});

describe("codexConvControls defaults", () => {
  it("returns the product defaults for an untouched conversation (network ON)", () => {
    expect(codexConvControls("nope")).toEqual({
      preset: "auto",
      network: true,
      summary: "auto",
      personality: "none",
    });
  });

  it("applies a stored patch over the defaults (network can be turned OFF)", () => {
    useCodexControls.getState().set("c1", { preset: "auto", network: false });
    expect(codexConvControls("c1")).toEqual({
      preset: "auto",
      network: false,
      summary: "auto",
      personality: "none",
    });
  });
});

describe("CODEX_PRESETS map to (sandbox, approval) axes", () => {
  it("prudent = read-only + on-request", () => {
    expect(CODEX_PRESETS.prudent.sandbox).toBe("readOnly");
    expect(CODEX_PRESETS.prudent.approval).toBe("on-request");
  });
  it("standard = workspace-write + on-request", () => {
    expect(CODEX_PRESETS.standard.sandbox).toBe("workspaceWrite");
    expect(CODEX_PRESETS.standard.approval).toBe("on-request");
  });
  it("auto = workspace-write + never", () => {
    expect(CODEX_PRESETS.auto.sandbox).toBe("workspaceWrite");
    expect(CODEX_PRESETS.auto.approval).toBe("never");
  });
  it("danger = full access + never", () => {
    expect(CODEX_PRESETS.danger.sandbox).toBe("dangerFullAccess");
    expect(CODEX_PRESETS.danger.approval).toBe("never");
  });
});

describe("buildCodexControls (wire payload)", () => {
  it("folds model+effort (conv record) with preset/network/summary/personality (store)", () => {
    useCodexControls.getState().set("c1", {
      preset: "auto",
      network: true,
      summary: "concise",
      personality: "friendly",
    });
    const wire = buildCodexControls(codexConv({ id: "c1", model: "gpt-5.4", effort: "xhigh" }));
    expect(wire).toEqual({
      model: "gpt-5.4",
      effort: "xhigh",
      sandbox: "workspaceWrite", // from the "auto" preset
      networkAccess: true,
      approvalPolicy: "never", // from the "auto" preset
      summary: "concise",
      personality: "friendly",
      serviceTier: null, // unset → follow the model's default tier
    });
  });

  it("folds a chosen service tier (null when unset)", () => {
    useCodexControls.getState().set("c1", { serviceTier: "priority" });
    expect(buildCodexControls(codexConv({ id: "c1" })).serviceTier).toBe("priority");
    // Clearing it falls back to the model default (null on the wire).
    useCodexControls.getState().set("c1", { serviceTier: undefined });
    expect(buildCodexControls(codexConv({ id: "c1" })).serviceTier).toBeNull();
  });

  it("falls back to the Codex default model/effort when the record is empty", () => {
    const wire = buildCodexControls(codexConv({ id: "c1", model: null, effort: null }));
    expect(wire.model).toBe(DEFAULT_CODEX_MODEL);
    expect(wire.effort).toBe("xhigh"); // DEFAULT_CODEX_EFFORT (= "Extra")
    expect(wire.approvalPolicy).toBe("never"); // default "auto" preset
    expect(wire.sandbox).toBe("workspaceWrite");
    expect(wire.networkAccess).toBe(true); // network ON by default
  });

  it("never sends a Claude alias as the Codex model (legacy conv seeded with 'opus')", () => {
    const wire = buildCodexControls(codexConv({ id: "c1", model: "opus" }));
    expect(wire.model).toBe(DEFAULT_CODEX_MODEL);
  });
});

describe("effortLevelsForModel is backend-aware", () => {
  it("Codex models expose low/medium/high/xhigh (no max, no ultracode)", () => {
    expect(effortLevelsForModel("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortLevelsForModel("gpt-5.4-mini")).toEqual(["low", "medium", "high", "xhigh"]);
  });
  it("Claude models keep their own ladders", () => {
    expect(effortLevelsForModel("opus")).toContain("max");
    expect(effortLevelsForModel("haiku")).toEqual([]);
  });
});

describe("clampEffort into Codex steps on a backend switch", () => {
  const codexSteps = ["low", "medium", "high", "xhigh"] as const;
  it("drops a Claude-only max / Ultra code down to the Codex top (xhigh)", () => {
    expect(clampEffort("max", "gpt-5.5", [...codexSteps])).toBe("xhigh");
    expect(clampEffort("ultracode", "gpt-5.5", [...codexSteps])).toBe("xhigh");
  });
  it("leaves a supported effort unchanged", () => {
    expect(clampEffort("high", "gpt-5.5", [...codexSteps])).toBe("high");
    expect(clampEffort("low", "gpt-5.5", [...codexSteps])).toBe("low");
  });
});
