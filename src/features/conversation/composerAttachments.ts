// Composer image attachments — the "+" button, paste-an-image and drop-a-file flows.
//
// All three go through ONE routine (`attachSources`, exposed as `attachPaths` for the
// picker/drop and `attachBlobs` for a paste), so they share the send-lock, the read
// deadline, the size ceiling, the error merging and the liveness check. A fourth,
// divergent copy of this pipeline is how "the + button and a drop disagree" bugs start.
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
   *  send without it, then attach it to the NEXT message). Absent = 0. Every read is
   *  bounded by ATTACH_READ_TIMEOUT_MS, so this count always comes back down. */
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

/**
 * A mention as it is written into the draft. Mentions are joined by spaces, so a path
 * that CONTAINS whitespace ("Capture d ecran 2026-09-19 a 14.03.21.pdf") would reach the
 * agent as several tokens — it then reads a path that doesn't exist and tells the user
 * the file is missing when it isn't. Such a path is wrapped in an inline-code span, the
 * one delimiter that reads as "this is one literal token" on both ends of the wire.
 *
 * The fence is longer than the longest backtick run inside the path, and padded when the
 * path itself starts or ends with a backtick (CommonMark), so the span always closes.
 *
 * A RELATIVE quoted path is also anchored with `./`, so a name that reads like prose
 * ("my notes.md") still says "a path, relative to the cwd" to the agent. It buys nothing
 * on OUR side: `parseFileMention` refuses any whitespace-bearing token on purpose, so
 * this mention is never a clickable chip. Widening the resolver was tried and reverted —
 * it did not even reach the case that motivates this function (its segment class is
 * ASCII-only, so the real "Capture d'écran … à 14.03.21.png" still failed), a user turn
 * renders as plain text with no Markdown pass so no chip was at stake anyway, and it
 * flagged `/usr/bin/ls -la` as a file. The wire is what this fixes, and only the wire.
 */
export function quoteMention(mention: string): string {
  if (!/\s/.test(mention)) return mention;
  const anchored = /^(?:\/|\.{1,2}\/)/.test(mention) ? mention : `./${mention}`;
  const longest = (anchored.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = anchored.startsWith("`") || anchored.endsWith("`") ? " " : "";
  return `${fence}${pad}${anchored}${pad}${fence}`;
}

/** The draft with these file-path mentions appended (space-separated, trailing space so
 *  the user can type straight on). */
export function appendMentions(draft: string, paths: string[], cwd: string | null): string {
  if (!paths.length) return draft;
  const joined = paths.map((p) => quoteMention(mentionPath(p, cwd))).join(" ");
  return draft.trim() ? `${draft.replace(/\s*$/, "")} ${joined} ` : `${joined} `;
}

/** How long a single image read may take before we give up on it. A read that never
 *  settles (an image on a network share that went away, an unplugged USB key: the fs
 *  service stays blocked in `fs::read` and its Tauri invoke never resolves) would
 *  otherwise leave `reading[convId]` at 1 FOREVER — that conversation's send button
 *  greyed out and Enter a silent no-op, with nothing on screen to explain it. */
export const ATTACH_READ_TIMEOUT_MS = 60_000;

/** How long a WHOLE batch may take, however many files it holds. The per-file deadline
 *  alone doesn't bound a batch: the send lock is taken once for all the sources and the
 *  reads run one after another, so dropping 30 images from a dead network share would
 *  hold the composer disabled for 30 × the per-file deadline — half an hour with no way
 *  to cancel. The budget is shared: each read gets whatever is LEFT of it. */
export const ATTACH_BATCH_TIMEOUT_MS = 120_000;

/** Separator between the failures shown in the composer's single inline error slot. */
const ERR_SEP = " · ";

/** The inline error with `errs` added to whatever another, overlapping batch already
 *  surfaced (deduplicated). Replacing would mean a slow batch silently erasing a fast
 *  one's failure, and the user never learning that file failed. */
export function mergeAttachErrors(previous: string | null, errs: string[]): string | null {
  const parts = [...new Set([...(previous ? previous.split(ERR_SEP) : []), ...errs])];
  return parts.length ? parts.join(ERR_SEP) : null;
}

/** The inline error WITHOUT the failures listed in `errs` — the undo of a merge. Used
 *  when a batch finds its conversation deleted: it takes back its own messages and
 *  leaves every other batch's standing. Two batches that produced the IDENTICAL message
 *  share one part (merging deduplicates), so taking one back takes the other's too —
 *  the ambiguity is inherent, and far narrower than wiping the conversation's slate. */
export function dropAttachErrors(previous: string | null, errs: string[]): string | null {
  if (!previous) return null;
  const drop = new Set(errs);
  const kept = previous.split(ERR_SEP).filter((p) => !drop.has(p));
  return kept.length ? kept.join(ERR_SEP) : null;
}

/** A duration as it reads in an error message. */
const fmtMs = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

/** `p`, rejecting once `ms` has elapsed. The abandoned promise may still settle later —
 *  we just stop waiting on it, which is what releases the send lock. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spent = fmtMs(ms);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${spent}`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** One thing to attach. A path and a pasted blob differ only in how they are read and in
 *  what "not an attachable image" means: a path falls back to a mention, a blob can't. */
type AttachSource =
  | { kind: "path"; path: string }
  | { kind: "blob"; blob: Blob; name: string };

export interface AttachOptions {
  /** Reads a picked/dropped image path. Injectable for tests; production goes through
   *  the fs service (`attachmentFromPath`). */
  read?: (path: string) => Promise<PathAttachResult>;
  /** Whether the target conversation still EXISTS. Re-checked after every await: a drop
   *  on a Flight Deck card whose conversation is deleted while the read runs must not
   *  resurrect attachments — nor rewrite a PERSISTED draft — for a conversation that is
   *  gone. Supplied by the callers (a store lookup here would be an import cycle:
   *  conversationsStore already imports this module). Defaults to "still alive". */
  isAlive?: () => boolean;
  /** Per-read deadline; defaults to ATTACH_READ_TIMEOUT_MS. Tests shorten it. */
  timeoutMs?: number;
  /** Deadline for the WHOLE batch; defaults to ATTACH_BATCH_TIMEOUT_MS. Tests shorten it. */
  batchTimeoutMs?: number;
}

/**
 * Attach files to a conversation's composer — the ONE routine behind the "+" picker, a
 * file dropped from the Finder and a pasted image, so all three give exactly the same
 * result: a model-attachable image becomes a base64 attachment, anything else (another
 * file type, a folder) becomes a path mention appended to the draft, which Claude reads
 * with its own tools.
 *
 * Works whether or not that conversation's composer is mounted (everything it touches is
 * a per-conversation store). Locks the conversation's send while images are read — under
 * a per-file AND a whole-batch deadline, so the lock is never permanent — and surfaces
 * each failure AS IT HAPPENS, merged with any other batch's: a later failure must not
 * silently erase an earlier one, and a 30-file batch must not sit mute until the last
 * read settles. Returns how many mentions were appended, so a mounted composer can put
 * the caret after them.
 */
async function attachSources(
  convId: string,
  sources: AttachSource[],
  cwd: string | null,
  opts: AttachOptions,
): Promise<{ mentions: number }> {
  const store = useComposerAttachments.getState;
  const read = opts.read ?? attachmentFromPath;
  const alive = opts.isAlive ?? (() => true);
  const timeoutMs = opts.timeoutMs ?? ATTACH_READ_TIMEOUT_MS;
  const batchTimeoutMs = opts.batchTimeoutMs ?? ATTACH_BATCH_TIMEOUT_MS;
  // Only a batch that finds the conversation idle may wipe the previous error: while
  // another batch is in flight, its failure (already shown) has to stay.
  if (!(store().reading[convId] ?? 0)) store().setError(convId, null);
  if (!sources.length) return { mentions: 0 };
  const mentions: string[] = [];
  // What THIS batch put in the store, so a conversation deleted mid-read takes back only
  // its own writes — `clear()` would also wipe an overlapping batch's attachments and
  // failures for the same conversation.
  const addedIds: string[] = [];
  const posted: string[] = [];
  /** Surface a failure NOW rather than at settle: on a slow batch the user has to learn
   *  which file failed while the rest are still being read, not minutes later. */
  const fail = (message: string) => {
    posted.push(message);
    store().setError(convId, mergeAttachErrors(store().errors[convId] ?? null, [message]));
  };
  const batchDeadline = Date.now() + batchTimeoutMs;
  let skipped = 0;
  store().beginRead(convId);
  try {
    for (const src of sources) {
      if (src.kind === "path" && !wireImageMimeForPath(src.path)) {
        mentions.push(src.path);
        continue;
      }
      const label = src.kind === "path" ? basename(src.path) : src.name;
      if (src.kind === "blob" && !normalizeWireMime(src.blob.type)) {
        fail(`Unsupported image format (png, jpeg, gif, webp): ${label}`);
        continue;
      }
      // Whatever is left of the batch budget, never more than one file's share. Out of
      // budget: skip the read outright (counted, reported once below) — carrying on would
      // keep the send locked for as long as there are files left in the batch.
      const left = Math.min(timeoutMs, batchDeadline - Date.now());
      if (left <= 0) {
        skipped++;
        continue;
      }
      try {
        const res = await withDeadline(
          src.kind === "path" ? read(src.path) : attachmentFromBlob(src.blob, src.name),
          left,
        );
        if (res && "error" in res) fail(res.error);
        else if (res) {
          if (alive()) {
            store().add(convId, res);
            addedIds.push(res.id);
          }
        } else if (src.kind === "blob") {
          // Type-checked above, so a null here is a FileReader failure, not a format we
          // refuse — say so rather than blaming the format.
          fail(`Failed to read pasted image: ${label}`);
        }
      } catch (e) {
        // An IPC-level failure (not a typed fs error), or a deadline: either way the user
        // must hear about it, and the finally below must still free the send.
        fail(`Failed to read image ${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!alive()) break;
    }
    if (skipped) {
      const plural = skipped > 1 ? "s" : "";
      fail(`Attaching timed out after ${fmtMs(batchTimeoutMs)}: ${skipped} image${plural} not read`);
    }
  } finally {
    store().endRead(convId);
  }
  if (!alive()) {
    // Deleted while we were reading: take back exactly what THIS batch wrote — its
    // attachments and its failures — and write nothing more (no draft). Another batch's
    // entries for the same conversation are none of our business.
    for (const id of addedIds) store().remove(convId, id);
    if (posted.length) {
      store().setError(convId, dropAttachErrors(store().errors[convId] ?? null, posted));
    }
    return { mentions: 0 };
  }
  if (mentions.length) {
    // Read the draft NOW, after the awaits: the user may have typed while images loaded.
    const drafts = useComposerDrafts.getState();
    drafts.setDraft(convId, appendMentions(drafts.drafts[convId] ?? "", mentions, cwd));
  }
  return { mentions: mentions.length };
}

/** Attach picked or dropped file PATHS (the "+" picker, a Finder drop). See attachSources. */
export function attachPaths(
  convId: string,
  paths: string[],
  cwd: string | null,
  opts: AttachOptions = {},
): Promise<{ mentions: number }> {
  return attachSources(convId, paths.map((path) => ({ kind: "path" as const, path })), cwd, opts);
}

/** Attach pasted image BLOBS (Cmd+V in the composer). Same pipeline as `attachPaths` —
 *  send lock, deadline, size ceiling, merged errors, liveness — but a blob has no path,
 *  so nothing can fall back to a mention: an unsupported one is a surfaced failure. */
export function attachBlobs(
  convId: string,
  blobs: { blob: Blob; name: string }[],
  opts: AttachOptions = {},
): Promise<{ mentions: number }> {
  return attachSources(convId, blobs.map((b) => ({ kind: "blob" as const, ...b })), null, opts);
}

/** A `data:` URL for rendering an attachment/turn image as a thumbnail. */
export function imageDataUrl(img: { mediaType: string; dataBase64: string }): string {
  return `data:${img.mediaType};base64,${img.dataBase64}`;
}
