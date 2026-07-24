// Renders a sub-agent's LIVE sub-thread from the store: the opening prompt (the live
// stream carries only the sub-agent's REPLIES, so we prepend the prompt as the opening
// user turn when it's known) followed by each streamed turn. Shared by the inline
// <SubAgentCard> (conversation thread) and the floating <TranscriptPopover>
// (conversation AgentBar + FlightDeck badge) so every sub-agent drill-down renders the
// same live transcript and the two views never diverge.
//
// Note the ConductorThread ⇄ LiveSubThread import cycle is render-time only (TurnRow /
// MsgUser are referenced inside the component body, not at module load), so ESM live
// bindings resolve it safely.

import { TurnRow } from "./ConductorThread";
import { AgentInstruction } from "./SubAgentTranscript";

export function LiveSubThread({
  session,
  ids,
  promptText,
}: {
  /** The store session key (the conversation's stable id). */
  session: string;
  /** tool_use ids of the live sub-thread turns (from `useSubThread`). */
  ids: string[];
  /** The Agent's `prompt` input, prepended as the opening turn when available. */
  promptText?: string | null;
}) {
  return (
    <div className="cv-subtranscript">
      {/* Claude's instruction to the sub-agent — attributed to Claude, not to the user
          (it used to carry the human avatar, as if they had written it). Same component as
          the cold drill-in, so live and settled views match. */}
      {promptText ? <AgentInstruction text={promptText} /> : null}
      {ids.map((id) => (
        <TurnRow key={id} session={session} turnId={id} />
      ))}
    </div>
  );
}
