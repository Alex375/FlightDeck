import { useState } from "react";
import {
  restartConversationSession,
  startConversationSession,
  stopConversationSession,
  type Conversation,
} from "../../store/conversationsStore";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { agentStatusToDot } from "../../agent/status";
import { useConversationStore } from "../../store/conversationStore";
import { Dot, Ico, Menu, MenuItem, WF_STATUS, type StreamState } from "../../ui/kit";

/** A conversation's stream state + the actions on it — shared by the title-bar menu below and
 *  the conversation side panel's Session footer, so both run the same guarded actions. */
export interface StreamActions {
  /** Status dot, forced to `err` while the last action's failure is shown. */
  status: StreamState;
  /** The `claude` process is up (a live handle) — decides which actions apply. */
  live: boolean;
  /** An action is in flight (further clicks are ignored). */
  pending: boolean;
  /** The last action's failure, cleared by the next attempt. */
  error: string | null;
  start: () => void;
  restart: () => void;
  stop: () => void;
}

/**
 * The stream's state and its turn on / restart / turn off actions.
 *
 * On/off is driven by the conversation's live `handle`: with the lazy policy the process spawns
 * on the first message, so it is normally off until then; turning it on pre-spawns it without
 * sending anything.
 */
export function useStreamActions(conv: Conversation): StreamActions {
  // Rich status keyed by the conversation's stable id; the handle (reactive via
  // the prop) is the source of truth for on/off, folded into the status.
  const status = agentStatusToDot(useAgentStatus(conv.id));
  const live = conv.handle !== null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Run an async stream action, guarding against concurrent clicks and
   *  surfacing a failure (e.g. `claude` not found) instead of swallowing it. */
  const run = (fn: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    void fn()
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[stream] action failed:", e);
        // Surface on the control (transient) AND in the thread (persistent, detail not
        // hidden behind a hover) so a failed turn-on/restart/turn-off can't be missed.
        setError(msg);
        useConversationStore.getState().addErrorTurn(conv.id, `Stream action failed: ${msg}`);
      })
      .finally(() => setPending(false));
  };

  return {
    // On failure show an error dot; the action stays offered so the user can retry
    // (which clears the error).
    status: error ? "err" : status,
    live,
    pending,
    error,
    start: () => run(() => startConversationSession(conv.id)),
    restart: () => run(() => restartConversationSession(conv.id)),
    stop: () => run(() => stopConversationSession(conv.id)),
  };
}

/**
 * Title-bar control for a conversation's live `claude` stream: shows whether it
 * is on or off (status dot + label) and opens a menu to turn it on, restart it,
 * or turn it off. The actions are contextual — turn on when off, restart/turn off when on.
 */
export function StreamControl({ conv, portal }: { conv: Conversation; portal?: boolean }) {
  const { status, live, pending, error, start, restart, stop } = useStreamActions(conv);

  return (
    <Menu
      align="right"
      portal={portal}
      trigger={
        <button
          type="button"
          className="wf-streamctl"
          title={error ? `Failed: ${error}` : "Stream control"}
          aria-label={`Stream ${error ? "failed" : WF_STATUS[status].label}`}
        >
          <Dot s={status} pulse />
          <span>{error ? "Failed" : WF_STATUS[status].label}</span>
          <Ico name="chev" className="sm wf-streamctl-chev" />
        </button>
      }
    >
      {live ? (
        <>
          <MenuItem icon="restart" disabled={pending} onClick={restart}>
            Restart stream
          </MenuItem>
          <MenuItem icon="stop" disabled={pending} onClick={stop}>
            Turn off stream
          </MenuItem>
        </>
      ) : (
        <MenuItem icon="play" disabled={pending} onClick={start}>
          Turn on stream
        </MenuItem>
      )}
    </Menu>
  );
}
