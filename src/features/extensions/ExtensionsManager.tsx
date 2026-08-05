// Extensions manager: a global modal with TWO DISTINCT lenses, chosen by the
// entry point that opened it (extensionsUiStore.target.kind):
//
//  - "project" (sidebar repo button): what is INSTALLED / available for the repo,
//    by scope — the configured inventory (on-disk scan). Plugins are toggle-able.
//  - "conversation" (composer chip): THIS session's LIVE picture. MCP servers with
//    real connection status + tools (from the `mcp_status` control request), plus
//    the plugins/skills/sub-agents active.
//
// Section order (both lenses): MCP servers → skills (file-based, from the repo) →
// sub-agents (file-based) → plugins. MCP servers are sorted into three ordered
// buckets — repo, plugin, cloud connectors — and within each bucket the
// connected/enabled ones come first (a sort that reads as sections).
//
// Interactions: an MCP row expands to reveal its tools; a file-based skill /
// sub-agent opens a clean markdown view of its SKILL.md / .md; a PLUGIN opens a
// 3-pane explorer (rail / list / detail) of its own skills / MCP / sub-agents,
// modelled on Claude.ai's Customize panel. See memory "extensions-two-distinct-views".
import type { UseMutationResult } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClaudeMark, CodexMark, Ico } from "../../ui/kit";
import { useCodexAvailable } from "../../store/binaryAvailable";
import { Toggle } from "../../ui/Toggle";
import { commands } from "../../ipc/client";
import { refetchSlashCommands } from "../../store/commandsStore";
import {
  useCheckPluginUpdates,
  useCodexExtensions,
  useCodexHooks,
  useCodexMarketplaceActions,
  useCodexPluginContents,
  useCodexPlugins,
  useCodexToggles,
  useExtensions,
  useExtensionDoc,
  useMarketplaces,
  useMcpActions,
  useMcpStatus,
  usePluginContents,
  useSetAllMarketplacesAutoUpdate,
  useSetMarketplaceAutoUpdate,
  useSetPluginEnabled,
  useUpdatePlugin,
} from "../../ipc/useExtensions";
import { useConversationsStore, type BackendKind, type Conversation } from "../../store/conversationsStore";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import type {
  AgentInfo,
  ExtScope,
  McpServerInfo,
  McpServerLive,
  PluginInfo,
  SkillInfo,
} from "../../ipc/client";
import { useExtensionsUi } from "./extensionsUiStore";
import { distinctCwds, resolveReloadTargets } from "./pluginReload";
import {
  allMarketplacesAuto,
  cliScope,
  totalUpdates,
  updateBadgeLabel,
  updatesForMarketplace,
} from "./pluginUpdates";
import styles from "./ExtensionsManager.module.css";

const CONFIG_SCOPE_LABEL: Record<ExtScope, string> = {
  user: "User",
  project: "Repo",
  local: "Local",
  plugin: "Plugin",
};

/** A skill / sub-agent doc to render in the standalone markdown viewer overlay. */
interface OpenDoc {
  name: string;
  source: string;
  path: string;
  description?: string | null;
}

/** Plugin NAME from a plugin id (`railway@claude-plugins-official` → `railway`). */
function pluginName(source: string): string {
  return source.split("@")[0] ?? source;
}

/**
 * Drop a leading YAML frontmatter block (`---` … `---`) from a SKILL.md / agent .md
 * before rendering its body. Without this, the closing `---` turns the `name:` /
 * `description:` lines above it into a setext heading — the garbled "table at the
 * top" the body would otherwise start with. The frontmatter fields are surfaced in
 * our own metadata strip instead (matching Claude.ai's Customize panel).
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  // First line must be exactly `---` (allow trailing CR); find the closing `---`.
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\s+/, "");
    }
  }
  return text; // no closing fence — leave it untouched
}

/** Badge class for a configured (on-disk) scope. */
function configBadgeCls(scope: ExtScope): string {
  return styles["scope_" + scope] ?? "";
}

/** Badge label + class for a LIVE scope string (from `mcp_status`). */
function liveBadge(scope: string | null | undefined): { label: string; cls: string } {
  switch (scope) {
    case "claudeai":
      return { label: "Claude connector", cls: styles.scope_connector };
    case "dynamic":
      return { label: "Plugin", cls: styles.scope_plugin };
    case "project":
      return { label: "Repo", cls: styles.scope_project };
    case "local":
      return { label: "Local", cls: "" };
    case "user":
      return { label: "User", cls: "" };
    default:
      return { label: scope ?? "—", cls: "" };
  }
}

/** Clear status word + dot tone for a live MCP status. */
/** Human label for a Codex MCP `failure_reason` (from the `mcpServer/startupStatus/updated`
 *  push). Unknown reasons fall back to the raw wire value so a new reason is never swallowed. */
function mcpFailureLabel(reason: string): string {
  switch (reason) {
    case "reauthenticationRequired":
      return "Re-authentication required";
    default:
      return reason;
  }
}

function statusInfo(status: string | null): { cls: string; label: string } {
  switch (status) {
    case "connected":
      return { cls: styles.sOk, label: "Connected" };
    case "pending":
    case "checking_status":
      return { cls: styles.sPending, label: "Connecting…" };
    case "needs-auth":
      return { cls: styles.sWarn, label: "Authentication required" };
    case "failed":
      return { cls: styles.sErr, label: "Failed" };
    case "disconnected":
      return { cls: styles.sOff, label: "Disconnected" };
    case "disabled":
      return { cls: styles.sOff, label: "Disabled" };
    default:
      return { cls: styles.sNone, label: status ?? "—" };
  }
}

/** Local (stdio) vs network (http/sse) connection, with a short detail. */
function connType(
  mcp: { transport: string | null; command: string | null; url: string | null },
): { kind: string; icon: string; detail: string } | null {
  if (mcp.url) {
    let host = mcp.url;
    try {
      host = new URL(mcp.url).host || mcp.url;
    } catch {
      /* keep the raw url */
    }
    return { kind: "Network", icon: "globe", detail: host };
  }
  if (mcp.command) return { kind: "Local", icon: "term", detail: mcp.command };
  if (mcp.transport) return { kind: mcp.transport, icon: "term", detail: "" };
  return null;
}

// ---- MCP buckets (the requested absolute sort) ---------------------------------

type McpBucket = "repo" | "user" | "plugin" | "connector";
// Plugin (`dynamic`) servers are intentionally NOT a live bucket — they're shown as
// "Provided by plugins" boxes instead (consistent with plugin skills/sub-agents),
// so they don't appear twice. Order: Repo → User → Cloud connectors.
const BUCKET_ORDER: McpBucket[] = ["repo", "user", "connector"];
const BUCKET_LABEL: Record<McpBucket, string> = {
  repo: "Repo",
  user: "User",
  plugin: "Plugin",
  connector: "Cloud connectors",
};

/** Live `mcp_status` scope → bucket. A `user`-scope server (global, e.g. a
 *  file-configured `playwright` in ~/.claude.json) is its OWN bucket — it is NOT
 *  repo-specific, so it must not read as "Repo". `dynamic` (plugin) servers map to
 *  "plugin" but that bucket isn't in BUCKET_ORDER → they're dropped from the live
 *  list and surfaced via the plugin boxes instead. */
function liveBucket(scope: string | null | undefined): McpBucket {
  if (scope === "claudeai") return "connector";
  if (scope === "dynamic") return "plugin";
  if (scope === "user") return "user";
  return "repo"; // project / local
}

interface McpGroup<T> {
  bucket: McpBucket;
  items: T[];
}

/** Connected/enabled first inside a bucket, then by name. */
function liveRank(status: string): number {
  return status === "connected" ? 0 : status === "needs-auth" ? 1 : status === "pending" || status === "checking_status" ? 2 : 3;
}

/** Partition servers into buckets, PRESERVING input order (the caller freezes the
 *  order at window-open via `useStableOrder`). No re-sort here — so toggling a server
 *  doesn't make it jump within its bucket. Empty buckets are dropped. */
function bucketizeLive(servers: McpServerLive[]): McpGroup<McpServerLive>[] {
  return BUCKET_ORDER.map((bucket) => ({
    bucket,
    items: servers.filter((m) => liveBucket(m.scope) === bucket),
  })).filter((g) => g.items.length > 0);
}

/**
 * Freeze a list's order at window-open, then keep it STABLE across re-renders so
 * toggling an item (enable/disable) doesn't reorder the list under the user's cursor.
 * The order is computed ONCE (by `rank`, lower first) the first time items arrive for
 * a given `resetToken`, then every later render arranges the current items by that
 * frozen position (unseen items go after, by key). Reopening the window (new token)
 * recomputes. Live state (enabled/status) keeps updating in place — only the ORDER
 * is frozen.
 */
function useStableOrder<T>(
  items: T[],
  key: (x: T) => string,
  rank: (x: T) => number,
  resetToken: string,
): T[] {
  const ref = useRef<{ token: string | null; keys: string[] }>({ token: null, keys: [] });
  if (ref.current.token !== resetToken) {
    ref.current = { token: resetToken, keys: [] }; // window (re)opened → refreeze
  }
  if (ref.current.keys.length === 0 && items.length > 0) {
    ref.current.keys = [...items]
      .sort((a, b) => rank(a) - rank(b) || key(a).localeCompare(key(b)))
      .map(key);
  }
  const order = ref.current.keys;
  const pos = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i; // items unseen at freeze-time go last
  };
  return [...items].sort((a, b) => pos(key(a)) - pos(key(b)) || key(a).localeCompare(key(b)));
}

interface Group<T> {
  key: string;
  label: string;
  isPlugin: boolean;
  items: T[];
}

/** Group file-based skills/sub-agents by their scope (Project / User). Plugin
 *  items are excluded upstream — they live in the per-plugin explorer instead. */
function groupBySource<T extends { source: string | null; scope: ExtScope }>(items: T[]): Group<T>[] {
  const map = new Map<string, Group<T>>();
  for (const it of items) {
    const key = it.source ?? `scope:${it.scope}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label: it.source ? pluginName(it.source) : CONFIG_SCOPE_LABEL[it.scope],
        isPlugin: it.source != null,
        items: [],
      };
      map.set(key, g);
    }
    g.items.push(it);
  }
  return [...map.values()].sort((a, b) => {
    if (a.isPlugin !== b.isPlugin) return a.isPlugin ? 1 : -1; // file-based first
    return a.label.localeCompare(b.label);
  });
}

export function ExtensionsManager() {
  const target = useExtensionsUi((s) => s.target);
  const close = useExtensionsUi((s) => s.closeManager);
  const handle = useConversationsStore((s) =>
    target?.kind === "conversation" && target.session
      ? (s.conversations.find((c) => c.id === target.session)?.handle ?? null)
      : null,
  );
  const codexAvailable = useCodexAvailable();
  // Which backend's extensions are shown. Tabs let the user flip between Claude and Codex;
  // the default is the target's OWN backend (a Codex conversation opens on the Codex tab).
  // Reset to that default whenever the target changes (see the open effect below).
  const [activeTab, setActiveTab] = useState<BackendKind>(target?.backend ?? "claude");
  // BOTH inventories are fetched so either tab renders instantly. `ext` = Claude's on-disk
  // config for the path; `codexExt` = Codex's account-global `~/.codex` config. `live` MCP
  // is the conversation's REAL session (Claude or Codex — the Codex actor answers
  // `mcp_status` via `mcpServerStatus/list`), only meaningful on the tab matching that backend.
  const ext = useExtensions(target?.path ?? null);
  const live = useMcpStatus(handle);
  const codexExt = useCodexExtensions(codexAvailable, target?.path ?? null);
  const setPluginEnabled = useSetPluginEnabled(target?.path ?? null);
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  // The plugin explorer carries WHICH section to open at (a contribution box jumps
  // straight to skills / mcp / agents). `codexMeta` (Extensions v2) marks a CODEX
  // plugin: the explorer then reads its contents via `plugin/read` instead of the
  // Claude plugin cache.
  const [pluginView, setPluginView] = useState<{
    plugin: PluginInfo;
    section: ExplorerSectionKey;
    codexMeta?: { pluginName: string; marketplacePath: string | null };
  } | null>(null);
  // The Marketplaces page (auto-update management), reached from the Plugins section.
  const [mktOpen, setMktOpen] = useState(false);
  const openPlugin = (p: PluginInfo, section: ExplorerSectionKey = "skills") =>
    setPluginView({ plugin: p, section });
  const openCodexPlugin = (p: PluginInfo, codexMeta: { pluginName: string; marketplacePath: string | null }) =>
    setPluginView({ plugin: p, section: "skills", codexMeta });

  // ---- Live plugin-reload bar --------------------------------------------------
  // Toggling a plugin only writes settings.json (USER-GLOBAL). A RUNNING session
  // reads `enabledPlugins` at spawn, so the change would otherwise take effect only
  // on restart — and the `/` command menu never refreshes. So we collect the toggles
  // made while the manager is open and offer to hot-apply them to the repo's LIVE
  // conversations: `reload_plugins` re-scans the plugin ON the live session (its
  // skills included — VERIFIED live against the binary), and `refetchSlashCommands`
  // re-reads the disk so the `/` menu (dis)appears the plugin's commands. Grouped:
  // N toggles → one reload. The bar shows only when ≥1 live conversation exists.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [reloading, setReloading] = useState(false);
  const allConvs = useConversationsStore((s) => s.conversations);
  const allRepos = useConversationsStore((s) => s.repos);
  const { liveConvs, currentConv } = useMemo(
    () => resolveReloadTargets(target, allConvs, allRepos),
    [target, allConvs, allRepos],
  );

  // The toggle's settings.json write is async (a mutation). Track those writes so a
  // reload can wait for them to land before the live sessions re-read disk — else a
  // fast click on the bar could race the toggle's own write.
  const pendingWrites = useRef<Promise<unknown>[]>([]);
  const onPluginToggle = (pluginId: string, enabled: boolean) => {
    pendingWrites.current.push(setPluginEnabled.mutateAsync({ pluginId, enabled }).catch(() => {}));
    setTouched((prev) => (prev.has(pluginId) ? prev : new Set(prev).add(pluginId)));
  };
  const applyReload = async (convs: Conversation[]) => {
    setReloading(true);
    try {
      // 1. Make sure every pending settings.json write has landed on disk.
      await Promise.allSettled(pendingWrites.current);
      pendingWrites.current = [];
      // 2. Layer 1 (live capability): hot-reload plugins on each live session. Best-effort
      //    — a dead session ("unknown session") is harmless (reads it on its next spawn).
      await Promise.all(
        convs.map(async (c) => {
          if (!c.handle) return;
          try {
            await commands.reloadPlugins(c.handle);
          } catch {
            /* applies on next spawn */
          }
        }),
      );
      // 3. Layer 2 (`/` menu): refresh the catalogue once per DISTINCT effective cwd
      //    (worktree-aware) — several sessions can share a cwd.
      await Promise.all(distinctCwds(convs).map((cwd) => refetchSlashCommands(cwd)));
    } finally {
      setReloading(false);
      setTouched(new Set());
    }
  };

  // Force a fresh read every time the manager OPENS (target set / changed). Without
  // this, reopening within the query's staleTime shows the cached snapshot — the
  // user expects an up-to-date picture on each open. The live MCP status also polls
  // on its own every 4s while open; this covers the configured snapshot.
  const refetchExt = ext.refetch;
  const refetchLive = live.refetch;
  const refetchCodexExt = codexExt.refetch;
  const defaultTab = target?.backend ?? "claude";
  const openKey = target ? `${target.backend}:${target.kind}:${target.path}:${target.session ?? ""}` : null;
  useEffect(() => {
    if (!openKey) return;
    // Land on the target's own backend, and refetch both inventories + the live status.
    setActiveTab(defaultTab);
    void refetchExt();
    if (codexAvailable) void refetchCodexExt();
    if (handle) void refetchLive();
    // A fresh open starts with no pending plugin toggles.
    setTouched(new Set());
    pendingWrites.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  if (!target) return null;
  const isConversation = target.kind === "conversation";
  // The backend of the conversation's LIVE session (null for a repo/project target). The
  // live lens (ConversationBody / Codex live MCP) is shown only on the matching tab; the
  // other tab shows that backend's CONFIGURED inventory (project-style, no live process).
  const liveBackend: BackendKind | null = isConversation ? target.backend : null;
  const onCodexTab = activeTab === "codex";
  // Which query the header refresh + spinner track (the active tab's inventory + any live).
  const tabFetching = onCodexTab ? codexExt.isFetching : ext.isFetching;
  const liveFetching = isConversation && activeTab === liveBackend && live.isFetching;

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name={isConversation ? "chat" : "layers"} className="sm" />
          <span className={styles.title}>
            {isConversation ? "Conversation extensions" : "Repository extensions"}
            <span className={styles.titleSub}>{target.title}</span>
          </span>
          <button
            className={styles.iconBtn}
            onClick={() => {
              // Refresh the ACTIVE tab's configured snapshot AND (when it's the live tab)
              // the live MCP status, so a failed query can be retried from here.
              if (onCodexTab) void codexExt.refetch();
              else void ext.refetch();
              if (liveFetching || (isConversation && activeTab === liveBackend)) void live.refetch();
            }}
            disabled={tabFetching || liveFetching}
            title="Refresh"
            aria-label="Refresh"
          >
            <Ico name="refresh" className={"sm" + (tabFetching || liveFetching ? " " + styles.spin : "")} />
          </button>
          <button className={styles.iconBtn} onClick={close} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        {/* Hot-apply plugin toggles to live conversations (Claude — Codex plugins are
            read-only). Self-gates on `touched`, which only Claude plugin toggles populate,
            so it never shows on the Codex tab. */}
        {touched.size > 0 && liveConvs.length > 0 ? (
          <PluginReloadBar
            count={touched.size}
            liveCount={liveConvs.length}
            hasCurrent={currentConv != null}
            busy={reloading}
            onReloadCurrent={() => currentConv && void applyReload([currentConv])}
            onReloadAll={() => void applyReload(liveConvs)}
            onDismiss={() => setTouched(new Set())}
          />
        ) : null}

        {/* Backend tabs — only when Codex is installed. Lets the user see BOTH backends'
            extensions; defaults to the target's own backend. */}
        {codexAvailable ? (
          <div className={styles.tabBar} role="tablist" aria-label="Extensions backend">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "claude"}
              className={styles.tabBtn + (activeTab === "claude" ? " " + styles.tabOn : "")}
              onClick={() => setActiveTab("claude")}
            >
              <ClaudeMark className={"sm " + styles.tabMarkClaude} /> Claude
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "codex"}
              className={styles.tabBtn + (activeTab === "codex" ? " " + styles.tabOn : "")}
              onClick={() => setActiveTab("codex")}
            >
              <CodexMark className={"sm " + styles.tabMarkCodex} /> Codex
            </button>
          </div>
        ) : null}

        {onCodexTab ? (
          <CodexExtensionsBody
            codexExt={codexExt}
            live={live}
            // Live MCP only when a session is actually running (a lazily-spawned Codex conv
            // has no handle yet). Otherwise show the CONFIGURED ~/.codex servers, never an
            // empty "live" list that reads as "no MCP servers".
            showLive={liveBackend === "codex" && handle != null}
            cwd={target.path}
            onOpenDoc={setDoc}
            onOpenPlugin={openCodexPlugin}
          />
        ) : liveBackend === "claude" ? (
          <ConversationBody
            ext={ext}
            live={live}
            handle={handle}
            path={target.path}
            setPluginEnabled={setPluginEnabled}
            onPluginToggle={onPluginToggle}
            onOpenDoc={setDoc}
            onOpenPlugin={openPlugin}
            onOpenMarketplaces={() => setMktOpen(true)}
            resetToken={openKey ?? ""}
          />
        ) : (
          <ProjectBody
            ext={ext}
            path={target.path}
            setPluginEnabled={setPluginEnabled}
            onPluginToggle={onPluginToggle}
            onOpenDoc={setDoc}
            onOpenPlugin={openPlugin}
            onOpenMarketplaces={() => setMktOpen(true)}
          />
        )}
      </div>

      {pluginView ? (
        <PluginExplorer
          plugin={pluginView.plugin}
          initialSection={pluginView.section}
          repoPath={target.path}
          codexMeta={pluginView.codexMeta ?? null}
          onClose={() => setPluginView(null)}
        />
      ) : null}
      {doc ? <DocViewer doc={doc} onClose={() => setDoc(null)} /> : null}
      {mktOpen ? (
        <MarketplacesPage
          path={target.path}
          plugins={ext.data?.plugins ?? []}
          onClose={() => setMktOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ---- Project view: configured inventory by scope -------------------------------

function ProjectBody({
  ext,
  path,
  setPluginEnabled,
  onPluginToggle,
  onOpenDoc,
  onOpenPlugin,
  onOpenMarketplaces,
}: {
  ext: ReturnType<typeof useExtensions>;
  path: string;
  setPluginEnabled: ReturnType<typeof useSetPluginEnabled>;
  onPluginToggle: (pluginId: string, enabled: boolean) => void;
  onOpenDoc: (d: OpenDoc) => void;
  onOpenPlugin: (p: PluginInfo) => void;
  onOpenMarketplaces: () => void;
}) {
  // No live session in the project lens → updates apply on the next session spawn
  // (handle is null, so no reload_plugins hot-apply).
  const updatePlugin = useUpdatePlugin(path, null);
  const data = ext.data;
  // No active/inactive state here — that is only knowable inside a live conversation
  // (see the conversation lens). The project lens shows what is CONFIGURED, grouped
  // by scope so "what's on the repo" (Project/Local) reads apart from user-global.
  // File-based / non-plugin only — plugin-provided MCP, skills and agents live in
  // the per-plugin explorer, so they are NOT duplicated at the top level (consistent
  // across all three categories).
  const mcp = (data?.mcp_servers ?? []).filter((m) => m.source == null);
  const plugins = data?.plugins ?? [];
  const skills = (data?.skills ?? []).filter((s) => s.source == null);
  const agents = (data?.agents ?? []).filter((a) => a.source == null);

  return (
    <div className={styles.body}>
      {ext.isLoading ? (
        <div className={styles.empty}>Loading…</div>
      ) : ext.isError ? (
        <div className={styles.error}>{(ext.error as Error).message}</div>
      ) : (
        <>
          {setPluginEnabled.isError ? (
            <div className={styles.error}>{(setPluginEnabled.error as Error).message}</div>
          ) : null}
          <WarningBanner warnings={ext.data?.warnings ?? []} />
          <GroupedSection icon="term" title="Configured MCP servers" groups={groupBySource(mcp)} render={(m) => (
            <McpConfigRow key={(m.source ?? "") + ":" + m.name + ":" + m.scope} mcp={m} />
          )} empty="No MCP server configured for this repository." />
          <GroupedSection icon="spark" title="Skills" groups={groupBySource(skills)} render={(s) => (
            <SkillRow key={s.path} skill={s} onOpen={() => onOpenDoc({ name: s.name, source: CONFIG_SCOPE_LABEL[s.scope], path: s.path, description: s.description })} />
          )} empty="No file-based skills." />
          {agents.length > 0 ? (
            <GroupedSection icon="grid" title="Sub-agents" groups={groupBySource(agents)} render={(a) => (
              <AgentRow key={a.path} agent={a} onOpen={() => onOpenDoc({ name: a.name, source: CONFIG_SCOPE_LABEL[a.scope], path: a.path, description: a.description })} />
            )} empty="" />
          ) : null}
          <PluginUpdateOutcome mutation={updatePlugin} />
          <Section
            icon="layers"
            title="Plugins"
            count={plugins.length}
            empty="No plugins for this repository."
            action={<MarketplacesButton updates={totalUpdates(plugins)} onOpen={onOpenMarketplaces} />}
          >
            {plugins.map((p) => (
              <PluginRow
                key={p.id}
                plugin={p}
                busy={setPluginEnabled.isPending}
                onToggle={(enabled) => onPluginToggle(p.id, enabled)}
                onOpen={() => onOpenPlugin(p)}
                onUpdate={() => updatePlugin.mutate({ pluginId: p.id, scope: cliScope(p.scope) })}
                updating={updatePlugin.isPending && updatePlugin.variables?.pluginId === p.id}
                anyUpdating={updatePlugin.isPending}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

// ---- Conversation view: this session's live picture ---------------------------

function ConversationBody({
  ext,
  live,
  handle,
  path,
  setPluginEnabled,
  onPluginToggle,
  onOpenDoc,
  onOpenPlugin,
  onOpenMarketplaces,
  resetToken,
}: {
  ext: ReturnType<typeof useExtensions>;
  live: ReturnType<typeof useMcpStatus>;
  handle: string | null;
  path: string;
  setPluginEnabled: ReturnType<typeof useSetPluginEnabled>;
  onPluginToggle: (pluginId: string, enabled: boolean) => void;
  onOpenDoc: (d: OpenDoc) => void;
  onOpenPlugin: (p: PluginInfo, section?: ExplorerSectionKey) => void;
  onOpenMarketplaces: () => void;
  resetToken: string;
}) {
  const actions = useMcpActions(handle);
  // A live session lets an update hot-apply via reload_plugins (handle non-null);
  // otherwise it lands on the next spawn.
  const updatePlugin = useUpdatePlugin(path, handle);
  // Order FROZEN at window-open (enabled/connected first), then stable — toggling an
  // item must not make it jump under the cursor (see useStableOrder).
  const plugins = useStableOrder(
    ext.data?.plugins ?? [],
    (p) => p.id,
    (p) => (p.enabled ? 0 : 1),
    resetToken,
  );
  const allPlugins = ext.data?.plugins ?? [];
  // File-based only — plugin skills/agents are summarized as boxes below + live in
  // the per-plugin explorer (never mixed in as if they were normal rows).
  const skills = (ext.data?.skills ?? []).filter((s) => s.source == null);
  const agents = (ext.data?.agents ?? []).filter((a) => a.source == null);
  const orderedServers = useStableOrder(
    live.data ?? [],
    // Two servers can share a name across scopes (e.g. a `local` and a `project`
    // `playwright`, both folded into the "repo" bucket) — key by scope+name so they
    // don't collide in the freeze order nor as React keys below.
    (s) => `${s.scope ?? ""}:${s.name}`,
    (s) => liveRank(s.status),
    resetToken,
  );
  const mcpGroups = bucketizeLive(orderedServers);
  const mcpTotal = mcpGroups.reduce((n, g) => n + g.items.length, 0);
  // Enabled plugins that contribute skills / sub-agents / MCP → one summary box each.
  const skillContribs = allPlugins.filter((p) => p.enabled && p.skill_count > 0);
  const agentContribs = allPlugins.filter((p) => p.enabled && p.agent_count > 0);
  const mcpContribs = allPlugins.filter((p) => p.enabled && p.mcp_count > 0);
  const sum = (ps: PluginInfo[], pick: (p: PluginInfo) => number) => ps.reduce((n, p) => n + pick(p), 0);

  return (
    <div className={styles.body}>
      {actions.toggle.isError || actions.reconnect.isError || actions.authenticate.isError || actions.clearAuth.isError ? (
        <div className={styles.error}>
          {((actions.toggle.error || actions.reconnect.error || actions.authenticate.error || actions.clearAuth.error) as Error)?.message}
        </div>
      ) : null}
      {/* A failed plugin toggle (settings.json write) must be visible here too — the
          toggle is interactive in this lens, not only the project one. */}
      {setPluginEnabled.isError ? (
        <div className={styles.error}>{(setPluginEnabled.error as Error).message}</div>
      ) : null}
      {/* A failed config snapshot read must NOT read as "empty repo" — surface it,
          distinct from the sections' "No …" placeholders. */}
      {ext.isError ? (
        <div className={styles.error}>
          Unable to read the extensions configuration: {(ext.error as Error).message}
        </div>
      ) : null}
      <WarningBanner warnings={ext.data?.warnings ?? []} />
      <div className={styles.section}>
        <div className={styles.sectionH}>
          <Ico name="globe" className="sm" />
          <span className={styles.sectionT}>MCP servers</span>
          <span className={styles.sectionC}>{mcpTotal + sum(mcpContribs, (p) => p.mcp_count)}</span>
        </div>
        {handle == null ? (
          <div className={styles.sectionEmpty}>
            Start the conversation (send a message) to see the live MCP server status.
          </div>
        ) : live.isLoading ? (
          <div className={styles.sectionEmpty}>Querying the process…</div>
        ) : live.isError ? (
          <div className={styles.error}>{(live.error as Error).message}</div>
        ) : mcpTotal === 0 && mcpContribs.length === 0 ? (
          <div className={styles.sectionEmpty}>No MCP server in this session.</div>
        ) : (
          mcpGroups.map((g) => (
            <div key={g.bucket} className={styles.bucket}>
              <div className={styles.bucketH}>
                <span>{BUCKET_LABEL[g.bucket]}</span>
                <span className={styles.bucketC}>{g.items.length}</span>
              </div>
              <div className={styles.list}>
                {g.items.map((m) => (
                  <McpLiveRow key={`${m.scope ?? ""}:${m.name}`} mcp={m} actions={actions} />
                ))}
              </div>
            </div>
          ))
        )}
        {/* Plugin-provided MCP servers as one box each (consistent with plugin
            skills/sub-agents) — click opens the plugin explorer at its Connectors. */}
        {mcpContribs.length ? <PluginContribFooter plugins={mcpContribs} kind="mcp" onOpen={onOpenPlugin} /> : null}
      </div>
      <GroupedSection
        icon="spark"
        title="Skills"
        groups={groupBySource(skills)}
        render={(s) => (
          <SkillRow key={s.path} skill={s} onOpen={() => onOpenDoc({ name: s.name, source: CONFIG_SCOPE_LABEL[s.scope], path: s.path, description: s.description })} />
        )}
        empty="No file-based skills."
        extraCount={sum(skillContribs, (p) => p.skill_count)}
        footer={skillContribs.length ? <PluginContribFooter plugins={skillContribs} kind="skills" onOpen={onOpenPlugin} /> : null}
      />
      {agents.length > 0 || agentContribs.length > 0 ? (
        <GroupedSection
          icon="grid"
          title="Sub-agents"
          groups={groupBySource(agents)}
          render={(a) => (
            <AgentRow key={a.path} agent={a} onOpen={() => onOpenDoc({ name: a.name, source: CONFIG_SCOPE_LABEL[a.scope], path: a.path, description: a.description })} />
          )}
          empty=""
          extraCount={sum(agentContribs, (p) => p.agent_count)}
          footer={agentContribs.length ? <PluginContribFooter plugins={agentContribs} kind="agents" onOpen={onOpenPlugin} /> : null}
        />
      ) : null}
      <PluginUpdateOutcome mutation={updatePlugin} />
      <Section
        icon="layers"
        title="Plugins"
        count={plugins.length}
        empty="No plugins."
        action={<MarketplacesButton updates={totalUpdates(allPlugins)} onOpen={onOpenMarketplaces} />}
      >
        {plugins.map((p) => (
          <PluginRow
            key={p.id}
            plugin={p}
            busy={setPluginEnabled.isPending}
            onToggle={(enabled) => onPluginToggle(p.id, enabled)}
            onOpen={() => onOpenPlugin(p)}
            onUpdate={() => updatePlugin.mutate({ pluginId: p.id, scope: cliScope(p.scope) })}
            updating={updatePlugin.isPending && updatePlugin.variables?.pluginId === p.id}
            anyUpdating={updatePlugin.isPending}
          />
        ))}
      </Section>
    </div>
  );
}

// ---- Live plugin-reload bar ----------------------------------------------------

/** Inline bar (not a popup): after toggling plugin(s) with live conversations open,
 *  offer to hot-apply the change to the running session(s). "This conversation" shows
 *  only in the conversation lens when its session is live; "all live conversations of
 *  the repo" always shows (it is the sole option in the repo lens or when the current
 *  conversation is off). Hidden entirely when no conversation of the repo is live. */
function PluginReloadBar({
  count,
  liveCount,
  hasCurrent,
  busy,
  onReloadCurrent,
  onReloadAll,
  onDismiss,
}: {
  count: number;
  liveCount: number;
  hasCurrent: boolean;
  busy: boolean;
  onReloadCurrent: () => void;
  onReloadAll: () => void;
  onDismiss: () => void;
}) {
  const s = count > 1 ? "s" : "";
  return (
    <div className={styles.reloadBar}>
      <Ico name="refresh" className={"sm" + (busy ? " " + styles.spin : "")} />
      <span className={styles.reloadBarText}>
        {count} plugin{s} changed — apply to running conversations?
      </span>
      <span className={styles.reloadBarSpacer} />
      {hasCurrent ? (
        <button className={styles.reloadBtnPrimary} onClick={onReloadCurrent} disabled={busy}>
          This conversation
        </button>
      ) : null}
      {!hasCurrent || liveCount > 1 ? (
        <button
          className={hasCurrent ? styles.reloadBtnGhost : styles.reloadBtnPrimary}
          onClick={onReloadAll}
          disabled={busy}
        >
          {hasCurrent ? `All (${liveCount})` : `All live conversations (${liveCount})`}
        </button>
      ) : null}
      <button
        className={styles.reloadDismiss}
        onClick={onDismiss}
        disabled={busy}
        title="Dismiss"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// ---- Codex backend view --------------------------------------------------------

/** The Extensions view for a Codex conversation/target — v2, actionable. Codex's
 *  inventory is account-global (`~/.codex/config.toml` + `~/.codex/skills`, plus the
 *  repo's `.codex/skills`), rendered with the SAME section/row primitives as Claude.
 *  v2 wires the toggles (skills / MCP servers / plugins — every write goes through the
 *  BINARY's own config writer), upgrades the plugin list to the live `plugin/installed`
 *  inventory (explorable, like Claude), and adds the Codex-only Hooks section plus the
 *  Codex marketplaces. Sub-agents stay absent — Codex has no equivalent. */
function CodexExtensionsBody({
  codexExt,
  live,
  showLive,
  cwd,
  onOpenDoc,
  onOpenPlugin,
}: {
  codexExt: ReturnType<typeof useCodexExtensions>;
  live: ReturnType<typeof useMcpStatus>;
  showLive: boolean;
  cwd: string;
  onOpenDoc: (d: OpenDoc) => void;
  onOpenPlugin: (p: PluginInfo, codexMeta: { pluginName: string; marketplacePath: string | null }) => void;
}) {
  // Live inventories layered over the instant config snapshot (each spawns a transient
  // app-server, so they load in ~1s while the snapshot renders immediately).
  const codexPlugins = useCodexPlugins(true);
  const hooks = useCodexHooks(true, cwd);
  const toggles = useCodexToggles(cwd);

  if (codexExt.isLoading) return <div className={styles.body}><div className={styles.empty}>Loading…</div></div>;
  if (codexExt.isError)
    return <div className={styles.body}><div className={styles.error}>{(codexExt.error as Error).message}</div></div>;

  const snap = codexExt.data;
  const mcpConfigured = snap?.mcp_servers ?? [];
  const skills = snap?.skills ?? [];
  const configPlugins = snap?.plugins ?? [];
  const liveServers = live.data ?? [];
  // The enabled state is CONFIG-owned (a live server row doesn't carry it): resolve a
  // live row's toggle state from the configured list (absent = enabled, the default).
  const configEnabled = (name: string) =>
    mcpConfigured.find((m) => m.name === name)?.enabled ?? true;
  // Only a server DECLARED in config.toml is toggleable. The Codex runtime ALSO injects
  // servers (codex_apps, computer-use) that show up live but have no config entry —
  // writing `mcp_servers.<injected>.enabled` produces a transport-less entry the
  // app-server rejects ("invalid transport"). So injected servers render read-only.
  const configHas = (name: string) => mcpConfigured.some((m) => m.name === name);
  // A toggle failure must never be silent — surface the most recent mutation error.
  const toggleError =
    (toggles.skill.error as Error | null)?.message ??
    (toggles.mcp.error as Error | null)?.message ??
    (toggles.plugin.error as Error | null)?.message ??
    null;
  // The MCP toggle writes the config even when the live reload fails (`false` from the
  // mutation): warn — non-blocking — that running Codex sessions keep the old state
  // until their next spawn, instead of showing a state they don't have.
  const mcpReloadWarning =
    toggles.mcp.data === false
      ? "MCP setting written, but running Codex conversations couldn't reload it — it will apply on the next session start."
      : null;

  return (
    <div className={styles.body}>
      <WarningBanner warnings={snap?.warnings ?? []} />
      {toggleError ? <div className={styles.error}>{toggleError}</div> : null}
      {mcpReloadWarning ? <div className={styles.warn}>{mcpReloadWarning}</div> : null}
      {/* MCP servers: live when a Codex session is running, else the configured list.
          Both carry the v2 toggle (config-level `enabled`, applied via the binary's
          config writer + `config/mcpServer/reload`). */}
      {showLive ? (
        <Section
          icon="term"
          title="MCP servers"
          count={liveServers.length}
          // Suppress the generic empty text while loading or on error — those states render
          // their own children below (never a silent empty list on a failed live query).
          empty={live.isError || live.isLoading ? "" : "No MCP server in this Codex session."}
        >
          {live.isError ? (
            <div className={styles.error}>{(live.error as Error).message}</div>
          ) : live.isLoading && liveServers.length === 0 ? (
            <div className={styles.empty}>Loading MCP status…</div>
          ) : (
            liveServers.map((m) => (
              <CodexMcpLiveRow
                key={m.name}
                mcp={m}
                enabled={configEnabled(m.name)}
                busy={toggles.mcp.isPending}
                // Injected servers (not in config.toml) can't be toggled via config —
                // render them read-only with a "managed by Codex" note instead of a
                // toggle that would fail with an "invalid transport" error.
                toggleable={configHas(m.name)}
                onToggle={(enabled) => toggles.mcp.mutate({ name: m.name, enabled })}
              />
            ))
          )}
        </Section>
      ) : (
        <Section
          icon="term"
          title="Configured MCP servers"
          count={mcpConfigured.length}
          empty="No MCP server in ~/.codex/config.toml."
        >
          {mcpConfigured.map((m) => (
            <McpConfigRow
              key={m.name}
              mcp={m}
              toggle={{
                checked: m.enabled,
                busy: toggles.mcp.isPending,
                onChange: (enabled) => toggles.mcp.mutate({ name: m.name, enabled }),
              }}
            />
          ))}
        </Section>
      )}

      <Section
        icon="spark"
        title="Skills"
        count={skills.length}
        empty="No skills in ~/.codex/skills."
      >
        {skills.map((s) => (
          <SkillRow
            key={s.path}
            skill={s}
            onOpen={() => onOpenDoc({ name: s.name, source: "Codex", path: s.path, description: s.description })}
            toggle={{
              checked: s.enabled,
              busy: toggles.skill.isPending,
              onChange: (enabled) => toggles.skill.mutate({ path: s.path, enabled }),
            }}
          />
        ))}
      </Section>

      <CodexPluginsSection
        codexPlugins={codexPlugins}
        configPlugins={configPlugins}
        busy={toggles.plugin.isPending}
        onToggle={(pluginId, enabled) => toggles.plugin.mutate({ pluginId, enabled })}
        onOpenPlugin={onOpenPlugin}
      />

      <CodexHooksSection hooks={hooks} />

      <CodexMarketplacesSection codexPlugins={codexPlugins} />
    </div>
  );
}

/** The Codex Plugins section — prefers the AUTHORITATIVE live inventory
 *  (`plugin/installed`: bundled/runtime plugins, versions, display metadata,
 *  explorable) and falls back to the config-snapshot rows while it loads. A failed
 *  live query still shows the config rows, WITH the error surfaced (never silently
 *  degraded). */
function CodexPluginsSection({
  codexPlugins,
  configPlugins,
  busy,
  onToggle,
  onOpenPlugin,
}: {
  codexPlugins: ReturnType<typeof useCodexPlugins>;
  configPlugins: PluginInfo[];
  busy: boolean;
  onToggle: (pluginId: string, enabled: boolean) => void;
  onOpenPlugin: (p: PluginInfo, codexMeta: { pluginName: string; marketplacePath: string | null }) => void;
}) {
  const livePlugins = codexPlugins.data?.plugins ?? [];
  const useLive = codexPlugins.isSuccess && livePlugins.length > 0;
  const count = useLive ? livePlugins.length : configPlugins.length;
  return (
    <Section
      icon="layers"
      title="Plugins"
      count={count}
      empty={codexPlugins.isLoading ? "Loading plugin inventory…" : "No Codex plugin installed."}
    >
      {codexPlugins.isError ? (
        <div className={styles.error}>
          Live plugin inventory unavailable: {(codexPlugins.error as Error).message}
        </div>
      ) : null}
      {(codexPlugins.data?.loadErrors ?? []).map((e) => (
        <div key={e} className={styles.error}>Marketplace error — {e}</div>
      ))}
      {useLive
        ? livePlugins.map((p) => (
            <CodexPluginRow
              key={p.id}
              name={p.displayName ?? p.name}
              meta={[p.marketplace, p.version ? `v${p.version}` : null, p.shortDescription]
                .filter(Boolean)
                .join(" · ")}
              enabled={p.enabled}
              busy={busy}
              onToggle={(enabled) => onToggle(p.id, enabled)}
              onOpen={() =>
                onOpenPlugin(
                  {
                    id: p.id,
                    name: p.displayName ?? p.name,
                    marketplace: p.marketplace,
                    version: p.version,
                    description: p.shortDescription,
                    enabled: p.enabled,
                    scope: "user",
                    update_available: false,
                    update_unproven: false,
                    latest_version: null,
                    skill_count: 0,
                    agent_count: 0,
                    command_count: 0,
                    mcp_count: 0,
                  },
                  { pluginName: p.name, marketplacePath: p.marketplacePath },
                )
              }
            />
          ))
        : configPlugins.map((p) => (
            <CodexPluginRow
              key={p.id}
              name={p.name}
              meta={p.marketplace}
              enabled={p.enabled}
              busy={busy}
              onToggle={(enabled) => onToggle(p.id, enabled)}
            />
          ))}
    </Section>
  );
}

/** The Codex-only Hooks section (`hooks/list`) — read-only (Codex exposes no hook
 *  toggle RPC), with the scan's warnings/errors surfaced so a broken hooks config is
 *  never indiscernible from "no hooks". */
function CodexHooksSection({ hooks }: { hooks: ReturnType<typeof useCodexHooks> }) {
  const data = hooks.data;
  const list = data?.hooks ?? [];
  return (
    <Section
      icon="grid"
      title="Hooks"
      count={list.length}
      empty={
        hooks.isLoading
          ? "Loading hooks…"
          : hooks.isError
            ? ""
            : "No Codex hook configured."
      }
    >
      {hooks.isError ? (
        <div className={styles.error}>{(hooks.error as Error).message}</div>
      ) : null}
      {(data?.warnings ?? []).map((w) => (
        <div key={w} className={styles.error}>{w}</div>
      ))}
      {(data?.errors ?? []).map((e) => (
        <div key={e} className={styles.error}>{e}</div>
      ))}
      {list.map((h) => (
        <div key={h.key} className={styles.mcpRow}>
          <div className={styles.mcpHead + " " + styles.noExpand}>
            <span className={`${styles.dot} ${h.enabled ? styles.sOk : styles.sOff}`} />
            <span className={styles.rowName}>{h.eventName}</span>
            <span className={styles.spacer} />
            <span className={styles.connKind}>{h.handlerType}</span>
            <span className={`${styles.statusWord} ${h.trustStatus === "trusted" || h.trustStatus === "managed" ? styles.sOk : styles.sWarn}`}>
              {HOOK_TRUST_LABEL[h.trustStatus] ?? h.trustStatus}
            </span>
          </div>
          <div className={styles.mcpSub}>
            <span className={styles.subDetail}>
              {h.command ?? h.sourcePath}
              {h.pluginId ? ` · plugin ${h.pluginId}` : ` · ${h.source}`}
            </span>
          </div>
        </div>
      ))}
    </Section>
  );
}

const HOOK_TRUST_LABEL: Record<string, string> = {
  trusted: "Trusted",
  managed: "Managed",
  untrusted: "Untrusted",
  modified: "Modified",
};

/** The Codex marketplaces (from the live inventory): list + per-marketplace refresh +
 *  removal + an add-by-source form. Every action reports its error inline. */
function CodexMarketplacesSection({
  codexPlugins,
}: {
  codexPlugins: ReturnType<typeof useCodexPlugins>;
}) {
  const [source, setSource] = useState("");
  const { add, remove, upgrade } = useCodexMarketplaceActions();
  const err =
    (add.error as Error | null)?.message ??
    (remove.error as Error | null)?.message ??
    (upgrade.error as Error | null)?.message ??
    null;
  const marketplaces = codexPlugins.data?.marketplaces ?? [];
  const anyBusy = add.isPending || remove.isPending || upgrade.isPending;

  return (
    <Section
      icon="layers"
      title="Marketplaces"
      count={marketplaces.length}
      empty={codexPlugins.isLoading ? "Loading…" : "No Codex marketplace registered."}
    >
      {err ? <div className={styles.error}>{err}</div> : null}
      {marketplaces.map((m) => (
        <div key={m.name} className={styles.mcpRow}>
          <div className={styles.mcpHead + " " + styles.noExpand}>
            <Ico name="layers" className="sm" />
            <span className={styles.rowName}>{m.displayName ?? m.name}</span>
            <span className={styles.spacer} />
            <span className={styles.toolPill}>{m.pluginCount} plugin{m.pluginCount > 1 ? "s" : ""}</span>
            <button
              className={styles.updateBtnGhost}
              disabled={anyBusy}
              onClick={() => upgrade.mutate(m.name)}
              title="Refresh this marketplace's contents"
            >
              <Ico name="refresh" className={"sm" + (upgrade.isPending ? " " + styles.spin : "")} />
              Update
            </button>
            <button
              className={styles.updateBtnGhost}
              disabled={anyBusy}
              onClick={() => remove.mutate(m.name)}
              title="Remove this marketplace"
            >
              ✕
            </button>
          </div>
          {m.path ? (
            <div className={styles.mcpSub}>
              <span className={styles.subDetail}>{m.path}</span>
            </div>
          ) : null}
        </div>
      ))}
      <div className={styles.mktAddRow}>
        <input
          className={styles.mktAddInput}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Add a marketplace (owner/repo, git URL or local path)"
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim() && !anyBusy)
              add.mutate(source.trim(), { onSuccess: () => setSource("") });
          }}
        />
        <button
          className={styles.updateBtnGhost}
          disabled={!source.trim() || anyBusy}
          onClick={() => add.mutate(source.trim(), { onSuccess: () => setSource("") })}
        >
          {add.isPending ? "Adding…" : "Add"}
        </button>
      </div>
    </Section>
  );
}

/** A Codex plugin row (v2): status dot + name + meta, an optional explore affordance
 *  (live inventory only — the explorer needs the marketplace path), and the enable
 *  toggle (config-level, written by the binary). */
function CodexPluginRow({
  name,
  meta,
  enabled,
  busy,
  onToggle,
  onOpen,
}: {
  name: string;
  meta: string;
  enabled: boolean;
  busy?: boolean;
  onToggle: (enabled: boolean) => void;
  onOpen?: () => void;
}) {
  const main = (
    <>
      <span className={`${styles.dot} ${enabled ? styles.sOk : styles.sOff}`} />
      <div className={styles.rowMain}>
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </div>
    </>
  );
  return (
    <div className={styles.pluginRow}>
      {onOpen ? (
        <button className={styles.pluginMain} onClick={onOpen} title="Explore the plugin">
          {main}
          <Ico name="arrow" className={"sm " + styles.openArrow} />
        </button>
      ) : (
        <div className={styles.pluginMain} style={{ cursor: "default" }}>{main}</div>
      )}
      <Toggle
        checked={enabled}
        disabled={busy}
        onChange={onToggle}
        label={`${enabled ? "Disable" : "Enable"} ${name}`}
        title="Global Codex setting (~/.codex/config.toml)"
      />
    </div>
  );
}

/** A live MCP row for Codex: status dot + name + tool count (expandable), plus the v2
 *  config-level enable toggle — ONLY when the server is declared in config.toml.
 *  Runtime-injected servers (codex_apps, computer-use) are read-only: they have no
 *  config entry, so writing their `enabled` key would fail ("invalid transport"). */
function CodexMcpLiveRow({
  mcp,
  enabled,
  busy,
  toggleable,
  onToggle,
}: {
  mcp: McpServerLive;
  enabled: boolean;
  busy?: boolean;
  toggleable: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = statusInfo(mcp.status);
  const canExpand = mcp.tools.length > 0;
  return (
    <div className={styles.mcpRow}>
      <div className={styles.mcpHead}>
        <span className={`${styles.dot} ${tone.cls}`} />
        <span className={styles.rowName}>{mcp.name}</span>
        <span className={styles.spacer} />
        {mcp.tool_count > 0 ? <span className={styles.toolPill}>{mcp.tool_count} tools</span> : null}
        {canExpand ? (
          <button
            className={styles.chevBtn}
            onClick={() => setOpen((o) => !o)}
            title={open ? "Hide tools" : "Show tools"}
            aria-label="Show tools"
          >
            <Ico name="chev" className={"sm " + styles.chev + (open ? " " + styles.chevOpen : "")} />
          </button>
        ) : null}
        {toggleable ? (
          <Toggle
            checked={enabled}
            disabled={busy}
            onChange={onToggle}
            label={`${enabled ? "Disable" : "Enable"} ${mcp.name}`}
            title="Global Codex setting (~/.codex/config.toml) · applied on the next turn via reload"
          />
        ) : (
          <span className={styles.connKind} title="Server provided by Codex — cannot be disabled from configuration">
            managed by Codex
          </span>
        )}
      </div>
      <div className={styles.mcpSub}>
        <span className={`${styles.statusWord} ${tone.cls}`}>{tone.label}</span>
      </div>
      {open ? (
        <div className={styles.toolList}>
          {mcp.tools.map((t) => (
            <span key={t} className={styles.toolChip}>{t}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---- Sections ------------------------------------------------------------------

function Section({
  icon,
  title,
  count,
  empty,
  children,
  action,
}: {
  icon: string;
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
  /** Optional right-aligned control in the section header (e.g. a "Marketplaces" button). */
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionH}>
        <Ico name={icon} className="sm" />
        <span className={styles.sectionT}>{title}</span>
        <span className={styles.sectionC}>{count}</span>
        {action ? (
          <>
            <span className={styles.spacer} />
            {action}
          </>
        ) : null}
      </div>
      {count === 0 && empty ? (
        <div className={styles.sectionEmpty}>{empty}</div>
      ) : count === 0 ? (
        children
      ) : (
        <div className={styles.list}>{children}</div>
      )}
    </div>
  );
}

/** A section whose items are grouped by origin (one sub-header per scope). `footer`
 *  renders inside the section after the groups (e.g. plugin-contribution boxes);
 *  `extraCount` adds those items to the header count. The empty state shows only
 *  when there are neither groups nor a footer. */
function GroupedSection<T extends { source: string | null; scope: ExtScope }>({
  icon,
  title,
  groups,
  render,
  empty,
  footer = null,
  extraCount = 0,
}: {
  icon: string;
  title: string;
  groups: Group<T>[];
  render: (item: T) => React.ReactNode;
  empty: string;
  footer?: React.ReactNode;
  extraCount?: number;
}) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const hasFooter = footer != null;
  return (
    <div className={styles.section}>
      <div className={styles.sectionH}>
        <Ico name={icon} className="sm" />
        <span className={styles.sectionT}>{title}</span>
        <span className={styles.sectionC}>{total + extraCount}</span>
      </div>
      {total === 0 && !hasFooter ? (
        <div className={styles.sectionEmpty}>{empty}</div>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.key} className={styles.group}>
              <div className={styles.groupH}>
                <Ico name={g.isPlugin ? "layers" : "folder"} className="sm" />
                <span>{g.label}</span>
                <span className={styles.groupTag}>{g.isPlugin ? "plugin" : "files"}</span>
                <span className={styles.groupC}>{g.items.length}</span>
              </div>
              <div className={styles.list}>{g.items.map(render)}</div>
            </div>
          ))}
          {footer}
        </>
      )}
    </div>
  );
}

/** A small "Marketplaces" button for a section header — opens [`MarketplacesPage`].
 *  Shows an amber count when some plugins have an update, as a discoverable hint. */
function MarketplacesButton({ updates, onOpen }: { updates: number; onOpen: () => void }) {
  return (
    <button
      className={styles.actBtn}
      onClick={onOpen}
      title="Manage marketplaces and auto-updates"
    >
      <Ico name="layers" className="sm" />
      Marketplaces
      {updates > 0 ? <span className={styles.updateBadge}>{updates}</span> : null}
    </button>
  );
}

/** The Marketplaces page — a dedicated overlay reached from the Plugins section header.
 *  Auto-update is PER-MARKETPLACE (the only granularity Claude Code exposes), so it
 *  belongs here rather than as a general section: the global master toggle, one toggle
 *  per marketplace, and the network "Check" (marketplace refresh). Per-plugin update
 *  stays on each PluginRow; the counts here are derived from the plugin list. */
function MarketplacesPage({
  path,
  plugins,
  onClose,
}: {
  path: string;
  plugins: PluginInfo[];
  onClose: () => void;
}) {
  const marketplaces = useMarketplaces(path);
  const check = useCheckPluginUpdates(path);
  const setAuto = useSetMarketplaceAutoUpdate(path);
  const setAllAuto = useSetAllMarketplacesAutoUpdate(path);
  const list = marketplaces.data ?? [];
  const total = totalUpdates(plugins);
  const allOn = allMarketplacesAuto(list);

  // Escape closes the overlay, like the app's other dialogs. Fullscreen is protected
  // globally by the capture-phase guard in App.tsx (which always preventDefaults Escape),
  // so this no longer needs to preventDefault or gate on `defaultPrevented`.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.mktScrim} onClick={onClose}>
      <div className={styles.mktPanel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="layers" className="sm" />
          <span className={styles.title}>
            Marketplaces
            <span className={styles.titleSub}>
              Plugin auto-update{total > 0 ? ` · ${total} update${total > 1 ? "s" : ""} available` : ""}
            </span>
          </span>
          <span className={styles.spacer} />
          <button
            className={styles.actBtn}
            onClick={() => check.mutate(null)}
            disabled={check.isPending}
            title="Refresh marketplaces and re-check for available updates"
          >
            <Ico name="refresh" className={"sm" + (check.isPending ? " " + styles.spin : "")} />
            {check.isPending ? "Checking…" : "Check for updates"}
          </button>
          <button className={styles.iconBtn} onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
        <div className={styles.body}>
          {check.isError ? <div className={styles.error}>{(check.error as Error).message}</div> : null}
          {setAuto.isError ? <div className={styles.error}>{(setAuto.error as Error).message}</div> : null}
          {setAllAuto.isError ? <div className={styles.error}>{(setAllAuto.error as Error).message}</div> : null}
          {marketplaces.isLoading ? (
            <div className={styles.sectionEmpty}>Loading marketplaces…</div>
          ) : marketplaces.isError ? (
            <div className={styles.error}>{(marketplaces.error as Error).message}</div>
          ) : list.length === 0 ? (
            <div className={styles.sectionEmpty}>No marketplace registered.</div>
          ) : (
            <div className={styles.list}>
              <div className={styles.mktRow}>
                <Ico name="bolt" className="sm" />
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>Auto-update</span>
                  <span className={styles.rowMeta}>All marketplaces at once</span>
                </div>
                <Toggle
                  checked={allOn}
                  disabled={setAuto.isPending || setAllAuto.isPending}
                  onChange={(v) => setAllAuto.mutate(v)}
                  label="Auto-update all marketplaces"
                />
              </div>
              {list.map((m) => {
                const n = updatesForMarketplace(plugins, m.name);
                return (
                  <div key={m.name} className={styles.mktRow}>
                    <Ico name="layers" className="sm" />
                    <div className={styles.rowMain}>
                      <span className={styles.rowName}>
                        {m.name}
                        {n > 0 ? <span className={styles.updateBadge}>{n} update{n > 1 ? "s" : ""}</span> : null}
                      </span>
                      {m.source ? <span className={styles.rowMeta}>{m.source}</span> : null}
                    </div>
                    <Toggle
                      checked={m.auto_update}
                      disabled={setAuto.isPending || setAllAuto.isPending}
                      onChange={(v) => setAuto.mutate({ name: m.name, enabled: v })}
                      label={`Auto-update ${m.name}`}
                      title="Auto-update this marketplace"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What the plugin-update button actually did.
 *
 * `claude plugin update` exits 0 whether it upgraded the plugin, decided it was
 * already current, or skipped it because another plugin pins an incompatible range —
 * so a bare spinner that just stops tells the user nothing, and a plugin that visibly
 * did not move reads as a broken button. The CLI's own verdict line is rendered
 * verbatim: as an error when the command failed, otherwise as a neutral note.
 */
function PluginUpdateOutcome({
  mutation,
}: {
  mutation: Pick<
    UseMutationResult<string, Error, { pluginId: string; scope: string | null }>,
    "isError" | "error" | "isSuccess" | "data"
  >;
}) {
  if (mutation.isError) {
    return <div className={styles.error}>{(mutation.error as Error).message}</div>;
  }
  // A successful run with nothing to say (the CLI printed only its progress line)
  // needs no box — the refreshed snapshot speaks for itself.
  if (!mutation.isSuccess || !mutation.data) return null;
  // Neutral, NOT the amber warning box: "Updated railway to 1.4.0." is the happy path
  // and must not read as an alert.
  return <div className={styles.note}>{mutation.data}</div>;
}

/** Plugin contributions to a category, shown as ONE summary box per plugin (NOT as
 *  individual rows) — "Tosse workflow · 5 skills" — clickable into the plugin
 *  explorer at that category. Only enabled plugins (they alone contribute live). */
function PluginContribFooter({
  plugins,
  kind,
  onOpen,
}: {
  plugins: PluginInfo[];
  kind: ExplorerSectionKey;
  onOpen: (p: PluginInfo, section?: ExplorerSectionKey) => void;
}) {
  if (!plugins.length) return null;
  const count = (p: PluginInfo) =>
    kind === "skills" ? p.skill_count : kind === "agents" ? p.agent_count : p.mcp_count;
  const noun = (n: number) =>
    kind === "skills"
      ? `${n} skill${n > 1 ? "s" : ""}`
      : kind === "agents"
        ? `${n} sub-agent${n > 1 ? "s" : ""}`
        : `${n} MCP server${n > 1 ? "s" : ""}`;
  return (
    <div className={styles.group}>
      <div className={styles.groupH}>
        <Ico name="layers" className="sm" />
        <span>Provided by plugins</span>
      </div>
      <div className={styles.list}>
        {plugins.map((p) => (
          <button
            key={p.id}
            className={styles.contribBox}
            onClick={() => onOpen(p, kind)}
            title={`Explore ${p.name}`}
          >
            <Ico name="layers" className="sm" />
            <span className={styles.rowName}>{p.name}</span>
            <span className={styles.contribCount}>{noun(count(p))}</span>
            <Ico name="arrow" className={"sm " + styles.openArrow} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={`${styles.badge} ${cls}`}>{label}</span>;
}

/** Non-blocking banner for config files that exist but couldn't be read/parsed —
 *  so a corrupt config is never indiscernible from an empty inventory. */
function WarningBanner({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className={styles.warn}>
      Configuration partially unreadable — the inventory below may be incomplete:
      <ul>
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

// ---- MCP rows ------------------------------------------------------------------

function McpLiveRow({ mcp, actions }: { mcp: McpServerLive; actions: ReturnType<typeof useMcpActions> }) {
  const [open, setOpen] = useState(false);
  const tone = statusInfo(mcp.status);
  const b = liveBadge(mcp.scope);
  const conn = connType(mcp);
  const canExpand = mcp.tools.length > 0;
  const enabled = mcp.status !== "disabled";
  // claude.ai connectors (`claudeai-proxy`) have their connection + auth managed by
  // the Claude app — we expose ONLY enable/disable for them and leave the rest to
  // the Cloud app (it rejects clear_auth, and reconnect/auth don't apply per-server).
  const isCloud = mcp.scope === "claudeai";
  const isNetwork = mcp.url != null; // OAuth-capable http/sse server (not a connector)
  const busy =
    actions.toggle.isPending ||
    actions.reconnect.isPending ||
    actions.authenticate.isPending ||
    actions.clearAuth.isPending;
  return (
    <div className={styles.mcpRow}>
      <div className={styles.mcpHead}>
        <span className={`${styles.dot} ${tone.cls}`} />
        <span className={styles.rowName}>{mcp.name}</span>
        <Badge label={b.label} cls={b.cls} />
        <span className={styles.spacer} />
        {mcp.tool_count > 0 ? <span className={styles.toolPill}>{mcp.tool_count} tools</span> : null}
        {canExpand ? (
          <button
            className={styles.chevBtn}
            onClick={() => setOpen((o) => !o)}
            title={open ? "Hide tools" : "Show tools"}
            aria-label="Show tools"
          >
            <Ico name="chev" className={"sm " + styles.chev + (open ? " " + styles.chevOpen : "")} />
          </button>
        ) : null}
      </div>
      <div className={styles.mcpSub}>
        <span className={`${styles.statusWord} ${tone.cls}`}>{tone.label}</span>
        {/* Why it failed to start (Codex `mcpServer/startupStatus/updated` push) — turns a
            mute "Failed" into a named cause, e.g. "Failed · Re-authentication required". */}
        {mcp.failure_reason ? (
          <>
            <span className={styles.subSep}>·</span>
            <span className={styles.subDetail}>{mcpFailureLabel(mcp.failure_reason)}</span>
          </>
        ) : null}
        {conn ? (
          <>
            <span className={styles.subSep}>·</span>
            <Ico name={conn.icon} className="sm" />
            <span>{conn.kind}</span>
            {conn.detail ? <span className={styles.subDetail}>{conn.detail}</span> : null}
          </>
        ) : null}
        <span className={styles.spacer} />
        <div className={styles.mcpActions}>
          {/* Auth + reconnect only for real servers — never claude.ai connectors. */}
          {!isCloud && mcp.status === "needs-auth" ? (
            <button
              className={styles.actBtn + " " + styles.actPrimary}
              disabled={busy}
              onClick={() => actions.authenticate.mutate(mcp.name)}
            >
              Authenticate
            </button>
          ) : null}
          {!isCloud && (mcp.status === "failed" || mcp.status === "disconnected") ? (
            <button className={styles.actBtn} disabled={busy} onClick={() => actions.reconnect.mutate(mcp.name)}>
              Reconnect
            </button>
          ) : null}
          {!isCloud && isNetwork && (mcp.status === "connected" || mcp.status === "needs-auth") ? (
            <button className={styles.actBtn} disabled={busy} onClick={() => actions.clearAuth.mutate(mcp.name)}>
              Reset auth
            </button>
          ) : null}
          {isCloud && (mcp.status === "needs-auth" || mcp.status === "failed") ? (
            <span
              className={styles.cloudHint}
              title="Connector managed by the Claude app. Authenticate it in Claude, then refresh."
            >
              Managed by the Claude app
            </span>
          ) : null}
          <Toggle
            checked={enabled}
            disabled={busy}
            onChange={(v) => actions.toggle.mutate({ serverName: mcp.name, enabled: v })}
            label={`${enabled ? "Disable" : "Enable"} ${mcp.name}`}
          />
        </div>
      </div>
      {open ? (
        <div className={styles.toolList}>
          {mcp.tools.map((t) => (
            <span key={t} className={styles.toolChip}>{t}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function McpConfigRow({
  mcp,
  toggle,
}: {
  mcp: McpServerInfo;
  /** Extensions v2 (Codex): the config-level enable toggle. Absent on Claude rows
   *  (their toggle is live-session-scoped) — the row then renders as before. */
  toggle?: { checked: boolean; busy?: boolean; onChange: (enabled: boolean) => void };
}) {
  const conn = connType(mcp);
  // No live connection state here: a server's connection is only knowable in a
  // conversation. This is purely "what's configured" (the scope lives in the group
  // sub-header). Lead with the connection-type icon.
  return (
    <div className={styles.mcpRow}>
      <div className={styles.mcpHead + " " + styles.noExpand}>
        <Ico name={conn?.icon ?? "term"} className="sm" />
        <span className={styles.rowName}>{mcp.name}</span>
        <span className={styles.spacer} />
        {conn ? <span className={styles.connKind}>{conn.kind}</span> : null}
        {toggle ? (
          <Toggle
            checked={toggle.checked}
            disabled={toggle.busy}
            onChange={toggle.onChange}
            label={`${toggle.checked ? "Disable" : "Enable"} ${mcp.name}`}
            title="Global Codex setting (~/.codex/config.toml)"
          />
        ) : null}
      </div>
      {conn?.detail ? (
        <div className={styles.mcpSub}>
          <span className={styles.subDetail}>{conn.detail}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---- Plugin / skill / agent rows ----------------------------------------------

/** Count summary line for a plugin ("5 skills · 1 agent · 1 MCP"). */
function pluginParts(plugin: { skill_count: number; agent_count: number; command_count: number; mcp_count: number }): string {
  const parts: string[] = [];
  if (plugin.skill_count) parts.push(`${plugin.skill_count} skill${plugin.skill_count > 1 ? "s" : ""}`);
  if (plugin.agent_count) parts.push(`${plugin.agent_count} agent${plugin.agent_count > 1 ? "s" : ""}`);
  if (plugin.command_count) parts.push(`${plugin.command_count} cmd`);
  if (plugin.mcp_count) parts.push(`${plugin.mcp_count} MCP`);
  return parts.join(" · ");
}

function PluginRow({
  plugin,
  busy,
  onToggle,
  onOpen,
  onUpdate,
  updating,
  anyUpdating,
}: {
  plugin: PluginInfo;
  busy?: boolean;
  onToggle?: (enabled: boolean) => void;
  onOpen: () => void;
  /** Trigger an on-demand update. The button is ALWAYS shown when provided (on-demand
   *  update is a requirement, and pin-less plugins never flip `update_available`); it's
   *  just emphasised when an update was detected. */
  onUpdate?: () => void;
  /** This row's update is in flight. */
  updating?: boolean;
  /** Any plugin's update is in flight (disables every row's button to avoid one shared
   *  mutation hijacking another row's spinner/error). */
  anyUpdating?: boolean;
}) {
  const parts = pluginParts(plugin);
  return (
    <div className={styles.pluginRow}>
      <button className={styles.pluginMain} onClick={onOpen} title="Explore the plugin">
        <span className={`${styles.dot} ${plugin.enabled ? styles.sOk : styles.sOff}`} />
        <div className={styles.rowMain}>
          <span className={styles.rowName}>
            {plugin.name}
            <Badge label={`Installed: ${CONFIG_SCOPE_LABEL[plugin.scope]}`} cls={configBadgeCls(plugin.scope)} />
            {plugin.update_available ? (
              <span className={styles.updateBadge}>{updateBadgeLabel(plugin.version, plugin.latest_version)}</span>
            ) : plugin.update_unproven ? (
              // Upstream moved but no version is resolvable on either side, so we can
              // neither promise an update nor claim currency — say exactly that instead
              // of picking a side the CLI would contradict.
              <span
                className={styles.unprovenBadge}
                title="The marketplace points at a newer commit, but it publishes no version for this plugin — Flight Deck cannot tell whether that is a new release. Use Update to ask Claude Code."
              >
                Upstream moved
              </span>
            ) : null}
          </span>
          <span className={styles.rowMeta}>
            {plugin.marketplace}
            {parts ? ` · ${parts}` : ""}
          </span>
        </div>
        <Ico name="arrow" className={"sm " + styles.openArrow} />
      </button>
      {onUpdate ? (
        <button
          className={plugin.update_available || updating ? styles.updateBtn : styles.updateBtnGhost}
          onClick={onUpdate}
          disabled={updating || anyUpdating}
          title={
            plugin.update_available
              ? "Update this plugin now"
              : plugin.update_unproven
                ? "Ask Claude Code whether a newer version exists"
                : "Force update to the marketplace's latest version"
          }
        >
          <Ico name="refresh" className={"sm" + (updating ? " " + styles.spin : "")} />
          {updating ? "Updating…" : "Update"}
        </button>
      ) : null}
      {onToggle ? (
        <Toggle
          checked={plugin.enabled}
          disabled={busy}
          onChange={onToggle}
          label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
          title="Global setting (all repositories) · a bar offers to apply it to running conversations"
        />
      ) : (
        <span className={styles.statusWord + " " + (plugin.enabled ? styles.sOk : styles.sOff)}>
          {plugin.enabled ? "Active" : "Inactive"}
        </span>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  onOpen,
  toggle,
}: {
  skill: SkillInfo;
  onOpen: () => void;
  /** Extensions v2 (Codex): the per-skill enable toggle. Absent on Claude rows (no
   *  per-skill toggle there) — the row then renders exactly as before. */
  toggle?: { checked: boolean; busy?: boolean; onChange: (enabled: boolean) => void };
}) {
  const main = (
    <>
      <Ico name="spark" className="sm" />
      <div className={styles.rowMain}>
        <span className={styles.rowName}>{skill.name}</span>
        {skill.description ? <span className={styles.desc}>{skill.description}</span> : null}
      </div>
      <Ico name="arrow" className={"sm " + styles.openArrow} />
    </>
  );
  if (!toggle) {
    return (
      <button className={styles.docRow} onClick={onOpen} title="Open the skill">
        {main}
      </button>
    );
  }
  // With a toggle, the row splits: the main area stays a button (opens the doc), the
  // toggle sits outside it (a control can't nest inside a button).
  return (
    <div className={styles.pluginRow}>
      <button className={styles.pluginMain} onClick={onOpen} title="Open the skill">
        {main}
      </button>
      <Toggle
        checked={toggle.checked}
        disabled={toggle.busy}
        onChange={toggle.onChange}
        label={`${toggle.checked ? "Disable" : "Enable"} ${skill.name}`}
        title="Global Codex setting (writes [[skills.config]] to ~/.codex/config.toml)"
      />
    </div>
  );
}

function AgentRow({ agent, onOpen }: { agent: AgentInfo; onOpen: () => void }) {
  return (
    <button className={styles.docRow} onClick={onOpen} title="Open the sub-agent">
      <Ico name="grid" className="sm" />
      <div className={styles.rowMain}>
        <span className={styles.rowName}>
          {agent.name}
          {agent.model ? <span className={styles.modelTag}>{agent.model}</span> : null}
        </span>
        {agent.description ? <span className={styles.desc}>{agent.description}</span> : null}
      </div>
      <Ico name="arrow" className={"sm " + styles.openArrow} />
    </button>
  );
}

// ---- Plugin explorer (3 panes: rail / list / detail) --------------------------

type ExplorerSectionKey = "skills" | "mcp" | "agents";

interface ExplorerItem {
  key: string;
  name: string;
  /** Markdown file to render (skill/agent); null for an MCP server (info card). */
  path: string | null;
  mcp?: McpServerInfo;
  model?: string | null;
  description?: string | null;
}

function PluginExplorer({
  plugin,
  initialSection,
  repoPath,
  codexMeta,
  onClose,
}: {
  plugin: PluginInfo;
  initialSection: ExplorerSectionKey;
  repoPath: string;
  /** Extensions v2: set for a CODEX plugin — contents are then read via the
   *  app-server's `plugin/read` (the Claude plugin cache knows nothing about it). */
  codexMeta: { pluginName: string; marketplacePath: string | null } | null;
  onClose: () => void;
}) {
  // Both hooks are called unconditionally (rules of hooks); each gates itself on its
  // own null/enabled input, so exactly one actually fetches.
  const claudeContents = usePluginContents(codexMeta ? null : repoPath, codexMeta ? null : plugin.id);
  const codexContents = useCodexPluginContents(
    codexMeta ? { pluginId: plugin.id, ...codexMeta } : null,
  );
  const { data, isLoading, isError, error } = codexMeta ? codexContents : claudeContents;
  const [section, setSection] = useState<ExplorerSectionKey>(initialSection);
  const [itemKey, setItemKey] = useState<string | null>(null);

  // Section descriptors in the requested order: Skills → Connectors → Sub-agents.
  const allSections: { key: ExplorerSectionKey; label: string; icon: string; items: ExplorerItem[] }[] = [
    {
      key: "skills",
      label: "Skills",
      icon: "spark",
      items: (data?.skills ?? []).map((s) => ({ key: s.path, name: s.name, path: s.path, description: s.description })),
    },
    {
      key: "mcp",
      label: "Connectors",
      icon: "term",
      items: (data?.mcp_servers ?? []).map((m) => ({ key: m.name, name: m.name, path: null, mcp: m })),
    },
    {
      key: "agents",
      label: "Sub-agents",
      icon: "grid",
      items: (data?.agents ?? []).map((a) => ({ key: a.path, name: a.name, path: a.path, model: a.model, description: a.description })),
    },
  ];
  const sections = allSections.filter((s) => s.items.length > 0);

  // Once contents load, default to the first non-empty section and its first item.
  useEffect(() => {
    if (!sections.length) return;
    const cur = sections.find((s) => s.key === section) ?? sections[0];
    if (cur.key !== section) setSection(cur.key);
    if (!cur.items.some((it) => it.key === itemKey)) setItemKey(cur.items[0]?.key ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, section]);

  const active = sections.find((s) => s.key === section);
  const item = active?.items.find((it) => it.key === itemKey) ?? null;

  return (
    <div className={styles.pluginScrim} onClick={onClose}>
      <div className={styles.pluginPanel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="layers" className="sm" />
          <span className={styles.title}>
            {plugin.name}
            <span className={styles.titleSub}>{plugin.marketplace}</span>
          </span>
          {plugin.version ? <span className={styles.verTag}>v{plugin.version}</span> : null}
          <span className={styles.spacer} />
          <button className={styles.iconBtn} onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        {isLoading ? (
          <div className={styles.pluginLoading}>Loading the plugin…</div>
        ) : isError ? (
          <div className={styles.error} style={{ margin: 16 }}>{(error as Error).message}</div>
        ) : sections.length === 0 ? (
          <div className={styles.pluginLoading}>This plugin provides no skills, connectors, or sub-agents.</div>
        ) : (
          <div className={styles.pluginCols}>
            <div className={styles.pluginRail}>
              {plugin.description ? <div className={styles.railDesc}>{plugin.description}</div> : null}
              {sections.map((s) => (
                <button
                  key={s.key}
                  className={styles.railItem + (s.key === section ? " " + styles.railItemOn : "")}
                  onClick={() => {
                    setSection(s.key);
                    setItemKey(s.items[0]?.key ?? null);
                  }}
                >
                  <Ico name={s.icon} className="sm" />
                  <span>{s.label}</span>
                  <span className={styles.railCount}>{s.items.length}</span>
                </button>
              ))}
            </div>

            <div className={styles.pluginList}>
              {active?.items.map((it) => (
                <button
                  key={it.key}
                  className={styles.listItem + (it.key === itemKey ? " " + styles.listItemOn : "")}
                  onClick={() => setItemKey(it.key)}
                >
                  <Ico name={active.icon} className="sm" />
                  <div className={styles.rowMain}>
                    <span className={styles.rowName}>{it.name}</span>
                    {it.description ? <span className={styles.listItemSub}>{it.description}</span> : null}
                  </div>
                </button>
              ))}
            </div>

            <div className={styles.pluginDetail}>
              {item ? (
                <ItemDetail item={item} sectionKey={section} pluginName={plugin.name} />
              ) : (
                <div className={styles.detailEmpty}>Select an item.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Right pane: a metadata strip + rendered markdown (skill/agent) or an MCP card. */
function ItemDetail({ item, sectionKey, pluginName }: { item: ExplorerItem; sectionKey: ExplorerSectionKey; pluginName: string }) {
  const typeLabel = sectionKey === "skills" ? "Skill" : sectionKey === "agents" ? "Sub-agent" : "MCP server";
  return (
    <>
      <div className={styles.detailHead}>
        <span className={styles.detailName}>{item.name}</span>
        <div className={styles.metaGrid}>
          <span className={styles.metaKey}>Provided by</span>
          <span className={styles.metaVal}>{pluginName}</span>
          <span className={styles.metaKey}>Type</span>
          <span className={styles.metaVal}>{typeLabel}</span>
          {item.model ? (
            <>
              <span className={styles.metaKey}>Model</span>
              <span className={styles.metaVal}>{item.model}</span>
            </>
          ) : null}
        </div>
        {item.description ? <p className={styles.detailDesc}>{item.description}</p> : null}
      </div>
      {item.path ? <DocBody path={item.path} /> : item.mcp ? <McpDetailCard mcp={item.mcp} /> : null}
    </>
  );
}

/** The shared load → error → binary/too-large → markdown ladder for a doc file.
 *  Reused by the detail pane (DocBody) and the standalone viewer (DocViewer) so the
 *  four-way state handling and frontmatter strip live in one place. */
function DocMarkdown({ path }: { path: string }) {
  const { data, isLoading, isError, error } = useExtensionDoc(path);
  if (isLoading) return <div className={styles.empty}>Loading…</div>;
  if (isError) return <div className={styles.error}>{(error as Error).message}</div>;
  if (data?.binary || data?.too_large)
    return <div className={styles.empty}>File cannot be displayed.</div>;
  return <StreamMarkdown text={stripFrontmatter(data?.content ?? "")} />;
}

/** Read + render a SKILL.md / agent .md inside a detail pane (frontmatter stripped). */
function DocBody({ path }: { path: string }) {
  return (
    <div className={styles.detailBody}>
      <DocMarkdown path={path} />
      <div className={styles.docPathFoot}>{path}</div>
    </div>
  );
}

/** MCP server detail (no markdown doc): connection type + endpoint. */
function McpDetailCard({ mcp }: { mcp: McpServerInfo }) {
  const conn = connType(mcp);
  return (
    <div className={styles.detailBody}>
      <div className={styles.mcpCard}>
        {conn ? (
          <div className={styles.mcpCardLine}>
            <Ico name={conn.icon} className="sm" />
            <span className={styles.mcpCardKind}>{conn.kind}</span>
            {conn.detail ? <span className={styles.subDetail}>{conn.detail}</span> : null}
          </div>
        ) : (
          <div className={styles.mcpCardLine}>Connection not described.</div>
        )}
        {mcp.transport ? (
          <div className={styles.mcpCardMeta}>Transport: {mcp.transport}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---- Standalone markdown viewer (file-based skill / sub-agent) -----------------

function DocViewer({ doc, onClose }: { doc: OpenDoc; onClose: () => void }) {
  return (
    <div className={styles.docScrim} onClick={onClose}>
      <div className={styles.docPanel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="file" className="sm" />
          <span className={styles.title}>
            {doc.name}
            <span className={styles.titleSub}>{doc.source}</span>
          </span>
          <button className={styles.iconBtn} onClick={onClose} title="Close" aria-label="Close">
            ✕
          </button>
        </div>
        <div className={styles.docBody}>
          {doc.description ? <p className={styles.detailDesc}>{doc.description}</p> : null}
          <DocMarkdown path={doc.path} />
        </div>
        <div className={styles.docFoot}>{doc.path}</div>
      </div>
    </div>
  );
}
