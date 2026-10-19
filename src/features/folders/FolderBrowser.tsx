// Flight Deck's folder browser: the dialog a folder is chosen with — on a paired SSH
// server (the sidebar's "+ → Add a folder on <server>…", a server's "New conversation…"
// in Settings) and on this Mac (`chooseFolder`, in place of the system picker). ONE
// dialog over a `FolderSource`, so a folder is chosen the same way wherever it lives.
//
//  - a breadcrumb with Up, the Home and Root places, and the git repositories found up
//    front in a side rail,
//  - one input that filters the folder you are in AND takes a path (`/srv/app`,
//    `~/code`), driven from the keyboard: ↑↓ select, ↵ go into, ⇧↵ open the selected
//    folder, ⌘↵ open the current one, ⌫ on an empty input goes up,
//  - "New folder", and "create it" for a typed path that doesn't exist yet: only the
//    LAST folder is ever created, and only when its parent exists (a wrong parent chain
//    fails loudly instead of materialising a bogus deep path),
//  - every failure in words — an unreachable server, a refused folder, a search that
//    timed out — never a spinner left running.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ico } from "../../ui/kit";
import { chordLabel } from "../../ui/platform";
import type { FolderListing } from "../../ipc/client";
import type { Outcome } from "../../ipc/outcome";
import { useDisplay } from "../../store/display";
import { remoteFolderSource, type FolderSource, type RepoSearch } from "./folderSources";
import {
  baseName,
  filterFolders,
  filterRepos,
  folderNameProblem,
  joinDir,
  looksLikePath,
  parentDir,
  pathCrumbs,
  repoEntries,
  resolveTypedPath,
  sortFolders,
  tildePath,
  type RepoEntry,
} from "./folderBrowserModel";
import styles from "./FolderBrowser.module.css";

/** What the main pane shows. `asked` is the path a failed listing was asked for (`""` =
 *  the home). */
type Listing =
  | { kind: "loading" }
  | { kind: "ready"; data: FolderListing }
  | { kind: "error"; asked: string; error: string };

/** Which way the last navigation went — the list slides in from that side. */
type NavDir = "down" | "up" | "jump";

/** A parent column of the column view: one folder already read, or on its way. */
type ColumnState = { kind: "loading" } | { kind: "ready"; data: FolderListing } | { kind: "error"; error: string };

/** One keyboard-selectable row of the main list. */
type Row =
  | { kind: "goto"; path: string }
  | { kind: "dir"; name: string; path: string; git: boolean; at: number; length: number }
  | { kind: "repo"; repo: RepoEntry }
  | { kind: "create"; name: string };

/** Past this many sub-folders, the list shows the first ones and asks for a filter — a
 *  `/usr/lib` must not lay out thousands of rows on every keystroke. */
const MAX_ROWS = 400;

const OPEN_CHORD = chordLabel("⌘↵");

/** The folder browser on a paired server, to start a conversation there. */
export function RemoteFolderDialog({
  machine,
  onOpen,
  onClose,
}: {
  machine: { id: string; label: string; user?: string; host?: string };
  /** Called with the chosen folder — one that exists on the server. */
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const source = useMemo(() => remoteFolderSource(machine.id), [machine.id]);
  return (
    <FolderBrowserDialog
      source={source}
      place={machine.label}
      badge="server"
      title={
        <>
          New conversation on <strong>{machine.label}</strong>
        </>
      }
      subtitle={
        <>
          {machine.user && machine.host ? (
            <span className={styles.mono}>
              {machine.user}@{machine.host}
            </span>
          ) : null}
          <span>Choose the folder it works in</span>
        </>
      }
      onOpen={onOpen}
      onClose={onClose}
    />
  );
}

export function FolderBrowserDialog({
  source,
  place,
  badge,
  title,
  subtitle,
  confirmLabel = "Open here",
  targetLabel = "Starts in",
  footerExtra,
  onOpen,
  onClose,
}: {
  /** Where the folders are read from. Keep it stable (memoized): a new one starts over. */
  source: FolderSource;
  /** Where the folders are, in words — "ready-vps", "this Mac". */
  place: string;
  /** The header's icon (a kit glyph name). */
  badge: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** The primary button, which hands back the folder you are in. */
  confirmLabel?: string;
  /** What the footer says the chosen folder is for — "Starts in", "Folder". */
  targetLabel?: string;
  /** A control at the start of the footer's buttons (this Mac's system picker). */
  footerExtra?: ReactNode;
  /** Called with the chosen folder — one that exists. */
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [home, setHome] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  // The path a navigation is on its way to. The previous listing stays on screen (dimmed)
  // meanwhile, so a fast server never flashes an empty pane between two folders.
  const [pending, setPending] = useState<string | null>(null);
  const [navDir, setNavDir] = useState<NavDir>("jump");
  const [repos, setRepos] = useState<Outcome<RepoSearch> | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  // The inline "new folder" row: its name, what's wrong with it, and whether the mkdir
  // is in flight.
  const [creating, setCreating] = useState<{ name: string; error: string | null; busy: boolean } | null>(null);
  // A failed "create it" of a typed path that doesn't exist — shown in its card.
  const [missingError, setMissingError] = useState<string | null>(null);
  const [missingBusy, setMissingBusy] = useState(false);

  // Every folder read in this dialog, by resolved path: the column view's parent columns
  // come from here, and going back to a folder already seen shows it at once.
  const [folders, setFolders] = useState<Record<string, ColumnState>>({});
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  // Anything but "list" reads as columns — a stored value from elsewhere included.
  const columnsView = useDisplay((s) => s.folderBrowserView) !== "list";
  const setDisplay = useDisplay((s) => s.set);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  // Orders the navigations: only the LAST one asked may land (clicking down three
  // folders on a slow link must not end on the first).
  const navSeq = useRef(0);
  const lastGood = useRef<string | null>(null);

  const current = listing.kind === "ready" ? listing.data.path : null;
  const exists = listing.kind === "ready" && listing.data.exists;

  const navigate = useCallback(
    async (path: string, dir: NavDir) => {
      const mine = ++navSeq.current;
      setQuery("");
      setActive(-1);
      setCreating(null);
      setMissingError(null);
      // A folder already read shows at once; the fresh read below still replaces it.
      const seen = foldersRef.current[path];
      if (seen?.kind === "ready") {
        setListing({ kind: "ready", data: seen.data });
        setNavDir(dir);
        setPending(null);
      } else {
        setPending(path || "~");
      }
      const res = await source.list(path);
      if (mine !== navSeq.current) return;
      setPending(null);
      setNavDir(dir);
      if (res.ok) {
        setListing({ kind: "ready", data: res.data });
        if (res.data.exists) {
          lastGood.current = res.data.path;
          setFolders((f) => ({ ...f, [res.data.path]: { kind: "ready", data: res.data } }));
        }
        if (path === "" && res.data.exists) setHome(res.data.path);
      } else {
        setListing({ kind: "error", asked: path, error: res.error });
      }
      inputRef.current?.focus();
    },
    [source],
  );

  /** Forget a folder read earlier — it changed (a folder was created in it), or failed. */
  const forget = useCallback((path: string | null) => {
    if (!path) return;
    setFolders((f) => {
      if (!(path in f)) return f;
      const next = { ...f };
      delete next[path];
      return next;
    });
  }, []);

  const searchRepos = useCallback(async () => {
    setRepos(null);
    setRepos(await source.findRepos());
  }, [source]);

  // Open at the REAL home folder (an empty path), and look for repositories.
  useEffect(() => {
    void navigate("", "jump");
    void searchRepos();
  }, [navigate, searchRepos]);

  // The breadcrumb keeps its END in view — the folder you are in, not the root. So do the
  // columns: past a few levels they scroll, and the newest one is the one to see.
  // Columns scrolled off to the left: the edge fades, so the cut doesn't read as the start.
  const [columnsClipped, setColumnsClipped] = useState(false);
  useLayoutEffect(() => {
    for (const el of [crumbsRef.current, columnsRef.current]) {
      if (el) el.scrollLeft = el.scrollWidth;
    }
    setColumnsClipped((columnsRef.current?.scrollLeft ?? 0) > 0);
  }, [current, columnsView]);

  // The column view's parent columns: every folder from the start of the breadcrumb down
  // to the one you are in — each listed, with the next one along selected.
  const parentColumns = useMemo(() => {
    if (!columnsView || !current || !exists) return [];
    const crumbs = pathCrumbs(current, home);
    return crumbs.slice(0, -1).map((c, i) => ({ path: c.path, selected: crumbs[i + 1].label }));
  }, [columnsView, current, exists, home]);

  // Read the parent columns not read yet (a typed path, a repository, the first open).
  const reading = useRef(new Set<string>());
  useEffect(() => {
    for (const { path } of parentColumns) {
      if (foldersRef.current[path] || reading.current.has(path)) continue;
      reading.current.add(path);
      setFolders((f) => ({ ...f, [path]: { kind: "loading" } }));
      void source.list(path).then((res) => {
        reading.current.delete(path);
        setFolders((f) => ({
          ...f,
          [path]: res.ok ? { kind: "ready", data: res.data } : { kind: "error", error: res.error },
        }));
      });
    }
  }, [parentColumns, folders, source]);

  const repoList = useMemo(() => (repos?.ok ? repoEntries(repos.data.paths, home) : []), [repos, home]);

  // A typed path is answered whatever the pane shows — an error included: it is how you
  // get out of one.
  const typingPath = looksLikePath(query);
  const showRows = typingPath || (listing.kind === "ready" && listing.data.exists);

  const { rows, matchingDirs } = useMemo<{ rows: Row[]; matchingDirs: number }>(() => {
    if (typingPath) {
      const target = resolveTypedPath(query, home);
      return { rows: target ? [{ kind: "goto", path: target }] : [], matchingDirs: 0 };
    }
    if (listing.kind !== "ready" || !listing.data.exists) return { rows: [], matchingDirs: 0 };
    const { path, dirs, repos: gitDirs } = listing.data;
    const matches = filterFolders(sortFolders(dirs), query);
    const out: Row[] = matches.slice(0, MAX_ROWS).map((m) => ({
      kind: "dir",
      name: m.name,
      path: joinDir(path, m.name),
      git: gitDirs.includes(m.name),
      at: m.at,
      length: m.length,
    }));
    const q = query.trim();
    if (q) {
      const shown = new Set(matches.map((m) => joinDir(path, m.name)));
      for (const repo of filterRepos(repoList, q)) {
        if (repo.path !== path && !shown.has(repo.path)) out.push({ kind: "repo", repo });
      }
      if (!folderNameProblem(q, dirs)) out.push({ kind: "create", name: q });
    }
    return { rows: out, matchingDirs: matches.length };
  }, [typingPath, query, home, listing, repoList]);

  // Typing selects the best match; clearing the input selects nothing. Set in the SAME
  // update as the text — an effect lands a beat later, and an Enter typed right behind
  // the last letter found nothing selected.
  const changeQuery = useCallback((q: string) => {
    setQuery(q);
    setActive(q.trim() ? 0 : -1);
  }, []);
  const activeRow = active >= 0 && active < rows.length ? rows[active] : null;

  // Keep the selected row in view as the arrows move it.
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const goUp = useCallback(() => {
    const up = current ? parentDir(current) : null;
    if (up) void navigate(up, "up");
  }, [current, navigate]);

  const createFolder = useCallback(
    async (rawName: string) => {
      if (!current || listing.kind !== "ready") return;
      const name = rawName.trim();
      const problem = folderNameProblem(name, listing.data.dirs);
      if (!name || problem) {
        setCreating({ name: rawName, error: problem, busy: false });
        return;
      }
      setCreating({ name, error: null, busy: true });
      const target = joinDir(current, name);
      const res = await source.makeDir(target);
      if (!res.ok) {
        setCreating({ name, error: res.error, busy: false });
        return;
      }
      // Its parent becomes a parent column — read it again, with the new folder in it.
      forget(current);
      await navigate(target, "down");
    },
    [current, listing, source, navigate, forget],
  );

  const createMissing = useCallback(async () => {
    if (listing.kind !== "ready" || listing.data.exists) return;
    const target = listing.data.path;
    setMissingBusy(true);
    setMissingError(null);
    const res = await source.makeDir(target);
    setMissingBusy(false);
    if (!res.ok) {
      setMissingError(res.error);
      return;
    }
    forget(parentDir(target));
    await navigate(target, "jump");
  }, [listing, source, navigate, forget]);

  const activate = useCallback(
    (row: Row) => {
      switch (row.kind) {
        case "goto":
          return void navigate(row.path, "jump");
        case "dir":
          return void navigate(row.path, "down");
        case "repo":
          return void navigate(row.repo.path, "jump");
        case "create":
          return void createFolder(row.name);
      }
    },
    [navigate, createFolder],
  );

  const openHere = useCallback(() => {
    if (current && exists && !pending) onOpen(current);
  }, [current, exists, pending, onOpen]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "ArrowDown" && mod) {
      e.preventDefault();
      if (activeRow) activate(activeRow);
    } else if (e.key === "ArrowUp" && mod) {
      e.preventDefault();
      goUp();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mod) openHere();
      else if (e.shiftKey && activeRow && (activeRow.kind === "dir" || activeRow.kind === "repo"))
        onOpen(activeRow.kind === "dir" ? activeRow.path : activeRow.repo.path);
      else if (activeRow) activate(activeRow);
    } else if (e.key === "Backspace" && query === "" && !e.repeat) {
      e.preventDefault();
      goUp();
    } else if (e.key === "ArrowRight" && activeRow && activeRow.kind !== "create" && caretAtEnd(e.currentTarget)) {
      // As in the Finder's columns: → opens the selected folder to the right.
      e.preventDefault();
      activate(activeRow);
    } else if (e.key === "ArrowLeft" && query === "") {
      e.preventDefault();
      goUp();
    }
  };

  // Escape peels one layer at a time — the new-folder row, then the filter, then the
  // dialog — and never reaches the window: Settings closes on a bare Escape too.
  // Read through a ref written at render: a listener re-subscribed by an effect would
  // see the text as it was a keystroke ago, and close the dialog instead of clearing it.
  const layers = useRef({ creating: false, query: "" });
  layers.current = { creating: creating !== null, query };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (layers.current.creating) {
        setCreating(null);
        inputRef.current?.focus();
      } else if (layers.current.query) {
        changeQuery("");
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [changeQuery, onClose]);

  const startCreating = () => {
    if (exists) setCreating({ name: "", error: null, busy: false });
  };

  const crumbs = current ? pathCrumbs(current, home) : [];
  const busy = pending !== null;
  const dirCount = listing.kind === "ready" ? listing.data.dirs.length : 0;
  const firstRepoRow = rows.findIndex((r) => r.kind === "repo");

  let main: ReactNode;
  if (showRows) {
    main = (
      <>
        {creating && (
          <div className={styles.createRow}>
            <span className={styles.rowIcon}>
              <Ico name="folderPlus" />
            </span>
            <input
              autoFocus
              className={styles.createInput}
              placeholder="Name of the new folder"
              value={creating.name}
              disabled={creating.busy}
              aria-label="Name of the new folder"
              onChange={(e) =>
                setCreating({
                  name: e.target.value,
                  error: folderNameProblem(e.target.value, listing.kind === "ready" ? listing.data.dirs : []),
                  busy: false,
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createFolder(creating.name);
                }
              }}
            />
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`}
              disabled={creating.busy || !creating.name.trim() || !!creating.error}
              onClick={() => void createFolder(creating.name)}
            >
              {creating.busy ? "Creating…" : "Create"}
            </button>
            {creating.error && <div className={styles.createError}>{creating.error}</div>}
          </div>
        )}
        {rows.length === 0 && !creating && (
          <EmptyState
            query={query}
            folderEmpty={dirCount === 0}
            homeUnknown={typingPath && !home}
            onCreate={startCreating}
          />
        )}
        {rows.map((row, i) => (
          <RowView
            key={rowKey(row)}
            row={row}
            index={i}
            active={i === active}
            sectionStart={i === firstRepoRow}
            home={home}
            onHover={() => setActive(i)}
            onActivate={() => activate(row)}
            onOpen={onOpen}
          />
        ))}
        {matchingDirs > MAX_ROWS && (
          <div className={styles.more}>
            Showing {MAX_ROWS} of {matchingDirs.toLocaleString()} folders — type to narrow them down.
          </div>
        )}
      </>
    );
  } else if (listing.kind === "loading") {
    main = <SkeletonRows />;
  } else if (listing.kind === "error") {
    main = (
      <StateCard icon="alert" tone="error" title="Couldn't open this folder" detail={listing.error}>
        <button type="button" className={styles.btn} onClick={() => void navigate(listing.asked, "jump")}>
          <Ico name="refresh" className="sm" /> Retry
        </button>
        {lastGood.current && lastGood.current !== listing.asked && (
          <button type="button" className={styles.btn} onClick={() => void navigate(lastGood.current!, "up")}>
            Back to {tildePath(lastGood.current, home)}
          </button>
        )}
      </StateCard>
    );
  } else {
    // Ready, but the folder isn't there: a typed path that doesn't exist yet.
    main = (
      <StateCard
        icon="folderPlus"
        tone="neutral"
        title="This folder doesn't exist yet"
        detail={
          <>
            <code className={styles.code}>{tildePath(listing.data.path, home)}</code> isn&apos;t on {place}. Create
            it to start there — only its last folder is created, so its parent must already exist.
          </>
        }
      >
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={missingBusy}
          onClick={() => void createMissing()}
        >
          <Ico name="folderPlus" className="sm" /> {missingBusy ? "Creating…" : "Create folder"}
        </button>
        {lastGood.current && (
          <button type="button" className={styles.btn} onClick={() => void navigate(lastGood.current!, "up")}>
            Back to {tildePath(lastGood.current, home)}
          </button>
        )}
        {missingError && <div className={styles.cardError}>{missingError}</div>}
      </StateCard>
    );
  }

  const body = (
    <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel} role="dialog" aria-modal aria-labelledby={titleId}>
        <header className={styles.head}>
          <span className={styles.badge}>
            <Ico name={badge} />
          </span>
          <div className={styles.headText}>
            <div className={styles.title} id={titleId}>
              {title}
            </div>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose} title="Close (Esc)" aria-label="Close">
            <Ico name="x" />
          </button>
        </header>

        <div className={styles.body}>
          <aside className={styles.rail}>
            <div className={styles.railLabel}>Places</div>
            <RailItem
              icon="home"
              label="Home"
              detail={home ? tildePath(home, null) : "…"}
              current={!!home && current === home}
              disabled={!home}
              onGo={() => home && void navigate(home, "jump")}
            />
            <RailItem icon="drive" label="Root" detail="/" current={current === "/"} onGo={() => void navigate("/", "jump")} />

            <div className={styles.railLabel}>
              Repositories
              {repos?.ok && repos.data.paths.length > 0 && (
                <span className={styles.count}>{repos.data.paths.length}</span>
              )}
            </div>
            <div className={styles.railRepos}>
              {repos === null ? (
                <>
                  <div className={styles.railNote}>
                    <Ico name="refresh" className="sm wf-spin-fast" /> Looking for git repositories…
                  </div>
                  <div className={styles.railSkel} />
                  <div className={styles.railSkel} />
                  <div className={styles.railSkel} />
                </>
              ) : !repos.ok ? (
                <div className={styles.railError}>
                  <span>Couldn&apos;t look for repositories: {repos.error}</span>
                  <button type="button" className={styles.linkBtn} onClick={() => void searchRepos()}>
                    Try again
                  </button>
                </div>
              ) : repos.data.paths.length === 0 ? (
                <div className={styles.railNote} title={source.searchedWhere}>
                  No git repository found.
                </div>
              ) : (
                repoList.map((r) => (
                  <RailItem
                    key={r.path}
                    icon="branch"
                    label={r.name}
                    detail={r.where}
                    current={current === r.path}
                    onGo={() => void navigate(r.path, "jump")}
                    onOpen={() => onOpen(r.path)}
                  />
                ))
              )}
              {repos?.ok && repos.data.note && <p className={styles.railHint}>{repos.data.note}</p>}
            </div>
          </aside>

          <section className={styles.main}>
            <div className={styles.toolbar}>
              <button
                type="button"
                className={styles.iconBtn}
                disabled={!current || !parentDir(current) || busy}
                onClick={goUp}
                title={`Up one level (${chordLabel("⌘↑")})`}
                aria-label="Up one level"
              >
                <Ico name="chevron" className={styles.upIco} />
              </button>
              <nav className={styles.crumbs} ref={crumbsRef} aria-label="Folder path">
                {listing.kind === "ready" ? (
                  crumbs.map((c, i) => {
                    const last = i === crumbs.length - 1;
                    return (
                      <span key={c.path} className={styles.crumbWrap}>
                        {i > 0 && <Ico name="chevron" className={`sm ${styles.crumbSep}`} />}
                        <button
                          type="button"
                          className={styles.crumb}
                          data-current={last || undefined}
                          disabled={last}
                          onClick={() => void navigate(c.path, "up")}
                          title={c.path}
                        >
                          {/* The start of the path is a place, drawn as in the rail: the
                              home with its folder's name (as Finder does), the root as a
                              disk — a bare "/" next to the separators read as noise. */}
                          {c.home ? (
                            <>
                              <Ico name="home" className="sm" />
                              {baseName(c.path)}
                            </>
                          ) : c.path === "/" ? (
                            <>
                              <Ico name="drive" className="sm" />
                              Root
                            </>
                          ) : (
                            c.label
                          )}
                        </button>
                      </span>
                    );
                  })
                ) : (
                  <span className={styles.crumbPlaceholder}>
                    {pending ?? (listing.kind === "error" ? listing.asked || "~" : " ")}
                  </span>
                )}
              </nav>
              {listing.kind === "ready" && listing.data.is_repo && (
                <span className={styles.gitTag} title="This folder is a git repository">
                  <Ico name="branch" className="sm" /> git
                </span>
              )}
              <div className={styles.viewSwitch} role="group" aria-label="View">
                <button
                  type="button"
                  className={styles.viewBtn}
                  aria-pressed={columnsView}
                  title="Columns — each folder opens to the right of its parent"
                  onClick={() => setDisplay({ folderBrowserView: "columns" })}
                >
                  <Ico name="columns" className="sm" />
                </button>
                <button
                  type="button"
                  className={styles.viewBtn}
                  aria-pressed={!columnsView}
                  title="List — the folder you are in"
                  onClick={() => setDisplay({ folderBrowserView: "list" })}
                >
                  <Ico name="list" className="sm" />
                </button>
              </div>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                disabled={!exists || busy || creating !== null}
                onClick={startCreating}
              >
                <Ico name="folderPlus" className="sm" /> New folder
              </button>
            </div>

            <label className={styles.search}>
              <Ico name="search" className="sm" />
              <input
                ref={inputRef}
                autoFocus
                className={styles.searchInput}
                placeholder="Filter folders, or type a path — /srv/app, ~/code…"
                value={query}
                spellCheck={false}
                autoComplete="off"
                aria-label="Filter folders or type a path"
                role="combobox"
                aria-expanded
                aria-controls="remote-folder-list"
                aria-activedescendant={activeRow ? `remote-folder-row-${active}` : undefined}
                onChange={(e) => changeQuery(e.target.value)}
                onKeyDown={onInputKey}
              />
              {query && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => {
                    changeQuery("");
                    inputRef.current?.focus();
                  }}
                  aria-label="Clear"
                >
                  <Ico name="x" className="sm" />
                </button>
              )}
            </label>

            <div className={styles.listWrap} data-busy={busy || undefined} data-view={columnsView ? "columns" : "list"}>
              {busy && <div className={styles.progress} />}
              <div
                className={styles.columns}
                ref={columnsRef}
                data-clipped={columnsClipped || undefined}
                onScroll={(e) => setColumnsClipped(e.currentTarget.scrollLeft > 0)}
              >
                {parentColumns.map((c) => (
                  <FolderColumn
                    key={c.path}
                    state={folders[c.path]}
                    selected={c.selected}
                    current={current !== null && joinDir(c.path, c.selected) === current}
                    onGo={(name, selected) => void navigate(joinDir(c.path, name), selected ? "up" : "jump")}
                    onOpen={(name) => onOpen(joinDir(c.path, name))}
                    onRetry={() => forget(c.path)}
                  />
                ))}
                <div
                  id="remote-folder-list"
                  ref={listRef}
                  role="listbox"
                  className={styles.list}
                  key={listing.kind === "ready" ? listing.data.path : listing.kind}
                  data-dir={navDir}
                >
                  {main}
                </div>
              </div>
            </div>

            <div className={styles.hints}>
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> select
              </span>
              <span>
                <kbd>→</kbd>
                <kbd>↵</kbd> go into
              </span>
              <span>
                <kbd>←</kbd>
                <kbd>⌫</kbd> up
              </span>
              <span>
                <kbd>{chordLabel("⇧↵")}</kbd> open selected
              </span>
            </div>
          </section>
        </div>

        <footer className={styles.foot}>
          <div className={styles.target}>
            {current && exists ? (
              <>
                {/* The full path: this line is the one place that says exactly which
                    folder the button hands back. */}
                <span className={styles.targetLabel}>{targetLabel}</span>
                <code className={styles.targetPath} title={current}>
                  {current}
                </code>
              </>
            ) : (
              <span className={styles.targetLabel}>Pick a folder</span>
            )}
          </div>
          {footerExtra}
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!current || !exists || busy}
            onClick={openHere}
          >
            {confirmLabel} <kbd className={styles.btnKbd}>{OPEN_CHORD}</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}

/** Whether → would move nothing in `input` — the caret is at the end of the text. */
function caretAtEnd(input: HTMLInputElement): boolean {
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}

function rowKey(row: Row): string {
  switch (row.kind) {
    case "goto":
      return `goto:${row.path}`;
    case "dir":
      return `dir:${row.path}`;
    case "repo":
      return `repo:${row.repo.path}`;
    case "create":
      return `create:${row.name}`;
  }
}

/** One row of the main list. Clicking it goes there (or creates the folder); its "Open"
 *  button starts the conversation in it directly. */
function RowView({
  row,
  index,
  active,
  sectionStart,
  home,
  onHover,
  onActivate,
  onOpen,
}: {
  row: Row;
  index: number;
  active: boolean;
  sectionStart: boolean;
  home: string | null;
  onHover: () => void;
  onActivate: () => void;
  onOpen: (path: string) => void;
}) {
  let icon = "folder";
  let label: ReactNode;
  let detail: ReactNode = null;
  let openPath: string | null = null;
  let git = false;
  switch (row.kind) {
    case "goto":
      icon = "arrow";
      label = (
        <>
          Go to <span className={styles.mono}>{tildePath(row.path, home)}</span>
        </>
      );
      break;
    case "dir":
      label = <Highlight text={row.name} at={row.at} length={row.length} />;
      openPath = row.path;
      git = row.git;
      break;
    case "repo":
      icon = "branch";
      label = row.repo.name;
      detail = row.repo.where;
      openPath = row.repo.path;
      git = true;
      break;
    case "create":
      icon = "folderPlus";
      label = (
        <>
          New folder <strong>“{row.name}”</strong> here
        </>
      );
      break;
  }
  return (
    <>
      {sectionStart && <div className={styles.section}>Repositories on this server</div>}
      <div
        id={`remote-folder-row-${index}`}
        data-row={index}
        role="option"
        aria-selected={active}
        className={styles.row}
        data-active={active || undefined}
        data-kind={row.kind}
        onMouseMove={active ? undefined : onHover}
        onClick={onActivate}
      >
        <span className={styles.rowIcon} data-git={git || undefined}>
          <Ico name={icon} />
        </span>
        <span className={styles.rowLabel}>{label}</span>
        {detail && <span className={styles.rowDetail}>{detail}</span>}
        {git && row.kind === "dir" && <span className={styles.gitPill}>git</span>}
        {openPath && (
          <button
            type="button"
            className={styles.rowOpen}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(openPath);
            }}
          >
            Open
          </button>
        )}
        {row.kind !== "create" && <Ico name="chevron" className={`sm ${styles.rowChevron}`} />}
      </div>
    </>
  );
}

/** A parent column of the column view: the folders of one parent, the one leading to the
 *  folder you are in selected. Clicking another goes there (its contents open to the
 *  right); clicking the selected one closes the columns past it. */
function FolderColumn({
  state,
  selected,
  current,
  onGo,
  onOpen,
  onRetry,
}: {
  state: ColumnState | undefined;
  /** The sub-folder on the way to the folder you are in. */
  selected: string;
  /** `selected` IS the folder you are in (this is the last parent column). */
  current: boolean;
  onGo: (name: string, selected: boolean) => void;
  onOpen: (name: string) => void;
  onRetry: () => void;
}) {
  const colRef = useRef<HTMLDivElement>(null);
  const ready = state?.kind === "ready" ? state.data : null;
  const names = useMemo(() => (ready ? sortFolders(ready.dirs) : []), [ready]);

  // The selected folder in view — in this column only: `scrollIntoView` would also move
  // the columns sideways, off the newest one.
  useLayoutEffect(() => {
    const col = colRef.current;
    const row = col?.querySelector<HTMLElement>("[data-selected]");
    if (!col || !row) return;
    if (row.offsetTop < col.scrollTop || row.offsetTop + row.offsetHeight > col.scrollTop + col.clientHeight) {
      col.scrollTop = row.offsetTop - col.clientHeight / 2 + row.offsetHeight / 2;
    }
  }, [names, selected]);

  return (
    <div className={styles.column} ref={colRef}>
      {!state || state.kind === "loading" ? (
        <SkeletonRows compact />
      ) : state.kind === "error" ? (
        <div className={styles.columnError}>
          <span>{state.error}</span>
          <button type="button" className={styles.linkBtn} onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        names.map((name) => {
          const isSelected = name === selected;
          const git = state.data.repos.includes(name);
          return (
            <div
              key={name}
              className={styles.colRow}
              data-selected={isSelected ? (current ? "current" : "path") : undefined}
              aria-current={isSelected && current ? "location" : undefined}
              onClick={() => onGo(name, isSelected)}
              title={name}
            >
              <span className={styles.colIcon} data-git={git || undefined}>
                <Ico name="folder" className="sm" />
              </span>
              <span className={styles.colName}>{name}</span>
              <button
                type="button"
                className={styles.rowOpen}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(name);
                }}
              >
                Open
              </button>
              <Ico name="chevron" className={`sm ${styles.rowChevron}`} />
            </div>
          );
        })
      )}
    </div>
  );
}

/** `text` with the typed part marked. */
function Highlight({ text, at, length }: { text: string; at: number; length: number }) {
  if (at < 0 || length === 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className={styles.mark}>{text.slice(at, at + length)}</mark>
      {text.slice(at + length)}
    </>
  );
}

/** A place or a repository in the side rail: the row goes there; a repository also has
 *  an "Open" button that starts the conversation in it directly. */
function RailItem({
  icon,
  label,
  detail,
  current,
  disabled,
  onGo,
  onOpen,
}: {
  icon: string;
  label: string;
  detail: string;
  current: boolean;
  disabled?: boolean;
  onGo: () => void;
  onOpen?: () => void;
}) {
  return (
    <div className={styles.railItem} data-current={current || undefined} data-disabled={disabled || undefined}>
      <button type="button" className={styles.railGo} onClick={onGo} disabled={disabled} title={detail}>
        <span className={styles.railIcon} data-git={icon === "branch" || undefined}>
          <Ico name={icon} className="sm" />
        </span>
        <span className={styles.railText}>
          <span className={styles.railName}>{label}</span>
          <span className={styles.railDetail}>{detail}</span>
        </span>
      </button>
      {onOpen && (
        <button type="button" className={styles.railOpen} onClick={onOpen} title={`Start the conversation in ${label}`}>
          Open
        </button>
      )}
    </div>
  );
}

function StateCard({
  icon,
  tone,
  title,
  detail,
  children,
}: {
  icon: string;
  tone: "error" | "neutral";
  title: string;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.card} data-tone={tone} role={tone === "error" ? "alert" : undefined}>
      <span className={styles.cardIcon}>
        <Ico name={icon} />
      </span>
      <div className={styles.cardTitle}>{title}</div>
      <div className={styles.cardDetail}>{detail}</div>
      {children && <div className={styles.cardActions}>{children}</div>}
    </div>
  );
}

function EmptyState({
  query,
  folderEmpty,
  homeUnknown,
  onCreate,
}: {
  query: string;
  folderEmpty: boolean;
  homeUnknown: boolean;
  onCreate: () => void;
}) {
  if (homeUnknown) {
    return <div className={styles.empty}>The server&apos;s home folder isn&apos;t known yet — type a full path.</div>;
  }
  if (query.trim()) {
    return (
      <div className={styles.empty}>
        No folder matches <strong>“{query.trim()}”</strong>.
      </div>
    );
  }
  if (!folderEmpty) return null;
  return (
    <div className={styles.empty}>
      <Ico name="folder" />
      <span>No sub-folders here.</span>
      <button type="button" className={styles.linkBtn} onClick={onCreate}>
        Create one
      </button>
      <span className={styles.emptyHint}>— or open this folder as it is.</span>
    </div>
  );
}

function SkeletonRows({ compact = false }: { compact?: boolean }) {
  return (
    <div className={styles.skeleton} aria-label="Loading" data-compact={compact || undefined}>
      {(compact ? [70, 52, 84, 46] : [72, 54, 86, 40, 63, 48]).map((w, i) => (
        <div key={i} className={styles.skelRow}>
          <span className={styles.skelIcon} />
          <span className={styles.skelBar} style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
