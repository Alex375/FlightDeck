// Wake-word status mirror — the shared, in-memory copy of the Rust
// `wake_word_status` truth (the detector's config + whether it is actually
// running). VoiceHost seeds it at boot and subscribes to it to gate the trigger;
// the Settings card updates it after every apply. One source, so the trigger gate
// and the Settings rows can never disagree. `null` = not read from the core yet.
import { create } from "zustand";
import type { WakeStatus } from "../ipc/client";

interface WakeState {
  status: WakeStatus | null;
  setStatus: (status: WakeStatus) => void;
}

export const useWakeStore = create<WakeState>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));

/** Whether the wake word is enabled right now (mirror), for the trigger gate. */
export function wakeEnabled(): boolean {
  return useWakeStore.getState().status?.enabled ?? false;
}
