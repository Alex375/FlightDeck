import { useEffect, useState } from "react";

/**
 * Whether the page is visible — `false` while the window is minimized, on another Space or
 * otherwise hidden (`document.hidden`). A hidden page shows nothing, so anything that only exists
 * to keep the screen current (a frame loop, a countdown's tick) has no reason to run.
 *
 * Re-renders the caller on each change. Outside a browser (no `document`) it reads as visible.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    // Re-read once subscribed: a flip between the first render and this effect raised its event
    // before anyone listened, and would otherwise hold the wrong answer until the NEXT flip (a
    // clock left paused on a visible page). Same value → React bails out, no extra render.
    on();
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}
