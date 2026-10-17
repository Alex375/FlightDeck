// A conversation's remote link is down: a small amber glyph where there is no room for a line —
// the sidebar row, and a Flight Deck card that is not running (a running card says it on its
// activity line). Its tooltip is the thread's own line (`agent/remoteLink.ts`), so the three never
// disagree. Renders nothing for a link that is up, a local conversation, or one with no session.
import { Ico } from "../../ui/kit";
import { Tooltip } from "../../ui/Tooltip";
import { useRemoteLinkView } from "../../agent/useRemoteLinkView";

export function LinkDownMark({ convId, className }: { convId: string; className?: string }) {
  const link = useRemoteLinkView(convId);
  if (!link) return null;
  return (
    <Tooltip
      className={"wf-linkdown" + (className ? ` ${className}` : "")}
      label={link.text}
      content={
        <>
          {link.lead}
          {link.wait ? <span className="wf-tip-sub">{link.wait}</span> : null}
        </>
      }
    >
      {/* Spins only while an attempt is in flight; a wait is a still clock. */}
      <Ico
        name={link.phase === "offline" ? "globe" : link.active ? "refresh" : "clock"}
        className={"sm" + (link.active ? " wf-spin-fast" : "")}
      />
    </Tooltip>
  );
}
