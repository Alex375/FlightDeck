// Cross-conversation navigation to ONE message: "open that conversation and scroll to the
// place where this exchange happened". Used by both sides of an agent-to-agent message (the
// recipient's card jumps to the sender's `send_message` call, the sender's card jumps to the
// arrival) and by the toast that announces it.
//
// Split in two halves because no single component can do both: the click happens in one
// thread, the scroll must happen in whichever pane ends up showing the OTHER conversation —
// possibly a cold one that still has to load its history. So the click only records a
// request here; `App` switches to the conversation view on it, and the pane showing the
// target conversation resolves the anchor once it is rendered (`useThreadJumpTarget`), then
// settles the request.

import { create } from "zustand";
import { useConversationsStore } from "./conversationsStore";

export type JumpAnchor =
  /** The recipient's card for a message (`data-agent-msg`). */
  | { kind: "received"; messageId: string }
  /** The sender's `send_message` card, found through the message id its result echoes. */
  | { kind: "sent"; messageId: string };

export interface JumpRequest {
  convId: string;
  /** `null` = just open the conversation (e.g. a message sent before message ids existed). */
  anchor: JumpAnchor | null;
  /** Distinguishes two clicks on the same target, so the second one scrolls again. */
  nonce: number;
  /** When it was asked (`performance.now()`): the deadline runs from the click, not from
   *  whenever a pane gets to it. */
  at: number;
}

/** How long a jump may look for its target — long enough for a cold transcript to load and a
 *  fold to open. Past it, a request nobody settled (its pane was left before the target
 *  rendered) is dead: a later visit to that conversation must not replay it. */
export const JUMP_TIMEOUT_MS = 6000;

/** Has this request outlived its deadline? Pure, for the pane that picks it up. */
export function jumpRequestExpired(request: JumpRequest, now: number): boolean {
  return now - request.at > JUMP_TIMEOUT_MS;
}

interface ThreadJumpState {
  request: JumpRequest | null;
  /** Clear the request once handled — only if it is still the one that was handled. */
  settle: (nonce: number) => void;
}

let seq = 0;

export const useThreadJump = create<ThreadJumpState>((set) => ({
  request: null,
  settle: (nonce) => set((s) => (s.request?.nonce === nonce ? { request: null } : s)),
}));

/** Select `convId` and ask for its thread to be shown, scrolled to `anchor` when set. */
export function openConversationAt(convId: string, anchor: JumpAnchor | null): void {
  useConversationsStore.getState().selectConversation(convId);
  useThreadJump.setState({ request: { convId, anchor, nonce: ++seq, at: performance.now() } });
}
