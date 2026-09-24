// The TOSSE card of one repository: what the CRM knows about this folder, and where the
// association is repaired.
//
// It mirrors the CRM's own repository page (name + status, the git url, the linked
// projects, the repo-level AI context) rather than inventing a second vocabulary — the
// point is to recognise, in Flight Deck, the page you already read in TOSSE.
//
// Read-only towards TOSSE. Nothing here writes to the CRM: it holds no field for a local
// path, and a path on this Mac would be meaningless on Armand's. The association is a
// local fact, stored in this app's database.
//
// Every "not linked" case is spelled out rather than collapsed into one blank state:
// nothing matched, several matched, the pinned repository is gone, the folder's remote
// could not even be read, or the CRM list itself failed to load. Each says what happened
// and offers the one action that fixes it.
import { useEffect, useMemo, useState } from "react";
import { Ico, TosseCrmMark } from "../../ui/kit";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TosseRepoLink, TosseRepository } from "../../ipc/client";
import {
  repoLinkFor,
  useLinkTosseRepository,
  useRefreshRemoteOrigins,
  useRemoteOriginWriteErrors,
  useTosseRepoLinks,
} from "../../ipc/useTosse";
import { repoName, useConversationsStore } from "../../store/conversationsStore";
import { useTosseRepoUi } from "./tosseRepoUiStore";
import styles from "./TosseRepoCard.module.css";

/** Rank repositories for the picker: the one currently linked first, then those whose name
 *  looks like the folder, then alphabetical.
 *
 *  ⚠️ A display nicety ONLY. The actual association is never decided by name — that is what
 *  the normalized git remote is for, and a name heuristic would both miss real pairs and
 *  invent false ones (the CRM calls `CRM_max` "TOSSE"). Here it merely saves scrolling. */
export function orderForPicker(
  list: TosseRepository[],
  folder: string,
  currentId?: string | null,
): TosseRepository[] {
  const needle = folder.toLowerCase().replace(/[^a-z0-9]/g, "");
  const looksLike = (name: string) => {
    if (!needle) return false;
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return n.includes(needle) || needle.includes(n);
  };
  return [...list].sort((a, b) => {
    if (currentId) {
      if (a.id === currentId) return -1;
      if (b.id === currentId) return 1;
    }
    const aHit = looksLike(a.name);
    const bHit = looksLike(b.name);
    if (aHit !== bHit) return aHit ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Name a paired server for a sentence: its label, or an honest stand-in when the server
 *  was un-paired and only its id survives on the folder. */
function machineName(machine: { label: string | null }): string {
  return machine.label ?? "a server that is no longer paired";
}

/** Why this folder could not be matched automatically, in one sentence.
 *
 *  Pure and exported so the reason has ONE definition and a test. Each branch names a
 *  different situation, and the order is load-bearing: a folder that lives on a server was
 *  never probed at all, so nothing may be said about its remote — reading it as "this
 *  folder has no git remote" is what the card did, and it was simply untrue. */
export function whyUnmatched(link: TosseRepoLink | undefined): string {
  // ⚠️ Before anything about reach: what the server actually ANSWERED, when that answer
  // was not a url. These are facts about the folder, obtained from a server that replied
  // perfectly well — and they used to be thrown away, which left `originRead` false and
  // sent the branch below to blame the server's reachability and advise "try again once
  // the server is reachable", advice that could never work. See `remote_origin_note`.
  const note = link?.machine?.originNote;
  if (link?.machine && note) {
    const where = machineName(link.machine);
    switch (note) {
      case "not-a-repository":
        return `This folder is not a git repository on ${where}, so there is no remote to match on. You can still pick a TOSSE repository by hand.`;
      case "gone":
        return `This folder is no longer there on ${where}, so its git remote cannot be read. Pick a TOSSE repository by hand, or check the folder on that server.`;
      case "no-git":
        return `${where} has no git installed, so Flight Deck cannot read this folder's remote there. Pick a TOSSE repository by hand, or install git on that server.`;
      case "no-remote":
        return `This folder has no git remote on ${where}, so it cannot be matched automatically.`;
      // An answer a newer backend knows and this build does not: say it rather than
      // dress it up as one of the cases above.
      default:
        return `${where} answered "${note}" for this folder, so its git remote could not be read. Pick a TOSSE repository by hand.`;
    }
  }
  // Only while the server has not answered at all: nothing was read, so every claim below
  // would be about a probe that never ran. Once it HAS answered, a folder over there is an
  // ordinary candidate and falls through to the same sentences as a local one.
  if (link?.machine && !link.machine.originRead) {
    return `This folder lives on ${machineName(link.machine)}, and Flight Deck has not been able to read its git remote there yet — so it cannot be matched automatically. Pick a TOSSE repository by hand, or try again once the server is reachable.`;
  }
  if (link?.machine && !link.remoteUrl && !link.remoteError) {
    // The server DID answer, and this folder has no origin. A fact about the folder, not
    // about our reach — the previous branch would have blamed the server for it.
    return `This folder has no git remote on ${machineName(link.machine)}, so it cannot be matched automatically.`;
  }
  if (link?.remoteError) {
    return "This folder's git remote could not be read, so it cannot be matched automatically.";
  }
  if (link?.notARepository) {
    return "This folder is not a git repository, so there is no remote to match on. You can still pick a TOSSE repository by hand.";
  }
  if (link?.remoteUrl) {
    return `No TOSSE repository carries this folder's remote (${link.remoteUrl}).`;
  }
  return "This folder has no git remote, so it cannot be matched automatically.";
}

export function TosseRepoCard() {
  const repoId = useTosseRepoUi((s) => s.repoId);
  const close = useTosseRepoUi((s) => s.closeCard);
  const repoPath = useConversationsStore((s) => s.repos.find((r) => r.id === repoId)?.path ?? null);
  const { data, isFetching, refetch, error: queryError } = useTosseRepoLinks(repoId != null);
  const linkRepository = useLinkTosseRepository();
  // Refresh re-ASKS the servers as well as re-running the match: for a remote folder the
  // url is cached, so a plain refetch would re-read the same answer and the button would
  // be a no-op exactly where someone presses it (an origin that moved, a server that was
  // off when the app started).
  const refreshRemoteOrigins = useRefreshRemoteOrigins();
  const originWriteErrors = useRemoteOriginWriteErrors();
  const refresh = () => {
    refreshRemoteOrigins();
    void refetch();
  };
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  // Escape closes, like the app's other dialogs (fullscreen is protected globally by the
  // capture-phase guard in App.tsx). One Escape closes ONE layer: with the picker open it
  // only backs out of the picker, so an accidental "change association" never costs the
  // whole card.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (picking) setPicking(false);
      else close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, picking]);

  // Reset per-card state whenever the card opens on another repo, so it never inherits the
  // previous folder's search text — nor its failed save. A mutation error is about ONE
  // folder: left standing, it would accuse the next repository of a write it never
  // attempted ("the association was not saved", quoting the other folder's id).
  const resetLink = linkRepository.reset;
  useEffect(() => {
    setPicking(false);
    setQuery("");
    resetLink();
  }, [repoId, resetLink]);

  const link: TosseRepoLink | undefined = repoLinkFor(data, repoId ?? "");
  const candidates = useMemo(
    () =>
      orderForPicker(
        data?.repositories ?? [],
        repoPath ? repoName(repoPath) : "",
        link?.repository?.id ?? null,
      ),
    [data?.repositories, repoPath, link?.repository?.id],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.url ?? "").toLowerCase().includes(q),
    );
  }, [candidates, query]);

  // Hooks all sit above this guard so their order never changes between renders.
  if (!repoId || !repoPath) return null;

  const repository = link?.repository ?? null;
  const busy = linkRepository.isPending;
  // Did matching actually RUN for this folder? False while the CRM list is unreadable, and
  // for a folder added since the last fetch. Every claim below is gated on it: without the
  // list, "no repository carries this remote" and "the one you picked is gone" are things
  // we cannot know — and stating them pushed the user to clear a valid association.
  const checked = link?.resolved === true;

  function pin(repositoryId: string | null) {
    linkRepository.mutate(
      { repoId: repoId!, repositoryId },
      { onSuccess: () => setPicking(false) },
    );
  }

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <TosseCrmMark className={styles.headMark} />
          <span className={styles.title}>
            {repository ? repository.name : "TOSSE"}
            <span className={styles.titleRepo}> · {repoName(repoPath)}</span>
          </span>
          {repository?.status ? (
            <span className={styles.status} data-archived={repository.status !== "Actif"}>
              {repository.status}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.iconBtn}
            title="Refresh"
            disabled={isFetching}
            onClick={refresh}
          >
            <Ico name="refresh" className="sm" />
          </button>
          <button type="button" className={styles.iconBtn} title="Close" onClick={close}>
            <Ico name="x" className="sm" />
          </button>
        </div>

        <div className={styles.body}>
          {/* The CRM list itself failed — say so instead of showing the folder as simply
              un-associated, which would look like the association was lost. */}
          {data?.error ? (
            <div className={styles.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={styles.problemTitle}>TOSSE could not be read</div>
                <div className={styles.problemBody}>{data.error}</div>
              </div>
            </div>
          ) : null}

          {/* A refresh that failed must not leave the previous content standing as if it
              had been confirmed — the button would look like a no-op. */}
          {queryError ? (
            <div className={styles.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={styles.problemTitle}>
                  The TOSSE associations could not be refreshed
                </div>
                <div className={styles.problemBody}>
                  {String(queryError)} — what is shown below may be out of date.
                </div>
              </div>
            </div>
          ) : null}

          {/* An answer the sweep paid an SSH round trip for and then failed to cache. It
              is invisible everywhere else: the folder simply keeps reading as
              never-probed, and Refresh looks inert for a reason nobody can see. */}
          {originWriteErrors.length > 0 ? (
            <div className={styles.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={styles.problemTitle}>
                  {originWriteErrors.length === 1
                    ? "A server's answer could not be saved"
                    : `${originWriteErrors.length} server answers could not be saved`}
                </div>
                <div className={styles.problemBody}>
                  {originWriteErrors.join(" · ")} — those folders will keep asking their
                  server on every refresh until this is fixed.
                </div>
              </div>
            </div>
          ) : null}

          {linkRepository.isError ? (
            <div className={styles.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={styles.problemTitle}>The association was not saved</div>
                {/* `.message`, not `String(error)`: the latter renders "Error: …" — the
                    class name is noise the user has to read past to reach the reason. Same
                    treatment as every other error surface in this feature. */}
                <div className={styles.problemBody}>{String(linkRepository.error.message)}</div>
              </div>
            </div>
          ) : null}

          {/* A genuine git fault only. A folder that simply is not a repository is an
              ordinary case here and gets a plain sentence in the empty state below — not a
              warning banner, which would put an alarm on every non-clone folder the user
              has added. */}
          {link?.remoteError ? (
            <div className={styles.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={styles.problemTitle}>This folder's git remote is unreadable</div>
                <div className={styles.problemBody}>
                  {link.remoteError} — an automatic match is impossible; pick a repository by
                  hand below if it belongs to one.
                </div>
              </div>
            </div>
          ) : null}

          {/* A pinned repository the CRM no longer returns. Never silently replaced by the
              remote guess, so the user sees their own choice, broken.
              ⚠️ Gated on `checked`: without a readable list this same shape means "we could
              not verify", and announcing a deletion there — with a destructive button as the
              only way out — is how a passing outage cost a valid association. */}
          {checked && !repository && link?.manualRepositoryId ? (
            <div className={styles.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={styles.problemTitle}>The repository you picked is gone</div>
                <div className={styles.problemBody}>
                  TOSSE no longer returns the repository <code>{link.manualRepositoryId}</code>.
                  It may have been archived or deleted. Pick another one, or clear the
                  association.
                </div>
              </div>
            </div>
          ) : null}

          {link && link.ambiguous.length > 0 ? (
            <div className={styles.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={styles.problemTitle}>
                  {link.ambiguous.length} TOSSE repositories share this git remote
                </div>
                <div className={styles.problemBody}>
                  Flight Deck will not guess between them — choose the right one:
                </div>
                <div className={styles.candidates}>
                  {link.ambiguous.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={styles.candidate}
                      disabled={busy}
                      onClick={() => pin(r.id)}
                    >
                      <span className={styles.candidateName}>{r.name}</span>
                      {r.url ? <span className={styles.candidateUrl}>{r.url}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {/* ── The repository, as TOSSE describes it ── */}
          {repository ? (
            <>
              <div className={styles.facts}>
                <Fact label="Repository">
                  {repository.url ? (
                    <button
                      type="button"
                      className={styles.link}
                      title="Open on the host"
                      onClick={() => void openUrl(repository.url!)}
                    >
                      {repository.url.replace(/^https?:\/\//, "")}
                      <Ico name="external" className={styles.linkIco} />
                    </button>
                  ) : (
                    <span className={styles.muted}>no url in TOSSE</span>
                  )}
                </Fact>
                {/* "Local folder" is a lie for a path that only exists on a server — and a
                    dangerous one, since a remote path can look exactly like one of yours.
                    The label follows the folder, and the server is named next to it. */}
                <Fact label={link?.machine ? "Folder" : "Local folder"}>
                  <span className={styles.mono}>{repoPath}</span>
                  {link?.machine ? (
                    <span className={styles.muted}> · on {machineName(link.machine)}</span>
                  ) : null}
                </Fact>
                <Fact label="Association">
                  <span className={styles.muted}>
                    {link?.source === "manual"
                      ? "picked by hand"
                      : "matched automatically from this folder's git remote"}
                  </span>
                </Fact>
              </div>

              <Section label={`Linked projects (${repository.projects.length})`}>
                {repository.projects.length === 0 ? (
                  <div className={styles.muted}>No project linked in TOSSE</div>
                ) : (
                  <ul className={styles.projects}>
                    {repository.projects.map((p) => (
                      <li key={p.id}>
                        <span className={styles.projectName}>{p.name}</span>
                        {p.status ? <span className={styles.projectStatus}>{p.status}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {repository.context ? (
                <Section label="Context">
                  <div className={styles.context}>
                    <StreamMarkdown text={repository.context} />
                  </div>
                </Section>
              ) : null}
            </>
          ) : (
            !picking &&
            (checked ? (
              <div className={styles.empty}>
                <Ico name="link" className={styles.emptyIco} />
                <div className={styles.emptyTitle}>This folder is not associated with TOSSE</div>
                <div className={styles.emptyBody}>{whyUnmatched(link)}</div>
              </div>
            ) : (
              // Not checked: say exactly that, and nothing about the folder's remote or
              // about the CRM's contents. The banner above already gives the cause when
              // there is one; a folder added since the last fetch simply has no entry yet.
              <div className={styles.empty}>
                <Ico name="link" className={styles.emptyIco} />
                <div className={styles.emptyTitle}>This association has not been checked yet</div>
                <div className={styles.emptyBody}>
                  {data?.error
                    ? "TOSSE could not be read, so this folder's association could not be verified. Nothing has changed — retry once TOSSE is reachable."
                    : "This folder has not been matched against TOSSE yet. Refresh to check it."}
                </div>
                {/* WHERE the folder lives is a local fact — it stays true through an
                    outage. Only said while the server has yet to answer: once it has,
                    this folder matches like any other and the note would be misleading. */}
                {link?.machine && !link.machine.originRead && !link.machine.originNote ? (
                  <div className={styles.emptyBody}>
                    It lives on {machineName(link.machine)}, whose git remotes could not be
                    read yet.
                  </div>
                ) : null}
                <button
                  type="button"
                  className={styles.ghostBtn}
                  disabled={isFetching}
                  onClick={refresh}
                >
                  {isFetching ? "Checking…" : "Refresh"}
                </button>
              </div>
            ))
          )}

          {/* ── Picker ── */}
          {picking ? (
            <Section label="Pick a TOSSE repository">
              <div className={styles.searchRow}>
                <Ico name="search" className="sm" />
                <input
                  className={styles.search}
                  value={query}
                  autoFocus
                  placeholder="Search by name or url…"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className={styles.pickList}>
                {filtered.length === 0 ? (
                  <div className={styles.muted}>No repository matches “{query}”</div>
                ) : (
                  filtered.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={styles.candidate}
                      disabled={busy}
                      data-current={r.id === repository?.id}
                      onClick={() => pin(r.id)}
                    >
                      <span className={styles.candidateName}>{r.name}</span>
                      {r.url ? <span className={styles.candidateUrl}>{r.url}</span> : null}
                      {r.id === repository?.id ? <Ico name="check" className="sm" /> : null}
                    </button>
                  ))
                )}
              </div>
            </Section>
          ) : null}
        </div>

        <div className={styles.foot}>
          {/* Clearing is only offered when a pin actually exists — clearing an automatic
              match would suggest a stored state that is not there.
              ⚠️ Disabled while the association is unchecked: during an outage this used to
              be the ONLY enabled control (the picker needs a repository list), so the single
              thing the user could do was destroy a pin on the strength of a false report. */}
          {link?.manualRepositoryId ? (
            <button
              type="button"
              className={styles.ghostBtn}
              disabled={busy || !checked}
              onClick={() => pin(null)}
            >
              Clear association
            </button>
          ) : null}
          {/* Said in VISIBLE text, not in a `title`: a disabled control has no pointer
              events, so its tooltip never renders and the user is left with a dead button
              and no reason. */}
          {link?.manualRepositoryId && !checked ? (
            <span className={styles.footNote}>unavailable until TOSSE can be reached</span>
          ) : null}
          <span className={styles.footSpacer} />
          {picking ? (
            <button type="button" className={styles.ghostBtn} onClick={() => setPicking(false)}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={busy || (data?.repositories.length ?? 0) === 0}
              onClick={() => setPicking(true)}
            >
              {repository ? "Change association" : "Associate with a repository"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{children}</span>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{label}</div>
      {children}
    </div>
  );
}
