import { create } from "zustand";

/**
 * One-shot trigger for the full-screen Ultracode activation animation.
 * The composer fires it the moment the switch turns ON; the global overlay
 * (mounted once in App) listens to `token` and replays on every increment.
 * Kept deliberately tiny and decoupled — no React import, no conversation state.
 */
interface UltraBlastState {
  /** Monotonic counter; each bump = one new blast to play. */
  token: number;
  fire: () => void;
}

export const useUltraBlast = create<UltraBlastState>((set) => ({
  token: 0,
  fire: () => set((s) => ({ token: s.token + 1 })),
}));
