// Front-derived registry of the artifacts Claude published in a conversation via the
// `Artifact` tool (a hosted HTML/MD page at claude.ai/artifact/<id>).
//
// Everything is DERIVED from the message stream already in `conversationStore` — the
// `Artifact` tool_use inputs (file_path / description / favicon / label) joined to their
// plain-text tool_result (which carries the published URL). NO Rust/IPC/persistence: the
// tool_use + tool_result are replayed from the transcript by history.rs, so a resumed
// conversation surfaces the same artifacts as a live one — for free.
//
// READ-ONLY toward claude.ai: this only reads what was already published; it never issues
// an `Artifact` publish/list call (that would be a real side-effect on the user's account).

import type { JsonValue } from "../../ipc/client";
import type { SessionEntry } from "../../store/types";
import { useConversationStore } from "../../store/conversationStore";
import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { basename } from "./toolMeta";

/** The canonical hosted-artifact URL shape. The publish tool_result is free text that
 *  ALWAYS begins "Published <abs_path> at <url>"; we anchor on the URL shape rather than
 *  parsing the surrounding human prose (which drifts across CLI versions — short vs long
 *  "To update:" forms, the "(Version N)" suffix).
 *
 *  ⚠️ BOTH shapes, on purpose. Up to claude 2.1.270 the URL was
 *  `https://claude.ai/code/artifact/<uuid>`; from 2.1.272 it is `https://claude.ai/artifact/<id>`
 *  (a ~22-char base58 id). Transcripts written by older binaries keep the old URL forever, so
 *  dropping it would regress every conversation already on disk. Missing the new one is what
 *  turned every card "Unavailable" and every prose link into a bare anchor. The trailing `/`
 *  keeps the gallery (`…/code/artifacts`) out. */
export const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/;

/** True when an `Artifact` tool_use is a real PUBLISH of a local page — the only call that is a
 *  deliverable. The tool also does `action:"list"`/`"read"`/`"quickstart"` and bare `url`-updates
 *  (no `file_path`), and `asset:true` UPLOADS (a `file_path` that is an image/font/PDF pushed into
 *  an existing artifact's asset store — not a page of its own). SINGLE source of truth for the
 *  inline card (`groupBlocks`) and the chip's list (`selectArtifacts`), so they never disagree. */
export function isArtifactPublish(input: JsonValue): boolean {
  if (!field(input, "file_path")) return false;
  return (input as Record<string, JsonValue>).asset !== true;
}

/** Pull the published URL out of an `Artifact` tool_result. Null while the publish is still
 *  in flight (no result yet) or if the ack is ever reworded past the canonical URL shape —
 *  callers degrade to a label-only, non-clickable state rather than a dead link. Mirrors the
 *  defensive `runIdFromResult` parse. */
export function artifactUrlFromResult(content: JsonValue | undefined): string | null {
  const text = resultText(content);
  if (!text) return null;
  const m = text.match(ARTIFACT_URL_RE);
  return m ? m[0] : null;
}

/** One publish of an artifact (one `Artifact` tool_use). Re-publishing the same file_path in
 *  the same conversation keeps the same URL and appends one of these — a version. */
export interface ArtifactVersion {
  /** The author-chosen `label` for this publish, or null (often omitted on the first publish).
   *  NOT unique — the same label can appear on different files — so it is never a grouping key. */
  label: string | null;
  /** The tool_use id that produced this version — the join key to its tool_result. */
  toolUseId: string;
  filePath: string;
  description: string | null;
  favicon: string | null;
  /** True when THIS publish's tool_result came back `is_error` (a failed/refused publish).
   *  False while still in flight (no result yet) or on success. */
  isError: boolean;
}

/** An artifact grouped across its versions for one conversation. */
export interface Artifact {
  /** Hosted URL (see {@link ARTIFACT_URL_RE}). Null only in the brief window between a
   *  publish tool_use and its tool_result landing. */
  url: string | null;
  /** Emoji favicon — of the most recent version that set it (last-known-good, so a republish
   *  that omits the favicon keeps the prior one), or null. */
  favicon: string | null;
  /** Gallery subtitle — of the most recent version that set it (last-known-good), or null. */
  description: string | null;
  /** Display title: the most recent non-empty label (last-known-good, consistent with
   *  favicon/description), else the file's basename (the wire carries no HTML <title>). */
  title: string;
  /** The file_path every version of this artifact was published from — INVARIANT, since it IS
   *  the grouping key (a different path is a different artifact). Kept under the historical
   *  `latest…` name for its readers. An EPHEMERAL temp scratchpad path: it may already be gone,
   *  so it is only ever a best-effort render source, never the artifact's identity (the hosted
   *  URL is). */
  latestFilePath: string;
  /** Every publish, oldest-first. */
  versions: ArtifactVersion[];
}

const EMPTY_ARTIFACTS: Artifact[] = [];

function stripExt(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

function artifactTitle(latestLabel: string | null, latestFilePath: string): string {
  if (latestLabel && latestLabel.trim()) return latestLabel.trim();
  const base = basename(latestFilePath);
  const stem = base ? stripExt(base) : "";
  return stem || "Artifact";
}

/**
 * Pure: walk a session's timeline and group every `Artifact` publish into one {@link Artifact}
 * per file_path, oldest→newest.
 *
 * Design choices, grounded in the verified wire contract:
 *  - MAIN-THREAD ONLY (`parentToolUseId === null`): a sub-agent's Artifact tool_use is replayed
 *    live but SKIPPED on reload (history.rs skip_sidechain), so scoping to the main thread keeps
 *    the list identical live and after a resume.
 *  - GROUP BY file_path (not URL, not label): same conversation + same file_path deterministically
 *    maps to the same URL, but the URL is only known once the tool_result lands — file_path is
 *    known at tool_use time, so it is the stable provisional key that never splits a republish
 *    into two items. Labels repeat across different files, so they are never a key.
 *  - Anything but a real publish ({@link isArtifactPublish}: list/read/quickstart, a bare
 *    cross-conversation url-update, an asset upload) is skipped — it doesn't describe a local page.
 *    (The inline card path uses the same predicate in `groupBlocks`.)
 *  - An artifact whose EVERY publish terminally FAILED (all versions `is_error`, no URL) is dropped
 *    from this list: it is not an openable artifact, so it must not inflate the "Artifacts (N)" chip
 *    nor sit there mislabelled as "not published yet". The failure is still surfaced in the thread
 *    by <ArtifactCard> (which reads `is_error` and shows the reason). A still-pending publish (no
 *    result yet → not `is_error`) is kept.
 */
export function selectArtifacts(entry: SessionEntry | undefined): Artifact[] {
  if (!entry) return EMPTY_ARTIFACTS;
  const byFile = new Map<string, Artifact>();
  const order: string[] = [];
  for (const t of entry.timeline) {
    if (t.kind !== "turn") continue;
    const turn = entry.turns[t.id];
    if (!turn || turn.role !== "assistant" || turn.parentToolUseId !== null) continue;
    for (const b of turn.blocks) {
      if (b.type !== "tool_use" || b.name !== "Artifact" || !isArtifactPublish(b.input)) continue;
      const filePath = field(b.input, "file_path")!;
      const label = field(b.input, "label") ?? null;
      const description = field(b.input, "description") ?? null;
      const favicon = field(b.input, "favicon") ?? null;
      const result = entry.toolResults[b.id];
      const url = artifactUrlFromResult(result?.content);
      const isError = !!result?.isError;
      let art = byFile.get(filePath);
      if (!art) {
        art = { url: null, favicon: null, description: null, title: "", latestFilePath: filePath, versions: [] };
        byFile.set(filePath, art);
        order.push(filePath);
      }
      art.versions.push({ label, toolUseId: b.id, filePath, description, favicon, isError });
      // Header fields = LAST-KNOWN-GOOD (timeline order = oldest→newest): keep the last non-null we
      // see, so a republish that omits a field doesn't blank the header. Any version's URL is the
      // artifact's URL (stable across republishes). `latestFilePath` is NOT refreshed here: it is
      // the grouping key, so every version of this artifact carries the very same path — writing it
      // per version would only re-assign the identical value and imply, wrongly, that it can drift.
      if (favicon) art.favicon = favicon;
      if (description) art.description = description;
      if (url) art.url = url;
    }
  }
  if (order.length === 0) return EMPTY_ARTIFACTS;
  const out = order
    .map((fp) => byFile.get(fp)!)
    // Drop artifacts whose every publish terminally failed (no URL + all versions errored). A
    // pending version (no result yet) is NOT errored, so a still-publishing artifact survives.
    .filter((a) => a.url || !a.versions.every((v) => v.isError));
  if (out.length === 0) return EMPTY_ARTIFACTS;
  return out.map((a) => {
    // Title = last-known-good label (consistent with favicon/description), else basename.
    let lastLabel: string | null = null;
    for (const v of a.versions) if (v.label && v.label.trim()) lastLabel = v.label;
    a.title = artifactTitle(lastLabel, a.latestFilePath);
    return a;
  });
}

/** A cheap content signature — lets {@link memoizedArtifacts} return the SAME array reference
 *  when the derived list is unchanged, so a tool_result for an unrelated tool (frequent) never
 *  re-renders the chip. */
function artifactsSig(list: Artifact[]): string {
  return list.map((a) => `${a.url ?? a.latestFilePath}#${a.versions.length}#${a.favicon ?? ""}#${a.title}`).join("|");
}

const cache = new Map<
  string,
  {
    timeline: SessionEntry["timeline"];
    toolResults: SessionEntry["toolResults"];
    sig: string;
    result: Artifact[];
  }
>();

/**
 * `selectArtifacts` memoised per session on the `timeline` AND `toolResults` references. Both
 * matter: a new publish appears as a tool_use (timeline advances when the turn settles) and its
 * URL arrives as a tool_result (toolResults changes) — keying on both catches the artifact the
 * moment its URL is known, WITHOUT recomputing on every streamed token (which replaces `turns`
 * but neither `timeline` nor `toolResults`). Ref-stable across unrelated recomputes via the
 * content signature. Pure (module-singleton cache) so the invariant is unit-testable.
 */
export function memoizedArtifacts(session: string, entry: SessionEntry | undefined): Artifact[] {
  if (!entry) return EMPTY_ARTIFACTS;
  const cached = cache.get(session);
  if (cached && cached.timeline === entry.timeline && cached.toolResults === entry.toolResults) {
    return cached.result;
  }
  const result = selectArtifacts(entry);
  const sig = artifactsSig(result);
  if (cached && cached.sig === sig) {
    // Content unchanged (e.g. an unrelated tool_result landed) → keep the previous array so
    // subscribers don't re-render; just refresh the reference keys for the fast path.
    cache.set(session, { timeline: entry.timeline, toolResults: entry.toolResults, sig, result: cached.result });
    return cached.result;
  }
  cache.set(session, { timeline: entry.timeline, toolResults: entry.toolResults, sig, result });
  return result;
}

/**
 * Forget one conversation's memoised artifact list. MUST be called on every conversation-removal
 * path (see conversationsStore, alongside `useGoalStore.clear`): the cache entry pins the whole
 * `timeline` AND `toolResults` of a conversation that no longer exists — and tool results carry
 * full tool output (base64 images among them), so a session's worth of memory would be held for
 * the rest of the run. It is also a correctness guard: a stale entry keyed by a reused id would
 * hand back another conversation's artifacts.
 */
export function clearArtifactsCache(convId: string): void {
  cache.delete(convId);
}

/** Forget EVERY conversation's memoised artifact list (wipe-all). */
export function clearAllArtifactsCache(): void {
  cache.clear();
}

/** The artifacts published in a conversation, oldest-first. Empty when none (Codex conversations
 *  never yield any — the Artifact tool is Claude-only). Ref-stable while unchanged. */
export function useArtifacts(session: string): Artifact[] {
  return useConversationStore((s) => memoizedArtifacts(session, s.sessions[session]));
}
