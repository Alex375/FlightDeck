// The side panel's "Linked conversations" widget: the other conversations this one exchanged
// with through the flightdeck `send_message` / `create_conversation` tools — who, how (sent,
// received, created), and one click to the place where the last exchange happened, on either
// side.
//
// Everything comes from THIS conversation's own thread (see linkedConversations.ts): no fetch,
// no polling, and it reads the same after a reload. Partners are named and coloured LIVE by id,
// each row on its own subscriptions, so one agent changing state re-renders one row.
//
// ⚠️ Hidden costs nothing: the widget is only mounted when switched on, and its header reads a
// memoised list (a reference compare per store write). The rows — the only part holding live
// subscriptions per partner — live in the section body, which a fold unmounts.

import { useState } from "react";
import type { Conversation } from "../../../store/conversationsStore";
import { useDisplay } from "../../../store/display";
import { openConversationAt } from "../../../store/threadJump";
import { Ico } from "../../../ui/kit";
import { motionAllowed } from "../../../ui/motion";
import { Tooltip } from "../../../ui/Tooltip";
import { PanelSection } from "../PanelSection";
import { ConvStatusDot, useLiveConversation } from "../conversationRef";
import {
  failureNote,
  linkSummary,
  useLinkedConversations,
  type LinkedConversation,
} from "../linkedConversations";
import s from "../ConversationSidePanel.module.css";
import css from "./LinkedConversationsWidget.module.css";

/** Rows shown before « Show N more » — a panel section, not a directory. */
const VISIBLE_ROWS = 5;

/** The "Linked conversations" section for `conv` (main zone). Renders null when this thread
 *  holds no exchange with another conversation, so the panel skips it. */
export function LinkedConversationsWidget({ conv }: { conv: Conversation }) {
  const links = useLinkedConversations(conv.id);
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));
  const [expanded, setExpanded] = useState(false);
  if (links.length === 0) return null;
  const hidden = Math.max(0, links.length - VISIBLE_ROWS);
  const shown = expanded || hidden === 0 ? links : links.slice(0, VISIBLE_ROWS);
  return (
    <PanelSection
      id="linked"
      icon={<Ico name="link" className="sm" />}
      title="Linked conversations"
      meta={<span className={`${s.meta} wf-mono`}>{links.length}</span>}
    >
      {/* `role="list"`: WebKit (the app's webview) drops a <ul>'s list semantics once its
          markers are styled away — and « list, 3 items » is the count worth announcing. */}
      <ul className={css.list} role="list" data-motion={motion || undefined}>
        {shown.map((link) => (
          <LinkedRow key={link.partnerId} selfId={conv.id} link={link} />
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          className={css.more}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <Ico name="chev" className={`sm ${css.moreChev}`} />
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </PanelSection>
  );
}

/**
 * One partner. The row opens the PARTNER at the card of the newest exchange that reached it (its
 * arrival card for our message, its send card for its message to us); the small « reply » button
 * scrolls THIS thread to our own card of the newest exchange instead.
 *
 * A partner no longer on the list is plain, dimmed text: no jump (there is nothing to open —
 * reopening it from History mints a new id) and no status dot (its state is unknown). Our own
 * card is still in this thread, so the local jump stays.
 */
function LinkedRow({ selfId, link }: { selfId: string; link: LinkedConversation }) {
  const live = useLiveConversation(link.partnerId);
  const gone = !live.exists;
  const knownName = live.name?.trim() || link.snapshotTitle || null;
  const knownRepo = live.repo ?? link.snapshotRepo ?? null;
  const name = knownName ?? "—";
  const repo = knownRepo ?? "—";
  // What assistive tech hears: the em dash is a visual « unknown », read aloud it is noise.
  const spoken = knownName ?? "an unnamed conversation";
  const summary = linkSummary(link);
  const failure = failureNote(link);

  const body = (
    <>
      <span className={css.dotSlot}>
        {gone ? null : <ConvStatusDot convId={link.partnerId} tooltip className={css.dotTip} />}
      </span>
      <span className={css.main}>
        {gone ? (
          <Tooltip
            content="No longer in the conversation list"
            label={`${spoken}, no longer in the conversation list`}
            className={css.nameTip}
          >
            <span className={css.name}>{name}</span>
          </Tooltip>
        ) : (
          <span className={css.name}>{name}</span>
        )}
        <span className={css.repo}>{repo}</span>
      </span>
      <Tooltip content={summary} label={summary} className={css.figs}>
        {link.created ? <span className={css.chip}>created</span> : null}
        {link.sent > 0 ? (
          <span className={css.fig}>
            <Ico name="arrow" className={`sm ${css.arrowOut}`} />
            {link.sent}
          </span>
        ) : null}
        {link.received > 0 ? (
          <span className={css.fig}>
            <Ico name="arrow" className={`sm ${css.arrowIn}`} />
            {link.received}
          </span>
        ) : null}
      </Tooltip>
      {failure ? (
        <Tooltip content={failure} label={failure} className={css.fail}>
          !
        </Tooltip>
      ) : null}
    </>
  );

  return (
    <li className={css.row} data-gone={gone || undefined}>
      {gone ? (
        <div className={css.open}>{body}</div>
      ) : (
        <button
          type="button"
          className={css.open}
          onClick={() => openConversationAt(link.partnerId, link.remoteAnchor)}
          // The button's label replaces its content for assistive tech, so it carries the
          // figures and the refusal in words too.
          aria-label={[
            `Open ${spoken}${knownRepo ? ` (${knownRepo})` : ""}` +
              (link.remoteAnchor ? " at the last message exchanged" : ""),
            summary,
            failure,
          ]
            .filter(Boolean)
            .join(". ")}
        >
          {body}
        </button>
      )}
      {link.localAnchor ? (
        <Tooltip
          content="Show the last exchange in this thread"
          label="Show the last exchange in this thread"
          className={css.hereTip}
        >
          <button
            type="button"
            className={css.here}
            onClick={() => openConversationAt(selfId, link.localAnchor)}
            aria-label={`Show the last exchange with ${spoken} in this thread`}
          >
            <Ico name="reply" className="sm" />
          </button>
        </Tooltip>
      ) : (
        // No card to scroll to (an envelope from before message ids): the slot stays, so this
        // row's figures line up with the others'.
        <span className={css.hereSlot} aria-hidden="true" />
      )}
    </li>
  );
}
