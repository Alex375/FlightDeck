// Conversation-header (top-right) indicator of the worktree the active
// conversation works in RIGHT NOW — it follows the agent when it moves into a
// worktree (EnterWorktree) and back out (ExitWorktree), via the conversation's
// live cwd. Shows the worktree's branch name, accented when it is a LINKED
// (non-main) worktree. Click opens the worktree manager for the repo. Renders
// nothing when the repo is not a git repository so it never adds noise — nor for a
// folder on a paired server: this Mac's git can't see its worktrees, and the same path
// here may be an unrelated clone whose branch would read as the server agent's.
// (The machine mark beside it already says where the agent runs.)
import { Ico } from "../../ui/kit";
import { useWorktrees } from "../../ipc/useWorktrees";
import { useSessionState } from "../../store/conversationStore";
import type { Conversation } from "../../store/conversationsStore";
import { effectiveCwd, isLinked, mainWorktree, resolveWorktree, worktreeName } from "./worktree";
import { useWorktreeUi } from "./worktreeUiStore";

export function WorktreeIndicator({
  conv,
  repoPath,
  machineId,
}: {
  conv: Conversation;
  repoPath: string;
  /** The paired server the folder lives on (`null` = this Mac) — nothing is read for a server. */
  machineId: string | null;
}) {
  const { data: worktrees } = useWorktrees(repoPath, machineId);
  const state = useSessionState(conv.id);
  const openManager = useWorktreeUi((s) => s.openManager);

  // Not a git repo / not loaded yet / a server folder (never fetched) → show nothing.
  if (machineId || !worktrees || worktrees.length === 0) return null;

  // The worktree the conversation is in now (live cwd → session cwd → spawn cwd),
  // falling back to the main worktree if it can't be resolved (e.g. a relative ".").
  const cwd = effectiveCwd(conv, state);
  const wt = resolveWorktree(cwd, worktrees) ?? mainWorktree(worktrees);
  if (!wt) return null;

  const linked = isLinked(wt);
  // The worktree's NAME (its directory) when in a linked worktree, else just
  // "main" for the main checkout. Branch names live in the manager, not here.
  const label = linked ? worktreeName(wt) : "main";
  const extra = worktrees.filter((w) => !w.is_bare).length - 1;

  // Colour carries the "am I in a worktree?" answer: accent = a linked worktree,
  // neutral = the repo's main checkout.
  return (
    <button
      type="button"
      className="wf-chip"
      style={{ cursor: "pointer", color: linked ? "var(--wf-accent)" : "var(--wf-tx-lo)" }}
      onClick={() => openManager(conv.repoId)}
      title={
        linked
          ? `Worktree "${worktreeName(wt)}"\n${wt.path}\nClick to manage worktrees`
          : `Main working tree (not a linked worktree)${extra > 0 ? `\n${extra} linked worktree${extra > 1 ? "s" : ""} in this repository` : ""}\nClick to manage worktrees`
      }
      aria-label="Manage worktrees"
    >
      <Ico name="branch" className="sm" />
      <span className="wf-chip-t">{label}</span>
      {extra > 0 ? (
        <span className="wf-chip-t" style={{ opacity: 0.5 }}>
          +{extra}
        </span>
      ) : null}
    </button>
  );
}
