// Slash-command catalogue, keyed by folder — a cwd ON A MACHINE (see `commandsPlace`).
//
// The core advertises a session's available commands once, in its `initialize`
// control response (the same source the VS Code extension uses). But our spawn
// is LAZY — no `claude` process exists until the first message — so the composer
// must be able to show the `/` menu *before* a session exists (typing `/pickup`
// as the very first thing is the canonical case). Commands are a function of the
// folder (built-ins + user/plugin skills are global to a machine; only a repo's own
// `.claude/skills` differ), so we cache them per folder and persist that cache to
// localStorage. After a repo has been opened once, its `/` menu works instantly
// on every later visit and across restarts — no spawn required.
//
// ⚠️ Two machines, two sources. A folder on this Mac can be probed up front (a
// short-lived local `claude`, `fetch_slash_commands`). A folder on a paired server
// CANNOT — that probe would run on the Mac, against the Mac's plugins, at a path that
// may not even exist here — so a remote catalogue only ever comes from a session that
// actually ran on that server (the passive `SessionCommandsEvent` feed).

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { commands } from "../ipc/client";
import type { SlashCommand } from "../ipc/client";
import { commandsKey, isRemotePlace, machineKey, type CommandsPlace } from "./commandsPlace";

const STORAGE_KEY = "tosse:slash-commands-by-place";
/** The pre-machine cache, keyed by bare cwd. Not migrated: an entry there may have been
 *  written by a session on a server that shares a path with a Mac folder, and nothing
 *  recorded which — so none of it can be trusted for either machine. Dropped on load; a
 *  local folder re-probes once, a remote one waits for its next session. */
const LEGACY_STORAGE_KEY = "tosse:slash-commands-by-cwd";

type ByPlace = Record<string, SlashCommand[]>;

/** Load the persisted cache; never throws (a corrupt/absent entry → empty). */
function loadCache(): ByPlace {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ByPlace) : {};
  } catch {
    return {};
  }
}

/** Persist best-effort; a storage failure must never break the UI. */
function saveCache(byPlace: ByPlace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byPlace));
  } catch {
    /* quota / unavailable — the in-memory store still works this run */
  }
}

/** The machine half of a stored key (see `commandsKey`). */
function machineOfKey(key: string): string {
  const sep = key.indexOf("\u0000");
  return sep < 0 ? key : key.slice(0, sep);
}

/** Rebuild the per-machine fallback from a loaded cache: any non-empty list per machine. */
function lastSeenFrom(byPlace: ByPlace): Record<string, SlashCommand[]> {
  const out: Record<string, SlashCommand[]> = {};
  for (const [key, list] of Object.entries(byPlace)) {
    const machine = machineOfKey(key);
    if (list.length > 0 && !out[machine]) out[machine] = list;
  }
  return out;
}

interface CommandsState {
  /** Catalogue per folder, under `commandsKey(place)`. */
  byPlace: ByPlace;
  /** Per MACHINE (`machineKey`): the most recently seen non-empty list, the fallback for
   *  a folder of that machine we have never seen (built-ins + global skills are identical
   *  across its repos). Per machine because a server's plugins are not the Mac's — a
   *  remote `/` menu filled from the Mac would offer commands the server does not know. */
  lastSeen: Record<string, SlashCommand[]>;
  /** Record the commands a session (or a probe) reported for a folder. */
  setCommands: (place: CommandsPlace, commands: SlashCommand[]) => void;
}

export const useCommandsStore = create<CommandsState>((set) => {
  const initial = loadCache();
  return {
    byPlace: initial,
    lastSeen: lastSeenFrom(initial),

    setCommands: (place, commands) =>
      set((s) => {
        const byPlace = { ...s.byPlace, [commandsKey(place)]: commands };
        saveCache(byPlace);
        return {
          byPlace,
          lastSeen:
            commands.length > 0
              ? { ...s.lastSeen, [machineKey(place.machineId)]: commands }
              : s.lastSeen,
        };
      }),
  };
});

/** The cached catalogue for exactly this folder, or undefined when never seen. */
export function cachedCommands(place: CommandsPlace): SlashCommand[] | undefined {
  return useCommandsStore.getState().byPlace[commandsKey(place)];
}

const EMPTY: SlashCommand[] = [];

/**
 * The slash commands to offer for a conversation's folder. Prefers the exact folder's
 * catalogue; falls back to the last-seen list OF THE SAME MACHINE so a never-spawned repo
 * still gets a useful (built-ins + global skills) menu. Empty on a truly cold start — and
 * for a server no session has run on yet, rather than borrowing the Mac's.
 */
export function useSlashCommands(place: CommandsPlace | null): SlashCommand[] {
  return useCommandsStore(
    useShallow(
      (s) =>
        (place && s.byPlace[commandsKey(place)]) ||
        s.lastSeen[machineKey(place?.machineId)] ||
        EMPTY,
    ),
  );
}

// Folders (by key) whose one-shot fetch has already been attempted this run (dedupe).
const fetchAttempted = new Set<string>();

/**
 * Make sure a folder's command catalogue is loaded, fetching it once via a
 * short-lived `claude` if we have never seen it. This is what makes the `/` menu
 * work BEFORE the lazy session spawns — without it, typing `/` as the first
 * thing in a fresh repo shows nothing until a message is sent. Cheap and
 * idempotent: skipped if already cached (incl. from localStorage) or in flight.
 *
 * A no-op for a folder on a server: the probe spawns `claude` on THIS Mac (see the header).
 */
export async function prefetchSlashCommands(place: CommandsPlace | null): Promise<void> {
  if (!place?.cwd || isRemotePlace(place)) return;
  const key = commandsKey(place);
  if (useCommandsStore.getState().byPlace[key]?.length || fetchAttempted.has(key)) return;
  fetchAttempted.add(key);
  try {
    const res = await commands.fetchSlashCommands(place.cwd);
    if (res.status === "ok" && res.data.length > 0) {
      useCommandsStore.getState().setCommands(place, res.data);
    } else {
      fetchAttempted.delete(key); // empty/failed → allow a later retry
    }
  } catch {
    fetchAttempted.delete(key);
  }
}

/**
 * Force a re-fetch of a folder's catalogue, OVERWRITING the cache. Unlike
 * `prefetchSlashCommands` this ignores the "already cached / already attempted"
 * guards — it is what `/reload-skills` triggers so the `/` menu reflects skills
 * the user just added, removed, or edited on disk. A fresh short-lived `claude`
 * re-reads the current on-disk skills at `initialize`, independently of the live
 * session's own reload. A failed/empty fetch leaves the existing cache intact
 * (a transient spawn failure must never blank the menu).
 *
 * A no-op for a folder on a server, like the prefetch: there the live session's own
 * reload reply carries the fresh catalogue (`SessionCommandsEvent`).
 */
export async function refetchSlashCommands(place: CommandsPlace | null): Promise<void> {
  if (!place?.cwd || isRemotePlace(place)) return;
  try {
    const res = await commands.fetchSlashCommands(place.cwd);
    if (res.status === "ok" && res.data.length > 0) {
      fetchAttempted.add(commandsKey(place)); // now known — keep prefetch deduped
      useCommandsStore.getState().setCommands(place, res.data);
    }
  } catch {
    /* keep the old cache */
  }
}
