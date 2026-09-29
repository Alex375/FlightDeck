// The Git status section of the conversation side panel: the branch the conversation works on,
// where it stands against its remote-tracking branch, and what is uncommitted — at a glance,
// without opening the Git workspace.
//
// Every figure comes from ONE `git status` (branch, upstream, ahead/behind and every count), read
// through the shared `useGitStatus` query keyed on the SAME cwd string as the Git workspace, its
// changes list and diff pane — one cache entry, one `git` process for all of them. The rules of
// what the figures mean live in `features/git/gitStatusSummary.ts` (pure, tested).
//
// Cost, by construction:
//  - a REMOTE repository mounts no query at all: its path is the server's, and `git` runs on this
//    Mac (see `localGitCwd`);
//  - folded, only the header's reading stays — one query observer, refreshed by the events that
//    already exist (mount, window focus, a turn end — `useGlobalSessionEvents`). The fs-driven
//    refresh (`useGitAutoRefresh`) lives in the BODY, so it goes with it;
//  - nothing polls, nothing fetches from the network (ahead/behind are as of the last fetch, and
//    the pill says so).
//
// ⚠️ Never a fake 0: while loading, on an error, or for a count git cannot give, a figure reads
// an em dash. A 0 is shown only when git said 0.

import { useMemo, useState } from "react";
import { Ico } from "../../../ui/kit";
import { Tooltip } from "../../../ui/Tooltip";
import { motionAllowed } from "../../../ui/motion";
import { useGitAutoRefresh, useGitStatus } from "../../../ipc/useGit";
import { useDisplay } from "../../../store/display";
import { useConversationStore } from "../../../store/conversationStore";
import {
  useConversationRepo,
  useConversationsStore,
  type Conversation,
} from "../../../store/conversationsStore";
import { useEditorStore } from "../../editor/editorStore";
import { useGitViewStore } from "../../git/gitViewStore";
import {
  branchSyncPill,
  classifyGitError,
  gitErrorDetail,
  gitMetaText,
  rollDirection,
  summarizeGitStatus,
  type GitErrorKind,
  type GitStatusSummary,
} from "../../git/gitStatusSummary";
import { localGitCwd } from "../../git/gitTurnRefresh";
import { PanelSection } from "../PanelSection";
import s from "../ConversationSidePanel.module.css";
import g from "./GitStatusWidget.module.css";

const ICON = <Ico name="diff" className="sm" />;
const TITLE = "Git status";

/**
 * The git status of `conv`'s working folder. Renders nothing when there is no answer to give:
 * no repo in the store, a relative cwd, or a folder that is not a git repository (an ordinary
 * folder is not a failure).
 */
export function GitStatusWidget({ conv }: { conv: Conversation }) {
  const repo = useConversationRepo(conv.id);
  // The folder, selected as a STRING: of the session's state only its cwd matters here, and a
  // running turn re-emits that state all the time (context meter, rate limits…). Subscribing to
  // the whole object would re-render the section — header included, folded or not — on each.
  const cwd = useConversationStore((st) => localGitCwd(conv, st.sessions[conv.id]?.state, repo));
  if (!repo) return null;
  if (repo.machineId) return <RemoteGitWidget machineId={repo.machineId} />;
  if (!cwd) return null;
  return <LocalGitWidget convId={conv.id} cwd={cwd} />;
}

/** A repository on a paired server: said plainly, with nothing read. */
function RemoteGitWidget({ machineId }: { machineId: string }) {
  // `||`, not `??`: a blank label would read "Lives on  — …".
  const label = useConversationsStore(
    (st) => st.machines.find((m) => m.id === machineId)?.label?.trim() || null,
  );
  return (
    <PanelSection id="git" icon={ICON} title={TITLE} meta={<Meta text="—" />}>
      <p className={g.note}>
        Lives on {label ?? "a remote server"} — git status reads this Mac only.
      </p>
    </PanelSection>
  );
}

function LocalGitWidget({ convId, cwd }: { convId: string; cwd: string }) {
  const { data, error, isError } = useGitStatus(cwd);
  const summary = useMemo(() => (data ? summarizeGitStatus(data) : null), [data]);
  // A failed REFETCH keeps the last good data alongside the error; the error wins, or a folder
  // deleted since the last read would keep showing its old counts.
  const errKind: GitErrorKind | null = isError && error ? classifyGitError(error.message) : null;
  if (errKind === "not-a-repo") return null;
  const known = errKind ? null : summary;

  const openChanges = () => {
    // Tab first, then the view: the workspace mounts straight onto Changes, no History flash.
    useGitViewStore.getState().setTab(convId, "changes");
    useEditorStore.getState().setGitOpen(true);
  };

  return (
    <PanelSection
      id="git"
      icon={ICON}
      title={TITLE}
      meta={<Meta text={gitMetaText(known)} />}
      action={
        errKind ? undefined : (
          <button
            type="button"
            className={s.textBtn}
            onClick={openChanges}
            title="Open this conversation's changes in the Git view"
          >
            Changes
          </button>
        )
      }
    >
      {errKind ? (
        <GitErrorLine kind={errKind} cwd={cwd} message={error?.message ?? ""} />
      ) : (
        // Keyed by the folder: a cwd move (entering or leaving a worktree) is a DIFFERENT tree,
        // not a change of this one — its counts must not roll in as if the turn had moved them
        // (the other folder's answer may already be cached, so no unknown step would reset them).
        <GitBody key={cwd} cwd={cwd} summary={known} />
      )}
    </PanelSection>
  );
}

/** The header's reading, in the panel's capsule. */
function Meta({ text }: { text: string }) {
  return <span className={`${s.meta} wf-mono`}>{text}</span>;
}

/**
 * The unfolded body: the branch line and the four counters. It also carries the fs-driven
 * refresh, so a folded section stops listening (see the header comment).
 */
function GitBody({ cwd, summary }: { cwd: string; summary: GitStatusSummary | null }) {
  useGitAutoRefresh(cwd);
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));
  const pill = summary ? branchSyncPill(summary) : null;
  const tag = summary?.unborn ? "no commits" : summary?.detached ? "detached" : null;
  return (
    <div className={g.git} data-motion={motion || undefined}>
      <div className={g.branchLine}>
        <span className={`${g.branch} wf-mono`} title={summary?.branchLabel}>
          {summary?.branchLabel ?? "—"}
        </span>
        {tag ? <span className={g.tag}>{tag}</span> : null}
        {pill ? (
          <Tooltip
            className={g.pill}
            content={pill.tooltip}
            label={`${pill.text}. ${pill.tooltip}`}
          >
            <span className={`${g.pillText} wf-mono`} data-warn={pill.warn || undefined}>
              {pill.text}
            </span>
          </Tooltip>
        ) : null}
      </div>
      <div className={g.counters}>
        <Counter label="Staged" value={summary?.staged ?? null} />
        <Counter label="Modified" value={summary?.modified ?? null} />
        <Counter label="Untracked" value={summary?.untracked ?? null} />
        <Counter label="Conflicts" value={summary?.conflicts ?? null} alarm />
      </div>
    </div>
  );
}

/**
 * One counter: the value over its label. `null` is unknown (an em dash); a 0 is a real 0, drawn
 * dim. When a KNOWN value changes, the new figure rolls in from the side it moved towards — the
 * one animation here, because it explains something (the turn just changed the tree); the first
 * reading does not roll.
 */
function Counter({ label, value, alarm }: { label: string; value: number | null; alarm?: boolean }) {
  // The previous value and the direction of the last change, adjusted DURING render (no effect,
  // no frame showing the old direction). `roll` keys the figure so each change replays it.
  const [prev, setPrev] = useState(value);
  const [roll, setRoll] = useState<{ n: number; dir: "up" | "down" } | null>(null);
  if (prev !== value) {
    setPrev(value);
    const dir = rollDirection(prev, value);
    if (dir) setRoll({ n: (roll?.n ?? 0) + 1, dir });
  }
  const tone = value === null ? "unknown" : value === 0 ? "zero" : alarm ? "alarm" : "some";
  return (
    <div className={g.counter}>
      <span className={`${g.value} wf-mono`} data-tone={tone}>
        <span key={roll?.n ?? 0} className={g.figure} data-roll={roll?.dir}>
          {value ?? "—"}
        </span>
      </span>
      <span className={g.label}>{label}</span>
    </div>
  );
}

/** A status read that failed for a reason worth a sentence. Quiet for the ordinary cases (a
 *  folder that is gone, one macOS keeps us out of), red only for a real failure. */
function GitErrorLine({ kind, cwd, message }: { kind: GitErrorKind; cwd: string; message: string }) {
  switch (kind) {
    case "folder-gone":
      return (
        <p className={g.note} title={cwd}>
          This folder no longer exists.
        </p>
      );
    case "no-access":
      return (
        <p className={g.note} title={message}>
          macOS keeps Flight Deck out of this folder (Privacy &amp; Security → Files and Folders).
        </p>
      );
    case "git-missing":
      return <p className={g.note}>git is not installed on this Mac.</p>;
    default:
      return (
        <p className={`${g.note} ${g.noteErr}`} title={message}>
          Couldn't read the git status: {gitErrorDetail(message)}
        </p>
      );
  }
}
