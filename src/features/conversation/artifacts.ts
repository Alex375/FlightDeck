// Front-derived registry of the artifacts Claude published in a conversation via the
// `Artifact` tool (a hosted page at claude.ai/artifact/<id>).
//
// Everything is DERIVED from the message stream already in `conversationStore` — the
// `Artifact` tool_use inputs (file_path / url / type_url / title / description / favicon /
// label) joined to their plain-text tool_result (which carries the published URL). NO
// Rust/IPC/persistence: the tool_use + tool_result are replayed from the transcript by
// history.rs, so a resumed conversation surfaces the same artifacts as a live one — for free.
//
// Two kinds of artifact come out of it:
//  - a PAGE artifact: a self-contained HTML/Markdown file Claude wrote locally and published.
//    Its local temp file can be previewed in-app as is.
//  - a TYPED artifact (Claude Design canvases today, and any other Artifact type): its page
//    belongs to the TYPE, hosted on claude.ai, and the artifact itself only carries DATA files
//    (`canvas.json`, `.dc.html` components…). Rendering one of those local files as a page is
//    exactly what showed a broken screen, so a typed artifact is only ever shown hosted.
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

/**
 * The CANONICAL form of an artifact URL — exactly what the hosted view (and its Rust validator,
 * `artifact_host::parse_hosted_artifact_url`) accepts — or null when `href` isn't one.
 *
 * ⚠️ This is the bridge between two DELIBERATELY different strictnesses. `isArtifactUrl`
 * recognises a link in PROSE, where the model's casing drifts and a trailing slash or an extra
 * segment is normal; the Rust host takes an exact `https://claude.ai/[code/]artifact/<id>` and
 * refuses anything else. Handing a prose href straight to the host was a self-inflicted error
 * panel on a link that is perfectly good — so every hosted route goes through here first, and a
 * link that can't be canonicalised opens in the browser (as it did before the host existed).
 */
export function canonicalArtifactUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = href.trim().match(new RegExp(`^${ARTIFACT_URL_RE.source}`, "i"));
  if (!m) return null;
  // Scheme and host are case-INsensitive per RFC 3986, the path is not: lowercase only the
  // origin, and keep the `/artifact/<id>` segment exactly as the canonical shape spells it.
  const rest = m[0].slice("https://claude.ai".length);
  const path = rest.replace(/^\/code\/artifact\//i, "/code/artifact/").replace(/^\/artifact\//i, "/artifact/");
  return `https://claude.ai${path}`;
}

/** A local file the in-app viewer can render as a PAGE: HTML or Markdown. Anything else a
 *  publish names (`canvas.json`, a data file) is a typed artifact's DATA, never a page. */
const PAGE_FILE_RE = /\.(html?|md|markdown)$/i;

/** True when `filePath` is a file the in-app viewer can render on its own (HTML/Markdown). */
export function isPageFile(filePath: string | null | undefined): boolean {
  return !!filePath && PAGE_FILE_RE.test(filePath);
}

/** A canonical artifact URL carried in an input field (`url`, `type_url`), or null. Anchored on
 *  the whole value: an input is a bare URL, never prose. */
function inputArtifactUrl(input: JsonValue, key: string): string | null {
  const v = field(input, key)?.trim();
  if (!v) return null;
  const m = v.match(ARTIFACT_URL_RE);
  return m && m.index === 0 ? m[0] : null;
}

/** True when the input carries a non-empty `files` map/list (a multi-file publish). */
function hasFiles(input: JsonValue): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const files = (input as Record<string, JsonValue>).files;
  if (Array.isArray(files)) return files.length > 0;
  return !!files && typeof files === "object" && Object.keys(files).length > 0;
}

/** True when an `Artifact` tool_use is a real PUBLISH — the only call that is a deliverable:
 *  - a page publish (`file_path`, optionally `url` to update it in place),
 *  - a TYPED artifact's creation (`type_url`, no files — the type provides the page),
 *  - a files-only update of a known artifact (`url` + `files`).
 *  The tool also does `action:"list"`/`"read"`/`"quickstart"` and `asset:true` UPLOADS (an
 *  image/font/PDF pushed into an existing artifact's asset store — not a page of its own); none of
 *  those is a deliverable. SINGLE source of truth for the inline card (`groupBlocks`) and the
 *  chip's list (`selectArtifacts`), so they never disagree. */
export function isArtifactPublish(input: JsonValue): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const action = field(input, "action");
  // A missing action IS a publish (the tool's default); any other named action is not.
  if (action && action !== "publish") return false;
  if ((input as Record<string, JsonValue>).asset === true) return false;
  if (field(input, "file_path")) return true;
  if (inputArtifactUrl(input, "type_url")) return true;
  return !!inputArtifactUrl(input, "url") && hasFiles(input);
}

/** Every canonical artifact URL in `text`, in order of appearance, de-duplicated. A local `/g`
 *  regex per call — a shared one would carry `lastIndex` between calls. */
function allArtifactUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(ARTIFACT_URL_RE.source, "g"))) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** The TYPE a publish result says the artifact's page comes from ("…from the Artifact type
 *  <url>…", "Its page comes from the Artifact type <url>…"). Anchored on "type" right before the
 *  URL — the one stable part across both wordings — never on a whole sentence (the CLI's prose
 *  drifts; see the AskUserQuestion wording-drift lesson). */
/*  ⚠️ Built FROM {@link ARTIFACT_URL_RE}, never re-typed: the URL shape has already changed once
 *  (2.1.272), and a copy would keep matching the old one while the shared source moved on —
 *  silently dropping `typeName` and letting the type's URL be mistaken for the artifact's. Only
 *  the PROSE around it is case-insensitive (`[Tt]ype`); the URL itself stays case-sensitive, as
 *  every tool_result parse here is. */
const TYPE_URL_IN_RESULT_RE = new RegExp(String.raw`\b[Tt]ype\s+(${ARTIFACT_URL_RE.source})`);

/** The Artifact TYPE url named in a publish result, or null. */
export function artifactTypeUrlFromResult(content: JsonValue | undefined): string | null {
  const text = resultText(content);
  if (!text) return null;
  const m = text.match(TYPE_URL_IN_RESULT_RE);
  return m ? m[1] : null;
}

/** Pull the published URL out of an `Artifact` tool_result. Null while the publish is still
 *  in flight (no result yet) or if the ack is ever reworded past the canonical URL shape —
 *  callers degrade to a label-only, non-clickable state rather than a dead link. Mirrors the
 *  defensive `runIdFromResult` parse.
 *
 *  ⚠️ A typed artifact's result names TWO artifact URLs: the artifact's own AND its type's
 *  ("Created a new Artifact at <own> … from the Artifact type <type>"). The type's page is not
 *  this artifact, so it is skipped wherever it appears — never "whichever comes first". */
export function artifactUrlFromResult(content: JsonValue | undefined): string | null {
  const text = resultText(content);
  if (!text) return null;
  const typeUrl = text.match(TYPE_URL_IN_RESULT_RE)?.[1] ?? null;
  return allArtifactUrls(text).find((u) => u !== typeUrl) ?? null;
}

/** What one publish tells about the artifact it targets — the per-publish half of the typed
 *  detection, shared by the inline card (one publish) and `selectArtifacts` (all of them). */
export interface PublishInfo {
  /** The artifact's hosted URL: the input's `url` when it updates one in place (authoritative,
   *  known before any result), else the one the result names. */
  url: string | null;
  /** The Artifact TYPE this publish belongs to, when anything says so. */
  typeUrl: string | null;
  /** True when the publish sends SIBLING files alongside its page (`files`) — a page that loads
   *  them relatively. The local preview can't serve them (a `srcDoc` document under our CSP has
   *  no origin to resolve them against), so it would render the page stripped of its stylesheet,
   *  its script or its data, with nothing saying why. Hosted is the honest route. */
  multiFile: boolean;
  /** True when this publish is a typed artifact's (its page is the type's, hosted). Any ONE
   *  signal is enough — the create's `type_url`, the result naming a type, or a published file
   *  that is data rather than a page — so a reworded result alone never flips it back. */
  typed: boolean;
}

export function publishInfo(input: JsonValue, resultContent: JsonValue | undefined): PublishInfo {
  const typeUrl = inputArtifactUrl(input, "type_url") ?? artifactTypeUrlFromResult(resultContent);
  const url = inputArtifactUrl(input, "url") ?? artifactUrlFromResult(resultContent);
  const filePath = field(input, "file_path") ?? null;
  const typed = !!typeUrl || (!!filePath && !isPageFile(filePath));
  return { url, typeUrl, typed, multiFile: hasFiles(input) };
}

/** One publish of an artifact (one `Artifact` tool_use) — a version. */
export interface ArtifactVersion {
  /** The author-chosen `label` for this publish, or null (often omitted on the first publish).
   *  NOT unique — the same label can appear on different files — so it is never a grouping key. */
  label: string | null;
  /** The tool_use id that produced this version — the join key to its tool_result. */
  toolUseId: string;
  /** The local file this publish sent, or null — a typed artifact's CREATION sends none (the
   *  type provides the page; the data files come in a later publish). */
  filePath: string | null;
  description: string | null;
  favicon: string | null;
  /** True when THIS publish's tool_result came back `is_error` (a failed/refused publish).
   *  False while still in flight (no result yet) or on success. */
  isError: boolean;
}

/** An artifact grouped across its versions for one conversation. */
export interface Artifact {
  /** A STABLE key for this artifact within the conversation — the first handle it was grouped
   *  under (its URL, else its file path, else the tool_use id of the publish that opened it).
   *  Never null, unlike `url`/`latestFilePath`, so list keys and memo signatures can rely on it
   *  (a typed creation still in flight has neither of those). */
  id: string;
  /** Hosted URL (see {@link ARTIFACT_URL_RE}). Null only in the brief window between a
   *  publish tool_use and its tool_result landing — and for an artifact whose every publish
   *  FAILED (a failed publish's URL is not an artifact you can open). */
  url: string | null;
  /** Emoji favicon — of the most recent version that set it (last-known-good, so a republish
   *  that omits the favicon keeps the prior one), or null. */
  favicon: string | null;
  /** Gallery subtitle — of the most recent version that set it (last-known-good), or null. */
  description: string | null;
  /** Display title: the most recent non-empty `title` (a typed artifact is NAMED by it at
   *  creation), else the most recent non-empty label, else the file's basename. */
  title: string;
  /** The local file of the most recent publish that sent one, or null (a typed artifact whose
   *  data hasn't been sent yet). An EPHEMERAL temp scratchpad path: it may already be gone, so it
   *  is only ever a best-effort render source, never the artifact's identity (the hosted URL is).
   *  For a typed artifact it is a DATA file — never rendered as a page. */
  latestFilePath: string | null;
  /** True when this is a TYPED artifact (Claude Design…): its page is the type's, hosted on
   *  claude.ai, so it is only ever shown hosted. See {@link PublishInfo.typed}. */
  typed: boolean;
  /** True when any publish sent sibling `files` — the local preview can't serve them, so this
   *  artifact is shown hosted too. See {@link PublishInfo.multiFile}. */
  multiFile: boolean;
  /** The Artifact TYPE's URL, when known. */
  typeUrl: string | null;
  /** The type's display name ("Design"…), when a quickstart/list result in this conversation
   *  named it — else null (the UI then says nothing more specific than "Artifact"). */
  typeName: string | null;
  /** Every publish, oldest-first. */
  versions: ArtifactVersion[];
}

const EMPTY_ARTIFACTS: Artifact[] = [];

function stripExt(name: string): string {
  return name.replace(/\.[^./]+$/, "");
}

/**
 * The ONE rule for naming an artifact, used by every surface (chip row, inline card, viewer).
 *
 * ⚠️ A TYPED artifact never falls back to its file's basename: that file is DATA the type
 * dictates the name of (`canvas.json`), so "canvas" is not a name — its description or its type
 * ("Design") says more. A page artifact, on the other hand, IS its file, so the basename is a
 * perfectly good last resort. Anything that needs a name reads `Artifact.title`; no surface keeps
 * a second chain of its own (they drifted apart once already).
 */
function artifactTitle(
  title: string | null,
  latestLabel: string | null,
  filePath: string | null,
  opts: { typed: boolean; typeName: string | null },
): string {
  if (title && title.trim()) return title.trim();
  if (latestLabel && latestLabel.trim()) return latestLabel.trim();
  // ⚠️ NOT the description: surfaces that show both (the chip row is title + description) would
  // print the same sentence twice. The description's place is {@link artifactHeadline}, for a
  // surface that shows ONE line.
  if (opts.typed) return opts.typeName?.trim() || "Artifact";
  const base = filePath ? basename(filePath) : "";
  const stem = base ? stripExt(base) : "";
  return stem || "Artifact";
}

/** The ONE line to show where only one fits (the inline card): the artifact's own words first —
 *  its description is what Claude wrote FOR the reader — then its {@link artifactTitle}. */
export function artifactHeadline(title: string, description: string | null | undefined): string {
  return description?.trim() || title || "Artifact";
}

/** A type listing line from a quickstart / `list scope:"types"` result:
 *  `- Design [core] — Design canvas for … — type_url: https://claude.ai/artifact/<id>`. The name is
 *  what precedes the first bracket/dash; the rest of the wording is free to drift. */
const TYPE_LISTING_RE = new RegExp(
  String.raw`^[ \t]*[-*][ \t]+([^\n[—–]+?)[ \t]*(?:\[[^\]\n]*\][ \t]*)?(?:[—–]|-[ \t])[^\n]*?[Tt]ype_[Uu]rl:?[ \t]*(${ARTIFACT_URL_RE.source})`,
  "gm",
);

/** Pure: every `type_url → name` a result's text lists. */
export function typeNamesFromResult(content: JsonValue | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const text = resultText(content);
  if (!text || !text.includes("type_url")) return out;
  for (const m of text.matchAll(TYPE_LISTING_RE)) {
    const name = m[1].trim();
    if (name && !out.has(m[2])) out.set(m[2], name);
  }
  return out;
}

/**
 * Pure: walk a session's timeline and group every `Artifact` publish into one {@link Artifact}
 * per hosted artifact, oldest→newest.
 *
 * Design choices, grounded in the verified wire contract:
 *  - MAIN-THREAD ONLY (`parentToolUseId === null`): a sub-agent's Artifact tool_use is replayed
 *    live but SKIPPED on reload (history.rs skip_sidechain), so scoping to the main thread keeps
 *    the list identical live and after a resume.
 *  - GROUP BY IDENTITY, from whichever handle a publish carries: its `file_path` (republishing
 *    the same path keeps the URL — and it is known at tool_use time, before any result), its
 *    input `url` (an in-place update), and the URL its result names. A publish joins the artifact
 *    ANY of its handles already points at. This is what ties a typed artifact together: its
 *    creation carries no file at all (only `type_url`; the URL arrives in the result) and the
 *    later fill targets it by `url` with a data `file_path` — grouped by file_path alone, the
 *    creation vanished and the fill became a nameless "canvas". Labels repeat across different
 *    files, so they are never a key.
 *  - Anything but a real publish ({@link isArtifactPublish}: list/read/quickstart, an asset
 *    upload) is skipped. (The inline card path uses the same predicate in `groupBlocks`.)
 *  - An artifact whose EVERY publish terminally FAILED (all versions `is_error`, no URL) is dropped
 *    from this list: it is not an openable artifact, so it must not inflate the "Artifacts (N)" chip
 *    nor sit there mislabelled as "not published yet". The failure is still surfaced in the thread
 *    by <ArtifactCard> (which reads `is_error` and shows the reason). A still-pending publish (no
 *    result yet → not `is_error`) is kept.
 */
export function selectArtifacts(entry: SessionEntry | undefined): Artifact[] {
  if (!entry) return EMPTY_ARTIFACTS;
  const byKey = new Map<string, Artifact>();
  const order: Artifact[] = [];
  const titles = new Map<Artifact, string>();
  const typeNames = new Map<string, string>();
  for (const t of entry.timeline) {
    if (t.kind !== "turn") continue;
    const turn = entry.turns[t.id];
    if (!turn || turn.role !== "assistant" || turn.parentToolUseId !== null) continue;
    for (const b of turn.blocks) {
      if (b.type !== "tool_use" || b.name !== "Artifact") continue;
      const result = entry.toolResults[b.id];
      // Type names come from ANY Artifact result (a quickstart / type listing is not a publish).
      for (const [u, n] of typeNamesFromResult(result?.content)) if (!typeNames.has(u)) typeNames.set(u, n);
      if (!isArtifactPublish(b.input)) continue;
      const filePath = field(b.input, "file_path") ?? null;
      const label = field(b.input, "label") ?? null;
      const title = field(b.input, "title")?.trim() || null;
      const description = field(b.input, "description") ?? null;
      const favicon = field(b.input, "favicon") ?? null;
      const info = publishInfo(b.input, result?.content);
      const isError = !!result?.isError;
      // A failed publish's URL is NOT this artifact's identity: the tool refuses, for instance, a
      // publish to an artifact this conversation never read, and its input url would otherwise
      // mint an "openable" artifact the conversation never published.
      const url = isError ? null : info.url;
      const urlKey = url ? `u:${url}` : null;
      const fileKey = filePath ? `f:${filePath}` : null;
      // ⚠️ IDENTITY IS THE URL, and the file path only a provisional stand-in for it. A URL
      // names one hosted artifact; a file path is just where the bytes came from, and Claude
      // reuses one (a type dictates `project/canvas.json`) across DIFFERENT artifacts. Letting
      // the file key win merged two artifacts and overwrote the first one's URL, so its design
      // became unreachable from the app. So: match on the URL first, and when the file key
      // points at an artifact that is already a DIFFERENT published one, don't join it —
      // re-point the file key at this publish's artifact instead.
      // RESIDUAL, accepted: a publish with NO url at all (not even in its input) can only be
      // matched by its file, so it joins whatever last held that path. That is exactly right for
      // a page artifact (republishing its file IS how you update it), and a typed fill always
      // carries its `url` — the tool requires it to target an artifact.
      const byUrl = urlKey ? byKey.get(urlKey) : undefined;
      const byFile = fileKey ? byKey.get(fileKey) : undefined;
      let art = byUrl;
      if (!art && byFile && (!url || !byFile.url || byFile.url === url)) art = byFile;
      if (!art) {
        art = {
          // The first handle this artifact was seen under — stable for the rest of the run.
          id: urlKey ?? fileKey ?? `t:${b.id}`,
          url: null,
          favicon: null,
          description: null,
          multiFile: false,
          title: "",
          latestFilePath: null,
          typed: false,
          typeUrl: null,
          typeName: null,
          versions: [],
        };
        order.push(art);
      }
      if (urlKey) byKey.set(urlKey, art);
      if (fileKey) byKey.set(fileKey, art);
      art.versions.push({ label, toolUseId: b.id, filePath, description, favicon, isError });
      // Header fields = LAST-KNOWN-GOOD (timeline order = oldest→newest): keep the last non-null we
      // see, so a republish that omits a field doesn't blank the header. Typed is sticky: one typed
      // publish makes the whole artifact typed (its page is the type's, whatever a later publish
      // sends).
      if (favicon) art.favicon = favicon;
      if (description) art.description = description;
      // A URL, once known, is the artifact's identity and never changes (republishing keeps it).
      // A DIFFERENT one means a different artifact, so it must not overwrite this one's.
      if (url && !art.url) art.url = url;
      if (filePath) art.latestFilePath = filePath;
      if (info.typed) art.typed = true;
      if (info.multiFile) art.multiFile = true;
      if (info.typeUrl) art.typeUrl = info.typeUrl;
      if (title) titles.set(art, title);
    }
  }
  if (order.length === 0) return EMPTY_ARTIFACTS;
  const out = order
    // Drop artifacts whose every publish terminally failed (no URL + all versions errored). A
    // pending version (no result yet) is NOT errored, so a still-publishing artifact survives.
    .filter((a) => a.url || !a.versions.every((v) => v.isError));
  if (out.length === 0) return EMPTY_ARTIFACTS;
  return out.map((a) => {
    // Title = last-known-good title, else label (consistent with favicon/description), else the
    // typed/page fallback — see artifactTitle, the single naming rule.
    let lastLabel: string | null = null;
    for (const v of a.versions) if (v.label && v.label.trim()) lastLabel = v.label;
    a.typeName = a.typeUrl ? typeNames.get(a.typeUrl) ?? null : null;
    a.title = artifactTitle(titles.get(a) ?? null, lastLabel, a.latestFilePath, {
      typed: a.typed,
      typeName: a.typeName,
    });
    return a;
  });
}

/** A cheap content signature — lets {@link memoizedArtifacts} return the SAME array reference
 *  when the derived list is unchanged, so a tool_result for an unrelated tool (frequent) never
 *  re-renders the chip. */
function artifactsSig(list: Artifact[]): string {
  return list
    .map(
      (a) =>
        `${a.id}#${a.url ?? ""}#${a.versions.length}#${a.favicon ?? ""}#${a.title}` +
        `#${a.latestFilePath ?? ""}#${a.typed ? 1 : 0}#${a.typeName ?? ""}`,
    )
    .join("|");
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
