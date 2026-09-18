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
import { editorKeyFor, useIdeStore } from "./ideStore";

/** Why a repository cannot be opened in the IDE, or null when it can. PURE, so a button
 *  can grey itself out WITH the reason instead of clicking into an empty explorer: the
 *  editor reads this Mac's disk, and a remote repository's files are not on it. */
export function ideBlockedReason(repo: Pick<Repo, "machineId"> | null | undefined): string | null {
  if (repo?.machineId) return "The IDE browses this Mac's files — this repository lives on a remote server.";
  return null;
}

/** Why "Open in IDE" is refused for a conversation of `repo`, the preference included — what
 *  a user-made composer button shows when it greys itself out. PURE. */
export function openInIdeBlockedReason(
  repo: Pick<Repo, "machineId"> | null | undefined,
  ideViewEnabled: boolean,
): string | null {
  if (!ideViewEnabled) return "The IDE view is switched off — Settings → General → Display.";
  return ideBlockedReason(repo);
}

/** The IDE view is a preference (Settings → General → Display). Every opener checks it, so
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
