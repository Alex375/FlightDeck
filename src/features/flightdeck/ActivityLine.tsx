// The live "what it's doing now" line for a running agent. Mounted only while the
// card is in the running state, so the stream-scan derivation (useActivityLabel)
// runs only for active agents.
import { useActivityLabel } from "../../store/activity";
import { useRemoteLinkView } from "../../agent/useRemoteLinkView";
import { ConvMark } from "../conversation/ConvMark";
import { RollText } from "../../ui/RollText";

export function ActivityLine({ convId }: { convId: string }) {
  const text = useActivityLabel(convId);
  // A remote agent whose link is down: the Mac cannot see what it is doing, so the card says
  // what the Mac is doing about the link — the thread's own line, in short (one voice, see
  // `agent/remoteLink.ts`). Amber, and the mark spins only while an attempt is in flight: a
  // playful "Thinking…" over a dead link is exactly the lie this replaces.
  const link = useRemoteLinkView(convId);
  if (link) {
    return (
      <div className="ag-card-act" title={link.text}>
        <span className="wf-act att">
          <ConvMark session={convId} className={link.active ? "wf-spin" : undefined} />
          <RollText text={link.shortLead} className="wf-act-t" />
          {link.shortWait ? <span className="wf-act-w">· {link.shortWait}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className="ag-card-act">
      <span className="wf-act run">
        <ConvMark session={convId} className="wf-spin" />
        <RollText text={text} className="wf-act-t" />
      </span>
    </div>
  );
}
