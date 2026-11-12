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
  /** Another client took it over (`replaced`): never re-attached on its own, at work or not —
   *  taking it back would make that client take it back in turn. Until the user turns its stream
   *  on here again. */
  replaced?: true;
}

type Marks = Record<string, RemoteStreamMark>;

// The last raw value read and what it parsed to: the router asks on every state event of a
// remote conversation, and the value only changes on a transition.
let memo: { raw: string | null; marks: Marks } | null = null;

function read(): Marks {
  try {
    const raw = localStorage.getItem(KEY);
    if (memo && memo.raw === raw) return { ...memo.marks };
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const marks: Marks = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v && typeof v === "object" && typeof (v as RemoteStreamMark).atWork === "boolean") {
          const mark: RemoteStreamMark = { atWork: (v as RemoteStreamMark).atWork };
          if ((v as RemoteStreamMark).replaced === true) mark.replaced = true;
          marks[id] = mark;
        }
      }
    }
    memo = { raw, marks };
    return { ...marks };
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
  const held = marks[convId];
  if (held && held.atWork === atWork && !held.replaced) return;
  marks[convId] = { atWork };
  write(marks);
}

/** Another client took `convId` over: it is not re-attached on its own any more (see
 *  {@link RemoteStreamMark.replaced}). */
export function markRemoteStreamReplaced(convId: string): void {
  const marks = read();
  if (marks[convId]?.replaced) return;
  marks[convId] = { atWork: false, replaced: true };
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
  /** Its work ended while this Mac was away (it was at work, it no longer is, its process
   *  still lives): to review. */
  review: string[];
  /** Its process is GONE while it was at work: not a turn that finished (a persistent claude
   *  does not exit after a turn) but one cut short — a crash, a server or daemon restart, a stop
   *  from another device. Shown as an error, never as a clean finish. */
  ended: string[];
  /** Its mark goes: no process of it is left on the server. */
  forget: string[];
}

/**
 * Decide, conversation by conversation, from what the server says and what this Mac remembers.
 * Pure. Attaching is not free (one ssh link per conversation, and an attach replaces any other
 * client), so only a conversation with a LIVE process is ever attached — never one the server
 * would have to cold-start — and among those only one at work now, or whose stream was on. A
 * conversation that was at work and no longer is turns "review" (blue): it finished while nobody
 * watched — as long as its process is still there. One whose process is gone did not finish: it
 * was cut short (see {@link ResumePlan.ended}). An existing reminder (an error, an open question)
 * is never overwritten.
 */
export function planRemoteResume(candidates: ResumeCandidate[]): ResumePlan {
  const plan: ResumePlan = { attach: [], review: [], ended: [], forget: [] };
  for (const c of candidates) {
    const alive = c.state?.running === true;
    // Another client holds it: left alone while its process lives, forgotten once it is gone.
    if (c.mark?.replaced) {
      if (!alive) plan.forget.push(c.convId);
      continue;
    }
    const atWorkNow = alive && c.state?.at_work === true;
    const stoppedWhileAway = c.mark?.atWork === true && !atWorkNow && c.reminder === null;
    if (stoppedWhileAway) (alive ? plan.review : plan.ended).push(c.convId);
    if (alive && (atWorkNow || c.mark)) plan.attach.push(c.convId);
    else if (c.mark && !alive) plan.forget.push(c.convId);
  }
  return plan;
}
