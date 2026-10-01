// What the Extensions panel shows for a repository that lives on a paired SERVER.
//
// The on-disk inventory (`list_extensions`) reads THIS Mac's `~/.claude` — and reads the
// server's path on the Mac, where it does not exist, so a missing file there reads as
// "nothing configured". Neither describes the remote agent. What does is the session's own
// report: its skills, sub-agents and plugins as the running binary loaded them (see
// `SessionStatePayload.loaded_*`). This module holds the pure decisions behind those
// sections — kept out of the component so they are unit-tested.

import type { Cascade, PermissionScope } from "./mcpToolPermissions";

/** What a conversation's scope may read and write of Claude Code's permission rules. */
export interface RuleAccess {
  /** Folder whose Claude Code files are read (`null` = this Mac's user/managed only). */
  repoPath: string | null;
  /** Whether any file is read at all — not for a remote session, whose rules are on the server. */
  readFiles: boolean;
  /** Why the scope can't be changed from this panel (`null`: it can). */
  readOnlyReason: string | null;
}

export const GLOBAL_FROM_REMOTE =
  "Global also reaches this Mac's conversations, which follow this Mac's own rules — rules this remote conversation's rows don't show. Change Global in Settings → Extensions, or from a conversation on this Mac.";

/**
 * Rules access for a conversation's scope. On this Mac: its files. On a server, the rows are
 * the REMOTE session's servers and tools, whose own Claude Code rules can't be read from here
 * — and this Mac's rules don't govern them, so they must not lock or explain them either.
 * Global is then read-only: it also reaches this Mac's conversations, whose baseline
 * (managed policy included) this panel doesn't show — writing it blind could offer an
 * "Allow" that policy forbids. Settings → Extensions shows that baseline.
 */
export function ruleAccess(remote: boolean, scope: PermissionScope, path: string): RuleAccess {
  if (!remote) return { repoPath: path, readFiles: true, readOnlyReason: null };
  return {
    repoPath: path,
    readFiles: false,
    readOnlyReason: scope === "global" ? GLOBAL_FROM_REMOTE : null,
  };
}

/** Which body the Extensions panel renders. */
export type ExtensionsBody =
  /** A Codex conversation in a remote repository: Codex never runs on a server. */
  | "remote-codex"
  /** The Codex tab of a repository on this Mac. */
  | "codex"
  /** A Claude conversation's live lens (on this Mac or on a server). */
  | "conversation"
  /** The repository lens of a repository on a server: no scan of this Mac. */
  | "remote-repository"
  /** The repository lens (Claude's configured inventory) on this Mac. */
  | "repository";

/**
 * Pick the panel's body. The REMOTE question comes first: on a server neither this Mac's
 * scan nor its Codex picture describes anything. Codex being detected or not only decides
 * whether the tab bar shows — never which body a local Codex conversation gets (gating on
 * it sent such a conversation to Claude's inventory, whose toggles write `~/.claude`).
 */
export function extensionsBody(o: {
  remote: boolean;
  /** The conversation's backend; `null` for the repository lens. */
  liveBackend: "claude" | "codex" | null;
  activeTab: "claude" | "codex";
}): ExtensionsBody {
  if (o.remote) {
    if (o.liveBackend === "codex") return "remote-codex";
    return o.liveBackend === "claude" ? "conversation" : "remote-repository";
  }
  if (o.activeTab === "codex") return "codex";
  return o.liveBackend === "claude" ? "conversation" : "repository";
}

/** A pending "Ask now" (a `reload_plugins` sent to make the session report its lists). */
export interface AskState {
  /** The session the request went to — an answer, or an error, concerns that one only. */
  askedHandle: string | null;
  error: string | null;
}

export const NO_ASK: AskState = { askedHandle: null, error: null };

/** What a remote list section shows. */
export type RemoteListView =
  /** No live session: nothing can report yet. */
  | "no-session"
  /** A live session that has not reported this list, and can be asked for it now. */
  | "can-ask"
  /** A live session that will report it with its next turn (no request returns it). */
  | "next-turn"
  /** An "Ask now" for THIS session is in flight. */
  | "asking"
  | "empty"
  | "list";

/**
 * The state of one remote list. The answer always wins: once the list is known, a stale
 * request state (one that timed out, one sent to an earlier session) no longer shows.
 */
export function remoteListView(
  list: readonly unknown[] | null | undefined,
  handle: string | null,
  canAsk: boolean,
  ask: AskState,
): RemoteListView {
  if (list != null) return list.length ? "list" : "empty";
  if (handle == null) return "no-session";
  if (canAsk && ask.askedHandle === handle && ask.error == null) return "asking";
  return canAsk ? "can-ask" : "next-turn";
}

/** The request error to show: only for THIS session, and only while its answer is missing. */
export function visibleAskError(
  list: readonly unknown[] | null | undefined,
  handle: string | null,
  ask: AskState,
): string | null {
  return list == null && handle != null && ask.askedHandle === handle ? ask.error : null;
}

/** Whether an "Ask now" is still waiting for its answer (drives its bounded wait). */
export function askWaiting(list: readonly unknown[] | null | undefined, handle: string | null, ask: AskState): boolean {
  return list == null && handle != null && ask.askedHandle === handle && ask.error == null;
}

/** One group of a remote list: a plugin's items (`plugin:item`), or the bare ones (`null`). */
export interface NameGroup<T> {
  plugin: string | null;
  items: { label: string; item: T }[];
}

/**
 * Group by the plugin that provides each item, from its `plugin:item` name. Bare names come
 * first, then one group per plugin; alphabetical inside. Only the FIRST `:` splits — the
 * item part keeps any colon of its own.
 */
export function groupByPlugin<T>(items: readonly T[], nameOf: (t: T) => string): NameGroup<T>[] {
  const groups = new Map<string | null, { label: string; item: T }[]>();
  for (const item of items) {
    const name = nameOf(item);
    const at = name.indexOf(":");
    const plugin = at > 0 ? name.slice(0, at) : null;
    const label = at > 0 ? name.slice(at + 1) : name;
    const g = groups.get(plugin) ?? [];
    g.push({ label, item });
    groups.set(plugin, g);
  }
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([plugin, list]) => ({ plugin, items: [...list].sort(byLabel) }));
}

/** A plugin on/off that Flight Deck itself applies to the context (not Claude Code's own). */
export interface PluginOverride {
  id: string;
  enabled: boolean;
  /** Where it is set — what clearing it removes. */
  level: "conversation" | "repository";
}

/**
 * Flight Deck's own plugin settings that reach a context, the narrowest winning: what the
 * session is told on spawn (`sessionOverridesFrom`). Listed for a REMOTE repository, whose
 * panel cannot toggle plugins (that would write this Mac's config) — without this, a
 * setting made before stays applied to every spawn while nothing shows it or undoes it.
 * `levels` = the ones the lens sees, narrowest first.
 */
export function pluginOverrides(
  cascade: Cascade,
  levels: readonly ("conversation" | "repository")[],
): PluginOverride[] {
  const out = new Map<string, PluginOverride>();
  for (const level of levels) {
    for (const [id, enabled] of Object.entries(cascade[level]?.plugins ?? {})) {
      if (!out.has(id)) out.set(id, { id, enabled, level });
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
