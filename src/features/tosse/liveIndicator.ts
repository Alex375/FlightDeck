// What the tasks toolbar says about the CRM live channel — a pure function, so what the
// indicator claims is pinned by tests rather than by reading JSX.
//
// The rule it encodes: this view must never look up-to-date while it is not. Everything
// else here is about NOT crying wolf — a reconnection is ordinary, and an indicator that
// flashes red at every blip is one nobody reads by the time it matters.

import type { TosseLiveStatus } from "../../ipc/client";

export interface LiveIndicatorView {
  /** Which colour the dot takes. */
  tone: "on" | "wait" | "err";
  /** The word next to the dot. */
  label: string;
  /** Hover text: always says what the state MEANS, and why when there is a reason. */
  title: string;
  /** Whether to offer a manual reconnection (only useful once retrying has given up). */
  retry: boolean;
}

/**
 * The indicator for a channel state, or `null` when nothing should be shown.
 *
 * `off` renders NOTHING on purpose: the channel only stops when there is no TOSSE session,
 * and the tasks view is already withdrawn in that case — a grey "not live" chip would be a
 * complaint about a connection nobody asked for.
 */
export function liveIndicatorView(status: TosseLiveStatus): LiveIndicatorView | null {
  switch (status.state) {
    case "off":
      return null;
    case "live":
      return {
        tone: "on",
        label: "Live",
        title: "Connected to TOSSE — this board follows changes made elsewhere.",
        retry: false,
      };
    case "connecting":
      return {
        tone: "wait",
        // First attempt vs recovering from a failure: the words differ because the second
        // one explains a delay the user may already have noticed.
        label: status.attempts > 0 ? "Reconnecting…" : "Connecting…",
        title: reasoned(
          status,
          "Connecting to TOSSE. The board still refreshes when you focus the window.",
        ),
        retry: false,
      };
    case "error":
      return {
        tone: "err",
        // Says what is FALSE about the view rather than what failed inside: the user's
        // question is "can I trust what I'm reading", not "which HTTP code came back".
        label: "Not live",
        title: reasoned(
          status,
          "Live updates from TOSSE stopped. The board still refreshes when you focus the window or press Refresh.",
        ),
        retry: true,
      };
  }
}

/** Append the core's reason when there is one — a degraded state that will not say why is a
 *  silent error wearing a colour. */
function reasoned(status: TosseLiveStatus, base: string): string {
  return status.detail ? `${base}\n\n${status.detail}` : base;
}
