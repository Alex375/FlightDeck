// Remote conversations whose stream this Mac holds open, and whether each was AT WORK (a turn
// running, a request waiting on a human, background work going) when this Mac last saw it —
// persisted to localStorage, so the next launch, or the Mac waking up, can put things back as they
// are on the server (see `agent/remoteResume.ts`).
//
// Why: a conversation on a paired server outlives this app. It keeps running under `flightdeckd`
// while Flight Deck is closed or the Mac sleeps, but every session of the app is lazy — nothing
// is attached at launch — so it came back "off", empty, until its stream was turned on by hand.
// What the server says (`remoteConversationStates`) is half of the answer; the other half is
// what only this Mac knew: which streams were on, and which were busy when it stopped watching.
//
// A mark is written while the stream is live (on every state the session reports), kept when the
// session ends with the server process alive (the app quitting, a link lost for good), and dropped
// when the stream is turned off or the process ended. Same shape as the other per-conversation
// localStorage caches: best-effort, never throws.

import type { RemoteConversationState } from "../ipc/client";
import type { ReminderKind } from "../agent/status";

const KEY = "tosse:remotestreams";

/** One remote conversation whose stream was on. */
export interface RemoteStreamMark {
  /** It was at work when this Mac last saw it. */
  atWork: boolean;
}

type Marks = Record<string, RemoteStreamMark>;

function read(): Marks {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const marks: Marks = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as RemoteStreamMark).atWork === "boolean") {
        marks[id] = { atWork: (v as RemoteStreamMark).atWork };
      }
    }
    return marks;
  } catch {
    return {}; // corrupt/absent → empty, never throw
  }
}

function write(marks: Marks): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(marks));
  } catch (e) {
    console.warn("remoteStreams: failed to persist", e);
  }
}

/** Every remote conversation marked as streaming. */
export function remoteStreamMarks(): Marks {
  return read();
}

/** The stream of remote conversation `convId` is live; `atWork` = what it is doing now. No-op
 *  when unchanged (called on every state event). */
export function markRemoteStream(convId: string, atWork: boolean): void {
  const marks = read();
  if (marks[convId]?.atWork === atWork) return;
  marks[convId] = { atWork };
  write(marks);
}

/** The stream of `convId` was turned off, its server process ended, or the conversation is gone. */
export function forgetRemoteStream(convId: string): void {
  const marks = read();
  if (!(convId in marks)) return;
  delete marks[convId];
  write(marks);
}

/** Drop every mark — on a full data wipe ("Delete all"). */
export function clearAllRemoteStreams(): void {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    console.warn("remoteStreams: failed to clear", e);
  }
}

/** One remote conversation with no live session, as the resume pass sees it. */
export interface ResumeCandidate {
  convId: string;
  /** This Mac's mark of it, if its stream was on. */
  mark: RemoteStreamMark | undefined;
  /** Its server's answer — `undefined` when the server listed no process of it. */
  state: RemoteConversationState | undefined;
  /** Its persisted reminder. */
  reminder: ReminderKind | null;
}

/** What to do with the candidates of ONE server whose status was read. */
export interface ResumePlan {
  /** Re-attach: its process is alive and either at work or its stream was on. */
  attach: string[];
  /** Its work ended while this Mac was away (it was at work, it no longer is): to review. */
  review: string[];
  /** Its mark goes: no process of it is left on the server. */
  forget: string[];
}

/**
 * Decide, conversation by conversation, from what the server says and what this Mac remembers.
 * Pure. Attaching is not free (one ssh link per conversation, and an attach replaces any other
 * client), so only a conversation with a LIVE process is ever attached — never one the server
 * would have to cold-start — and among those only one at work now, or whose stream was on. A
 * conversation that was at work and no longer is turns "review" (blue): it finished while nobody
 * watched. An existing reminder (an error, an open question) is never overwritten.
 */
export function planRemoteResume(candidates: ResumeCandidate[]): ResumePlan {
  const plan: ResumePlan = { attach: [], review: [], forget: [] };
  for (const c of candidates) {
    const alive = c.state?.running === true;
    const atWorkNow = alive && c.state?.at_work === true;
    const finishedWhileAway = c.mark?.atWork === true && !atWorkNow && c.reminder === null;
    if (finishedWhileAway) plan.review.push(c.convId);
    if (alive && (atWorkNow || c.mark)) plan.attach.push(c.convId);
    else if (c.mark && !alive) plan.forget.push(c.convId);
  }
  return plan;
}
