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
//  - A QUIET SERVER GLYPH, and nothing else, at rest. At a glance the only question worth
//    answering is "is this on this Mac?", and one small glyph answers it without
//    competing with the repo name beside it. A rack unit, not a globe: a VPS of your
//    own is a MACHINE, and a globe both says "the internet" and turns to mush at 13px.
//  - WHICH server is answered on HOVER, in the app's own tooltip (ui/Tooltip.tsx):
//    machine name plus its ssh target. Not the native `title` — that waits about a
//    second, which reads as nothing happening for information deliberately hidden at
//    rest.
//  - LOCAL IS UNMARKED. Local is the default and the overwhelming majority — badging it
//    too would put a permanent glyph on nearly every row and dilute the one signal that
//    carries information.
//  - NO SETTING. This is a missing piece of information, not a deliberate change of
//    experience: not seeing that an agent runs on a server is a defect, so there is
//    nothing to opt back out of (the project's reversibility principle covers real
//    features, not fixes).
//
// ⚠️ Colour is RESERVED. At rest this mark is the quietest text tone on purpose: the
// sibling task puts a HEALTH state on it (a machine gone unreachable or degraded), and
// health needs the attention/error colours to itself. Spending them here on the plain
// "this is remote" fact would leave "this server is down" nothing louder to say. The
// single exception below is a genuine fault, not a state.
import { Ico } from "../../ui/kit";
import { Tooltip } from "../../ui/Tooltip";
import { useMachines, type Machine } from "../../store/conversationsStore";

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
  const mark = remoteMarkFor(machineId, machines);
  if (mark.kind === "local") return null;

  const unknown = mark.kind === "unknown";
  // One flat string for assistive tech, the two-line version for the eye — same facts.
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
    </>
  );

  return (
    <Tooltip content={content} label={label} className={"wf-remote" + (unknown ? " unknown" : "")}>
      <Ico name="server" className="sm" />
    </Tooltip>
  );
}
