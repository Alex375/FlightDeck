// Composer image attachments — the "+" button, paste-an-image and drop-a-file flows.
//
// State is IN-MEMORY and per-conversation (keyed by the stable conv id), NOT
// persisted: base64 image blobs would bloat localStorage, and an attachment is a
// transient part of the message being composed. It survives a conversation switch
// (the pane remounts, but the store doesn't) and is cleared on send. The typed text
// draft lives separately in `composerDrafts` (that one IS persisted).
//
// Only the four media types the model accepts as `image` blocks are attachable
// (png / jpeg / gif / webp — verified against the `claude` binary). Any other file
// picked via "+" is inserted as a path mention in the text instead (Claude reads it
// with its own tools); see `attachPaths`.
//
// The in-flight read count and the last failure live here too, per conversation, rather
// than in the composer: a file dropped on a Flight Deck card is attached to a conversation
// whose composer is not mounted yet, and its send-lock and errors must still be there when
// the reply modal opens on it.

import { create } from "zustand";
import { commands } from "../../ipc/client";
import { useComposerDrafts } from "../../store/composerDrafts";
import type { UserTurnImage } from "../../store/types";

/** An attachment in the composer: a `UserTurnImage` plus a local id for list keys
 *  and removal. `dataBase64` is raw base64 (no `data:` prefix), wire-ready. */
export interface ImageAttachmentDraft extends UserTurnImage {
  id: string;
}

interface AttachmentsState {
  /** Attachments per conversation stable id. */
  byConv: Record<string, ImageAttachmentDraft[]>;
  /** In-flight image reads per conversation. While > 0 that conversation's send is
   *  blocked, so a fast attach-then-Enter can't fire BEFORE the image lands (which would
   *  send without it, then attach it to the NEXT message). Absent = 0. */
  reading: Record<string, number>;
  /** Last attach failure per conversation (unreadable / too large / unsupported), shown
   *  inline in the attachment row until the next attach attempt or send. */
  errors: Record<string, string>;
  add: (convId: string, att: ImageAttachmentDraft) => void;
  remove: (convId: string, id: string) => void;
  /** Drop this conversation's attachments AND its error (a send consumed them, or the
   *  conversation was deleted). In-flight reads are left alone: they settle on their own. */
  clear: (convId: string) => void;
  /** Drop every conversation's attachments and errors — for a full data wipe. */
  clearAll: () => void;
  beginRead: (convId: string) => void;
  endRead: (convId: string) => void;
  /** Set (or, with null, clear) this conversation's inline attach error. */
  setError: (convId: string, message: string | null) => void;
}

/** A copy of `map` without `key` (the map itself when the key is absent). */
function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export const useComposerAttachments = create<AttachmentsState>((set) => ({
  byConv: {},
  reading: {},
  errors: {},
  add: (convId, att) =>
    set((s) => ({ byConv: { ...s.byConv, [convId]: [...(s.byConv[convId] ?? []), att] } })),
  remove: (convId, id) =>
    set((s) => ({
      byConv: { ...s.byConv, [convId]: (s.byConv[convId] ?? []).filter((a) => a.id !== id) },
    })),
  clear: (convId) =>
    set((s) => {
      const byConv = s.byConv[convId]?.length ? without(s.byConv, convId) : s.byConv;
      const errors = without(s.errors, convId);
      return byConv === s.byConv && errors === s.errors ? s : { byConv, errors };
    }),
  clearAll: () =>
    set((s) =>
      Object.keys(s.byConv).length || Object.keys(s.errors).length ? { byConv: {}, errors: {} } : s,
    ),
  beginRead: (convId) =>
    set((s) => ({ reading: { ...s.reading, [convId]: (s.reading[convId] ?? 0) + 1 } })),
  endRead: (convId) =>
    set((s) => {
      const n = (s.reading[convId] ?? 0) - 1;
      return { reading: n > 0 ? { ...s.reading, [convId]: n } : without(s.reading, convId) };
    }),
  setError: (convId, message) =>
    set((s) => {
      if (message === null) {
        const errors = without(s.errors, convId);
        return errors === s.errors ? s : { errors };
      }
      return s.errors[convId] === message ? s : { errors: { ...s.errors, [convId]: message } };
    }),
}));

/** Forget one conversation's attachments — call when it's deleted so the in-memory
 *  map doesn't accumulate orphan base64 blobs. Mirrors clearComposerDraft. */
export function clearComposerAttachments(convId: string): void {
  useComposerAttachments.getState().clear(convId);
}

/** Drop every conversation's attachments — call on a full data wipe ("Delete
 *  all"). Mirrors clearAllComposerDrafts. */
export function clearAllComposerAttachments(): void {
  useComposerAttachments.getState().clearAll();
}

const EMPTY: ImageAttachmentDraft[] = [];

/** Reactive selector: this conversation's current attachments (stable empty array). */
export function useConvAttachments(convId: string): ImageAttachmentDraft[] {
  return useComposerAttachments((s) => s.byConv[convId] ?? EMPTY);
}

/** Imperative read (for the send path). */
export function attachmentsFor(convId: string): ImageAttachmentDraft[] {
  return useComposerAttachments.getState().byConv[convId] ?? EMPTY;
}

/** Reactive: whether this conversation has image reads in flight (its send is locked). */
export function useAttachReading(convId: string): boolean {
  return useComposerAttachments((s) => (s.reading[convId] ?? 0) > 0);
}

/** Reactive: this conversation's inline attach error, or null. */
export function useAttachError(convId: string): string | null {
  return useComposerAttachments((s) => s.errors[convId] ?? null);
}

// ---- media-type gating ------------------------------------------------------

// Extension → wire media type, restricted to what the model accepts as an image
// block. A picked file whose extension isn't here is NOT an attachable image.
const EXT_WIRE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const SUPPORTED_WIRE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The wire media type for a path if it is a model-attachable image, else null. */
export function wireImageMimeForPath(path: string): string | null {
  const name = path.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  return EXT_WIRE_MIME[ext] ?? null;
}

/** Normalize a browser blob MIME (paste/drop) to a supported wire type, or null. */
export function normalizeWireMime(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  if (m === "image/apng") return "image/png";
  return SUPPORTED_WIRE_MIME.has(m) ? m : null;
}

// ---- building attachments ---------------------------------------------------

/** The last path segment of a POSIX-ish path. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `att_${Math.abs(hashString(String(performance.now())))}`;

// Deterministic fallback id (no Math.random) for environments without crypto.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

/** Outcome of trying to attach a picked file path. `null` = not an attachable image
 *  (caller should treat it as a file mention). `{ error }` = a real, surfaceable
 *  failure (unreadable / too large). */
export type PathAttachResult = ImageAttachmentDraft | { error: string } | null;

/** Read a picked image file's bytes (base64) via the fs service. Returns null when
 *  the path isn't a model-attachable image, so the caller inserts a path mention. */
export async function attachmentFromPath(path: string): Promise<PathAttachResult> {
  const mediaType = wireImageMimeForPath(path);
  if (!mediaType) return null;
  const res = await commands.readImage(path);
  if (res.status === "error") return { error: `Failed to read image: ${res.error}` };
  if (res.data.too_large) return { error: `Image too large: ${basename(path)}` };
  return { id: uid(), name: basename(path), mediaType, dataBase64: res.data.data_base64 };
}

// Byte ceiling for an attached image, mirroring the fs service's MAX_FILE_BYTES
// (src-tauri/src/fs/mod.rs) so BOTH the file-picker path (guarded by read_image's
// too_large) and the paste path enforce the same limit — a full-res base64 blob on
// the wire + in memory would otherwise stall the webview.
export const MAX_ATTACH_BYTES = 16 * 1024 * 1024;

/** Turn a pasted/dropped image blob into an attachment (FileReader → base64). Returns
 *  null when the blob isn't a supported image type, or `{ error }` when it exceeds
 *  MAX_ATTACH_BYTES (the paste path has no fs-layer size guard, unlike the picker). */
export function attachmentFromBlob(blob: Blob, name: string): Promise<PathAttachResult> {
  const mediaType = normalizeWireMime(blob.type);
  if (!mediaType) return Promise.resolve(null);
  if (blob.size > MAX_ATTACH_BYTES) {
    const mib = Math.round(MAX_ATTACH_BYTES / (1024 * 1024));
    return Promise.resolve({ error: `Image too large (max ${mib} MiB): ${name}` });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? { id: uid(), name, mediaType, dataBase64: url.slice(comma + 1) } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// ---- routing picked / dropped paths -----------------------------------------

/** How a file path is written into the draft: relative to the conversation cwd when it
 *  lives under it (a short mention that resolves to a clickable chip), else absolute
 *  (still readable by Claude and by the mention resolver). */
export function mentionPath(abs: string, cwd: string | null): string {
  const base = cwd ? cwd.replace(/\/+$/, "") : "";
  return base && abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
}

/** The draft with these file-path mentions appended (space-separated, trailing space so
 *  the user can type straight on). */
export function appendMentions(draft: string, paths: string[], cwd: string | null): string {
  if (!paths.length) return draft;
  const joined = paths.map((p) => mentionPath(p, cwd)).join(" ");
  return draft.trim() ? `${draft.replace(/\s*$/, "")} ${joined} ` : `${joined} `;
}

/**
 * Attach files to a conversation's composer — the ONE routine behind the "+" picker and a
 * file dropped from the Finder, so both give exactly the same result: a model-attachable
 * image becomes a base64 attachment, anything else (another file type, a folder) becomes
 * a path mention appended to the draft, which Claude reads with its own tools.
 *
 * Works whether or not that conversation's composer is mounted (everything it touches is
 * a per-conversation store). Locks the conversation's send while images are read, and
 * surfaces every failure at once as its inline error — a later failure must not silently
 * erase an earlier one. Returns how many mentions were appended, so a mounted composer
 * can put the caret after them.
 *
 * `read` is injectable for tests; production reads through the fs service.
 */
export async function attachPaths(
  convId: string,
  paths: string[],
  cwd: string | null,
  read: (path: string) => Promise<PathAttachResult> = attachmentFromPath,
): Promise<{ mentions: number }> {
  const store = useComposerAttachments.getState;
  store().setError(convId, null);
  if (!paths.length) return { mentions: 0 };
  const mentions: string[] = [];
  const errs: string[] = [];
  store().beginRead(convId);
  try {
    for (const p of paths) {
      if (!wireImageMimeForPath(p)) {
        mentions.push(p);
        continue;
      }
      try {
        const res = await read(p);
        if (res && "error" in res) errs.push(res.error);
        else if (res) store().add(convId, res);
      } catch (e) {
        // An IPC-level failure (not a typed fs error) must still reach the user.
        errs.push(`Failed to read image ${basename(p)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    store().endRead(convId);
  }
  if (errs.length) store().setError(convId, [...new Set(errs)].join(" · "));
  if (mentions.length) {
    // Read the draft NOW, after the awaits: the user may have typed while images loaded.
    const drafts = useComposerDrafts.getState();
    drafts.setDraft(convId, appendMentions(drafts.drafts[convId] ?? "", mentions, cwd));
  }
  return { mentions: mentions.length };
}

/** A `data:` URL for rendering an attachment/turn image as a thumbnail. */
export function imageDataUrl(img: { mediaType: string; dataBase64: string }): string {
  return `data:${img.mediaType};base64,${img.dataBase64}`;
}
