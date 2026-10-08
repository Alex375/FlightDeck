// Worktree manager: a modal, opened per repo, that lists the repository's
// worktrees — branch / path / status / the conversations attached to each — and
// lets the user remove one (strictly guarded) or start a conversation in one.
// Worktrees are CREATED elsewhere: by the agent (EnterWorktree) or via the
// composer's "worktree" toggle when starting a conversation — not from here, to
// keep this view a clean, read-mostly overview.
//
// Deletion guard (strict): the main worktree can never be removed; a worktree
// with a LIVE session running in it is blocked; a worktree with uncommitted or
// untracked work requires an explicit "force" confirmation (a separate, clearly
// destructive button). Everything else deletes cleanly. The actual git-level
// safety is delegated to `git worktree remove` (see the Rust git module).
import { useState } from "react";
import { Ico } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { useRemoveWorktree, useWorktreeStatus, useWorktrees } from "../../ipc/useWorktrees";
import type { WorktreeInfo } from "../../ipc/client";
import {
  createConversationInWorktree,
  repoName,
  SERVER_WORKTREE_UNSUPPORTED,
  stopConversationSession,
  useConversations,
  useConversationsStore,
  type Conversation,
} from "../../store/conversationsStore";
import { effectiveCwd, resolveWorktree, worktreeLabel, worktreeName } from "./worktree";
import { useWorktreeUi } from "./worktreeUiStore";
import styles from "./WorktreeManager.module.css";

export function WorktreeManager() {
  const repoId = useWorktreeUi((s) => s.managerRepoId);
  const close = useWorktreeUi((s) => s.closeManager);
  const repoPath = useConversationsStore(
    (s) => s.repos.find((r) => r.id === repoId)?.path ?? null,
  );
  // A folder on a paired server: `git worktree` runs on THIS Mac, so it would list (and
  // open conversations in) whatever sits at that path here — never the server's worktrees.
  const onServer = useConversationsStore(
    (s) => !!s.repos.find((r) => r.id === repoId)?.machineId,
  );
  const conversations = useConversations();
  const { data: worktrees, isLoading, isError, error, refetch, isFetching } =
    useWorktrees(onServer ? null : repoPath);
  // A manual refresh that fails while a previous list is still shown would
  // otherwise be swallowed (the query keeps status:"success" with stale data),
  // so we surface the refetch error explicitly.
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Hooks are all above this guard so their order never changes between renders.
  if (!repoId || !repoPath) return null;

  // Start a conversation rooted in a worktree (same repo group, worktree cwd),
  // then close the manager so the user lands on it.
  function openConversationIn(cwd: string) {
    createConversationInWorktree(repoId!, cwd);
    close();
  }

  // Conversations of THIS repo, grouped by the worktree they're in (live cwd if
  // the agent moved into one, else the spawn cwd).
  const convsForRepo = conversations.filter((c) => c.repoId === repoId);
  const convsByPath = new Map<string, Conversation[]>();
  if (worktrees) {
    for (const c of convsForRepo) {
      const wt = resolveWorktree(effectiveCwd(c, undefined), worktrees);
      if (!wt) continue;
      const arr = convsByPath.get(wt.path) ?? [];
      arr.push(c);
      convsByPath.set(wt.path, arr);
    }
  }

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="branch" className="sm" />
          <span className={styles.title}>
            Worktrees <span className={styles.titleRepo}>· {repoName(repoPath)}</span>
          </span>
          {/* No refresh on a server folder: `refetch` ignores the disabled query and would
              run this Mac's git anyway. */}
          {onServer ? null : (
            <button
              className={styles.iconBtn}
              onClick={async () => {
                setRefreshError(null);
                const r = await refetch();
                if (r.isError) {
                  setRefreshError((r.error as Error)?.message ?? "Refresh failed.");
                }
              }}
              disabled={isFetching}
              title="Refresh"
              aria-label="Refresh"
            >
              <Ico name="refresh" className={"sm" + (isFetching ? " " + styles.spin : "")} />
            </button>
          )}
          <button className={styles.iconBtn} onClick={close} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {refreshError ? <div className={styles.error}>{refreshError}</div> : null}

          {/* Worktree list */}
          {onServer ? (
            <div className={styles.empty}>{SERVER_WORKTREE_UNSUPPORTED}</div>
          ) : isLoading ? (
            <div className={styles.empty}>Loading…</div>
          ) : isError ? (
            /not a git repository/i.test((error as Error).message) ? (
              // A plain folder, not a git repo → no worktrees. Calm, not an error.
              <div className={styles.empty}>
                This folder isn't a git repository — there are no worktrees to manage.
              </div>
            ) : (
              <div className={styles.error}>{(error as Error).message}</div>
            )
          ) : worktrees && worktrees.length > 0 ? (
            <div className={styles.list}>
              {worktrees
                .filter((w) => !w.is_bare)
                .map((w) => (
                  <WorktreeRow
                    key={w.path}
                    repoPath={repoPath}
                    worktree={w}
                    convs={convsByPath.get(w.path) ?? []}
                    onOpenConversation={() => openConversationIn(w.path)}
                  />
                ))}
            </div>
          ) : (
            <div className={styles.empty}>No worktrees.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorktreeRow({
  repoPath,
  worktree,
  convs,
  onOpenConversation,
}: {
  repoPath: string;
  worktree: WorktreeInfo;
  convs: Conversation[];
  onOpenConversation: () => void;
}) {
  const { data: status, isError: statusError, error: statusErr } = useWorktreeStatus(worktree.path);
  const remove = useRemoveWorktree(repoPath);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const liveHere = convs.some((c) => c.handle != null);
  const dirty = !!status && (status.dirty || status.untracked);
  // Only the main worktree is ever undeletable. A live session no longer blocks
  // deletion — it's allowed, behind a loud warning in the confirm dialog.
  const canDelete = !worktree.is_main;
  const disabledReason = worktree.is_main
    ? "The main worktree cannot be removed."
    : undefined;

  async function confirmDelete() {
    setDeleting(true);
    // Stop any live sessions rooted here FIRST: their cwd is about to vanish.
    // Ending them cleanly (the user was warned) means a later message re-spawns
    // them in the main checkout (the cwd-missing recovery) instead of talking to
    // a process whose directory is gone. Best-effort — proceed even if a stop fails.
    try {
      await Promise.all(
        convs.filter((c) => c.handle != null).map((c) => stopConversationSession(c.id)),
      );
    } catch {
      /* ignore — the forced removal below still goes through */
    }
    // Force when there's a live session or uncommitted work (git would refuse a
    // dirty worktree otherwise). Always via this explicit, separate confirmation.
    remove.mutate(
      { worktreePath: worktree.path, force: dirty || liveHere },
      // Close on success AND error so the row's red error message is visible
      // (it would otherwise stay hidden behind the still-open dialog).
      {
        onSuccess: () => {
          setDeleting(false);
          setConfirming(false);
        },
        onError: () => {
          setDeleting(false);
          setConfirming(false);
        },
      },
    );
  }

  return (
    <div className={styles.row}>
      {/* Header: the worktree's name + the branch it has checked out, then status. */}
      <div className={styles.rowTop}>
        <span className={styles.wtName}>
          <Ico name="folder" className="sm" />
          {worktreeName(worktree)}
        </span>
        <span className={styles.branchTag} title={`Checked-out branch: ${worktreeLabel(worktree)}`}>
          <Ico name="branch" className="sm" />
          {worktreeLabel(worktree)}
        </span>
        {worktree.is_main ? <span className={`${styles.tag} ${styles.tagMain}`}>main</span> : null}
        {worktree.is_locked ? <span className={styles.tag}>locked</span> : null}
        {worktree.is_detached ? <span className={styles.tag}>detached</span> : null}
        <span className={styles.spacer} />
        {/* git status — error is surfaced (never shown as a neutral "—"). */}
        {statusError ? (
          <span className={styles.statusErr} title={(statusErr as Error)?.message}>
            status unavailable
          </span>
        ) : status ? (
          dirty ? (
            <span className={styles.dirty}>
              {status.changed_files} changed{status.untracked ? " · untracked" : ""}
            </span>
          ) : (
            <span className={styles.clean}>clean</span>
          )
        ) : (
          <span className={styles.muted}>…</span>
        )}
        {status && (status.ahead != null || status.behind != null) ? (
          <span className={styles.muted}>↑{status.ahead ?? 0} ↓{status.behind ?? 0}</span>
        ) : null}
      </div>

      {/* Who is here: attached conversations + a live-session marker. */}
      <div className={styles.meta}>
        <span>
          {convs.length === 0
            ? "no conversations"
            : `${convs.length} conversation${convs.length > 1 ? "s" : ""}`}
        </span>
        {liveHere ? (
          <span className={styles.live}>
            <span className={styles.dot} />
            active session
          </span>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button
          className={styles.btn}
          onClick={onOpenConversation}
          title="Start a conversation in this worktree"
        >
          + conversation
        </button>
        <span className={styles.spacer} />
        <button
          className={`${styles.btn} ${styles.danger}`}
          disabled={!canDelete || remove.isPending}
          title={disabledReason}
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      </div>

      {remove.isError ? (
        <div className={styles.error}>{(remove.error as Error).message}</div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        danger
        busy={deleting || remove.isPending}
        title={`Delete worktree "${worktreeLabel(worktree)}"?`}
        confirmLabel={liveHere ? "Delete anyway" : dirty ? "Force delete" : "Delete"}
        onCancel={() => setConfirming(false)}
        onConfirm={confirmDelete}
      >
        {liveHere ? (
          <div className={styles.dangerBox}>
            ⚠️ DANGER — {convs.filter((c) => c.handle != null).length}{" "}
            <strong>active</strong> Claude session
            {convs.filter((c) => c.handle != null).length > 1 ? "s" : ""}{" "}
            {convs.filter((c) => c.handle != null).length > 1 ? "are" : "is"} running in this
            worktree (possibly mid-write). Removing{" "}
            {convs.filter((c) => c.handle != null).length > 1 ? "them" : "it"} now will{" "}
            <strong>
              stop {convs.filter((c) => c.handle != null).length > 1 ? "these sessions" : "this session"}
            </strong>{" "}
            and may <strong>lose in-progress work</strong>.
          </div>
        ) : null}
        The folder <span className="wf-mono">{worktree.path}</span> will be deleted. The branch{" "}
        <span className="wf-mono">{worktreeLabel(worktree)}</span> is kept (only the worktree is
        removed).
        {convs.length > 0
          ? ` ⚠️ ${convs.length} conversation${convs.length > 1 ? "s" : ""} ${convs.length > 1 ? "are attached to it and will lose their" : "is attached to it and will lose its"} working directory (you can restart ${convs.length > 1 ? "them" : "it"}, but in the main tree).`
          : ""}
        {dirty
          ? " ⚠️ This worktree has uncommitted changes that will be permanently lost."
          : ""}
      </ConfirmDialog>
    </div>
  );
}
