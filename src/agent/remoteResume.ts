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
// (running, waiting on a prompt, finished → review) like any live stream.

import { commands } from "../ipc/client";
import {
  convMachineId,
  ensureConversationSession,
  loadConversationHistory,
  useConversationsStore,
  type Conversation,
} from "../store/conversationsStore";
import { forgetRemoteStream, planRemoteResume, remoteStreamMarks, type RemoteStreamMark } from "../store/remoteStreams";
import { serverLabel } from "../store/remoteGates";
import { useAppErrors } from "../store/appErrors";

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

let inflight: Promise<void> | null = null;

/** Run one resume pass now (a pass already under way is joined, not doubled). */
export function resumeRemoteConversations(): Promise<void> {
  if (!inflight) inflight = resumePass().finally(() => (inflight = null));
  return inflight;
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

async function resumePass(): Promise<void> {
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
    if (!machineId) continue;
    const list = byServer.get(machineId);
    if (list) list.push(c);
    else byServer.set(machineId, [c]);
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
  // decided — a mark stays for the next pass, no conversation is called finished.
  if (res.status !== "ok") {
    console.warn(`remote resume: no status from server ${machineId}:`, res.error);
    return;
  }
  const states = new Map(res.data.map((st) => [st.conversation_id, st]));
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
  for (const id of plan.forget) forgetRemoteStream(id);
  const queue = [...plan.attach];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) await reattach(id, machineId);
  };
  await Promise.all(Array.from({ length: Math.min(ATTACHES_PER_SERVER, queue.length) }, worker));
}

async function reattach(convId: string, machineId: string): Promise<void> {
  try {
    // History first: the attach's replay merges into what the thread already shows.
    await loadConversationHistory(convId);
    // The user may have turned it on, or deleted it, meanwhile.
    const conv = useConversationsStore.getState().conversations.find((c) => c.id === convId);
    if (!conv || conv.handle) return;
    await ensureConversationSession(convId);
  } catch (e) {
    console.error("remote resume: re-attach failed:", e);
    const s = useConversationsStore.getState();
    useAppErrors
      .getState()
      .pushError(
        `Couldn't re-attach a conversation running on ${serverLabel(s.machines, machineId)}.`,
        e instanceof Error ? e.message : String(e),
      );
  }
}
