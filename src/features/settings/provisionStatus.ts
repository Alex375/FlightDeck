// Pure formatting for the per-server phone-provisioning status row (C10/C11) —
// kept separate from ControlSection.tsx so it's unit-testable without mounting
// React, the same split as `parseTicket`/`buildServerCommand` in that file.
import type { MachineProvisionStatus, ProvisionState } from "../../ipc/client";
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
