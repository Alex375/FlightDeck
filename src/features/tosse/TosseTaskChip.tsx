// What TASK this conversation was opened on — shown from the conversation's side.
//
// The link existed in the database and nowhere on screen: a conversation started from a
// task looked like any other, so nothing said which piece of work it was carrying. That
// matters most exactly where the work happens — the conversation header — and on the
// Flight Deck, where several agents run side by side.
//
// Reads the DENORMALISED title and status stored on the conversation, never the CRM: the
// chip is therefore just as legible offline, which is the reason those columns exist.

import { Ico, TosseCrmMark } from "../../ui/kit";
import type { Conversation } from "../../store/conversationsStore";
import { STATUS_TONE } from "./tosseModel";
import s from "./TosseTaskChip.module.css";

export function TosseTaskChip({
  conv,
  compact,
  onOpen,
}: {
  conv: Conversation;
  /** Flight Deck card: no title, just the mark and the status dot — a card has no room
   *  for a task title next to the backend, worktree and effort marks. */
  compact?: boolean;
  /** Open the task. Omitted on surfaces with nowhere to open it (the Flight Deck card),
   *  where the chip is then a plain, non-clickable statement. */
  onOpen?: () => void;
}) {
  const title = conv.tosseTaskTitle;
  if (!conv.tosseTaskId || !title) return null;
  const status = conv.tosseTaskStatus;
  const tone = status ? (STATUS_TONE[status] ?? "todo") : "todo";
  const label = `TOSSE task: ${title}${status ? ` (${status})` : ""}${
    onOpen ? " — click to read it in the side panel" : ""
  }`;

  const body = (
    <>
      <TosseCrmMark className={s.mark} />
      <span className={`${s.dot} ${s[`dot_${tone}`]}`} />
      {compact ? null : <span className={s.title}>{title}</span>}
    </>
  );

  if (!onOpen) {
    return (
      <span className={`${s.chip} ${compact ? s.compact : ""}`} title={label}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${s.chip} ${s.clickable} ${compact ? s.compact : ""}`}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      {body}
      <Ico name="external" className={`sm ${s.go}`} />
    </button>
  );
}
