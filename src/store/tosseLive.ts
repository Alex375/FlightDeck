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

// NOTE: "is the channel broken?" deliberately has no helper here. The one surface that asks
// is the Tasks-view indicator, and it asks a richer question (what to SAY, and whether to
// offer a reconnect) answered in one pure place — `features/tosse/liveIndicator.ts`. A second
// predicate spelling the same rule differently is how the two drift.
