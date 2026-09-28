// A reference to ANOTHER conversation, by its stable id — the small pieces every surface that
// names a conversation it does not own reuses: the agent-message cards (both sides of an
// exchange) and the side panel's "Linked conversations" widget.
//
// Everything here reads the conversation LIVE by id, so a rename or a status change shows up
// wherever it is named, and a conversation that was removed degrades to plain, dimmed text
// instead of a dead jump. Each hook uses PRIMITIVE selectors so a row re-renders on its own
// values, never on every conversations write.

import { useConversationsStore } from "../../store/conversationsStore";
import { openConversationAt, type JumpAnchor } from "../../store/threadJump";
import { agentStatusToDot } from "../../agent/status";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { Dot, WF_STATUS } from "../../ui/kit";
import { Tooltip } from "../../ui/Tooltip";

/** A folder's display name: the last path segment (trailing slashes ignored). */
export function repoLabel(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

export interface LiveConversation {
  /** Still on the conversation list. ⌘Z restores a removed conversation under the SAME id (the
   *  reference revives); reopening it from History mints a NEW id (it does not). */
  exists: boolean;
  name: string | null;
  /** The basename of its repo folder. */
  repo: string | null;
}

/** Another conversation, read LIVE by id (a rename shows up). Primitive selectors only, so a
 *  card re-renders on ITS values, not on every conversations write. */
export function useLiveConversation(id: string | null): LiveConversation {
  const name = useConversationsStore((s) =>
    id ? (s.conversations.find((c) => c.id === id)?.name ?? null) : null,
  );
  const repoPath = useConversationsStore((s) => {
    const conv = id ? s.conversations.find((c) => c.id === id) : undefined;
    return conv ? (s.repos.find((r) => r.id === conv.repoId)?.path ?? null) : null;
  });
  return { exists: name !== null, name, repo: repoPath ? repoLabel(repoPath) : null };
}

/** The other conversation's name. A link while it is on the list; once removed it stays as
 *  plain, dimmed text (with the snapshot title) rather than offering a dead jump. */
export function ConversationLink({
  id,
  live,
  title,
  anchor,
}: {
  id: string | null;
  live: LiveConversation;
  title: string | null;
  anchor: JumpAnchor | null;
}) {
  const label = live.name?.trim() || title || "unknown conversation";
  if (!id || !live.exists) {
    return (
      <span
        className="cv-agentmsg-name"
        data-gone={id ? "1" : undefined}
        title={id ? "No longer in the conversation list" : undefined}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cv-agentmsg-name"
      title={anchor ? "Open this conversation at the message" : "Open this conversation"}
      onClick={(e) => {
        e.stopPropagation(); // neither the row's toggle nor the pane's background click
        openConversationAt(id, anchor);
      }}
    >
      {label}
    </button>
  );
}

/** Another conversation's live agent state as the compact status dot — its OWN component, so a
 *  list re-renders one row when one agent moves, not the whole list on any of them. Event-driven
 *  (no polling); a cold conversation reads "off" plus its persisted reminder, with no history
 *  load. Pulse is opt-in: a quiet surface (the side panel) keeps its dots still. `tooltip` names
 *  the state on hover (the colour alone is a code to learn). */
export function ConvStatusDot({
  convId,
  pulse = false,
  tooltip = false,
  className,
}: {
  convId: string;
  pulse?: boolean;
  tooltip?: boolean;
  /** On the tooltip's trigger (only rendered with `tooltip`). */
  className?: string;
}) {
  const state = agentStatusToDot(useAgentStatus(convId));
  const dot = <Dot s={state} pulse={pulse} />;
  if (!tooltip) return dot;
  const label = WF_STATUS[state]?.label ?? "Unknown";
  return (
    <Tooltip content={label} label={`Agent state: ${label}`} className={className}>
      {dot}
    </Tooltip>
  );
}
