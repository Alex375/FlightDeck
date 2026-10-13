// The rendered ("Preview") side of a `.diff` / `.patch` tab, in two layouts the user
// switches between (remembered: the editor store's `diffLayout`):
//
// - "unified" — the patch laid out the way a code review shows it: one section per file
//   (status, path, +/− counts, foldable), hunks with old/new line numbers, added and
//   removed lines tinted, and the changed span of a rewritten line marked inside it.
// - "split" — the Git panel's view: the patch's files listed, and the selected one
//   before | after in the same ribbon diff (RibbonDiff). A patch only carries excerpts, so
//   each side shows its hunks end to end, banded by their `@@` lines and numbered with the
//   real files' line numbers (see `sideBySideOf`).
//
// The Source toggle shows the raw text.
//
// Everything structural comes from the pure parser (unifiedDiff.ts). What it could not
// read is never rendered as less in silence: its problems head the preview, and a file
// with no diff in it says so instead of showing an empty page.
//
// Line numbers and +/− signs are drawn from data attributes (CSS `content`), not text
// nodes: copying lines out of the preview copies the code, and ⌘F searches the code too.

import { lazy, memo, Suspense, useMemo, useRef, useState } from "react";
import { useDomFind } from "../find/useDomFind";
import { Ico } from "../../ui/kit";
import { useEditorStore, type DiffLayout } from "./editorStore";
import {
  inlineSpans,
  parseUnifiedDiff,
  patchFilePath,
  sideBySideOf,
  type PatchFile,
  type PatchFileStatus,
  type PatchHunk,
} from "./unifiedDiff";
import styles from "./DiffPreview.module.css";

// Monaco's diff editor — its own chunk, shared with the Git panel (DiffSlot).
const RibbonDiff = lazy(() => import("../git/RibbonDiff"));

/** A file whose diff is longer than this starts folded: thousands of rows mounted at once
 *  is a long freeze for a section the user may not even want. One click unfolds it. */
const FOLD_ABOVE_LINES = 1500;

const STATUS: Record<PatchFileStatus, { letter: string; label: string }> = {
  modified: { letter: "M", label: "Modified" },
  added: { letter: "A", label: "Added" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
};

const LAYOUTS: Array<{ value: DiffLayout; label: string }> = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Side by side" },
];

function lineCount(f: PatchFile): number {
  let n = 0;
  for (const h of f.hunks) n += h.lines.length + 1;
  return n;
}

export function DiffPreview({ text, name }: { text: string; name: string }) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findBar = useDomFind({
    id: "diff-preview",
    zoneRef,
    root: () => scrollRef.current,
    scope: { label: name, icon: "file" },
  });
  const patch = useMemo(() => parseUnifiedDiff(text), [text]);
  const layout = useEditorStore((s) => s.diffLayout);
  const setLayout = useEditorStore((s) => s.setDiffLayout);
  // Fold state keyed by the file's position AND path: it survives the live reload of a
  // patch that is being rewritten, without carrying a fold over to a different file.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  // The file shown side by side — clamped, since a rewritten patch may have fewer files.
  const [selected, setSelected] = useState(0);

  let additions = 0;
  let deletions = 0;
  for (const f of patch.files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  const split = layout === "split" && patch.files.length > 0;

  let fileIndex = 0;
  return (
    <div ref={zoneRef} className={styles.zone}>
      {findBar}
      <div ref={scrollRef} className={split ? styles.splitBody : styles.scroll}>
        {patch.files.length > 0 ? (
          <div className={styles.summary}>
            <span>
              {patch.files.length} {patch.files.length === 1 ? "file" : "files"} changed
            </span>
            <span className={styles.adds}>+{additions}</span>
            <span className={styles.dels}>−{deletions}</span>
            <span className={styles.summarySpace} />
            <div className={styles.switch} role="group" aria-label="Diff layout">
              {LAYOUTS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  className={styles.switchBtn}
                  data-on={layout === l.value ? "" : undefined}
                  aria-pressed={layout === l.value}
                  onClick={() => setLayout(l.value)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {patch.problems.length > 0 ? (
          <div className={styles.problems} role="alert">
            <div className={styles.problemsHead}>
              <Ico name="alert" className="sm" />
              {patch.problems.length === 1
                ? "This patch has a problem — part of it may not be shown as intended."
                : `This patch has ${patch.problems.length} problems — parts of it may not be shown as intended.`}
            </div>
            <ul>
              {patch.problems.map((p, i) => (
                <li key={i}>
                  <span className={styles.problemLine}>Line {p.line}</span> {p.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {patch.files.length === 0 ? (
          <div className={styles.empty}>
            No diff found in this file — no file header or hunk (<code>@@ … @@</code>) of a unified
            diff. Switch to <b>Source</b> to edit it as text.
          </div>
        ) : null}

        {split ? (
          <SplitFiles
            files={patch.files}
            selected={Math.min(selected, patch.files.length - 1)}
            onSelect={setSelected}
          />
        ) : (
          patch.blocks.map((block, i) => {
            if (block.kind === "text") {
              return (
                <pre key={`t${i}`} className={styles.text}>
                  {block.lines.join("\n")}
                </pre>
              );
            }
            const index = fileIndex++;
            const key = `${index}:${patchFilePath(block.file)}`;
            const folded = folds[key] ?? lineCount(block.file) > FOLD_ABOVE_LINES;
            return (
              <FileSection
                key={key}
                file={block.file}
                folded={folded}
                onToggle={() => setFolds((s) => ({ ...s, [key]: !folded }))}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

/** A file's identity line: status letter, path (old → new for a rename or copy), binary
 *  tag and +/− counts. Shared by a unified section's header and a split-view list row. */
function FileLabel({ file }: { file: PatchFile }) {
  const status = STATUS[file.status];
  const moved = (file.status === "renamed" || file.status === "copied") && file.oldPath !== null;
  return (
    <>
      <span className={styles.status} data-status={file.status} title={status.label}>
        {status.letter}
      </span>
      <span className={styles.path}>
        {moved ? (
          <>
            <span className={styles.oldPath}>{file.oldPath}</span>
            <span className={styles.arrow}>→</span>
          </>
        ) : null}
        {patchFilePath(file)}
      </span>
      {file.binary ? <span className={styles.tag}>binary</span> : null}
      <span className={styles.counts}>
        {file.additions > 0 ? <span className={styles.adds}>+{file.additions}</span> : null}
        {file.deletions > 0 ? <span className={styles.dels}>−{file.deletions}</span> : null}
      </span>
    </>
  );
}

/** Why a file has nothing to lay out line by line, or null when it has hunks. */
function noTextDiff(file: PatchFile): string | null {
  if (file.binary) return "Binary file — no text diff to show.";
  if (file.hunks.length === 0) return "No content change.";
  return null;
}

/** The "split" layout: the patch's files, and the selected one side by side. */
function SplitFiles({
  files,
  selected,
  onSelect,
}: {
  files: PatchFile[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const file = files[selected];
  const sides = useMemo(() => sideBySideOf(file), [file]);
  // Stable identities: RibbonDiff rebuilds its models whenever these change.
  const lineLabels = useMemo(() => ({ original: sides.oldLabels, modified: sides.newLabels }), [sides]);
  const bands = useMemo(
    () => ({ original: sides.oldBands, modified: sides.newBands, className: styles.band }),
    [sides],
  );
  const empty = noTextDiff(file);

  return (
    <>
      <div className={styles.fileList} role="listbox" aria-label="Files in this patch">
        {files.map((f, i) => (
          <button
            key={`${i}:${patchFilePath(f)}`}
            type="button"
            role="option"
            aria-selected={i === selected}
            className={styles.fileRow}
            data-selected={i === selected ? "" : undefined}
            onClick={() => onSelect(i)}
          >
            <FileLabel file={f} />
          </button>
        ))}
      </div>
      <div className={styles.splitDiff}>
        {empty ? (
          <div className={styles.note}>{empty}</div>
        ) : (
          <Suspense fallback={<div className={styles.note}>Loading diff…</div>}>
            <RibbonDiff
              path={patchFilePath(file)}
              oldText={sides.oldText}
              newText={sides.newText}
              lineLabels={lineLabels}
              bands={bands}
            />
          </Suspense>
        )}
      </div>
    </>
  );
}

function FileSection({
  file,
  folded,
  onToggle,
}: {
  file: PatchFile;
  folded: boolean;
  onToggle: () => void;
}) {
  // Wide enough for the largest line number either side of any hunk reaches.
  let maxNo = 0;
  for (const h of file.hunks) maxNo = Math.max(maxNo, h.oldStart + h.oldLines, h.newStart + h.newLines);
  const gutter = `${String(maxNo).length + 1}ch`;
  const empty = noTextDiff(file);

  return (
    <section className={styles.file}>
      <button type="button" className={styles.fileHead} onClick={onToggle} aria-expanded={!folded}>
        <span className={styles.chevron} data-folded={folded ? "" : undefined}>
          <Ico name="chevron" className="sm" />
        </span>
        <FileLabel file={file} />
      </button>
      {folded ? null : (
        <div className={styles.fileBody}>
          {file.meta.length > 0 ? (
            <div className={styles.meta}>
              {file.meta.map((m, i) => (
                <div key={i}>{m}</div>
              ))}
            </div>
          ) : null}
          {empty ? (
            <div className={styles.note}>{empty}</div>
          ) : (
            <div className={styles.hunks} style={{ ["--gutter" as string]: gutter }}>
              <div className={styles.rows}>
                {file.hunks.map((h, i) => (
                  <Hunk key={i} hunk={h} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const SIGN = { context: " ", add: "+", del: "−", note: "" } as const;

const Hunk = memo(function Hunk({ hunk }: { hunk: PatchHunk }) {
  const spans = useMemo(() => inlineSpans(hunk.lines), [hunk.lines]);
  return (
    <>
      <div className={styles.hunkHead}>
        <span className={styles.hunkRange}>{hunk.header.split("@@").slice(0, 2).join("@@")}@@</span>
        {hunk.section ? <span className={styles.hunkSection}>{hunk.section}</span> : null}
      </div>
      {hunk.lines.map((l, i) => {
        if (l.kind === "note") {
          return (
            <div key={i} className={styles.row} data-kind="note">
              <span className={styles.no} />
              <span className={styles.no} />
              <span className={styles.sign} />
              <span className={styles.code}>{l.text}</span>
            </div>
          );
        }
        const span = spans.get(i);
        return (
          <div key={i} className={styles.row} data-kind={l.kind}>
            <span className={styles.no} data-n={l.oldNo ?? ""} />
            <span className={styles.no} data-n={l.newNo ?? ""} />
            <span className={styles.sign} data-sign={SIGN[l.kind]} />
            <span className={styles.code}>
              {span ? (
                <>
                  {l.text.slice(0, span[0])}
                  <mark className={styles.changed}>{l.text.slice(span[0], span[1])}</mark>
                  {l.text.slice(span[1])}
                </>
              ) : (
                l.text
              )}
            </span>
          </div>
        );
      })}
    </>
  );
});
