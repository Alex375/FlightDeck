// Choosing the local folder a TOSSE project's work happens in.
//
// ONE picker, two callers: the "Start / Discuss" dialog (which needs a folder before it can
// open a conversation) and a project card's own "folder" chip (which just records the
// association). They ask the same question, so they show the same thing — the chip used to
// offer a cramped dropdown of bare paths, which said nothing about which folder actually
// belonged to the project.
//
// Two groups, and the difference between them is the point: what BELONGS to the project
// (the CRM's answer, found among the open folders or on the disk) versus what merely
// happens to be open in Flight Deck.

import { useMemo } from "react";
import { Ico, TosseCrmMark } from "../../ui/kit";
import { pickFolder } from "../../ipc/pickFolder";
import { repoName, useConversationsStore, useMachines, useRepos } from "../../store/conversationsStore";
import { useLocalRepoScan, useTosseProjectRepos, useTosseRepoLinks } from "../../ipc/useTosse";
import { compareMachines, projectRepositoryUrls, resolveTaskFolder, scanMatchAlreadyOffered } from "./taskFolder";
import { MachineHeading, MachineTag } from "./PlaceMark";
import s from "./FolderPicker.module.css";

/**
 * One folder on offer, whichever group it is in.
 *
 * `repoId` null means Flight Deck does not know it yet — picking it adds it.
 * `repositoryName` is the CRM repository this folder answers to, and is what lets the UI
 * say WHY it is proposed rather than just listing a path.
 * `machineId` is the paired server it lives on (`null` = this Mac — always, for a clone
 * found by the disk scan, which only reads this Mac).
 */
export interface FolderChoice {
  key: string;
  path: string;
  repoId: string | null;
  repositoryName: string | null;
  machineId: string | null;
}

/** The three ways the match can come up empty, each as a glyph and a few words. The full
 *  explanation rides in the tooltip — long copy in a dialog is copy nobody reads. */
const EMPTY = {
  unreachable: {
    icon: "alert",
    text: "TOSSE unreachable — pick a folder",
    why: "The CRM could not be read, so this project's repositories could not be matched.",
  },
  noRepository: {
    icon: "link",
    text: "No repository in TOSSE — pick a folder",
    why: "This project has no repository linked in the CRM, so there is nothing to match against.",
  },
  notCloned: {
    icon: "search",
    text: "Not cloned on this Mac — pick a folder",
    why: "None of this project's repositories was found in the folders searched.",
  },
} as const;

/** `~/Repos/foo` rather than `/Users/alexandrejosien/Repos/foo` — a badge has no room for
 *  a home prefix that is the same on every line. */
function shortPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/)?.[0];
  return home ? path.replace(home, "~") : path;
}

export function FolderPicker({
  projectId,
  busy,
  currentRepoId,
  currentLabel,
  onChoose,
}: {
  projectId: string | null;
  busy?: boolean;
  /** The folder already in force, marked in place rather than repeated above the list —
   *  showing it twice made the same folder read as two different offers. */
  currentRepoId?: string | null;
  /** How it got there ("chosen" / "matched"), shown on that row. */
  currentLabel?: string;
  /** The folder was picked. `repoId` is always a REGISTERED folder — one found on disk is
   *  added to Flight Deck first, so the caller never has to know where it came from. */
  onChoose: (repoId: string) => void | Promise<void>;
}) {
  const repos = useRepos();
  const { data: pins } = useTosseProjectRepos();
  const { data: links } = useTosseRepoLinks();

  const resolution = useMemo(
    () => resolveTaskFolder(pins ?? [], links, projectId, repos),
    [pins, links, projectId, repos],
  );
  // The clone is usually already ON the disk — Flight Deck was just never told about it.
  const projectUrls = useMemo(() => projectRepositoryUrls(links, projectId), [links, projectId]);
  const scan = useLocalRepoScan(projectUrls, true);

  const { matched, others } = useMemo(() => {
    const repositoryNamed = (url: string | null) =>
      (url ? links?.repositories.find((r) => r.url === url)?.name : null) ?? null;

    const matched: FolderChoice[] = [];
    // Already in Flight Deck AND belonging to the project — the strongest answer there is.
    for (const id of resolution.candidates) {
      const r = repos.find((x) => x.id === id);
      if (!r) continue;
      matched.push({
        key: r.id,
        path: r.path,
        repoId: r.id,
        repositoryName: links?.links.find((l) => l.repoId === r.id)?.repository?.name ?? null,
        machineId: r.machineId || null,
      });
    }
    // Found on disk, not in Flight Deck yet (a server folder at the same path does not
    // count — see `scanMatchAlreadyOffered`).
    for (const m of scan.data?.matches ?? []) {
      if (scanMatchAlreadyOffered(m.path, matched, repos)) continue;
      matched.push({
        key: m.path,
        path: m.path,
        repoId: null,
        repositoryName: repositoryNamed(m.matchedUrl),
        machineId: null,
      });
    }
    const others: FolderChoice[] = repos
      .filter((r) => !matched.some((c) => c.repoId === r.id))
      .map((r) => ({
        key: r.id,
        path: r.path,
        repoId: r.id,
        repositoryName: null,
        machineId: r.machineId || null,
      }));
    return { matched, others };
  }, [links, repos, resolution.candidates, scan.data]);

  // The project's folders BY MACHINE once one of them is on a server: the same repository
  // on this Mac and on Base would otherwise be two rows told apart by their paths alone.
  // A project that lives only on this Mac keeps its flat list, exactly as before.
  const machines = useMachines();
  const groups = useMemo(() => {
    const out: { machineId: string | null; choices: FolderChoice[] }[] = [];
    for (const c of matched) {
      const group = out.find((g) => g.machineId === c.machineId);
      if (group) group.choices.push(c);
      else out.push({ machineId: c.machineId, choices: [c] });
    }
    return out.sort((a, b) => compareMachines(a.machineId, b.machineId, machines));
  }, [matched, machines]);
  const grouped = groups.some((g) => g.machineId != null);

  /** Registering is idempotent, so this covers both groups: a known folder comes back
   *  as-is, one found on disk is added. */
  async function choose(choice: FolderChoice) {
    const id = choice.repoId ?? useConversationsStore.getState().addRepo(choice.path).id;
    await onChoose(id);
  }

  const emptyKind: keyof typeof EMPTY = !resolution.checked
    ? "unreachable"
    : projectUrls.length === 0
      ? "noRepository"
      : "notCloned";

  async function chooseByHand() {
    const path = await pickFolder();
    if (!path) return;
    await onChoose(useConversationsStore.getState().addRepo(path).id);
  }

  return (
    <>
      {/* ── What belongs to this project ── */}
      <div className={s.groupHead}>
        <TosseCrmMark className={s.groupMark} />
        <span className={s.groupTitle}>
          {grouped ? "Project repositories" : "Project repositories on this computer"}
        </span>
        {scan.isFetching ? (
          <span className={s.searching}>
            <Ico name="refresh" className="sm wf-spin-fast" />
            Searching…
          </span>
        ) : null}
      </div>

      {matched.length > 0 ? (
        <div className={s.matchList}>
          {groups.flatMap((g) => [
            grouped ? (
              <MachineHeading
                key={`head:${g.machineId ?? "local"}`}
                machineId={g.machineId}
                className={s.machineHead}
              />
            ) : null,
            ...g.choices.map((c) => (
            <button
              key={c.key}
              type="button"
              className={s.match}
              disabled={busy}
              title={c.path}
              onClick={() => void choose(c)}
            >
              <Ico name="folder" className={`sm ${s.matchIco}`} />
              <span className={s.matchBody}>
                <span className={s.matchName}>
                  {repoName(c.path)}
                  {c.repositoryName ? <span className={s.matchRepo}>{c.repositoryName}</span> : null}
                </span>
                <span className={s.matchPath}>{c.path}</span>
              </span>
              {/* Either this IS the folder in force, or the row says what clicking does —
                  the two kinds look alike, but one of them also registers a folder the app
                  had never heard of. */}
              {c.repoId && c.repoId === currentRepoId ? (
                <span className={s.currentFlag}>
                  <Ico name="check" className="sm" />
                  {currentLabel ?? "current"}
                </span>
              ) : c.repoId ? null : (
                <span className={s.matchAdd}>+ Flight Deck</span>
              )}
            </button>
            )),
          ])}
        </div>
      ) : scan.isFetching ? (
        <div className={s.searchingBlock}>
          <Ico name="refresh" className="sm wf-spin-fast" />
          Searching this Mac for a clone…
        </div>
      ) : (
        // A glyph and a few words, not a paragraph: this is a state, and a state nobody
        // reads is a state that may as well not be shown.
        <div className={s.empty} title={EMPTY[emptyKind].why}>
          <Ico name={EMPTY[emptyKind].icon} className={s.emptyIco} />
          <span className={s.emptyText}>{EMPTY[emptyKind].text}</span>
        </div>
      )}

      {/* Each note still says WHICH thing happened — "stopped early" on its own sent us
          chasing the wrong cause once already — but as a badge of facts, with the sentence
          moved into the tooltip where it costs nobody a read. */}
      {(scan.data?.unreadable.length ?? 0) > 0 ? (
        <div
          className={s.note}
          title={`macOS has not granted access to ${scan.data?.unreadable.join(
            ", ",
          )}. Allow it in System Settings › Privacy & Security › Files and Folders, or pick the folder by hand.`}
        >
          <Ico name="shield" className="sm" />
          <span>Not searched:</span>
          <span className={s.noteFact}>{scan.data?.unreadable.map(shortPath).join(" · ")}</span>
        </div>
      ) : null}
      {scan.data?.truncated ? (
        <div
          className={s.note}
          title="The search hit its own limit, so a clone may be missing from this list — pick the folder by hand if it is."
        >
          <Ico name="clock" className="sm" />
          <span>Search cut short:</span>
          <span className={s.noteFact}>
            {scan.data.visited} folders · {(scan.data.elapsedMs / 1000).toFixed(1)}s
          </span>
        </div>
      ) : null}
      {scan.error ? (
        <div className={s.note} title={String((scan.error as Error).message)}>
          <Ico name="alert" className="sm" />
          <span>Search failed</span>
        </div>
      ) : null}

      {/* ── Everything else, offered plainly ── */}
      {others.length > 0 ? (
        <>
          <div className={s.otherHead}>Other open folders</div>
          <div className={s.otherList}>
            {others.map((c) => (
              <button
                key={c.key}
                type="button"
                className={s.other}
                disabled={busy}
                title={c.path}
                onClick={() => void choose(c)}
              >
                <span className={s.otherName}>{repoName(c.path)}</span>
                <MachineTag machineId={c.machineId} />
                <span className={s.otherPath}>{c.path}</span>
                {c.repoId === currentRepoId ? (
                  <span className={s.currentFlag}>
                    <Ico name="check" className="sm" />
                    {currentLabel ?? "current"}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className={s.pickRow}>
        <button type="button" className={s.ghostBtn} disabled={busy} onClick={() => void chooseByHand()}>
          Browse…
        </button>
      </div>
    </>
  );
}
