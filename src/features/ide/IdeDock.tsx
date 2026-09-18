// The IDE's dock — the panel under (or beside) the editor, the size an IDE gives its
// terminal. It has two MODES, flipped from its header:
//
//   • Terminals      — as many shells as the workspace needs, one tab each;
//   • Conversations  — the workspace's agent conversations, one tab each, every tab
//                      carrying the agent's live state the way a Flight Deck card does,
//                      and the selected one shown in full (thread + composer).
//
// Both are mounts of things that already exist: a terminal tab is a `termManager` entry
// (so a shell keeps running while another tab, the other mode, or another VIEW is on
// screen), and a conversation tab shows the same `ConversationPane` as the conversation
// view. The conversation on screen here IS the app's active conversation — see ideStore.
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Dot, Ico, Menu, MenuItem, MenuLabel, RunPulse, WF_STATUS } from "../../ui/kit";
import { agentStatusToDot, backgroundCount, rowAttention, type AgentStatus } from "../../agent/status";
import { useAgentStatus } from "../../agent/useAgentStatus";
import { useActivityLabel } from "../../store/activity";
import { useSessionState } from "../../store/conversationStore";
import {
  createConversationInRepo,
  createConversationInWorktree,
  loadConversationHistory,
  useActiveConversationId,
  useConversations,
  useConversationsStore,
  useRepos,
  type Conversation,
} from "../../store/conversationsStore";
import { ConversationPane } from "../conversation/ConversationPane";
import type { ComposerHandle } from "../conversation/ConductorComposer";
import { useEditorStore } from "../editor/editorStore";
import { effectiveCwd } from "../git/worktree";
import { AttentionPips } from "./IdeAttention";
import {
  dockedConversation,
  editorKeyFor,
  isOutsideWorkspace,
  neighbourAfterClose,
  normalizeFolder,
  splitConversationTabs,
  useIdeStore,
  workspaceConversations,
  workspaceLabel,
  workspaceRepoId,
  type DockMode,
  type IdeTerminal,
  type IdeWorkspace,
} from "./ideStore";
import styles from "./ide.module.css";

// Lazy for the same reason as in the conversation view: xterm.js + its addons stay out of
// the startup bundle until a terminal is actually shown.
const TerminalView = lazy(() => import("../terminal/TerminalView"));

// Clicks on these must not be hijacked to focus the composer — same list as the other
// surfaces that mount a ConversationPane.
const INTERACTIVE =
  'a, button, input, textarea, select, label, summary, [role="button"], [role="option"], [role="tab"], [contenteditable="true"]';

export function IdeDock({
  ws,
  onOpenConversation,
  onMoveStart,
  moving = false,
}: {
  ws: IdeWorkspace;
  onOpenConversation: (id: string) => void;
  /** Starts a drag of the whole panel (see `useDockDrag`), wired to the header's grip and
   *  to its non-interactive background — never to a tab, the mode switch or a button,
   *  whose clicks must keep working exactly as before. Optional: without it the dock still
   *  moves through the header's "Move the panel" button. */
  onMoveStart?: (e: ReactPointerEvent) => void;
  /** True while such a drag is in flight — the header wears the `grabbing` cursor. */
  moving?: boolean;
}) {
  const mode = useIdeStore((s) => s.dockMode);
  const position = useIdeStore((s) => s.dockPosition);
  const maximized = useIdeStore((s) => s.dockMaximized);
  const showDock = useIdeStore((s) => s.showDock);
  const setDockOpen = useIdeStore((s) => s.setDockOpen);
  const setDockPosition = useIdeStore((s) => s.setDockPosition);
  const setDockMaximized = useIdeStore((s) => s.setDockMaximized);
  const addTerminal = useIdeStore((s) => s.addTerminal);

  const conversations = useConversations();
  const repos = useRepos();
  const activeId = useActiveConversationId();
  // Creation order, oldest first: a tab strip that re-sorts itself on every message moves
  // the tab you were about to click. New conversations arrive on the right, as tabs do.
  const allConvs = useMemo(
    () => workspaceConversations(ws, conversations, repos).sort((a, b) => a.createdAt - b.createdAt),
    [ws, conversations, repos],
  );
  // `convs` = the tabs on show; `closedConvs` = tabs the user closed here (still alive
  // everywhere else, reopenable from the header). Attention pips read `allConvs`: closing
  // a tab must never be a way to stop hearing from an agent that needs you.
  const { open: convs, closed: closedConvs } = useMemo(
    () => splitConversationTabs(allConvs, ws.closedConvIds),
    [allConvs, ws.closedConvIds],
  );
  // The conversation on screen: the app's active one when it is a tab of this folder, else
  // this workspace's own — DISPLAYED, never selected (see `dockedConversation` for why a
  // mere visit to the IDE view must not move the app's selection).
  const shownConv = useMemo(
    () => dockedConversation(convs, activeId, ws.lastConvId),
    [convs, activeId, ws.lastConvId],
  );
  const shownId = shownConv?.id ?? null;

  // Remember it per workspace, so coming back to a folder returns to ITS conversation — and
  // so it stays pinned in the strip if its agent walks out of the folder meanwhile.
  useEffect(() => {
    if (shownId) useIdeStore.getState().noteConversation(ws.id, shownId);
  }, [ws.id, shownId]);

  // Tell the notification gate what is actually on screen here: the docked conversation may
  // not be the active one, and an OS banner over a thread the user is reading is noise.
  // Only while the Conversations mode shows it; cleared when the dock goes away.
  useEffect(() => {
    const setWatched = useIdeStore.getState().setWatchedConv;
    setWatched(mode === "conversations" ? shownId : null);
    return () => setWatched(null);
  }, [mode, shownId]);

  // The first visit to Terminals opens a shell — an empty terminal panel asking for a
  // click would be pure friction. `termSeq === 0` = "never had one": closing the last
  // terminal on purpose must NOT respawn it.
  useEffect(() => {
    if (mode === "terminals" && ws.termSeq === 0) addTerminal(ws.id);
  }, [mode, ws.id, ws.termSeq, addTerminal]);

  const newConversation = () => {
    const repoId = workspaceRepoId(ws, repos);
    const repo = repos.find((r) => r.id === repoId) ?? null;
    // A workspace opened on a WORKTREE starts its agents in that worktree, grouped under
    // the parent repository. Anything else is (or becomes) a repository of its own.
    if (repo && normalizeFolder(repo.path) !== ws.path) createConversationInWorktree(repo.id, ws.path);
    else createConversationInRepo(ws.path);
    showDock("conversations");
  };

  // Close a conversation's TAB (the conversation itself is untouched). When it is the one
  // on screen, the dock moves to its NEIGHBOUR — the tab that slides under the pointer —
  // by noting it as this workspace's conversation. The app's selection is left alone: a
  // closed tab simply stops being a candidate (`dockedConversation` only looks at open
  // tabs), so the closed conversation can stay active elsewhere without showing here.
  const closeConversationTab = (convId: string) => {
    if (convId === shownId) {
      const next = neighbourAfterClose(
        convs.map((c) => c.id),
        convId,
        convId,
      );
      if (next) useIdeStore.getState().noteConversation(ws.id, next);
    }
    useIdeStore.getState().closeConversationTab(ws.id, convId);
  };

  const reopenConversationTab = (convId: string) => {
    useIdeStore.getState().reopenConversationTab(ws.id, convId);
    useConversationsStore.getState().selectConversation(convId);
    showDock("conversations");
  };

  // A press that landed on the header's OWN background (the gaps around the switch, the
  // empty end of the tab strip) drags the panel. `e.target === e.currentTarget` is the
  // whole test: anything that landed on a child belongs to that child, so there is no list
  // of interactive elements to keep in step.
  const onFillerPointerDown = (e: ReactPointerEvent) => {
    if (e.target === e.currentTarget) onMoveStart?.(e);
  };

  return (
    <div className={styles.dock} data-position={position}>
      <div className={styles.dockHead} data-dragging={moving ? "" : undefined} onPointerDown={onFillerPointerDown}>
        {/* The affordance the whole feature hangs on: the panel can be moved, and this is
            where you take hold of it. Hidden from assistive tech — the accessible path is
            the "Move the panel" button on the right, which does the same in one click. */}
        <div
          className={styles.grip}
          aria-hidden="true"
          title="Drag to move the panel — bottom or right"
          onPointerDown={(e) => onMoveStart?.(e)}
        >
          <Ico name="grip" className="sm" />
        </div>
        <div className={styles.modeSwitch} role="tablist" aria-label="Panel">
          <ModeButton mode="terminals" current={mode} icon="term" label="Terminals" onSelect={showDock}>
            {ws.terminals.length > 0 ? <span className={styles.count}>{ws.terminals.length}</span> : null}
          </ModeButton>
          <ModeButton mode="conversations" current={mode} icon="chat" label="Conversations" onSelect={showDock}>
            {convs.length > 0 ? <span className={styles.count}>{convs.length}</span> : null}
            {/* While the shells are on screen, this is where a waiting agent shows up —
                closed tabs included. */}
            {mode === "terminals" ? <AttentionPips convIds={allConvs.map((c) => c.id)} /> : null}
          </ModeButton>
        </div>

        <div className={styles.tabStrip} role="tablist" onPointerDown={onFillerPointerDown}>
          {mode === "terminals"
            ? ws.terminals.map((t) => (
                <TerminalTab key={t.id} ws={ws} term={t} active={t.id === ws.activeTerminalId} />
              ))
            : convs.map((c) => (
                <ConversationTab
                  key={c.id}
                  conv={c}
                  active={c.id === shownId}
                  // Pinned although its agent left this folder (see workspaceConversations):
                  // the tab says so instead of passing for one of the folder's own.
                  outsideOf={isOutsideWorkspace(ws, c) ? workspaceLabel(ws.path) : null}
                  onClose={() => closeConversationTab(c.id)}
                />
              ))}
          <button
            type="button"
            className={styles.tabAdd}
            onClick={() => (mode === "terminals" ? addTerminal(ws.id) : newConversation())}
            title={mode === "terminals" ? "New terminal" : "New conversation in this folder"}
            aria-label={mode === "terminals" ? "New terminal" : "New conversation"}
          >
            <Ico name="plus" className="sm" />
          </button>
        </div>

        <div className={styles.dockActions}>
          {/* Closed tabs are one click away, never gone: the list appears as soon as there
              is something to reopen. A waiting agent behind a closed tab pips here. */}
          {mode === "conversations" && closedConvs.length > 0 ? (
            <Menu
              portal
              align="right"
              trigger={
                <button
                  type="button"
                  className={styles.reopenBtn}
                  title="Reopen a closed conversation tab"
                  aria-label="Reopen a closed conversation tab"
                >
                  <Ico name="list" className="sm" />
                  <span className={styles.count}>{closedConvs.length}</span>
                  <AttentionPips convIds={closedConvs.map((c) => c.id)} />
                </button>
              }
            >
              <MenuLabel>Closed tabs — click to reopen</MenuLabel>
              {closedConvs.map((c) => (
                <MenuItem key={c.id} icon="chat" onClick={() => reopenConversationTab(c.id)}>
                  {c.name}
                </MenuItem>
              ))}
            </Menu>
          ) : null}
          {mode === "conversations" && shownConv ? (
            <button
              type="button"
              className={styles.headBtn}
              onClick={() => onOpenConversation(shownConv.id)}
              title="Open in the Conversation view"
              aria-label="Open in the Conversation view"
            >
              <Ico name="external" className="sm" />
            </button>
          ) : null}
          <button
            type="button"
            className={styles.headBtn}
            onClick={() => setDockPosition(position === "bottom" ? "right" : "bottom")}
            // The one-click path. It names the drag too, so the grip on the left is never
            // the only place the second way of moving the panel is mentioned.
            title={
              position === "bottom"
                ? "Move the panel to the right — or drag it by the grip on the left"
                : "Move the panel to the bottom — or drag it by the grip on the left"
            }
            aria-label="Move the panel"
          >
            <Ico name={position === "bottom" ? "splith" : "splitv"} className="sm" />
          </button>
          <button
            type="button"
            className={styles.headBtn}
            data-on={maximized ? "" : undefined}
            onClick={() => setDockMaximized(!maximized)}
            title={maximized ? "Restore the panel size" : "Maximize the panel"}
            aria-label={maximized ? "Restore the panel size" : "Maximize the panel"}
          >
            <Ico name="chev" className={"sm " + (maximized ? "" : styles.flip)} />
          </button>
          <button
            type="button"
            className={styles.headBtn}
            onClick={() => setDockOpen(false)}
            title="Close the panel (⌘J)"
            aria-label="Close the panel"
          >
            <Ico name="x" className="sm" />
          </button>
        </div>
      </div>

      <div className={styles.dockBody}>
        {mode === "terminals" ? (
          <TerminalBody ws={ws} onNew={() => addTerminal(ws.id)} />
        ) : shownConv ? (
          <DockedConversation key={shownConv.id} ws={ws} conv={shownConv} />
        ) : (
          <div className={styles.empty}>
            <p>
              {closedConvs.length > 0
                ? "Every conversation tab of this folder is closed."
                : "No conversation in this folder yet."}
            </p>
            <div className={styles.emptyActions}>
              <button type="button" className="wf-btn sm" onClick={newConversation}>
                <Ico name="plus" className="sm" />
                New conversation
              </button>
              {closedConvs.length > 0 ? (
                <button
                  type="button"
                  className="wf-btn ghost sm"
                  // The most recently closed one: the likeliest "oops".
                  onClick={() => reopenConversationTab(closedConvs[closedConvs.length - 1].id)}
                >
                  Reopen the last closed tab
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  mode,
  current,
  icon,
  label,
  onSelect,
  children,
}: {
  mode: DockMode;
  current: DockMode;
  icon: string;
  label: string;
  onSelect: (m: DockMode) => void;
  children?: React.ReactNode;
}) {
  const on = mode === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={styles.modeBtn}
      data-on={on ? "" : undefined}
      onClick={() => onSelect(mode)}
      // The label is dropped when the dock sits beside the editor (see the stylesheet).
      title={label}
    >
      <Ico name={icon} className="sm" />
      <span className={styles.modeLabel}>{label}</span>
      {children}
    </button>
  );
}

// ---- Terminals -----------------------------------------------------------------------

function TerminalTab({ ws, term, active }: { ws: IdeWorkspace; term: IdeTerminal; active: boolean }) {
  const setActiveTerminal = useIdeStore((s) => s.setActiveTerminal);
  const closeTerminal = useIdeStore((s) => s.closeTerminal);
  const renameTerminal = useIdeStore((s) => s.renameTerminal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(term.title);
  // Enter commits and Escape cancels, but BOTH also blur the input — this flag keeps the
  // trailing blur from committing a rename the user just cancelled.
  const settled = useRef(false);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    renameTerminal(ws.id, term.id, draft);
  };

  return (
    <div
      role="tab"
      // Focusable + Enter/Space: a div-based tab is otherwise out of reach of the keyboard
      // (a <button> cannot be used — the tab carries its own close button).
      tabIndex={0}
      aria-selected={active}
      className={styles.tab}
      data-on={active ? "" : undefined}
      onClick={() => setActiveTerminal(ws.id, term.id)}
      onKeyDown={(e) => {
        // Only the tab's own keys: the rename input and the close button handle theirs.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setActiveTerminal(ws.id, term.id);
        }
      }}
      onDoubleClick={() => {
        settled.current = false;
        setDraft(term.title);
        setEditing(true);
      }}
      title={editing ? undefined : `${term.title} — double-click to rename`}
    >
      <Ico name="term" className="sm" />
      {editing ? (
        <input
          className={styles.tabEdit}
          value={draft}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              settled.current = true;
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span className={styles.tabName}>{term.title}</span>
      )}
      <button
        type="button"
        className={styles.tabClose}
        aria-label={`Close ${term.title}`}
        title="Kill this terminal"
        onClick={(e) => {
          e.stopPropagation();
          closeTerminal(ws.id, term.id);
        }}
      >
        <Ico name="x" className="sm" />
      </button>
    </div>
  );
}

function TerminalBody({ ws, onNew }: { ws: IdeWorkspace; onNew: () => void }) {
  const active = ws.terminals.find((t) => t.id === ws.activeTerminalId) ?? null;
  if (!active) {
    return (
      <div className={styles.empty}>
        <p>No terminal open.</p>
        <button type="button" className="wf-btn sm" onClick={onNew}>
          <Ico name="plus" className="sm" />
          New terminal
        </button>
      </div>
    );
  }
  return (
    <Suspense fallback={<div className={styles.bodyFill} />}>
      {/* Keyed by terminal: switching tabs detaches one long-lived xterm host and attaches
          another — neither shell is touched (see termManager). */}
      <TerminalView key={active.id} convId={active.id} cwd={ws.path} stacked={false} flush />
    </Suspense>
  );
}

// ---- Conversations -------------------------------------------------------------------

function ConversationTab({
  conv,
  active,
  outsideOf,
  onClose,
}: {
  conv: Conversation;
  active: boolean;
  /** Set (to the folder's label) when this conversation's agent has LEFT the workspace's
   *  folder and the tab is only here because it is the one being watched. */
  outsideOf: string | null;
  onClose: () => void;
}) {
  const status = useAgentStatus(conv.id);
  const select = useConversationsStore((s) => s.selectConversation);
  return (
    // A div, not a button: the tab carries its own close BUTTON, and a button inside a
    // button is invalid — same structure as the terminal tabs. Keyboard-reachable through
    // tabIndex + Enter/Space.
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      className={styles.tab + " " + styles.convTab}
      data-on={active ? "" : undefined}
      data-attn={rowAttention(status) ?? undefined}
      data-outside={outsideOf ? "" : undefined}
      // A click is an EXPLICIT pick: this is one of the few places the dock changes the
      // app's active conversation (see `dockedConversation`).
      onClick={() => select(conv.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(conv.id);
        }
      }}
      // Middle-click closes, as tabs do everywhere.
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      title={
        outsideOf
          ? `${conv.name} — its agent has left ${outsideOf} (it now works elsewhere); kept here because it is the conversation on screen`
          : conv.name
      }
    >
      {status.kind === "running" ? (
        <RunPulse />
      ) : (
        <Dot s={agentStatusToDot(status)} pulse ring={backgroundCount(status) > 0} />
      )}
      {/* Keyed by the name: WebKit fails to repaint an ellipsised box whose text changes
          at an identical size (the sidebar's "ghost title") — a fresh node paints clean. */}
      <span key={conv.name} className={styles.tabName}>
        {conv.name}
      </span>
      {outsideOf ? (
        <span className={styles.tabOutside} aria-label={`left ${outsideOf}`}>
          <Ico name="external" className="sm" />
        </span>
      ) : null}
      <TabState convId={conv.id} status={status} />
      <button
        type="button"
        className={styles.tabClose}
        aria-label={`Close the ${conv.name} tab`}
        // Said out loud, because × DELETES a conversation in the sidebar and on the
        // Flight Deck: here it only puts the tab away.
        title="Close this tab — the conversation is kept, and can be reopened from the panel header"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <Ico name="x" className="sm" />
      </button>
    </div>
  );
}

/** Where the agent is, in a few words — the Flight Deck's reading of a conversation,
 *  folded into its tab. Nothing at all while it is idle or off: a calm tab stays quiet. */
function TabState({ convId, status }: { convId: string; status: AgentStatus }) {
  if (status.kind === "running") return <RunningLabel convId={convId} />;
  if (status.kind === "idle" || status.kind === "off") return null;
  const dot = agentStatusToDot(status);
  return (
    <span className={styles.tabState} data-s={dot}>
      {WF_STATUS[dot].label}
    </span>
  );
}

/** Mounted only while the agent runs, so the once-a-second activity derivation it carries
 *  costs nothing for the tabs that are not working (same trick as the deck's ActivityLine). */
function RunningLabel({ convId }: { convId: string }) {
  const text = useActivityLabel(convId);
  return (
    <span className={styles.tabState} data-s="work">
      {text}
    </span>
  );
}

function DockedConversation({ ws, conv }: { ws: IdeWorkspace; conv: Conversation }) {
  const composerRef = useRef<ComposerHandle>(null);
  const liveState = useSessionState(conv.id);
  const cwd = effectiveCwd(conv, liveState);

  // Replay the on-disk transcript into the message store (idempotent, at most once per
  // conversation) — exactly what the conversation view does on selection.
  useEffect(() => {
    void loadConversationHistory(conv.id);
  }, [conv.id]);

  // A file the agent mentions opens in the WORKSPACE's editor, right above this panel —
  // not in the conversation's own side region, which is not on screen here. Stable
  // identity: it feeds a memoized context that every mention in the thread reads.
  const openInWorkspace = useCallback(
    (abs: string, opts?: { line?: number; column?: number }) => {
      const key = editorKeyFor(ws.id);
      const editor = useEditorStore.getState();
      editor.ensureConv(key, ws.path);
      void editor.openFile(key, abs, {
        preview: true,
        reveal: opts?.line != null ? { line: opts.line, column: opts.column } : undefined,
      });
      // A maximized panel hides the editor: opening a file there would do nothing visible.
      useIdeStore.getState().setDockMaximized(false);
    },
    [ws.id, ws.path],
  );

  const focusComposerOnClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!window.getSelection()?.isCollapsed) return;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    composerRef.current?.focus();
  };

  return (
    <ConversationPane
      session={conv.id}
      cwd={cwd}
      composerRef={composerRef}
      onBackgroundClick={focusComposerOnClick}
      onOpenMention={openInWorkspace}
      // The composer's editor / terminal / Git buttons drive the CONVERSATION view's
      // panels; here they would flip persisted flags with nothing to show for it.
      hasPanels={false}
    />
  );
}
