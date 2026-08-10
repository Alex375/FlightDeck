// Which conversation is open in the Flight Deck reply modal, if any. A tiny shared
// slice so the stream cards' attention actions (StateActions) can open the modal
// without threading a callback down through FlightDeck → StreamCard, mirroring the
// store-driven pattern of the other globally-mounted dialogs (worktreeUiStore,
// extensions manager, history panel). Live-only, keyed by the STABLE conversation
// id — the modal reads everything else by that id, independent of the app's single
// "active conversation" selection.
import { create } from "zustand";
import type { Box } from "./modalZoom";

interface FlightdeckModalState {
  /** Stable id of the conversation shown in the modal, or null when closed. */
  convId: string | null;
  /** Screen box of the card the modal was opened FROM, captured at click time — the start
   *  point of the zoom (see {@link zoomTransform}). Null when the opener had no card to point
   *  at, in which case the modal just fades in. Only the ENTRY reads it: the exit re-measures
   *  the card live, since the deck reorders itself while the modal is open. */
  origin: Box | null;
  open: (convId: string, origin?: Box | null) => void;
  close: () => void;
}

export const useFlightdeckModal = create<FlightdeckModalState>((set) => ({
  convId: null,
  origin: null,
  open: (convId, origin) => set({ convId, origin: origin ?? null }),
  close: () => set({ convId: null, origin: null }),
}));
