// Sidebar badge: a small branch glyph on a conversation row when that
// conversation works in a LINKED (non-main) worktree. Hover shows the worktree
// name; click opens the manager. Renders nothing for conversations on the main
// worktree — so the common case stays completely clean — and nothing for a folder on a
// paired server, whose worktrees this Mac's git cannot list (see useWorktrees).
import { Ico } from "../../ui/kit";
import { useWorktrees } from "../../ipc/useWorktrees";
import { useSessionState } from "../../store/conversationStore";
import { useConversationsStore, type Conversation } from "../../store/conversationsStore";
import { effectiveCwd, isLinked, resolveWorktree, worktreeLabel } from "./worktree";
import { useWorktreeUi } from "./worktreeUiStore";

export function WorktreeBadge({ conv }: { conv: Conversation }) {
  const repoPath = useConversationsStore(
    (s) => s.repos.find((r) => r.id === conv.repoId)?.path ?? null,
  );
  const machineId = useConversationsStore(
    (s) => s.repos.find((r) => r.id === conv.repoId)?.machineId ?? null,
  );
  // One shared query per folder (deduped across rows by the ["worktrees", machine, path] key);
  // disabled for a server folder.
  const { data: worktrees } = useWorktrees(repoPath, machineId);
  const state = useSessionState(conv.id);
  const openManager = useWorktreeUi((s) => s.openManager);

  if (!worktrees) return null;
  const wt = resolveWorktree(effectiveCwd(conv, state), worktrees);
  if (!wt || !isLinked(wt)) return null;

  return (
    <button
      type="button"
      className="cv-wt-badge"
      title={`Worktree "${worktreeLabel(wt)}"\nClick to manage worktrees`}
      aria-label={`Worktree ${worktreeLabel(wt)}`}
      onClick={(e) => {
        e.stopPropagation();
        openManager(conv.repoId);
      }}
    >
      <Ico name="branch" className="sm" />
    </button>
  );
}
