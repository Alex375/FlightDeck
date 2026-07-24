// One stream card. Pure composition over shared, id-keyed selectors — the SAME
// status the sidebar shows (useAgentStatus → agentStatusToDot/rowAttention), the
// same todo summary, context fill and worktree badge. No bespoke data, no fake
// chrome: every element is wired to the live store.
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Dot, Pill, Ico, ClaudeMark, CodexMark } from "../../ui/kit";
import { guardReorderClick, type DragData } from "../../ui/orderDnd";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { agentStatusToDot, backgroundCount, isActivelyRunning, railState, rowAttention } from "../../agent/status";
import { useLastMessageSummary } from "../../store/lastMessageSummary";
import { useRunningTaskCount } from "../../store/backgroundTasksStore";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { WorktreeIndicator } from "../git/WorktreeIndicator";
import { useConversationsStore, type Conversation } from "../../store/conversationsStore";
import { StateBlock } from "./StateBlock";
import { StateActions } from "./StateActions";
import { BackgroundTaskBadge } from "./BackgroundTaskBadge";
import { LastMessagePeek } from "./LastMessagePeek";
import { TodoPeek } from "./TodoPeek";
import { CardEffort } from "./CardEffort";
import { CardContext } from "./CardContext";
import { CardGoal } from "./CardGoal";
import { useFlightdeckModal } from "./flightdeckModalStore";

/** Relative "last activity" stamp — "14 min ago" / "2 h ago". `now` comes from
 *  the grid's shared ticker so idle/off cards advance without a per-card timer. */
function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function StreamCard({
  conv,
  repoPath,
  now,
  onOpen,
}: {
  conv: Conversation;
  repoPath: string;
  now: number;
  onOpen: (id: string) => void;
}) {
  const status = useAgentStatus(conv.id);
  const dot = agentStatusToDot(status);
  const attn = rowAttention(status);
  const openModal = useFlightdeckModal((s) => s.open);
  // A few-word summary of the user's LAST message (live-only, this run). Complements
  // the activity line: it says what YOU last asked, not what the agent is doing now.
  const lastMsg = useLastMessageSummary(conv.id);

  // Delete-from-card: reuses the sidebar ConvRow mechanics verbatim — the shared
  // `removeConversation` (already snapshots for ⌘Z undo, kills the session, cleans up),
  // gated by a ConfirmDialog only while the conversation is actively running so a live
  // run is never killed by a stray click.
  const remove = useConversationsStore((s) => s.removeConversation);
  const runningBgTasks = useRunningTaskCount(conv.id);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busyForDelete = isActivelyRunning(status) || runningBgTasks > 0;
  // If the work settles while the confirm is open, close it (the danger is gone).
  useEffect(() => {
    if (confirmingDelete && !busyForDelete) setConfirmingDelete(false);
  }, [confirmingDelete, busyForDelete]);

  // The importance rail (left edge) lights up only for states that deserve a glance;
  // `off` (shut down) and `idle` (at rest) get no rail and recede — `dim` a touch more
  // than `rest`, the only whisper between the two calm states (that + the dot shape).
  // The WHOLE card is the drag surface (no grip): `listeners` + the click guard go on the
  // card root below. While dragging, the card is hidden in place and a DragOverlay ghost
  // (rendered by FlightDeck, outside the swimlane's overflow clip) follows the cursor.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: conv.id,
    data: { kind: "conv", repoId: conv.repoId } satisfies DragData,
  });
  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hidden in place while dragging — the DragOverlay ghost (rendered by FlightDeck,
    // outside the swimlane's overflow clip) is the moving visual; the gap marks the drop.
    opacity: isDragging ? 0 : undefined,
  };

  const rail = railState(status);
  const cls =
    "wf-card ag-card ag-card-clickable" +
    (attn === "input" || attn === "error" ? " att" : "") +
    (attn === "review" ? " rev" : "") +
    (status.kind === "off" ? " dim" : "") +
    (status.kind === "idle" ? " rest" : "");

  // Clicking the card BODY opens the conversation in the reply modal — the same as
  // the (now removed) plain "Open" button. The card TITLE stays the full-screen
  // entry point.
  const onCardClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Ignore a click that bubbled from a PORTAL opened within the card (the last-message
    // / to-do peek popovers, the background-tasks popover). React bubbles portal events
    // through the component tree, so a click-away to CLOSE such a popover would otherwise
    // reach here and open the conversation — the portal's target isn't a DOM descendant
    // of the card, so `contains` rejects it.
    if (!e.currentTarget.contains(target)) return;
    // Any interactive child (title, action buttons, worktree/bg badges, the peek
    // triggers — all real <button>s) handles its own click.
    if (target.closest("button, a, input, textarea, select, label")) return;
    // A text selection isn't a click.
    if (!window.getSelection()?.isCollapsed) return;
    openModal(conv.id);
  };

  return (
    <div
      ref={setNodeRef}
      style={dragStyle}
      className={cls + " cv-draggable"}
      data-rail={rail ?? undefined}
      onClick={onCardClick}
      onClickCapture={guardReorderClick}
      {...listeners}
    >
      <div className="ag-card-h">
        <Dot s={dot} pulse ring={backgroundCount(status) > 0} />
        <button className="ag-card-name" onClick={() => onOpen(conv.id)} title={conv.name}>
          {conv.name}
        </button>
        <Pill s={dot} icon={false} />
        <button
          type="button"
          className="ag-card-del"
          title="Delete conversation (⌘Z to undo)"
          aria-label="Delete conversation"
          onClick={(e) => {
            e.stopPropagation();
            if (busyForDelete) setConfirmingDelete(true);
            else remove(conv.id);
          }}
        >
          <Ico name="x" className="sm" />
        </button>
      </div>

      <div className="ag-card-tags">
        <span
          className={"ag-backend" + (conv.kind === "codex" ? " codex" : "")}
          title={conv.kind === "codex" ? "Backend: Codex (OpenAI)" : "Backend: Claude"}
          aria-label={conv.kind === "codex" ? "Codex" : "Claude"}
        >
          {conv.kind === "codex" ? <CodexMark /> : <ClaudeMark />}
        </span>
        <WorktreeIndicator conv={conv} repoPath={repoPath} />
        {/* Reasoning effort — now a real, clickable slider (the composer's EffortGauge),
            set live per conversation. Renders nothing until an effort is known. */}
        <CardEffort convId={conv.id} />
      </div>

      {lastMsg ? <LastMessagePeek convId={conv.id} summary={lastMsg} /> : null}

      <StateBlock convId={conv.id} status={status} />

      <div className="ag-card-foot">
        {/* Active `/goal` — a clickable target opening the SAME goal popover as the composer
            (condition + reason + clear). Renders nothing when no goal is active. */}
        <CardGoal convId={conv.id} />
        {/* Context meter — clickable, opening the same context/usage popover as the
            composer's ContextRing (renders nothing until usage is reported). */}
        <CardContext convId={conv.id} />
        <TodoPeek convId={conv.id} />
        <BackgroundTaskBadge convId={conv.id} />
        <span className="wf-row" style={{ gap: 5, marginLeft: "auto" }} title="Last activity">
          <Ico name="clock" className="sm" />
          {fmtAgo(conv.lastActivityAt, now)}
        </span>
      </div>

      <StateActions convId={conv.id} status={status} />

      {/* Portaled to document.body (escapes the .ag-grid overflow clip), shown only while
          the conversation is actively running — same copy as the sidebar's ConvRow. */}
      {confirmingDelete ? (
        <ConfirmDialog
          open
          danger
          title={`Delete "${conv.name}"?`}
          confirmLabel="Delete anyway"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            remove(conv.id);
          }}
        >
          This conversation is <strong>running</strong>. Deleting it will{" "}
          <strong>stop the {conv.kind === "codex" ? "Codex" : "Claude"} session</strong> and
          unfinished work may be lost. The conversation can still be recovered with ⌘Z, but
          not the interrupted run.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
