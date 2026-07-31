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
export type BadgeState = "linked" | "unlinked" | "attention";

export function badgeStateFor(
  link: { repository: unknown; ambiguous: unknown[]; manualRepositoryId: string | null } | undefined,
): BadgeState {
  if (!link) return "unlinked";
  if (link.repository) return "linked";
  // Two situations that are NOT "simply not associated": several CRM repositories match
  // this remote, or a pinned one has vanished server-side. Both are the user's to resolve,
  // so the badge stays visible and says something is off instead of hiding.
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

  // The CRM list failed to load: nothing can be resolved right now. Offering "associate
  // this folder" here would invite an action that cannot succeed, and would read as "not
  // associated" for a folder that IS. Stay silent — except where the user pinned something
  // by hand, which the card can still explain.
  if (data.error && state !== "attention") return null;
  const name = link?.repository?.name;

  const title =
    state === "linked"
      ? `TOSSE — ${name}`
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
        (state === "attention" ? " attention" : "")
      }
      title={title}
      aria-label={title}
      onClick={() => openCard(repoId)}
    >
      <TosseCrmMark className="sm" />
      {state === "attention" ? <Ico name="alert" className="cv-tosse-badge-flag" /> : null}
    </button>
  );
}
