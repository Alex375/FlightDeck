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
