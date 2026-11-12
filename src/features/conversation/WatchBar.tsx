// Pinned list of the OTHER conversations this one follows (conversationWatch.ts) — the
// counterpart of <AgentBar> / <BashBar> / <MonitorBar> for cross-conversation work, in the same
// `.cv-bgagents` stack above the composer:
//  - "Waiting for <X>" while a `wait_for_conversation` call is parked (running dots + elapsed);
//  - "Watching <X>" for each subscription, with X's live status dot and a button that stops
//    watching — the human can always cut a subscription the agent made.
// Each name opens that conversation. Renders nothing when this conversation follows nobody.

import { unwatchConversation, useWaitsOf, useWatchesOf } from "../../agent/conversationWatch";
import { openConversationAt } from "../../store/threadJump";
import { Ico, RunDots } from "../../ui/kit";
import { useLiveElapsed } from "../../ui/liveElapsed";
import { ConvStatusDot, useLiveConversation } from "./conversationRef";

export function WatchBar({ session }: { session: string }) {
  const waits = useWaitsOf(session);
  const watches = useWatchesOf(session);
  if (waits.length === 0 && watches.length === 0) return null;
  return (
    <div className="cv-bgagents" aria-label="Conversations this one follows">
      <WatchRows session={session} />
    </div>
  );
}

/** The rows themselves — the bar above, and the Flight Deck card's popover (CardWatch). */
export function WatchRows({ session }: { session: string }) {
  const waits = useWaitsOf(session);
  const watches = useWatchesOf(session);
  return (
    <>
      {waits.map((w) => (
        <WaitRow key={`wait-${w.targetId}-${w.startedAt}`} targetId={w.targetId} startedAt={w.startedAt} />
      ))}
      {watches.map((w) => (
        <WatchRow key={`watch-${w.targetId}`} session={session} targetId={w.targetId} persistent={w.mode === "persistent"} />
      ))}
    </>
  );
}

function TargetName({ targetId }: { targetId: string }) {
  const live = useLiveConversation(targetId);
  return <span className="cv-watchrow-name">{live.name?.trim() || "a conversation"}</span>;
}

function WaitRow({ targetId, startedAt }: { targetId: string; startedAt: number }) {
  return (
    <div className="cv-bashrow">
      <button
        type="button"
        className="cv-bashrow-main"
        onClick={() => openConversationAt(targetId, null)}
        title="Open the conversation this agent is waiting for"
      >
        <RunDots />
        <Ico name="clock" className="sm cv-watchrow-ico" />
        <span className="cv-watchrow-verb">Waiting for</span>
        <TargetName targetId={targetId} />
        <WaitElapsed startedAt={startedAt} />
      </button>
    </div>
  );
}

/** Its own leaf on the app's shared elapsed clock (the sidebar's counter): a tick re-renders
 *  this label only, in the app's one elapsed format. */
function WaitElapsed({ startedAt }: { startedAt: number }) {
  const label = useLiveElapsed(startedAt);
  return label ? <span className="cv-monrow-tag">{label}</span> : null;
}

function WatchRow({ session, targetId, persistent }: { session: string; targetId: string; persistent: boolean }) {
  return (
    <div className="cv-bashrow">
      <button
        type="button"
        className="cv-bashrow-main"
        onClick={() => openConversationAt(targetId, null)}
        title={
          persistent
            ? "Watching: this agent hears every time it finishes, needs attention or stops"
            : "Watching: this agent hears the next time it finishes, needs attention or stops"
        }
      >
        <span className="cv-bashrow-dot">
          <ConvStatusDot convId={targetId} />
        </span>
        <Ico name="eye" className="sm cv-watchrow-ico" />
        <span className="cv-watchrow-verb">Watching</span>
        <TargetName targetId={targetId} />
        <span className="cv-monrow-tag">{persistent ? "until stopped" : "next event"}</span>
      </button>
      <button
        type="button"
        className="cv-bgstop"
        title="Stop watching"
        aria-label="Stop watching"
        onClick={() => unwatchConversation(session, targetId)}
      >
        <Ico name="x" className="sm" />
      </button>
    </div>
  );
}
