// The remote-machine mark — the ONE place the UI says a repository lives on a SERVER
// rather than on this Mac, and whether that server can still be reached.
//
// The data was there all along (`Repo.machineId` → a paired `Machine`) and drove real
// behaviour (which Claude account is used, how a title is pushed, whether the IDE may
// open the folder), but nothing ever RENDERED it: a remote repository looked exactly
// like a local one. Two folders can even carry look-alike paths once truncated
// (`/Users/…/app` vs `/home/…/app`), so you could message an agent believing it works
// on your Mac while it runs on a server.
//
// Deliberate shape, per Alexandre:
//  - A QUIET SERVER GLYPH, and nothing else, at rest. At a glance the only question worth
//    answering is "is this on this Mac?", and one small glyph answers it without
//    competing with the repo name beside it. A transmitting mast, not a globe: what
//    matters at a glance is that the thing is REACHING you from somewhere, and a globe
//    both says "the internet" and turns to mush at 13px.
//  - WHICH server is answered on HOVER, in the app's own tooltip (ui/Tooltip.tsx):
//    machine name plus its ssh target. Not the native `title` — that waits about a
//    second, which reads as nothing happening for information deliberately hidden at
//    rest.
//  - LOCAL IS UNMARKED. Local is the default and the overwhelming majority — badging it
//    too would put a permanent glyph on nearly every row and dilute the one signal that
//    carries information.
//  - NO SETTING. This is a missing piece of information, not a deliberate change of
//    experience: not seeing that an agent runs on a server — or that the server is down
//    — is a defect, so there is nothing to opt back out of (the project's reversibility
//    principle covers real features, not fixes).
//
// HEALTH (the reserved colour, now spent). A machine `store/machineHealth.ts` has
// actually checked and found OUT OF REACH turns this mark red AND swaps the mast for
// its crossed-out twin, and the tooltip stops being a label and starts being an
// explanation: how long it has been gone, the backend's own reason, and what to do.
// Three rules hold it honest:
//  - ONLY "UNREACHABLE" IS PAINTED. Reachable is the expected case and stays as quiet as
//    it was; a green glyph on every remote row would be noise, and the one state worth
//    interrupting for would have to shout over it.
//  - NEVER PAINTED ON A GUESS. No verdict yet renders exactly like a healthy machine.
//    Accusing a server of being down because we haven't asked it yet would be worse than
//    the silence this whole mark exists to end.
//  - IT LEADS SOMEWHERE. A red dot that only says "broken" tells you nothing you can
//    act on, so the unreachable mark is a real button onto the server panel that already
//    knows how to diagnose and repair it.
import { useCallback } from "react";
import { Ico } from "../../ui/kit";
import { Tooltip } from "../../ui/Tooltip";
import { useMachines, type Machine } from "../../store/conversationsStore";
import { useSettingsUi } from "../../store/settingsUi";
import { isUnreachable, useMachineHealth, type MachineHealth } from "../../store/machineHealth";

/** What the mark should say about one repository — derived once, so the glyph and its
 *  tooltip can never disagree. Pure; exported for the unit test. */
export type RemoteMark =
  /** No `machineId`: an ordinary folder on this Mac. Renders nothing. */
  | { kind: "local" }
  | { kind: "remote"; label: string; target: string }
  /** `machineId` is set but names no paired machine — the pairing was deleted, or the
   *  row outlived it. Still REMOTE: the path is not on this Mac. */
  | { kind: "unknown" };

export function remoteMarkFor(
  machineId: string | null | undefined,
  machines: Machine[],
): RemoteMark {
  if (!machineId) return { kind: "local" };
  const m = machines.find((x) => x.id === machineId);
  // ⚠️ Never fall back to "local" here. A repository whose machine we cannot name is
  // still a repository whose files and agents live on a server — degrading it to the
  // silent local case would resurrect the exact confusion this mark exists to end.
  if (!m) return { kind: "unknown" };
  return { kind: "remote", label: m.label, target: `${m.user}@${m.host}:${m.port}` };
}

/** "4 min ago" / "just now" for the last moment we know the machine answered. Pure;
 *  exported for the unit test. `null` when it has never answered in this app run —
 *  which the caller renders as its own sentence rather than as a fake duration. */
export function lastReachedPhrase(health: MachineHealth, nowMs: number): string | null {
  if (health.lastReachedAtMs === null) return null;
  const secs = Math.max(0, Math.round((nowMs - health.lastReachedAtMs) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The mark for a repository, or nothing at all for a local one.
 *
 *  Split in two so the common case costs nothing: a local repository returns before any
 *  hook runs, so the machines list is only subscribed to by the rows that are actually
 *  remote. */
export function RemoteRepoMark({ machineId }: { machineId: string | null | undefined }) {
  if (!machineId) return null;
  return <RemoteMachineGlyph machineId={machineId} />;
}

function RemoteMachineGlyph({ machineId }: { machineId: string }) {
  const machines = useMachines();
  const health = useMachineHealth(machineId);
  const openSettings = useSettingsUi((s) => s.openSettings);
  const mark = remoteMarkFor(machineId, machines);

  // The server panel is where diagnose-and-repair already lives — this is a shortcut to
  // it, not a second implementation of it.
  const openServerPanel = useCallback(
    (e: React.MouseEvent) => {
      // Every surface this mark sits on is itself clickable (a sidebar repo header that
      // folds, a Flight Deck card that opens the conversation). Without this, asking
      // "what is wrong with this server?" would also do that other thing.
      e.stopPropagation();
      e.preventDefault();
      openSettings("control", "remote");
    },
    [openSettings],
  );

  if (mark.kind === "local") return null;

  const down = isUnreachable(health);
  const unknown = mark.kind === "unknown";

  // One flat string for assistive tech, the richer version for the eye — same facts.
  // Unreachable wins over unpaired in the wording: both are faults, but one of them is
  // happening right now and has a next step.
  if (down && health) {
    const name = mark.kind === "remote" ? mark.label : "This server";
    const since = lastReachedPhrase(health, Date.now());
    // Always state WHEN, not just that. "Last reached 2 min ago" is a server that just
    // fell over; "not reached since the app started" is one that was already gone when
    // you sat down — two different problems, and the difference is the first thing you
    // would otherwise have to go and find out for yourself.
    const when = since ? `Last reached ${since}` : "Not reached since the app started";
    const label = [`${name} is unreachable`, health.reason, when, "Open the server panel to diagnose it."]
      .filter(Boolean)
      .join(" — ");
    return (
      <Tooltip
        content={
          <>
            {name} — unreachable
            {health.reason ? <span className="wf-tip-sub">{health.reason}</span> : null}
            <span className="wf-tip-sub">{when}</span>
            <span className="wf-tip-sub">Click to diagnose</span>
          </>
        }
        label={label}
        className="wf-remote down"
      >
        <button type="button" className="wf-remote-btn" onClick={openServerPanel} aria-label={label}>
          <Ico name="serverOff" className="sm" />
        </button>
      </Tooltip>
    );
  }

  const label = unknown
    ? "Remote repository — this server is no longer paired. Its path is on a server, not on this Mac."
    : `Remote repository on ${mark.label} (${mark.target})`;
  const content = unknown ? (
    <>
      Server no longer paired
      <span className="wf-tip-sub">Its path is on a server, not on this Mac</span>
    </>
  ) : (
    <>
      {mark.label}
      <span className="wf-tip-sub">{mark.target}</span>
      {health?.probeError ? (
        // Never swallowed: a machine stuck at "unknown" because the check itself could
        // not run says so, rather than looking like one nobody ever asked about.
        <span className="wf-tip-sub">Could not check it: {health.probeError}</span>
      ) : null}
    </>
  );

  return (
    <Tooltip content={content} label={label} className={"wf-remote" + (unknown ? " unknown" : "")}>
      <Ico name="server" className="sm" />
    </Tooltip>
  );
}
