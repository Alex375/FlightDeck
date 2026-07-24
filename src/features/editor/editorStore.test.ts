// Exercises the editor store's buffer lifecycle and — crucially — the live/edit
// conflict policy. Runs against the browser IPC mock (jsdom → not Tauri), whose
// readFile returns deterministic synthetic content, so "external change" is real.

import { beforeEach, describe, expect, it } from "vitest";
import { useAppErrors } from "../../store/appErrors";
import { resetMockDisk, touchMockFile } from "../../ipc/mock/mockBindings";
import { useEditorStore, type FileBuffer } from "./editorStore";

const CONV = "conv-1";
const ROOT = "/repo";
const FILE = "/repo/a.txt";

function buffer(path = FILE): FileBuffer {
  const b = useEditorStore.getState().byConv[CONV]?.buffers[path];
  if (!b) throw new Error("buffer not found");
  return b;
}

/** Force buffer fields (simulating prior edits / a stale saved baseline). */
function patch(path: string, fields: Partial<FileBuffer>) {
  useEditorStore.setState((st) => {
    const c = st.byConv[CONV];
    return {
      byConv: {
        ...st.byConv,
        [CONV]: { ...c, buffers: { ...c.buffers, [path]: { ...c.buffers[path], ...fields } } },
      },
    };
  });
}

beforeEach(() => {
  useEditorStore.setState({ byConv: {} });
  // Simulated disk writes are module-global in the mock — reset them so one test's
  // "the agent rewrote this" doesn't leak into the next one's baseline.
  resetMockDisk();
});

describe("buffer lifecycle", () => {
  it("opens a file as a clean buffer (content == saved)", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    const b = buffer();
    expect(b.loading).toBe(false);
    expect(b.dirty).toBe(false);
    expect(b.content).toBe(b.saved);
    expect(b.content.length).toBeGreaterThan(0);
  });

  it("marks the buffer dirty on edit and clean again when reverted", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    const saved = buffer().saved;

    s.setContent(CONV, FILE, "changed");
    expect(buffer().dirty).toBe(true);

    s.setContent(CONV, FILE, saved);
    expect(buffer().dirty).toBe(false);
  });

  it("opens markdown in preview by default", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/README.md");
    expect(buffer("/repo/README.md").preview).toBe(true);
  });
});

describe("conflict policy on external change", () => {
  it("live-reloads a CLEAN buffer in place", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    // Stale clean baseline that differs from what's on disk.
    patch(FILE, { content: "OLD", saved: "OLD", dirty: false });

    await s.onExternalChange(CONV, [FILE]);

    const b = buffer();
    expect(b.dirty).toBe(false);
    expect(b.diskChanged).toBe(false);
    expect(b.content).not.toBe("OLD"); // reloaded from disk
    expect(b.content).toBe(b.saved);
  });

  it("PROTECTS a dirty buffer: keeps local edits + flags diskChanged", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    patch(FILE, { content: "LOCAL", saved: "OLD", dirty: true });

    await s.onExternalChange(CONV, [FILE]);

    const b = buffer();
    expect(b.content).toBe("LOCAL"); // untouched
    expect(b.dirty).toBe(true);
    expect(b.diskChanged).toBe(true);
    expect(b.diskContent).not.toBeNull();
  });

  it("PROTECTS a dirty buffer even when the on-disk file turned binary (no silent loss)", async () => {
    const s = useEditorStore.getState();
    const P = "/repo/__binary__.txt";
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, P);
    // A dirty text buffer whose on-disk version has meanwhile become binary (the
    // mock returns binary:true + empty content for a __binary__ path). The dirty
    // guard must win over the binary branch, or the edits are silently clobbered.
    patch(P, { binary: false, content: "LOCAL", saved: "OLD", dirty: true, diskChanged: false, diskContent: null });

    await s.onExternalChange(CONV, [P]);

    const b = buffer(P);
    expect(b.content).toBe("LOCAL"); // edits kept, NOT overwritten by the binary disk read
    expect(b.dirty).toBe(true);
    expect(b.diskChanged).toBe(true); // surfaced via the "modified on disk" banner instead
  });

  it("reloadFromDisk applies the pending disk content and clears the flag", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    patch(FILE, { content: "LOCAL", saved: "OLD", dirty: true });
    await s.onExternalChange(CONV, [FILE]);
    const disk = buffer().diskContent!;

    s.reloadFromDisk(CONV, FILE);

    const b = buffer();
    expect(b.content).toBe(disk);
    expect(b.saved).toBe(disk);
    expect(b.dirty).toBe(false);
    expect(b.diskChanged).toBe(false);
    expect(b.diskContent).toBeNull();
  });
});

describe("resyncOpenBuffers (catch-up when the watch re-points, and on the poll tick)", () => {
  it("catches up a CLEAN open buffer that changed while unwatched", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    const opened = buffer().content;
    // A write we never got an event for (the watch was on another cwd).
    touchMockFile(FILE);

    // No path list — the watch just re-pointed here and we re-check everything open.
    await s.resyncOpenBuffers(CONV);

    const b = buffer();
    expect(b.content).not.toBe(opened); // resynced from disk
    expect(b.content).toBe(b.saved);
    expect(b.dirty).toBe(false);
  });

  it("still PROTECTS a dirty buffer on resync (never clobbers local edits)", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE);
    patch(FILE, { content: "LOCAL", saved: "OLD", dirty: true });
    touchMockFile(FILE);

    await s.resyncOpenBuffers(CONV);

    const b = buffer();
    expect(b.content).toBe("LOCAL");
    expect(b.dirty).toBe(true);
    expect(b.diskChanged).toBe(true);
  });

  // The regression this whole mechanism exists for: an agent rewrites a PDF (or an
  // image) you have open while you're on ANOTHER conversation. No fs event ever
  // reaches this tab, and resync used to skip binaries outright to save the re-read
  // — so the viewer kept showing the old document as though it were current.
  it("REFRESHES an image tab rewritten while this conversation was unwatched", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/pic.png");
    patch("/repo/pic.png", { imageDataUrl: "data:STALE" });
    touchMockFile("/repo/pic.png");

    await s.resyncOpenBuffers(CONV);

    expect(buffer("/repo/pic.png").imageDataUrl).not.toBe("data:STALE");
  });

  it("REFRESHES a PDF tab rewritten while this conversation was unwatched", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.pdf");
    patch("/repo/doc.pdf", { pdfBase64: "STALE" });
    touchMockFile("/repo/doc.pdf");

    await s.resyncOpenBuffers(CONV);

    expect(buffer("/repo/doc.pdf").pdfBase64).not.toBe("STALE");
  });

  // The other half of the deal: covering binaries must NOT mean re-reading every
  // open tab's bytes on every conversation switch and every poll tick. An untouched
  // file is settled by its stat alone.
  it("does NOT re-read a tab whose disk stamp is unchanged", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.pdf");
    await s.openFile(CONV, FILE);
    // Sentinels that only a real re-read would overwrite. Nothing was touched on
    // disk, so the stamps still match and both must survive.
    patch("/repo/doc.pdf", { pdfBase64: "UNTOUCHED" });
    patch(FILE, { content: "UNTOUCHED", saved: "UNTOUCHED" });

    await s.resyncOpenBuffers(CONV);

    expect(buffer("/repo/doc.pdf").pdfBase64).toBe("UNTOUCHED");
    expect(buffer(FILE).content).toBe("UNTOUCHED");
  });

  it("re-reads rather than trusting a buffer with no stamp yet", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.pdf");
    // An unknown stamp must read as "unknown", never as "unchanged" — otherwise a
    // buffer that failed to stamp (a failed read) would be frozen forever.
    patch("/repo/doc.pdf", { pdfBase64: "STALE", diskStamp: null });

    await s.resyncOpenBuffers(CONV);

    expect(buffer("/repo/doc.pdf").pdfBase64).not.toBe("STALE");
  });

  it("falls back to a full re-read when the stat call itself fails", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.pdf");
    patch("/repo/doc.pdf", { pdfBase64: "STALE" });
    // Make ONLY the stat fail (the mock fails on a `__fail__` path anywhere in the
    // batch), while the tab itself stays perfectly readable. Skipping the refresh
    // here would leave the PDF stale with nothing to show for it.
    await s.openFile(CONV, "/repo/__fail__/other.txt");

    await s.resyncOpenBuffers(CONV);

    expect(buffer("/repo/doc.pdf").pdfBase64).not.toBe("STALE");
  });
});

describe("preview (temporary) tabs", () => {
  const conv = () => useEditorStore.getState().byConv[CONV];

  it("single-click opens a reusable preview tab that the next single-click replaces", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true });
    expect(conv().tabs).toEqual(["/repo/a.txt"]);
    expect(conv().previewTab).toBe("/repo/a.txt");

    await s.openFile(CONV, "/repo/b.txt", { preview: true });
    expect(conv().tabs).toEqual(["/repo/b.txt"]); // replaced in place, not piled up
    expect(conv().previewTab).toBe("/repo/b.txt");
  });

  it("double-click pins (appends) and leaves an existing preview alone", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true }); // preview a
    await s.openFile(CONV, "/repo/b.txt", { preview: false }); // pin b → new tab
    expect(conv().tabs).toEqual(["/repo/a.txt", "/repo/b.txt"]);
    expect(conv().previewTab).toBe("/repo/a.txt");

    // A new preview replaces the preview slot (a), not the pinned tab (b).
    await s.openFile(CONV, "/repo/c.txt", { preview: true });
    expect(conv().tabs).toEqual(["/repo/c.txt", "/repo/b.txt"]);
    expect(conv().previewTab).toBe("/repo/c.txt");
  });

  it("pinning the current preview tab keeps it but clears the preview slot", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true });
    await s.openFile(CONV, "/repo/a.txt", { preview: false }); // double-click same file
    expect(conv().tabs).toEqual(["/repo/a.txt"]);
    expect(conv().previewTab).toBeNull();
  });

  it("editing a preview tab pins it", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt", { preview: true });
    s.setContent(CONV, "/repo/a.txt", "edited");
    expect(conv().previewTab).toBeNull();
    expect(conv().buffers["/repo/a.txt"].dirty).toBe(true);
  });
});

describe("error surfacing (no silent failures)", () => {
  const conv = () => useEditorStore.getState().byConv[CONV];

  it("surfaces a directory read error and does not get stuck loading", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.toggleDir(CONV, "/repo/__fail__");
    expect(conv().dirErrors["/repo/__fail__"]).toBeTruthy();
    expect(conv().dirs["/repo/__fail__"]).toBeUndefined();
    expect(conv().loadingDirs["/repo/__fail__"]).toBeFalsy();
  });

  it("catches a THROWN directory read (safeCmd) and surfaces it as an error", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    // Without safeCmd this would reject and leave the dir stuck loading forever.
    await s.toggleDir(CONV, "/repo/__throw__");
    expect(conv().dirErrors["/repo/__throw__"]).toBeTruthy();
    expect(conv().loadingDirs["/repo/__throw__"]).toBeFalsy();
  });

  it("a failed file read marks buffer.error instead of staying stuck loading", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/__fail__.txt", { preview: false });
    const b = conv().buffers["/repo/__fail__.txt"];
    expect(b.loading).toBe(false);
    expect(b.error).toBeTruthy();
  });

  it("a THROWN file read is caught (safeCmd) and surfaced on the buffer", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/__throw__.txt", { preview: false });
    const b = conv().buffers["/repo/__throw__.txt"];
    expect(b.loading).toBe(false);
    expect(b.error).toBeTruthy();
  });
});

describe("image buffers", () => {
  it("opens an image via readImage as a data URL (not the text/Monaco path)", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/logo.png");
    const b = buffer("/repo/logo.png");
    expect(b.loading).toBe(false);
    expect(b.isImage).toBe(true);
    expect(b.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(b.imageSize).toBeGreaterThan(0);
    // Never decoded as editable text.
    expect(b.binary).toBe(false);
    expect(b.content).toBe("");
  });

  it("live-reloads an open image on external change", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/logo.png");
    patch("/repo/logo.png", { imageDataUrl: "data:image/png;base64,STALE" });

    await s.onExternalChange(CONV, ["/repo/logo.png"]);

    const b = buffer("/repo/logo.png");
    expect(b.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(b.imageDataUrl).not.toContain("STALE");
  });

  it("surfaces a failed image read instead of staying stuck loading", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/__fail__.png");
    const b = buffer("/repo/__fail__.png");
    expect(b.loading).toBe(false);
    expect(b.error).toBeTruthy();
    expect(b.imageDataUrl).toBeNull();
  });

  it("persists the per-tab zoom/pan view so it survives a tab switch", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.png");
    await s.openFile(CONV, "/repo/b.png");

    // Zoom image A, then "leave" it (the viewer flushes its view on unmount).
    s.setImageView(CONV, "/repo/a.png", 4, { x: -120, y: 30 });

    // The view is remembered on A's buffer and B is untouched (still default).
    expect(buffer("/repo/a.png").imageZoom).toBe(4);
    expect(buffer("/repo/a.png").imageOffset).toEqual({ x: -120, y: 30 });
    expect(buffer("/repo/b.png").imageZoom).toBeUndefined();
  });
});

describe("pdf buffers", () => {
  it("opens a PDF via readImage as base64 bytes (not the text/Monaco path)", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.pdf");
    const b = buffer("/repo/doc.pdf");
    expect(b.loading).toBe(false);
    expect(b.isPdf).toBe(true);
    expect(b.isImage).toBe(false);
    expect(b.pdfBase64).toBeTruthy();
    expect(b.tooLarge).toBe(false);
    // Never decoded as editable text.
    expect(b.binary).toBe(false);
    expect(b.content).toBe("");
  });

  it("live-reloads an open PDF on external change", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.pdf");
    patch("/repo/doc.pdf", { pdfBase64: "STALE" });

    await s.onExternalChange(CONV, ["/repo/doc.pdf"]);

    const b = buffer("/repo/doc.pdf");
    expect(b.pdfBase64).toBeTruthy();
    expect(b.pdfBase64).not.toBe("STALE");
  });

  it("surfaces a failed PDF read instead of staying stuck loading", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/__fail__.pdf");
    const b = buffer("/repo/__fail__.pdf");
    expect(b.loading).toBe(false);
    expect(b.error).toBeTruthy();
    expect(b.pdfBase64).toBeNull();
  });
});

describe("tabs", () => {
  it("closing the active tab falls back to a neighbour", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/a.txt");
    await s.openFile(CONV, "/repo/b.txt");
    expect(useEditorStore.getState().byConv[CONV].activeTab).toBe("/repo/b.txt");

    s.closeTab(CONV, "/repo/b.txt");
    const c = useEditorStore.getState().byConv[CONV];
    expect(c.tabs).toEqual(["/repo/a.txt"]);
    expect(c.activeTab).toBe("/repo/a.txt");
  });
});

// The "jump to a line" plumbing behind clickable file mentions: openFile's `reveal`
// option, the markdown→source forcing, the seq nonce (so a re-click replays), and the
// revealInEditor orchestration (open panel + collapse tree + arm the reveal).
describe("reveal (clickable file mentions)", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("stamps a pendingReveal with line + column and a fresh seq", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE, { reveal: { line: 42, column: 7 } });
    const r = buffer().pendingReveal;
    expect(r).toMatchObject({ line: 42, column: 7 });
    expect(typeof r!.seq).toBe("number");
  });

  it("defaults the reveal column to 1", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE, { reveal: { line: 5 } });
    expect(buffer().pendingReveal).toMatchObject({ line: 5, column: 1 });
  });

  it("re-arms a NEW seq when revealing the SAME line of an already-open file", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE, { reveal: { line: 10 } });
    const seq1 = buffer().pendingReveal!.seq;
    // A re-click on the same line must produce a higher seq so MonacoView replays
    // the jump+pulse (an identical reveal would otherwise be a no-op).
    await s.openFile(CONV, FILE, { reveal: { line: 10 } });
    expect(buffer().pendingReveal!.seq).toBeGreaterThan(seq1);
  });

  it("forces a markdown file to source when a line reveal is pending", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.md", { reveal: { line: 3 } });
    const b = buffer("/repo/doc.md");
    expect(b.language).toBe("markdown");
    expect(b.preview).toBe(false); // source, so Monaco mounts and can jump
  });

  it("opens markdown in rendered preview when there is NO reveal", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.md");
    expect(buffer("/repo/doc.md").preview).toBe(true);
  });

  it("flips an already-open markdown preview to source on a later reveal", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/doc.md");
    expect(buffer("/repo/doc.md").preview).toBe(true);
    await s.openFile(CONV, "/repo/doc.md", { reveal: { line: 2 } });
    expect(buffer("/repo/doc.md").preview).toBe(false);
  });

  it("clearReveal drops the consumed pendingReveal", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, FILE, { reveal: { line: 9 } });
    expect(buffer().pendingReveal).not.toBeNull();
    s.clearReveal(CONV, FILE);
    expect(buffer().pendingReveal).toBeNull();
  });

  it("revealInEditor opens the panel, collapses the tree, and arms the reveal", async () => {
    const s = useEditorStore.getState();
    s.setOpen(false);
    s.setTreeCollapsed(false);
    s.revealInEditor(CONV, ROOT, FILE, { line: 12 });
    // Panel + tree are synchronous orchestration.
    expect(useEditorStore.getState().open).toBe(true);
    expect(useEditorStore.getState().treeCollapsed).toBe(true);
    await tick(); // openFile is fired (void) — let the buffer settle
    expect(buffer().pendingReveal).toMatchObject({ line: 12, column: 1 });
  });

  it("revealInEditor without a line opens the file but arms no reveal", async () => {
    const s = useEditorStore.getState();
    s.revealInEditor(CONV, ROOT, FILE);
    await tick();
    expect(buffer().pendingReveal).toBeNull();
  });
});

// The explorer's mutating actions must NEVER fail silently: any rejected disk op
// (or a thrown transport probe) has to land on the app-level error banner. These
// lock that contract via the mock's `__fail__`/`__throw__` path sentinels.
describe("explorer mutations — error surfacing (zero silent failures)", () => {
  beforeEach(() => {
    useEditorStore.setState({ byConv: {}, clipboard: null });
    useAppErrors.setState({ errors: [] });
  });

  function setEditing(target: { kind: "rename" | "newFile" | "newDir"; parentPath: string; targetPath?: string; initial: string }) {
    useEditorStore.setState((st) => ({
      byConv: { ...st.byConv, [CONV]: { ...st.byConv[CONV], editing: target } },
    }));
  }

  it("surfaces a failed delete (trash) on the app banner", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.deletePath(CONV, "/repo/__fail__/doomed.txt");
    expect(useAppErrors.getState().errors.length).toBe(1);
  });

  it("surfaces a failed rename", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    setEditing({ kind: "rename", parentPath: ROOT, targetPath: "/repo/__fail__.txt", initial: "__fail__.txt" });
    await s.commitEdit(CONV, "renamed.txt");
    expect(useAppErrors.getState().errors.length).toBe(1);
  });

  it("surfaces a failed create", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    setEditing({ kind: "newFile", parentPath: ROOT, initial: "" });
    await s.commitEdit(CONV, "broken__fail__.txt");
    expect(useAppErrors.getState().errors.length).toBe(1);
  });

  it("surfaces an invalid name instead of swallowing it", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    setEditing({ kind: "newFile", parentPath: ROOT, initial: "" });
    await s.commitEdit(CONV, "a/b"); // a separator → invalid, must be reported
    expect(useAppErrors.getState().errors.length).toBe(1);
  });

  it("surfaces a thrown collision probe during paste (the one un-safeCmd'd call)", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    s.setClipboard(["/repo/a.txt"], "copy");
    await s.pasteInto(CONV, "/repo/__throw__dir");
    expect(useAppErrors.getState().errors.length).toBe(1);
  });

  it("surfaces a failed live refresh (a stale tree is never silent)", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    // Pretend a directory whose RE-READ will fail is already loaded, then signal a
    // change under it: the refresh re-reads it, fails, and must surface (not just
    // console.error and leave the tree stale).
    useEditorStore.setState((st) => ({
      byConv: {
        ...st.byConv,
        [CONV]: { ...st.byConv[CONV], dirs: { ...st.byConv[CONV].dirs, "/repo/__fail__d": [] } },
      },
    }));
    await s.onExternalChange(CONV, ["/repo/__fail__d/changed.txt"]);
    expect(useAppErrors.getState().errors.length).toBe(1);
  });
});

// Renaming/moving a DIRECTORY must rebase its open child buffers (keep the tabs),
// not silently drop them.
describe("explorer mutations — folder rename rebases open buffers", () => {
  beforeEach(() => {
    useEditorStore.setState({ byConv: {}, clipboard: null });
    useAppErrors.setState({ errors: [] });
  });

  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  it("moves a child buffer with the folder instead of closing it", async () => {
    const s = useEditorStore.getState();
    s.ensureConv(CONV, ROOT);
    await s.openFile(CONV, "/repo/dir/child.txt", { preview: false });
    await settle();
    expect(useEditorStore.getState().byConv[CONV].buffers["/repo/dir/child.txt"]).toBeTruthy();

    // Rename the folder /repo/dir -> /repo/renamed (renameEntry mock → ok).
    useEditorStore.setState((st) => ({
      byConv: {
        ...st.byConv,
        [CONV]: { ...st.byConv[CONV], editing: { kind: "rename", parentPath: ROOT, targetPath: "/repo/dir", initial: "dir" } },
      },
    }));
    await s.commitEdit(CONV, "renamed");

    const c = useEditorStore.getState().byConv[CONV];
    expect(c.buffers["/repo/dir/child.txt"]).toBeUndefined(); // old path gone
    expect(c.buffers["/repo/renamed/child.txt"]).toBeTruthy(); // rebased, not closed
    expect(c.tabs).toContain("/repo/renamed/child.txt");
  });
});
