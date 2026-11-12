// Why a conversation's process is being stopped RIGHT NOW — read by conversationWatch.ts to tell
// the app's own plumbing stops (a restart, a rewind, a fork, an account switch, a removed
// worktree: the conversation carries on afterwards) from the user's own Stop.
//
// Its own tiny module because both sides need it: `stopConversationSession`
// (conversationsStore.ts) marks every stop it runs, and the watch module reads the mark — which
// imports conversationsStore, so the store cannot import the watch module back.
//
// ⚠️ The core emits `ended{stopped}` WHILE the handle is still bound (the actor's teardown runs
// before `stop_session` returns), so the mark must be up for the whole round trip: set before
// `commands.stopSession`, cleared only after the handle is unbound.

const appStopping = new Map<string, number>();

/** A stop of `convId` is starting (re-entrant: nested stops count). */
export function beginAppStop(convId: string): void {
  appStopping.set(convId, (appStopping.get(convId) ?? 0) + 1);
}

/** …and is over (the handle is unbound). */
export function endAppStop(convId: string): void {
  const n = (appStopping.get(convId) ?? 0) - 1;
  if (n > 0) appStopping.set(convId, n);
  else appStopping.delete(convId);
}

/** Is the app stopping `convId` right now (any stop it runs, the user's included)? */
export function isAppStopping(convId: string): boolean {
  return appStopping.has(convId);
}
