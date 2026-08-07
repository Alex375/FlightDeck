// The folder a project's work happens in, on its card — and the way to change it.
//
// The association is decided once, when a task is first started, and would otherwise be
// invisible for good: a pin made in a dialog three weeks ago, with no way to see it, is a
// setting the user cannot trust. So the card states it, and one click re-picks it.
//
// The picking itself is the SAME dialog the "Start / Discuss" flow opens (see
// {@link FolderPicker}) — it used to be a cramped dropdown of bare paths, which said
// nothing about which folder actually belonged to the project, nor that a clone of it was
// sitting on the disk unregistered.
//
// Local only — TOSSE holds no field for a machine path.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Ico, TosseCrmMark } from "../../ui/kit";
import { useLinkTosseProjectRepo, useTosseProjectRepos, useTosseRepoLinks } from "../../ipc/useTosse";
import { repoName, useRepos } from "../../store/conversationsStore";
import { FolderPicker } from "./FolderPicker";
import { resolveTaskFolder } from "./taskFolder";
import s from "./ProjectFolderChip.module.css";

export function ProjectFolderChip({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const repos = useRepos();
  const { data: pins } = useTosseProjectRepos();
  const { data: links } = useTosseRepoLinks();
  const [picking, setPicking] = useState(false);

  const resolution = resolveTaskFolder(pins ?? [], links, projectId, repos);
  const repo = repos.find((r) => r.id === resolution.repoId) ?? null;

  return (
    <>
      <button
        className={`${s.chip} ${repo ? "" : s.chipEmpty}`}
        title={
          repo
            ? `${repo.path} — ${
                resolution.source === "pin"
                  ? "the folder you picked for this project"
                  : "matched from this project's TOSSE repository"
              }. Click to change it.`
            : "No folder associated with this project yet — click to pick one"
        }
        onClick={(e) => {
          e.stopPropagation();
          setPicking(true);
        }}
      >
        <Ico name="folder" className="sm" />
        {repo ? repoName(repo.path) : "Associate a folder"}
      </button>
      {picking ? (
        <ProjectFolderDialog
          projectId={projectId}
          projectName={projectName}
          currentRepoId={resolution.repoId}
          pinned={resolution.source === "pin"}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}

/** The picker, in the same frame as the "Start / Discuss" dialog. */
function ProjectFolderDialog({
  projectId,
  projectName,
  currentRepoId,
  pinned,
  onClose,
}: {
  projectId: string;
  projectName: string;
  /** The folder in force right now — pinned or matched. */
  currentRepoId: string | null;
  /** Whether that folder is a PIN (clearable) rather than an automatic match. */
  pinned: boolean;
  onClose: () => void;
}) {
  const link = useLinkTosseProjectRepo();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const write = (repoId: string | null, then?: () => void) => {
    setError(null);
    link.mutate(
      { projectId, repoId },
      {
        onSuccess: () => then?.(),
        // A refused write must say so: the chip would otherwise keep showing the old
        // folder and the user would believe they had changed it.
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  // ⚠️ Portaled to `document.body`, like every other overlay here. The chip lives inside a
  // project card, and that card animates in with a `transform` — which makes it the
  // containing block for any `position: fixed` descendant. Rendered in place, the scrim
  // was therefore anchored to the CARD, not the window, and the dialog hung off the bottom
  // of the screen.
  return createPortal(
    <div className={s.scrim} onClick={onClose}>
      <div className={s.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={s.head}>
          <TosseCrmMark className={s.headMark} />
          <span className={s.title}>
            Working folder
            <span className={s.titleProject}> · {projectName}</span>
          </span>
          <button type="button" className={s.iconBtn} title="Close (Esc)" onClick={onClose}>
            <Ico name="x" className="sm" />
          </button>
        </div>

        <div className={s.body}>
          <div className={s.section}>
            {/* The folder in force is marked IN the list rather than shown above it: the
                same folder in two places read as two different offers. */}
            <FolderPicker
              projectId={projectId}
              busy={link.isPending}
              currentRepoId={currentRepoId}
              currentLabel={pinned ? "chosen" : "matched"}
              onChoose={(repoId) => write(repoId, onClose)}
            />
          </div>

          {error ? (
            <div className={s.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={s.problemTitle}>The folder was not saved</div>
                <div className={s.problemBody}>{error}</div>
              </div>
            </div>
          ) : null}
        </div>

        <div className={s.foot}>
          {/* Clearing is only offered when a PIN exists — clearing an automatic match would
              suggest a stored choice that is not there. */}
          {pinned ? (
            <button
              type="button"
              className={s.ghostBtn}
              disabled={link.isPending}
              onClick={() => write(null, onClose)}
            >
              Forget this folder
            </button>
          ) : null}
          <span className={s.footSpacer} />
          <button type="button" className={s.ghostBtn} disabled={link.isPending} onClick={onClose}>
            {link.isPending ? "Saving…" : "Close"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
