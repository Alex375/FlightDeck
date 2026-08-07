// Pure, side-effect-free derivations for the plugin-update UI. Kept apart from the
// React component so they can be unit-tested without a DOM (see pluginUpdates.test.ts).

import type { ExtScope, MarketplaceInfo, PluginInfo } from "../../ipc/client";

/**
 * Map a plugin's install scope to the CLI `-s <scope>` argument for
 * `claude plugin update`. A plugin is installed at user / project / local scope;
 * `"plugin"` is never an install scope, so it maps to `null` (omit the flag).
 */
export function cliScope(scope: ExtScope): "user" | "project" | "local" | null {
  return scope === "user" || scope === "project" || scope === "local" ? scope : null;
}

/**
 * The badge text for a plugin that has a PROVEN update. A concrete "vX → vY" when both
 * the installed and target human versions are known and differ; otherwise a generic
 * label — never a misleading "vX → vX".
 *
 * Note `update_available === true` now implies `latest_version !== null` (the core only
 * claims an update it can prove from versions — a bare commit move reports
 * `update_unproven` instead, which renders its own muted badge). The generic branch is
 * therefore defensive only: it still guards an unknown INSTALLED version.
 */
export function updateBadgeLabel(
  version: string | null,
  latestVersion: string | null,
): string {
  if (version && latestVersion && version !== latestVersion) {
    return `v${version} → v${latestVersion}`;
  }
  return "Update available";
}

/** How many installed plugins from `marketplace` have an update available. */
export function updatesForMarketplace(plugins: PluginInfo[], marketplace: string): number {
  return plugins.filter((p) => p.marketplace === marketplace && p.update_available).length;
}

/** Total installed plugins (across marketplaces) with an update available. */
export function totalUpdates(plugins: PluginInfo[]): number {
  return plugins.filter((p) => p.update_available).length;
}

/**
 * Whether the global master auto-update toggle should read as ON: true only when
 * there is at least one marketplace and every one has auto-update enabled (a mixed or
 * empty set reads as OFF, and flipping the master turns them all ON).
 */
export function allMarketplacesAuto(list: MarketplaceInfo[]): boolean {
  return list.length > 0 && list.every((m) => m.auto_update);
}
