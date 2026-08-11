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
  recycleRefetchKeys,
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
 * Shortest interval between two refetches caused by the server RECYCLING an idle stream.
 *
 * ⚠️ This exists because of a MEASURED server behaviour: an idle stream is ended by the
 * proxy roughly every 12 s (see `tosse/sse.rs`), so the core reopens one about that often.
 * Each connection owes a refetch — there is no replay, so the gap could have hidden a
 * change — and honouring every one of them literally would be a refetch every 12 s: the
 * polling this feature exists to remove, wearing a different hat.
 *
 * Set to the briefing's own `staleTime`, so at its very worst this costs no more than the
 * query would have refetched by itself. Two further guards keep it from becoming a permanent
 * poll (which is exactly what it was): the sweep is narrowed to what a ~200 ms gap can
 * plausibly have hidden ({@link recycleRefetchKeys}, which excludes the expensive repo-link
 * matching), and it does not run at all while the window is hidden — it is held, then flushed
 * when the user comes back. Fixing the keepalive on the CRM side would make both the recycles
 * and this throttle unnecessary.
 */
const RECYCLE_REFETCH_MS = 60_000;

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
  // run the one we held back. Held back, never dropped — see RECYCLE_REFETCH_MS.
  const lastRefetchAt = useRef(0);
  const pendingRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Was the channel ever NOT live since the connection we last refetched for? That is what
  // separates the server's ~200 ms recycle from a real outage (a lid closed, a redeploy),
  // whose gap can be minutes long. The two owe very different refetches — see onState.
  const sawOutage = useRef(false);
  // What the last (re)connection still owes, if anything. "full" outranks "recycle": once an
  // outage is in the mix, the narrow sweep is no longer enough to cover the gap.
  const owed = useRef<null | "recycle" | "full">(null);

  // Listeners are attached ONCE, independently of whether the channel is currently open:
  // re-attaching them on every sign-in would race the events themselves (a state event
  // emitted by `start` can arrive before a listener registered right after it).
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    // ⚠️ `listen()` is async, so an unmount can land BEFORE it resolves — which StrictMode
    // makes happen on every dev mount. Pushing into the array from the `.then` would then
    // register a listener nobody ever removes: it stays on the Tauri bus for the life of the
    // app, delivering every event to a handler the `disposed` flag has already muted.
    const track = (un: () => void) => (disposed ? un() : unlisteners.push(un));

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

    /**
     * Run the refetch a (re)connection owes — unless the window is hidden, in which case it
     * stays owed and is flushed on the way back. A backgrounded app must do NO periodic work:
     * that was the polling this feature exists to remove.
     */
    const runOwed = () => {
      pendingRefetch.current = null;
      const what = owed.current;
      if (what == null || document.hidden) return;
      owed.current = null;
      lastRefetchAt.current = Date.now();
      for (const key of what === "full" ? allTosseQueryKeys() : recycleRefetchKeys()) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    /** Owe it now if the throttle allows, else park it on a timer. */
    const scheduleOwed = () => {
      if (pendingRefetch.current != null || document.hidden) return;
      const since = Date.now() - lastRefetchAt.current;
      if (since >= RECYCLE_REFETCH_MS) runOwed();
      else pendingRefetch.current = setTimeout(runOwed, RECYCLE_REFETCH_MS - since);
    };

    const onState = (status: TosseLiveStatus) => {
      useTosseLive.getState().set(status);
      // Sign-out clears the slate: there is no gap to cover for a channel nobody asked for.
      if (status.state === "off") {
        sawOutage.current = false;
        owed.current = null;
      } else if (status.state !== "live") {
        sawOutage.current = true;
      }
      // ⚠️ Every connection owes a refetch: the server implements no replay, so whatever it
      // emitted while the socket was down is gone. Without it, a reconnection leaves the view
      // showing — confidently, under a green indicator — a board that changed in the
      // meantime. The rule itself is pure and tested.
      const { refetch, nextHandled } = connectionRefetch(status, refetchedFor.current);
      refetchedFor.current = nextHandled;
      if (!refetch) return;
      // How MUCH is owed depends on what the gap was. A real outage (the channel dropped to
      // connecting/error first) can have hidden minutes of changes and is rare → the full
      // sweep, right now, no throttle. The server's idle recycle hides ~200 ms and happens
      // five times a minute → the narrow sweep, on the throttle. Treating both as "refetch
      // everything" is what turned this into a permanent 30-second poll of the whole board.
      const outage = sawOutage.current;
      sawOutage.current = false;
      owed.current = outage || owed.current === "full" ? "full" : "recycle"; // "full" wins
      if (!outage) {
        scheduleOwed();
        return;
      }
      if (pendingRefetch.current != null) clearTimeout(pendingRefetch.current);
      runOwed();
    };

    // Coming back to the window is when a held-back refetch is finally worth paying for.
    const onVisibility = () => {
      if (!document.hidden && owed.current != null) scheduleOwed();
    };
    document.addEventListener("visibilitychange", onVisibility);

    events.tosseCrmEvent
      .listen((e) => {
        if (!disposed) onCrmEvent(e.payload.kind);
      })
      .then(track)
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
      .then(track)
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
      document.removeEventListener("visibilitychange", onVisibility);
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
