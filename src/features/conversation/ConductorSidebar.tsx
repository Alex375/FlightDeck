import { useEffect, useRef, useState } from "react";
import { pickFolder } from "../../ipc/pickFolder";
import { Splitter } from "../editor/Splitter";
import { useSidebar } from "../../store/sidebar";
import { TosseMark } from "../../ui/TosseMark";
import {
  acknowledgeConversation,
  createConversationInRepo,
  repoName,
  useActiveConversationId,
  useConversationsByRepo,
  useConversationsStore,
  type Conversation,
} from "../../store/conversationsStore";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { useRunningTaskCount } from "../../store/backgroundTasksStore";
import {
  agentStatusToDot,
  backgroundCount,
  isActivelyRunning,
  isDismissable,
  rowAttention,
  type AgentStatus,
} from "../../agent/status";
import { useSettingsUi } from "../../store/settingsUi";
import { useSidebarFold, useRepoCollapsed } from "../../store/sidebarFold";
import { useDisplay } from "../../store/display";
import { FleetReadout } from "../../ui/FleetReadout";
import { SettingsPanel } from "../settings/SettingsPanel";
import { Dot, Ico, Menu, MenuItem, MenuLabel, RunPulse } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { WorktreeBadge } from "../git/WorktreeBadge";
import { useWorktreeUi } from "../git/worktreeUiStore";
import { useExtensionsUi } from "../extensions/extensionsUiStore";
import { useHistoryUi } from "../history/historyUiStore";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { useSurfaceOrderDnd, orderCollisionDetection, guardReorderClick, type DragData } from "../../ui/orderDnd";

/** The conversation's status glyph: the "sonar" running indicator while a turn is in
 *  flight, otherwise the plain coloured status dot (review / attention / error / idle…). */
function StatusDot({ status }: { status: AgentStatus }) {
  if (status.kind === "running") return <RunPulse />;
  return <Dot s={agentStatusToDot(status)} pulse ring={backgroundCount(status) > 0} />;
}

function ConvRow({ conv, active }: { conv: Conversation; active: boolean }) {
  // Rich status keyed by the conversation's stable id (the message store routes
  // live events back to it). Drives the dot colour, the whole-row highlight, and
  // the "Seen" acknowledge button.
  const status = useAgentStatus(conv.id);
  // Raw count of running background tools for this conversation. We gate the delete
  // confirm on this DIRECTLY (not just `isActivelyRunning(status)`), because a running
  // background task can be masked by a higher-priority derived kind: when the last
  // turn is unseen, deriveAgentStatus reports `review`/`error`/`needInput` even while
  // background work is live (see status.ts + status.test.ts). Reading the count avoids
  // the friction-free × silently killing that live work.
  const runningBgTasks = useRunningTaskCount(conv.id);
  const attn = rowAttention(status);
  const select = useConversationsStore((s) => s.selectConversation);
  const rename = useConversationsStore((s) => s.renameConversation);
  const remove = useConversationsStore((s) => s.removeConversation);
  const [editing, setEditing] = useState(false);
  // Only when the conversation is actively running (turn in flight / background
  // tools) does the friction-free × ask first — deleting then kills live work.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(conv.name);
  // Both Enter/blur commit and Escape cancel unmount the input, which fires a
  // trailing `onBlur`. This latch makes the commit run exactly once and lets
  // Escape suppress it entirely (so a cancel never writes the edited draft).
  const settled = useRef(false);

  // The WHOLE row is the drag surface (no grip): `listeners` go on the row root below.
  // A small activation distance (see useSurfaceOrderDnd) keeps a plain click selecting;
  // `guardReorderClick` swallows the click that follows a real drag. The row moves via
  // transform while dragging.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: conv.id,
    data: { kind: "conv", repoId: conv.repoId } satisfies DragData,
  });
  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  // "Busy" for delete-safety: a turn in flight OR any background work still running.
  const busyForDelete = isActivelyRunning(status) || runningBgTasks > 0;
  // If the work settles while the confirm is open, its "still running / work may be
  // lost" copy is stale and no confirm is warranted anymore — close it (the × goes
  // back to friction-free). Guarded on `confirmingDelete` so it's a no-op otherwise.
  useEffect(() => {
    if (confirmingDelete && !busyForDelete) setConfirmingDelete(false);
  }, [confirmingDelete, busyForDelete]);

  function startEdit() {
    settled.current = false;
    setDraft(conv.name);
    setEditing(true);
  }
  function commitEdit() {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    rename(conv.id, draft); // the store ignores a blank or unchanged title
  }
  function cancelEdit() {
    settled.current = true; // suppress the trailing blur-commit
    setEditing(false);
  }

  if (editing) {
    return (
      <div
        ref={setNodeRef}
        style={dragStyle}
        className={"cv-sess-row" + (active ? " on" : "")}
        data-attn={attn ?? undefined}
      >
        <span className="cv-sess" style={{ cursor: "default" }}>
          <StatusDot status={status} />
          <input
            className="cv-sess-edit"
            value={draft}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              else if (e.key === "Escape") cancelEdit();
            }}
            onBlur={commitEdit}
          />
        </span>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={dragStyle}
      className={"cv-sess-row cv-draggable" + (active ? " on" : "")}
      data-attn={attn ?? undefined}
      {...listeners}
      onClickCapture={guardReorderClick}
    >
      <button
        type="button"
        className="cv-sess"
        onClick={() => select(conv.id)}
        onDoubleClick={startEdit}
      >
        <StatusDot status={status} />
        {/* Keyed by the name so an incoming auto-title (applyAutoTitle) REMOUNTS this
            node instead of mutating its text in place. WebKit fails to repaint a
            text-overflow:ellipsis box when only its text content changes at an identical
            box size — old and new glyphs superimpose (the "ghost title" that only a
            sidebar resize cleared). A fresh node gets a clean paint region. Repo titles
            never change, which is why they never ghosted. */}
        <span key={conv.name} className="cv-sess-n">{conv.name}</span>
      </button>
      <WorktreeBadge conv={conv} />
      {isDismissable(status) ? (
        <button
          type="button"
          className="cv-sess-seen"
          title="Mark as seen"
          aria-label="Mark as seen"
          onClick={(e) => {
            e.stopPropagation();
            acknowledgeConversation(conv.id);
          }}
        >
          <Ico name="check" className="sm" />
        </button>
      ) : null}
      {/* Friction-free delete: one click removes the conversation immediately, no
          confirm dialog. It's reversible with ⌘Z (undoRemoveConversation) — the on-disk
          transcript is never touched, so nothing is truly lost. Mirrors the "Seen" button
          (cv-sess-seen) — revealed on row hover, danger-tinted. The × is the row's only
          inline affordance: rename is double-click on the name (startEdit).
          EXCEPTION: while the conversation is actively running (turn in flight or
          background tools), the click opens a confirm first — deleting then stops the
          live session and can drop unfinished work (⌘Z restores the conversation but
          not the killed run). Idle/settled conversations keep the one-click delete. */}
      <button
        type="button"
        className="cv-sess-del"
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
          <strong>stop the Claude session</strong> and unfinished work may be lost. The
          conversation can still be restored with ⌘Z, but not the interrupted run.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** Open the native folder picker, then start a conversation in the chosen folder. */
async function newConversationInPickedFolder() {
  const path = await pickFolder();
  if (path) void createConversationInRepo(path);
}

/** One repo swimlane in the sidebar. Single-line header: collapse chevron + repo title,
 *  which flexes to run the full width up to the ALWAYS-visible new-conversation (+) button
 *  pinned at the right. Hovering the header slides in the secondary tools (worktrees,
 *  extensions) between the title and the +, at which point the title truncates to make room.
 *  So at rest the name reaches the right edge; the extra tools only appear on demand. The
 *  collapsed state is per-repo and persisted (see sidebarFold). */
function RepoGroup({
  repo,
  items,
  activeId,
}: {
  repo: { id: string; path: string };
  items: Conversation[];
  activeId: string | null;
}) {
  const collapsed = useRepoCollapsed(repo.id);
  const toggleFold = useSidebarFold((s) => s.toggle);
  const openManager = useWorktreeUi((s) => s.openManager);
  const openExtensions = useExtensionsUi((s) => s.openManager);
  const removeRepo = useConversationsStore((s) => s.removeRepo);
  const [confirming, setConfirming] = useState(false);

  // Whole header is the drag surface for reordering repositories (no grip). `listeners`
  // + the click guard go on the header row below; the group moves via transform.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: repo.id,
    data: { kind: "repo" } satisfies DragData,
  });
  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
  };

  return (
    <div ref={setNodeRef} style={dragStyle} className={"cv-repo" + (collapsed ? " collapsed" : "")}>
      <div className="cv-repo-h cv-draggable" {...listeners} onClickCapture={guardReorderClick}>
        {/* Chevron + title — the collapse toggle. Flexes to fill all the space the buttons
            leave, so at rest the name runs right up to the + at the edge. */}
        <button
          type="button"
          className="cv-repo-title"
          title={collapsed ? "Expand this repository" : "Collapse this repository"}
          aria-label={collapsed ? "Expand this repository" : "Collapse this repository"}
          aria-expanded={!collapsed}
          onClick={() => toggleFold(repo.id)}
        >
          <Ico name="chev" className="sm cv-repo-fold-chev" />
          <span className="cv-repo-n">{repoName(repo.path)}</span>
        </button>
        {/* Worktrees + extensions — revealed only on header hover (0-width at rest). */}
        <button
          type="button"
          className="cv-repo-act cv-repo-reveal"
          title="Open this repository's worktrees"
          onClick={() => openManager(repo.id)}
        >
          <Ico name="branch" className="sm" />
        </button>
        <button
          type="button"
          className="cv-repo-act cv-repo-reveal"
          title="This repository's extensions — MCP, plugins, skills, sub-agents"
          onClick={() =>
            openExtensions({
              kind: "project",
              // The repo button is Claude-oriented; the repo-level segmented Claude|Codex
              // view is a later, Armand-scoped iteration. A Codex conversation shows its
              // extensions via the composer chip instead.
              backend: "claude",
              path: repo.path,
              title: repoName(repo.path),
              session: null,
            })
          }
        >
          <Ico name="layers" className="sm" />
        </button>
        {/* Delete the whole repo section — revealed on hover like the other secondary tools,
            but danger-tinted and gated behind a confirm. Unlike the per-conversation × (which
            is friction-free and ⌘Z-undoable), removing a repo drops every conversation under it
            and is NOT undoable, so it takes a deliberate confirmation. */}
        <button
          type="button"
          className="cv-repo-act cv-repo-reveal cv-repo-del"
          title="Remove this repository from Flight Deck"
          aria-label="Remove this repository"
          onClick={() => setConfirming(true)}
        >
          <Ico name="trash" className="sm" />
        </button>
        {/* New conversation (+) — always visible, pinned at the right edge. Creates a
            (Claude-default) conversation; the BACKEND is chosen afterwards in the
            composer's model picker (picking a Codex model ⇒ a Codex conversation),
            which replaced the old Claude/Codex "+" menu. Backend stays fixed at the
            first message. */}
        <button
          type="button"
          className="cv-repo-act"
          title="New conversation in this repository"
          onClick={() => void createConversationInRepo(repo.path)}
        >
          <Ico name="plus" className="sm" />
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        danger
        title={`Remove "${repoName(repo.path)}"?`}
        confirmLabel="Remove repository"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          removeRepo(repo.path);
        }}
      >
        {items.length === 0
          ? "This repository will be removed from the sidebar. "
          : items.length === 1
            ? "This repository and its conversation will be removed from the sidebar. "
            : `This repository and its ${items.length} conversations will be removed from the sidebar. `}
        The folder and the on-disk transcripts are left untouched. Unlike deleting a
        conversation, this action cannot be undone (⌘Z).
      </ConfirmDialog>
      {collapsed ? null : items.length === 0 ? (
        <div className="cv-repo-empty">No conversations</div>
      ) : (
        <SortableContext items={items.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {items.map((c) => <ConvRow key={c.id} conv={c} active={c.id === activeId} />)}
        </SortableContext>
      )}
    </div>
  );
}

export function ConductorSidebar() {
  // Repo-grouped conversations — recency-ordered, or the user's manual drag order when
  // the "auto reorder" toggles are off (see useConversationsByRepo). `useSurfaceOrderDnd`
  // wraps them with the drag wiring; `groups` is what to render (an ephemeral recency-mode
  // drag override falls back to the automatic order on the next change).
  const { displayGroups: groups, sensors, onDragStart, onDragEnd, onDragCancel } =
    useSurfaceOrderDnd("sidebar", useConversationsByRepo());
  const activeId = useActiveConversationId();
  const openHistory = useHistoryUi((s) => s.openPanel);
  const settingsOpen = useSettingsUi((s) => s.open);
  const openSettings = useSettingsUi((s) => s.openSettings);
  const closeSettings = useSettingsUi((s) => s.closeSettings);
  const showFleet = useDisplay((s) => s.fleetBannerConversation);

  // Resizable width, persisted (localStorage). The grip is an absolute handle on the
  // right edge (reusing the editor's Splitter for pointer-capture + hover accent), so
  // resizing stays self-contained here — the parent flex row is untouched.
  const width = useSidebar((s) => s.width);
  const setWidth = useSidebar((s) => s.setWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const onResize = (clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWidth(clientX - rect.left);
  };

  return (
    <div
      ref={rootRef}
      className="wf-col cv-side"
      style={{
        width,
        flex: `0 0 ${width}px`,
        position: "relative",
        borderRight: "1px solid var(--wf-line)",
        background: "var(--wf-bg-2)",
      }}
    >
      <div className="cv-side-h">
        <span className="wf-row" style={{ gap: 8 }}>
          <TosseMark className="cv-brand-mark" />
          <span className="wf-hi" style={{ fontWeight: 600 }}>
            Flight Deck
          </span>
        </span>
        <Menu
          align="right"
          trigger={
            <button className="wf-icon-btn" title="New conversation">
              <Ico name="plus" className="sm" />
            </button>
          }
        >
          <MenuLabel>New conversation in…</MenuLabel>
          {groups.map(({ repo: r }) => (
            <MenuItem key={r.id} icon="folder" onClick={() => void createConversationInRepo(r.path)}>
              {repoName(r.path)}
            </MenuItem>
          ))}
          <MenuItem icon="plus" onClick={() => void newConversationInPickedFolder()}>
            Add a folder…
          </MenuItem>
        </Menu>
      </div>

      <button
        type="button"
        className="cv-search"
        title="Search the conversation history (entire disk)"
        onClick={() => openHistory()}
      >
        <Ico name="search" className="sm" />
        <span className="wf-xmuted" style={{ fontSize: 12 }}>
          History
        </span>
      </button>

      <div className="cv-sess-scroll">
        {groups.length === 0 ? (
          <div style={{ padding: "20px 12px", color: "var(--wf-tx-lo)", fontSize: 12, lineHeight: 1.6 }}>
            No repositories. Click <span className="wf-hi">＋</span> to open a folder.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={orderCollisionDetection}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
          >
            <SortableContext
              items={groups.map((g) => g.repo.id)}
              strategy={verticalListSortingStrategy}
            >
              {groups.map(({ repo, conversations: items }) => (
                <RepoGroup key={repo.id} repo={repo} items={items} activeId={activeId} />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Compact whole-fleet readout, pinned just above the Settings footer. Counts
          span every conversation (not just this repo), so it matches the FlightDeck
          bar. Hidden via Settings → General (independent of the FlightDeck toggle). */}
      {showFleet ? <FleetReadout variant="sidebar" /> : null}

      <button
        type="button"
        className="cv-side-foot"
        onClick={() => openSettings()}
        style={{
          background: "transparent",
          borderLeft: 0,
          borderRight: 0,
          borderBottom: 0,
          width: "100%",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <Ico name="cog" className="sm" />
        <span className="wf-muted" style={{ fontSize: 12 }}>
          Settings
        </span>
      </button>

      <SettingsPanel open={settingsOpen} onClose={closeSettings} />

      {/* Drag handle on the right edge — resizes the sidebar, width persisted. */}
      <div className="cv-side-grip">
        <Splitter axis="x" onMove={onResize} />
      </div>
    </div>
  );
}
