// A column of small bars floating over the RIGHT edge of the conversation — one per
// message the user sent, oldest at the top. Hovering a bar previews that message (its
// saved summary, or the message in full — a preference); clicking it scrolls the thread
// to it. It is the "where am I in this conversation" map: past a few rounds, a long
// thread has no landmarks except your own asks.
//
// Design decisions (chosen with Alexandre, see the task):
//  - FLOATING overlay, not a flex column: the thread keeps 100% of its width. The column
//    is quiet at rest and comes forward on hover.
//  - The whole conversation ALWAYS fits — bars are laid out at a percentage of the
//    column's height rather than stacked, so 200 messages compress instead of scrolling
//    the minimap. Below ~2px of slot they overlap slightly; that is the accepted cost of
//    keeping the overview whole.
//  - Shown on every surface that mounts the thread (conversation, Flight Deck reply
//    modal, Git workspace) — one affordance, everywhere.
//
// Anchoring: each user bubble carries `data-user-turn=<turnId>` (see MsgUser and the
// clean-output InlineUserMarker). We match on THAT id, never on index, because clean
// output can leave a folded message unrendered — an index-aligned lookup would then
// scroll to the wrong bubble. All queries are scoped to the pane element, since up to 3
// ConversationPanes can be mounted at once and a document-wide lookup would hit another
// instance (the same trap LastMessagePin documents).

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { useDisplay, type MinimapHoverMode } from "../../store/display";
import { useUserMessageMarks, type UserMessageMark } from "../../store/conversationStore";
import { summaryKey, summaryPreview, useMessageSummaries } from "../../store/lastMessageSummary";
import { userMessagePreviewText } from "./userText";

/** Max characters of the one-line label in "summary" mode when no summary was saved for
 *  the message. Longer than the Flight Deck's 46: this line is the ONLY thing telling two
 *  asks apart, and the tooltip has the width to spare. */
const LABEL_MAX = 90;

/** Max characters shown in "full" mode — a guard against a pasted wall of text turning the
 *  hover into a full-screen panel. The CSS line-clamp is the visual limit; this one keeps
 *  the DOM node small. */
const FULL_MAX = 1200;

/** How far below the thread's top edge the "you are here" line sits, in px. A message is
 *  the current one once its top has scrolled past this line. */
const ACTIVE_LINE_PX = 96;

/** Keep the hover preview clear of the column's bottom edge, in px. */
const TIP_BOTTOM_PAD_PX = 14;

/** The preview's own top padding (`.cv-mmap-tip` in CSS). The preview is lifted by this
 *  much so its FIRST LINE OF TEXT — not its border — lands on the hovered mark: the point
 *  of top-aligning it is that the eye falls straight on the start of the message.
 *  ⚠️ Keep in step with the CSS padding-top. */
const TIP_TEXT_INSET_PX = 7;

/**
 * How long the pointer must settle on a mark before its message is previewed, in ms.
 *
 * Without it, sweeping the column fires a hover per mark crossed and the preview strobes
 * through a dozen messages — unreadable, and it makes a deliberate hover feel twitchy. The
 * delay is the difference between "passing over" and "asking about" a mark. It gates ONLY
 * the preview card: the magnification stays instant, since that is the feedback that has to
 * track the cursor for the column to feel alive.
 */
const HOVER_INTENT_MS = 120;

/** How many neighbours on each side the dock magnification reaches. */
const DOCK_RANGE = 3;

/** How far a neighbour is pushed away, per unit of magnification, in px. */
const DOCK_SPREAD_PX = 3;

/** Fewer than this many messages and there is nothing to navigate — the column would be
 *  decoration. */
const MIN_MARKS = 2;

/** Distance between two consecutive bars at rest, in px. Small on purpose: the bars read
 *  as ONE condensed block, not as a scale running down the page — but with enough air
 *  between them that the block breathes (Alexandre's call, ~+65% over the first build). */
const PITCH_PX = 10;

/** How close to the end counts as "scrolled to the bottom", in px. A couple of pixels of
 *  slack absorbs fractional scroll heights (zoom, non-integer DPI). */
const BOTTOM_EPSILON_PX = 4;

/** The tallest the block is ever allowed to get, as a share of the column. Past this the
 *  pitch tightens instead — the block stays a block, centred, rather than growing into a
 *  full-height ladder. */
const MAX_BLOCK_RATIO = 0.45;

/**
 * Distance between two consecutive bars. Fixed at rest, tightening only once the block
 * would outgrow its share of the column — which is what keeps a 300-message conversation
 * inside the same compact shape as a 5-message one. Bars start to touch (and then overlap)
 * past ~150 messages; that is the accepted cost of never scrolling the minimap.
 */
export function minimapPitchPx(columnHeight: number, count: number): number {
  if (count <= 1 || !(columnHeight > 0)) return PITCH_PX;
  // (count - 1) gaps span the block: that is the distance from the first bar to the last.
  return Math.min(PITCH_PX, (columnHeight * MAX_BLOCK_RATIO) / (count - 1));
}

/** Height of the whole block of bars, in px. */
export function minimapBlockHeightPx(columnHeight: number, count: number): number {
  return count <= 1 ? 0 : minimapPitchPx(columnHeight, count) * (count - 1);
}

/**
 * Vertical placement of bar `i`, in px from the column's top. The block is CENTRED in the
 * column: the conversation reads as one compact object floating at mid-height, rather than
 * as marks spread edge to edge.
 */
export function markOffsetPx(index: number, count: number, columnHeight: number): number {
  const centre = columnHeight / 2;
  if (count <= 1) return centre;
  const pitch = minimapPitchPx(columnHeight, count);
  return centre + (index - (count - 1) / 2) * pitch;
}

/**
 * The text shown when hovering a bar. `summary` mode prefers the summary already
 * generated for that message (saved on generation — see `lastMessageSummary`) and falls
 * back to a truncation for messages that never got one (short messages and slash commands
 * are deliberately never summarized: the truncation IS the message). `full` mode shows the
 * message as sent, capped.
 *
 * Both modes go through `userMessagePreviewText` first, so a slash command reads as
 * `/pickup <id>` rather than the CLI's raw `<command-name>` wrapper.
 */
export function resolveMessageLabel(
  text: string,
  mode: MinimapHoverMode,
  summaries: Record<string, string>,
): string {
  if (!text.trim()) return "[image]"; // image-only send: no text to preview
  const clean = userMessagePreviewText(text);
  if (mode === "full") return clean.length > FULL_MAX ? clean.slice(0, FULL_MAX) + "…" : clean;
  // The summary is keyed by the RAW message text — that is what was sent for generation.
  return summaries[summaryKey(text)] ?? summaryPreview(clean, LABEL_MAX);
}

/**
 * Dock-style magnification: how much bar `distance` marks away from the cursor swells,
 * from 1 (the one under the cursor) down to 0 (out of reach). A raised cosine, so the
 * swell eases in and out instead of breaking into a visible cone.
 */
export function dockMagnification(distance: number): number {
  const d = Math.abs(distance);
  if (d >= DOCK_RANGE) return 0;
  return (1 + Math.cos((Math.PI * d) / DOCK_RANGE)) / 2;
}

/**
 * How far bar `index` is pushed away from the hovered one, in px (negative = upwards).
 *
 * This is the CUMULATIVE room the swollen bars between them take up — half of the hovered
 * bar's own growth, plus all of each bar in between — which is what makes the block part
 * around the cursor like the Dock, rather than every bar sliding by the same amount.
 * Past `DOCK_RANGE` nothing more is added, so distant bars all settle at the same small
 * offset instead of drifting further and further.
 *
 * Bounded by DOCK_RANGE, not by the conversation's length.
 */
export function dockPushPx(index: number, hoveredIndex: number): number {
  if (hoveredIndex < 0 || index === hoveredIndex) return 0;
  const direction = index > hoveredIndex ? 1 : -1;
  const distance = Math.abs(index - hoveredIndex);
  let room = dockMagnification(0) / 2; // the hovered bar pushes with half its own growth
  for (let d = 1; d < distance && d < DOCK_RANGE; d++) room += dockMagnification(d);
  return direction * room * DOCK_SPREAD_PX;
}

/**
 * Where the hover preview sits and how tall it may get: its first line of text lands on the
 * hovered mark, and it may use whatever room is left below.
 *
 * Capping the height (rather than sliding the preview up when it doesn't fit) is what keeps
 * the top alignment unconditional. The block is centred and never taller than ~45% of the
 * column, so the lowest mark still leaves ~a quarter of the height below it — enough for a
 * useful preview, and summary mode is a single line that always fits.
 */
export function tipStyle(markTop: number, columnHeight: number): { top: string; maxHeight: string } {
  const top = Math.max(0, markTop - TIP_TEXT_INSET_PX);
  return {
    top: `${top.toFixed(2)}px`,
    maxHeight: `${Math.max(0, columnHeight - top - TIP_BOTTOM_PAD_PX).toFixed(2)}px`,
  };
}

/** An anchor found in the thread: its message id and the distance of its top edge from the
 *  top of the scroll viewport. */
export interface AnchorTop {
  id: string;
  top: number;
}

/**
 * Which message you are currently reading: the LAST anchor whose top has crossed `line`.
 * Anchors arrive in document order, so this is simply the last one at or above the line;
 * before the first has crossed (you are at the very top) there is no current message.
 *
 * Pure, so the "which bar lights up" rule is locked by a test rather than by scrolling.
 */
export function activeAnchorId(anchors: AnchorTop[], line: number): string | null {
  let active: string | null = null;
  for (const a of anchors) {
    if (a.top > line) break;
    active = a.id;
  }
  return active;
}

/**
 * Whether the thread is scrolled to its end.
 *
 * ⚠️ Load-bearing for the position indicator, not a nicety. The reading line sits ~96px
 * below the thread's top, so a message can only become "current" by scrolling PAST it —
 * and the last message often cannot: if what follows it is shorter than the viewport, the
 * scroll runs out first and it never reaches the line. The indicator then sticks on the
 * second-to-last message however far down you scroll. At the bottom, the last message IS
 * the one you are reading, so we say so.
 */
export function isScrolledToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_EPSILON_PX;
}

/**
 * The live conversation's minimap: the store-backed wrapper around {@link MessageMinimap}.
 * Kept separate so the column itself stays a pure function of its props and can serve the
 * History panel, which has no conversation in the store to read from.
 */
export function ConversationMinimap({
  session,
  hostRef,
  scrollRef,
}: {
  session: string;
  hostRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const marks = useUserMessageMarks(session);
  const summaries = useMessageSummaries(session);
  return (
    <MessageMinimap
      marks={marks}
      summaries={summaries}
      hostRef={hostRef}
      scrollRef={scrollRef}
    />
  );
}

/**
 * The minimap itself, as a function of the messages handed to it — no store reads, so the
 * same column serves the live conversation and the History panel's cold preview (whose
 * messages come off disk and have no conversation in the store at all).
 */
export function MessageMinimap({
  marks,
  summaries,
  hostRef,
  scrollRef,
}: {
  marks: UserMessageMark[];
  /** Saved summaries by {@link summaryKey}; empty for a conversation we have none for. */
  summaries: Record<string, string>;
  /** The positioned, NON-scrolling element the column is laid over. It must not be the
   *  scroll container itself, or the column would scroll away with the content. */
  hostRef: RefObject<HTMLElement | null>;
  /** The scroll container holding the anchored messages. Every DOM lookup is scoped to it,
   *  since several transcripts can be mounted at once (see the header). */
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const enabled = useDisplay((s) => s.messageMinimap);
  const hoverMode = useDisplay((s) => s.minimapHoverMode);
  // Two hover states, on purpose: `hovered` is instant (it drives the magnification, which
  // must track the cursor), `previewed` lags by HOVER_INTENT_MS (it drives the preview card,
  // which must not strobe when the column is swept).
  const [hovered, setHovered] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The column is sized and placed onto the SCROLL container's box, not the host's: in the
  // conversation the host also holds the floating bars and the composer, and centring on it
  // would sink the block below the conversation's actual middle by however tall those are.
  const [column, setColumn] = useState({ top: 0, height: 0 });

  const show = enabled && marks.length >= MIN_MARKS;

  /** All rendered anchors, in document order. Scoped to the scroll container (see header). */
  const anchorNodes = useCallback(
    (): HTMLElement[] =>
      scrollRef.current
        ? Array.from(scrollRef.current.querySelectorAll<HTMLElement>("[data-user-turn]"))
        : [],
    [scrollRef],
  );

  // Track the message currently under the reading line. Recomputed on scroll (throttled to
  // one animation frame) and whenever the thread's content changes — streaming grows the
  // thread under a pinned scroll position, which moves the line over a new message without
  // a scroll event of its own.
  useEffect(() => {
    if (!show) return;
    const thread = scrollRef.current;
    if (!thread) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const nodes = anchorNodes();
      // At the end of the thread the last message is the one being read, whether or not it
      // ever crossed the reading line — see isScrolledToBottom. Costs no measurement.
      if (isScrolledToBottom(thread.scrollTop, thread.clientHeight, thread.scrollHeight)) {
        setActiveId(nodes.length ? (nodes[nodes.length - 1].dataset.userTurn ?? null) : null);
        return;
      }
      const threadTop = thread.getBoundingClientRect().top;
      const line = threadTop + ACTIVE_LINE_PX;
      const anchors: AnchorTop[] = [];
      for (const node of nodes) {
        const id = node.dataset.userTurn;
        if (!id) continue;
        const top = node.getBoundingClientRect().top;
        anchors.push({ id, top });
        // Anchors are in document order, so everything below is further down: stop as soon
        // as one is past the line instead of measuring the whole (possibly long) thread.
        if (top > line) break;
      }
      setActiveId(activeAnchorId(anchors, line));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    thread.addEventListener("scroll", schedule, { passive: true });
    // Content can grow/shrink without a scroll (streaming, a fold opening) — observe the
    // thread's inner box so the indicator doesn't go stale while the user reads.
    const ro = new ResizeObserver(schedule);
    // Observe the scrolled CONTENT (the container's own box doesn't change as it grows).
    // The first element child is that content wrapper in both hosts: `.cv-thread-inner`
    // live, `.cv-subtranscript` in the History preview.
    const inner = thread.firstElementChild;
    if (inner) ro.observe(inner);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      thread.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
    // `marks` is a dep so a newly-sent message is measured immediately (its bar can become
    // the active one before any scroll happens).
  }, [show, scrollRef, anchorNodes, marks]);

  // Track the scroll container's box within the host — it drives where the block sits and
  // how tight its pitch is. Measured rather than assumed: the box is resized by the side
  // panel, the window, full screen, and by the floating bars appearing above the composer.
  useEffect(() => {
    if (!show) return;
    const pane = hostRef.current;
    const thread = scrollRef.current;
    if (!pane || !thread) return;
    const measure = () => {
      const t = thread.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      setColumn((prev) =>
        prev.top === t.top - p.top && prev.height === t.height
          ? prev
          : { top: t.top - p.top, height: t.height },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(thread);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [show, hostRef, scrollRef]);

  // Hover intent: only a mark the pointer SETTLES on gets previewed. Leaving the column
  // clears the card at once — an empty column should never keep a card floating over the
  // conversation — while moving between marks keeps the previous one up until the new one
  // settles, so a deliberate move reads as the card following rather than blinking.
  useEffect(() => {
    if (hovered === null) {
      setPreviewed(null);
      return;
    }
    const timer = setTimeout(() => setPreviewed(hovered), HOVER_INTENT_MS);
    return () => clearTimeout(timer);
  }, [hovered]);

  const scrollTo = useCallback(
    (id: string) => {
      // Match on the dataset rather than an attribute selector: turn ids are store keys, and
      // building a selector out of one would need escaping to stay correct.
      const node = anchorNodes().find((n) => n.dataset.userTurn === id);
      // block:"center" leaves the message clear of the floating pin at the thread's top.
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [anchorNodes],
  );

  const labels = useMemo(
    () => marks.map((m) => resolveMessageLabel(m.text, hoverMode, summaries)),
    [marks, hoverMode, summaries],
  );

  if (!show) return null;

  const hoveredIndex = hovered ? marks.findIndex((m) => m.id === hovered) : -1;
  const previewedIndex = previewed ? marks.findIndex((m) => m.id === previewed) : -1;
  // The hit area is exactly one pitch tall, so the bands TILE: every pixel of the block
  // belongs to its nearest bar and none is stolen by an overlapping neighbour (which would
  // shift every target by half a slot).
  const pitch = minimapPitchPx(column.height, marks.length);

  return (
    <div
      className="cv-mmap"
      style={{ top: `${column.top}px`, height: `${column.height}px` }}
      onMouseLeave={() => setHovered(null)}
      aria-label="Messages you sent"
    >
      {marks.map((mark, i) => (
        <button
          key={mark.id}
          type="button"
          className="cv-mmap-bar"
          // The BUTTON never moves — only the mark it draws does (the CSS applies the push
          // to the ::before). A hit area that slid out from under the cursor would drop the
          // hover, snap back, and oscillate: the classic dock-effect flicker.
          style={{
            top: `${markOffsetPx(i, marks.length, column.height).toFixed(2)}px`,
            height: `${Math.max(4, pitch).toFixed(2)}px`,
            ["--cv-mmap-mag" as string]:
              hoveredIndex < 0 ? "0" : dockMagnification(i - hoveredIndex).toFixed(3),
            ["--cv-mmap-push" as string]: `${dockPushPx(i, hoveredIndex).toFixed(2)}px`,
          }}
          data-active={mark.id === activeId ? "" : undefined}
          data-hovered={mark.id === hovered ? "" : undefined}
          aria-label={`Go to your message: ${labels[i]}`}
          onMouseEnter={() => setHovered(mark.id)}
          onFocus={() => setHovered(mark.id)}
          onBlur={() => setHovered(null)}
          onClick={(e) => {
            e.stopPropagation(); // don't trigger the pane's background click
            scrollTo(mark.id);
          }}
        />
      ))}
      {previewedIndex >= 0 ? (
        <div
          className="cv-mmap-tip"
          data-mode={hoverMode}
          // TOP-aligned on the hovered mark, never centred on it: a multi-line preview
          // centred on the mark puts its MIDDLE under the eye, so the reader has to hunt
          // back up for the first words. Instead of shifting the preview up when it would
          // run past the column (which would break that alignment, the whole point), its
          // height is capped to the room left below — see tipMaxHeightPx.
          style={tipStyle(markOffsetPx(previewedIndex, marks.length, column.height), column.height)}
        >
          {labels[previewedIndex]}
        </div>
      ) : null}
    </div>
  );
}
