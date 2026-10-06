// The code editors on screen, as far as ⌘F is concerned. Monaco brings its own find widget
// (anchored in the editor's top-right corner — exactly the "in the zone" behaviour we want), so
// an editor panel's find host only has to reach the right Monaco instance and run its find
// action. This registry is that bridge, kept free of any Monaco import: MonacoView lives in a
// lazily-loaded chunk and must stay out of the startup bundle.

export interface CodeEditorFind {
  /** The editor's DOM host. */
  el: HTMLElement;
  /** Focus the editor and open its native find widget (seeded from its selection). */
  openFind: () => void;
}

const editors = new Set<CodeEditorFind>();

export function registerCodeEditor(editor: CodeEditorFind): () => void {
  editors.add(editor);
  return () => {
    editors.delete(editor);
  };
}

/** Open the find widget of the code editor shown inside `zone`. False when the zone shows no
 *  code editor right now (an image, a PDF, a markdown preview, nothing open). */
export function openCodeEditorFindIn(zone: HTMLElement | null): boolean {
  if (!zone) return false;
  for (const ed of editors) {
    if (ed.el.isConnected && zone.contains(ed.el) && ed.el.getClientRects().length > 0) {
      ed.openFind();
      return true;
    }
  }
  return false;
}
