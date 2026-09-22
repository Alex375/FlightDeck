// The remote-machine mark — the ONE place the UI says a repository lives on a SERVER
// rather than on this Mac.
//
// The data was there all along (`Repo.machineId` → a paired `Machine`) and drove real
// behaviour (which Claude account is used, how a title is pushed, whether the IDE may
// open the folder), but nothing ever RENDERED it: a remote repository looked exactly
// like a local one. Two folders can even carry look-alike paths once truncated
// (`/Users/…/app` vs `/home/…/app`), so you could message an agent believing it works
// on your Mac while it runs on a server.
//
// Deliberate shape, per Alexandre:
//  - GLOBE + MACHINE NAME, not a bare icon. On a fleet with several servers, knowing
//    WHICH one matters as much as "this is remote"; host/user/port stay in the tooltip.
//  - LOCAL IS UNMARKED. Local is the default and the overwhelming majority — badging it
//    too would put a permanent chip on nearly every row and dilute the one signal that
//    carries information.
//  - NO SETTING. This is a missing piece of information, not a deliberate change of
//    experience: not seeing that an agent runs on a server is a defect, so there is
//    nothing to opt back out of (the project's reversibility principle covers real
//    features, not fixes).
//
// ⚠️ Colour is RESERVED. At rest this mark is neutral (panel + line + muted text) on
// purpose: the sibling task puts a HEALTH state on it (a machine gone unreachable or
// degraded), and health needs the attention/error colours to itself. Spending them here
// on the plain "this is remote" fact would leave "this server is down" nothing louder to
// say. The single exception below is a genuine fault, not a state.
import { Ico } from "../../ui/kit";
import { useMachines, type Machine } from "../../store/conversationsStore";

/** What the mark should say about one repository — derived once, so the chip and its
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

/** The mark for a repository, or nothing at all for a local one.
 *
 *  Split in two so the common case costs nothing: a local repository returns before any
 *  hook runs, so the machines list is only subscribed to by the rows that are actually
 *  remote. */
export function RemoteRepoMark({ machineId }: { machineId: string | null | undefined }) {
  if (!machineId) return null;
  return <RemoteMachineChip machineId={machineId} />;
}

function RemoteMachineChip({ machineId }: { machineId: string }) {
  const machines = useMachines();
  const mark = remoteMarkFor(machineId, machines);
  if (mark.kind === "local") return null;

  const unknown = mark.kind === "unknown";
  const label = unknown ? "unknown server" : mark.label;
  const title = unknown
    ? `Remote repository — this server is no longer paired\nIts path is on a server, not on this Mac. Pair it again in Settings → Control.`
    : `Remote repository — ${mark.label}\n${mark.target}\nIts path is on that server, and its agents run there.`;

  return (
    <span
      className={"wf-remote" + (unknown ? " unknown" : "")}
      title={title}
      aria-label={title}
    >
      <Ico name="globe" className="sm" />
      <span className="wf-remote-n">{label}</span>
    </span>
  );
}
