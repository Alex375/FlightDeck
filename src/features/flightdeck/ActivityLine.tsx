// The live "what it's doing now" line for a running agent. Mounted only while the
// card is in the running state, so the stream-scan derivation (useActivityLabel)
// runs only for active agents.
import { useActivityLabel } from "../../store/activity";
import { useRemoteLinkView } from "../../agent/useRemoteLinkView";
import { RollText } from "../../ui/RollText";
import { ActivityOrb, useHeldUntilSwap } from "../../ui/orbs/ActivityOrb";
import { useOrbStateOf } from "../../ui/orbs/useOrbStateOf";

export function ActivityLine({ convId }: { convId: string }) {
  const text = useActivityLabel(convId);
  // A remote agent whose link is down: the Mac cannot see what it is doing, so the card says
  // what the Mac is doing about the link — the thread's own line, in short (one voice, see
  // `agent/remoteLink.ts`). Amber, and the orb moves only while an attempt is in flight: a
  // playful "Thinking…" over a dead link is exactly the lie this replaces.
  const link = useRemoteLinkView(convId);
  // The activity orb's shape says what the agent is doing (`connecting` while the link is
  // down — `useOrbStateOf` says so); the words change when it swaps shape. The backend stays
  // on the card: its mark is in the tags row.
  const orbState = useOrbStateOf(convId);
  const shownText = useHeldUntilSwap(convId, orbState, text);
  if (link) {
    return (
      <div className="ag-card-act" title={link.text}>
        <span className="wf-act att">
          <ActivityOrb channel={convId} state={orbState} tone="currentColor" display={18} frozen={!link.active} />
          <RollText text={link.shortLead} className="wf-act-t" />
          {link.shortWait ? <span className="wf-act-w">· {link.shortWait}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className="ag-card-act">
      <span className="wf-act run">
        <ActivityOrb channel={convId} state={orbState} tone="--wf-run" display={18} />
        <RollText text={shownText} className="wf-act-t" />
      </span>
    </div>
  );
}
