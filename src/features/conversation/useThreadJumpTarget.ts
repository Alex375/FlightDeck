// The receiving half of a cross-conversation jump (see store/threadJump.ts): the pane that
// shows the target conversation finds the anchored message in its thread, scrolls it into
// the middle of the view and flashes it.
//
// The message is often not there yet — the conversation was cold and its history is still
// loading, or (on the sender's side) the "message sent" card is folded inside a closed
// clean-output block, which does not mount its children. So the lookup runs frame by frame:
// it opens the block holding the card when it meets one, keeps looking until the card
// renders, and gives up with a visible note rather than silently leaving the user at the
// wrong place. Once found, it keeps the message in place for a moment while late content
// (the rest of the history) lands above it.

import { useEffect, type RefObject } from "react";
import { useConversationStore } from "../../store/conversationStore";
import {
  JUMP_TIMEOUT_MS,
  jumpRequestExpired,
  useThreadJump,
  type JumpAnchor,
} from "../../store/threadJump";
import { pushInfoToast } from "../../store/toasts";
import { useWorkFold } from "../../store/workFold";
import { verticalScaleOfEl } from "../../ui/visualScale";
import { findSentMessageToolUse } from "./agentMessage";

/** How long the target is held in place once found. */
const SETTLE_MS = 900;
const FLASH_MS = 1800;
/** Distance (layout px) from its wanted place tolerated before the target is revealed again. */
const DRIFT_PX = 24;

/** First element under `root` whose `data-*` attribute equals `value`. Matched on the dataset
 *  rather than through a selector: ids built into a selector would need escaping. */
function byData(root: HTMLElement, attr: string, key: string, value: string): HTMLElement | null {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`))) {
    if (node.dataset[key] === value) return node;
  }
  return null;
}

/** The anchored element, or null for now. May open a fold as a side effect (sender side).
 *  `sent` remembers the tool_use id once resolved, so later frames skip the result scan. */
function locate(
  root: HTMLElement,
  session: string,
  anchor: JumpAnchor,
  sent: { toolUseId: string | null },
): HTMLElement | null {
  if (anchor.kind === "received") return byData(root, "data-agent-msg", "agentMsg", anchor.messageId);
  sent.toolUseId ??= findSentMessageToolUse(
    useConversationStore.getState().sessions[session],
    anchor.messageId,
  );
  const toolUseId = sent.toolUseId;
  if (!toolUseId) return null; // its result is not in the store yet
  const card = byData(root, "data-agent-msg-sent", "agentMsgSent", toolUseId);
  if (card) return card;
  // Folded away under clean output: open the block that holds it; the card mounts later.
  for (const block of Array.from(root.querySelectorAll<HTMLElement>("[data-jump-anchors]"))) {
    const key = block.dataset.foldKey;
    if (key && block.dataset.jumpAnchors?.split(" ").includes(toolUseId)) {
      useWorkFold.getState().setOpen(session, key, true);
      break;
    }
  }
  return null;
}

/** The element's top relative to the scroll container's top, in LAYOUT px (the Flight Deck
 *  modal can scale an ancestor, and `scrollTop` is always layout px). */
function offsetInView(root: HTMLElement, el: HTMLElement): number {
  const scale = verticalScaleOfEl(root) || 1;
  return (el.getBoundingClientRect().top - root.getBoundingClientRect().top) / scale;
}

/** Where the element should sit: in the middle — or near the top when taller than the view. */
function wantedOffset(root: HTMLElement, el: HTMLElement): number {
  return Math.max(16, (root.clientHeight - el.offsetHeight) / 2);
}

function reveal(root: HTMLElement, el: HTMLElement): void {
  root.scrollTop = Math.max(0, root.scrollTop + offsetInView(root, el) - wantedOffset(root, el));
}

export function useThreadJumpTarget(
  session: string,
  scrollEl: RefObject<HTMLDivElement | null>,
  release: () => void,
): void {
  const request = useThreadJump((s) => (s.request?.convId === session ? s.request : null));

  useEffect(() => {
    if (!request) return;
    const { anchor, nonce } = request;
    const settle = () => useThreadJump.getState().settle(nonce);
    if (!anchor) {
      settle(); // nothing to scroll to: opening the conversation was the whole jump
      return;
    }
    // Left before its target rendered (the pane unmounted without settling — deliberately:
    // StrictMode's remount would kill every jump): a late visit must not replay it.
    if (jumpRequestExpired(request, performance.now())) {
      settle();
      return;
    }
    const sent = { toolUseId: null as string | null };
    let found: HTMLElement | null = null;
    let foundAt = 0;
    let raf = 0;
    const tick = () => {
      const root = scrollEl.current;
      const now = performance.now();
      if (found && !found.isConnected) found = null; // remounted meanwhile: look again
      if (root && !found) {
        const el = locate(root, session, anchor, sent);
        if (el) {
          found = el;
          foundAt = now;
          release();
          reveal(root, el);
          el.dataset.jumpFlash = "1";
          window.setTimeout(() => delete el.dataset.jumpFlash, FLASH_MS);
        }
      } else if (root && found) {
        if (now - foundAt > SETTLE_MS) {
          settle();
          return;
        }
        // The thread is still moving: a fold opening around the card (its height animates, so
        // the first scroll was clamped short) or late history landing above it. Reveal again.
        if (Math.abs(offsetInView(root, found) - wantedOffset(root, found)) > DRIFT_PX) reveal(root, found);
      }
      if (!found && now - request.at > JUMP_TIMEOUT_MS) {
        settle();
        pushInfoToast(
          anchor.kind === "sent"
            ? "Couldn't find where that message was sent in this conversation."
            : "Couldn't find that message in this conversation.",
        );
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [request, session, scrollEl, release]);
}
