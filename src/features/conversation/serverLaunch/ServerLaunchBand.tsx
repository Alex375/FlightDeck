// Above the composer of a new conversation on this Mac: the offer to run it on a paired server
// instead, then — once a server is picked — the preparation screen, every step of the move
// visible (running, done with what it found, failed with why and a retry), and finally a
// short report of what was copied and what was left behind. Renders nothing otherwise.

import { useEffect, useState } from "react";
import { commands } from "../../../ipc/client";
import { useConversationsStore, useConversationRepo, useMachines } from "../../../store/conversationsStore";
import { useTimeline } from "../../../store/conversationStore";
import { useDisplay } from "../../../store/display";
import { isUnreachable, useMachineHealth } from "../../../store/machineHealth";
import { useSettingsUi } from "../../../store/settingsUi";
import { Ico } from "../../../ui/kit";
import { MACHINE } from "../../../ui/platform";
import type { Machine } from "../../../store/conversationsStore";
import {
  COPY_WHY_LABEL,
  LAUNCH_STEPS,
  alignNotes,
  failedStep,
  formatBytes,
  inviteVisible,
  progressFraction,
  skippedByReason,
  type LaunchStepId,
} from "./serverLaunchModel";
import {
  cancelServerLaunch,
  dismissInvite,
  dismissServerLaunch,
  retryServerLaunch,
  startServerLaunch,
  useServerLaunch,
  useServerLaunchStore,
  type ServerLaunch,
} from "./serverLaunchStore";
import s from "./ServerLaunch.module.css";

// This Mac's name, read once per app run.
let macName: Promise<string> | null = null;
function useThisMachineName(): string {
  const [name, setName] = useState<string>(`this ${MACHINE}`);
  useEffect(() => {
    let alive = true;
    macName ??= commands.thisMachineName().catch(() => `this ${MACHINE}`);
    void macName.then((n) => alive && setName(n.trim() || `this ${MACHINE}`));
    return () => {
      alive = false;
    };
  }, []);
  return name;
}

export function ServerLaunchBand({ session }: { session: string }) {
  const launch = useServerLaunch(session);
  const conv = useConversationsStore((st) => st.conversations.find((c) => c.id === session));
  const repo = useConversationRepo(session);
  const machines = useMachines();
  const pref = useDisplay((d) => d.serverLaunchInvite);
  const dismissed = useServerLaunchStore((st) => !!st.dismissed[session]);
  // No message yet (a notice — a spawn error, say — does not count).
  const threadEmpty = !useTimeline(session).some((e) => e.kind === "turn");

  if (launch) {
    // The summary of a finished move steps aside at the conversation's first message.
    if (launch.done && !threadEmpty) return <FinishedCleanup session={session} />;
    return <LaunchPanel launch={launch} />;
  }
  if (
    !conv ||
    !inviteVisible({
      pref,
      kind: conv.kind,
      local: !!repo && !repo.machineId,
      empty: !conv.sessionId && !conv.handle && threadEmpty,
      launching: false,
      dismissed,
      servers: machines.length,
    })
  ) {
    return null;
  }
  return <Invite session={session} machines={machines} />;
}

/** Drops a finished launch's state once its summary is no longer shown. */
function FinishedCleanup({ session }: { session: string }) {
  useEffect(() => dismissServerLaunch(session), [session]);
  return null;
}

function Invite({ session, machines }: { session: string; machines: Machine[] }) {
  const mac = useThisMachineName();
  const openSettings = useSettingsUi((st) => st.openSettings);
  return (
    <div className={s.card} role="group" aria-label="Where this conversation runs">
      <div className={s.head}>
        <Ico name="laptop" className={s.headIco} />
        <span className={s.title}>
          This conversation will run on <b>{mac}</b>. Run it on a server instead?
        </span>
        <span className={s.fill} />
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => dismissInvite(session)}
          title="Not for this conversation (Settings → Conversation → Composer turns the offer off everywhere)"
          aria-label="Dismiss"
        >
          <Ico name="x" className="sm" />
        </button>
      </div>
      <div className={s.choices}>
        {machines.map((m) => (
          <ServerChoice key={m.id} session={session} machine={m} />
        ))}
        <button
          type="button"
          className={s.choice}
          data-quiet="1"
          onClick={() => openSettings("control", "remote")}
          title="Settings → Control → Remote: pair a server with the usual assistant"
        >
          <Ico name="plus" className="sm" />
          Connect a new server…
        </button>
      </div>
      <div className={s.note}>
        Its repository is sent there as it is now — commits not pushed, uncommitted changes, untracked
        files, <code>.claude</code> and secrets like <code>.env</code> — into a worktree of its own.
      </div>
    </div>
  );
}

function ServerChoice({ session, machine }: { session: string; machine: Machine }) {
  const health = useMachineHealth(machine.id);
  const down = isUnreachable(health);
  const name = machine.label.trim() || machine.host;
  return (
    <button
      type="button"
      className={s.choice}
      data-down={down || undefined}
      onClick={() => void startServerLaunch(session, machine.id)}
      title={`${machine.user}@${machine.host}${down ? " — last check: unreachable" : ""}`}
    >
      <Ico name={down ? "serverOff" : "server"} className="sm" />
      {name}
      {down ? <span className={s.tag}>unreachable</span> : null}
    </button>
  );
}

function StepMark({ status }: { status: string }) {
  if (status === "done") return <Ico name="check" className={`${s.mark} ${s.markDone}`} />;
  if (status === "failed") return <Ico name="alert" className={`${s.mark} ${s.markFailed}`} />;
  if (status === "running") return <span className={`${s.mark} ${s.spinner}`} aria-hidden="true" />;
  return <span className={`${s.mark} ${s.dot}`} aria-hidden="true" />;
}

function LaunchPanel({ launch }: { launch: ServerLaunch }) {
  const failed = failedStep(launch.steps);
  const [showReport, setShowReport] = useState(false);
  const title = launch.done
    ? `Running on ${launch.server}`
    : failed
      ? `Moving this conversation to ${launch.server} stopped`
      : `Moving this conversation to ${launch.server}…`;
  return (
    <div className={s.card} data-tone={launch.done ? "done" : failed ? "error" : "run"} role="status">
      <div className={s.head}>
        <Ico name={launch.done ? "server" : failed ? "serverOff" : "server"} className={s.headIco} />
        <span className={s.title}>{title}</span>
        <span className={s.fill} />
        {launch.done ? (
          <button
            type="button"
            className={s.iconBtn}
            onClick={() => dismissServerLaunch(launch.convId)}
            aria-label="Close"
            title="Close this summary"
          >
            <Ico name="x" className="sm" />
          </button>
        ) : (
          <>
            {failed && !launch.running ? (
              <button type="button" className={s.btn} onClick={() => void retryServerLaunch(launch.convId)}>
                <Ico name="refresh" className="sm" />
                Retry
              </button>
            ) : null}
            {/* Not while the conversation is being filed under the server: a cancel could no
                longer keep it on this Mac. Once it is (moved), "Close" is back. */}
            {launch.steps.start.status === "running" && !launch.moved ? null : (
            <button
              type="button"
              className={s.btn}
              data-quiet="1"
              onClick={() => void cancelServerLaunch(launch.convId)}
              title={
                launch.moved
                  ? `The conversation is ${launch.server}'s now — this closes the move; send a message to start it there`
                  : `Stop, remove what the move made on ${launch.server}, and keep this conversation on this ${MACHINE}`
              }
            >
              {launch.moved ? "Close" : "Cancel"}
            </button>
            )}
          </>
        )}
      </div>
      {!launch.done ? (
        <ol className={s.steps}>
          {LAUNCH_STEPS.map((st) => (
            <Step key={st.id} id={st.id} label={st.label} launch={launch} />
          ))}
        </ol>
      ) : (
        <div className={s.doneLine}>
          {launch.worktree ? <code className={s.path}>{launch.worktree.worktree}</code> : null}
          {launch.worktree?.branch ? <span className={s.dim}>branch {launch.worktree.branch}</span> : null}
        </div>
      )}
      {launch.copy ? (
        <div className={s.reportRow}>
          <button type="button" className={s.linkBtn} onClick={() => setShowReport((v) => !v)} aria-expanded={showReport}>
            <Ico name="chevron" className={`sm ${s.chev} ${showReport ? s.chevOpen : ""}`} />
            {launch.copy.copied.length} file{launch.copy.copied.length === 1 ? "" : "s"} copied ·{" "}
            {launch.copy.skipped.length + launch.copy.skippedMore} left behind
          </button>
        </div>
      ) : null}
      {launch.copy && showReport ? <Report launch={launch} /> : null}
    </div>
  );
}

function Step({ id, label, launch }: { id: LaunchStepId; label: string; launch: ServerLaunch }) {
  const st = launch.steps[id];
  const p = launch.progress && st.status === "running" && launch.progress.step === id ? launch.progress : null;
  const frac = p ? progressFraction(p.sent, p.total) : null;
  return (
    <li className={s.step} data-status={st.status}>
      <StepMark status={st.status} />
      <span className={s.stepLabel}>{label}</span>
      {st.status === "done" && st.detail ? <span className={s.stepDetail} title={st.detail}>{st.detail}</span> : null}
      {p ? (
        <span className={s.progress}>
          <span className={s.bar}>
            <span className={s.barFill} style={{ width: `${Math.round((frac ?? 0) * 100)}%` }} />
          </span>
          <span className={s.dim}>
            {formatBytes(p.sent)} / {formatBytes(p.total)}
          </span>
        </span>
      ) : null}
      {st.status === "failed" && st.error ? <div className={s.error}>{st.error}</div> : null}
      {id === "check" && st.status === "done" ? <AlignNotes launch={launch} /> : null}
    </li>
  );
}

/** What aligning the server changed, put off or failed — a failure is shown here, before the
 *  conversation starts, without stopping the move. */
function AlignNotes({ launch }: { launch: ServerLaunch }) {
  const notes = alignNotes(launch.facts);
  if (!notes.length) return null;
  return (
    <ul className={s.alignNotes}>
      {notes.map((n) => (
        <li key={n.part} data-status={n.status}>
          <span className={s.alignPart}>{n.part}</span>
          <span className={s.dim}>
            {n.status}
            {n.detail ? ` — ${n.detail}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Report({ launch }: { launch: ServerLaunch }) {
  const c = launch.copy!;
  const groups = skippedByReason(c);
  return (
    <div className={s.report}>
      {c.copied.length ? (
        <div className={s.group}>
          <div className={s.groupHead}>Copied</div>
          <ul className={s.files}>
            {c.copied.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
                <span className={s.dim}>
                  {COPY_WHY_LABEL[f.why]} · {formatBytes(f.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {groups.map((g) => (
        <div key={g.why} className={s.group}>
          <div className={s.groupHead}>Not copied — {g.label}</div>
          <ul className={s.files}>
            {g.paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {c.skippedMore ? <div className={s.dim}>…and {c.skippedMore} more not copied.</div> : null}
    </div>
  );
}
