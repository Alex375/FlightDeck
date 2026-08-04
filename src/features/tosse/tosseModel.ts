// Pure shaping for the TOSSE tasks view: how the briefing's flat project list becomes
// client bands, and how a project's tasks become status sections.
//
// Kept out of the component so the ordering rules — the part that has to stay stable while
// rows move under optimistic writes — is unit-testable without a DOM.

import type { TosseBriefing, TosseProject, TosseTask } from "../../ipc/client";

/**
 * The statuses that make a task LEAVE the briefing.
 *
 * Mirrors the server's own filter (`briefing.service.ts`:
 * `status: { notIn: ['Archivé', 'Fait', 'Backlog', 'En attente'] }`). THREE of the six
 * statuses the menu offers are in here, not just `Fait`.
 */
export const STATUSES_OFF_THE_BOARD = new Set([
  "Fait",
  "Backlog",
  "En attente",
  "Archivé",
]);

/**
 * The board as it looks the instant a task is moved to `status` — the optimistic patch.
 *
 * Covers `generalTasks` as well as the projects, because the project-less band is rendered
 * too: patching only `projects` meant a status change on one of those rows moved nothing,
 * and — the real damage — a REFUSED write had nothing to roll back, so failure and success
 * produced the identical screen.
 *
 * A task whose new status is off the board is removed rather than moved: the briefing does
 * not carry those, so keeping the row would show something the next refetch deletes on its
 * own, which reads as a glitch instead of as the move that was asked for.
 */
export function applyStatusToBoard(
  briefing: TosseBriefing,
  taskId: string,
  status: string,
): TosseBriefing {
  const patch = (tasks: TosseTask[]): TosseTask[] =>
    STATUSES_OFF_THE_BOARD.has(status)
      ? tasks.filter((t) => t.id !== taskId)
      : tasks.map((t) => (t.id === taskId ? { ...t, status } : t));
  return {
    ...briefing,
    projects: briefing.projects.map((p) => ({ ...p, tasks: patch(p.tasks) })),
    generalTasks: patch(briefing.generalTasks),
  };
}

/**
 * The status sections a project card shows, in order.
 *
 * This is the CRM Briefing page's order (running first), NOT the alphabetical or lifecycle
 * order: what is being worked on outranks what is waiting to be read, which outranks what
 * hasn't started. `Backlog`/`En attente`/`Fait` are absent from the briefing payload
 * altogether, so they only appear here if the endpoint ever starts sending them.
 */
export const STATUS_ORDER = ["En cours", "Review", "À faire", "En attente", "Backlog"] as const;

/**
 * Semantic tone per status.
 *
 * ⚠️ These tones are painted with the CRM's OWN colours in this view — blue for « En cours »,
 * amber for « En revue » — and NOT with Flight Deck's language (where green means running
 * and blue means waiting for you). Alexandre reversed the 2026-08-01 decision on
 * 2026-08-04, having been told the two views would then disagree: this screen is the CRM's
 * board, and the point is that it reads like the CRM.
 *
 * The colours live in `TosseView.module.css` as `--ts-*` variables scoped to `.page`, so the
 * Flight Deck's own dots and rails are untouched.
 */
export const STATUS_TONE: Record<string, "run" | "wait" | "todo" | "hold" | "done"> = {
  "En cours": "run",
  Review: "wait",
  "À faire": "todo",
  "En attente": "hold",
  Backlog: "todo",
  Fait: "done",
};

/**
 * What a status section is CALLED on a project card.
 *
 * The CRM's Briefing renames exactly one: « Review » reads « En revue » as a section
 * heading, while the status VALUE stays « Review » everywhere it is written or picked
 * (the status menu, the detail chip). We carry both, as it does.
 */
export const SECTION_LABELS: Record<string, string> = { Review: "En revue" };

export function sectionLabel(status: string): string {
  return SECTION_LABELS[status] ?? status;
}

/** The icon a status section wears, mirroring the CRM Briefing (Play / Eye / ListTodo /
 *  CircleDot). Unknown statuses fall back to the list glyph rather than going bare. */
export const SECTION_ICONS: Record<string, string> = {
  "En cours": "play",
  Review: "eye",
  "À faire": "list",
  "En attente": "circledot",
  Backlog: "list",
};

export function sectionIcon(status: string): string {
  return SECTION_ICONS[status] ?? "list";
}

/** Priority ordering inside a section. Unknown/absent priorities sit with "Moyenne" rather
 *  than at either end — an unlabelled task is ordinary, not urgent and not last. */
const PRIORITY_RANK: Record<string, number> = {
  Urgente: 0,
  Haute: 1,
  Moyenne: 2,
  Basse: 3,
};

export function priorityRank(priority: string | null): number {
  if (!priority) return 2;
  return PRIORITY_RANK[priority] ?? 2;
}

export interface StatusSection {
  status: string;
  tasks: TosseTask[];
}

/**
 * A project's tasks, grouped into the sections the card renders.
 *
 * Empty sections are dropped (a card shows what it has, not a fixed skeleton), and any
 * status the briefing sends that we don't know about is kept in its own trailing section
 * rather than silently discarded — a task that exists must be visible somewhere.
 */
export function statusSections(tasks: TosseTask[]): StatusSection[] {
  const known = new Set<string>(STATUS_ORDER);
  const sections: StatusSection[] = [];
  for (const status of STATUS_ORDER) {
    const inStatus = tasks.filter((t) => t.status === status);
    if (inStatus.length > 0) {
      sections.push({ status, tasks: sortTasks(inStatus) });
    }
  }
  const rest = tasks.filter((t) => !known.has(t.status));
  for (const status of dedupe(rest.map((t) => t.status))) {
    sections.push({ status, tasks: sortTasks(rest.filter((t) => t.status === status)) });
  }
  return sections;
}

/** Priority first, then title — a total order, so a re-render after an optimistic write
 *  can't shuffle equal-priority rows around. */
function sortTasks(tasks: TosseTask[]): TosseTask[] {
  return [...tasks].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title),
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Counts per status across a set of projects — what a folded client band still reports. */
export function statusCounts(projects: TosseProject[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of projects) {
    for (const t of p.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * The toolbar's headline counts — EVERY open task the view shows, project-less ones
 * included.
 *
 * Counted from the same two lists the body renders (`projects[].tasks` + `generalTasks`),
 * because a total that silently omits a band is worse than no total: the header said
 * "5 À faire" while six rows sat below it, and nothing on screen explained the difference.
 * Pure, so the arithmetic is unit-tested rather than eyeballed.
 */
export function briefingTotals(
  projects: TosseProject[],
  generalTasks: TosseTask[] = [],
): Record<string, number> {
  const counts = statusCounts(projects);
  for (const t of generalTasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
}

export interface ClientBand {
  /** Stable key — the client's id, or `"none"` for the projects that have no client. */
  key: string;
  name: string;
  logoUrl: string | null;
  /** Carried for its domain — the mark falls back to the site's favicon (see ClientAvatar). */
  website: string | null;
  /** Active projects first, paused ones last (they carry no tasks). */
  projects: TosseProject[];
  openTasks: number;
  counts: Record<string, number>;
}

/**
 * Group projects into client bands.
 *
 * Bands keep the order in which their first project appears in the briefing (the endpoint
 * builds it from the most recently created tasks), so the band you last worked in tends to
 * stay near the top without any client-level ranking of our own. Projects with NO client —
 * the CRM reaches a client through a mission, and either link can be missing — get a
 * trailing band instead of being dropped.
 */
export function groupByClient(projects: TosseProject[], paused: TosseProject[] = []): ClientBand[] {
  const bands = new Map<string, ClientBand>();
  const push = (p: TosseProject) => {
    const key = p.client?.id ?? "none";
    let band = bands.get(key);
    if (!band) {
      band = {
        key,
        name: p.client?.name ?? "No client",
        logoUrl: p.client?.logoUrl ?? null,
        website: p.client?.website ?? null,
        projects: [],
        openTasks: 0,
        counts: {},
      };
      bands.set(key, band);
    }
    band.projects.push(p);
  };
  projects.forEach(push);
  // Paused projects join their client's band at the end: parked, not gone.
  paused.forEach(push);
  for (const band of bands.values()) {
    band.counts = statusCounts(band.projects);
    band.openTasks = Object.values(band.counts).reduce((a, b) => a + b, 0);
  }
  // "No client" last, whatever the order its projects appeared in.
  return [...bands.values()].sort((a, b) => Number(a.key === "none") - Number(b.key === "none"));
}

/** Whether a due date is in the past — the one date styling that has to be loud. `now` is
 *  injected so this stays pure (and testable) rather than reading the clock. */
export function isOverdue(dueDate: string | null, now: number): boolean {
  if (!dueDate) return false;
  const t = Date.parse(dueDate);
  return Number.isFinite(t) && t < now;
}

/** `dd/mm` — the compact form the CRM uses on its own cards. Invalid input renders nothing
 *  rather than "NaN/NaN". */
export function shortDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The status a project's action button moves it to, and how that button reads.
 *
 * One obvious next move per state — the same shape the CRM's task panel uses. `Terminé` is
 * flagged `confirm` because it closes a project: heavier than parking one, and not
 * something a mis-aimed click should do.
 */
export interface ProjectAction {
  label: string;
  next: string;
  confirm?: boolean;
  tone?: "go" | "done";
}

export function projectActions(status: string | null): ProjectAction[] {
  switch (status) {
    case "En cours":
      return [
        { label: "Pause", next: "En pause" },
        { label: "Finish", next: "Terminé", confirm: true, tone: "done" },
      ];
    case "En pause":
      return [{ label: "Resume", next: "En cours", tone: "go" }];
    case "À démarrer":
      return [{ label: "Start", next: "En cours", tone: "go" }];
    // Terminé / Annulé / Archivé — nothing to offer here; reopening a closed project is a
    // CRM-side decision, not a one-click action from a task list.
    default:
      return [];
  }
}

/** Every status a task can be moved to from the view, in menu order. `Fait` is last and
 *  rendered behind a separator: reachable (a human is clicking), never adjacent to the
 *  status right above it by accident. */
export const TASK_STATUS_CHOICES = [
  "Backlog",
  "À faire",
  "En cours",
  "En attente",
  "Review",
  "Fait",
] as const;
