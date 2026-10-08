// Pure resolver for the plugin-reload bar in ExtensionsManager.
//
// Toggling a plugin writes settings.json (user-global); a RUNNING `claude` session
// reads `enabledPlugins` only at spawn. To hot-apply a toggle we send `reload_plugins`
// to the repo's LIVE sessions (VERIFIED: it re-scans the plugin, skills included) and
// refresh the `/` command menu. This module decides WHICH conversations are in scope.
import type { Conversation, Repo } from "../../store/conversationsStore";
import type { ExtensionsTarget } from "./extensionsUiStore";

export interface ReloadTargets {
  /** Every CLAUDE conversation of the target's repo whose stream is live (handle
   *  bound). Codex conversations are out of scope — see resolveReloadTargets. */
  liveConvs: Conversation[];
  /** The lens's own conversation, only when it is live (conversation lens) AND runs on
   *  Claude. Null in the repo lens or when that conversation's process is off. */
  currentConv: Conversation | null;
}

/**
 * Resolve the reload scope for the extensions manager's current target.
 *
 * - Conversation lens: the repo is derived from the lens's conversation; `currentConv`
 *   is that conversation when live.
 * - Project (repo) lens: the repo is matched by `target.path`; there is no current
 *   conversation.
 *
 * "Live" means a live Rust session handle is bound (`handle != null`).
 *
 * CLAUDE conversations only: the bar hot-applies a Claude plugin toggle — a
 * settings.json write plus the `reload_plugins` control request, which the Codex actor
 * ignores as a no-op — and refetches the `/` menu by spawning an ephemeral `claude`.
 * A live Codex conversation neither reads settings.json nor answers the request, so
 * counting it would inflate "All live conversations (N)" and claim an
 * application that never happens.
 */
export function resolveReloadTargets(
  target: ExtensionsTarget | null,
  conversations: Conversation[],
  repos: Repo[],
): ReloadTargets {
  if (!target) return { liveConvs: [], currentConv: null };
  const current =
    target.kind === "conversation" && target.session
      ? (conversations.find((c) => c.id === target.session) ?? null)
      : null;
  const currentConv = current?.handle && current.kind === "claude" ? current : null;
  // The project lens names its folder by (machine, path): a path alone could pick another
  // folder that shares it — a server one, or the clone on this Mac.
  const repoId =
    current?.repoId ??
    repos.find((r) => r.path === target.path && (r.machineId ?? null) === (target.machineId ?? null))
      ?.id ??
    null;
  const liveConvs = repoId
    ? conversations.filter(
        (c) => c.repoId === repoId && c.handle != null && c.kind === "claude",
      )
    : [];
  return { liveConvs, currentConv };
}

/** The distinct effective cwds (worktree-aware) to refresh the `/` menu for. */
export function distinctCwds(convs: Conversation[]): string[] {
  return [...new Set(convs.filter((c) => c.handle).map((c) => c.liveCwd ?? c.cwd))];
}
