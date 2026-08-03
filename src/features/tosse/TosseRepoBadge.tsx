// The TOSSE mark on a repository's sidebar header: says at a glance whether this folder is
// known to the CRM, and opens its card.
//
// Two resting states, deliberately asymmetric:
//  - LINKED   → the mark is solid, in the CRM's brand colour, and ALWAYS visible. That the
//               folder maps to a client project is standing information, not a tool.
//  - UNLINKED → nothing at rest; hovering the header slides in a hollow mark (like the
//               worktree / extensions buttons) offering to associate it by hand. A user
//               whose folders mostly live outside TOSSE sees no permanent clutter.
//
// Nothing at all is rendered when TOSSE is not connected, when the association feature is
// switched off in Settings, or while the first fetch is still in flight — the app is fully
// usable without the CRM, and a badge that flickers in on load would say otherwise.
import { Ico, TosseCrmMark } from "../../ui/kit";
import { repoLinkFor, useTosseRepoLinks } from "../../ipc/useTosse";
import { useDisplay } from "../../store/display";
import { useTosseRepoUi } from "./tosseRepoUiStore";

/** What the badge should say about one folder — derived once, so the button and its
 *  tooltip can never disagree. Exported for the unit test. */
export type BadgeState = "linked" | "unlinked" | "attention" | "unknown";

interface BadgeLink {
  /** False when the CRM list could not be read: the fields below say nothing about reality. */
  resolved: boolean;
  repository: unknown;
  ambiguous: unknown[];
  manualRepositoryId: string | null;
  remoteError: string | null;
}

export function badgeStateFor(link: BadgeLink | undefined): BadgeState {
  // No entry yet (a folder added since the last fetch) — we have not looked, so we must
  // not claim anything, in either direction.
  if (!link) return "unknown";
  // ⚠️ Checked BEFORE anything else: with an unread CRM list, `repository: null` and a
  // surviving `manualRepositoryId` are NOT evidence of a broken association — they are the
  // absence of evidence. Reading them as "attention" is what pushed the user toward
  // clearing a perfectly valid pin during a passing outage.
  if (!link.resolved) return link.manualRepositoryId ? "unknown" : "unlinked";
  if (link.repository) return "linked";
  // A folder whose git remote could not even be read is broken, not un-associated — the
  // card explains which, and the user is not told to go hunting for a missing remote.
  if (link.remoteError) return "attention";
  // Two situations that are NOT "simply not associated": several CRM repositories match
  // this remote, or a pinned one really has vanished server-side (the list WAS read).
  if (link.ambiguous.length > 0 || link.manualRepositoryId) return "attention";
  return "unlinked";
}

export function TosseRepoBadge({ repoId }: { repoId: string }) {
  const enabled = useDisplay((s) => s.tosseRepoBadge);
  const { data } = useTosseRepoLinks(enabled);
  const openCard = useTosseRepoUi((s) => s.openCard);

  // No session, feature off, or nothing fetched yet → the sidebar looks exactly as it did
  // before this feature existed.
  if (!enabled || !data?.connected) return null;

  const link = repoLinkFor(data, repoId);
  const state = badgeStateFor(link);

  // Nothing to say about a folder we have not looked at — UNLESS the user pinned something
  // to it: that mark stays (muted) so the card, which explains why the check could not run,
  // is still one click away. Marking every folder during an outage would be noise; hiding
  // the pinned ones would make the explanation unreachable.
  if (state === "unknown" && !link?.manualRepositoryId) return null;

  const name = link?.repository?.name;

  const title =
    state === "linked"
      ? `TOSSE — ${name}`
      : state === "unknown"
        ? "TOSSE — this association cannot be checked right now"
        : state === "attention"
          ? "TOSSE — this association needs your attention"
          : "Associate this folder with a TOSSE repository";

  return (
    <button
      type="button"
      className={
        "cv-repo-act cv-tosse-badge" +
        (state === "unlinked" ? " cv-repo-reveal" : "") +
        (state === "linked" ? " linked" : "") +
        (state === "unknown" ? " unknown" : "") +
        (state === "attention" ? " attention" : "")
      }
      title={title}
      aria-label={title}
      onClick={() => openCard(repoId)}
    >
      <TosseCrmMark className="sm" />
      {/* The warning flag is reserved for a REAL problem. An unchecked association is not
          one — flagging it would dress a network blip up as a broken link. */}
      {state === "attention" ? <Ico name="alert" className="cv-tosse-badge-flag" /> : null}
    </button>
  );
}
