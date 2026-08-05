// TanStack Query wrapper around the `list_extensions` IPC command. The configured
// extensions (MCP / plugins / skills / sub-agents) are a property of a directory
// (repo or worktree cwd), so the snapshot is cached per PATH and shared by every
// component asking for the same path — the per-conversation view and the per-repo
// modal dedupe to one request.
//
// This is the CONFIGURED picture (on-disk). The LIVE connection status comes from
// the running session's `SessionStatePayload.mcp_servers` and is merged in the UI
// (see features/extensions/mcpMerge).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { refetchSlashCommands } from "../store/commandsStore";
import { commands } from "./client";
import type {
  ExtensionsSnapshot,
  MarketplaceInfo,
  McpServerLive,
  PluginContents,
  Result,
} from "./client";

/** Throw on the Result.error branch so the query's error state is populated. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

/** Query key for a path's extensions snapshot — shared so requests dedupe per path. */
export const extensionsKey = (path: string | null) => ["extensions", path] as const;

/**
 * The configured extensions visible to `path` (a repo root or a conversation's
 * cwd), across user / project / plugin scopes. Disabled when `path` is null.
 * Refetches on window focus so a plugin enabled / MCP server added from the CLI
 * (or our own toggles) shows up when the user returns, without watching the FS.
 */
export function useExtensions(path: string | null) {
  return useQuery({
    queryKey: extensionsKey(path),
    enabled: !!path,
    queryFn: () => unwrap(commands.listExtensions(path!)),
    // Config changes rarely; a few seconds of staleness avoids refetching on every
    // re-render of the panel.
    staleTime: 5_000,
  });
}

/** Query key for the Codex configured extensions snapshot (per optional repo cwd). */
export const codexExtensionsKey = (cwd?: string | null) =>
  ["codex-extensions", cwd ?? null] as const;

/**
 * The CONFIGURED Codex extensions (`~/.codex/config.toml` declared MCP servers +
 * installed plugins + on-disk skills — plus `<cwd>/.codex/skills` when a repo path is
 * given), as the SAME `ExtensionsSnapshot` shape as Claude so the manager renders a
 * Codex segment with the shared primitives. Skill/MCP rows carry their toggle state
 * (Extensions v2). `enabled` gates it to when a Codex view is actually shown.
 */
export function useCodexExtensions(enabled: boolean, cwd?: string | null) {
  return useQuery({
    queryKey: codexExtensionsKey(cwd),
    enabled,
    queryFn: () => unwrap(commands.codexListExtensions(cwd ?? null)),
    staleTime: 5_000,
  });
}

/** Query key for the live (app-server) Codex plugin inventory. Account-global. */
export const codexPluginsKey = () => ["codex-plugins"] as const;

/**
 * The AUTHORITATIVE installed Codex plugin inventory (`plugin/installed` on a transient
 * app-server): bundled/runtime plugins with versions, display metadata and marketplace
 * grouping — richer than the config.toml snapshot, which only sees toggled entries.
 * Slower (spawns the binary), so it's a separate query layered over the instant
 * snapshot: the UI renders config rows immediately and upgrades when this lands.
 */
export function useCodexPlugins(enabled: boolean) {
  return useQuery({
    queryKey: codexPluginsKey(),
    enabled,
    queryFn: () => unwrap(commands.codexListPlugins([])),
    staleTime: 30_000,
  });
}

/** Query key for the Codex hooks visible from a cwd. */
export const codexHooksKey = (cwd: string | null) => ["codex-hooks", cwd] as const;

/**
 * The Codex hooks visible from `cwd` (`hooks/list` on a transient app-server) —
 * read-only view with the scan's warnings/errors surfaced. Codex-only section (Claude
 * hooks live in settings.json and have no equivalent list RPC).
 */
export function useCodexHooks(enabled: boolean, cwd: string | null) {
  return useQuery({
    queryKey: codexHooksKey(cwd),
    enabled,
    queryFn: () => unwrap(commands.codexListHooks(cwd ? [cwd] : [])),
    staleTime: 30_000,
  });
}

/**
 * Everything ONE Codex plugin provides (`plugin/read`), as the same `PluginContents`
 * shape the Claude explorer drills into. Keyed by plugin id; `meta` carries the
 * wire selectors (name + marketplace path) from the live inventory row.
 */
export function useCodexPluginContents(
  meta: { pluginId: string; pluginName: string; marketplacePath: string | null } | null,
) {
  return useQuery<PluginContents>({
    queryKey: ["codex-plugin-contents", meta?.pluginId ?? null] as const,
    enabled: !!meta,
    queryFn: () =>
      unwrap(
        commands.codexPluginContents(meta!.pluginName, meta!.marketplacePath, meta!.pluginId),
      ),
    staleTime: 30_000,
  });
}

/**
 * The Extensions v2 Codex toggles — skill (`skills/config/write`), MCP server
 * (`config/value/write` + `config/mcpServer/reload`) and plugin
 * (`config/value/write` on `plugins."<id>".enabled`). Every mutation goes through the
 * BINARY's own config writer (comments + secrets preserved). On success both Codex
 * inventories are invalidated so the rows reflect the resolved state.
 */
export function useCodexToggles(cwd?: string | null) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["codex-extensions"] });
    void qc.invalidateQueries({ queryKey: codexPluginsKey() });
  };
  const skill = useMutation({
    mutationFn: (a: { path: string; enabled: boolean }) =>
      unwrap(commands.codexSetSkillEnabled(a.path, a.enabled)),
    onSuccess: refresh,
  });
  // Resolves to whether the LIVE Codex sessions picked the change up — `false` means
  // the config was written but the live reload failed (it applies on the next session
  // spawn); the manager surfaces that as a non-blocking warning.
  const mcp = useMutation({
    mutationFn: (a: { name: string; enabled: boolean }): Promise<boolean> =>
      unwrap(commands.codexSetMcpEnabled(a.name, a.enabled)),
    onSuccess: refresh,
  });
  const plugin = useMutation({
    mutationFn: (a: { pluginId: string; enabled: boolean }): Promise<null> =>
      unwrap(commands.codexSetPluginEnabled(a.pluginId, a.enabled)),
    onSuccess: refresh,
  });
  // `cwd` keeps the signature symmetrical with the Claude hooks (and documents which
  // snapshot the caller is looking at); the invalidation is prefix-wide regardless.
  void cwd;
  return { skill, mcp, plugin };
}

/**
 * Codex marketplace actions (`marketplace/add` / `remove` / `upgrade`) — each
 * invalidates both Codex inventories on success so the sections reflect the change.
 */
export function useCodexMarketplaceActions() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: codexPluginsKey() });
    void qc.invalidateQueries({ queryKey: ["codex-extensions"] });
  };
  const add = useMutation({
    mutationFn: (source: string): Promise<null> => unwrap(commands.codexMarketplaceAdd(source)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string): Promise<null> => unwrap(commands.codexMarketplaceRemove(name)),
    onSuccess: refresh,
  });
  const upgrade = useMutation({
    mutationFn: (name: string): Promise<null> => unwrap(commands.codexMarketplaceUpgrade(name)),
    onSuccess: refresh,
  });
  return { add, remove, upgrade };
}

/**
 * Read a skill's `SKILL.md` / a sub-agent's `.md` (by absolute path) for the
 * markdown viewer. Reuses the editor's `read_file` (text, with binary/size guards).
 * Cached per path; disabled when `path` is null (viewer closed).
 */
export function useExtensionDoc(path: string | null) {
  return useQuery({
    queryKey: ["ext-doc", path] as const,
    enabled: !!path,
    queryFn: () => unwrap(commands.readFile(path!)),
    staleTime: 60_000,
  });
}

/**
 * Everything a single plugin provides (skills / sub-agents / MCP servers), for the
 * per-plugin explorer. Scanned regardless of the plugin's enabled state, so a
 * disabled plugin still opens. `path` roots the relevant install; disabled when
 * either `path` or `pluginId` is null (explorer closed). Cached per (path, plugin).
 */
export function usePluginContents(path: string | null, pluginId: string | null) {
  return useQuery<PluginContents>({
    queryKey: ["plugin-contents", path, pluginId] as const,
    enabled: !!path && !!pluginId,
    queryFn: () => unwrap(commands.listPluginContents(path!, pluginId!)),
    staleTime: 30_000,
  });
}

/** Query key for a session's live MCP status (keyed by the live session handle). */
export const mcpStatusKey = (handle: string | null) => ["mcp-status", handle] as const;

/**
 * The LIVE MCP server status of a running session (real connection state + tools
 * per server + scope), queried from the `claude` process via the `mcp_status`
 * control request. Disabled when `handle` is null (no live process). Light polling
 * while open so a server still connecting (claude.ai connectors take a few seconds)
 * settles from `pending`/`checking_status` to `connected` without a manual refresh.
 */
export function useMcpStatus(handle: string | null) {
  return useQuery<McpServerLive[]>({
    queryKey: mcpStatusKey(handle),
    enabled: !!handle,
    queryFn: () => unwrap(commands.mcpStatus(handle!)),
    staleTime: 2_000,
    refetchInterval: 4_000,
  });
}

/**
 * Live MCP actions for a running session (control channel). Each mutation, on
 * success, invalidates the session's `mcp_status` so the row reflects the new state
 * after the next poll. Disabled (no-op) when `handle` is null. These only exist in
 * the conversation lens — the project lens has no live process.
 */
export function useMcpActions(handle: string | null) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: mcpStatusKey(handle) });

  const toggle = useMutation({
    mutationFn: (a: { serverName: string; enabled: boolean }): Promise<null> =>
      unwrap(commands.mcpToggle(handle!, a.serverName, a.enabled)),
    onSuccess: refresh,
  });
  const reconnect = useMutation({
    mutationFn: (serverName: string): Promise<null> =>
      unwrap(commands.mcpReconnect(handle!, serverName)),
    onSuccess: refresh,
  });
  const clearAuth = useMutation({
    mutationFn: (serverName: string): Promise<null> =>
      unwrap(commands.mcpClearAuth(handle!, serverName)),
    onSuccess: refresh,
  });
  // Authenticate: open the returned authUrl in the system browser. The CLI handles
  // the loopback callback itself in the common case; the 4s mcp_status poll then
  // settles the server from `needs-auth` to `connected` without a manual step.
  const authenticate = useMutation({
    mutationFn: async (serverName: string) => {
      const res = await unwrap(commands.mcpAuthenticate(handle!, serverName));
      if (res.error) throw new Error(res.error);
      if (res.auth_url) await openUrl(res.auth_url);
      // Non-loopback OAuth: the CLI can't complete the callback on its own and needs
      // the redirect URL pasted back (mcp_oauth_callback_url) — a flow not yet wired
      // here. Surface that instead of leaving the server silently stuck in needs-auth.
      if (res.requires_user_action) {
        throw new Error(
          "Finish authenticating in the browser. This server requires the redirect URL to be pasted back — a flow not yet handled here; reconnect the server once authenticated.",
        );
      }
      return res;
    },
    onSuccess: refresh,
  });

  return { toggle, reconnect, clearAuth, authenticate };
}

/**
 * Enable/disable a plugin (USER-GLOBAL — writes ~/.claude/settings.json). On
 * success it invalidates `path`'s snapshot so the panel reflects the new enabled
 * state and the skills/agents an enabled plugin now (un)contributes. The change
 * applies to a live session only on its next (re)start.
 */
export function useSetPluginEnabled(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pluginId: string; enabled: boolean }): Promise<null> =>
      unwrap(commands.setPluginEnabled(args.pluginId, args.enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: extensionsKey(path) }),
  });
}

// ---- Plugin updates (marketplaces + auto-update + on-demand update) -----------
//
// Marketplaces are USER-GLOBAL (not repo-scoped), so their list caches under a single
// key. Auto-update is a PER-MARKETPLACE flag (the only granularity Claude Code exposes)
// with a global master that flips them all. "Update now" is per-plugin: it shells out
// to `claude plugin update`, then hot-applies to a live session via `reload_plugins`.

/** Query key for the user-global marketplace list (with per-marketplace auto-update). */
export const marketplacesKey = () => ["marketplaces"] as const;

/**
 * The marketplaces registered with Claude Code, each with its resolved auto-update
 * state. User-global; `path` only gates the fetch (disabled when the manager is
 * closed / no target). Refetches on window focus so a marketplace added / auto-update
 * changed from the CLI shows up.
 */
export function useMarketplaces(path: string | null) {
  return useQuery<MarketplaceInfo[]>({
    queryKey: marketplacesKey(),
    enabled: !!path,
    queryFn: () => unwrap(commands.listMarketplaces()),
    // 0 so the section refetches whenever it (re)mounts — i.e. on every manager open,
    // matching the "fresh picture on each open" contract the extensions snapshot has.
    // Our own toggles/refresh invalidate this key too; this only adds the on-open read.
    staleTime: 0,
  });
}

/**
 * Refresh marketplace(s) from upstream — the network "Check for updates"
 * action (`claude plugin marketplace update`, all when `name` is omitted). On success
 * it invalidates BOTH the extensions snapshot (so per-plugin `update_available`
 * recomputes against the fresh pins) and the marketplace list. Can take a few seconds.
 */
export function useCheckPluginUpdates(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name?: string | null): Promise<string> =>
      unwrap(commands.refreshPluginMarketplaces(name ?? null)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: extensionsKey(path) });
      void qc.invalidateQueries({ queryKey: marketplacesKey() });
    },
  });
}

/**
 * Update ONE plugin to its marketplace's latest version (`claude plugin update`),
 * then — when a live session exists — hot-apply it with `reload_plugins` so a running
 * conversation picks it up without a restart. A failed hot-reload is non-fatal (the
 * update is already on disk and lands on the next spawn; a genuine reject still
 * surfaces in the thread as a control error), so it never fails the mutation. On
 * success the extensions snapshot is invalidated so the "update available" badge clears.
 *
 * ⚠️ Two layers must be refreshed, not one: `reload_plugins` updates the session's
 * CAPABILITY, `refetchSlashCommands` updates the `/` MENU. The plugin-toggle path in
 * ExtensionsManager does both; this one used to do only the first, so updating a
 * plugin whose new version adds or removes commands left the menu showing the old
 * catalogue until the next spawn.
 */
export function useUpdatePlugin(path: string | null, handle: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { pluginId: string; scope: string | null }): Promise<string> => {
      // Pass the repo/conversation cwd so project/local-scoped updates resolve the
      // right project (the CLI selects it from the working directory).
      // The CLI's verdict is the RESULT: exit 0 does not mean the plugin moved (it
      // exits 0 on "already at the latest version" and on "Skipped — …"), so the
      // caller renders this line instead of implying success.
      const verdict = await unwrap(commands.updatePlugin(args.pluginId, args.scope, path ?? ""));
      if (handle) {
        // Best-effort hot-apply; a dead session ("unknown session") is harmless here.
        try {
          await unwrap(commands.reloadPlugins(handle));
        } catch {
          /* update already written to disk; it applies on the next session spawn */
        }
      }
      // Refresh the `/` catalogue for this cwd even with no live session: it runs an
      // ephemeral spawn that re-reads the disk, so the menu matches the new version.
      await refetchSlashCommands(path);
      return verdict;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: extensionsKey(path) }),
  });
}

/**
 * Toggle one marketplace's auto-update (writes settings.json). Invalidates the
 * marketplace list so the switch reflects the new state.
 */
export function useSetMarketplaceAutoUpdate(_path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; enabled: boolean }): Promise<null> =>
      unwrap(commands.setMarketplaceAutoUpdate(args.name, args.enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: marketplacesKey() }),
  });
}

/**
 * The global master: turn auto-update on/off for EVERY marketplace at once. `path`
 * is unused by the command (user-global) but kept in the signature for symmetry.
 */
export function useSetAllMarketplacesAutoUpdate(_path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean): Promise<null> =>
      unwrap(commands.setAllMarketplacesAutoUpdate(enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: marketplacesKey() }),
  });
}

export type { ExtensionsSnapshot, MarketplaceInfo };
