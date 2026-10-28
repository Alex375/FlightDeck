// Pure view of a server's alignment on this Mac (see `store/serverAlign.ts`): what the
// "Sync with this Mac" block of the server panel says. Every part of a pass — even one that
// changed nothing — gets its line, and every failure keeps the backend's own words.
import type { AlignPart, AlignReport, AlignStatus, MachineAlignState } from "../../ipc/client";

export type AlignTone = "ready" | "caution" | "error" | "muted";

export interface AlignLine {
  label: string;
  tone: AlignTone;
  text: string;
}

const TONE: Record<AlignStatus, AlignTone> = {
  current: "ready",
  updated: "ready",
  deferred: "caution",
  skipped: "muted",
  failed: "error",
};

/** `before → after` when the pass moved a version, else the one version known. */
function versions(p: AlignPart): string | null {
  if (p.before && p.after && p.before !== p.after) return `${p.before} → ${p.after}`;
  return p.after ?? p.before ?? null;
}

function partText(p: AlignPart, words: Record<AlignStatus, string>): string {
  const head = [words[p.status], versions(p)].filter(Boolean).join(" · ");
  return p.detail ? `${head} — ${p.detail}` : head;
}

/** One line per part of `report`, in the order the pass runs them. */
export function alignLines(report: AlignReport): AlignLine[] {
  const base: Record<AlignStatus, string> = {
    current: "In line",
    updated: "Updated",
    deferred: "Waiting",
    skipped: "Not aligned",
    failed: "Failed",
  };
  const parts: { label: string; part: AlignPart; words?: Partial<Record<AlignStatus, string>> }[] = [
    { label: "Claude Code", part: report.claude },
    { label: "Config", part: report.config, words: { updated: "Copied from this Mac" } },
    { label: "Daemon", part: report.daemon },
    {
      label: "Conversations",
      part: report.sessions,
      words: { current: "Nothing to restart", updated: "Moved onto the new setup" },
    },
  ];
  return parts.map(({ label, part, words }) => ({
    label,
    tone: TONE[part.status],
    text: partText(part, { ...base, ...words }),
  }));
}

/** The block's one-line summary. */
export function alignHeadline(state: MachineAlignState | undefined): { tone: AlignTone; text: string } {
  if (!state) return { tone: "muted", text: "Loading…" };
  if (state.running) return { tone: "muted", text: "Syncing with this Mac…" };
  const last = state.last;
  // A later attempt that could not start is shown under the last report (see the panel).
  if (state.last_error && !last) return { tone: "error", text: state.last_error };
  if (!last) {
    return state.keep_aligned
      ? { tone: "muted", text: "Not synced in this session yet — it syncs when it is next reached" }
      : { tone: "muted", text: "Automatic sync is off" };
  }
  const statuses = [last.claude, last.daemon, last.config, last.sessions].map((p) => p.status);
  const when = new Date(last.finished_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (statuses.includes("failed")) return { tone: "error", text: `Not fully aligned (checked at ${when})` };
  if (statuses.includes("deferred")) return { tone: "caution", text: `Aligned, a restart is waiting (checked at ${when})` };
  if (statuses.includes("skipped")) return { tone: "caution", text: `Partly aligned (checked at ${when})` };
  return { tone: "ready", text: `In line with this Mac (checked at ${when})` };
}
