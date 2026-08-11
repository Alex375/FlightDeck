// Owns the TOSSE live channel from the UI side: when it runs, what a CRM change
// invalidates, and where a failure shows up. Renders nothing.
//
// There is no preference gating any of it — signed in, the channel runs. Live updates are
// how the tasks view works rather than a mode of it, so the only "off" is being signed out.
//
// Mounted once at the app root, next to the other always-on hosts, because the channel is
// app-global — one socket, whatever view is on screen. A per-view subscription would open
// and close the connection with the tab, which is exactly the churn the CRM's rate limiter
// exists to punish.
//
// The core (`src-tauri/src/tosse/sse.rs`) holds the socket and forwards a change as a bare
// KIND; the mapping from kind to query keys is a pure, tested function
// (`ipc/tosseLiveEvents.ts`). What is left here is the plumbing: when to start, how to
// coalesce a burst, and what to do when the channel's health changes.

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { commands, events } from "../../ipc/client";
import type { TosseLiveStatus } from "../../ipc/client";
import {
  allTosseQueryKeys,
  connectionRefetch,
  mergeInvalidationKeys,
} from "../../ipc/tosseLiveEvents";
import { useTosseConnection } from "../../ipc/useTosse";
import { useTosseLive } from "../../store/tosseLive";
import { useAppErrors } from "../../store/appErrors";

/**
 * How long a burst of CRM events is allowed to accumulate before one round of invalidation.
 *
 * A single write emits several events (a status change also fires its relation events) and a
 * server cron can emit dozens in a row. Short enough to stay imperceptible, long enough that
 * a cron sweep costs one refetch rather than one per row it touched.
 */
const BURST_MS = 400;

/**
 * Shortest interval between two whole-board refetches caused by a (re)connection.
 *
 * ⚠️ This exists because of a MEASURED server behaviour: an idle stream is ended by the
 * proxy roughly every 12 s (see `tosse/sse.rs`), so the core reopens one about that often.
 * Each connection owes a full refetch — there is no replay, so the gap could have hidden a
 * change — and honouring every one of them literally would be a refetch every 12 s: the
 * polling this feature exists to remove, wearing a different hat.
 *
 * So they are throttled, with the pending one kept (never dropped): the worst case is that a
 * change landing inside a ~200 ms reconnection gap is shown up to this long after the fact,
 * instead of the board being re-downloaded five times a minute. Fixing the keepalive on the
 * CRM side would make both the recycles and this throttle unnecessary.
 */
const RECONNECT_REFETCH_MS = 30_000;

export function TosseLiveHost() {
  const queryClient = useQueryClient();
  // Being signed in is the ONE condition. There is no preference: live updates are how the
  // tasks view works, not a mode of it — a board that silently disagrees with the CRM is
  // not a behaviour worth keeping a switch for.
  //
  // The connection query is already mounted app-wide; TanStack dedupes, so reading it here
  // costs nothing and keeps this host from needing its own notion of "signed in".
  const { data: connection } = useTosseConnection(true);
  const connected = connection?.connected === true;

  // Pending event kinds and the timer that will flush them. Refs, not state: a burst must
  // not re-render anything — it only decides which queries to refetch.
  const pending = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last connection we refetched for. Keyed on the COUNTER, not on a state transition:
  // the core keeps a recycled stream on `live` (no indicator flicker), so `live → live` with
  // a bumped counter is precisely the case a transition test would miss.
  const refetchedFor = useRef(0);
  // Throttle bookkeeping for those refetches: when the last one ran, and the timer that will
  // run the one we held back. Held back, never dropped — see RECONNECT_REFETCH_MS.
  const lastRefetchAt = useRef(0);
  const pendingRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listeners are attached ONCE, independently of whether the channel is currently open:
  // re-attaching them on every sign-in would race the events themselves (a state event
  // emitted by `start` can arrive before a listener registered right after it).
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const flush = () => {
      timer.current = null;
      const kinds = pending.current;
      pending.current = [];
      for (const key of mergeInvalidationKeys(kinds)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const onCrmEvent = (kind: string) => {
      pending.current.push(kind);
      if (timer.current == null) timer.current = setTimeout(flush, BURST_MS);
    };

    const refetchEverything = () => {
      pendingRefetch.current = null;
      lastRefetchAt.current = Date.now();
      for (const key of allTosseQueryKeys()) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const onState = (status: TosseLiveStatus) => {
      useTosseLive.getState().set(status);
      // ⚠️ Every connection owes a full refetch: the server implements no replay, so
      // whatever it emitted while the socket was down is gone. Without it, a reconnection
      // leaves the view showing — confidently, under a green indicator — a board that
      // changed in the meantime. The rule itself is pure and tested.
      const { refetch, nextHandled } = connectionRefetch(status, refetchedFor.current);
      refetchedFor.current = nextHandled;
      if (!refetch) return;
      if (pendingRefetch.current != null) return; // already owed; the timer will cover this one
      const since = Date.now() - lastRefetchAt.current;
      if (since >= RECONNECT_REFETCH_MS) refetchEverything();
      else pendingRefetch.current = setTimeout(refetchEverything, RECONNECT_REFETCH_MS - since);
    };

    events.tosseCrmEvent
      .listen((e) => {
        if (!disposed) onCrmEvent(e.payload.kind);
      })
      .then((un) => unlisteners.push(un))
      .catch((e) =>
        // Attaching is the one failure that would make the whole feature silently absent:
        // the socket runs, the indicator says "live", and nothing ever refreshes.
        useAppErrors
          .getState()
          .pushError("TOSSE live updates unavailable", String((e as Error)?.message ?? e)),
      );
    events.tosseLiveStateEvent
      .listen((e) => {
        if (!disposed) onState(e.payload.status);
      })
      .then((un) => unlisteners.push(un))
      .catch((e) =>
        useAppErrors
          .getState()
          .pushError("TOSSE live status unavailable", String((e as Error)?.message ?? e)),
      );

    return () => {
      disposed = true;
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = null;
      if (pendingRefetch.current != null) clearTimeout(pendingRefetch.current);
      pendingRefetch.current = null;
      unlisteners.forEach((un) => un());
    };
  }, [queryClient]);

  // The channel follows the session: open while signed in, closed otherwise. Closed means NO
  // socket — not a hidden one nobody reads — so a signed-out app talks to the CRM exactly as
  // little as it did before any of this existed.
  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const res = connected ? await commands.tosseLiveStart() : await commands.tosseLiveStop();
      if (disposed || res.status !== "error") return;
      // A channel that could not be opened must say so: the tasks view would otherwise fall
      // back to its focus/refresh behaviour while the indicator claimed nothing at all.
      useAppErrors
        .getState()
        .pushError(
          connected ? "TOSSE live updates could not start" : "TOSSE live updates could not stop",
          res.error,
        );
    };
    void run();
    return () => {
      disposed = true;
    };
  }, [connected]);

  return null;
}
