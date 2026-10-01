// Prompt suggestions: the binary's prediction of the user's next message, shown as ghost
// text in an empty composer and taken with Tab (the terminal's own feature, piloted over
// stream-json — see the `prompt-suggestion-wire` notes in the repo context).
//
// In memory only, keyed by the conversation's STABLE id. A suggestion predicts the reply
// to the turn that just ended, so it is worthless across a restart and dies with the next
// turn: cleared on send and on the next busy edge (see `useGlobalSessionEvents`).
//
// Also holds which conversations have a composer ON SCREEN (a ref count: the conversation
// view and the Flight Deck reply modal can both mount one). `PromptSuggestionPauseHost`
// pauses generation for every live conversation that has none.
import { create } from "zustand";

interface PromptSuggestionsState {
  /** convId → the latest suggestion for that conversation's last turn. */
  byConv: Record<string, string>;
  /** convId → number of mounted composers showing that conversation. */
  onScreen: Record<string, number>;
  set: (convId: string, suggestion: string) => void;
  clear: (convId: string) => void;
  /** Register a mounted composer; returns its unregister. */
  mountComposer: (convId: string) => () => void;
}

export const usePromptSuggestions = create<PromptSuggestionsState>((set, get) => ({
  byConv: {},
  onScreen: {},
  set: (convId, suggestion) =>
    set((s) =>
      s.byConv[convId] === suggestion ? s : { byConv: { ...s.byConv, [convId]: suggestion } },
    ),
  clear: (convId) =>
    set((s) => {
      if (!(convId in s.byConv)) return s;
      const byConv = { ...s.byConv };
      delete byConv[convId];
      return { byConv };
    }),
  mountComposer: (convId) => {
    set((s) => ({ onScreen: { ...s.onScreen, [convId]: (s.onScreen[convId] ?? 0) + 1 } }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (get().onScreen[convId] ?? 1) - 1;
      set((s) => {
        const onScreen = { ...s.onScreen };
        if (left > 0) onScreen[convId] = left;
        else delete onScreen[convId];
        return { onScreen };
      });
    };
  },
}));

/** Live handles whose process was spawned with the opt-in. Only those can generate, so
 *  only those are ever told to pause — a session spawned without it never hears of the
 *  subtype (an older CLI would answer it with an error). Recorded at spawn. */
const optedInHandles = new Set<string>();

export function noteSuggestionsOptIn(handle: string, optedIn: boolean): void {
  if (optedIn) optedInHandles.add(handle);
  else optedInHandles.delete(handle);
}

export function isSuggestionsOptedIn(handle: string): boolean {
  return optedInHandles.has(handle);
}

/** This conversation's current suggestion, or null. */
export function usePromptSuggestion(convId: string): string | null {
  return usePromptSuggestions((s) => s.byConv[convId] ?? null);
}

/** Drop a conversation's suggestion (a send, a new turn, a rewind, a deletion). */
export function clearPromptSuggestion(convId: string): void {
  usePromptSuggestions.getState().clear(convId);
}

/**
 * Which live sessions to pause, given what is on screen. Pure, for the host and its test.
 *
 * Paused = the feature is off, or no composer shows the conversation. Only Claude sessions
 * are listed (Codex has no equivalent). `lastSent` is what each handle was last told; a
 * fresh process starts unpaused, so a handle never told anything counts as `false`.
 * Returns only the handles whose wanted state differs from that.
 */
export function pauseChanges(
  live: readonly { convId: string; handle: string }[],
  onScreen: Readonly<Record<string, number>>,
  enabled: boolean,
  lastSent: ReadonlyMap<string, boolean>,
): { handle: string; paused: boolean }[] {
  const out: { handle: string; paused: boolean }[] = [];
  for (const { convId, handle } of live) {
    const paused = !enabled || !(onScreen[convId] > 0);
    if ((lastSent.get(handle) ?? false) !== paused) out.push({ handle, paused });
  }
  return out;
}

/**
 * Whether a suggestion may show as ghost text right now: the composer is empty (no text,
 * no attachment), the agent is between turns, and the feature is on.
 */
export function showsGhost(opts: {
  suggestion: string | null;
  text: string;
  attachments: number;
  busy: boolean;
  enabled: boolean;
}): boolean {
  return (
    opts.enabled &&
    !!opts.suggestion &&
    !opts.busy &&
    opts.text.length === 0 &&
    opts.attachments === 0
  );
}
