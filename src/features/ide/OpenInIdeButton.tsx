import { Ico } from "../../ui/kit";
import { useConversationRepo, type Conversation } from "../../store/conversationsStore";
import { useConvEditor } from "../editor/editorStore";
import { ideBlockedReason, openConversationInIde } from "./openInIde";

/**
 * Title-bar control of the conversation view: continue THIS conversation in the IDE view
 * — its folder becomes the workspace, the files open in the side editor come along as
 * tabs, and the conversation itself docks under them. Disabled WITH the reason when the
 * repository is remote (the IDE reads this Mac's disk), never a click into an empty tree.
 */
export function OpenInIdeButton({ conv }: { conv: Conversation }) {
  const repo = useConversationRepo(conv.id);
  const openFiles = useConvEditor(conv.id)?.tabs.length ?? 0;
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
      disabled={!!blocked}
      onClick={() => openConversationInIde(conv.id)}
      title={title}
      aria-label="Open in IDE"
    >
      <Ico name="ide" className="sm" />
    </button>
  );
}
