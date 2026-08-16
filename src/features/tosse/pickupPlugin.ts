// Getting the TOSSE skills AVAILABLE in a folder, rather than merely reporting that they
// are not.
//
// They come from a plugin (`tosse-workflow@tosse-plugins`), enabled user-globally in
// `~/.claude/settings.json`. When it is installed but switched off, the honest thing is not
// to fall back to written instructions and say nothing could be done: it is to turn it back
// on — that is one write the user asked for, in their own config, for their own plugin.
//
// The distinction that drives the whole module: "not installed" (nothing we can do — the
// fallback prompt is the answer) versus "installed, disabled" (one toggle away).
//
// ⚠️ This is about the SKILLS only. The plugin ships skills and an agent, NOT the TOSSE MCP
// server — that one is a claude.ai account connector, which exists only inside a live
// session and no plugin toggle can reach. Enabling the plugin therefore equips a
// conversation with `/pickup`, `/done`… and nothing should claim more than that.

import { commands } from "../../ipc/client";
import { refetchSlashCommands } from "../../store/commandsStore";
import { pickupCommandName } from "./taskPrompts";

/** A plugin that provides the pickup skill, as the extensions scan sees it. */
export interface PickupPlugin {
  /** `<plugin>@<marketplace>` — the key `enabledPlugins` is written under. */
  id: string;
  name: string;
  enabled: boolean;
  /** Whether {@link enabled} was READ or merely assumed. False when the one file that
   *  holds `enabledPlugins` could not be parsed: the scan then reports every plugin as on
   *  (`plugin_state_trusted` in the Rust snapshot documents why). Kept apart from
   *  `enabled` rather than folded into it, because the two answers lead opposite ways —
   *  "it is on" means leave it alone, "we could not tell" means do not conclude. */
  enabledTrusted: boolean;
}

/**
 * The installed plugin that provides a `pickup` skill, if any.
 *
 * Found by what it PROVIDES, not by name: any plugin shipping the skill qualifies, and the
 * TOSSE one is simply the usual provider. A plugin's skills are scanned whatever its
 * enabled state, which is exactly what lets us see a disabled one.
 *
 * ⚠️ THROWS when the extensions cannot be read, rather than answering `null`. "We looked and
 * found nothing installed" and "we could not look" lead to opposite conclusions — the first
 * means there is nothing to switch on, the second means we know nothing at all — and a
 * single `null` for both would let a failed scan be reported to the user as a missing
 * plugin.
 */
export async function findPickupPlugin(repoPath: string): Promise<PickupPlugin | null> {
  const res = await commands.listExtensions(repoPath);
  if (res.status !== "ok") throw new Error(res.error);
  const snapshot = res.data;
  const providers = new Set(
    snapshot.skills
      .filter((s) => s.name === "pickup" || s.name.endsWith(":pickup"))
      .map((s) => s.source)
      .filter((s): s is string => s != null),
  );
  const plugin = snapshot.plugins.find((p) => providers.has(p.id));
  if (!plugin) return null;
  return {
    id: plugin.id,
    name: plugin.name,
    enabled: plugin.enabled,
    enabledTrusted: snapshot.plugin_state_trusted,
  };
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

/** What ensuring the plugin left behind — the caller stays quiet on the nominal path and
 *  SAYS the rest (see {@link activationProblem}). */
export type PluginActivation =
  /** A provider plugin is already on. Nothing was written. */
  | { kind: "present"; plugin: string }
  /** It was installed but off, and has just been switched on. `pickup` is the skill name
   *  the folder publishes now — `null` means the write went through and it still is not
   *  advertised, which is a half-success and gets said. */
  | { kind: "enabled"; plugin: string; pickup: string | null }
  /** We looked: no installed plugin provides the skill. There is nothing to switch on. */
  | { kind: "missing" }
  /** The write was refused. */
  | { kind: "failed"; plugin: string; error: string }
  /** The extensions could not be read — we never got to look, so nothing is concluded. */
  | { kind: "unknown"; error: string };

/**
 * Make sure the folder's TOSSE plugin is ON, switching it on when it is merely dormant.
 *
 * The single path both buttons take, and it runs BEFORE anything is spawned: enabling only
 * writes `~/.claude/settings.json`, which a `claude` process reads at startup — flipping it
 * afterwards would leave the conversation the user is looking at unequipped (a live session
 * would need `reload_plugins` on top).
 *
 * Enabling is deliberately automatic and silent on success: it is what the user asked for
 * by pressing a TOSSE button, and a confirmation for a switch they never wanted flipped off
 * would be noise. Silent means "quiet when it WORKS" — every other outcome is reported.
 */
export async function ensurePickupPlugin(
  repoPath: string,
  /** An answer the caller already has from its own {@link findPickupPlugin} — `null` means
   *  it looked and found none. Omit it (undefined) to scan here. The dialog holds this
   *  answer before the button is even pressed, and scanning again would read the same
   *  four config files a second time for the same launch. */
  known?: PickupPlugin | null,
): Promise<PluginActivation> {
  let plugin: PickupPlugin | null;
  try {
    plugin = known === undefined ? await findPickupPlugin(repoPath) : known;
  } catch (e) {
    return { kind: "unknown", error: errorText(e) };
  }
  if (!plugin) return { kind: "missing" };
  // `enabled` is only worth acting on when it was actually READ. Untrusted, we do not
  // conclude "already on" — we attempt the write, which either goes through (harmless, it
  // is the state we want) or comes back with the parse error that made the state
  // unreadable in the first place. Either beats opening an unequipped conversation while
  // reporting it as equipped.
  if (plugin.enabled && plugin.enabledTrusted) return { kind: "present", plugin: plugin.name };
  try {
    return { kind: "enabled", plugin: plugin.name, pickup: await enablePickupPlugin(plugin.id, repoPath) };
  } catch (e) {
    return { kind: "failed", plugin: plugin.name, error: errorText(e) };
  }
}

/**
 * The sentence to show for an activation, or `null` when there is nothing to say.
 *
 * Pure, and the single place the wording lives, because this is the whole "no silent
 * failure" contract of the launch: a conversation that opens WITHOUT the skills it was
 * supposed to get must never look exactly like one that got them.
 *
 * `missing` is not handled here on purpose — "this folder has no TOSSE plugin at all" is a
 * standing fact about the folder that the dialog says BEFORE launching, not an outcome of
 * having tried.
 *
 * ⚠️ EXHAUSTIVE on purpose, with no `default` arm: silence is this function's most
 * dangerous answer, so a variant added to {@link PluginActivation} later must not fall into
 * it by omission. Every case is listed, and the unreachable arm below turns a new one into
 * a compile error instead of a conversation that quietly opens without its skills.
 */
export function activationProblem(a: PluginActivation): string | null {
  switch (a.kind) {
    case "failed":
      return `« ${a.plugin} » could not be enabled, so this conversation opens without the TOSSE skills: ${a.error}`;
    case "unknown":
      return `This folder's extensions could not be read, so the TOSSE plugin could not be checked: ${a.error}`;
    case "enabled":
      return a.pickup
        ? null
        : `« ${a.plugin} » was enabled, but this folder still does not offer the pickup skill.`;
    case "present":
    case "missing":
      return null;
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
