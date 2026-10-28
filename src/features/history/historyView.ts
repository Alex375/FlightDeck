// Pure view logic for the conversation-history panel: time-window + repo filtering,
// repo grouping, applying a search ranking, and merging what this Mac and each paired
// server list. Kept side-effect-free so the panel stays dumb and these rules are
// unit-tested in isolation (historyView.test.ts).
//
// A row is the pair (machine, session): a server's transcripts are listed next to this
// Mac's, and a folder is the pair (machine, path) — the same path on this Mac and on a
// server (or on two servers) is two folders, never one. Every key below says so.
import type { DiskConversation, FileReadError, SearchHit, ServerConversations } from "../../ipc/client";
import { fileReadErrorText } from "../conversation/remoteRead";

/** Coarse recency buckets the period filter offers (predefined, not a date picker). */
export type Period = "all" | "today" | "7d" | "30d";

const DAY_MS = 86_400_000;

/** The identity of a History row (or a search hit): its machine (`null` = this Mac) and its
 *  session. Two rows of one session id on two machines are two conversations. */
export function rowKey(c: { session_id: string; machine_id?: string | null }): string {
  return `${c.machine_id ?? ""}\u0000${c.session_id}`;
}

/** The folder a row groups under: (machine, repo root). */
export function repoKey(c: { repo_root: string; machine_id?: string | null }): string {
  return `${c.machine_id ?? ""}\u0000${c.repo_root}`;
}

/** The oldest mtime (Unix ms) a conversation may have to pass `period`, given `now`.
 *  `all` → 0 (everything passes). `today` is the last 24h (a rolling window, not the
 *  calendar day — good enough and simpler). */
export function periodCutoff(period: Period, now: number): number {
  switch (period) {
    case "today":
      return now - DAY_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "all":
    default:
      return 0;
  }
}

/** This Mac's rows and each server's, as one most-recent-first list (each listing is already
 *  ordered; they interleave by time). */
export function mergeListings(local: DiskConversation[], servers: DiskConversation[][]): DiskConversation[] {
  return [local, ...servers].flat().sort((a, b) => b.mtime_ms - a.mtime_ms);
}

/** Keep only conversations matching the active folder ({@link repoKey}) and the recency
 *  window. Input order (most-recent-first) is preserved. */
export function filterConversations(
  convs: DiskConversation[],
  opts: { repoKey: string | null; period: Period; now: number },
): DiskConversation[] {
  const cutoff = periodCutoff(opts.period, opts.now);
  return convs.filter(
    (c) => (opts.repoKey === null || repoKey(c) === opts.repoKey) && c.mtime_ms >= cutoff,
  );
}

export interface HistoryRepoGroup {
  /** {@link repoKey} of the group. */
  key: string;
  repoRoot: string;
  /** The server the folder lives on, `null` = this Mac. */
  machineId: string | null;
  conversations: DiskConversation[];
}

/** Group conversations under their folder (machine, repo root). Within a group, the most
 *  recent comes first; groups are ordered by their most recent conversation. Assumes the
 *  input is already most-recent-first (so the first seen per folder is its newest). */
export function groupByRepoRoot(convs: DiskConversation[]): HistoryRepoGroup[] {
  const byKey = new Map<string, HistoryRepoGroup>();
  for (const c of convs) {
    const key = repoKey(c);
    let g = byKey.get(key);
    if (!g) {
      g = { key, repoRoot: c.repo_root, machineId: c.machine_id ?? null, conversations: [] };
      byKey.set(key, g);
    }
    g.conversations.push(c);
  }
  return [...byKey.values()].sort(
    (a, b) => (b.conversations[0]?.mtime_ms ?? 0) - (a.conversations[0]?.mtime_ms ?? 0),
  );
}

export interface RankedRow {
  conv: DiskConversation;
  /** Snippet from the search hit (context around the match), empty when none. */
  snippet: string;
}

/** Order conversations by their search hit (best score first, recency tiebreak) and
 *  attach each hit's snippet, dropping conversations the search didn't match. A hit joins
 *  the row of ITS machine. Used when a query is active (the grouped/recency view is replaced
 *  by this flat ranking). */
export function applySearch(convs: DiskConversation[], hits: SearchHit[]): RankedRow[] {
  const byKey = new Map(convs.map((c) => [rowKey(c), c]));
  const score = new Map(hits.map((h) => [rowKey(h), h]));
  return hits
    .map((h) => {
      const conv = byKey.get(rowKey(h));
      return conv ? { conv, snippet: h.snippet } : null;
    })
    .filter((r): r is RankedRow => r !== null)
    .sort((a, b) => {
      const sa = score.get(rowKey(a.conv))!;
      const sb = score.get(rowKey(b.conv))!;
      return sb.score - sa.score || b.conv.mtime_ms - a.conv.mtime_ms;
    });
}

/** Where one paired server's listing stands in the panel. */
export type ServerListing =
  | { status: "loading" }
  | {
      status: "ok";
      pending: number;
      unreadable: number;
      /** Entries under `projects/` its `find` could not read, and the first thing it said. */
      unlisted?: number;
      unlistedReason?: string | null;
      /** The listing stopped before the end: what was read is listed, some may be missing. */
      interrupted?: FileReadError | null;
    }
  /** Still being read when a caller could not wait (the agents' tools): `cached` = its rows
   *  are those of its last listing this run; `partial` = that listing was itself incomplete. */
  | { status: "late"; cached: boolean; partial?: boolean }
  | { status: "error"; error: FileReadError };

/** The panel's view of a server's answer. */
export function listingOf(res: ServerConversations): ServerListing {
  return {
    status: "ok",
    pending: res.pending,
    unreadable: res.unreadable,
    unlisted: res.unlisted,
    unlistedReason: res.unlisted_reason,
    interrupted: res.interrupted,
  };
}

export interface ServerNotice {
  machineId: string;
  tone: "info" | "error";
  text: string;
}

/** What the panel says about each paired server whose listing is not simply complete: still
 *  loading, out of reach (its conversations are NOT listed — said, never silent), cut short
 *  by its bounds, or holding transcripts it could not read. In the machines' order. */
export function serverNotices(
  machines: ReadonlyArray<{ id: string; label: string }>,
  listings: Record<string, ServerListing | undefined>,
): ServerNotice[] {
  const out: ServerNotice[] = [];
  for (const m of machines) {
    const l = listings[m.id];
    const name = m.label.trim() || "A server";
    if (!l) continue;
    if (l.status === "loading") {
      out.push({ machineId: m.id, tone: "info", text: `Reading the conversations on ${name}…` });
    } else if (l.status === "late") {
      out.push({
        machineId: m.id,
        tone: "info",
        text: !l.cached
          ? `Still reading ${name}: its conversations are not listed yet — ask again in a moment.`
          : l.partial
            ? `Still reading ${name}: its conversations are listed as of its last reading, which did not read them all.`
            : `Still reading ${name}: its conversations are listed as of its last reading.`,
      });
    } else if (l.status === "error") {
      const text =
        l.error.kind === "unreachable"
          ? `${name} unreachable: its conversations are not listed (${l.error.reason}).`
          : `${name}'s conversations are not listed: ${fileReadErrorText(l.error)}.`;
      out.push({ machineId: m.id, tone: "error", text });
    } else {
      if (l.interrupted) {
        out.push({
          machineId: m.id,
          tone: "error",
          text: `${name}'s listing stopped before the end (${fileReadErrorText(l.interrupted)}): some of its conversations may be missing.`,
        });
      }
      if (l.unlisted && l.unlisted > 0) {
        const why = l.unlistedReason ? ` (${l.unlistedReason})` : "";
        out.push({
          machineId: m.id,
          tone: "error",
          text: `${l.unlisted} folder(s) of transcripts on ${name} could not be read${why}: their conversations are not listed.`,
        });
      }
      if (l.pending > 0) {
        out.push({
          machineId: m.id,
          tone: "info",
          text: `${l.pending} conversation(s) on ${name} not read yet — reopen History to read them.`,
        });
      }
      if (l.unreadable > 0) {
        out.push({
          machineId: m.id,
          tone: "error",
          text: `${l.unreadable} transcript(s) on ${name} could not be read (permission or I/O): not listed.`,
        });
      }
    }
  }
  return out;
}

/** Relative "time ago" for a Unix-ms timestamp (compact list label). */
export function timeAgo(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.floor(mo / 12)} yr ago`;
}
