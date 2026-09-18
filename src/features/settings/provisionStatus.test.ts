import { describe, expect, it } from "vitest";
import { describeProvisionStatus } from "./provisionStatus";

const NOW = 1_800_000_000_000;

describe("describeProvisionStatus", () => {
  it("reports 'not checked yet' when there is no entry for this machine", () => {
    const label = describeProvisionStatus(undefined, NOW);
    expect(label).toEqual({ text: "not checked yet", canRetry: true, isProblem: false });
  });

  it("formats a provisioned row with a relative timestamp, not as a problem", () => {
    const label = describeProvisionStatus(
      { machine_id: "m1", state: { kind: "provisioned", at_ms: NOW - 5 * 60_000 }, checked_at_ms: NOW },
      NOW,
    );
    expect(label.text).toBe("provisioned 5 min ago");
    expect(label.isProblem).toBe(false);
    expect(label.canRetry).toBe(true);
  });

  it("shows pending as in-flight and NOT retryable (a retry is already running)", () => {
    const label = describeProvisionStatus(
      { machine_id: "m1", state: { kind: "pending" }, checked_at_ms: NOW },
      NOW,
    );
    expect(label).toEqual({ text: "pending…", canRetry: false, isProblem: false });
  });

  it("surfaces the daemon's own refusal reason verbatim, as a problem", () => {
    const label = describeProvisionStatus(
      {
        machine_id: "m1",
        state: { kind: "failed", reason: "too many authorized phones (max 32) — remove one first" },
        checked_at_ms: NOW,
      },
      NOW,
    );
    expect(label.text).toBe("failed: too many authorized phones (max 32) — remove one first");
    expect(label.isProblem).toBe(true);
    expect(label.canRetry).toBe(true);
  });

  it("names a too-old daemon distinctly from a generic failure", () => {
    const label = describeProvisionStatus(
      { machine_id: "m1", state: { kind: "daemon_too_old" }, checked_at_ms: NOW },
      NOW,
    );
    expect(label.text).toBe("daemon too old — update flightdeckd");
    expect(label.isProblem).toBe(true);
    expect(label.canRetry).toBe(true);
  });
});
