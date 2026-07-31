// Which repository the TOSSE repository card is open for, if any.
//
// A tiny shared slice, mirroring `extensionsUiStore` / `worktreeUiStore`: the badge that
// opens the card lives in the sidebar header, the card itself is mounted once at the app
// root — so the two communicate through here rather than through prop drilling.
import { create } from "zustand";

interface TosseRepoUiState {
  /** Flight Deck repo id the card is showing, or `null` when closed. */
  repoId: string | null;
  openCard: (repoId: string) => void;
  closeCard: () => void;
}

export const useTosseRepoUi = create<TosseRepoUiState>((set) => ({
  repoId: null,
  openCard: (repoId) => set({ repoId }),
  closeCard: () => set({ repoId: null }),
}));
