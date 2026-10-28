// Put REMOTE conversations back as they are on their server — when the app starts, and when the
// Mac comes back (wake from sleep, network back, the app shown again after a long time away).
//
// A conversation on a paired server keeps running under `flightdeckd` while Flight Deck is closed
// or the Mac sleeps. Every session of the app is lazy, so without this it came back "off" and
// empty until its stream was turned on by hand — a conversation still working showed nothing of
// it. Here, ONE `flightdeckd status` round trip per server (only servers with a conversation not
// attached right now) says what each is doing, and what this Mac remembers (`store/remoteStreams`)
// says which streams were on and which were busy when it stopped watching. `planRemoteResume`
// decides; this module carries it out: a conversation re-attached gets its history from the
// server transcript first, then the daemon's replay merged into it, and lands on its true state
// (running, waiting on a prompt, finished → review) like any live stream. One whose process is
// gone while it was at work was cut short, not finished: it is shown as an error, with a notice.

import { commands } from "../ipc/client";
import {
  convMachineId,
  ensureConversationSession,
  refreshHistoryForReattach,
  useConversationsStore,
  type Conversation,
} from "../store/conversationsStore";
import {
  forgetRemoteStream,
  planRemoteResume,
  remoteStreamMarks,
  type RemoteStreamMark,
  type ResumePlan,
} from "../store/remoteStreams";
import { publishWatchEvent, type WatchEvent } from "./conversationWatch";
import { serverLabel } from "../store/remoteGates";
import { useAppErrors } from "../store/appErrors";
import { useConversationStore } from "../store/conversationStore";
import { useMachineHealthStore, type MachineHealth } from "../store/machineHealth";
import { isOnline } from "../store/online";
import { MACHINE } from "../ui/platform";

/** Heartbeat of the wake detector: timers stop while the Mac sleeps, so a tick that comes this
 *  much later than due means it just woke. */
const HEARTBEAT_MS = 30_000;
const WAKE_GAP_MS = 2 * HEARTBEAT_MS;
/** The app shown again after being hidden at least this long: things may have moved on the server. */
const AWAY_MS = 5 * 60_000;
/** Attaches to ONE server at once. Each first reads the conversation's history there, and the
 *  server's read queue holds 3 (`remote_files::READS_PER_SERVER`): two leave one free for what the
 *  user opens meanwhile. */
const ATTACHES_PER_SERVER = 2;

/** How long after a server's status could not be read it is asked again, attempt by attempt
 *  (the last delay repeats). A pass runs the moment the Mac wakes or launches, often before its
 *  network is usable (Wi-Fi associating, a VPN tunnel not up yet), and nothing else may come to
 *  ask again: no `online` event when the Wi-Fi never dropped, no second wake. */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000];

let inflight: Promise<void> | null = null;
/** A trigger arrived while a pass was under way: one more (full) pass follows it. */
let rerun = false;
/** The servers whose status could not be read, with their pending retry. */
const retries = new Map<string, { attempt: number; timer: number | null }>();

/** Run one resume pass now. A pass already under way is not doubled — but one more follows it:
 *  the trigger (the network back while a status read was still waiting) may carry news it missed. */
export function resumeRemoteConversations(): Promise<void> {
  return runPass();
}

/** One pass over every server (`only` unset) or over one server, through the same single slot. */
function runPass(only?: string): Promise<void> {
  if (inflight) {
    rerun = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      let scope = only;
      do {
        rerun = false;
        await resumePass(scope);
        scope = undefined;
      } while (rerun);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Ask `machineId` again later: its status could not be read, its conversations are undecided.
 *  With no network on this Mac the dial is skipped and the next delay armed (the `online` event
 *  runs a full pass the moment it is back); a server seen reachable again is asked at once. */
function scheduleRetry(machineId: string): void {
  watchReachability();
  const held = retries.get(machineId);
  if (held?.timer != null) window.clearTimeout(held.timer);
  const attempt = held?.attempt ?? 0;
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  const timer = window.setTimeout(() => {
    const entry = retries.get(machineId);
    if (entry) entry.timer = null;
    if (!isOnline()) scheduleRetry(machineId);
    else void runPass(machineId);
  }, delay);
  retries.set(machineId, { attempt: attempt + 1, timer });
}

let watchingReachability = false;

/** A server waiting for a retry that the health probe (the ambient sweep, a "Check now") sees
 *  come back is asked right away: otherwise the server would show reachable while its
 *  conversations stay "off" until the backoff runs out. Only a TRANSITION counts — a server
 *  that answers ssh while its daemon does not would otherwise be re-asked on every sweep. */
function watchReachability(): void {
  if (watchingReachability) return;
  watchingReachability = true;
  // A real verdict of "reachable" (a probe that never got one keeps `checkedAtMs` 0).
  const reached = (h: MachineHealth | undefined) => h !== undefined && h.reachable && h.checkedAtMs !== 0;
  useMachineHealthStore.subscribe((s, prev) => {
    for (const machineId of [...retries.keys()]) {
      if (!reached(s.byMachine[machineId]) || reached(prev.byMachine[machineId])) continue;
      const held = retries.get(machineId);
      if (held?.timer != null) window.clearTimeout(held.timer);
      if (held) held.timer = null;
      void runPass(machineId);
    }
  });
}

/** `machineId` answered, or has nothing left to put back: no retry pending. */
function clearRetry(machineId: string): void {
  const held = retries.get(machineId);
  if (held?.timer != null) window.clearTimeout(held.timer);
  retries.delete(machineId);
}

/** Forget every pending retry — for tests. */
export function resetRemoteResumeForTests(): void {
  for (const id of [...retries.keys()]) clearRetry(id);
  rerun = false;
}

let started = false;

/** Resume once now (call it once the persisted conversations are loaded), then again whenever
 *  the Mac comes back: a wake (a heartbeat that fired late), the network back, the app shown
 *  again after a long time away. Idempotent. */
export function startRemoteResume(): void {
  if (started) return;
  started = true;
  void resumeRemoteConversations();
  window.addEventListener("online", () => void resumeRemoteConversations());
  // A late tick while the window is hidden may only be the OS throttling a background page: it
  // is held, and acted on when the window shows again (one pass, not one per throttled tick).
  let wokeHidden = false;
  let lastTick = Date.now();
  window.setInterval(() => {
    const now = Date.now();
    if (now - lastTick > WAKE_GAP_MS) {
      if (document.hidden) wokeHidden = true;
      else void resumeRemoteConversations();
    }
    lastTick = now;
  }, HEARTBEAT_MS);
  let hiddenAt: number | null = document.hidden ? Date.now() : null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else {
      const away = hiddenAt !== null && Date.now() - hiddenAt > AWAY_MS;
      if (away || wokeHidden) void resumeRemoteConversations();
      hiddenAt = null;
      wokeHidden = false;
    }
  });
}

async function resumePass(only?: string): Promise<void> {
  const s = useConversationsStore.getState();
  const marks = remoteStreamMarks();
  // A mark whose conversation is no longer on a server has nothing to put back. One whose
  // conversation is not in the store at all is left alone: a deleted conversation's mark went
  // with it, so an unknown one means the store did not load (a database error at launch) — and
  // its streams are to be put back once it does.
  for (const id of Object.keys(marks)) {
    if (s.conversations.some((c) => c.id === id) && !convMachineId(s, id)) {
      forgetRemoteStream(id);
      delete marks[id];
    }
  }
  // The conversations with no live session, by server. (Codex never runs on a server.)
  const byServer = new Map<string, Conversation[]>();
  for (const c of s.conversations) {
    if (c.handle || c.kind === "codex") continue;
    const machineId = convMachineId(s, c.id);
    if (!machineId || (only !== undefined && machineId !== only)) continue;
    const list = byServer.get(machineId);
    if (list) list.push(c);
    else byServer.set(machineId, [c]);
  }
  // A server waiting for a retry with nothing left to put back (attached or removed meanwhile).
  for (const machineId of [...retries.keys()]) {
    if ((only === undefined || machineId === only) && !byServer.has(machineId)) clearRetry(machineId);
  }
  await Promise.all([...byServer].map(([machineId, convs]) => resumeOnServer(machineId, convs, marks)));
}

async function resumeOnServer(
  machineId: string,
  convs: Conversation[],
  marks: Record<string, RemoteStreamMark>,
): Promise<void> {
  const res = await commands.remoteConversationStates(machineId);
  // The server could not be asked (down, unreachable, a daemon that does not answer): nothing is
  // decided — a mark stays, no conversation is called finished — and it is asked again shortly.
  if (res.status !== "ok") {
    console.warn(`remote resume: no status from server ${machineId}:`, res.error);
    scheduleRetry(machineId);
    return;
  }
  clearRetry(machineId);
  const states = new Map(res.data.conversations.map((st) => [st.conversation_id, st]));
  // The plan rests on a snapshot: by the time a conversation's history is read (up to minutes),
  // its process may have been stopped or removed from elsewhere. A daemon that can join a running
  // claude only — its OWN word, from this very status — then answers that nothing runs, and starts,
  // un-archives and clears nothing; an older one would cold-start it.
  const existingOnly = res.data.daemon_caps.includes("existing-only");
  const store = useConversationsStore.getState();
  // A conversation's claude session moves on the server while this Mac is away (a `/clear` sent
  // from the phone): this Mac's copy is stale, and both the history read and the next attach must
  // use the one the server runs now.
  for (const c of convs) {
    const moved = states.get(c.id)?.session_id;
    if (moved && moved !== c.sessionId) store.noteSessionId(c.id, moved);
  }
  const plan = planRemoteResume(
    convs.map((c) => ({ convId: c.id, mark: marks[c.id], state: states.get(c.id), reminder: c.pendingReminder })),
  );
  for (const id of plan.review) store.setReminder(id, "review");
  // At work when this Mac stopped watching, and its process is gone: the turn was cut short, not
  // finished. Said in its thread (below the history its next open reads) and shown as an error.
  for (const id of plan.ended) {
    store.setReminder(id, "error");
    useConversationStore
      .getState()
      .addErrorTurn(
        id,
        `This conversation's process ended on ${serverLabel(store.machines, machineId)} while this ${MACHINE} was away, in the middle of its work: its last turn may have been cut short.`,
        "A crash, a restart of the server or of flightdeckd, or a stop from another device ends it. Send a message to start it again.",
      );
  }
  for (const id of plan.forget) forgetRemoteStream(id);
  // Conversations watching these hear it too: what settled while this Mac was away reaches
  // them through no other path (the attach's replay is history — it arms nothing).
  for (const ev of awayWatchEvents(plan, marks)) publishWatchEvent(ev);
  const queue = [...plan.attach];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) await reattach(id, machineId, existingOnly);
  };
  await Promise.all(Array.from({ length: Math.min(ATTACHES_PER_SERVER, queue.length) }, worker));
}

/**
 * What a resume plan tells watchers (conversationWatch.ts), each marked `whileAway`: a
 * conversation whose work ended while this Mac was away settled (how is not known here — the
 * server's status says only that it is no longer at work); one whose process is gone ENDED. A
 * takeover by another client was already told when it happened, and is not told twice.
 */
export function awayWatchEvents(plan: ResumePlan, marks: Record<string, RemoteStreamMark>): WatchEvent[] {
  const gone = new Set(plan.forget.filter((id) => !marks[id]?.replaced));
  const out: WatchEvent[] = [];
  for (const id of plan.review) {
    if (gone.has(id)) continue; // reported as ended below — the stronger fact
    out.push({
      kind: "completed",
      conversationId: id,
      outcome: "unknown",
      subtype: null,
      lastAssistantText: null,
      openQuestion: false,
      whileAway: true,
    });
  }
  for (const id of gone) out.push({ kind: "ended", conversationId: id, reason: "exited", whileAway: true });
  return out;
}

async function reattach(convId: string, machineId: string, existingOnly: boolean): Promise<void> {
  try {
    // History first: the attach's replay merges into what the thread already shows — and it
    // must be the server's transcript as it is NOW, not as it was read earlier in this run.
    await refreshHistoryForReattach(convId);
    // The user may have turned it on, or deleted it, meanwhile.
    const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
    if (!conv || conv.handle) return;
    // Just read: not a second time by the spawn — nor a read that just failed (already surfaced).
    await ensureConversationSession(convId, { existingOnly, historyTried: true });
  } catch (e) {
    const s = useConversationsStore.getState();
    // Removed while it was being re-attached: nothing failed that the user still cares about
    // (a session that came up meanwhile was stopped by the spawn).
    if (!s.conversations.some((c) => c.id === convId)) return;
    console.error("remote resume: re-attach failed:", e);
    useAppErrors
      .getState()
      .pushError(
        `Couldn't re-attach a conversation running on ${serverLabel(s.machines, machineId)}.`,
        e instanceof Error ? e.message : String(e),
      );
  }
}
