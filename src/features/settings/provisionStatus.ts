// Pure formatting for the per-server phone-provisioning status row (C10/C11) —
// kept separate from ControlSection.tsx so it's unit-testable without mounting
// React, the same split as `parseTicket`/`buildServerCommand` in that file.
import type { MachineProvisionStatus, MachineRevokeStatus, ProvisionState } from "../../ipc/client";
import { timeAgo } from "../history/historyView";

/** What a status row shows, plus whether it's worth offering a Retry button. */
export interface ProvisionStatusLabel {
  /** The row's status text (e.g. "provisioned 3 min ago", "failed: …"). */
  text: string;
  /** Whether a Retry button makes sense here — everything except a live "pending". */
  canRetry: boolean;
  /** Render with the danger/warning treatment (failed / daemon too old). */
  isProblem: boolean;
}

/**
 * Describes one machine's phone-provisioning status for display, or the
 * "never attempted this run" case when `phone_provisioning_status` has no
 * entry for it yet (a fresh launch, or remote access has never been on) —
 * not a failure, just nothing to report.
 */
export function describeProvisionStatus(
  status: MachineProvisionStatus | undefined,
  nowMs: number,
): ProvisionStatusLabel {
  if (!status) {
    return { text: "not checked yet", canRetry: true, isProblem: false };
  }
  return describeProvisionState(status.state, nowMs);
}

function describeProvisionState(state: ProvisionState, nowMs: number): ProvisionStatusLabel {
  switch (state.kind) {
    case "provisioned":
      return { text: `provisioned ${timeAgo(state.at_ms, nowMs)}`, canRetry: true, isProblem: false };
    case "pending":
      return { text: "pending…", canRetry: false, isProblem: false };
    case "failed":
      return { text: `failed: ${state.reason}`, canRetry: true, isProblem: true };
    case "daemon_too_old":
      return { text: "daemon too old — update flightdeckd", canRetry: true, isProblem: true };
  }
}

/**
 * Describes one machine's phone-REVOCATION status (the "did the OLD token
 * actually get forgotten here" row, C10's critical fix) — `null` when
 * `phone_revocation_status` has no entry for it, which just means no
 * revocation was ever attempted against this machine this run (the common
 * case: a revoke only runs when the user regenerates pairing) — nothing to
 * show, not a problem. Unlike provisioning there is no dedicated retry
 * action: an unreachable/refused/too-old daemon is retried automatically the
 * next time it's successfully contacted (including as a side effect of the
 * provisioning "Retry" button above it), so this never offers its own button.
 */
export function describeRevokeStatus(
  status: MachineRevokeStatus | undefined,
  nowMs: number,
): ProvisionStatusLabel | null {
  if (!status) return null;
  switch (status.outcome.kind) {
    case "removed":
      return { text: `old access revoked ${timeAgo(status.checked_at_ms, nowMs)}`, canRetry: false, isProblem: false };
    case "queued":
      return {
        text: "old access: server unreachable — will revoke automatically once it's back",
        canRetry: false,
        isProblem: true,
      };
    case "daemon_too_old":
      return { text: "old access: daemon too old to revoke — update flightdeckd", canRetry: false, isProblem: true };
    case "failed":
      return { text: `old access: revoke failed: ${status.outcome.reason}`, canRetry: false, isProblem: true };
  }
}
