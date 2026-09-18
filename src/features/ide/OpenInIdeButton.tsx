import { Ico } from "../../ui/kit";
import { useAppErrors } from "../../store/appErrors";
import { useConversationRepo, type Conversation } from "../../store/conversationsStore";
import { useEditorStore } from "../editor/editorStore";
import { ideBlockedReason, openConversationInIde } from "./openInIde";

/**
 * Title-bar control of the conversation view: continue THIS conversation in the IDE view
 * — its folder becomes the workspace, the files open in the side editor come along as
 * tabs, and the conversation itself docks under them. Refused WITH the reason when the
 * repository is remote (the IDE reads this Mac's disk), never a click into an empty tree.
 */
export function OpenInIdeButton({ conv }: { conv: Conversation }) {
  const repo = useConversationRepo(conv.id);
  // The COUNT only. Selecting the whole editor slice re-rendered this title-bar button on
  // every keystroke in the side editor (each one replaces the slice object).
  const openFiles = useEditorStore((s) => s.byConv[conv.id]?.tabs.length ?? 0);
  const blocked = ideBlockedReason(repo);
  const title =
    blocked ??
    (openFiles > 0
      ? `Open in IDE — with the ${openFiles === 1 ? "open file" : `${openFiles} open files`} (⌘⇧I)`
      : "Open in IDE (⌘⇧I)");
  return (
    <button
      type="button"
      className="wf-icon-btn"
      // ⚠️ NOT the `disabled` attribute: a disabled control takes no pointer events, so its
      // `title` never renders — and the reason is the one thing the user needs here.
      // `aria-disabled` keeps it hoverable and announced as unavailable; the click says why.
      aria-disabled={blocked ? true : undefined}
      onClick={() => {
        if (blocked) {
          useAppErrors.getState().pushError("Can't open this conversation in the IDE", blocked);
          return;
        }
        openConversationInIde(conv.id);
      }}
      title={title}
      aria-label="Open in IDE"
    >
      <Ico name="ide" className="sm" />
    </button>
  );
}
