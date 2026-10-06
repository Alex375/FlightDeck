// "Search folded work too" — while a conversation's find bar has it on, every clean-output fold
// of THAT conversation renders open, so its intermediate prose is in the DOM and searchable
// (a closed fold does not mount its children). Transient on purpose: it never touches the
// remembered open/closed state of each fold (workFold), so closing the bar puts the thread
// back exactly as the user left it — except the fold holding the hit they stopped on, which
// the find session opens for real (see useDomFind).
import { create } from "zustand";

interface FoldRevealState {
  /** conversation id → reveal every fold. */
  on: Record<string, true>;
  set: (conv: string, on: boolean) => void;
}

export const useFoldReveal = create<FoldRevealState>((set) => ({
  on: {},
  set: (conv, on) =>
    set((s) => {
      if (!!s.on[conv] === on) return s;
      const next = { ...s.on };
      if (on) next[conv] = true;
      else delete next[conv];
      return { on: next };
    }),
}));
