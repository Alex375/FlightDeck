// The TOSSE live channel's health, as the UI reads it.
//
// Live-only and app-global (one connection for the whole app), so nothing here is
// persisted: on a fresh launch the channel is genuinely `off` until the host starts it, and
// a remembered "live" would be a claim about a socket that does not exist yet.
//
// It exists so the indicator can be rendered anywhere without every surface subscribing to
// the Tauri event bus — {@link TosseLiveHost} is the single writer.

import { create } from "zustand";
import type { TosseLiveStatus } from "../ipc/client";

/** Nothing running: the state before the first start, and after any stop. */
const OFF: TosseLiveStatus = { state: "off", detail: null, attempts: 0, connections: 0 };

interface TosseLiveState {
  status: TosseLiveStatus;
  set: (status: TosseLiveStatus) => void;
}

export const useTosseLive = create<TosseLiveState>((set) => ({
  status: OFF,
  set: (status) => set({ status }),
}));

/**
 * Whether the channel is failing in a way the user should SEE.
 *
 * Deliberately not "anything other than live": a single reconnection is normal (a lid
 * closed, a Railway redeploy) and flashing a warning at every blip would train the eye to
 * ignore the one that matters. The core only reports `error` once the failures have piled
 * up — see `FAILURES_BEFORE_ERROR` in `tosse/sse.rs`.
 */
export function isLiveChannelBroken(status: TosseLiveStatus): boolean {
  return status.state === "error";
}
