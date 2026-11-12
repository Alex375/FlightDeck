// "The persisted conversations are loaded" — a one-shot signal, raised by `bootConversations`
// (conversationsStore.ts) ONLY when the load succeeded. A failed load leaves the list empty,
// indistinguishable from a fresh install by its contents alone, so anything that cleans up
// against "the conversations that exist" must wait for this, never infer it from the list.
//
// Its own module so a listener (conversationWatch.ts) need not import the store's boot path.

let booted = false;
const waiting: Array<() => void> = [];

/** The persisted conversations are in the store (called once, on a successful load). */
export function markConversationsBooted(): void {
  if (booted) return;
  booted = true;
  for (const cb of waiting.splice(0)) cb();
}

/** Run `cb` once the persisted conversations are loaded — at once if they already are. Never
 *  runs if the load failed. */
export function onConversationsBooted(cb: () => void): void {
  if (booted) cb();
  else waiting.push(cb);
}
