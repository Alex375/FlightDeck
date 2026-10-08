// Opening a ⌘⇧F result where the user will see it.
//
// A FILE hit opens in an editor at its line, the match selected: the editor already on screen
// when the file belongs to it (the conversation's side editor, the IDE's current workspace),
// otherwise the IDE view on the searched folder, otherwise the side editor of a conversation
// in that folder. A CONVERSATION hit opens that conversation (bringing it back from disk if the
// app had forgotten it) with its find bar up on the same query, landing on the very occurrence
// that was clicked.
import type { ConversationHits, DiskConversation, FileHits, LineHit, MessageHit } from "../../ipc/client";
import { reactivateDiskConversation, useConversationsStore } from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import { useDisplay } from "../../store/display";
import type { View } from "../../ui/shortcuts";
import { useEditorStore } from "../editor/editorStore";
import { useFindStore } from "../find/findStore";
import type { FindOptions } from "../find/findQuery";
import { effectiveCwd } from "../git/worktree";
import { IDE_SETTING_PATH } from "../ide/openInIde";
import { editorKeyFor, useIdeStore } from "../ide/ideStore";
import { hintFromPreview, isUnder } from "./globalSearchView";

export interface OpenContext {
  currentView: View;
  changeView: (v: View) => void;
}

/** Open a file hit. Returns null on success, or why it could not be opened (shown to the user —
 *  a click that silently does nothing is the one outcome we never allow). */
export function openFileHit(file: FileHits, line: LineHit, ctx: OpenContext): string | null {
  const first = [...line.ranges].sort((a, b) => a.start - b.start)[0];
  const reveal = {
    line: line.line,
    column: line.column,
    length: first ? Math.max(0, first.end - first.start) : undefined,
  };
  const convs = useConversationsStore.getState();
  const editor = useEditorStore.getState();

  // 1. The conversation on screen works in (or under) this folder: its side editor.
  if (ctx.currentView === "conversation") {
    const conv = convs.conversations.find((c) => c.id === convs.activeId) ?? null;
    if (conv) {
      const cwd = effectiveCwd(conv, useConversationStore.getState().sessions[conv.id]?.state);
      const repo = convs.repos.find((r) => r.id === conv.repoId) ?? null;
      if (!repo?.machineId && (isUnder(file.path, cwd) || (repo && isUnder(file.path, repo.path)))) {
        editor.revealInEditor(conv.id, cwd, file.path, reveal);
        return null;
      }
    }
  }

  const ideOn = useDisplay.getState().ideView;
  const ide = useIdeStore.getState();

  // 2. The IDE's workspace on screen holds the file: its editor.
  if (ctx.currentView === "ide") {
    const ws = ide.workspaces.find((w) => w.id === ide.activeId) ?? null;
    if (ws && isUnder(file.path, ws.path)) {
      openInWorkspace(ws.id, ws.path, file.path, reveal);
      return null;
    }
  }

  // 3. The IDE on the searched folder.
  if (ideOn) {
    const repo = convs.repos.find((r) => !r.machineId && r.path === file.root) ?? null;
    const wsId = ide.openWorkspace(file.root, repo?.id ?? null);
    const ws = useIdeStore.getState().workspaces.find((w) => w.id === wsId);
    openInWorkspace(wsId, ws?.path ?? file.root, file.path, reveal);
    useIdeStore.getState().show();
    return null;
  }

  // 4. The IDE is off: a conversation working in that folder lends its side editor.
  const conv = convs.conversations.find((c) => {
    const repo = convs.repos.find((r) => r.id === c.repoId);
    return !repo?.machineId && (isUnder(c.liveCwd ?? c.cwd, file.root) || (repo && isUnder(file.path, repo.path)));
  });
  if (conv) {
    convs.selectConversation(conv.id);
    ctx.changeView("conversation");
    const cwd = effectiveCwd(conv, useConversationStore.getState().sessions[conv.id]?.state);
    editor.revealInEditor(conv.id, cwd, file.path, reveal);
    return null;
  }
  return `No editor is open on this folder. Turn on the IDE view (${IDE_SETTING_PATH}) or start a conversation in it.`;
}

function openInWorkspace(
  wsId: string,
  root: string,
  path: string,
  reveal: { line: number; column: number; length?: number },
): void {
  const editor = useEditorStore.getState();
  const key = editorKeyFor(wsId);
  editor.ensureConv(key, root);
  void editor.openFile(key, path, { preview: true, reveal });
  // A maximized dock hides the editor entirely — the file just opened would be invisible.
  useIdeStore.getState().setDockMaximized(false);
}

/** Open a conversation hit: the conversation, then its find bar on `query`, on that occurrence. */
export function openConversationHit(
  conv: ConversationHits,
  hit: MessageHit,
  query: string,
  options: FindOptions,
  ctx: OpenContext,
): void {
  const store = useConversationsStore.getState();
  const existing = store.conversations.find((c) => c.sessionId === conv.session_id);
  let id: string;
  if (existing) {
    store.selectConversation(existing.id);
    id = existing.id;
  } else {
    const disk: DiskConversation = {
      session_id: conv.session_id,
      cwd: conv.cwd,
      repo_root: conv.repo_root,
      git_branch: null,
      title: conv.title,
      excerpt: conv.excerpt,
      mtime_ms: conv.mtime_ms,
      backend: conv.backend,
    };
    id = reactivateDiskConversation(disk);
    useConversationsStore.getState().selectConversation(id);
  }
  // Requested BEFORE the view switches: the conversation pane picks it up as it mounts.
  useFindStore.getState().requestFind(`conv:${id}`, query, options, {
    hint: hintFromPreview(hit.preview, hit.ranges),
    // A user message is never folded away; an assistant one may be (clean output).
    autoFold: hit.role === "assistant",
  });
  ctx.changeView("conversation");
}
