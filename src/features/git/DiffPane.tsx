// The diff area (top/middle of the Git workspace). Shows the right diff for the shared
// selection: a commit-file diff (history tab) or a working-tree diff (changes tab). Both
// query hooks are always called (rules of hooks); the inactive one is disabled by passing
// null, so only one ever runs.
//
// The selection comes in as PROPS rather than being read from the store: while the pane
// slides shut the workspace holds it at its last value, so the diff being closed stays on
// screen for the length of the animation instead of blinking to "Select a file" on its way
// out (see useFrozenWhile). The workspace reads that selection anyway.
//
// For a renamed file the "before" side must come from the OLD path — we look the
// rename source up from the already-loaded file lists (deduped by React Query)
// and thread it through so a rename doesn't render as fully added.

import { useCommitFileDiff, useCommitFiles, useGitDiff, useGitStatus } from "../../ipc/useGit";
import type { GitTab } from "./gitViewStore";
import { DiffSlot } from "./DiffSlot";

export function DiffPane({
  cwd,
  tab,
  selectedOid,
  selectedHistoryFile,
  selectedChangePath,
}: {
  cwd: string;
  tab: GitTab;
  selectedOid: string | null;
  selectedHistoryFile: string | null;
  selectedChangePath: string | null;
}) {
  const isHistory = tab === "history";

  // Rename source for the selected file, from the lists the strip already loaded.
  const status = useGitStatus(cwd);
  const commitFiles = useCommitFiles(cwd, isHistory ? selectedOid : null);
  const origForHistory =
    isHistory && selectedHistoryFile
      ? (commitFiles.data?.find((f) => f.path === selectedHistoryFile)?.orig_path ?? null)
      : null;
  const origForChange =
    !isHistory && selectedChangePath
      ? (status.data?.files.find((f) => f.path === selectedChangePath)?.orig_path ?? null)
      : null;

  const commitDiff = useCommitFileDiff(
    cwd,
    isHistory ? selectedOid : null,
    isHistory ? selectedHistoryFile : null,
    origForHistory,
  );
  const worktreeDiff = useGitDiff(cwd, isHistory ? null : selectedChangePath, origForChange);

  const path = isHistory ? selectedHistoryFile : selectedChangePath;
  const q = isHistory ? commitDiff : worktreeDiff;

  return (
    <DiffSlot
      path={path}
      diff={q.data}
      loading={q.isLoading}
      error={q.error ? (q.error as Error).message : null}
      emptyHint={isHistory ? "Select a commit file" : "Select a changed file"}
    />
  );
}
