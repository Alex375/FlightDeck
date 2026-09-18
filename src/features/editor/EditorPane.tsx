import { lazy, Suspense } from "react";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { Ico } from "../../ui/kit";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { ImageViewer } from "./ImageViewer";
import { baseName, fileBadge, isMarkdownPath } from "./language";
import { fileIconUrl, useFileIcons } from "./fileIcons";
import { useConvEditor, useEditorStore, type FileBuffer } from "./editorStore";
import styles from "./editor.module.css";

// Monaco lives in its own lazily-loaded chunk (see MonacoView's header).
const MonacoView = lazy(() => import("./MonacoView"));
// pdf.js lives in its own lazily-loaded chunk too — only pulled in when a PDF opens.
const PdfViewer = lazy(() => import("./PdfViewer"));

/** Tab bar + the active file's content (Monaco / markdown preview / a guard). */
export function EditorPane({
  convId,
  treeCollapsed,
  onToggleTree,
}: {
  convId: string;
  /** Tree visibility + its toggle, owned by the panel — which knows whether the layout is
   *  the global one or a host's own (see `TreeLayout` in EditorPanel). */
  treeCollapsed: boolean;
  onToggleTree: () => void;
}) {
  const conv = useConvEditor(convId);
  const selectTab = useEditorStore((s) => s.selectTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const pinTab = useEditorStore((s) => s.pinTab);
  const iconMap = useFileIcons();

  if (!conv) return null;
  const active = conv.activeTab ? conv.buffers[conv.activeTab] ?? null : null;

  return (
    <div className={styles.editor}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          className={styles.treeToggle}
          data-on={!treeCollapsed ? "" : undefined}
          onClick={onToggleTree}
          title={treeCollapsed ? "Show file tree" : "Hide file tree"}
          aria-label="Show/hide file tree"
        >
          <Ico name="sidebar" className="sm" />
        </button>
        {conv.tabs.map((p) => {
          const b = conv.buffers[p];
          const on = conv.activeTab === p;
          const preview = conv.previewTab === p;
          const iconUrl = iconMap ? fileIconUrl(iconMap, p) : null;
          const badge = fileBadge(p);
          return (
            <div
              key={p}
              role="tab"
              aria-selected={on}
              className={
                styles.tab + (on ? " " + styles.tabActive : "") + (preview ? " " + styles.tabPreview : "")
              }
              onClick={() => selectTab(convId, p)}
              onDoubleClick={() => pinTab(convId, p)}
              title={p}
            >
              {iconUrl ? (
                <img src={iconUrl} className={styles.entryIcon} alt="" draggable={false} />
              ) : (
                <span className={styles.tabBadge} style={{ color: badge.color }}>
                  {badge.label}
                </span>
              )}
              <span className={styles.tabName}>{b?.name ?? baseName(p)}</span>
              {b?.dirty ? <span className={styles.tabDirty}>•</span> : null}
              <button
                type="button"
                className={styles.tabClose}
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(convId, p);
                }}
              >
                <Ico name="x" className="sm" />
              </button>
            </div>
          );
        })}
      </div>

      {active ? (
        <ActiveFile convId={convId} buffer={active} openPaths={conv.tabs} />
      ) : (
        <div className={styles.placeholder}>
          {conv.tabs.length === 0
            ? "Select a file in the tree to open it."
            : "No tab selected."}
        </div>
      )}
    </div>
  );
}

function ActiveFile({
  convId,
  buffer,
  openPaths,
}: {
  convId: string;
  buffer: FileBuffer;
  openPaths: string[];
}) {
  const setContent = useEditorStore((s) => s.setContent);
  const saveBuffer = useEditorStore((s) => s.saveBuffer);
  const togglePreview = useEditorStore((s) => s.togglePreview);
  const setImageView = useEditorStore((s) => s.setImageView);
  const reloadFromDisk = useEditorStore((s) => s.reloadFromDisk);
  const keepLocal = useEditorStore((s) => s.keepLocal);
  const clearReveal = useEditorStore((s) => s.clearReveal);

  const isMd = isMarkdownPath(buffer.path);
  const editable =
    !buffer.binary &&
    !buffer.tooLarge &&
    !buffer.loading &&
    !buffer.error &&
    !buffer.isImage &&
    !buffer.isPdf;

  return (
    <div className={styles.content}>
      {buffer.diskChanged ? (
        <div className={styles.banner}>
          <Ico name="alert" className="sm" />
          <span className={styles.bannerMsg}>
            This file was modified on disk (you have unsaved changes).
          </span>
          <button type="button" className={styles.bannerBtn} onClick={() => reloadFromDisk(convId, buffer.path)}>
            Reload
          </button>
          <button type="button" className={styles.bannerBtn} onClick={() => keepLocal(convId, buffer.path)}>
            Keep my changes
          </button>
        </div>
      ) : null}

      {editable ? (
        <div className={styles.toolbar}>
          {isMd ? (
            <>
              <button
                type="button"
                className={styles.toolBtn + (buffer.preview ? " " + styles.toolBtnOn : "")}
                onClick={() => togglePreview(convId, buffer.path)}
              >
                <Ico name="file" className="sm" />
                Preview
              </button>
              <button
                type="button"
                className={styles.toolBtn + (!buffer.preview ? " " + styles.toolBtnOn : "")}
                onClick={() => togglePreview(convId, buffer.path)}
              >
                <Ico name="diff" className="sm" />
                Source
              </button>
            </>
          ) : null}
          <span className={styles.toolbarSpace} />
          <span>{buffer.dirty ? "Modified…" : "Saved"}</span>
        </div>
      ) : null}

      {buffer.loading ? (
        <div className={styles.placeholder}>Loading…</div>
      ) : buffer.error ? (
        <div className={styles.placeholder}>{buffer.error}</div>
      ) : buffer.tooLarge ? (
        <div className={styles.placeholder}>File too large to display (&gt; 16 MB).</div>
      ) : buffer.isImage ? (
        buffer.imageDataUrl ? (
          <ImageViewer
            key={`${convId}:${buffer.path}`}
            src={buffer.imageDataUrl}
            size={buffer.imageSize}
            initialZoom={buffer.imageZoom}
            initialOffset={buffer.imageOffset}
            onViewChange={(z, o) => setImageView(convId, buffer.path, z, o)}
          />
        ) : (
          <div className={styles.placeholder}>Image preview unavailable.</div>
        )
      ) : buffer.isPdf ? (
        buffer.pdfBase64 ? (
          <Suspense fallback={<div className={styles.placeholder}>Loading PDF viewer…</div>}>
            <PdfViewer key={`${convId}:${buffer.path}`} base64={buffer.pdfBase64} />
          </Suspense>
        ) : (
          <div className={styles.placeholder}>PDF preview unavailable.</div>
        )
      ) : buffer.binary ? (
        <div className={styles.placeholder}>Binary file — preview not available.</div>
      ) : isMd && buffer.preview ? (
        <div className={styles.mdPreview}>
          <StreamMarkdown text={buffer.content} />
        </div>
      ) : (
        <EditorErrorBoundary key={buffer.path}>
          <Suspense fallback={<div className={styles.placeholder}>Loading editor…</div>}>
            <MonacoView
              path={buffer.path}
              value={buffer.content}
              language={buffer.language}
              openPaths={openPaths}
              onChange={(v) => setContent(convId, buffer.path, v)}
              onSave={() => void saveBuffer(convId, buffer.path)}
              reveal={buffer.pendingReveal}
              onRevealConsumed={() => clearReveal(convId, buffer.path)}
            />
          </Suspense>
        </EditorErrorBoundary>
      )}
    </div>
  );
}
