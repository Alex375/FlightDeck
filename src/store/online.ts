// Whether this Mac has a network at all (`navigator.onLine`), as a React value. It is only ever
// `false` with no network interface up (airplane mode, Wi-Fi off) — a flaky train Wi-Fi still
// reads `true` — so it is used for one thing: telling "this Mac is offline" apart from "the
// server is unreachable", which a probe or an ssh dial run FROM this Mac cannot.
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** `navigator.onLine` now — `true` where there is no `navigator` (tests, SSR). */
export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** {@link isOnline}, re-rendering when it flips. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}
