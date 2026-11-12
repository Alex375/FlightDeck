// The thread's live line for a remote conversation whose ssh link is down — what the Mac is doing
// about it right now, in the shared link voice (`agent/remoteLink.ts`). Shown under the timeline
// whether or not a turn is running: a link that drops while the agent is idle is just as true,
// and the only place it was said before was a side panel row that is off by default.
import type { ReactNode } from "react";
import { Ico } from "../../ui/kit";
import { RollText } from "../../ui/RollText";
import type { RemoteLinkView } from "../../agent/remoteLink";
import { retryRemoteLinksNow } from "../../agent/useRemoteLinkView";
import styles from "./ConductorThread.module.css";

/** One line: a spinner ONLY while an attempt is in flight — a wait shows a still clock and how
 *  long it lasts, with "Retry now" to cut it short. `trailing` (a turn's elapsed time) follows. */
export function RemoteLinkLine({ view, trailing }: { view: RemoteLinkView; trailing?: ReactNode }) {
  const icon = view.phase === "offline" ? "globe" : view.active ? "refresh" : "clock";
  return (
    <div className={styles.activity} data-link-phase={view.phase}>
      <Ico name={icon} className={"sm " + (view.active ? styles.retrySpin : styles.linkWait)} />
      {/* The situation rolls when it changes; the countdown after it just updates — a line that
          rolled every second would read as a glitch, not a clock. */}
      <RollText text={view.lead} />
      {view.wait ? <span className={styles.linkWaitText}>— {view.wait}</span> : null}
      {view.canRetryNow ? (
        <button
          type="button"
          className={styles.linkRetry}
          onClick={retryRemoteLinksNow}
          title="Retries every remote conversation whose connection dropped, not only this one"
        >
          Retry now
        </button>
      ) : null}
      {trailing}
    </div>
  );
}
