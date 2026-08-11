// Which cached queries a CRM change makes stale — the whole of the front's live-update
// policy, as a pure function.
//
// The core forwards a change as a bare KIND (`"task:updated"`), never a payload: the board
// is aggregated and sorted server-side, so rebuilding it here from an event would duplicate
// that logic in the UI — and the CRM's broadcast is GLOBAL (one client map, no per-user
// routing), so those payloads are not even scoped to what this user is looking at. An event
// is therefore a signal to REFETCH, and the queries stay the single readers of the shape.
//
// Kept separate from the hook that consumes it so the mapping is testable without a Tauri
// event bus or a QueryClient — and so a new CRM event kind is one line here, next to the
// test that pins what it must NOT touch.

import {
  tosseBacklogKey,
  tosseBriefingKey,
  tosseProjectReposKey,
  tosseRepoLinksKey,
  tosseTaskKeyPrefix,
} from "./useTosse";

/** A TanStack Query key PREFIX to invalidate (prefix matching is the default). */
export type InvalidationKey = readonly unknown[];

/**
 * The query prefixes a CRM event kind invalidates. Empty for anything this app does not
 * read — which is most of the feed.
 *
 * ⚠️ Total by design, including for kinds the core would never forward: this is the layer
 * that decides what a kind MEANS, and answering "nothing" for an unknown one is what keeps a
 * finance cron tick from refetching the board. (The core's own filter is coarser — it only
 * asks whether a kind is our business at all, so it never wakes the webview for those. Two
 * filters, two questions, both tested.)
 */
export function crmEventQueryKeys(kind: string): InvalidationKey[] {
  // `task:created` / `:updated` / `:archived`, plus the relation events (a blocking link
  // changes what the detail panel shows and whether a task can be started).
  if (kind.startsWith("task:")) {
    return [tosseBriefingKey, tosseBacklogKey, tosseTaskKeyPrefix];
  }
  // A project can move between the active and paused sections — and it takes its tasks with
  // it, which is why the briefing (not just a project list) is refetched.
  if (kind.startsWith("project:")) {
    return [tosseBriefingKey, tosseBacklogKey, tosseTaskKeyPrefix, tosseProjectReposKey];
  }
  // A mission is above the project in the cascade: the board groups by client through it,
  // so a renamed or archived mission changes what the cards say.
  if (kind.startsWith("mission:")) {
    return [tosseBriefingKey];
  }
  // The repository list is what every folder's association is matched against.
  if (kind.startsWith("repository:")) {
    return [tosseRepoLinksKey];
  }
  // Clients are the bands the board is grouped into (name, logo, order).
  if (kind.startsWith("client:")) {
    return [tosseBriefingKey, tosseRepoLinksKey];
  }
  return [];
}

/**
 * Merge the keys of a BURST of events into the set to invalidate once.
 *
 * A single CRM write emits several events (a status change fires `task:updated` plus its
 * relation events), and a server cron can emit dozens in a row. De-duplicating before
 * invalidating turns that into one refetch per query instead of one per event.
 */
export function mergeInvalidationKeys(kinds: Iterable<string>): InvalidationKey[] {
  const seen = new Map<string, InvalidationKey>();
  for (const kind of kinds) {
    for (const key of crmEventQueryKeys(kind)) {
      seen.set(JSON.stringify(key), key);
    }
  }
  return [...seen.values()];
}

/**
 * Whether a channel-state update means "we may have missed something — re-read everything",
 * and what to remember for next time.
 *
 * Keyed on the CONNECTION COUNTER rather than on a state transition, because the core keeps
 * a recycled stream on `live` (the server ends an idle one every ~12 s and announcing each
 * would strobe the indicator): `live → live` with a bumped counter is exactly the case a
 * transition test would miss.
 *
 * Pure, because getting it wrong is invisible in both directions — too eager and the board is
 * re-downloaded on a timer, too shy and it silently stops matching the CRM.
 */
export function connectionRefetch(
  status: { state: string; connections: number },
  lastHandled: number,
): { refetch: boolean; nextHandled: number } {
  // A stopped channel resets the core's counter, so ours must reset too: otherwise switching
  // the preference off and on lands on `connections: 1`, matches the 1 remembered from the
  // previous run, and skips the refetch that a restart most needs.
  if (status.state === "off") return { refetch: false, nextHandled: 0 };
  if (status.state !== "live") return { refetch: false, nextHandled: lastHandled };
  if (status.connections === lastHandled) return { refetch: false, nextHandled: lastHandled };
  return { refetch: true, nextHandled: status.connections };
}

/**
 * Everything TOSSE-derived, for the wholesale refetch owed on every (re)connection.
 *
 * ⚠️ Not an optimisation to skip: the server implements no `Last-Event-ID` replay, so
 * whatever it emitted while the socket was down is GONE. Reconnecting without this leaves
 * the view confidently showing a board that changed while we were away.
 */
export function allTosseQueryKeys(): InvalidationKey[] {
  return [
    tosseBriefingKey,
    tosseBacklogKey,
    tosseTaskKeyPrefix,
    tosseProjectReposKey,
    tosseRepoLinksKey,
  ];
}
