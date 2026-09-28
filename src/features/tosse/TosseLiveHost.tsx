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
import { allTosseQueryKeys, connectionRefetch, mergeInvalidationKeys } from "../../ipc/tosseLiveEvents";
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
  // Was the channel ever NOT live since the connection we last refetched for? That is what
  // separates the server's ~200 ms recycle from a real outage (a lid closed, a redeploy),
  // whose gap can be minutes long. Only the outage owes a refetch — see onState.
  const sawOutage = useRef(false);
  // Whether the last real (re)connection still owes its refetch — held while the window is
  // hidden, paid on the way back.
  const owed = useRef(false);

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
      if (!owed.current || document.hidden) return;
      owed.current = false;
      for (const key of allTosseQueryKeys()) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };

    const onState = (status: TosseLiveStatus) => {
      useTosseLive.getState().set(status);
      // Sign-out clears the slate: there is no gap to cover for a channel nobody asked for.
      if (status.state === "off") {
        sawOutage.current = false;
        owed.current = false;
      } else if (status.state !== "live") {
        sawOutage.current = true;
      }
      // ⚠️ A reconnection after a gap owes a refetch: the server implements no replay, so
      // whatever it emitted while the socket was down is gone. Without it, the view is left
      // showing — confidently, under a green indicator — a board that changed in the
      // meantime. Which connection is NEW is pure and tested (`connectionRefetch`).
      const { refetch, nextHandled } = connectionRefetch(status, refetchedFor.current);
      refetchedFor.current = nextHandled;
      if (!refetch) return;
      // …but only a REAL outage owes one: the channel dropped to connecting/error first, a
      // gap that can have hidden minutes of changes (a lid closed, a redeploy) → the full
      // sweep, once. A server-side RECYCLE of an idle stream (the core keeps the state on
      // `live`, only the counter moves) hides ~200 ms and owes nothing: refetching for it was
      // a sweep every 60 s for as long as the window stayed visible — a poll wearing the live
      // channel's clothes. And the recycles themselves are gone: they came from the CRM's
      // `Bun.serve` idle timeout, which its SSE route now opts out of (see `tosse/sse.rs`).
      const outage = sawOutage.current;
      sawOutage.current = false;
      if (!outage) return;
      owed.current = true;
      runOwed();
    };

    // Coming back to the window is when a held-back refetch is finally worth paying for.
    const onVisibility = () => {
      if (!document.hidden) runOwed();
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
