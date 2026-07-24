// FlightDeck — the agent dashboard view (the "Agent management" view). A grid of stream
// cards grouped by repo, with the fleet readout banner on top. Uses `useFleetLanes`,
// which shares the repo-grouping skeleton with the sidebar but orders STATUS-first
// (action-required/error → review → running → idle → off, recency as tiebreak)
// instead of the sidebar's pure recency — a deliberate difference, so only the
// grouping is shared, not the order. When the "auto reorder" toggles are off, the order
// is instead the user's MANUAL drag arrangement (see useFleetLanes / useSurfaceOrderDnd).
// Each card reuses the same status/todo/context selectors as the conversation view.
import { useEffect, useState } from "react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Ico } from "../../ui/kit";
import {
  createConversationInRepo,
  repoName,
  type Conversation,
  type Repo,
} from "../../store/conversationsStore";
import { useFleetLanes } from "../../agent/fleet";
import { useDisplay } from "../../store/display";
import {
  useSurfaceOrderDnd,
  orderCollisionDetection,
  guardReorderClick,
  type ActiveDrag,
  type DragData,
} from "../../ui/orderDnd";
import { FleetReadout } from "../../ui/FleetReadout";
import { StreamCard } from "./StreamCard";

/** A coarse clock ticking every 30s so the relative "last activity" stamps on
 *  idle/off/review cards advance even when nothing else re-renders them. One
 *  interval for the whole grid (cheaper than one per card), scoped to mount. */
function useNow(periodMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}

/** One repo swimlane: a sortable header (the whole header is the drag surface — no grip)
 *  over a horizontally-scrolling card grid whose cards are themselves sortable within the lane. */
function RepoLane({
  repo,
  conversations,
  now,
  onOpen,
}: {
  repo: Repo;
  conversations: Conversation[];
  now: number;
  onOpen: (id: string) => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: repo.id,
    data: { kind: "repo" } satisfies DragData,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="ag-repo">
      <div className="ag-repo-h cv-draggable" {...listeners} onClickCapture={guardReorderClick}>
        <Ico name="folder" className="sm" />
        <span className="wf-hi" style={{ fontWeight: 600, fontSize: 12.5 }}>
          {repoName(repo.path)}
        </span>
        <span className="wf-mono wf-xmuted" style={{ fontSize: 11 }}>
          {repo.path}
        </span>
        <span className="ag-repo-counts">
          <button
            className="wf-icon-btn"
            title="New conversation in this repository"
            onClick={() => void createConversationInRepo(repo.path)}
          >
            <Ico name="plus" className="sm" />
          </button>
          <span className="wf-mono wf-xmuted" style={{ fontSize: 11 }}>
            {conversations.length} stream{conversations.length > 1 ? "s" : ""}
          </span>
        </span>
      </div>
      {conversations.length === 0 ? (
        <div className="ag-repo-empty">No conversations</div>
      ) : (
        <div className="ag-grid">
          <SortableContext items={conversations.map((c) => c.id)} strategy={rectSortingStrategy}>
            {conversations.map((c) => (
              <StreamCard key={c.id} conv={c} repoPath={repo.path} now={now} onOpen={onOpen} />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

/** The floating ghost shown while dragging — rendered in a DragOverlay so it escapes the
 *  swimlane's `overflow:hidden` clip. A lightweight pill (not the live card) so it never
 *  re-runs the card's selectors mid-drag. */
function DragGhost({ active, lanes }: { active: ActiveDrag; lanes: { repo: Repo; conversations: Conversation[] }[] }) {
  if (active.kind === "repo") {
    const repo = lanes.find((l) => l.repo.id === active.id)?.repo;
    return (
      <div className="ag-drag-ghost ag-drag-ghost-repo">
        <Ico name="folder" className="sm" />
        <span>{repo ? repoName(repo.path) : ""}</span>
      </div>
    );
  }
  const conv = lanes.flatMap((l) => l.conversations).find((c) => c.id === active.id);
  return (
    <div className="ag-drag-ghost ag-drag-ghost-card">
      <Ico name="grip" className="sm" />
      <span>{conv?.name ?? ""}</span>
    </div>
  );
}

export function FlightDeck({ onOpen }: { onOpen: (id: string) => void }) {
  const { displayGroups: groups, sensors, onDragStart, onDragEnd, onDragCancel, active } =
    useSurfaceOrderDnd("flightdeck", useFleetLanes());
  const now = useNow();
  const showReadout = useDisplay((s) => s.fleetBannerFlightDeck);

  if (groups.length === 0) {
    return (
      <div className="ag-page wf-col">
        <div className="ag-empty">
          <Ico name="grid" />
          <div className="ag-empty-title">No agents</div>
          <div>Add a repository and start a conversation to steer your agents here.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="ag-page wf-col">
      {showReadout ? <FleetReadout variant="deck" /> : null}
      <div className="ag-scroll wf-fade-b">
        <DndContext
          sensors={sensors}
          collisionDetection={orderCollisionDetection}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <SortableContext items={groups.map((g) => g.repo.id)} strategy={verticalListSortingStrategy}>
            {groups.map(({ repo, conversations }) => (
              <RepoLane key={repo.id} repo={repo} conversations={conversations} now={now} onOpen={onOpen} />
            ))}
          </SortableContext>
          <DragOverlay>{active ? <DragGhost active={active} lanes={groups} /> : null}</DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
