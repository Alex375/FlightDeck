// Conversation-history search panel — a single global modal (mounted once in App,
// opened from the sidebar search bar). Lists EVERY conversation found on disk
// (including ones the app forgot — "orphans"), grouped by repo, with a smart search,
// a read-only preview, and one-click reactivation back into the sidebar.
//
// Performance (Option A): on open we list rows from a cheap head-read (instant) and
// prime the heavier search index in the background; the full transcript is read only
// when a row is previewed. All ordering/filtering is pure (see historyView.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../ipc/client";
import type { ConversationItem, DiskConversation, SearchHit } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import { repoName, reactivateDiskConversation, useConversationsStore } from "../../store/conversationsStore";
import { BackendMark } from "../conversation/ConvMark";
import { SubAgentTranscript } from "../conversation/SubAgentTranscript";
import { userMessagePreviewText } from "../conversation/userText";
import { useHistoryUi } from "./historyUiStore";
import {
  applySearch,
  filterConversations,
  groupByRepoRoot,
  timeAgo,
  type Period,
} from "./historyView";
import styles from "./HistoryPanel.module.css";

const PERIODS: { key: Period; label: string }[] = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

export function HistoryPanel() {
  const open = useHistoryUi((s) => s.open);
  const close = useHistoryUi((s) => s.closePanel);

  const [convs, setConvs] = useState<DiskConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const reqId = useRef(0);

  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("all");
  const [selected, setSelected] = useState<DiskConversation | null>(null);

  // Conversations already in the app — mark those rows as "already present".
  const conversations = useConversationsStore((s) => s.conversations);
  const existingIds = useMemo(
    () => new Set(conversations.map((c) => c.sessionId).filter((s): s is string => !!s)),
    [conversations],
  );

  // On open: reset, list rows (cheap head-read, instant) + warm the search index in
  // the background. On close we keep nothing — a fresh open re-scans disk.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setSelected(null);
    setQuery("");
    setHits(null);
    setRepoRoot(null);
    setPeriod("all");
    setNow(Date.now());
    void commands.listDiskConversations().then((res) => {
      if (!alive) return;
      if (res.status === "ok") setConvs(res.data);
      else setError(res.error);
      setLoading(false);
    });
    // Background prime so search is armed a beat after the list shows (Option A).
    void commands.primeHistoryIndex();
    return () => {
      alive = false;
    };
  }, [open]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Debounced search. Empty query → no search (the grouped recency view shows).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      // Bump the token so an ALREADY-fired request can't repopulate `hits` after the
      // box was cleared (its resolve guard would otherwise still match and resurrect
      // the ranked view over an empty query).
      reqId.current++;
      setHits(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const token = ++reqId.current;
    const t = setTimeout(() => {
      void commands.searchConversations(q).then((res) => {
        if (token !== reqId.current) return; // a newer query (or a clear) superseded this
        if (res.status === "ok") {
          setHits(res.data);
          setSearchError(null);
        } else {
          // Surface the failure (errors are never swallowed) and drop stale hits so a
          // previous query's matches aren't shown for this one.
          setSearchError(res.error);
          setHits(null);
        }
        setSearching(false);
      });
    }, 180);
    return () => clearTimeout(t);
  }, [query]);

  // Keep relative labels + the period-filter boundaries fresh while the panel stays
  // open (otherwise `now` is frozen at open time).
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  // Preview: full transcript of the selected conversation (read-only render).
  const [preview, setPreview] = useState<ConversationItem[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    setPreview(null);
    setPreviewError(null);
    // Read the cold history from the backend that wrote it: a Codex row parses its
    // `~/.codex` rollout (`codexLoadHistory`), a Claude row its transcript. Routing by the
    // row's own `backend` is required — the preview runs before reactivation, so there's no
    // store conversation yet to carry the kind.
    const load =
      selected.backend === "codex"
        ? commands.codexLoadHistory(selected.session_id)
        : commands.loadSessionHistory(selected.session_id);
    void load.then((res) => {
      if (!alive) return;
      // Distinguish a read failure from a genuinely empty transcript (don't render an
      // error as "no readable messages").
      if (res.status === "ok") setPreview(res.data);
      else setPreviewError(res.error);
      setPreviewLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [selected?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(
    () => filterConversations(convs, { repoRoot, period, now }),
    [convs, repoRoot, period, now],
  );
  const ranked = useMemo(() => (hits ? applySearch(filtered, hits) : null), [hits, filtered]);
  const groups = useMemo(() => (ranked ? null : groupByRepoRoot(filtered)), [ranked, filtered]);

  const repoOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of convs) counts.set(c.repo_root, (counts.get(c.repo_root) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [convs]);

  if (!open) return null;

  const reactivate = (d: DiskConversation) => {
    reactivateDiskConversation(d);
    close();
  };

  const totalShown = ranked ? ranked.length : filtered.length;

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="search" className="sm" />
          <span className={styles.title}>
            Conversation history
            <span className={styles.titleSub}>{totalShown} conversation(s)</span>
          </span>
          <button className={styles.iconBtn} onClick={close} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {/* ---- Left: search + filters + list ---- */}
          <div className={styles.listCol}>
            <div className={styles.searchRow}>
              <Ico name="search" className="sm" />
              <input
                className={styles.searchInput}
                placeholder="Search all conversations…"
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
              />
              {searching ? <Ico name="refresh" className={"sm " + styles.spin} /> : null}
            </div>

            <div className={styles.filters}>
              <select
                className={styles.repoSelect}
                value={repoRoot ?? ""}
                onChange={(e) => setRepoRoot(e.target.value || null)}
                title="Filter by repository"
              >
                <option value="">All repositories</option>
                {repoOptions.map(([root, count]) => (
                  <option key={root} value={root}>
                    {repoName(root)} ({count})
                  </option>
                ))}
              </select>
              <div className={styles.periodChips}>
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    className={p.key === period ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                    onClick={() => setPeriod(p.key)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.list}>
              {loading ? (
                <div className={styles.empty}>Reading conversations from disk…</div>
              ) : error ? (
                <div className={styles.error}>Unable to list conversations: {error}</div>
              ) : searchError ? (
                <div className={styles.error}>Search failed: {searchError}</div>
              ) : totalShown === 0 ? (
                <div className={styles.empty}>
                  {query.trim()
                    ? `No results for "${query.trim()}".`
                    : "No conversations found on disk."}
                </div>
              ) : ranked ? (
                // Search active → flat ranked list (with repo label + snippet).
                ranked.map(({ conv, snippet }) => (
                  <Row
                    key={conv.session_id}
                    conv={conv}
                    snippet={snippet}
                    showRepo
                    now={now}
                    selected={selected?.session_id === conv.session_id}
                    present={existingIds.has(conv.session_id)}
                    onClick={() => setSelected(conv)}
                  />
                ))
              ) : (
                // No search → grouped by repo, recency-ordered.
                groups!.map((g) => (
                  <div key={g.repoRoot} className={styles.group}>
                    <div className={styles.groupH}>
                      <Ico name="folder" className="sm" />
                      <span className={styles.groupName}>{repoName(g.repoRoot)}</span>
                      <span className={styles.groupCount}>{g.conversations.length}</span>
                    </div>
                    {g.conversations.map((conv) => (
                      <Row
                        key={conv.session_id}
                        conv={conv}
                        now={now}
                        selected={selected?.session_id === conv.session_id}
                        present={existingIds.has(conv.session_id)}
                        onClick={() => setSelected(conv)}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ---- Right: preview + reactivate ---- */}
          <div className={styles.previewCol}>
            {!selected ? (
              <div className={styles.previewEmpty}>
                Select a conversation to preview it.
              </div>
            ) : (
              <>
                <div className={styles.previewHead}>
                  <div className={styles.previewTitle}>
                    <span className={`${styles.backendBadge} ${styles.previewBadge}`}>
                      <BackendMark kind={selected.backend} />
                    </span>
                    {(selected.title ?? "").trim() ||
                      (selected.excerpt ? userMessagePreviewText(selected.excerpt) : "") ||
                      "Conversation"}
                  </div>
                  <div className={styles.previewMeta}>
                    <Ico name="folder" className="sm" />
                    <span>{repoName(selected.repo_root)}</span>
                    {selected.git_branch ? (
                      <>
                        <span className={styles.metaSep}>·</span>
                        <Ico name="branch" className="sm" />
                        <span>{selected.git_branch}</span>
                      </>
                    ) : null}
                    <span className={styles.metaSep}>·</span>
                    <span>{timeAgo(selected.mtime_ms, now)}</span>
                  </div>
                  <button
                    className={styles.reactivateBtn}
                    onClick={() => reactivate(selected)}
                    title={
                      existingIds.has(selected.session_id)
                        ? "This conversation is already in the app — open it"
                        : "Add this conversation to the sidebar"
                    }
                  >
                    <Ico name="plus" className="sm" />
                    {existingIds.has(selected.session_id) ? "Open" : "Add conversation"}
                  </button>
                </div>
                <div className={styles.previewBody}>
                  {previewLoading ? (
                    <div className={styles.previewEmpty}>Loading transcript…</div>
                  ) : previewError ? (
                    <div className={styles.error}>
                      Unable to load transcript: {previewError}
                    </div>
                  ) : preview && preview.length > 0 ? (
                    <SubAgentTranscript items={preview} />
                  ) : (
                    <div className={styles.previewEmpty}>
                      This conversation has no readable messages.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  conv,
  snippet,
  showRepo,
  now,
  selected,
  present,
  onClick,
}: {
  conv: DiskConversation;
  snippet?: string;
  showRepo?: boolean;
  now: number;
  selected: boolean;
  present: boolean;
  onClick: () => void;
}) {
  // Run the excerpt through the same cleanup the thread's own bubbles use: a first prompt
  // that was a slash command is stored WRAPPED (`<command-message>…<command-name>/foo…`),
  // and without this the raw tags become the row's label — and, for a conversation with no
  // ai-title, the name it is restored under.
  const excerpt = conv.excerpt ? userMessagePreviewText(conv.excerpt) : conv.excerpt;
  const label = (conv.title ?? "").trim() || excerpt || "Conversation";
  // In a title row, the excerpt is a useful second line; a search snippet (if any)
  // is more relevant than the generic excerpt.
  const second = (snippet && snippet.trim()) || excerpt;
  return (
    <button
      type="button"
      className={selected ? `${styles.row} ${styles.rowOn}` : styles.row}
      onClick={onClick}
    >
      <div className={styles.rowName}>
        <span className={styles.backendBadge} title={conv.backend === "codex" ? "Codex" : "Claude"}>
          <BackendMark kind={conv.backend} />
        </span>
        <span className={styles.rowTitle}>{label}</span>
        {present ? <span className={styles.presentTag}>already present</span> : null}
      </div>
      {second && second !== label ? <div className={styles.rowExcerpt}>{second}</div> : null}
      <div className={styles.rowMeta}>
        {showRepo ? (
          <span className={styles.repoTag} title={conv.repo_root}>
            <Ico name="folder" className="sm" />
            <span className={styles.repoTagName}>{repoName(conv.repo_root)}</span>
          </span>
        ) : null}
        <span>{timeAgo(conv.mtime_ms, now)}</span>
      </div>
    </button>
  );
}
