// The Monaco editor wrapper. This module is the heavy one (Monaco + its language
// grammars), so it is imported LAZILY (React.lazy in EditorPane) — it lands in
// its own chunk and never weighs on app startup, keeping the "fast/light" core
// principle intact.
//
// The web-worker environment + the `tosse-dark` theme are set up by the shared
// `monacoEnv` module (also used by the Git diff editor), so whichever mounts
// first configures Monaco correctly.

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { setupMonaco } from "./monacoEnv";
import { registerCodeEditor } from "../find/codeEditors";
import styles from "./editor.module.css";

interface Props {
  path: string;
  value: string;
  language: string;
  /** All currently-open tab paths — models for closed tabs are disposed. */
  openPaths: string[];
  onChange: (value: string) => void;
  onSave: () => void;
  /** A one-shot request to jump to a line (from a clicked file mention). The
   *  `seq` nonce lets a repeat click on the same line re-fire. */
  reveal?: { line: number; column: number; seq: number; length?: number } | null;
  /** Called once the `reveal` has been applied, so the store can clear it. */
  onRevealConsumed?: () => void;
}

export default function MonacoView({
  path,
  value,
  language,
  openPaths,
  onChange,
  onSave,
  reveal,
  onRevealConsumed,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  // Guards the change listener while we apply an EXTERNAL value (live reload), so
  // pushing disk content into the model doesn't echo back as a user edit.
  const applyingExternal = useRef(false);
  // The last reveal seq we acted on — so a value change (an edit) never re-jumps
  // the cursor, but a fresh click (new seq) always does.
  const lastRevealSeq = useRef<number | null>(null);
  const revealDeco = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onRevealConsumedRef = useRef(onRevealConsumed);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onRevealConsumedRef.current = onRevealConsumed;

  // Create the editor exactly once.
  useEffect(() => {
    setupMonaco();
    const ed = monaco.editor.create(hostRef.current!, {
      theme: "tosse-dark",
      automaticLayout: true, // tracks our resizable panel via a ResizeObserver
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: "none",
      smoothScrolling: true,
      padding: { top: 8 },
      scrollbar: { useShadows: false },
    });
    editorRef.current = ed;
    const sub = ed.onDidChangeModelContent(() => {
      if (applyingExternal.current) return;
      const m = ed.getModel();
      if (m) onChangeRef.current(m.getValue());
    });
    // Cmd/Ctrl+S → save now (in addition to the debounced autosave).
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    // ⌘F while focus is elsewhere in the editor panel (its file tree, its tab strip) reaches
    // this editor through the find registry — Monaco's own widget then opens, in place.
    const unregisterFind = registerCodeEditor({
      el: hostRef.current!,
      openFind: () => {
        ed.focus();
        void ed.getAction("actions.find")?.run();
      },
    });
    return () => {
      unregisterFind();
      sub.dispose();
      ed.dispose();
      editorRef.current = null;
      models.current.forEach((m) => m.dispose());
      models.current.clear();
    };
  }, []);

  // Bind the active path's model (created + cached per file, so switching tabs
  // preserves each file's undo history and cursor position).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const uri = monaco.Uri.file(path);
    let model = models.current.get(path);
    if (!model) {
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, language, uri);
      models.current.set(path, model);
    }
    if (ed.getModel() !== model) ed.setModel(model);
    // `value`/`language` are intentionally not deps: handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Push external value changes (live reload / first load) into the model.
  useEffect(() => {
    const model = models.current.get(path);
    if (!model || model.getValue() === value) return;
    applyingExternal.current = true;
    model.setValue(value);
    applyingExternal.current = false;
  }, [value, path]);

  // Keep the model's language in sync.
  useEffect(() => {
    const model = models.current.get(path);
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language, path]);

  // Dispose models for tabs that were closed (free memory).
  useEffect(() => {
    const keep = new Set(openPaths);
    for (const [p, m] of models.current) {
      if (!keep.has(p)) {
        m.dispose();
        models.current.delete(p);
      }
    }
  }, [openPaths]);

  // Jump to (and pulse-highlight) a line when a file mention is clicked. Acts
  // once per reveal nonce, so an edit (value change) never re-jumps the cursor
  // while a fresh click (new seq) always does. MonacoView only mounts after the
  // buffer has loaded (EditorPane's loading guard), so the model has its lines.
  // The highlight fades itself out (CSS animation `forwards`); the next reveal's
  // `.set()` replaces it — so no timer (which a consume-triggered re-render would
  // race) is needed.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !reveal || lastRevealSeq.current === reveal.seq) return;
    const model = models.current.get(path) ?? ed.getModel();
    if (!model) return;
    lastRevealSeq.current = reveal.seq;
    const line = Math.min(Math.max(reveal.line, 1), model.getLineCount());
    ed.revealLineInCenter(line);
    const column = Math.max(reveal.column, 1);
    if (reveal.length && reveal.length > 0) {
      // A search hit: select it, so the match itself lights up (and ⌘F seeds from it).
      ed.setSelection(new monaco.Range(line, column, line, column + reveal.length));
    } else {
      ed.setPosition({ lineNumber: line, column });
    }
    ed.focus();
    if (!revealDeco.current) revealDeco.current = ed.createDecorationsCollection();
    // Clear before setting so the line's decoration DOM node is recreated — a
    // re-click on the SAME line (identical decoration) would otherwise be a no-op
    // for Monaco's overlay and the pulse animation wouldn't replay.
    revealDeco.current.clear();
    revealDeco.current.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: styles.revealHighlight },
      },
    ]);
    onRevealConsumedRef.current?.();
  }, [reveal, path]);

  return <div ref={hostRef} className={styles.monacoHost} />;
}
