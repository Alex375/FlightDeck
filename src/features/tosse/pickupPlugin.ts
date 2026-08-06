// Getting the pickup skill AVAILABLE in a folder, rather than merely reporting that it
// is not.
//
// The skill normally comes from a plugin (`tosse-workflow@tosse-plugins`), enabled
// user-globally in `~/.claude/settings.json`. When it is installed but switched off, the
// honest thing is not to fall back to written instructions and say nothing could be done:
// it is to turn it back on — that is one write the user asked for, in their own config,
// for their own plugin.
//
// The distinction that drives the whole module: "not installed" (nothing we can do — the
// fallback prompt is the answer) versus "installed, disabled" (one toggle away).

import { commands } from "../../ipc/client";
import { refetchSlashCommands } from "../../store/commandsStore";
import { pickupCommandName } from "./taskPrompts";

/** A plugin that provides the pickup skill, as the extensions scan sees it. */
export interface PickupPlugin {
  /** `<plugin>@<marketplace>` — the key `enabledPlugins` is written under. */
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * The installed plugin that provides a `pickup` skill, if any.
 *
 * Found by what it PROVIDES, not by name: any plugin shipping the skill qualifies, and the
 * TOSSE one is simply the usual provider. A plugin's skills are scanned whatever its
 * enabled state, which is exactly what lets us see a disabled one.
 */
export async function findPickupPlugin(repoPath: string): Promise<PickupPlugin | null> {
  const res = await commands.listExtensions(repoPath);
  if (res.status !== "ok") return null;
  const snapshot = res.data;
  const providers = new Set(
    snapshot.skills
      .filter((s) => s.name === "pickup" || s.name.endsWith(":pickup"))
      .map((s) => s.source)
      .filter((s): s is string => s != null),
  );
  const plugin = snapshot.plugins.find((p) => providers.has(p.id));
  if (!plugin) return null;
  return { id: plugin.id, name: plugin.name, enabled: plugin.enabled };
}

/**
 * Enable `pluginId`, then re-read the folder's command catalogue and return the pickup
 * skill's published name.
 *
 * The re-read is what makes this trustworthy rather than optimistic: `set_plugin_enabled`
 * only writes `settings.json`, so we ask a fresh short-lived `claude` what it now
 * advertises. `null` means the write went through but the skill still is not there — which
 * the caller SAYS, instead of sending a slash command that would arrive as plain text.
 */
export async function enablePickupPlugin(
  pluginId: string,
  repoPath: string,
): Promise<string | null> {
  const res = await commands.setPluginEnabled(pluginId, true);
  if (res.status !== "ok") throw new Error(res.error);
  await refetchSlashCommands(repoPath);
  return pickupCommandName(repoPath);
}
