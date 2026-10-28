// Drives a server launch, step by step, for one conversation: the steps run in the core
// (`src-tauri/src/server_launch`, one IPC each), the state of each lives here so the
// preparation screen shows every one of them — running, done with what it found, or failed
// with why and a way to retry. In memory, keyed by conversation id: a launch is a minute of
// work, not something to resume after a restart (the core forgets it too).
//
// While a launch runs, its conversation is LOCKED (`launchLocks`): nothing may start it on
// this Mac. The last step files it under the server folder and starts it there.

import { create } from "zustand";
import {
  commands,
  events,
  type CopyOutcome,
  type ServerFacts,
  type TransferOutcome,
  type WorktreeOutcome,
} from "../../../ipc/client";
import {
  ensureConversationSession,
  moveConversationToServer,
  useConversationsStore,
} from "../../../store/conversationsStore";
import { lockForLaunch, onLaunchAbort, unlockForLaunch } from "../../../store/launchLocks";
import { useAppErrors } from "../../../store/appErrors";
import {
  checkDetail,
  copyDetail,
  freshSteps,
  nextStep,
  transferDetail,
  worktreeDetail,
  type LaunchStepId,
  type StepState,
} from "./serverLaunchModel";

export interface LaunchProgress {
  step: string;
  sent: number;
  total: number;
}

export interface ServerLaunch {
  convId: string;
  machineId: string;
  /** The server's name, as the user knows it. */
  server: string;
  /** The repository on this Mac the launch takes its state from. */
  repoPath: string;
  launchId: string | null;
  steps: Record<LaunchStepId, StepState>;
  running: boolean;
  /** The run driving this launch now. A run whose launch was cancelled — or replaced by a
   *  new one for the same conversation — sees another value after its next await, and
   *  stops there, touching nothing. */
  runId: number;
  progress: LaunchProgress | null;
  facts: ServerFacts | null;
  transfer: TransferOutcome | null;
  copy: CopyOutcome | null;
  worktree: WorktreeOutcome | null;
  /** The conversation is filed under the server folder now: abandoning the launch must not
   *  remove the worktree it points at. */
  moved: boolean;
  /** Started on the server. */
  done: boolean;
}

interface State {
  byConv: Record<string, ServerLaunch>;
  /** Conversations whose invite the user closed (this run only). */
  dismissed: Record<string, true>;
}

export const useServerLaunchStore = create<State>(() => ({ byConv: {}, dismissed: {} }));

export const useServerLaunch = (convId: string): ServerLaunch | null =>
  useServerLaunchStore((s) => s.byConv[convId] ?? null);

function get(convId: string): ServerLaunch | null {
  return useServerLaunchStore.getState().byConv[convId] ?? null;
}

function patch(convId: string, p: Partial<ServerLaunch>): void {
  useServerLaunchStore.setState((s) => {
    const cur = s.byConv[convId];
    return cur ? { byConv: { ...s.byConv, [convId]: { ...cur, ...p } } } : s;
  });
}

function setStep(convId: string, id: LaunchStepId, p: Partial<StepState>): void {
  const cur = get(convId);
  if (!cur) return;
  patch(convId, { steps: { ...cur.steps, [id]: { ...cur.steps[id], ...p } } });
}

function unwrap<T>(r: { status: "ok"; data: T } | { status: "error"; error: string }): T {
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let listening: Promise<unknown> | null = null;

/** One app-wide listener for the uploads' progress, routed to the launch it belongs to. */
function ensureProgressListener(): void {
  if (listening) return;
  listening = events.serverLaunchProgressEvent
    .listen((e) => {
      const p = e.payload;
      const l = Object.values(useServerLaunchStore.getState().byConv).find((x) => x.launchId === p.launchId);
      if (l) patch(l.convId, { progress: { step: p.step, sent: p.sent, total: p.total } });
    })
    .catch((e: unknown) => {
      listening = null;
      console.error("[server launch] progress listener failed:", e);
    });
}

export function dismissInvite(convId: string): void {
  useServerLaunchStore.setState((s) => ({ dismissed: { ...s.dismissed, [convId]: true } }));
}

/** Start moving `convId` — an empty conversation on this Mac — to server `machineId`. */
export async function startServerLaunch(convId: string, machineId: string): Promise<void> {
  if (get(convId)) return;
  const st = useConversationsStore.getState();
  const conv = st.conversations.find((c) => c.id === convId);
  const repo = conv ? st.repos.find((r) => r.id === conv.repoId) : undefined;
  const machine = st.machines.find((m) => m.id === machineId);
  if (!conv || !repo || repo.machineId || !machine) {
    useAppErrors
      .getState()
      .pushError("Can't move this conversation to a server", "It is no longer an empty conversation on this computer.");
    return;
  }
  const server = machine.label.trim() || machine.host;
  useServerLaunchStore.setState((s) => ({
    byConv: {
      ...s.byConv,
      [convId]: {
        convId,
        machineId,
        server,
        // The conversation's own folder: a worktree of this Mac, when it was started in one.
        repoPath: conv.cwd,
        launchId: null,
        steps: freshSteps(),
        running: false,
        runId: 0,
        progress: null,
        facts: null,
        transfer: null,
        copy: null,
        worktree: null,
        moved: false,
        done: false,
      },
    },
  }));
  lockForLaunch(convId, server);
  ensureProgressListener();
  await run(convId);
}

/** Run the failed step again, then the rest. */
export async function retryServerLaunch(convId: string): Promise<void> {
  await run(convId);
}

/**
 * Abandon the launch. Before the conversation was moved: everything it made on the server goes
 * (its worktree and the branch it created; the clone stays — the next launch reuses it), and
 * the conversation stays on this Mac, unchanged. After: the conversation is the server's now,
 * so only the launch's leftovers go.
 */
export async function cancelServerLaunch(convId: string): Promise<void> {
  const l = get(convId);
  if (!l) return;
  useServerLaunchStore.setState((s) => {
    const { [convId]: _, ...rest } = s.byConv;
    return { byConv: rest };
  });
  unlockForLaunch(convId);
  if (!l.launchId) return;
  await endLaunch(l.launchId, !l.moved, l.server);
}

/** End the launch in the core; what it could not clean up is said. */
async function endLaunch(launchId: string, discard: boolean, server: string): Promise<void> {
  try {
    const r = await commands.serverLaunchEnd(launchId, discard);
    if (r.status === "error") {
      useAppErrors.getState().pushError(`Couldn't clean up what the move left on ${server}`, r.error);
    }
  } catch (e) {
    useAppErrors.getState().pushError(`Couldn't clean up what the move left on ${server}`, message(e));
  }
}

// Removing the conversation (or its folder) mid-move ends the move, cleaning up after it.
onLaunchAbort((convId) => void cancelServerLaunch(convId));

/** Forget a finished launch (its summary card is closed). */
export function dismissServerLaunch(convId: string): void {
  useServerLaunchStore.setState((s) => {
    const { [convId]: _, ...rest } = s.byConv;
    return { byConv: rest };
  });
}

let runSeq = 0;

/** How the core says a step that outlived its cancel could not remove what it made.
 *  ⚠️ The exact opening of `LEFT_BEHIND` in `src-tauri/src/ipc/server_launch.rs`. */
export const LEFT_BEHIND = "A cancelled move left something on the server:";

/** Raised when the run's launch is no longer the one it drives (see `ServerLaunch.runId`). */
class Superseded extends Error {}

async function run(convId: string): Promise<void> {
  const first = get(convId);
  if (!first || first.running) return;
  const runId = ++runSeq;
  patch(convId, { running: true, runId });
  const alive = () => get(convId)?.runId === runId;
  for (;;) {
    const l = get(convId);
    if (!l || !alive()) return; // cancelled, or another launch now
    const step = nextStep(l.steps);
    if (!step) break;
    setStep(convId, step, { status: "running", error: null });
    try {
      const detail = await runStep(convId, step, alive);
      if (!alive()) return;
      setStep(convId, step, { status: "done", detail });
    } catch (e) {
      if (!alive() || e instanceof Superseded) {
        // Nobody waits on this step any more — but what it could not clean up after the
        // cancel (a worktree with the copied secrets) must still be said.
        const msg = message(e);
        if (msg.startsWith(LEFT_BEHIND)) {
          useAppErrors.getState().pushError(`A cancelled move left something on ${first.server}`, msg);
        }
        return;
      }
      setStep(convId, step, { status: "failed", error: message(e) });
      patch(convId, { running: false, progress: null });
      return;
    }
  }
  patch(convId, { running: false, progress: null, done: true });
}

async function runStep(convId: string, step: LaunchStepId, alive: () => boolean): Promise<string> {
  const l = get(convId);
  if (!l) throw new Superseded();
  let id = l.launchId;
  if (!id) {
    id = unwrap(await commands.serverLaunchBegin(convId, l.machineId, l.repoPath));
    if (!alive()) {
      // Cancelled while it began: nothing was sent yet, end it at once.
      void endLaunch(id, true, l.server);
      throw new Superseded();
    }
    patch(convId, { launchId: id });
  }
  // A step's answer, only while this run still drives the launch: nothing is written for a
  // launch that was cancelled or replaced meanwhile.
  const answer = async <T,>(p: Promise<{ status: "ok"; data: T } | { status: "error"; error: string }>): Promise<T> => {
    const v = unwrap(await p);
    if (!alive()) throw new Superseded();
    return v;
  };
  switch (step) {
    case "check": {
      const facts = await answer(commands.serverLaunchCheck(id));
      patch(convId, { facts });
      return checkDetail(facts);
    }
    case "transfer": {
      patch(convId, { progress: null });
      const transfer = await answer(commands.serverLaunchTransfer(id));
      // The core drops what later steps had made against an older transfer; so does this.
      const cur = get(convId);
      if (cur) {
        patch(convId, {
          transfer,
          copy: null,
          worktree: null,
          progress: null,
          steps: { ...cur.steps, copy: { status: "pending", detail: null, error: null }, worktree: { status: "pending", detail: null, error: null } },
        });
      }
      return transferDetail(transfer);
    }
    case "copy": {
      patch(convId, { progress: null });
      const copy = await answer(commands.serverLaunchCopy(id));
      patch(convId, { copy, progress: null });
      return copyDetail(copy);
    }
    case "worktree": {
      const worktree = await answer(commands.serverLaunchWorktree(id));
      patch(convId, { worktree });
      return worktreeDetail(worktree);
    }
    case "start": {
      // The answer is checked against the run: the last point a cancel (the button is gone
      // once this step runs; a removal of the conversation still lands here) keeps the
      // conversation on this Mac.
      const target = await answer(commands.serverLaunchFinish(id));
      await moveConversationToServer(convId, l.machineId, target.clone, target.cwd);
      patch(convId, { moved: true });
      unlockForLaunch(convId);
      await ensureConversationSession(convId, { launch: true });
      // What the launch left on the server (its upload folder): cleaned now. A failure there
      // costs nothing but disk, and is said — never silent.
      void endLaunch(id, false, l.server);
      return `running on ${l.server}`;
    }
  }
}
