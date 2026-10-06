// ⌘⇧F — search everywhere. One modal, mounted once in App: a query (with the find bar's three
// toggles: case, whole word, regex), what to search (conversations, files — either or both),
// and which folders (every repository of the app, tickable, plus folders added by hand with
// the OS picker). Results stream in as the user types (debounced; a newer search cancels the
// one in flight, Rust side) and open in place: a file in an editor at its line, a conversation
// with its find bar on the same query (openResult.ts).
//
// The search itself runs in the Rust core (`search/mod.rs`): gitignore-aware walk of the
// folders + the conversation transcripts on disk. Everything that limits a result — a cap, the
// time budget, an unreadable folder or file — is SAID in the status line, never left implicit.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { commands } from "../../ipc/client";
import type { ConversationHits, FileHits, GlobalSearchResult } from "../../ipc/client";
import { pickFolder } from "../../ipc/pickFolder";
import { repoName, useConversationsStore } from "../../store/conversationsStore";
import { useAppErrors } from "../../store/appErrors";
import { Ico } from "../../ui/kit";
import type { View } from "../../ui/shortcuts";
import { BackendMark } from "../conversation/ConvMark";
import { Toggle } from "../find/FindBar";
import { timeAgo } from "../history/historyView";
import { useGlobalSearch } from "./globalSearchStore";
import {
  flatRows,
  highlightSegments,
  plural,
  rowKey,
  searchRoots,
  splitPath,
  type ResultRow,
} from "./globalSearchView";
import { openConversationHit, openFileHit } from "./openResult";
import styles from "./GlobalSearchPanel.module.css";

/** Typing settles for this long before a search fires. */
const DEBOUNCE_MS = 280;

export function GlobalSearchPanel({ changeView, currentView }: { changeView: (v: View) => void; currentView: View }) {
  const open = useGlobalSearch((s) => s.open);
  if (!open) return null;
  return <Panel changeView={changeView} currentView={currentView} />;
}

/** The last result, kept across a close/reopen so ⌘⇧F comes back to it instantly. Module-level:
 *  transient UI state, not worth a store field nobody else reads. */
let lastSearch: { key: string; result: GlobalSearchResult } | null = null;

function Panel({ changeView, currentView }: { changeView: (v: View) => void; currentView: View }) {
  const s = useGlobalSearch();
  const repos = useConversationsStore((st) => st.repos);
  const machines = useConversationsStore((st) => st.machines);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { chips, roots } = useMemo(
    () =>
      searchRoots(repos, s.excludedRepoIds, s.extraFolders, (id) => machines.find((m) => m.id === id)?.label ?? null),
    [repos, machines, s.excludedRepoIds, s.extraFolders],
  );

  const request = useMemo(
    () => ({
      query: { pattern: s.query, is_regex: s.isRegex, match_case: s.matchCase, whole_word: s.wholeWord },
      roots,
      files: s.files,
      conversations: s.conversations,
      include: s.files ? s.include : "",
      exclude: s.files ? s.exclude : "",
    }),
    [s.query, s.isRegex, s.matchCase, s.wholeWord, roots, s.files, s.conversations, s.include, s.exclude],
  );
  const requestKey = JSON.stringify(request);
  const ready = s.query !== "" && roots.length > 0 && (s.files || s.conversations);

  const [result, setResult] = useState<GlobalSearchResult | null>(() =>
    lastSearch && lastSearch.key === requestKey ? lastSearch.result : null,
  );
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);

  // Debounced search; a newer one supersedes (the Rust side cancels the stale walk). A reopen
  // shows the last results at once (initial state above) and still searches again: the files
  // and conversations may have changed since.
  useEffect(() => {
    if (!ready) {
      token.current++;
      setSearching(false);
      setError(null);
      setResult(null);
      return;
    }
    const mine = ++token.current;
    setSearching(true);
    const t = window.setTimeout(() => {
      void commands.globalSearch(request).then((res) => {
        if (mine !== token.current) return;
        setSearching(false);
        if (res.status === "error") {
          setError(res.error);
          setResult(null);
          return;
        }
        if (res.data.cancelled) return;
        setError(null);
        setResult(res.data);
        lastSearch = { key: requestKey, result: res.data };
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, ready]);

  // Closing stops any walk still running.
  useEffect(() => () => void commands.cancelGlobalSearch(), []);

  // Focus + select the query on every open.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [s.openNonce]);

  // ---- result rows & keyboard -------------------------------------------------------------
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (key: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const convs = result?.conversations ?? [];
  const files = result?.files ?? [];
  const rows = useMemo(
    () => flatRows(convs.map((c) => c.hits.length), files.map((f) => f.lines.length), collapsed),
    [convs, files, collapsed],
  );
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [result]);
  const selected: ResultRow | null = rows[Math.min(sel, rows.length - 1)] ?? null;

  useEffect(() => {
    if (!selected) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${rowKey(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = s.closePanel;
  const openRow = (r: ResultRow) => {
    const ctx = { currentView, changeView };
    if (r.kind === "file") {
      const f = files[r.group];
      const why = openFileHit(f, f.lines[r.hit], ctx);
      if (why) {
        useAppErrors.getState().pushError("Can't open this file", why);
        return;
      }
    } else {
      const c = convs[r.group];
      openConversationHit(c, c.hits[r.hit], s.query, { isRegex: s.isRegex, matchCase: s.matchCase, wholeWord: s.wholeWord }, ctx);
    }
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (rows.length === 0) return;
      e.preventDefault();
      setSel((i) => {
        const cur = Math.min(i, rows.length - 1);
        return e.key === "ArrowDown" ? Math.min(cur + 1, rows.length - 1) : Math.max(cur - 1, 0);
      });
      return;
    }
    // ↵ in the query box opens the selected row (a focused row button opens itself).
    if (e.key === "Enter" && selected && e.target === inputRef.current) {
      e.preventDefault();
      openRow(selected);
    }
  };

  const addFolder = async () => {
    const path = await pickFolder("Add a folder to search");
    if (path) s.addFolder(path);
    // Back to the query: the keyboard drives this panel (↑↓ ↵), and a focused button would
    // swallow the next ↵ — re-opening the picker instead of opening the selected result.
    inputRef.current?.focus();
  };

  const [filtersOpen, setFiltersOpen] = useState(() => s.include !== "" || s.exclude !== "");
  const now = Date.now();
  const selKey = selected ? rowKey(selected) : null;

  return (
    <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={styles.panel} role="dialog" aria-modal aria-label="Search everywhere" onKeyDown={onKeyDown}>
        {/* ---- query ---- */}
        <div className={styles.head}>
          <Ico name="search" />
          <input
            ref={inputRef}
            className={styles.query}
            value={s.query}
            placeholder="Search conversations and files…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search everywhere"
            data-find-input=""
            onChange={(e) => s.set({ query: e.target.value })}
          />
          {searching ? <Ico name="refresh" className={"sm " + styles.spin} /> : null}
          <span className={styles.toggles}>
            <Toggle on={s.matchCase} title="Match case" onClick={() => s.set({ matchCase: !s.matchCase })}>
              Aa
            </Toggle>
            <Toggle on={s.wholeWord} title="Match whole word" onClick={() => s.set({ wholeWord: !s.wholeWord })}>
              <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>ab</span>
            </Toggle>
            <Toggle on={s.isRegex} title="Use regular expression" onClick={() => s.set({ isRegex: !s.isRegex })}>
              .*
            </Toggle>
          </span>
          <button type="button" className={styles.iconBtn} title="Close (Esc)" aria-label="Close" onClick={close}>
            <Ico name="x" />
          </button>
        </div>

        {/* ---- scope ---- */}
        <div className={styles.scope}>
          <span className={styles.scopeLabel}>Search in</span>
          <Check on={s.conversations} onClick={() => s.set({ conversations: !s.conversations })}>
            <Ico name="chat" className="sm" /> Conversations
          </Check>
          <Check on={s.files} onClick={() => s.set({ files: !s.files })}>
            <Ico name="file" className="sm" /> Files
          </Check>
          {s.files ? (
            <button
              type="button"
              className={styles.linkBtn + (filtersOpen ? " " + styles.linkBtnOn : "")}
              onMouseDown={keepQueryFocus}
              onClick={() => setFiltersOpen((o) => !o)}
              title="Files to include / exclude (globs)"
            >
              <Ico name="dots" className="sm" />
              {s.include || s.exclude ? "Filters (on)" : "Filters"}
            </button>
          ) : null}
        </div>
        {s.files && filtersOpen ? (
          <div className={styles.filters}>
            <label className={styles.filter}>
              <span>Files to include</span>
              <input
                value={s.include}
                placeholder="e.g. src/**, *.ts"
                spellCheck={false}
                onChange={(e) => s.set({ include: e.target.value })}
              />
            </label>
            <label className={styles.filter}>
              <span>Files to exclude</span>
              <input
                value={s.exclude}
                placeholder="e.g. **/*.test.ts, dist"
                spellCheck={false}
                onChange={(e) => s.set({ exclude: e.target.value })}
              />
            </label>
          </div>
        ) : null}

        {/* ---- folders ---- */}
        <div className={styles.folders}>
          <span className={styles.scopeLabel}>Folders</span>
          <div className={styles.chips}>
            {chips.map((c) => (
              <span
                key={c.kind + c.key}
                className={
                  styles.chip + (c.on ? " " + styles.chipOn : "") + (c.disabledReason ? " " + styles.chipOff : "")
                }
                title={c.disabledReason ?? c.path}
              >
                <button
                  type="button"
                  className={styles.chipMain}
                  disabled={!!c.disabledReason}
                  aria-pressed={c.on}
                  onMouseDown={keepQueryFocus}
                  onClick={() => (c.kind === "repo" ? s.toggleRepo(c.key) : s.toggleFolder(c.key))}
                >
                  <span className={styles.box} aria-hidden="true">
                    {c.on ? <Ico name="check" /> : null}
                  </span>
                  {c.disabledReason && c.kind === "repo" ? <Ico name="server" className="sm" /> : null}
                  {repoName(c.path)}
                </button>
                {c.kind === "folder" ? (
                  <button
                    type="button"
                    className={styles.chipX}
                    title="Remove this folder from the search"
                    aria-label={`Remove ${repoName(c.path)}`}
                    onMouseDown={keepQueryFocus}
                    onClick={() => s.removeFolder(c.key)}
                  >
                    <Ico name="x" />
                  </button>
                ) : null}
              </span>
            ))}
            <button type="button" className={styles.addBtn} onClick={() => void addFolder()}>
              <Ico name="plus" className="sm" />
              Add folder…
            </button>
          </div>
        </div>

        {/* ---- results ---- */}
        <div className={styles.results} ref={listRef}>
          {!s.conversations && !s.files ? (
            <Empty>Choose what to search: conversations, files, or both.</Empty>
          ) : roots.length === 0 ? (
            <Empty>Tick at least one folder — or add one with “Add folder…”.</Empty>
          ) : s.query === "" ? (
            <Empty>
              Type to search {plural(roots.length, "folder")}
              {s.conversations && s.files ? " — conversations and files" : s.conversations ? " — conversations" : " — files"}.
            </Empty>
          ) : error ? (
            <div className={styles.error}>
              <Ico name="alert" className="sm" />
              {error}
            </div>
          ) : !result ? (
            <Empty>Searching…</Empty>
          ) : convs.length === 0 && files.length === 0 ? (
            <Empty>No results.</Empty>
          ) : (
            <>
              {s.conversations && convs.length > 0 ? (
                <Section
                  title="Conversations"
                  sub={`${plural(result.conversation_match_count, "match", "matches")} in ${plural(convs.length, "conversation")}`}
                  collapsed={collapsed.has("section:conv")}
                  onToggle={() => toggleCollapsed("section:conv")}
                >
                  {convs.map((c, g) => (
                    <ConvGroup
                      key={c.session_id}
                      conv={c}
                      now={now}
                      collapsed={collapsed.has(`conv:${g}`)}
                      onToggle={() => toggleCollapsed(`conv:${g}`)}
                    >
                      {c.hits.map((h, i) => {
                        const key = rowKey({ kind: "conv", group: g, hit: i });
                        return (
                          <button
                            type="button"
                            key={i}
                            data-row={key}
                            className={styles.row + (key === selKey ? " " + styles.rowSel : "")}
                            onMouseEnter={() => setSel(rows.findIndex((r) => rowKey(r) === key))}
                            onClick={() => openRow({ kind: "conv", group: g, hit: i })}
                          >
                            <span className={styles.role + (h.role === "user" ? " " + styles.roleUser : "")}>
                              {h.role === "user" ? "You" : c.backend === "codex" ? "Codex" : "Claude"}
                            </span>
                            <Preview text={h.preview} ranges={h.ranges} />
                          </button>
                        );
                      })}
                      {c.match_count > c.hits.length ? (
                        <div className={styles.more}>+{plural(c.match_count - c.hits.length, "more match", "more matches")}</div>
                      ) : null}
                    </ConvGroup>
                  ))}
                </Section>
              ) : null}
              {s.files && files.length > 0 ? (
                <Section
                  title="Files"
                  sub={`${plural(result.file_match_count, "match", "matches")} in ${plural(files.length, "file")}`}
                  collapsed={collapsed.has("section:file")}
                  onToggle={() => toggleCollapsed("section:file")}
                >
                  {files.map((f, g) => (
                    <FileGroup
                      key={f.path}
                      file={f}
                      showRoot={roots.length > 1}
                      collapsed={collapsed.has(`file:${g}`)}
                      onToggle={() => toggleCollapsed(`file:${g}`)}
                    >
                      {f.lines.map((l, i) => {
                        const key = rowKey({ kind: "file", group: g, hit: i });
                        return (
                          <button
                            type="button"
                            key={i}
                            data-row={key}
                            className={styles.row + (key === selKey ? " " + styles.rowSel : "")}
                            onMouseEnter={() => setSel(rows.findIndex((r) => rowKey(r) === key))}
                            onClick={() => openRow({ kind: "file", group: g, hit: i })}
                          >
                            <span className={styles.lineNo}>{l.line}</span>
                            <Preview text={l.preview} ranges={l.ranges} mono />
                          </button>
                        );
                      })}
                      {f.match_count > f.lines.length ? (
                        <div className={styles.more}>+{plural(f.match_count - f.lines.length, "more match", "more matches")}</div>
                      ) : null}
                    </FileGroup>
                  ))}
                </Section>
              ) : null}
            </>
          )}
        </div>

        {/* ---- status ---- */}
        <StatusLine result={ready ? result : null} conversations={s.conversations} files={s.files} />
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

/** Keep the caret in the query box when a setting is clicked: the panel is keyboard-driven, and a
 *  focused toggle would take the next ↵ (toggling itself) instead of opening the selected result. */
const keepQueryFocus = (e: MouseEvent) => e.preventDefault();

function Check({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={styles.check + (on ? " " + styles.checkOn : "")}
      aria-pressed={on}
      onMouseDown={keepQueryFocus}
      onClick={onClick}
    >
      <span className={styles.box} aria-hidden="true">
        {on ? <Ico name="check" /> : null}
      </span>
      {children}
    </button>
  );
}

function Section({
  title,
  sub,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  sub: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <button type="button" className={styles.sectionHead} onClick={onToggle} aria-expanded={!collapsed}>
        <span className={styles.chev + (collapsed ? " " + styles.chevClosed : "")}>
          <Ico name="chev" className="sm" />
        </span>
        <span className={styles.sectionTitle}>{title}</span>
        <span className={styles.sectionSub}>{sub}</span>
      </button>
      {collapsed ? null : children}
    </section>
  );
}

function ConvGroup({
  conv,
  now,
  collapsed,
  onToggle,
  children,
}: {
  conv: ConversationHits;
  now: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const label = conv.title?.trim() || conv.excerpt.trim() || conv.session_id;
  return (
    <div className={styles.group}>
      <button type="button" className={styles.groupHead} onClick={onToggle} aria-expanded={!collapsed} title={conv.cwd}>
        <span className={styles.chev + (collapsed ? " " + styles.chevClosed : "")}>
          <Ico name="chev" className="sm" />
        </span>
        <BackendMark kind={conv.backend} className={styles.mark} />
        <span className={styles.groupName}>{label}</span>
        <span className={styles.groupMeta}>
          {repoName(conv.repo_root)} · {timeAgo(conv.mtime_ms, now)}
        </span>
        <span className={styles.badge}>{conv.match_count}</span>
      </button>
      {collapsed ? null : children}
    </div>
  );
}

function FileGroup({
  file,
  showRoot,
  collapsed,
  onToggle,
  children,
}: {
  file: FileHits;
  showRoot: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { dir, name } = splitPath(file.rel_path);
  return (
    <div className={styles.group}>
      <button type="button" className={styles.groupHead} onClick={onToggle} aria-expanded={!collapsed} title={file.path}>
        <span className={styles.chev + (collapsed ? " " + styles.chevClosed : "")}>
          <Ico name="chev" className="sm" />
        </span>
        <Ico name="file" className={"sm " + styles.fileIco} />
        <span className={styles.groupName}>{name}</span>
        <span className={styles.groupMeta}>
          {showRoot ? `${repoName(file.root)} · ` : ""}
          {dir}
        </span>
        <span className={styles.badge}>{file.match_count}</span>
      </button>
      {collapsed ? null : children}
    </div>
  );
}

function Preview({ text, ranges, mono = false }: { text: string; ranges: { start: number; end: number }[]; mono?: boolean }) {
  const segs = highlightSegments(text, ranges);
  return (
    <span className={styles.preview + (mono ? " " + styles.previewMono : "")}>
      {segs.map((seg, i) =>
        seg.hit ? (
          <mark key={i} className={styles.hit}>
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

/** What the search covered, and everything that limited it — never left implicit. */
function StatusLine({
  result,
  conversations,
  files,
}: {
  result: GlobalSearchResult | null;
  conversations: boolean;
  files: boolean;
}) {
  if (!result) return <div className={styles.status} />;
  const parts: ReactNode[] = [];
  if (files) parts.push(<span key="f">{plural(result.files_scanned, "file")} searched</span>);
  if (conversations) parts.push(<span key="c">{plural(result.conversations_scanned, "conversation")} searched</span>);
  parts.push(<span key="t">{(result.elapsed_ms / 1000).toFixed(result.elapsed_ms < 10_000 ? 2 : 1)} s</span>);
  const warnings: string[] = [];
  if (result.files_truncated) warnings.push("File results were cut short (too many matches or the time limit) — narrow the search.");
  if (result.conversations_truncated)
    warnings.push("Conversation results were cut short (too many matches or the time limit) — narrow the search.");
  if (result.unreadable_files > 0) warnings.push(`${plural(result.unreadable_files, "file")} could not be read.`);
  if (result.unreadable_conversations > 0)
    warnings.push(`${plural(result.unreadable_conversations, "conversation")} could not be read (they may hold matches).`);
  if (result.large_files_skipped > 0) warnings.push(`${plural(result.large_files_skipped, "file")} over 4 MB skipped.`);
  for (const r of result.skipped_roots) warnings.push(`${repoName(r.path)}: ${r.reason}`);
  return (
    <div className={styles.status}>
      <span className={styles.statusMain}>{parts.reduce<ReactNode[]>((acc, p, i) => (i ? [...acc, " · ", p] : [p]), [])}</span>
      {warnings.length ? (
        <span className={styles.statusWarn} title={warnings.join("\n")}>
          <Ico name="alert" className="sm" />
          {warnings[0]}
          {warnings.length > 1 ? ` (+${warnings.length - 1})` : ""}
        </span>
      ) : null}
      <span className={styles.statusKeys}>↑↓ navigate · ↵ open · Esc close</span>
    </div>
  );
}
