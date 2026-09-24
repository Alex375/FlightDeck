import { beforeEach, describe, expect, it } from "vitest";
import type { ServerDiagnosis } from "../ipc/client";
import {
  healthFromDiagnosis,
  isUnreachable,
  resetProbeStateForTests,
  useMachineHealthStore,
  type MachineHealth,
} from "./machineHealth";

const diagnosis = (over: Partial<ServerDiagnosis> = {}): ServerDiagnosis => ({
  state: { kind: "ready" },
  reachable: true,
  link_issue: null,
  tailscale_off_locally: null,
  installed_as: "system",
  daemon_running: true,
  daemon_version_disk: "0.4.2",
  daemon_version_running: "0.4.2",
  restart_pending: false,
  reboot_safe: true,
  linger: null,
  sleep_masked: true,
  user_unit_missing_path: null,
  claude_installed: true,
  claude_logged_in: true,
  claude_email: "a@b.com",
  tailscale_name: null,
  last_boot: null,
  busy_conversations: 0,
  bundled_daemon_version: null,
  daemon_outdated: false,
  ...over,
});

const unreachable = () =>
  diagnosis({
    reachable: false,
    state: { kind: "failed", reason: "could not reach the server" },
    installed_as: "unknown",
    daemon_running: null,
    claude_installed: null,
    claude_logged_in: null,
    claude_email: null,
    reboot_safe: null,
    sleep_masked: null,
  });

describe("healthFromDiagnosis", () => {
  it("files a reachable server with no reason and stamps when it answered", () => {
    const h = healthFromDiagnosis(undefined, diagnosis(), 1_000);
    expect(h).toEqual<MachineHealth>({
      reachable: true,
      checkedAtMs: 1_000,
      lastReachedAtMs: 1_000,
      reason: null,
      probeError: null,
    });
  });

  it("carries the last time the machine answered across an unreachable verdict", () => {
    const up = healthFromDiagnosis(undefined, diagnosis(), 1_000);
    const down = healthFromDiagnosis(up, unreachable(), 5_000);
    expect(down.reachable).toBe(false);
    expect(down.checkedAtMs).toBe(5_000);
    // What lets the tooltip say "last reached 4 min ago" instead of just "down".
    expect(down.lastReachedAtMs).toBe(1_000);
    expect(down.reason).toBe("could not reach the server");
  });

  // ⚠️ THE trap this whole field exists for. `DiagnosisState::Failed` is what a server
  // that answers ssh perfectly well produces when its `flightdeckd` is simply stopped —
  // a machine that is up, and one repair click away. Deriving "unreachable" from the
  // state (or from its reason wording) would paint that machine red and send the user
  // hunting a network problem that does not exist.
  it("keeps a reachable server reachable even when its diagnosis failed", () => {
    const h = healthFromDiagnosis(
      undefined,
      diagnosis({
        reachable: true,
        state: { kind: "failed", reason: "flightdeckd is not running" },
        daemon_running: false,
      }),
      1_000,
    );
    expect(h.reachable).toBe(true);
    expect(isUnreachable(h)).toBe(false);
    expect(h.reason).toBeNull();
  });

  it("clears a stale probe error as soon as a real verdict lands", () => {
    const stuck: MachineHealth = {
      reachable: true,
      checkedAtMs: 0,
      lastReachedAtMs: null,
      reason: null,
      probeError: "machine not found",
    };
    expect(healthFromDiagnosis(stuck, diagnosis(), 2_000).probeError).toBeNull();
  });
});

describe("isUnreachable", () => {
  it("is false for a machine nobody has checked yet", () => {
    expect(isUnreachable(undefined)).toBe(false);
  });

  // Never accuse a server on a guess: a row that exists only because a probe COMMAND
  // failed carries no verdict, and must render exactly like a healthy machine.
  it("is false for a row that only ever recorded a probe error", () => {
    useMachineHealthStore.setState({ byMachine: {} });
    useMachineHealthStore.getState().recordProbeError("m1", "machine not found");
    expect(isUnreachable(useMachineHealthStore.getState().byMachine.m1)).toBe(false);
    expect(useMachineHealthStore.getState().byMachine.m1.probeError).toBe("machine not found");
  });

  it("is true only once a real round trip came back empty-handed", () => {
    useMachineHealthStore.setState({ byMachine: {} });
    useMachineHealthStore.getState().record("m1", unreachable());
    expect(isUnreachable(useMachineHealthStore.getState().byMachine.m1)).toBe(true);
  });
});

describe("the store", () => {
  beforeEach(() => {
    useMachineHealthStore.setState({ byMachine: {} });
    resetProbeStateForTests();
  });

  it("keeps the previous verdict when a probe could not even run", () => {
    useMachineHealthStore.getState().record("m1", diagnosis());
    useMachineHealthStore.getState().recordProbeError("m1", "ssh binary missing");
    const h = useMachineHealthStore.getState().byMachine.m1;
    expect(h.reachable).toBe(true);
    expect(h.probeError).toBe("ssh binary missing");
  });

  // A stale "unreachable" must not outlive the server it described — an unpaired
  // machine's row goes with it.
  it("forgets an unpaired machine", () => {
    useMachineHealthStore.getState().record("m1", unreachable());
    useMachineHealthStore.getState().forget("m1");
    expect(useMachineHealthStore.getState().byMachine.m1).toBeUndefined();
  });

  it("keeps machines apart", () => {
    useMachineHealthStore.getState().record("m1", unreachable());
    useMachineHealthStore.getState().record("m2", diagnosis());
    expect(isUnreachable(useMachineHealthStore.getState().byMachine.m1)).toBe(true);
    expect(isUnreachable(useMachineHealthStore.getState().byMachine.m2)).toBe(false);
  });

  // ⚠️ The mount probe of the Settings card is bounded at 20s against a dead server,
  // and "Retry" is clickable while it is still in flight. Ordering by ARRIVAL let the
  // slow "unreachable" land on top of the fresh "ready" and re-redden the sidebar mark,
  // the composer band and the card — undoing the re-check the user had just asked for.
  it("ignores a verdict from a probe that was fired before the one already applied", () => {
    useMachineHealthStore.getState().record("m1", diagnosis(), 5_000); // Retry, fired late, answered first
    useMachineHealthStore.getState().record("m1", unreachable(), 1_000); // mount probe, fired first, times out later
    expect(isUnreachable(useMachineHealthStore.getState().byMachine.m1)).toBe(false);
  });

  it("still applies a verdict from a probe fired after the one already applied", () => {
    useMachineHealthStore.getState().record("m1", diagnosis(), 1_000);
    useMachineHealthStore.getState().record("m1", unreachable(), 5_000);
    expect(isUnreachable(useMachineHealthStore.getState().byMachine.m1)).toBe(true);
  });

  // A caller with no provenance to give is treated as current rather than dropped: an
  // answer must never be swallowed just because it arrived unlabelled.
  it("applies a verdict recorded without a start stamp", () => {
    useMachineHealthStore.getState().record("m1", diagnosis(), 5_000);
    useMachineHealthStore.getState().record("m1", unreachable());
    expect(isUnreachable(useMachineHealthStore.getState().byMachine.m1)).toBe(true);
  });

  it("ignores a stale probe ERROR too, so it cannot shadow a fresher answer", () => {
    useMachineHealthStore.getState().record("m1", diagnosis(), 5_000);
    useMachineHealthStore.getState().recordProbeError("m1", "ssh timed out", 1_000);
    expect(useMachineHealthStore.getState().byMachine.m1.probeError).toBeNull();
  });
});
