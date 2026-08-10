// Running an app action, in ONE place.
//
// Extracted from App's keyboard handler so the same action can be triggered from more
// than one surface: the global chords (see ACTION_BINDINGS in shortcuts.ts) and the
// composer's user-made buttons (see composerActions.ts). Keeping the registry, the
// documentation catalogue and the dispatcher in the same neighbourhood is what stops
// "what ⌘B does" and "what a button labelled ⌘B does" from drifting apart.
//
// Live store state is read at call time — no stale closures, whichever surface calls.
import { createConversationInRepo, groupConversationsByRepo, useConversationsStore } from "../store/conversationsStore";
import { useDisplay, resolveCleanOutput } from "../store/display";
import { useEditorStore } from "../features/editor/editorStore";
import { useExtensionsUi } from "../features/extensions/extensionsUiStore";
import { useHistoryUi } from "../features/history/historyUiStore";
import { DEFAULT_ZOOM, nextZoom, prevZoom } from "./zoom";
import type { ShortcutAction, View } from "./shortcuts";

export interface AppActionOptions {
  /**
   * Which conversation the action targets.
   *
   * ⚠️ Load-bearing. The keyboard caller can leave it out — there, the ACTIVE
   * conversation is by definition the one on screen. A composer cannot: it is mounted on
   * three surfaces, and the Flight Deck reply modal deliberately shows a conversation
   * that is INDEPENDENT of `activeId`. Defaulting to `activeId` from there would toggle
   * clean output on a conversation the user isn't even looking at, silently.
   */
  convId?: string;
  changeView?: (v: View) => void;
}

/**
 * Run one app action. Returns whether it actually did something, so a keyboard caller
 * only swallows the key when it acted — and so a button caller can tell a no-op from a
 * success instead of reporting nothing.
 *
 * `changeView` is optional: a caller already inside the target view (the composer, for
 * one) has nothing to switch, and every action that would use it navigates to the
 * conversation view — where such a caller already is.
 */
export function runAppAction(action: ShortcutAction, opts?: AppActionOptions): boolean {
  const store = useConversationsStore.getState();
  const targetId = opts?.convId ?? store.activeId;
  const conv = store.conversations.find((c) => c.id === targetId) ?? null;
  const changeView = opts?.changeView;
  const editor = useEditorStore.getState();
  switch (action) {
    case "toggle-editor":
      if (!conv) return false;
      editor.toggleOpen();
      return true;
    case "toggle-terminal":
      if (!conv) return false;
      editor.toggleTerminal();
      return true;
    case "toggle-git":
      if (!conv) return false;
      editor.toggleGit();
      return true;
    case "toggle-clean-output": {
      if (!conv) return false;
      const eff = resolveCleanOutput(conv.cleanOutput ?? null, useDisplay.getState().cleanOutput);
      store.setConvCleanOutput(conv.id, !eff);
      return true;
    }
    case "open-extensions":
      if (!conv) return false;
      useExtensionsUi.getState().openManager({
        kind: "conversation",
        backend: conv.kind,
        path: conv.liveCwd ?? conv.cwd ?? ".",
        title: conv.name,
        session: conv.id,
      });
      return true;
    case "new-conversation": {
      const repoPath =
        (conv && store.repos.find((r) => r.id === conv.repoId)?.path) ?? store.repos[0]?.path ?? null;
      if (!repoPath) return false;
      createConversationInRepo(repoPath);
      changeView?.("conversation");
      return true;
    }
    case "prev-conversation":
    case "next-conversation": {
      const ordered = groupConversationsByRepo(store.repos, store.conversations).flatMap(
        (g) => g.conversations,
      );
      if (ordered.length < 2) return false;
      const idx = ordered.findIndex((c) => c.id === store.activeId);
      if (idx < 0) return false;
      const nextIdx = action === "prev-conversation" ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= ordered.length) return false; // clamp at the ends
      store.selectConversation(ordered[nextIdx].id);
      changeView?.("conversation");
      return true;
    }
    case "open-history":
      useHistoryUi.getState().openPanel();
      return true;
    case "zoom-in":
    case "zoom-out":
    case "zoom-reset": {
      const display = useDisplay.getState();
      const current = display.uiZoom;
      const next =
        action === "zoom-reset"
          ? DEFAULT_ZOOM
          : action === "zoom-in"
            ? nextZoom(current)
            : prevZoom(current);
      // Persist only a real change, but claim the key either way: at either end of the
      // ladder the app HAS handled the zoom request (there is just nowhere further to
      // go), and letting ⌘+ fall through to the webview would hand it a second, hidden
      // zoom of its own on top of ours.
      if (next !== current) display.set({ uiZoom: next });
      return true;
    }
  }
}
