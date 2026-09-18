// The strip at the bottom of the IDE view: where you are (branch, sync state, pending
// changes, folder) on the left; the panel toggles on the right — which is also how a
// closed dock is reopened on a given mode.
import { Ico } from "../../ui/kit";
import { useGitAutoRefresh, useGitStatus } from "../../ipc/useGit";
import { useConversations, useRepos } from "../../store/conversationsStore";
import { AttentionPips } from "./IdeAttention";
import {
  splitConversationTabs,
  useIdeStore,
  workspaceConversations,
  type DockMode,
  type IdeWorkspace,
} from "./ideStore";
import styles from "./ide.module.css";

export function IdeStatusBar({ ws }: { ws: IdeWorkspace }) {
  // A folder that is not a git repository makes this query fail — an ordinary outcome
  // here, not an error to report: the branch segment simply is not shown.
  const git = useGitStatus(ws.path).data ?? null;
  // Follows the workspace's fs watch (the explorer keeps it pointed here), so the pending
  // change count moves as the agents write.
  useGitAutoRefresh(ws.path);
  const dockOpen = useIdeStore((s) => s.dockOpen);
  const dockMode = useIdeStore((s) => s.dockMode);
  const showDock = useIdeStore((s) => s.showDock);
  const setDockOpen = useIdeStore((s) => s.setDockOpen);
  const conversations = useConversations();
  const repos = useRepos();
  const allConvs = workspaceConversations(ws, conversations, repos);
  // The count is the tabs on show; the pips listen to EVERY conversation of the folder —
  // closing a tab must not silence an agent that needs you.
  const convIds = allConvs.map((c) => c.id);
  const openTabCount = splitConversationTabs(allConvs, ws.closedConvIds).open.length;

  // Clicking the mode already on screen closes the panel; anything else shows that mode.
  const toggle = (mode: DockMode) => {
    if (dockOpen && dockMode === mode) setDockOpen(false);
    else showDock(mode);
  };

  return (
    <div className={styles.status}>
      {git ? (
        <span className={styles.statusItem} title={git.upstream ? `Tracking ${git.upstream}` : "No upstream"}>
          <Ico name="branch" className="sm" />
          {git.branch ?? (git.head ? git.head.slice(0, 7) : "no commits")}
          {git.ahead > 0 ? <span className={styles.statusDim}>↑{git.ahead}</span> : null}
          {git.behind > 0 ? <span className={styles.statusDim}>↓{git.behind}</span> : null}
        </span>
      ) : null}
      {git && git.files.length > 0 ? (
        <span className={styles.statusItem} title="Files changed in the working tree">
          <Ico name="diff" className="sm" />
          {git.files.length}
        </span>
      ) : null}
      <span className={styles.statusPath} title={ws.path}>
        {/* The box is RTL so an overlong path is cut on the LEFT; <bdi> keeps the path
            itself left-to-right — without it the leading "/" is reordered to the end. */}
        <bdi>{ws.path}</bdi>
      </span>
      <span className={styles.statusSpacer} />
      <button
        type="button"
        className={styles.statusBtn}
        data-on={dockOpen && dockMode === "terminals" ? "" : undefined}
        onClick={() => toggle("terminals")}
        title="Terminals"
      >
        <Ico name="term" className="sm" />
        Terminals
        {ws.terminals.length > 0 ? <span className={styles.statusDim}>{ws.terminals.length}</span> : null}
      </button>
      <button
        type="button"
        className={styles.statusBtn}
        data-on={dockOpen && dockMode === "conversations" ? "" : undefined}
        onClick={() => toggle("conversations")}
        title="Conversations"
      >
        <Ico name="chat" className="sm" />
        Conversations
        {openTabCount > 0 ? <span className={styles.statusDim}>{openTabCount}</span> : null}
        {/* With the conversations off screen, a waiting agent shows up here. */}
        {dockOpen && dockMode === "conversations" ? null : <AttentionPips convIds={convIds} />}
      </button>
    </div>
  );
}
