// Shared Monaco setup: the web-worker environment and the `tosse-dark` theme.
// Both the file editor (MonacoView) and the Git diff editor (DiffViewer) need
// these, and either may mount first — so the setup lives here, idempotent, and
// each calls `setupMonaco()` before creating its editor. Without it, whichever
// editor opens first while the other never has would run Monaco with no worker
// env (it falls back to the main thread, freezing the UI on large files and
// canceling diff computation).
//
// Workers: Vite bundles each as its own lazily-fetched chunk, so wiring them
// costs nothing at startup (this module only loads with a lazy editor) and a
// worker is fetched only when a file of that language is opened.

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoSelf = typeof globalThis & { MonacoEnvironment?: monaco.Environment };
const globalSelf = globalThis as MonacoSelf;

let workersDone = false;
let themeDone = false;
let languagesDone = false;

function setupWorkers() {
  if (workersDone || globalSelf.MonacoEnvironment) {
    workersDone = true;
    return;
  }
  workersDone = true;
  globalSelf.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}

function setupTheme() {
  if (themeDone) return;
  themeDone = true;
  // The app's dark palette (--wf-* tokens) so the editor + diffs blend in. Diff
  // colors are included so the Git diff editor reads even when shown standalone.
  monaco.editor.defineTheme("tosse-dark", {
    base: "vs-dark",
    inherit: true,
    // Tokens of the `diff` language (setupLanguages) — the app's status hues.
    rules: [
      { token: "inserted.diff", foreground: "5fb98c" },
      { token: "deleted.diff", foreground: "e0727c" },
      { token: "range.diff", foreground: "7aa2e3" },
      { token: "header.diff", foreground: "e7e7ec", fontStyle: "bold" },
      { token: "meta.diff", foreground: "6a6a76" },
    ],
    colors: {
      "editor.background": "#0c0c0f",
      "editor.foreground": "#e7e7ec",
      "editorLineNumber.foreground": "#4a4a55",
      "editorLineNumber.activeForeground": "#a6a6b0",
      "editor.selectionBackground": "#2a3350",
      "editor.lineHighlightBackground": "#15151b",
      "editorCursor.foreground": "#d97757",
      "editorIndentGuide.background1": "#20202a",
      "editorWidget.background": "#15151b",
      "editorWidget.border": "#26262f",
      "editorGutter.background": "#0c0c0f",
      "scrollbarSlider.background": "#26262f88",
      // Diff highlighting tuned to be VIVID so changed regions pop when scrolling
      // fast. Two-tone: a saturated whole-line wash + a stronger inner highlight on
      // the exact changed characters.
      "diffEditor.insertedLineBackground": "#2ea0432e",
      "diffEditor.removedLineBackground": "#f8514929",
      "diffEditor.insertedTextBackground": "#2ea04366",
      "diffEditor.removedTextBackground": "#f8514961",
      // Marks on the right overview ruler — see at a glance WHERE the changes are.
      "diffEditorOverview.insertedForeground": "#2ea043cc",
      "diffEditorOverview.removedForeground": "#f85149cc",
    },
  });
}

/** Languages Monaco has no built-in for. `diff` colours a .diff / .patch file in the
 *  editor's Source mode (its Preview is the rendered DiffPreview). Line-anchored rules
 *  only: in a unified diff the first character decides what a line is. */
function setupLanguages() {
  if (languagesDone) return;
  languagesDone = true;
  monaco.languages.register({ id: "diff", extensions: [".diff", ".patch"] });
  monaco.languages.setMonarchTokensProvider("diff", {
    tokenPostfix: ".diff",
    tokenizer: {
      root: [
        [/^(diff |---|\+\+\+).*$/, "header"],
        [/^@@.*$/, "range"],
        [/^\+.*$/, "inserted"],
        [/^-.*$/, "deleted"],
        [/^(index |new file mode|deleted file mode|similarity index|rename |old mode|new mode|\\).*$/, "meta"],
        [/^.*$/, ""],
      ],
    },
  });
}

/** Configure Monaco's workers, theme and extra languages once. Safe to call from every editor. */
export function setupMonaco() {
  setupWorkers();
  setupLanguages();
  setupTheme();
}
