// "Start" and "Discuss" — turning a TOSSE task into a conversation.
//
// One provider owns the whole gesture (resolve the folder, ask what has to be asked,
// send, and decide whether to navigate) and every task row / detail panel reaches it
// through context, rather than each row carrying its own copy of the queries and the
// rules. That is what keeps the two buttons meaning the same thing wherever they are
// pressed — including the last step, which is NOT the same for both: see `handOff`.
//
// The dialog is deliberately NOT always shown. A project whose folder is already known
// and whose repo has the `/pickup` skill starts in one click — "ask once, then remember"
// is the whole promise. It opens when there is something real to decide or to say:
//   - "Discuss" always (the question comes first, by design);
//   - no folder resolves, or several do;
//   - the folder has no `/pickup` skill, so written instructions go instead — a
//     substitution the user is TOLD about rather than left to discover.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { Ico, TosseCrmMark } from "../../ui/kit";
import { repoName, useConversationsStore, useRepos } from "../../store/conversationsStore";
import { useLinkTosseProjectRepo, useTosseProjectRepos, useTosseRepoLinks } from "../../ipc/useTosse";
import { launchFocusesConversation, launchTaskConversation, type LaunchMode } from "./taskConversation";
import { useDisplay } from "../../store/display";
import { resolveTaskFolder } from "./taskFolder";
import { FolderPicker } from "./FolderPicker";
import { pickupSupport, pickupSupportFromCache, type LaunchTask, type PickupSupport } from "./taskPrompts";
import { activationProblem, findPickupPlugin, type PickupPlugin } from "./pickupPlugin";
import card from "./TosseRepoCard.module.css";
import s from "./TaskLaunch.module.css";

/** What the dialog is working on. One at a time — this is a modal gesture. */
interface Pending {
  mode: LaunchMode;
  task: LaunchTask;
  projectId: string | null;
  /** Pre-resolved folder, or null when the dialog has to ask for one. */
  repoId: string | null;
  /** What the caller already knew about `/pickup` there. Null for "Discuss". */
  pickup: PickupSupport | null;
  /** "Start" only: the extra instruction typed in the button's drop-down, carried through
   *  the dialog when one has to be shown (no folder yet, or no pickup skill). */
  extra?: string;
}

interface LaunchDialogState {
  pending: Pending | null;
  open: (p: Pending) => void;
  close: () => void;
}

const useLaunchDialog = create<LaunchDialogState>((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}));

/** How long a task wears its "Started" mark. Long enough to be caught by an eye that was
 *  on the button and has already moved on, short enough that it never reads as the row's
 *  permanent state — after it, the conversation chip alone says the task is taken. */
const STARTED_MS = 2600;

/** The resting value of `startedTaskIds` — one shared empty set, so a provider that has
 *  never started anything hands out the same reference on every render. */
const NO_TASKS: ReadonlySet<string> = new Set();

interface TaskLaunchApi {
  /** Press "Start" or "Discuss" on a task — ALWAYS opens a NEW conversation. A task can
   *  legitimately carry several (a retry, a second opinion, a discussion alongside the
   *  work); reopening an existing one is {@link open}. */
  launch: (task: LaunchTask, projectId: string | null, mode: LaunchMode, extra?: string) => void;
  /** Focus a conversation this task already has. */
  open: (convId: string) => void;
  /** The task whose launch is in flight (its buttons show it), or null. */
  busyTaskId: string | null;
  /** The tasks that JUST started and stayed on this view, each for a few seconds
   *  ({@link STARTED_MS}). Only filled when the window did NOT move: a launch that navigates
   *  announces itself by landing you in the thread, so there is nothing left to confirm.
   *  Read by the task row, which flashes and shows "Started" — otherwise the only thing a
   *  successful click changes is a small chip appearing, easy to miss on the row you were
   *  already looking at.
   *
   *  A SET, not one id: staying put is what makes firing off several tasks in a row the
   *  normal way to work, and one slot would yank the mark off the previous row the moment
   *  the next one started — turning the confirmation into a flicker exactly when it is
   *  being used most. */
  startedTaskIds: ReadonlySet<string>;
}

const Ctx = createContext<TaskLaunchApi | null>(null);

/** The launch API, or null outside the tasks view (so a row can render inert). */
export function useTaskLaunch(): TaskLaunchApi | null {
  return useContext(Ctx);
}

export function TaskLaunchProvider({
  onOpenConversation,
  children,
}: {
  /** Focus a conversation — the tasks view hands over to the thread. Called for "Open",
   *  and after a launch only when that launch focuses (see `handOff`). */
  onOpenConversation: (convId: string) => void;
  children: React.ReactNode;
}) {
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useLaunchDialog((d) => d.pending);
  const openDialog = useLaunchDialog((d) => d.open);
  const closeDialog = useLaunchDialog((d) => d.close);
  const { data: pins } = useTosseProjectRepos();
  const { data: links } = useTosseRepoLinks();
  const repos = useRepos();
  const startStaysOnTasks = useDisplay((d) => d.tosseStartStaysOnTasks);
  const [startedTaskIds, setStartedTaskIds] = useState<ReadonlySet<string>>(NO_TASKS);
  // One timer PER task, so each mark lives out its own few seconds — see `startedTaskIds`.
  const startedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The marks fade on a timer, so they MUST be cancellable: leaving this view mid-flash
  // would otherwise land a state update on an unmounted component.
  useEffect(() => {
    const timers = startedTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  // Mark the row as started, for the few seconds of `STARTED_MS`. Used whenever the window
  // does NOT move — the window moving IS the confirmation everywhere else, so with it gone
  // the row has to say it itself.
  const markStarted = useCallback((taskId: string) => {
    const running = startedTimers.current.get(taskId);
    if (running) clearTimeout(running);
    setStartedTaskIds((prev) => new Set(prev).add(taskId));
    startedTimers.current.set(
      taskId,
      setTimeout(() => {
        startedTimers.current.delete(taskId);
        setStartedTaskIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }, STARTED_MS),
    );
  }, []);

  // Every successful launch ends here — the one-click path AND the dialog's — so the
  // "does the window move" decision is taken in ONE place, whichever route got there.
  const handOff = useCallback(
    (mode: LaunchMode, taskId: string, convId: string) => {
      if (launchFocusesConversation(mode, startStaysOnTasks)) {
        onOpenConversation(convId);
        return;
      }
      markStarted(taskId);
    },
    [markStarted, onOpenConversation, startStaysOnTasks],
  );

  const launch = useCallback(
    (task: LaunchTask, projectId: string | null, mode: LaunchMode, extra?: string) => {
      setError(null);
      // No short-circuit to an existing conversation: these two buttons MEAN "another
      // one", and the surface offers "Open" separately for the ones already there.
      const resolution = resolveTaskFolder(pins ?? [], links, projectId, repos);
      // "Discuss" always asks: the question is the point of the button.
      if (mode === "discuss" || !resolution.repoId) {
        openDialog({ mode, task, projectId, repoId: resolution.repoId, pickup: null, extra });
        return;
      }
      const repo = repos.find((r) => r.id === resolution.repoId);
      // Cached answer only — PROBING the command catalogue spawns a short-lived `claude`,
      // which belongs in the dialog (it can show that it is working), not in a click
      // handler that is meant to be instant. Anything but a confirmed "available" opens the
      // dialog, which probes and then says what it found. (Equipping the folder still runs
      // inside the launch below: that one reads config files off disk, and only pays for a
      // spawn in the one case where it found a dormant plugin to switch on — which is the
      // work the click asked for, and the row shows it is busy while it happens.)
      const pickup = repo ? pickupSupportFromCache(repo.path) : "unknown";
      if (pickup !== "available") {
        openDialog({ mode, task, projectId, repoId: resolution.repoId, pickup, extra });
        return;
      }
      setBusyTaskId(task.id);
      void launchTaskConversation({ task, repoId: resolution.repoId, mode, extra })
        .then((out) => {
          const problem = activationProblem(out.plugin);
          setError(problem);
          // ⚠️ A problem must stay READABLE. Handing the window over unmounts this
          // provider — and the toast with it — so a launch with something to say does not
          // navigate: it stays here, says it, and marks the row started like any launch
          // that stays put. The conversation exists and is linked, so the row's own
          // « Open » button leads to it once the message has been read.
          if (problem) {
            markStarted(task.id);
            return;
          }
          handOff(mode, task.id, out.convId);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusyTaskId(null));
    },
    [handOff, links, markStarted, openDialog, pins, repos],
  );

  const open = useCallback(
    (convId: string) => {
      useConversationsStore.getState().selectConversation(convId);
      onOpenConversation(convId);
    },
    [onOpenConversation],
  );

  const api = useMemo<TaskLaunchApi>(
    () => ({ launch, open, busyTaskId, startedTaskIds }),
    [launch, open, busyTaskId, startedTaskIds],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* A one-click launch that failed has nowhere else to be seen: without this the
          click would simply appear to do nothing. */}
      {error ? (
        <div className={s.toast} role="alert">
          <Ico name="alert" className="sm" />
          <span className={s.toastText}>{error}</span>
          <button
            type="button"
            className={card.iconBtn}
            title="Dismiss"
            onClick={() => setError(null)}
          >
            <Ico name="x" className="sm" />
          </button>
        </div>
      ) : null}
      {/* Keyed by task: opening the dialog on another task REMOUNTS it, so it can never
          inherit the previous one's question, folder or failure. */}
      {pending ? (
        <TaskLaunchDialog
          key={`${pending.task.id}:${pending.mode}`}
          pending={pending}
          onClose={closeDialog}
          onLaunched={(convId) => handOff(pending.mode, pending.task.id, convId)}
        />
      ) : null}
    </Ctx.Provider>
  );
}

/** The folder-and-question dialog. Mounted only while a launch is pending. */
function TaskLaunchDialog({
  pending,
  onClose,
  onLaunched,
}: {
  pending: Pending;
  onClose: () => void;
  /** The launch went through. Whether that also focuses the conversation is the
   *  provider's call (see `handOff`) — the dialog only reports the outcome. */
  onLaunched: (convId: string) => void;
}) {
  const repos = useRepos();
  const { data: pins } = useTosseProjectRepos();
  const { data: links } = useTosseRepoLinks();
  const linkProject = useLinkTosseProjectRepo();

  const [chosenRepoId, setChosenRepoId] = useState<string | null>(null);
  // The user asked to pick another folder. A separate flag, NOT `chosenRepoId = null`:
  // when the folder was pre-resolved (a project pin, or the caller's own resolution),
  // clearing the choice falls straight back onto it and re-displays the same folder, so
  // "Change" would do nothing at all — which is exactly when it is wanted (running one
  // task in a different clone).
  const [changing, setChanging] = useState(false);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The conversation this dialog has already opened. Set when a launch went through but
  // something AROUND it did not, which keeps the dialog up to say so — and this is what
  // stops the still-enabled button from launching a SECOND conversation on the same task.
  const [launched, setLaunched] = useState<string | null>(null);
  const [pickup, setPickup] = useState<PickupSupport | null>(pending.pickup);
  const [probing, setProbing] = useState(false);
  // The plugin that provides the TOSSE skills, as this folder's extensions report it —
  // carried WITH the path it was scanned for, so a folder changed since is never described
  // by the previous one's answer. `undefined` while unknown (or unreadable — nothing is
  // concluded from a scan that failed), `plugin: null` when none is installed. READ-ONLY
  // here; switching it on is the launch's job, so cancelling this dialog never writes
  // anything.
  const [scan, setScan] = useState<{ path: string; plugin: PickupPlugin | null } | undefined>(
    undefined,
  );
  // Whether that scan is still out. Held apart from the answer because "not yet known" and
  // "we looked and found none" must not share a value: the dialog stays silent on the first
  // and speaks on the second.
  const [scanning, setScanning] = useState(false);

  const resolution = useMemo(
    () => resolveTaskFolder(pins ?? [], links, pending.projectId, repos),
    [pins, links, pending.projectId, repos],
  );
  const repoId = chosenRepoId ?? (changing ? null : (pending.repoId ?? resolution.repoId));
  const repo = repos.find((r) => r.id === repoId) ?? null;
  const repoPath = repo?.path ?? null;
  const starting = pending.mode === "pickup";
  const provider = scan && scan.path === repoPath ? scan.plugin : undefined;
  // Installed but off — the launch will switch it on, which is why the dialog must NOT
  // announce the written-instructions fallback in this case: it would describe a folder
  // that stops being true the moment the button is pressed.
  const dormant = provider && !provider.enabled ? provider : null;

  // Escape closes, like the app's other dialogs (the capture-phase guard in App.tsx
  // keeps macOS from leaving fullscreen either way).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Probe `/pickup` for the folder in play — "Start" only, and only once a folder is
  // known. Here rather than in the click handler because it can spawn a short-lived
  // `claude`: the dialog can show that it is working, and say what it found BEFORE
  // anything is sent.
  useEffect(() => {
    if (!starting || !repoPath) return;
    const cached = pickupSupportFromCache(repoPath);
    if (cached !== "unknown") {
      setPickup(cached);
      return;
    }
    let alive = true;
    setProbing(true);
    void pickupSupport(repoPath)
      .then((got) => {
        if (alive) setPickup(got);
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [starting, repoPath]);

  // Which plugin, if any, would equip this folder. Asked for BOTH buttons: "Discuss" opens
  // a conversation that lives on and will want the skills, so a folder where none is
  // installed is worth saying before the question is even typed.
  //
  // "Start" asks only once its catalogue came back empty — there the answer is already
  // known when the skill is published, and this scan exists to tell "nothing installed"
  // apart from "installed, dormant".
  useEffect(() => {
    if (!repoPath || (starting && pickup !== "absent")) {
      setScan(undefined);
      // ⚠️ Clear the in-flight flag too. Reaching this branch WHILE a scan is out (the
      // folder was unregistered, or the catalogue came back) leaves the resolving promise
      // unable to clear it — its `finally` is gated on the effect run that owned it, which
      // has just been cleaned up. Stranded at true, `scanning` would suppress the fallback
      // warning below for the rest of the dialog's life.
      setScanning(false);
      return;
    }
    let alive = true;
    const path = repoPath;
    setScanning(true);
    findPickupPlugin(path)
      .then((found) => {
        if (alive) setScan({ path, plugin: found });
      })
      // A scan that failed says nothing about what is installed, so it must not read as
      // "none". It is not swallowed either: the launch runs the same scan and reports the
      // failure through `activationProblem`.
      .catch(() => {
        if (alive) setScan(undefined);
      })
      .finally(() => {
        if (alive) setScanning(false);
      });
    return () => {
      alive = false;
    };
  }, [starting, repoPath, pickup]);

  async function go(overrideRepoId?: string) {
    // One conversation per dialog, full stop. After a launch that opened one and then had
    // something to report, the button is still there and still enabled — pressing it again
    // must not create a second conversation, link it, send a second first message and write
    // the plugin toggle again. Reaching the one already opened is what the footer offers
    // instead (see `launched`).
    if (launched) return;
    // `overrideRepoId`: a folder just adopted in the SAME click — React state has not been
    // applied yet, so reading `repoId` here would launch in the previous folder (or in
    // none). The explicit id is the only correct one at this point.
    const targetRepoId = overrideRepoId ?? repoId;
    if (!targetRepoId) return;
    setSending(true);
    setError(null);
    try {
      // Remember the folder FOR THE PROJECT, so the question is asked once. A refused
      // pin does NOT stop the launch — but it is said out loud, because being asked
      // again next time with no explanation is exactly the silent failure to avoid.
      let pinError: string | null = null;
      if (pending.projectId && targetRepoId !== resolution.repoId) {
        try {
          await linkProject.mutateAsync({ projectId: pending.projectId, repoId: targetRepoId });
        } catch (e) {
          pinError = e instanceof Error ? e.message : String(e);
        }
      }
      // Hand the scan we already have to the launch, so one launch reads the folder's
      // config files ONCE. Only when it was made for THIS folder: `overrideRepoId` adopts a
      // folder in the same click, and the answer on screen is still the previous one's —
      // passing it would have the launch skip its scan and act on another folder's plugin.
      const targetPath = repos.find((r) => r.id === targetRepoId)?.path ?? null;
      const out = await launchTaskConversation({
        task: pending.task,
        repoId: targetRepoId,
        mode: pending.mode,
        question,
        extra: pending.extra,
        plugin: scan && scan.path === targetPath ? scan.plugin : undefined,
      });
      // Two things can go wrong AROUND a launch that itself succeeded: the folder was not
      // remembered, and the plugin was not switched on. Both are reported together —
      // showing one and dropping the other would be a silent failure for whichever lost.
      const problems = [
        pinError
          ? `The conversation opened, but this folder could not be remembered for the project: ${pinError}`
          : null,
        activationProblem(out.plugin),
      ].filter((p): p is string => p != null);
      if (problems.length > 0) {
        // The conversation IS open; only what surrounds it failed. Keep the dialog up to
        // say so rather than navigating away from the message — and remember which
        // conversation that was, so the footer leads to it instead of opening another.
        setLaunched(out.convId);
        setError(problems.join("\n"));
        setSending(false);
        return;
      }
      onClose();
      onLaunched(out.convId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  const busy = sending || probing;

  return (
    <div className={card.scrim} onClick={onClose}>
      <div
        className={`${card.panel} ${s.panel}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className={card.head}>
          <TosseCrmMark className={card.headMark} />
          <span className={card.title}>
            {starting ? "Start" : "Discuss"}
            <span className={card.titleRepo}> · {pending.task.title}</span>
          </span>
          <button type="button" className={card.iconBtn} title="Close (Esc)" onClick={onClose}>
            <Ico name="x" className="sm" />
          </button>
        </div>

        <div className={s.body}>
          {/* ── Where the work happens ── */}
          <div className={s.section}>
            <div className={s.sectionTitle}>Where should this run?</div>
            {repo ? (
              <div className={s.chosen}>
                <Ico name="folder" className={`sm ${s.chosenIco}`} />
                <span className={s.chosenBody}>
                  <span className={s.chosenName}>{repoName(repo.path)}</span>
                  <span className={s.chosenPath}>{repo.path}</span>
                </span>
                <button
                  type="button"
                  className={card.ghostBtn}
                  disabled={busy || launched !== null}
                  onClick={() => {
                    setChosenRepoId(null);
                    setChanging(true);
                  }}
                >
                  Change
                </button>
              </div>
            ) : (
              // The shared picker — the same one a project card's folder chip opens, so the
              // two never drift apart. Choosing there hands back a REGISTERED folder id.
              <FolderPicker
                projectId={pending.projectId}
                busy={busy}
                onChoose={(id) => {
                  setChosenRepoId(id);
                  setChanging(false);
                  // "Start" has nothing else to ask, so one click goes all the way.
                  // "Discuss" only selects: the question field below is the point of it.
                  return starting ? go(id) : undefined;
                }}
              />
            )}
          </div>

          {/* ── The question, for "Discuss" ── */}
          {!starting ? (
            <div className={s.section}>
              <div className={s.sectionTitle}>What do you want to think through?</div>
              {/* The hint sits ABOVE the field, not under it: on a short window the body
                  scrolls, and whatever is last gets cut in half. A field cut in half still
                  reads as a field; a sentence cut in half reads as a bug. */}
              <div className={s.sectionHint} title="The task is pasted into the prompt, and the agent is told to think it through rather than begin.">
                The agent thinks it through — it does not start.
              </div>
              <textarea
                className={s.question}
                autoFocus
                rows={3}
                value={question}
                placeholder="Optional — leave it empty and the agent will ask where to start."
                disabled={busy}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘↵ sends, like the composer. A bare ↵ writes a newline: this is a
                  // question one writes out, not a one-line field.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
                }}
              />
            </div>
          ) : null}

          {/* ── Nothing installed provides the skills: the conversation opens without them ──
              Only for "Discuss": "Start" says it below, in the terms that matter there
              (which prompt gets sent instead). */}
          {!starting && repo && provider === null ? (
            <div className={card.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={card.problemTitle}>No TOSSE plugin in this folder</div>
                <div className={card.problemBody}>
                  The conversation opens without its skills — no <code>/pickup</code>,{" "}
                  <code>/done</code> or <code>/list-tasks</code> to carry the work on
                  afterwards. The question below still works: the task travels inside the
                  prompt.
                </div>
              </div>
            </div>
          ) : null}

          {/* ── The substitution, said out loud when nothing can be switched on ──
              Waits for the plugin scan: announcing the fallback while a dormant plugin is
              still being looked for would describe a folder that stops being true the
              moment Start is pressed. */}
          {starting && repo && !dormant && !scanning && pickup !== null && pickup !== "available" ? (
            <div className={card.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={card.problemTitle}>
                  {pickup === "absent"
                    ? "No pickup skill in this folder"
                    : "This folder's commands could not be read"}
                </div>
                <div className={card.problemBody}>
                  A slash command this folder does not know would reach the agent as plain
                  text and move nothing in TOSSE. Written instructions go instead: the agent
                  reads the task, checks its blockers and moves it to « En cours » itself —
                  or says so if it cannot.
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className={card.problem}>
              <Ico name="alert" className="sm" />
              <div>
                <div className={card.problemTitle}>Something did not go through</div>
                <div className={card.problemBody}>{error}</div>
              </div>
            </div>
          ) : null}
        </div>

        <div className={card.foot}>
          {probing ? <span className={card.footNote}>Checking this folder's commands…</span> : null}
          <span className={card.footSpacer} />
          <button type="button" className={card.ghostBtn} disabled={sending} onClick={onClose}>
            {launched ? "Close" : "Cancel"}
          </button>
          {/* Once a conversation has been opened, the primary action is to GO TO IT — the
              launch is done, and offering to run it again is offering to duplicate it. */}
          {launched ? (
            <button
              type="button"
              className={card.primaryBtn}
              onClick={() => {
                onClose();
                onLaunched(launched);
              }}
            >
              Open the conversation
            </button>
          ) : (
            <button
              type="button"
              className={card.primaryBtn}
              disabled={busy || !repoId}
              onClick={() => void go()}
            >
              {sending ? "Opening…" : starting ? "Start" : "Discuss"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
