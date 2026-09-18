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
} from "react";
import { Dot, Ico, RunPulse, WF_STATUS } from "../../ui/kit";
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
  editorKeyFor,
  normalizeFolder,
  useIdeStore,
  workspaceConversations,
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
}: {
  ws: IdeWorkspace;
  onOpenConversation: (id: string) => void;
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
  const convs = useMemo(
    () => workspaceConversations(ws, conversations, repos).sort((a, b) => a.createdAt - b.createdAt),
    [ws, conversations, repos],
  );
  const activeConv = convs.find((c) => c.id === activeId) ?? null;

  // The dock shows the app's ACTIVE conversation. When that one belongs elsewhere (the
  // user came from another folder), land on this workspace's own: the one it showed last,
  // else its most recent. Only while the Conversations mode is on screen — browsing files
  // or running a shell must not move the selection behind the user's back.
  useEffect(() => {
    if (mode !== "conversations" || activeConv || convs.length === 0) return;
    const target =
      convs.find((c) => c.id === ws.lastConvId) ??
      [...convs].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    useConversationsStore.getState().selectConversation(target.id);
  }, [mode, activeConv, convs, ws.lastConvId]);

  useEffect(() => {
    if (activeConv) useIdeStore.getState().noteConversation(ws.id, activeConv.id);
  }, [ws.id, activeConv]);

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

  return (
    <div className={styles.dock} data-position={position}>
      <div className={styles.dockHead}>
        <div className={styles.modeSwitch} role="tablist" aria-label="Panel">
          <ModeButton mode="terminals" current={mode} icon="term" label="Terminals" onSelect={showDock}>
            {ws.terminals.length > 0 ? <span className={styles.count}>{ws.terminals.length}</span> : null}
          </ModeButton>
          <ModeButton mode="conversations" current={mode} icon="chat" label="Conversations" onSelect={showDock}>
            {convs.length > 0 ? <span className={styles.count}>{convs.length}</span> : null}
            {/* While the shells are on screen, this is where a waiting agent shows up. */}
            {mode === "terminals" ? <AttentionPips convIds={convs.map((c) => c.id)} /> : null}
          </ModeButton>
        </div>

        <div className={styles.tabStrip} role="tablist">
          {mode === "terminals"
            ? ws.terminals.map((t) => (
                <TerminalTab key={t.id} ws={ws} term={t} active={t.id === ws.activeTerminalId} />
              ))
            : convs.map((c) => <ConversationTab key={c.id} conv={c} active={c.id === activeId} />)}
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
          {mode === "conversations" && activeConv ? (
            <button
              type="button"
              className={styles.headBtn}
              onClick={() => onOpenConversation(activeConv.id)}
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
            title={position === "bottom" ? "Move the panel to the right" : "Move the panel to the bottom"}
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
        ) : activeConv ? (
          <DockedConversation key={activeConv.id} ws={ws} conv={activeConv} />
        ) : (
          <div className={styles.empty}>
            <p>No conversation in this folder yet.</p>
            <button type="button" className="wf-btn sm" onClick={newConversation}>
              <Ico name="plus" className="sm" />
              New conversation
            </button>
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
      aria-selected={active}
      className={styles.tab}
      data-on={active ? "" : undefined}
      onClick={() => setActiveTerminal(ws.id, term.id)}
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

function ConversationTab({ conv, active }: { conv: Conversation; active: boolean }) {
  const status = useAgentStatus(conv.id);
  const select = useConversationsStore((s) => s.selectConversation);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={styles.tab + " " + styles.convTab}
      data-on={active ? "" : undefined}
      data-attn={rowAttention(status) ?? undefined}
      onClick={() => select(conv.id)}
      title={conv.name}
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
      <TabState convId={conv.id} status={status} />
    </button>
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
