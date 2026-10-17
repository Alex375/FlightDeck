// Edit › Undo / Redo on macOS — who answers them.
//
// The main webview is a CHILD webview (Tauri's `unstable` feature, for the artifact host), and a
// child never sees a ⌘+key that matches a native menu item: the menu serves it first. So ⌘Z / ⌘⇧Z
// (and a click on Edit › Undo / Redo) reach the front as an `EditMenuEvent`, never as a keydown —
// see `src-tauri/src/edit_menu.rs`. App's keydown undo still covers the platforms without that menu.

import { commands, type EditAction } from "../ipc/client";
import { isEditableTarget } from "./shortcuts";

/** Who answers Edit › Undo / Redo: Monaco (its own undo stack), a frame of the page (an
 *  artifact preview's sandboxed `<iframe>`: its own document, out of this one's reach), a
 *  field that owns its native undo (composer, inputs, rename, terminal — see
 *  {@link isEditableTarget}), or the app (the conversation delete's undo). */
export type EditMenuRoute = "monaco" | "frame" | "field" | "app";

/** The route for the focused element. Pure (takes the element) so it unit-tests under jsdom.
 *  A focused frame shows here as the `<iframe>` element itself, whatever has focus inside it. */
export function editMenuRoute(el: Element | null): EditMenuRoute {
  if (el?.closest(".monaco-editor")) return "monaco";
  if (el?.tagName === "IFRAME") return "frame";
  return isEditableTarget(el) ? "field" : "app";
}

export interface EditMenuDeps {
  /** Restore the last deleted conversation; false when there is none. */
  undoConversation: () => boolean;
  /** Undo / redo in the Monaco editor that has text focus; false when none has it (a widget's
   *  input inside the editor, like its find box, keeps the native undo). */
  monacoEdit: (action: EditAction) => Promise<boolean>;
  /** The webview's own undo / redo — what the predefined Edit item did. */
  nativeEdit: (action: EditAction) => void;
  /** AppKit's own undo / redo, for a focused frame — `nativeEdit` acts on this document only,
   *  and a sandboxed frame is out of its reach. Rejects when it could not be sent. */
  frameEdit: (action: EditAction) => Promise<void>;
  /** Tell the user an undo / redo could not be done. */
  reportFailure: (message: string) => void;
}

/** Answer an Edit › Undo / Redo for the focused element `el`. */
export function runEditMenu(action: EditAction, el: Element | null, deps: EditMenuDeps): void {
  switch (editMenuRoute(el)) {
    case "monaco":
      void deps
        .monacoEdit(action)
        .then((done) => {
          if (!done) deps.nativeEdit(action);
        })
        .catch((e) => {
          console.error(`Monaco ${action} failed, falling back to the native one:`, e);
          deps.nativeEdit(action);
        });
      return;
    case "frame":
      void deps.frameEdit(action).catch((e) => {
        console.error(`${action} in the artifact preview failed:`, e);
        deps.reportFailure(`Couldn't ${action} in the artifact preview: ${String(e)}`);
      });
      return;
    case "field":
      deps.nativeEdit(action);
      return;
    case "app":
      // Nothing to restore: leave ⌘Z its native meaning, as before the menu owned the key.
      if (action === "undo" && deps.undoConversation()) return;
      deps.nativeEdit(action);
  }
}

/** {@link EditMenuDeps.monacoEdit} for the real editors. Monaco is already loaded whenever one
 *  of its editors has focus, so the import costs nothing then — and nothing at startup. */
export async function monacoEdit(action: EditAction): Promise<boolean> {
  const monaco = await import("monaco-editor");
  const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus());
  if (!editor) return false;
  editor.trigger("keyboard", action, null);
  return true;
}

/** {@link EditMenuDeps.frameEdit} for the real app. */
export async function frameEdit(action: EditAction): Promise<void> {
  const res = await commands.editMenuNative(action);
  if (res.status === "error") throw new Error(res.error);
}

/** {@link EditMenuDeps.nativeEdit} for the real document. */
export function nativeEdit(action: EditAction): void {
  document.execCommand(action);
}
