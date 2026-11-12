// The Flight Deck card's watch & wait mark: this agent follows other conversations
// (conversationWatch.ts). An eye plus a WORD — "watching", or "waiting" (in the running tone)
// while a wait is parked, with a count past one — since the card is where the fleet is read,
// so who-waits-on-whom must show there too, not only in the thread. Opens the SAME rows as the
// conversation's watch bar (portaled: the card clips).

import { useWaitsOf, useWatchesOf } from "../../agent/conversationWatch";
import { Ico, Menu } from "../../ui/kit";
import { WatchRows } from "../conversation/WatchBar";

export function CardWatch({ convId }: { convId: string }) {
  const waits = useWaitsOf(convId);
  const watches = useWatchesOf(convId);
  const total = waits.length + watches.length;
  if (total === 0) return null;
  const parts: string[] = [];
  if (waits.length) parts.push(`waiting for ${waits.length}`);
  if (watches.length) parts.push(`watching ${watches.length}`);
  const title = `Follows other conversations — ${parts.join(", ")}`;
  return (
    <Menu
      portal
      align="right"
      trigger={
        // Words, not a glyph + number: a clock here read as the footer's "last activity" clock.
        <button
          type="button"
          className={"ag-goal ag-watch" + (waits.length ? " is-waiting" : "")}
          aria-label={title}
          title={title}
        >
          <Ico name="eye" className="sm" />
          <span className="ag-watch-t">
            {waits.length ? "waiting" : "watching"}
            {total > 1 ? ` · ${total}` : ""}
          </span>
        </button>
      }
    >
      <div className="cv-watch-pop">
        <div className="wf-pop-h">Follows</div>
        <WatchRows session={convId} />
      </div>
    </Menu>
  );
}
