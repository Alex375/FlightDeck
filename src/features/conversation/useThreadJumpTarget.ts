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
  jumpMissNote,
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

/** The sender's messaging card for `toolUseId`, or null for now. When clean output has folded
 *  it away, opens the block that holds it (the card mounts on a later frame): a closed block
 *  does not mount its children, only stamps their ids on itself (`data-jump-anchors`). */
function locateSentCard(root: HTMLElement, session: string, toolUseId: string): HTMLElement | null {
  const card = byData(root, "data-agent-msg-sent", "agentMsgSent", toolUseId);
  if (card) return card;
  for (const block of Array.from(root.querySelectorAll<HTMLElement>("[data-jump-anchors]"))) {
    const key = block.dataset.foldKey;
    if (key && block.dataset.jumpAnchors?.split(" ").includes(toolUseId)) {
      useWorkFold.getState().setOpen(session, key, true);
      break;
    }
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
  // An artifact publish is its own segment — never folded by clean output — so the card is
  // already mounted whenever its turn is; no fold to open, unlike a `send_message` card.
  if (anchor.kind === "artifact") {
    return byData(root, "data-artifact-publish", "artifactPublish", anchor.toolUseId);
  }
  // Already addressed by its tool_use id: no result to scan for the message id.
  if (anchor.kind === "sentTool") return locateSentCard(root, session, anchor.toolUseId);
  sent.toolUseId ??= findSentMessageToolUse(
    useConversationStore.getState().sessions[session],
    anchor.messageId,
  );
  const toolUseId = sent.toolUseId;
  if (!toolUseId) return null; // its result is not in the store yet
  return locateSentCard(root, session, toolUseId);
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
        pushInfoToast(jumpMissNote(anchor));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [request, session, scrollEl, release]);
}
