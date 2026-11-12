// Remote conversations whose permission mode the user picked and no process of theirs has
// confirmed yet — persisted to localStorage, so the mark survives a relaunch.
//
// Why: a conversation on a paired server outlives this app, and its process can change mode
// while no session of this Mac watches it — a plan approved from the phone, the agent entering
// plan mode on its own. Its record then holds a STALE mode, which the next session must not
// force back onto the process (the implementing agent was thrown back into plan mode). But the
// record also holds a mode the user just picked with no session to take it (the composer works
// on a conversation that is not running), which the next session must apply. Only this Mac
// knows which of the two the record holds: a pick is marked here, and the spawn tells the
// session (`SpawnFlags.permissionPickPending`) — the session keeps the live mode otherwise.
//
// The mark is dropped once the session settles a mode for the conversation
// (`SessionPermissionSettledEvent`: the pick confirmed, or the mode the process was found in),
// and with the conversation. Same shape as the other per-conversation localStorage caches:
// best-effort, never throws.

const KEY = "tosse:permissionpicks";

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set(); // corrupt/absent → empty, never throw
  }
}

function write(ids: Set<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch (e) {
    console.warn("permissionPicks: failed to persist", e);
  }
}

/** The user picked the permission mode of remote conversation `convId`: it is to be applied by
 *  the next session that has not confirmed it yet. */
export function markPermissionPick(convId: string): void {
  const ids = read();
  if (ids.has(convId)) return;
  ids.add(convId);
  write(ids);
}

/** Whether the permission mode of `convId` is a pick still to be applied. */
export function permissionPickPending(convId: string): boolean {
  return read().has(convId);
}

/** A session settled the permission mode of `convId`, or the conversation is gone. */
export function clearPermissionPick(convId: string): void {
  const ids = read();
  if (!ids.delete(convId)) return;
  write(ids);
}

/** Drop every mark (wipe all data). */
export function clearAllPermissionPicks(): void {
  write(new Set());
}
