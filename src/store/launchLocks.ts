// Conversations being moved to a server (the server launch, `features/conversation/serverLaunch`):
// while one is, nothing may start it HERE — a first message would spawn its `claude` on this Mac,
// in the very folder the launch is copying away from. A module of its own so the conversations
// store can read it without importing the launch (which imports the store).

import { MACHINE } from "../ui/platform";

const locked = new Map<string, string>();

/** Mark `convId` as being moved to the server named `server`. */
export function lockForLaunch(convId: string, server: string): void {
  locked.set(convId, server);
}

/** The move is over (started there, or abandoned). */
export function unlockForLaunch(convId: string): void {
  locked.delete(convId);
}

/** The server `convId` is being moved to, or `null` when it is not. */
export function launchLockFor(convId: string): string | null {
  return locked.get(convId) ?? null;
}

// What ends a move whose conversation goes away (removed, its folder removed): registered by
// the launch store, called by the conversations store — neither imports the other.
let abortHandler: ((convId: string) => void) | null = null;

export function onLaunchAbort(fn: (convId: string) => void): void {
  abortHandler = fn;
}

/** The conversation is being removed: end its move, if one runs (and clean up after it). */
export function abortLaunchFor(convId: string): void {
  if (locked.has(convId)) abortHandler?.(convId);
}

/** Why a spawn is refused while the move runs. */
export function launchLockedMessage(server: string): string {
  return `This conversation is being moved to ${server} — it starts there once the move is done (or cancel the move to run it on this ${MACHINE}).`;
}
