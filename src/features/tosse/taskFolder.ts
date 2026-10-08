// Where a TOSSE task's work happens on this machine — the chain task → project →
// CRM repositories → local folder, resolved entirely in the front.
//
// The repo-links payload already carries every piece: each Flight Deck folder with the
// CRM repository it matched, and each repository with the projects it belongs to. So
// this is an INVERSION of data we already fetch, not a new request — and it stays a
// pure function, because "which folder does this task open in" is the one decision
// that must be identical in the task row, the detail panel and the project card.

import type { Repo } from "../../store/conversationsStore";
import type { TosseProjectRepo, TosseRepoLinksPayload } from "../../ipc/client";

/** The CRM status an archived repository carries. Compared exactly: a repository with
 *  NO status must not be filtered out — unknown is not archived. */
const ARCHIVED = "Archivé";

/**
 * How the folder was arrived at. The UI says which, because the two are not the same
 * promise: a pin is the user's own answer and stays until they change it, whereas a
 * derived match tracks the CRM and can move under them.
 */
export type FolderSource = "pin" | "derived";

export interface TaskFolderResolution {
  /** The folder to open in, when there is exactly one answer. Null means the user has
   *  to be asked — either because several folders match, or because none does. */
  repoId: string | null;
  /** How `repoId` was reached. Null when there is no answer. */
  source: FolderSource | null;
  /**
   * The folders a project's CRM repositories point at, deduplicated — the choices to
   * offer when there is more than one. The CRM legitimately holds several repository
   * rows for the same clone, so this is deduplicated on the LOCAL FOLDER: two rows
   * pointing at one folder are one choice, not an invented dilemma.
   */
  candidates: string[];
  /**
   * Whether the CRM's repository list could actually be read.
   *
   * ⚠️ The distinction that must not collapse: "no repository of this project matches a
   * folder" versus "we could not look". Resolving against a payload that failed to load
   * makes every project look unassociated, and the UI would then ask for a folder the
   * user already associated. A pin still resolves in that state — it is local.
   */
  checked: boolean;
}

/** Index the pins by project id. Pins are a handful of rows, read on every resolve. */
function pinFor(pins: TosseProjectRepo[], projectId: string): string | undefined {
  return pins.find((p) => p.project_id === projectId)?.repo_id;
}

/**
 * The local folders a TOSSE project resolves to, through the CRM repositories attached
 * to it. Deduplicated, in the payload's own order (which is the order folders were
 * added to Flight Deck).
 *
 * Archived repositories are dropped BEFORE resolving — measured on real data, keeping
 * them turned single answers into fake multiple-choice questions.
 */
export function foldersForProject(
  payload: TosseRepoLinksPayload | undefined,
  projectId: string | null | undefined,
): string[] {
  if (!payload || !projectId) return [];
  const out: string[] = [];
  for (const link of payload.links) {
    const repository = link.repository;
    if (!repository || repository.status === ARCHIVED) continue;
    if (!repository.projects.some((p) => p.id === projectId)) continue;
    if (!out.includes(link.repoId)) out.push(link.repoId);
  }
  return out;
}

/**
 * The git urls of a project's CRM repositories — what a disk scan matches clones against.
 *
 * Same filter as {@link foldersForProject} (archived repositories dropped), read from the
 * SAME payload: the repository list is already fetched, so finding out whether the project
 * is cloned somewhere costs no network call of its own.
 */
export function projectRepositoryUrls(
  payload: TosseRepoLinksPayload | undefined,
  projectId: string | null | undefined,
): string[] {
  if (!payload || !projectId) return [];
  const urls: string[] = [];
  for (const repository of payload.repositories) {
    if (repository.status === ARCHIVED || !repository.url) continue;
    if (!repository.projects.some((p) => p.id === projectId)) continue;
    if (!urls.includes(repository.url)) urls.push(repository.url);
  }
  return urls;
}

/**
 * Whether a clone the LOCAL repo scan found at `path` is already on offer — so the folder
 * picker does not list it twice. It is when an earlier scan match sits at that path, or
 * when Flight Deck already knows a folder of THIS Mac there.
 *
 * Only a local folder counts: the scan reads this Mac's disk, and a folder is the pair
 * (machine, path) — a server folder that merely shares the path is another folder, and
 * hiding the clone behind it would leave the user unable to pick the one sitting here.
 */
export function scanMatchAlreadyOffered(
  path: string,
  offered: readonly { path: string; repoId: string | null }[],
  repos: readonly Pick<Repo, "path" | "machineId">[],
): boolean {
  const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  return (
    offered.some((c) => c.repoId === null && same(c.path, path)) ||
    repos.some((r) => !r.machineId && same(r.path, path))
  );
}

/**
 * Which folder a task's project opens in.
 *
 * A PIN always wins: it is the user's own answer, and the whole point of asking once is
 * that the automatic match never overrides it afterwards. A pin whose folder is no
 * longer registered is ignored rather than returned — the database cascades those away,
 * but the store can lag a delete by a render.
 */
export function resolveTaskFolder(
  pins: TosseProjectRepo[],
  payload: TosseRepoLinksPayload | undefined,
  projectId: string | null | undefined,
  repos: Repo[],
): TaskFolderResolution {
  // `connected: false` is not a failure to read — there is simply no CRM session, and
  // the tasks view is not even reachable in that state. `error` IS one.
  const checked = payload != null && payload.error == null;
  const candidates = foldersForProject(payload, projectId).filter((id) =>
    repos.some((r) => r.id === id),
  );
  const pinned = projectId ? pinFor(pins, projectId) : undefined;
  if (pinned && repos.some((r) => r.id === pinned)) {
    return { repoId: pinned, source: "pin", candidates, checked };
  }
  if (candidates.length === 1) {
    return { repoId: candidates[0], source: "derived", candidates, checked };
  }
  return { repoId: null, source: null, candidates, checked };
}

/**
 * One place a task can run: a registered folder, on this Mac or on a paired server.
 *
 * A project can legitimately live in several — the same repository cloned on the Mac AND on
 * a server, both matched to the CRM by their `origin`. A place is a FOLDER, not a machine:
 * two clones on one machine are two places, told apart by their folder.
 */
export interface TaskPlace {
  repoId: string;
  path: string;
  /** The paired server it lives on, `null` for this Mac. */
  machineId: string | null;
  /** The place a plain "Start" runs in — the resolution's own answer. */
  isDefault: boolean;
}

/**
 * Every place a task's project can run: the CRM's matches plus the pin (which may point at a
 * folder the CRM does not match — it is the user's own answer), each folder once.
 *
 * ⚠️ The order is STABLE and says nothing about the default — this Mac first, then servers
 * by name, then folder. Moving the default to the top would make the row the user just
 * pinned jump away from under the pointer; the default is marked IN PLACE instead.
 * A server whose pairing is gone sorts last: it is still a place (its files are over
 * there), just the least likely one to want.
 */
export function taskPlaces(
  resolution: TaskFolderResolution,
  repos: Repo[],
  machines: ReadonlyArray<{ id: string; label: string }>,
): TaskPlace[] {
  const ids = [...resolution.candidates];
  if (resolution.repoId && !ids.includes(resolution.repoId)) ids.push(resolution.repoId);
  const places: TaskPlace[] = [];
  for (const id of ids) {
    const repo = repos.find((r) => r.id === id);
    if (!repo) continue;
    places.push({
      repoId: repo.id,
      path: repo.path,
      machineId: repo.machineId || null,
      isDefault: repo.id === resolution.repoId,
    });
  }
  return places.sort(
    (a, b) => compareMachines(a.machineId, b.machineId, machines) || a.path.localeCompare(b.path),
  );
}

/** Where a one-click "Start" runs, and whether that run also sets the project's default. */
export interface LaunchTarget {
  /** The folder to run in, or null when the user has to be asked (the dialog opens). */
  repoId: string | null;
  /** Write it as the project's default (pin) — once the launch has gone through. */
  rememberAsDefault: boolean;
}

/**
 * Resolve a launch from the Start button or its drop-down. Pure — this is the rule that
 * keeps the default from ping-ponging between machines, so it is tested on its own.
 *
 *  - No place picked → the project's default (null → ask).
 *  - A place picked that is still registered → that place, FOR THIS RUN. It becomes the
 *    default only when the project had none yet (the first answer is remembered, as the
 *    dialog's first choice is); otherwise the default stays where the user put it.
 *  - A place picked that has since been unregistered → null (ask), NOT the default: the
 *    user just chose somewhere other than the default, so silently running there instead
 *    would be the wrong machine.
 */
export function launchTarget(
  resolution: TaskFolderResolution,
  repos: ReadonlyArray<{ id: string }>,
  projectId: string | null,
  chosenRepoId?: string,
): LaunchTarget {
  if (!chosenRepoId) return { repoId: resolution.repoId, rememberAsDefault: false };
  if (!repos.some((r) => r.id === chosenRepoId)) return { repoId: null, rememberAsDefault: false };
  return { repoId: chosenRepoId, rememberAsDefault: projectId != null && resolution.repoId == null };
}

/**
 * Whether a launch from the Start dialog writes its folder as the project's default. Only
 * when it is to become the default (`makeDefault`: the user's pin toggle, which starts ON
 * for a project with no default yet) and is not already it. Launching somewhere else for
 * one run never moves it. Pure, for the same reason as {@link launchTarget}.
 */
export function dialogPinsDefault(
  projectId: string | null,
  makeDefault: boolean,
  targetRepoId: string,
  defaultRepoId: string | null,
): boolean {
  return projectId != null && makeDefault && targetRepoId !== defaultRepoId;
}

/**
 * The one order machines are listed in wherever a project's places are: this Mac, then
 * paired servers by name, then servers whose pairing is gone. Shared so the Start drop-down
 * and the folder picker never list the same machines in two orders.
 */
export function compareMachines(
  a: string | null,
  b: string | null,
  machines: ReadonlyArray<{ id: string; label: string }>,
): number {
  const key = (machineId: string | null): [number, string] => {
    if (!machineId) return [0, ""];
    const label = machines.find((m) => m.id === machineId)?.label;
    return label == null ? [2, ""] : [1, label.toLocaleLowerCase()];
  };
  const [ra, la] = key(a);
  const [rb, lb] = key(b);
  return ra - rb || la.localeCompare(lb);
}
