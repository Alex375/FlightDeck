// A few-word summary of the user's LAST message, per conversation — shown on the Flight
// Deck so the fleet's last asks ("what did I tell each agent to do") are legible at a
// glance. Twin of the auto-title (`conversationsStore`): same `generate_session_title`
// wire, Haiku inside the binary, hidden from the Opus context (`persist:false`, no
// transcript). Distinct routing: the title names the whole conversation; this
// summarizes ONLY the latest message, and regenerates on EVERY user send.
//
// The DISPLAYED last-message line is live-only, in memory (like `remoteControl` / the
// background bars): it simply (re)appears on the next send. Keyed by the STABLE
// conversation id.
//
// Every summary the binary generates is ALSO kept in a per-message cache persisted to
// localStorage (`tosse:msgsummaries`, keyed by a hash of the message text). Not for the
// line above — for the message minimap, which labels every past message and would
// otherwise show a bare truncation for all but the newest one after a reload. We cache
// what we generate; we never generate to fill the cache (no backfill on open — that would
// be a burst of Haiku calls per conversation, exactly the cost the discipline below
// avoids). Messages themselves stay unpersisted (they live in Claude's transcripts).
// Two-stage value: an INSTANT optimistic truncation of the message (0 tokens, works even
// with no live session / before the Haiku returns), REPLACED by the ≤6-word Haiku
// summary when it arrives. A `seq` per message drops a stale (superseded) Haiku response.
//
// Cost discipline (see the brainstorm): the Haiku call fires ONLY when it earns its keep
// — a short single-line message or a slash command is already its own summary, so we
// skip generation and keep just the truncation.

import { create } from "zustand";
import { commands } from "../ipc/client";

/** Max characters for the optimistic truncation shown before/without a Haiku summary. */
const PREVIEW_MAX = 46;

/** localStorage key for the per-message summary cache (see {@link cacheSummary}). */
const CACHE_KEY = "tosse:msgsummaries";

/** Max cached summaries kept per conversation. Oldest-first eviction (FIFO): a long
 *  conversation keeps its recent asks legible and stops growing. */
const CACHE_MAX_PER_CONV = 200;

/**
 * The instant, zero-token preview of a message: first line, whitespace-collapsed,
 * truncated. Mirrors `conversationsStore.deriveName`. This is what shows immediately on
 * send and the permanent fallback if generation is skipped or fails.
 */
export function summaryPreview(text: string, max: number = PREVIEW_MAX): string {
  const firstLine = text.split("\n", 1)[0];
  const t = firstLine.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Clean a model-generated summary: trim, collapse whitespace, strip wrapping quotes the
 * small model sometimes adds despite the hint. Deliberately NOT length-capped: the Haiku
 * is already constrained to ≤6 words, and the card wraps a slightly long summary onto a
 * 2nd line rather than ellipsize it (truncating the summary itself is what we're avoiding
 * — a "…" on the last ask reads as broken). The 2-line clamp in CSS is the only safety net.
 */
export function cleanSummary(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  // The model occasionally echoes the summary in quotes despite "no quotes" — peel one
  // symmetric layer.
  if (t.length >= 2 && /^["'“”«»]/.test(t) && /["'“”«»]$/.test(t)) t = t.slice(1, -1).trim();
  return t;
}

/**
 * Whether a message is trivial enough that the truncation IS the summary — so we skip
 * the Haiku call. True for a slash command (show the command as typed) or a short,
 * single-line message that the preview already shows in full. Only genuinely long /
 * multi-line messages, where compression adds value, are worth a generation.
 */
export function isTrivialToSummarize(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("/")) return true; // a slash command — its name is the summary
  const multiLine = /\n/.test(t);
  return !multiLine && t.length <= PREVIEW_MAX;
}

/**
 * Cache key for one message: a short hash of its text. Keyed by TEXT rather than by
 * position, so a summary survives anything that renumbers the conversation (rewind,
 * fork, a reload that re-reads the transcript) — the same pattern the thread uses for
 * frozen thinking durations.
 *
 * FNV-1a, 32-bit. A collision would show a neighbouring message's summary in a hover
 * preview — display-only, self-correcting on the next generation — which is why 32 bits
 * is enough here (~5e-6 odds at the 200-entry cap) and worth the ~8× storage saving over
 * keying by the message text itself.
 *
 * The `h` prefix matters: an all-digit key would be an "array index" to JS objects and
 * get reordered ahead of the others, silently breaking the insertion-order FIFO below.
 */
export function summaryKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "h" + (h >>> 0).toString(16).padStart(8, "0");
}

type SummaryCache = Record<string, Record<string, string>>;

function loadCache(): SummaryCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // Storage is user-writable and survives version changes: accept only the shape we
    // wrote, so a corrupted blob degrades to "no cached summaries" (truncations) instead
    // of throwing inside a render.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SummaryCache = {};
    for (const [convId, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
      const kept: Record<string, string> = {};
      for (const [key, value] of Object.entries(entries as Record<string, unknown>))
        if (typeof value === "string") kept[key] = value;
      if (Object.keys(kept).length) out[convId] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

function saveCache(cache: SummaryCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota / disabled storage — best-effort, ignore (summaries fall back to truncations) */
  }
}

/**
 * Add one generated summary to a conversation's cache, evicting oldest-first past the
 * cap. Pure (takes and returns the cache) so the eviction is testable. Re-inserting an
 * existing key refreshes its recency — the message was just sent again, so it is the
 * least interesting one to drop next.
 */
export function cacheSummary(
  cache: SummaryCache,
  convId: string,
  key: string,
  summary: string,
): SummaryCache {
  const prev = cache[convId] ?? {};
  if (prev[key] === summary) return cache; // no-op: keep identity, skip the write
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev)) if (k !== key) next[k] = v;
  next[key] = summary;
  const keys = Object.keys(next);
  if (keys.length > CACHE_MAX_PER_CONV)
    for (const k of keys.slice(0, keys.length - CACHE_MAX_PER_CONV)) delete next[k];
  return { ...cache, [convId]: next };
}

// The seq of each conversation's CURRENT (latest) message. A Haiku summary is applied
// ONLY if its seq still matches — a newer message advances the seq, so any in-flight
// response for a superseded message is dropped. Module-level (non-reactive): it gates
// applies, it isn't rendered.
const currentSeq = new Map<string, number>();

// convId → seq → the message that seq was generated for, so an arriving summary can be
// FILED under its own message. Kept small (only summaries in flight); an entry is dropped
// as soon as it is used or superseded past the window.
const seqText = new Map<string, Map<number, string>>();

/** How many in-flight message texts to remember per conversation. Generation is one call
 *  per send and answers arrive in seconds, so a handful covers any realistic overlap. */
const SEQ_WINDOW = 8;

function rememberSeqText(convId: string, seq: number, text: string): void {
  let bySeq = seqText.get(convId);
  if (!bySeq) seqText.set(convId, (bySeq = new Map()));
  bySeq.set(seq, text);
  if (bySeq.size > SEQ_WINDOW)
    for (const k of [...bySeq.keys()].slice(0, bySeq.size - SEQ_WINDOW)) bySeq.delete(k);
}

interface LastMessageSummaryStore {
  /** convId → the summary/preview to display. Absent = nothing sent this run. */
  byConv: Record<string, string>;
  /** convId → message key ({@link summaryKey}) → its generated summary. Persisted, so the
   *  summaries a conversation has already paid for survive a reload — that is what lets
   *  the message minimap label OLD messages instead of only the newest one. */
  cache: SummaryCache;
  /** Apply a Haiku summary if it still matches the conversation's latest message. */
  apply: (convId: string, summary: string, seq: number) => void;
  /** Forget one conversation's summaries (its conversation was deleted). */
  clear: (convId: string) => void;
  /** Forget every conversation's summaries (wipe-all). */
  clearAll: () => void;
}

export const useLastMessageSummaryStore = create<LastMessageSummaryStore>((set) => ({
  byConv: {},
  cache: loadCache(),
  apply: (convId, summary, seq) =>
    set((s) => {
      const cleaned = cleanSummary(summary);
      if (!cleaned) return s;
      // FILE it under the message it was generated for, even when a newer message has
      // since been sent: the summary is still correct for THAT message, and the minimap
      // shows every message, not just the latest. (The seq gate below is about which one
      // is DISPLAYED as "last message", a different question.)
      const text = seqText.get(convId)?.get(seq);
      let cache = s.cache;
      if (text != null) {
        seqText.get(convId)?.delete(seq);
        cache = cacheSummary(cache, convId, summaryKey(text), cleaned);
        if (cache !== s.cache) saveCache(cache);
      }
      // Drop a stale response for the DISPLAYED last-message line: only the seq of the
      // conversation's latest message wins.
      if (seq !== currentSeq.get(convId) || s.byConv[convId] === cleaned)
        return cache === s.cache ? s : { ...s, cache };
      return { ...s, cache, byConv: { ...s.byConv, [convId]: cleaned } };
    }),
  clear: (convId) =>
    set((s) => {
      currentSeq.delete(convId);
      seqText.delete(convId);
      // The cached summaries go too — the conversation is gone. (An undone delete does
      // not restore them; they simply regenerate on the next send, and until then the
      // hover previews fall back to truncations.)
      const hadCache = convId in s.cache;
      let cache = s.cache;
      if (hadCache) {
        cache = { ...s.cache };
        delete cache[convId];
        saveCache(cache);
      }
      if (!(convId in s.byConv)) return hadCache ? { ...s, cache } : s;
      const next = { ...s.byConv };
      delete next[convId];
      return { ...s, cache, byConv: next };
    }),
  clearAll: () => {
    currentSeq.clear();
    seqText.clear();
    saveCache({});
    set({ byConv: {}, cache: {} });
  },
}));

/**
 * On a user send: show the instant truncation immediately, and — unless the message is
 * trivial or there's no live session — ask the binary for a ≤6-word Haiku summary that
 * replaces it. Fire-and-forget: the summary returns via `SessionSummaryEvent` → `apply`.
 * A failure is non-fatal (the truncation stays) — logged, never surfaced.
 *
 * @param handle the LIVE session handle (from `ensureConversationSession`), or null/undefined
 *               if the send couldn't spawn — then only the truncation shows.
 */
export function triggerLastMessageSummary(
  convId: string,
  handle: string | null | undefined,
  text: string,
): void {
  const seq = (currentSeq.get(convId) ?? 0) + 1;
  currentSeq.set(convId, seq);
  // Remember which message this seq is for, so the answer can be cached under it.
  rememberSeqText(convId, seq, text);

  // Optimistic truncation — instant, zero-token, and the fallback if generation is
  // skipped or fails. NOT seq-gated: a newer message always supersedes.
  const preview = summaryPreview(text);
  useLastMessageSummaryStore.setState((s) =>
    s.byConv[convId] === preview ? s : { byConv: { ...s.byConv, [convId]: preview } },
  );

  // Skip the Haiku call when the truncation already IS the summary, or nothing's live.
  if (!handle || isTrivialToSummarize(text)) return;

  void commands
    .generateMessageSummary(handle, text, seq)
    .then((res) => {
      if (res.status === "error")
        console.error("[lastMsgSummary] generateMessageSummary failed:", res.error);
    })
    .catch((e) => console.error("[lastMsgSummary] generateMessageSummary threw:", e));
}

/** Reactive last-message summary for one conversation (`undefined` until a send). */
export function useLastMessageSummary(convId: string): string | undefined {
  return useLastMessageSummaryStore((s) => s.byConv[convId]);
}

/** Empty map shared by every conversation with no cached summary — a fresh `{}` per call
 *  would be a new reference on each render and defeat the store's re-render bail-out. */
const NO_SUMMARIES: Record<string, string> = {};

/**
 * Reactive map of a conversation's cached summaries, keyed by {@link summaryKey}. Used by
 * the message minimap to label EVERY past message, not just the newest — a message with
 * no cached summary (short, a slash command, or sent before this feature existed) simply
 * falls back to a truncation — see `resolveMessageLabel` in `MessageMinimap`.
 */
export function useMessageSummaries(convId: string): Record<string, string> {
  return useLastMessageSummaryStore((s) => s.cache[convId] ?? NO_SUMMARIES);
}
