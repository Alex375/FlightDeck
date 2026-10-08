// WHERE a slash-command catalogue was seen: a folder on this Mac, or a folder on a paired
// server. Pure, and kept out of `commandsStore` so the tests that mock the store still share
// the one definition of the key.
//
// ⚠️ A cwd alone does not name a folder. The catalogue used to be keyed by the bare cwd, so
// a Mac clone and a server clone sharing a path (`~/Repos/app` on both) overwrote each
// other's catalogue — and the TOSSE launch then sent `/tosse-workflow:pickup` to a server
// that did not have the plugin, where it arrives as plain text and moves nothing. The
// machine is part of the identity, on every read and every write.

/** A folder whose catalogue we keep: `machineId` null/absent = on this Mac. */
export interface CommandsPlace {
  cwd: string;
  machineId?: string | null;
}

/** The key segment for "this Mac". Machine ids are uuids, so it cannot collide. */
const LOCAL = "local";

/** The machine half of a key — also what the per-machine `lastSeen` fallback is keyed by. */
export function machineKey(machineId: string | null | undefined): string {
  return machineId || LOCAL;
}

/** The catalogue key for a place. NUL-separated: no path or machine id can contain it. */
export function commandsKey(place: CommandsPlace): string {
  return `${machineKey(place.machineId)}\u0000${place.cwd}`;
}

/** Whether a place lives on a paired server rather than on this Mac. */
export function isRemotePlace(place: CommandsPlace): boolean {
  return !!place.machineId;
}

/** A registered folder's own place: its path, on its machine. */
export function repoPlace(repo: { path: string; machineId?: string | null }): CommandsPlace {
  return { cwd: repo.path, machineId: repo.machineId ?? null };
}

/**
 * The place a conversation's catalogue belongs to: its cwd, on the machine its repository
 * lives on. `cwd` is passed in rather than read off the conversation because the callers
 * differ on purpose — the passive session feed files under the anchor `cwd`, the plugin
 * reload refreshes the effective (worktree) one.
 *
 * `null` when the repository is no longer in the store: with no machine to attribute the
 * catalogue to, filing it as local could be exactly the mix-up this key exists to prevent.
 */
export function conversationPlace(
  cwd: string,
  repoId: string,
  repos: readonly { id: string; machineId?: string | null }[],
): CommandsPlace | null {
  const repo = repos.find((r) => r.id === repoId);
  return repo ? { cwd, machineId: repo.machineId ?? null } : null;
}
