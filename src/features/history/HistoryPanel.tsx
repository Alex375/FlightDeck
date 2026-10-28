// Conversation-history search panel — a single global modal (mounted once in App,
// opened from the sidebar search bar). Lists EVERY conversation found on disk — this
// Mac's and each paired server's (including ones the app forgot — "orphans", and a
// server's conversations closed here, archived on its daemon) — grouped by folder, with
// a smart search, a read-only preview, and one-click reactivation back into the sidebar.
//
// Performance (Option A): on open we list this Mac's rows from a cheap head-read
// (instant) and prime the heavier search index in the background; each server is listed
// in parallel (one pre-filtered, cached ssh round trip) and its rows join the list as
// they land — never blocking this Mac's. The full transcript is read only when a row is
// previewed — on the machine it lives on. All ordering/filtering is pure (historyView.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../../ipc/client";
import type { ConversationItem, DiskConversation, SearchHit } from "../../ipc/client";
import { Ico } from "../../ui/kit";
import {
  convMachineId,
  repoName,
  reactivateDiskConversation,
  useConversationsStore,
  useMachines,
} from "../../store/conversationsStore";
import { serverLabel } from "../../store/remoteGates";
import { BackendMark } from "../conversation/ConvMark";
import { SubAgentTranscript, userMarksFromItems } from "../conversation/SubAgentTranscript";
import { MessageMinimap } from "../conversation/MessageMinimap";
import { userMessagePreviewText } from "../conversation/userText";
import { fileReadErrorText } from "../conversation/remoteRead";
import { MACHINE } from "../../ui/platform";
import { useHistoryUi } from "./historyUiStore";
import {
  applySearch,
  listingOf,
  filterConversations,
  groupByRepoRoot,
  mergeListings,
  repoKey,
  rowKey,
  serverNotices,
  timeAgo,
  type Period,
  type ServerListing,
} from "./historyView";
import styles from "./HistoryPanel.module.css";

/** No saved message summaries for a disk conversation — the cache is keyed by the app's
 *  conversation id, which a conversation still only on disk does not have. Module-level so
 *  the identity is stable across renders. */
const NO_SUMMARIES: Record<string, string> = {};

const PERIODS: { key: Period; label: string }[] = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

export function HistoryPanel() {
  const open = useHistoryUi((s) => s.open);
  const close = useHistoryUi((s) => s.closePanel);
  const machines = useMachines();

  const [localConvs, setLocalConvs] = useState<DiskConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  // Each paired server's rows and where its listing stands, by machine id.
  const [serverRows, setServerRows] = useState<Record<string, DiskConversation[]>>({});
  const [listings, setListings] = useState<Record<string, ServerListing>>({});

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const reqId = useRef(0);

  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("all");
  const [selected, setSelected] = useState<DiskConversation | null>(null);

  // Conversations already in the app — mark those rows as "already present". A row is the
  // pair (machine, session), so is the match.
  const conversations = useConversationsStore((s) => s.conversations);
  const repos = useConversationsStore((s) => s.repos);
  const existingKeys = useMemo(() => {
    const s = { conversations, repos };
    return new Set(
      conversations
        .filter((c) => !!c.sessionId)
        .map((c) => rowKey({ session_id: c.sessionId!, machine_id: convMachineId(s, c.id) })),
    );
  }, [conversations, repos]);

  // Which panel opening the results in flight belong to: a listing that lands after the panel
  // closed (or re-opened) is dropped.
  const openGen = useRef(0);
  // The servers already asked during this opening.
  const askedServers = useRef(new Set<string>());

  // On open: reset, list this Mac's rows (cheap head-read, instant) + warm the search index
  // in the background. On close we keep nothing — a fresh open re-scans (a server's listing is
  // incremental: only what changed is read).
  useEffect(() => {
    if (!open) return;
    const gen = ++openGen.current;
    askedServers.current = new Set();
    // The panel stays mounted while closed: last opening's rows must not pass for current ones.
    setLocalConvs([]);
    setLoading(true);
    setError(null);
    setSelected(null);
    setQuery("");
    setHits(null);
    setRepoFilter(null);
    setPeriod("all");
    setNow(Date.now());
    setServerRows({});
    setListings({});
    void commands.listDiskConversations().then(
      (res) => {
        if (gen !== openGen.current) return;
        if (res.status === "ok") setLocalConvs(res.data);
        else {
          setLocalConvs([]);
          setError(res.error);
        }
        setLoading(false);
      },
      (e: unknown) => {
        if (gen !== openGen.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    // Background prime so search is armed a beat after the list shows (Option A).
    void commands.primeHistoryIndex();
    return () => {
      openGen.current++;
    };
  }, [open]);

  // Every paired server is listed in parallel, each landing on its own — including one paired
  // (or loaded) after the panel opened: a server is never just absent without a word.
  const machineIds = machines.map((m) => m.id).join("\u0000");
  useEffect(() => {
    if (!open) return;
    const gen = openGen.current;
    for (const m of useConversationsStore.getState().machines) {
      if (askedServers.current.has(m.id)) continue;
      askedServers.current.add(m.id);
      setListings((l) => ({ ...l, [m.id]: { status: "loading" } }));
      void commands.listServerConversations(m.id).then(
        (res) => {
          if (gen !== openGen.current) return;
          if (res.status === "ok") {
            setServerRows((s) => ({ ...s, [m.id]: res.data.conversations }));
            setListings((l) => ({ ...l, [m.id]: listingOf(res.data) }));
          } else {
            console.error(`listServerConversations(${m.id}) failed:`, res.error);
            setListings((l) => ({ ...l, [m.id]: { status: "error", error: res.error } }));
          }
        },
        (e: unknown) => {
          if (gen !== openGen.current) return;
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`listServerConversations(${m.id}) threw:`, e);
          setListings((l) => ({ ...l, [m.id]: { status: "error", error: { kind: "io", server: m.label, reason } } }));
        },
      );
    }
  }, [open, machineIds]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // How many servers have landed: the search re-runs as each one does, so a query typed
  // before a server answered also ranks that server's conversations once they are in.
  const serversLanded = Object.keys(serverRows).length;

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
  }, [query, serversLanded]);

  // Keep relative labels + the period-filter boundaries fresh while the panel stays
  // open (otherwise `now` is frozen at open time).
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [open]);

  // Preview: full transcript of the selected conversation (read-only render).
  // `previewCol` is the positioned host for the message minimap and `previewBody` its scroll
  // container — the same pairing the live conversation uses (pane + thread).
  const previewColRef = useRef<HTMLDivElement>(null);
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<ConversationItem[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewMarks = useMemo(() => (preview ? userMarksFromItems(preview) : []), [preview]);
  const selectedKey = selected ? rowKey(selected) : null;
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
    // Read the cold history where it lives and from the backend that wrote it: a server's
    // transcript is read ON that server; on this Mac, a Codex row parses its `~/.codex`
    // rollout (`codexLoadHistory`), a Claude row its transcript. Routing by the row's own
    // `machine_id` / `backend` is required — the preview runs before reactivation, so there's
    // no store conversation yet to carry either.
    const machineId = selected.machine_id;
    const load = machineId
      ? commands.loadServerSessionHistory(machineId, selected.session_id).then((res) =>
          res.status === "ok"
            ? res
            : { status: "error" as const, error: fileReadErrorText(res.error) },
        )
      : selected.backend === "codex"
        ? commands.codexLoadHistory(selected.session_id)
        : commands.loadSessionHistory(selected.session_id);
    void load.then(
      (res) => {
        if (!alive) return;
        // Distinguish a read failure from a genuinely empty transcript (don't render an
        // error as "no readable messages").
        if (res.status === "ok") setPreview(res.data);
        else setPreviewError(res.error);
        setPreviewLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setPreviewError(e instanceof Error ? e.message : String(e));
        setPreviewLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const convs = useMemo(
    () => mergeListings(localConvs, machines.map((m) => serverRows[m.id] ?? [])),
    [localConvs, serverRows, machines],
  );
  const filtered = useMemo(
    () => filterConversations(convs, { repoKey: repoFilter, period, now }),
    [convs, repoFilter, period, now],
  );
  const ranked = useMemo(() => (hits ? applySearch(filtered, hits) : null), [hits, filtered]);
  const groups = useMemo(() => (ranked ? null : groupByRepoRoot(filtered)), [ranked, filtered]);
  const notices = useMemo(() => serverNotices(machines, listings), [machines, listings]);

  const repoOptions = useMemo(() => {
    const counts = new Map<string, { root: string; machineId: string | null; count: number }>();
    for (const c of convs) {
      const key = repoKey(c);
      const held = counts.get(key);
      if (held) held.count += 1;
      else counts.set(key, { root: c.repo_root, machineId: c.machine_id ?? null, count: 1 });
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [convs]);

  if (!open) return null;

  const reactivate = (d: DiskConversation) => {
    reactivateDiskConversation(d);
    close();
  };

  const totalShown = ranked ? ranked.length : filtered.length;
  const nameOf = (machineId: string) => serverLabel(machines, machineId);

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
                // ⌘F while this panel is open lands here (find/findStore.ts routeFind).
                data-find-input=""
                onChange={(e) => setQuery(e.target.value)}
              />
              {searching ? <Ico name="refresh" className={"sm " + styles.spin} /> : null}
            </div>

            <div className={styles.filters}>
              <select
                className={styles.repoSelect}
                value={repoFilter ?? ""}
                onChange={(e) => setRepoFilter(e.target.value || null)}
                title="Filter by repository"
              >
                <option value="">All repositories</option>
                {repoOptions.map(([key, o]) => (
                  <option key={key} value={key}>
                    {repoName(o.root)}
                    {o.machineId ? ` · ${nameOf(o.machineId)}` : ""} ({o.count})
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

            {/* Each server that is still loading, out of reach, cut short or holding
                transcripts it could not read says so — its conversations are never just
                missing from the list without a word. */}
            {notices.length > 0 ? (
              <div className={styles.serverNotices}>
                {notices.map((n, i) => (
                  <div
                    key={`${n.machineId}-${i}`}
                    className={n.tone === "error" ? `${styles.serverNotice} ${styles.serverNoticeErr}` : styles.serverNotice}
                  >
                    <Ico name={n.tone === "error" ? "serverOff" : "server"} className="sm" />
                    <span>{n.text}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className={styles.list}>
              {/* This Mac's listing failing (or still running) says so — without hiding the
                  rows the servers already brought. */}
              {error ? (
                <div className={styles.error}>Unable to list this {MACHINE}'s conversations: {error}</div>
              ) : loading && convs.length > 0 ? (
                <div className={styles.empty}>Reading this {MACHINE}'s conversations…</div>
              ) : null}
              {loading && convs.length === 0 ? (
                <div className={styles.empty}>Reading conversations from disk…</div>
              ) : searchError ? (
                <div className={styles.error}>Search failed: {searchError}</div>
              ) : totalShown === 0 ? (
                error && !query.trim() ? null : (
                  <div className={styles.empty}>
                    {query.trim()
                      ? `No results for "${query.trim()}".`
                      : "No conversations found on disk."}
                  </div>
                )
              ) : ranked ? (
                // Search active → flat ranked list (with repo label + snippet).
                ranked.map(({ conv, snippet }) => (
                  <Row
                    key={rowKey(conv)}
                    conv={conv}
                    snippet={snippet}
                    showRepo
                    server={conv.machine_id ? nameOf(conv.machine_id) : null}
                    now={now}
                    selected={selectedKey === rowKey(conv)}
                    present={existingKeys.has(rowKey(conv))}
                    onClick={() => setSelected(conv)}
                  />
                ))
              ) : (
                // No search → grouped by folder, recency-ordered.
                groups!.map((g) => (
                  <div key={g.key} className={styles.group}>
                    <div className={styles.groupH}>
                      <Ico name={g.machineId ? "server" : "folder"} className="sm" />
                      <span className={styles.groupName}>{repoName(g.repoRoot)}</span>
                      {g.machineId ? <ServerTag name={nameOf(g.machineId)} /> : null}
                      <span className={styles.groupCount}>{g.conversations.length}</span>
                    </div>
                    {g.conversations.map((conv) => (
                      <Row
                        key={rowKey(conv)}
                        conv={conv}
                        server={conv.machine_id ? nameOf(conv.machine_id) : null}
                        now={now}
                        selected={selectedKey === rowKey(conv)}
                        present={existingKeys.has(rowKey(conv))}
                        onClick={() => setSelected(conv)}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ---- Right: preview + reactivate ---- */}
          <div className={styles.previewCol} ref={previewColRef}>
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
                    {selected.machine_id ? (
                      <>
                        <ServerTag name={nameOf(selected.machine_id)} />
                        <span className={styles.metaSep}>·</span>
                      </>
                    ) : null}
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
                      existingKeys.has(rowKey(selected))
                        ? "This conversation is already in the app — open it"
                        : selected.machine_id
                          ? `Add this conversation to the sidebar — it resumes on ${nameOf(selected.machine_id)}`
                          : "Add this conversation to the sidebar"
                    }
                  >
                    <Ico name="plus" className="sm" />
                    {existingKeys.has(rowKey(selected)) ? "Open" : "Add conversation"}
                  </button>
                </div>
                <div className={styles.previewBody} ref={previewBodyRef}>
                  {previewLoading ? (
                    <div className={styles.previewEmpty}>
                      {selected.machine_id
                        ? `Loading the transcript from ${nameOf(selected.machine_id)}…`
                        : "Loading transcript…"}
                    </div>
                  ) : previewError ? (
                    <div className={styles.error}>
                      Unable to load transcript: {previewError}
                    </div>
                  ) : preview && preview.length > 0 ? (
                    <SubAgentTranscript
                      items={preview}
                      goalAware={selected.backend !== "codex"}
                    />
                  ) : (
                    <div className={styles.previewEmpty}>
                      This conversation has no readable messages.
                    </div>
                  )}
                </div>
                {/* Same minimap as the live conversation, over the preview's right edge.
                    No saved summaries to offer: those are keyed by the app's conversation
                    id, and a conversation still on disk has none — the marks fall back to
                    each message's first line, which is what the preview can honestly show. */}
                {preview && preview.length > 0 ? (
                  <MessageMinimap
                    marks={previewMarks}
                    summaries={NO_SUMMARIES}
                    hostRef={previewColRef}
                    scrollRef={previewBodyRef}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The server a row's conversation lives on — its NAME, like the backend mark says which agent
 *  ran it. This Mac's rows carry none (local is the unmarked default). */
function ServerTag({ name }: { name: string }) {
  return (
    <span className={styles.serverTag} title={`On ${name}`}>
      <Ico name="server" className="sm" />
      <span className={styles.repoTagName}>{name}</span>
    </span>
  );
}

function Row({
  conv,
  snippet,
  showRepo,
  server,
  now,
  selected,
  present,
  onClick,
}: {
  conv: DiskConversation;
  snippet?: string;
  showRepo?: boolean;
  /** The server's name when the conversation lives on one, `null` on this Mac. */
  server: string | null;
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
        {server ? <ServerTag name={server} /> : null}
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
