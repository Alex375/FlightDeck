// "Open in IDE" — the ONE implementation behind every entry point: the sidebar's
// repository button, the title-bar button, the composer action, the ⌘⇧I chord and the
// IDE's own "open a folder" menu. Each opens (or focuses) a workspace and asks App to put
// the IDE view on screen; none of them switches the view itself (App owns that).
import { pickFolder } from "../../ipc/pickFolder";
import { useConversationsStore, type Repo } from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import { useDisplay } from "../../store/display";
import { useEditorStore } from "../editor/editorStore";
import { effectiveCwd } from "../git/worktree";
import { editorKeyFor, useIdeStore, workspaceConversations } from "./ideStore";

/** Why a repository cannot be opened in the IDE, or null when it can. PURE, so a button
 *  can grey itself out WITH the reason instead of clicking into an empty explorer: the
 *  editor reads this Mac's disk, and a remote repository's files are not on it. */
export function ideBlockedReason(repo: Pick<Repo, "machineId"> | null | undefined): string | null {
  if (repo?.machineId) return "The IDE browses this Mac's files — this repository lives on a remote server.";
  return null;
}

/** Where the "IDE view" switch lives, spelled ONCE: a refusal that sends the user (or an
 *  agent) to a Settings page that does not exist is its own dead end. "Display" is a
 *  top-level Settings tab, "IDE" its sub-page. */
export const IDE_SETTING_PATH = "Settings → Display → IDE";

/** Why "Open in IDE" is refused for a conversation of `repo`, the preference included — what
 *  a user-made composer button shows when it greys itself out. PURE. */
export function openInIdeBlockedReason(
  repo: Pick<Repo, "machineId"> | null | undefined,
  ideViewEnabled: boolean,
): string | null {
  if (!ideViewEnabled) return `The IDE view is switched off — ${IDE_SETTING_PATH}.`;
  return ideBlockedReason(repo);
}

/** The IDE view is a preference (see {@link IDE_SETTING_PATH}). Every opener checks it, so
 *  a chord or a user-made composer button cannot land on a view that is switched off. */
function ideEnabled(): boolean {
  return useDisplay.getState().ideView;
}

/** Open a repository's folder as a workspace and show the IDE. False = refused (remote
 *  repository, or the view is switched off). */
export function openRepoInIde(repo: Repo): boolean {
  if (!ideEnabled() || ideBlockedReason(repo)) return false;
  const ide = useIdeStore.getState();
  ide.openWorkspace(repo.path, repo.id);
  ide.show();
  return true;
}

/**
 * Open a conversation in the IDE: the folder it is working in RIGHT NOW (a worktree, when
 * the agent moved into one) becomes the workspace, the files it has open in the
 * conversation view's editor come along as tabs, and the dock shows the conversation
 * itself — so "open in IDE" continues what was on screen rather than starting over.
 */
export function openConversationInIde(convId: string): boolean {
  const store = useConversationsStore.getState();
  const conv = store.conversations.find((c) => c.id === convId);
  if (!conv) return false;
  const repo = store.repos.find((r) => r.id === conv.repoId) ?? null;
  if (!ideEnabled() || ideBlockedReason(repo)) return false;

  const cwd = effectiveCwd(conv, useConversationStore.getState().sessions[convId]?.state);
  const ide = useIdeStore.getState();
  const wsId = ide.openWorkspace(cwd, conv.repoId);
  const ws = useIdeStore.getState().workspaces.find((w) => w.id === wsId);
  if (ws) carryOpenFiles(convId, editorKeyFor(wsId), ws.path);

  // Asking for THIS conversation in the IDE overrides having closed its tab there earlier.
  ide.reopenConversationTab(wsId, convId);
  store.selectConversation(convId);
  ide.showDock("conversations");
  ide.show();
  return true;
}

/** Copy a conversation's open editor tabs into a workspace's editor, active tab last so
 *  it ends up focused. Pinned (not preview) tabs: they were deliberately brought along. */
function carryOpenFiles(convId: string, editorKey: string, root: string): void {
  const editor = useEditorStore.getState();
  const source = editor.byConv[convId];
  if (!source || source.tabs.length === 0) return;
  editor.ensureConv(editorKey, root);
  const ordered = source.tabs.filter((p) => p !== source.activeTab);
  if (source.activeTab) ordered.push(source.activeTab);
  for (const path of ordered) void editor.openFile(editorKey, path);
}

/**
 * Open ONE file, at an optional line/column, in the IDE workspace for a conversation's
 * folder — the app-control `open_file` tool's `view: "ide"` path. Unlike
 * `openConversationInIde` (which carries a conversation's WHOLE editor state along), this
 * targets a single file an agent just named. Returns the workspace id, or null when the
 * conversation no longer exists.
 *
 * Deliberately narrow: it does NOT check the IDE-enabled / remote-repo gates (the caller
 * does, so each caller can word its own refusal) and does NOT switch the view (the caller
 * owns that, same contract as every other opener here). It also never routes through
 * `revealInEditor` — that helper mutates the CONVERSATION view's global layout flags
 * (`setOpen`/`setTreeCollapsed`), which have nothing to do with a workspace's own editor.
 */
export function openFileInIde(
  convId: string,
  cwd: string,
  abs: string,
  opts?: { line?: number; column?: number },
): string | null {
  const store = useConversationsStore.getState();
  const conv = store.conversations.find((c) => c.id === convId);
  if (!conv) return null;

  const ide = useIdeStore.getState();
  // Stay in the workspace ON SCREEN whenever it holds this conversation — WHETHER OR NOT
  // the file sits under its root. Opening (or focusing) another workspace swaps the whole
  // IDE — explorer, tabs, terminals, dock — under the user, which a background agent must
  // never be able to do. The file being elsewhere is the normal case, not an exotic one:
  // the repository's folder is open and the agent works in a worktree; or the docked agent
  // has LEFT the folder (`/land`'s ExitWorktree) and is only listed through the pin — then
  // every path it names lives outside. A tab rooted elsewhere is fine: `openFile` takes
  // any absolute path, and the explorer's auto-reveal simply no-ops off-root.
  const current = ide.workspaces.find((w) => w.id === ide.activeId) ?? null;
  const stay =
    current !== null &&
    workspaceConversations(current, store.conversations, store.repos).some((c) => c.id === convId);
  const wsId = stay ? current.id : ide.openWorkspace(cwd, conv.repoId);
  const ws = useIdeStore.getState().workspaces.find((w) => w.id === wsId);
  // openWorkspace always returns an id for a workspace it just created or focused, so `ws`
  // is present here — but fall back to the raw cwd rather than crash if that ever changes.
  const root = ws?.path ?? cwd;

  const editor = useEditorStore.getState();
  const editorKey = editorKeyFor(wsId);
  editor.ensureConv(editorKey, root);
  void editor.openFile(editorKey, abs, {
    preview: true,
    reveal: opts?.line != null ? { line: opts.line, column: opts.column } : undefined,
  });

  // The FILE is what was asked for — so NOTHING about conversations moves: not the app's
  // active one (persisted, inherited by ⌘1, ⌘⌥↑/↓ and the next launch), and not the one
  // this dock shows either (`lastConvId`). Repointing the latter from here swapped the
  // thread the user was reading for the calling agent's, mid-read — and, when the one on
  // screen was only listed through the pin, dropped its tab altogether. The agent's tab is
  // merely made available again if it had been closed here.
  ide.reopenConversationTab(wsId, convId);
  // A maximized dock hides the editor entirely — the file just opened would be invisible.
  ide.setDockMaximized(false);
  return wsId;
}

/** Pick any folder with the native dialog and open it as a workspace. */
export async function openPickedFolderInIde(): Promise<boolean> {
  if (!ideEnabled()) return false;
  const path = await pickFolder();
  if (!path) return false;
  const repos = useConversationsStore.getState().repos;
  const repo = repos.find((r) => !r.machineId && r.path === path) ?? null;
  const ide = useIdeStore.getState();
  ide.openWorkspace(path, repo?.id ?? null);
  ide.show();
  return true;
}
