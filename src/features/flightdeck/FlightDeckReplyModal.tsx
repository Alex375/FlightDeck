// The Flight Deck reply modal — a conversation opened in place over the dashboard,
// so an agent's question/permission/review can be handled WITHOUT switching to the
// full Conversation view. It mounts the exact same `ConversationPane` the main view
// uses (thread + pinned bars + composer), keyed by the STABLE conversation id, but
// deliberately WITHOUT the editor/terminal side panel — it stays light, for quick
// triage. A "Fullscreen" escape hatch promotes it to the real Conversation view.
//
// Store-driven (useFlightdeckModal): the attention actions on the stream cards open
// it; App mounts it once. `onPromote` is the only prop, since promoting needs the
// app-level view switch (openConversation).
//
// It opens the way Finder's Quick Look does: the panel grows out of the card that was
// clicked and shrinks back into it on close, so the modal is visibly THAT conversation
// rather than a dialog appearing from nowhere. See `modalZoom.ts` for the geometry.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ConversationPane } from "../conversation/ConversationPane";
import type { ComposerHandle } from "../conversation/ConductorComposer";
import { StreamControl } from "../conversation/StreamControl";
import { Dot, Ico } from "../../ui/kit";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { agentStatusToDot } from "../../agent/status";
import { useSessionState } from "../../store/conversationStore";
import {
  loadConversationHistory,
  repoName,
  useConversationRepo,
  useConversations,
  useConversationsStore,
} from "../../store/conversationsStore";
import { useDisplay, useEffectiveCleanOutput } from "../../store/display";
import { motionAllowed } from "../../ui/motion";
import { effectiveCwd } from "../git/worktree";
import { useFlightdeckModal } from "./flightdeckModalStore";
import {
  EASE_CLOSE,
  EASE_OPEN,
  ZOOM_IN_MS,
  ZOOM_OUT_MS,
  boxOf,
  viewportBox,
  visibleRegionOf,
  zoomTransform,
} from "./modalZoom";
import styles from "./FlightDeckReplyModal.module.css";

// Interactive elements whose clicks must NOT be hijacked to focus the composer —
// same list the full Conversation view uses.
const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="option"], [role="tab"], [contenteditable="true"]';

/** Whether the zoom may play at all — the app-wide policy (see `src/ui/motion.ts`) applied to
 *  this animation's own preference. Read imperatively at each open/close so flipping the
 *  setting takes effect immediately, without this component subscribing to it. */
const zoomAllowed = (): boolean => motionAllowed(useDisplay.getState().flightdeckModalZoom);

/** The card this conversation lives on RIGHT NOW, if it is still on the deck. Looked up by
 *  data attribute rather than kept as a ref: between opening and closing, the card may have
 *  been reordered, scrolled, or removed entirely. */
function liveCard(convId: string): Element | null {
  for (const el of document.querySelectorAll(".ag-card[data-conv-id]")) {
    if ((el as HTMLElement).dataset.convId === convId) return el;
  }
  return null;
}

export function FlightDeckReplyModal({ onPromote }: { onPromote: (id: string) => void }) {
  const convId = useFlightdeckModal((s) => s.convId);
  const close = useFlightdeckModal((s) => s.close);
  // Hooks stay above the early return so their order never changes between renders;
  // they no-op harmlessly on the empty id when the modal is closed.
  const conv = useConversations().find((c) => c.id === convId) ?? null;
  const repo = useConversationRepo(convId);
  const liveState = useSessionState(convId ?? "");
  const status = useAgentStatus(convId ?? "");
  // Effective clean-output for THIS conversation (per-conv override ?? global default).
  // The ⌘L shortcut is conversation-view-scoped and inert here, so the modal exposes
  // its own toggle in the header.
  const cleanOutput = useEffectiveCleanOutput(convId ?? "");
  const composerRef = useRef<ComposerHandle>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The exit animation runs BEFORE the store is cleared (that unmounts us), so a second
  // Escape / click while it plays must be ignored rather than restart it.
  const closingRef = useRef(false);
  const failsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The opening animations, kept so a dismissal that lands mid-flight can stop them before
  // measuring anything — a running transform makes every rect inside the panel report visual,
  // not layout, pixels.
  const entryRef = useRef<Animation[]>([]);

  // Grow out of the card that was clicked. A LAYOUT effect so the very first painted frame
  // is already the card-sized state — starting after paint would flash the full-size panel.
  // The panel keeps its final layout throughout; only a composited transform moves it.
  useLayoutEffect(() => {
    closingRef.current = false;
    // Any fail-safe left over from the previous close is now moot — and must go, or it
    // would slam shut a modal reopened within its delay.
    if (failsafeRef.current) clearTimeout(failsafeRef.current);
    failsafeRef.current = null;
    const scrim = scrimRef.current;
    const panel = panelRef.current;
    // A freshly-opened panel always takes clicks again, whatever the last exit left behind
    // (React unmounts it between openings today — this keeps that from being load-bearing).
    if (panel) panel.style.pointerEvents = "";
    entryRef.current = [];
    if (!convId || !scrim || !panel || !zoomAllowed()) return;
    // The card is measured through whatever clips it, not just against the window — a lane
    // hidden under the header/banner is not somewhere to fly from. See visibleRegionOf.
    const card = liveCard(convId);
    const from = zoomTransform(
      useFlightdeckModal.getState().origin,
      boxOf(panel),
      visibleRegionOf(card, viewportBox()),
    );
    const opts = { duration: ZOOM_IN_MS, easing: EASE_OPEN } as const;
    const anims = [
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], opts),
      panel.animate(
        [
          // No usable origin (opened with no card to point at, or a card off-screen) →
          // a plain fade with a hint of scale, instead of a lie about where it came from.
          { transform: from ?? "scale(0.97)", opacity: 0, offset: 0 },
          // Opaque well before the panel finishes travelling: the distorted early frames
          // are the ones worth hiding, not the ones near full size.
          { opacity: 1, offset: 0.45 },
          { transform: "none", opacity: 1, offset: 1 },
        ],
        opts,
      ),
    ];
    panel.style.willChange = "transform, opacity";
    // Kept so the exit can STOP them (see requestClose): while they run, the panel's box is
    // an animated one, and every rect read inside it lies.
    entryRef.current = anims;
    anims[1].onfinish = () => {
      panel.style.willChange = "";
      entryRef.current = [];
    };
    return () => {
      for (const a of anims) a.cancel();
      entryRef.current = [];
      panel.style.willChange = "";
    };
  }, [convId]);

  // Close by shrinking back into the card, THEN clearing the store (which unmounts us).
  // Every dismissal goes through here — Escape, the × button, a backdrop click.
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    const scrim = scrimRef.current;
    const panel = panelRef.current;
    const id = useFlightdeckModal.getState().convId;
    if (!id || !scrim || !panel || !zoomAllowed()) {
      close();
      return;
    }
    closingRef.current = true;
    // ⚠️ Dismissing DURING the opening zoom (a double-click, a quick Escape) used to measure
    // the panel through its own animation. `boxOf` is `getBoundingClientRect` — a VISUAL box —
    // while the maths below needs the panel's final LAYOUT box, so the exit was computed
    // against a half-grown panel: at ~27ms in, the measured box IS the card's, giving
    // `scale(1)` and no shrink at all; further in, the panel flew to a point between the modal
    // and the card, landing on nothing. So: read what is on screen right now, THEN stop the
    // entry — after which the panel measures its true layout box again.
    const shown = getComputedStyle(panel);
    const fromTransform = shown.transform && shown.transform !== "none" ? shown.transform : "none";
    const fromOpacity = Number.parseFloat(shown.opacity);
    const opaque = Number.isFinite(fromOpacity) ? fromOpacity : 1;
    const scrimOpacity = Number.parseFloat(getComputedStyle(scrim).opacity);
    for (const a of entryRef.current) a.cancel();
    entryRef.current = [];
    // Where the card is NOW — deliberately re-measured rather than reusing the box captured
    // at open time: the deck reorders itself as agents change state. When the card is gone
    // (or is hidden behind the header/banner, or clipped out of its lane), the panel fades in
    // place instead: shrinking into a remembered position would point at whatever sits there
    // now, and shrinking into a clipped one at nothing the user can see.
    const card = liveCard(id);
    const to = zoomTransform(boxOf(card), boxOf(panel), visibleRegionOf(card, viewportBox()));
    // The panel stops taking clicks while it flies away; the scrim keeps swallowing them,
    // so a stray click cannot reach the deck underneath and open another card mid-exit.
    panel.style.pointerEvents = "none";
    panel.style.willChange = "transform, opacity";
    // `fill: forwards` holds the final frame until React unmounts us — without it the
    // animation's end reverts to the natural styles for a frame, flashing the panel back.
    const opts = { duration: ZOOM_OUT_MS, easing: EASE_CLOSE, fill: "forwards" } as const;
    scrim.animate(
      [{ opacity: Number.isFinite(scrimOpacity) ? scrimOpacity : 1 }, { opacity: 0 }],
      opts,
    );
    const flight = panel.animate(
      [
        // Starting from what is ACTUALLY on screen, not from a hard-coded "none": a new
        // animation wins composite order, so an exit that assumed the settled state would
        // snap the panel to full size for one frame before shrinking — a visible pop,
        // measured at 348 → 1353px, whenever the dismissal caught the entry mid-flight.
        { transform: fromTransform, opacity: opaque, offset: 0 },
        // Holds the opacity it STARTED at rather than jumping to a hard 1 — identical to the
        // settled case (where that is 1), and no brightening pop when the entry was cut short.
        { opacity: opaque, offset: 0.45 },
        { transform: to ?? "scale(0.97)", opacity: 0, offset: 1 },
      ],
      opts,
    );
    flight.onfinish = () => close();
    // Fail-safe: a timeline that never fires `onfinish` (a hidden window pausing its
    // animations) must not strand a modal the user asked to close.
    failsafeRef.current = setTimeout(close, ZOOM_OUT_MS + 400);
  }, [close]);

  // Drop the fail-safe when we go away — including when something else (leaving the Flight
  // Deck view) closes the modal out from under an exit already in flight.
  useEffect(
    () => () => {
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
      failsafeRef.current = null;
    },
    [],
  );

  // Replay the on-disk transcript into the message store (idempotent, at most once
  // per conversation) exactly as the full view does on selection — so the thread is
  // populated even for a conversation never opened this run. Then focus the composer.
  useEffect(() => {
    if (!convId) return;
    void loadConversationHistory(convId);
    const t = setTimeout(() => composerRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [convId]);

  // Escape closes the modal, like the app's other dialogs — but ONLY if a nested
  // overlay inside the mounted ConversationPane (a drill-in TranscriptPopover /
  // TaskOutputPopover / WorkflowDetail / background-task badge) hasn't already consumed
  // it. Those popovers sit on `document` and call stopPropagation() on their Escape;
  // since keydown bubbles document→window, this window-level listener never fires when
  // an inner popover owns the key — so one Escape dismisses only the topmost layer.
  // (Fullscreen is protected globally by the capture-phase guard in App.tsx, so this no
  // longer needs to preventDefault or gate on defaultPrevented.)
  useEffect(() => {
    if (!convId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [convId, requestClose]);

  if (!convId || !conv) return null;

  const cwd = effectiveCwd(conv, liveState);

  // Click anywhere in the pane (but not on a control) → focus the composer: the same
  // "click to type" affordance as the full Conversation view.
  const focusComposerOnClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!window.getSelection()?.isCollapsed) return;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    composerRef.current?.focus();
  };

  return (
    <div
      ref={scrimRef}
      className={styles.scrim}
      // Close on a genuine backdrop click only. We must NOT stopPropagation on the
      // panel (the old approach): that swallowed clicks before they reached the
      // window-level listener the opener plugin installs for `<a target="_blank">`,
      // so links in Claude's messages were dead in the modal but worked in the full view.
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div ref={panelRef} className={styles.panel} role="dialog" aria-modal>
        <div className={styles.head}>
          <Dot s={agentStatusToDot(status)} pulse />
          <span className={styles.title} title={conv.name}>
            {conv.name}
          </span>
          {repo ? <span className={styles.repo}>· {repoName(repo.path)}</span> : null}
          <span className={styles.spacer} />
          {/* Stream display controls, brought back from the classic conversation view:
              the clean-output toggle (⌘L is inert in the modal) and the stream on/off
              control. `portal` on the latter so its menu escapes the panel's overflow clip. */}
          <button
            type="button"
            role="switch"
            aria-checked={cleanOutput}
            className={styles.iconBtn}
            onClick={() =>
              useConversationsStore.getState().setConvCleanOutput(convId, !cleanOutput)
            }
            title="Clean output — show only the final message of each response; fold the intermediate work (tools, thinking, steps)"
            aria-label="Clean output"
            style={
              cleanOutput ? { borderColor: "var(--wf-accent)", color: "var(--wf-accent)" } : undefined
            }
          >
            <Ico name="list" className="sm" />
          </button>
          <StreamControl conv={conv} portal />
          <button
            className={styles.headBtn}
            onClick={() => onPromote(convId)}
            title="Open in the conversation view"
          >
            <Ico name="external" className="sm" />
            Fullscreen
          </button>
          <button
            className={styles.iconBtn}
            onClick={requestClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            <Ico name="x" className="sm" />
          </button>
        </div>
        <div className={styles.body}>
          {/* The exact conversation column of the main view — no SidePanel (editor/
              terminal), keeping the modal light. Keyed by the stable id. File mentions
              are inert here: there is no editor host to reveal them in. */}
          <ConversationPane
            key={convId}
            session={convId}
            cwd={cwd}
            composerRef={composerRef}
            onBackgroundClick={focusComposerOnClick}
            inertMentions
            disableMessageControls
          />
        </div>
      </div>
    </div>
  );
}
