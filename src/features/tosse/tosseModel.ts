// Pure shaping for the TOSSE tasks view: how the briefing's flat project list becomes
// client bands, and how a project's tasks become status sections.
//
// Kept out of the component so the ordering rules — the part that has to stay stable while
// rows move under optimistic writes — is unit-testable without a DOM.

import type {
  TosseBriefing,
  TosseOffBoardTask,
  TosseProject,
  TosseTask,
  TosseTaskProject,
} from "../../ipc/client";

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
 * The off-board statuses the view FETCHES for itself, in the order their sections appear.
 *
 * ⚠️ Mirror of `OFF_BOARD_STATUSES` in `src-tauri/src/tosse/mod.rs`, which refuses anything
 * else: asking here for a status the core does not fetch would surface as a raw error about
 * a request the user never made. `Fait` and `Archivé` are deliberately absent — they are off
 * the board too, but they are history, and this screen is about live work.
 */
export const OFF_BOARD_SECTIONS = ["En attente", "Backlog"] as const;

/**
 * The three caches the view reads, as one value — the briefing plus one list per off-board
 * status. `null` means "not fetched / not in cache", which is NOT the same as an empty list
 * and must not be turned into one: writing back an empty array would tell the query cache
 * the answer is "nothing", and the section would go silent instead of loading.
 */
export interface BoardCaches {
  briefing: TosseBriefing | null;
  /** status → its rows, or null when that query holds nothing yet. */
  offBoard: Record<string, TosseOffBoardTask[] | null>;
}

/** The task a row carries, plus where it lives — what a move needs in order to re-file it. */
interface FoundTask {
  task: TosseTask;
  project: TosseTaskProject | null;
}

/**
 * Every cache, the instant a task is moved to `status`.
 *
 * ⚠️ This exists because the sections a task can move BETWEEN are no longer all in one
 * payload. With only the briefing patched, a task sent to « En attente » vanished (the
 * briefing drops it) and did not reappear in the section right below it, while a task
 * pulled OUT of « En attente » vanished the other way — both until a refetch landed. The
 * move looked like a deletion, which is the one reading a status change must never have.
 *
 * The task is looked up across ALL caches first, so a row can be moved from wherever it is
 * displayed; then removed everywhere; then filed into its destination:
 *   - an off-board status we fetch → that list, carrying its project so the card survives;
 *   - a board status → the briefing, under its project (fabricating that project's entry
 *     when the briefing has never carried it — see {@link offBoardProjectCards}, which is
 *     what put the row on screen in the first place);
 *   - `Fait` / `Archivé` → nowhere. They leave the screen, which is what closing a task
 *     means here.
 *
 * Returns the caches unchanged when the task is nowhere to be found: patching by id alone
 * would silently create a half-filled row out of a task we never had.
 */
export function routeTaskStatus(
  caches: BoardCaches,
  taskId: string,
  status: string,
): BoardCaches {
  const found = findTask(caches, taskId);
  if (!found) return caches;
  // ⚠️ Decided BEFORE anything is removed. A task coming back onto the board needs the briefing
  // to land in, and it is legitimately absent from cache (a failed or evicted briefing next to
  // an off-board list that fetched fine — `readBoardCaches` hands back exactly that). Stripping
  // it from its off-board list anyway and then finding nowhere to put it made the row vanish
  // from the screen until the refetch landed: the "looks like a deletion" reading this function
  // exists to prevent. Nothing patched at all is the honest answer.
  if (!STATUSES_OFF_THE_BOARD.has(status) && !caches.briefing) return caches;

  const moved: TosseTask = { ...found.task, status };
  const briefing = caches.briefing
    ? stripTaskFromBriefing(caches.briefing, taskId)
    : null;
  const offBoard: Record<string, TosseOffBoardTask[] | null> = {};
  for (const [key, rows] of Object.entries(caches.offBoard)) {
    offBoard[key] = rows ? rows.filter((r) => r.task.id !== taskId) : rows;
  }

  // Destination 1 — another off-board list. Only one we actually hold: a status whose query
  // has never run has nothing to patch, and the section will fetch it when it mounts.
  if (status in offBoard) {
    const rows = offBoard[status];
    if (rows) offBoard[status] = [...rows, { project: found.project, task: moved }];
    return { briefing, offBoard };
  }

  // Destination 2 — back onto the board. `briefing` is non-null here: the guard at the top
  // returned early otherwise, rather than letting the row fall through to "gone on purpose".
  if (!STATUSES_OFF_THE_BOARD.has(status) && briefing) {
    return { briefing: insertIntoBriefing(briefing, moved, found.project), offBoard };
  }

  // Destination 3 — `Fait` / `Archivé`: gone from every list, on purpose.
  return { briefing, offBoard };
}

function findTask(caches: BoardCaches, taskId: string): FoundTask | null {
  for (const rows of Object.values(caches.offBoard)) {
    const row = rows?.find((r) => r.task.id === taskId);
    if (row) return { task: row.task, project: row.project };
  }
  const b = caches.briefing;
  if (!b) return null;
  for (const project of b.projects) {
    const task = project.tasks.find((t) => t.id === taskId);
    if (task) {
      return {
        task,
        project: {
          id: project.id,
          name: project.name,
          status: project.status,
          client: project.client,
        },
      };
    }
  }
  const general = b.generalTasks.find((t) => t.id === taskId);
  return general ? { task: general, project: null } : null;
}

function stripTaskFromBriefing(briefing: TosseBriefing, taskId: string): TosseBriefing {
  return {
    ...briefing,
    projects: briefing.projects.map((p) => ({
      ...p,
      tasks: p.tasks.filter((t) => t.id !== taskId),
    })),
    generalTasks: briefing.generalTasks.filter((t) => t.id !== taskId),
  };
}

/**
 * Put a task back on the board, under its project.
 *
 * A project the briefing has never carried gets an entry built on the spot — the same
 * fabrication {@link offBoardProjectCards} does for display. Without it, pulling the last
 * parked task of such a project onto the board would delete its card (nothing off-board
 * left to build one from) and the task would be nowhere until the refetch landed.
 */
function insertIntoBriefing(
  briefing: TosseBriefing,
  task: TosseTask,
  project: TosseTaskProject | null,
): TosseBriefing {
  if (!project) return { ...briefing, generalTasks: [...briefing.generalTasks, task] };
  let placed = false;
  const projects = briefing.projects.map((p) => {
    if (p.id !== project.id) return p;
    placed = true;
    return { ...p, tasks: [...p.tasks, task] };
  });
  if (placed) return { ...briefing, projects };
  return { ...briefing, projects: [...projects, projectCard(project, [task])] };
}

/** A briefing-shaped project from what a task row knows — no dates, no progress counts,
 *  because the tasks endpoint does not send them (see `TosseTaskProject`). */
function projectCard(project: TosseTaskProject, tasks: TosseTask[]): TosseProject {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    client: project.client,
    startDate: null,
    dueDate: null,
    tasks,
    taskCount: 0,
    taskDone: 0,
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
 * ⚠️ These tones are painted with the CRM's OWN colours — blue « En cours », VIOLET
 * « En revue », YELLOW « En attente » — and NOT with Flight Deck's language (where green
 * means running and blue means waiting for you). Alexandre reversed the 2026-08-01 decision
 * on 2026-08-04, having been told the two views would then disagree: this screen is the
 * CRM's board, and the point is that it reads like the CRM.
 *
 * ⚠️ The two greys are NOT interchangeable. `Backlog` and `À faire` shared one tone, so the
 * only two statuses a card can show side by side looked identical; the CRM separates them
 * (gray-700/200 against gray-800/300) and so do we — `backlog` is the lighter of the pair.
 *
 * The hues live in `src/ui/tosse-status.css` as `--ts-*` variables on `:root`, because the
 * board is not the only surface that paints a task status (the conversation's task chip and
 * the delete dialog do too, and each used to carry its own copy of the hexes). Nothing
 * outside those surfaces consumes them.
 */
export type StatusTone = "run" | "review" | "todo" | "backlog" | "hold" | "done" | "archived";

export const STATUS_TONE: Record<string, StatusTone> = {
  "En cours": "run",
  Review: "review",
  "À faire": "todo",
  "En attente": "hold",
  Backlog: "backlog",
  Fait: "done",
  Archivé: "archived",
};

/**
 * Semantic tone per PROJECT status — a different vocabulary from a task's, painted with the
 * same tokens because the CRM paints both with one badge.
 *
 * ⚠️ Kept beside {@link STATUS_TONE} and NOT merged with it: the two enums share no value
 * except « En cours », and a single map would let a project state silently pick up a task
 * colour (or the reverse) the day either list grows. The CRM's badge does the same — one
 * palette, one lookup table per meaning.
 *
 * `En pause` is the yellow that « En attente » wears (parked, in both languages), `Terminé`
 * the green of `Fait`, `Archivé` the spent grey. `À démarrer` is the CRM's darker neutral,
 * exactly like `À faire`. Anything unknown — `Annulé` today — stays neutral rather than
 * borrowing a meaning.
 */
export const PROJECT_STATUS_TONE: Record<string, StatusTone> = {
  "En cours": "run",
  "En pause": "hold",
  "À démarrer": "todo",
  Terminé: "done",
  Archivé: "archived",
};

/** The tone of a PROJECT status, neutral when absent or unknown. */
export function projectStatusTone(status: string | null): StatusTone {
  if (!status) return "todo";
  return PROJECT_STATUS_TONE[status] ?? "todo";
}

/**
 * The tone of a TASK status, neutral when unknown.
 *
 * ⚠️ Every surface that paints a task status goes through this, not through `STATUS_TONE[…] ??
 * "todo"` written out again: the board, the card sections, the task chip and the delete dialog
 * had nine copies of that fallback between them, one of which feeds a CSS class name. A new CRM
 * status (or a change of what "unknown" should look like) then has to move all nine together,
 * and the one that is missed paints a different colour on a single screen — exactly the split
 * the shared `--ts-*` tokens were introduced to end. The palette was centralised; the LOOKUP is
 * the other half of that.
 */
export function taskStatusTone(status: string | null | undefined): StatusTone {
  if (!status) return "todo";
  return STATUS_TONE[status] ?? "todo";
}

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

/** Off-board rows, in the same order as any other section. Exported because those sections
 *  are rendered on their own, outside `statusSections`. */
export function sortedBacklog(tasks: TosseTask[]): TosseTask[] {
  return sortTasks(tasks);
}

/** The rows of an off-board response that belong to no project at all. */
export function offBoardWithoutProject(rows: TosseOffBoardTask[]): TosseTask[] {
  return rows.filter((r) => !r.project).map((r) => r.task);
}

/**
 * The off-board responses pivoted the way the CARDS consume them: project id → status → its
 * tasks, in display order, empty statuses left out.
 *
 * ⚠️ Pivoted ONCE, in the caller's memo, and read by indexing. It used to be grouped
 * status→project and then re-grouped per card inside the render `.map`, which allocated a
 * fresh object for every project on every render — so a card could never be memoised on it,
 * and the whole board (progress rings, actions, dates) re-rendered on any unrelated state
 * change, down to the toolbar's "Syncing…" flip. Sorting here rather than in the section body
 * is the same argument: it is a function of the data, not of the render.
 */
export function offBoardByScope(
  byStatus: Record<string, TosseOffBoardTask[]>,
): Record<string, Record<string, TosseTask[]>> {
  const out: Record<string, Record<string, TosseTask[]>> = {};
  for (const [status, rows] of Object.entries(byStatus)) {
    for (const row of rows) {
      if (!row.project) continue;
      const scope = (out[row.project.id] ??= {});
      (scope[status] ??= []).push(row.task);
    }
  }
  for (const scope of Object.values(out)) {
    for (const status of Object.keys(scope)) scope[status] = sortTasks(scope[status]);
  }
  return out;
}

/** The empty slice, shared: a card with nothing parked must get the SAME object every render,
 *  or the identity churn this pivot exists to remove comes straight back. */
export const NO_OFF_BOARD: Readonly<Record<string, TosseTask[]>> = Object.freeze({});

/**
 * Cards for the projects that ONLY have off-board work.
 *
 * ⚠️ Load-bearing, not a nicety. The briefing lists a project because it has a live task;
 * a project whose whole queue is parked is therefore absent from it, and its tasks had
 * nowhere to be drawn — 17 « En attente » tasks across 6 projects at the time this was
 * written, several of which existed on no card at all. The row was fetched, grouped by a
 * project id nothing matched, and silently dropped: the count in the toolbar and the rows
 * on screen disagreed, with nothing to explain it.
 *
 * The cards are DEGRADED by construction — no dates, no progress ring, and the client mark
 * falls back to initials — because the tasks endpoint sends none of that (see
 * `TosseTaskProject`). A degraded card that shows the work beats a perfect one that doesn't
 * exist. `paused`/`Terminé` projects can't appear here: the request already asks for active
 * projects only, exactly as the briefing does.
 */
export function offBoardProjectCards(
  briefing: TosseBriefing | null,
  rows: TosseOffBoardTask[][],
): TosseProject[] {
  const known = new Set<string>();
  for (const p of briefing?.projects ?? []) known.add(p.id);
  for (const p of briefing?.pausedProjects ?? []) known.add(p.id);

  const cards = new Map<string, TosseProject>();
  for (const row of rows.flat()) {
    const project = row.project;
    if (!project || known.has(project.id) || cards.has(project.id)) continue;
    cards.set(project.id, projectCard(project, []));
  }
  return [...cards.values()];
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

/**
 * The calendar day a CRM date denotes, as `yyyy-mm-dd`, or null when it isn't a date.
 *
 * ⚠️ The CRM's `dueDate`/`startDate` are date-only values, minted at UTC midnight
 * (`2026-03-07T00:00:00.000Z`) — a DAY, not an instant. Read back with the local-zone
 * getters, that day lands on the 6th at 19:00 in New York, so every deadline rendered one
 * day early for any viewer west of Greenwich — and a day-early date is indistinguishable
 * from a correct one. So the day is read in the zone it was minted in.
 *
 * This is ONLY for those date-only fields. A real timestamp (an activity time, the "Synced
 * at" of the toolbar) is an instant and must keep the local getters — none goes through here.
 */
function crmDay(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** The day the VIEWER is living in, as `yyyy-mm-dd` — the other side of an overdue check. */
function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Whether a due date is in the past — the one date styling that has to be loud. `now` is
 * injected so this stays pure (and testable) rather than reading the clock.
 *
 * Compares CALENDAR DAYS, not instants: the due value is the start of its day in UTC, so an
 * instant comparison called a task late from the very first minute of the day it is due
 * (and, west of Greenwich, from the evening BEFORE). A task is late once the day it was due
 * has passed for the person looking at it. `yyyy-mm-dd` strings order lexicographically.
 */
export function isOverdue(dueDate: string | null, now: number): boolean {
  const due = crmDay(dueDate);
  return due !== null && due < localDay(now);
}

/** `dd/mm` — the compact form the CRM uses on its own cards. Invalid input renders nothing
 *  rather than "NaN/NaN". */
export function shortDate(value: string | null): string | null {
  const day = crmDay(value);
  if (!day) return null;
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
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

/**
 * The one status move a task row offers as a BUTTON, or null when it offers none.
 *
 * Deliberately a single case — `Review` → `Fait` — and not the per-status ladder
 * {@link projectActions} draws for a project. Closing a task you have just reviewed is the
 * move that was worth a click of its own: everything else already has a natural home (the
 * `/pickup` skill starts a task, and the CRM, not this app, is what writes « En cours »),
 * and a button on every row would put three one-click writes to the CRM where the list
 * previously had none.
 *
 * Every other move stays behind the row's status dot, which opens the full menu. This
 * button is a shortcut through that menu, never the only way to reach a status.
 *
 * ⚠️ `Fait` is the one status the dot's menu isolates behind a separator, because it closes
 * the task. A labelled button revealed on hover is a different gesture from a menu entry
 * sitting under the pointer — deliberate, read before it is clicked — so it is NOT given a
 * confirmation step (decided with Alexandre, 2026-08-07). A mis-click is recoverable from
 * the same dot menu, which can put the task back.
 */
export interface TaskQuickAction {
  label: string;
  next: string;
  tone: "done";
}

export function taskQuickAction(status: string): TaskQuickAction | null {
  return status === "Review" ? { label: "Done", next: "Fait", tone: "done" } : null;
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
