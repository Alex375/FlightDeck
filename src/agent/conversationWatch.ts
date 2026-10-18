// Conversation WATCH & WAIT — how one conversation hears about another without polling.
//
// The flightdeck MCP server lets a conversation start another (`create_conversation`) and
// message it (`send_message`), but the relationship used to end there: nothing told the
// caller when the other one finished, got stuck, or died. Observed for real (CRM task
// 75b8d6c9): a conversation tailed transcripts on disk to follow one it had launched, watched
// the wrong signal, and saw NOTHING for 16 hours while the other wrote 9 500 lines. The
// absence of a signal read like "nothing happened" — the failure mode this module exists to
// rule out: every outcome below is an explicit event, never a silence.
//
// Two ways in, one event source:
//  - WATCH (fire-and-forget): `watch_conversation` subscribes the caller; each event of the
//    watched conversation is DELIVERED to the watcher as a message (a `<flightdeck-message>`
//    envelope marked `<watch-event>`, see agentMessage.ts), which wakes it — or is injected
//    into its running turn, like any message. 'once' (default) ends after one event.
//  - WAIT (blocking): `wait_for_conversation` parks the caller's tool call until the next
//    event, or answers at once when one already happened since the caller's last message.
//
// The events (`publishWatchEvent`) come from the SAME settled point that fires the OS
// notifications (`fireAgentNotification`, useGlobalSessionEvents.ts) — after the settle
// window, minus no-op turns, minus "finished but background work continues" — so a watcher
// hears exactly what the human would have been pinged about. Plus the endings that point
// never sees: the process ended (`ended` state, reported with its reason), the session was
// stopped, the conversation was removed (both seen here, by diffing the conversations store).
//
// Unlike the Rust event journal (`appmcp/events.rs`), this runs for REMOTE conversations
// too: the journal gates them out because their host daemon emits its own events to the
// phone, but a watcher on this Mac has no other way to hear about them.
//
// Loop guard: a notification wakes the watcher, whose finished turn may notify ITS watchers,
// and two conversations watching each other would wake each other forever, a paid turn each
// time, with no agent ever deciding anything. Each notification carries a depth — one more
// than the depth of the turn it reports on, read back from that conversation's last prompt
// (a notification → its depth; anything else, a human's message above all → 0). Past
// MAX_WATCH_DEPTH the notification is held back and the HUMAN is told. Derived from the
// thread itself, so it needs no bookkeeping and survives a reload.

import { useMemo } from "react";
import { create } from "zustand";
import { useConversationsStore, loadConversationHistory } from "../store/conversationsStore";
import { useConversationStore } from "../store/conversationStore";
import { agentWatchEnabled, useAppControlPrefs } from "../store/appControl";
import { loadJson, saveJson } from "../store/persist";
import { pushInfoToast } from "../store/toasts";
import { sendConversationMessage } from "../ipc/useCommands";
import { isAppStopping } from "../store/stopIntent";
import { onConversationsBooted } from "../store/bootSignal";
import { remoteStreamMarks } from "../store/remoteStreams";
import {
  buildWatchNotificationEnvelope,
  parseAgentMessage,
  type AgentMessageSender,
} from "../features/conversation/agentMessage";
import type { SessionEndReason } from "../ipc/client";
import type { SessionEntry } from "../store/types";

// ---- Types ---------------------------------------------------------------------

export type WatchMode = "once" | "persistent";

export interface WatchSubscription {
  watcherId: string;
  targetId: string;
  mode: WatchMode;
}

/** Why a watched conversation stopped being reachable. The `SessionEndReason`s come from the
 *  core's `ended` state; `removed` is the conversation leaving the list. */
export type WatchEndReason = SessionEndReason | "removed";

export type WatchEvent = (
  | {
      kind: "completed";
      conversationId: string;
      /** `unknown`: it settled while this Mac was not following it (a server conversation seen
       *  again after a sleep or a relaunch) — that it is no longer at work is all that is known. */
      outcome: "success" | "error" | "interrupted" | "unknown";
      /** The result subtype of an errored turn (`error_max_turns`, …). */
      subtype: string | null;
      lastAssistantText: string | null;
      openQuestion: boolean;
    }
  | {
      kind: "needs_attention";
      conversationId: string;
      reason: "permission" | "question";
      tool: string | null;
      prompt: string | null;
    }
  | {
      kind: "ended";
      conversationId: string;
      reason: WatchEndReason;
    }
) & {
  /** It happened while this Mac was not following the conversation (asleep, closed, or its
   *  link down) and was only learned afterwards — said so, not passed off as just now. */
  whileAway?: boolean;
};

/** Consecutive notifications allowed before the chain is held back (see the module doc). */
export const MAX_WATCH_DEPTH = 4;

/** `wait_for_conversation`'s default / maximum wait — mirror of `WAIT_DEFAULT_SECS` /
 *  `WAIT_MAX_SECS` in `src-tauri/src/appmcp/tools.rs`, whose bridge outlasts it. */
export const WAIT_DEFAULT_S = 300;
export const WAIT_MAX_S = 1800;

/** The longest last reply a notification quotes; the rest is one `read_conversation` away. */
const QUOTE_MAX = 2000;
const PROMPT_MAX = 600;

/** The endings after which the process may well live on — on its server — and finish its
 *  work later: this Mac only lost its view of it. */
export function mayStillRun(reason: WatchEndReason): boolean {
  return reason === "replaced" || reason === "detached" || reason === "link_failed";
}

/** The one ending after which THIS MAC follows the conversation again on its own: a link that
 *  failed keeps its resume mark, so the next resume pass re-attaches it (or reports what became
 *  of it). A `replaced` one is tombstoned instead — another client owns it now, this Mac never
 *  re-follows it — so a watch on it cannot be kept and must not promise otherwise. */
function watchOutlives(reason: WatchEndReason): boolean {
  return reason === "link_failed";
}

// ---- Subscriptions (persisted) ------------------------------------------------

const STORAGE_KEY = "tosse:convwatch";

interface Persisted {
  subscriptions?: unknown;
}

function isSubscription(v: unknown): v is WatchSubscription {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.watcherId === "string" &&
    typeof s.targetId === "string" &&
    (s.mode === "once" || s.mode === "persistent")
  );
}

function loadSubscriptions(): WatchSubscription[] {
  const raw = loadJson<Persisted>(STORAGE_KEY, {}).subscriptions;
  return Array.isArray(raw) ? raw.filter(isSubscription) : [];
}

/** A `wait_for_conversation` call in flight — what the UI shows as "Waiting for …". */
export interface ActiveWait {
  watcherId: string;
  targetId: string;
  startedAt: number;
}

interface WatchState {
  subscriptions: WatchSubscription[];
  /** Live only (a wait dies with its turn): never persisted. */
  waits: ActiveWait[];
}

/** Subscriptions are persisted so they survive an app restart: a watched conversation on a
 *  server keeps working while this Mac is off, and its next event must still reach the watcher. */
export const useConversationWatchStore = create<WatchState>(() => ({
  subscriptions: loadSubscriptions(),
  waits: [],
}));

function setSubscriptions(next: WatchSubscription[]): void {
  useConversationWatchStore.setState({ subscriptions: next });
  saveJson(STORAGE_KEY, { subscriptions: next });
}

/** Subscribe `watcherId` to `targetId` (idempotent; re-watching updates the mode). */
export function watchConversation(watcherId: string, targetId: string, mode: WatchMode): void {
  const rest = useConversationWatchStore
    .getState()
    .subscriptions.filter((s) => !(s.watcherId === watcherId && s.targetId === targetId));
  setSubscriptions([...rest, { watcherId, targetId, mode }]);
}

/** Drop one subscription; says whether there was one. */
export function unwatchConversation(watcherId: string, targetId: string): boolean {
  const subs = useConversationWatchStore.getState().subscriptions;
  const rest = subs.filter((s) => !(s.watcherId === watcherId && s.targetId === targetId));
  if (rest.length === subs.length) return false;
  setSubscriptions(rest);
  return true;
}

/** What `watcherId` is watching. */
export function watchesOf(watcherId: string): WatchSubscription[] {
  return useConversationWatchStore.getState().subscriptions.filter((s) => s.watcherId === watcherId);
}

/** The subscription of `watcherId` on `targetId`, if any. */
export function watchOf(watcherId: string, targetId: string): WatchSubscription | null {
  return (
    useConversationWatchStore
      .getState()
      .subscriptions.find((s) => s.watcherId === watcherId && s.targetId === targetId) ?? null
  );
}

const NO_SUBS: WatchSubscription[] = [];
const NO_WAITS: ActiveWait[] = [];

/** What a conversation is watching, live — for the watch bar and the Flight Deck card. The
 *  selector returns a stable empty array when there is nothing, and the joined key keeps a
 *  write that touches OTHER conversations from re-rendering this one. */
export function useWatchesOf(watcherId: string): WatchSubscription[] {
  const key = useConversationWatchStore((s) =>
    s.subscriptions
      .filter((w) => w.watcherId === watcherId)
      .map((w) => `${w.targetId}:${w.mode}`)
      .join("|"),
  );
  return useMemo(
    () =>
      key
        ? key.split("|").map((part) => {
            const [targetId, mode] = part.split(":");
            return { watcherId, targetId, mode: mode as WatchMode };
          })
        : NO_SUBS,
    [key, watcherId],
  );
}

/** The waits a conversation has in flight, live. */
export function useWaitsOf(watcherId: string): ActiveWait[] {
  const key = useConversationWatchStore((s) =>
    s.waits
      .filter((w) => w.watcherId === watcherId)
      .map((w) => `${w.targetId}:${w.startedAt}`)
      .join("|"),
  );
  return useMemo(
    () =>
      key
        ? key.split("|").map((part) => {
            const [targetId, startedAt] = part.split(":");
            return { watcherId, targetId, startedAt: Number(startedAt) };
          })
        : NO_WAITS,
    [key, watcherId],
  );
}

// ---- Event sequence + waits (memory) ------------------------------------------

/** Events published per conversation since launch — a cursor, never reused. */
const seqByConv = new Map<string, number>();
/** The newest event of each conversation, with its sequence number. */
const lastEventByConv = new Map<string, { seq: number; event: WatchEvent }>();
/** `watcher→target` → the target's sequence when the watcher last messaged it: an event past
 *  it is the answer to that message, even if it landed before the watcher started waiting. */
const sentSeq = new Map<string, number>();

function pairKey(watcherId: string, targetId: string): string {
  return `${watcherId}→${targetId}`;
}

function seqOf(convId: string): number {
  return seqByConv.get(convId) ?? 0;
}

/** Record that `watcherId` just messaged `targetId` (send_message / create_conversation). */
export function noteMessageSent(watcherId: string, targetId: string): void {
  sentSeq.set(pairKey(watcherId, targetId), seqOf(targetId));
}

/** An event of `targetId` newer than `watcherId`'s last message to it — consumed, so a second
 *  wait does not return the same event again. `null` when there is none. */
export function takeEventSinceLastSend(watcherId: string, targetId: string): WatchEvent | null {
  const key = pairKey(watcherId, targetId);
  const since = sentSeq.get(key);
  if (since === undefined) return null;
  const last = lastEventByConv.get(targetId);
  if (!last || last.seq <= since) return null;
  sentSeq.delete(key);
  return last.event;
}

/** `watcherId` messaged `targetId` and no event has settled since: a wait has something to
 *  wait FOR, even while the target still reads as idle (its process is still spawning). */
export function hasUnsettledSend(watcherId: string, targetId: string): boolean {
  const since = sentSeq.get(pairKey(watcherId, targetId));
  return since !== undefined && seqOf(targetId) <= since;
}

export type WaitOutcome = { kind: "event"; event: WatchEvent } | { kind: "timeout" } | { kind: "cancelled"; why: string };

interface Waiter {
  watcherId: string;
  targetId: string;
  startedAt: number;
  resolve: (o: WaitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const waiters = new Set<Waiter>();

/** Mirror the live waits into the store, for the UI. */
function publishWaits(): void {
  useConversationWatchStore.setState({
    waits: [...waiters].map((w) => ({ watcherId: w.watcherId, targetId: w.targetId, startedAt: w.startedAt })),
  });
}

function settleWaiter(w: Waiter, outcome: WaitOutcome): void {
  if (!waiters.delete(w)) return;
  clearTimeout(w.timer);
  publishWaits();
  w.resolve(outcome);
}

/** Park until `targetId`'s next event, for at most `timeoutMs`. */
export function nextEvent(watcherId: string, targetId: string, timeoutMs: number): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    const w: Waiter = {
      watcherId,
      targetId,
      startedAt: Date.now(),
      resolve,
      timer: setTimeout(() => settleWaiter(w, { kind: "timeout" }), timeoutMs),
    };
    waiters.add(w);
    publishWaits();
  });
}

/** Answer every pending wait of `watcherId` at once — its turn ended (interrupted: the CLI no
 *  longer awaits the call), it was removed, or the feature was turned off. */
export function cancelWaitsOf(watcherId: string, why: string): void {
  for (const w of [...waiters]) if (w.watcherId === watcherId) settleWaiter(w, { kind: "cancelled", why });
}

/** Does `watcherId` have a wait in flight? (cheap guard for the per-state-event hook) */
export function isWaiting(watcherId: string): boolean {
  for (const w of waiters) if (w.watcherId === watcherId) return true;
  return false;
}

// ---- Pure helpers (exported for tests) ----------------------------------------

/** The loop-guard depth of the turn a conversation is on: the depth of the watch notification
 *  its LAST main-thread prompt was, 0 when that prompt was anything else (a human's message, an
 *  agent's send_message, a task notification). A notification injected into a running turn
 *  counts too — over-counting by one is the safe side of a loop guard. */
export function turnDepth(entry: SessionEntry | undefined): number {
  if (!entry) return 0;
  for (let i = entry.timeline.length - 1; i >= 0; i--) {
    const t = entry.timeline[i];
    if (t.kind !== "turn") continue;
    const turn = entry.turns[t.id];
    if (!turn || turn.role !== "user" || turn.parentToolUseId !== null) continue;
    return parseAgentMessage(turn.streamingText)?.watch?.depth ?? 0;
  }
  return 0;
}

function clipText(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

const END_LINES: Record<WatchEndReason, (title: string) => string> = {
  exited: (t) => `"${t}"'s process ended unexpectedly. Its next message restarts it.`,
  stopped: (t) => `"${t}" was stopped. Its next message restarts it.`,
  removed: (t) => `"${t}" was removed from the conversation list.`,
  replaced: (t) =>
    `Another client took "${t}" over: it may still be running on its server, but this Mac no longer ` +
    "follows it, so you will not hear when it settles.",
  detached: (t) => `This Mac let go of "${t}"'s live stream. It may still be running on its server.`,
  link_failed: (t) =>
    `This Mac lost its live link to "${t}". It may still be running on its server.`,
  attach_failed: (t) =>
    `"${t}"'s server could not rejoin its process: it ended there. Its next message restarts it.`,
  not_running: (t) =>
    `"${t}"'s process was no longer running on its server when this Mac came back. Its next message restarts it.`,
};

/** The body of a watch notification — what the watcher's model reads. */
export function notificationBody(
  event: WatchEvent,
  title: string,
  footer: "once" | "persistent" | "still" | "removed",
): string {
  const lines: string[] = [];
  switch (event.kind) {
    case "completed": {
      lines.push(
        event.outcome === "interrupted"
          ? `"${title}"'s turn was interrupted by the user before it finished.`
          : event.outcome === "error"
            ? `"${title}"'s turn ended in error${event.subtype ? ` (${event.subtype})` : ""}.`
            : event.outcome === "unknown"
              ? `"${title}" is no longer at work: it settled while this Mac was not following it, so how it ended is not known here.`
              : `"${title}" finished its turn.`,
      );
      if (event.openQuestion) lines.push("It ends on a question: it is waiting for an answer.");
      const last = event.lastAssistantText?.trim();
      if (last) lines.push("", "Its last reply:", quote(clipText(last, QUOTE_MAX)));
      lines.push("", `Read more with read_conversation (conversation_id: "${event.conversationId}").`);
      break;
    }
    case "needs_attention": {
      const what =
        event.reason === "question"
          ? "a question it asked"
          : `a permission request${event.tool ? ` (${event.tool})` : ""}`;
      lines.push(`"${title}" is blocked: it waits for the human to answer ${what}.`);
      const prompt = event.prompt?.trim();
      if (prompt) lines.push("", quote(clipText(prompt, PROMPT_MAX)));
      lines.push("", "It resumes only once the user answers it in Flight Deck.");
      break;
    }
    case "ended":
      lines.push(END_LINES[event.reason](title));
      break;
  }
  // (An `unknown` completion already says so in its first line.)
  if (event.whileAway && !(event.kind === "completed" && event.outcome === "unknown"))
    lines.push("", "(It happened while this Mac was not following it — learned only now.)");
  lines.push(
    "",
    footer === "once"
      ? "This was a one-time notification: call watch_conversation again to keep watching it."
      : footer === "persistent"
        ? "You are watching it until you call unwatch_conversation."
        : footer === "still"
          ? "You are still watching it, but you will only hear what it did once this Mac follows it again: " +
            "at the app's next launch, when the Mac wakes or comes back online, or as soon as its stream is " +
            "turned on here or it is sent a message. Tell the user if it matters now."
          : "You are no longer watching it.",
  );
  return lines.join("\n");
}

/** One event as the JSON a wait returns (and `detail` of the outcome). */
export function eventJson(event: WatchEvent): Record<string, unknown> {
  return event.whileAway ? { ...eventFields(event), while_away: true } : eventFields(event);
}

function eventFields(event: WatchEvent): Record<string, unknown> {
  switch (event.kind) {
    case "completed":
      return {
        outcome: "completed",
        turn_outcome: event.outcome,
        ...(event.subtype ? { subtype: event.subtype } : {}),
        open_question: event.openQuestion,
        last_assistant_text: event.lastAssistantText
          ? clipText(event.lastAssistantText, QUOTE_MAX)
          : null,
      };
    case "needs_attention":
      return {
        outcome: "needs_attention",
        reason: event.reason,
        ...(event.tool ? { tool: event.tool } : {}),
        prompt: event.prompt ? clipText(event.prompt, PROMPT_MAX) : null,
      };
    case "ended":
      return { outcome: "ended", reason: event.reason, may_still_run: mayStillRun(event.reason) };
  }
}

// ---- Dispatch -------------------------------------------------------------------

function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

function senderFor(convId: string): AgentMessageSender {
  const s = useConversationsStore.getState();
  const conv = s.conversations.find((c) => c.id === convId);
  const repo = conv ? s.repos.find((r) => r.id === conv.repoId) : undefined;
  return {
    conversationId: convId,
    title: conv?.name ?? removedTitles.get(convId) ?? "Untitled conversation",
    repo: repo ? baseName(repo.path) : null,
    backend: conv?.kind ?? "claude",
  };
}

/** Titles of conversations that just left the list — their `removed` event still names them. */
const removedTitles = new Map<string, string>();

function titleOf(convId: string): string {
  return senderFor(convId).title;
}

/** Deliver one notification to a watcher (a message — wakes it, or joins its running turn). */
async function deliver(watcherId: string, event: WatchEvent, depth: number, body: string): Promise<void> {
  const watched = senderFor(event.conversationId);
  const text = buildWatchNotificationEnvelope(watched, { event: event.kind, depth }, body);
  try {
    // Same order as send_message: hydrate a cold timeline BEFORE the send creates the entry.
    await loadConversationHistory(watcherId);
    const busy = useConversationStore.getState().sessions[watcherId]?.state.busy ?? false;
    await sendConversationMessage(watcherId, { text, queued: busy });
  } catch (e) {
    console.error("watch notification delivery failed:", e);
    pushInfoToast(
      `Couldn't tell "${titleOf(watcherId)}" that "${watched.title}" ${eventVerb(event)}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { sticky: true },
    );
  }
}

function eventVerb(event: WatchEvent): string {
  return event.kind === "completed"
    ? "finished its turn"
    : event.kind === "needs_attention"
      ? "needs attention"
      : "stopped";
}

/**
 * Publish one event of a conversation: answer the waits on it, then notify its watchers.
 *
 * A watcher whose WAIT this event just answered is not also sent a notification for it (its
 * tool call carries the event; a message on top would say it twice) — its 'once' subscription
 * is consumed all the same. A lost link keeps a 'once' subscription alive: this Mac re-follows
 * the conversation at its next resume pass, and the real outcome is still to come. Any other
 * ending (a takeover by another client included) ends it, and says so.
 */
export function publishWatchEvent(event: WatchEvent, depthOverride?: number): void {
  const target = event.conversationId;
  const seq = seqOf(target) + 1;
  seqByConv.set(target, seq);
  lastEventByConv.set(target, { seq, event });

  const answered = new Set<string>();
  for (const w of [...waiters]) {
    if (w.targetId !== target) continue;
    answered.add(w.watcherId);
    // The wait IS the answer to the caller's last message: nothing left unsettled.
    sentSeq.delete(pairKey(w.watcherId, target));
    settleWaiter(w, { kind: "event", event });
  }

  // This Mac letting go of a remote stream (the app quitting, a deliberate detach) tells a
  // watcher nothing about the watched work — and waking an agent for it would be noise.
  if (event.kind === "ended" && event.reason === "detached") return;
  // Ends every subscription on the target: it left the list, or another client owns it now.
  const terminal = event.kind === "ended" && (event.reason === "removed" || event.reason === "replaced");
  const keepsGoing = event.kind === "ended" && watchOutlives(event.reason);
  const consumed = (s: WatchSubscription) => terminal || (s.mode === "once" && !keepsGoing);
  const footerFor = (s: WatchSubscription): Footer => (terminal ? "removed" : keepsGoing ? "still" : s.mode);

  // A conversation taken over by another client can no longer act from this Mac: delivering it a
  // notification would re-attach it — taking it BACK from that client (never done on its own).
  // What it watched ends with it.
  if (event.kind === "ended" && event.reason === "replaced") dropWatchesOf(target);

  // The loop-guard depth: one more than the turn it reports on (read now — a removal drops the
  // session entry, so a caller that read it earlier passes it in).
  const depth = depthOverride ?? turnDepth(useConversationStore.getState().sessions[target]) + 1;

  // Watchers removed a moment ago (inside their ⌘Z grace window) are owed this event if they
  // come back: kept with their held subscriptions, delivered on restore.
  for (const pending of pendingRemovals.values()) {
    for (const s of pending.held.filter((h) => h.targetId === target)) {
      pending.missed.push({ event, footer: footerFor(s), depth });
      if (consumed(s)) pending.held = pending.held.filter((h) => h !== s);
    }
  }

  const subs = useConversationWatchStore.getState().subscriptions.filter((s) => s.targetId === target);
  if (subs.length === 0) return;
  const all = useConversationWatchStore.getState().subscriptions;
  if (subs.some(consumed)) setSubscriptions(all.filter((s) => !(s.targetId === target && consumed(s))));

  if (!agentWatchEnabled()) return;
  for (const s of subs) {
    if (answered.has(s.watcherId)) continue;
    notifyWatcher(s.watcherId, event, depth, footerFor(s));
  }
}

type Footer = "once" | "persistent" | "still" | "removed";

/** Deliver one event to one watcher — unless it is the target itself, gone, taken over by
 *  another client, or the chain of conversations waking each other is too deep. */
function notifyWatcher(watcherId: string, event: WatchEvent, depth: number, footer: Footer): void {
  const target = event.conversationId;
  if (watcherId === target) return;
  if (!useConversationsStore.getState().conversations.some((c) => c.id === watcherId)) return;
  const title = titleOf(target);
  if (remoteStreamMarks()[watcherId]?.replaced) {
    // Delivering would re-attach it and take it back from the other client: never on its own.
    dropWatchesOf(watcherId);
    pushInfoToast(
      `"${titleOf(watcherId)}" was watching "${title}", but another client took it over: it no longer ` +
        "gets notifications from this Mac, and its watches ended.",
      { sticky: true },
    );
    return;
  }
  if (depth > MAX_WATCH_DEPTH) {
    pushInfoToast(
      `Held back a notification to "${titleOf(watcherId)}" about "${title}": conversations kept waking ` +
        `each other (${MAX_WATCH_DEPTH} in a row). Message "${titleOf(watcherId)}" yourself to let it go on.`,
      { sticky: true },
    );
    return;
  }
  void deliver(watcherId, event, depth, notificationBody(event, title, footer));
}

/** Drop every subscription `watcherId` holds. */
function dropWatchesOf(watcherId: string): void {
  const all = useConversationWatchStore.getState().subscriptions;
  if (all.some((s) => s.watcherId === watcherId)) setSubscriptions(all.filter((s) => s.watcherId !== watcherId));
}

/** Answer the waits parked ON `targetId` (not BY it) — its turn was cut short by something its
 *  watchers are not told about (the app restarting it), so no event will ever answer them. */
function settleWaitsOn(targetId: string, why: string): void {
  for (const w of [...waiters]) if (w.targetId === targetId) settleWaiter(w, { kind: "cancelled", why });
}

const APP_STOP_WHY =
  "the conversation you waited for was stopped by the app (a restart, a rewind, an account switch…) — its turn was cut short";

// ---- Store-driven endings (stop / removal) + pref --------------------------------

/** Conversations whose `ended` state was already handled — the store diff below must not
 *  report the same ending a second time as "stopped" when the handle is then cleared. */
const reportedEnd = new Set<string>();

/**
 * The core reported the process ended (`ended` state): publish it with its reason. Called
 * BEFORE the handle is unbound, so the store diff knows it is already handled.
 *
 * ⚠️ The core emits `ended{stopped}` for EVERY stop this app runs, while the handle is still
 * bound — a restart, a rewind, an account switch included. Those are the app's own plumbing
 * (`isAppStopping` without a {@link noteUserStop}): watchers are not told and a 'once' watch is
 * kept for the real outcome; only waits parked on it are answered, its turn being cut short.
 */
export function publishSessionEnded(convId: string, reason: SessionEndReason | null): void {
  reportedEnd.add(convId);
  const byUser = userStops.delete(convId);
  // Only the ending the stop itself produces (`stopped`; Codex gives no reason) is plumbing: a
  // takeover, a crash or a lost link landing inside the stop's window is news all the same.
  if (!byUser && isAppStopping(convId) && (reason === "stopped" || reason === null)) {
    settleWaitsOn(convId, APP_STOP_WHY);
    return;
  }
  publishWatchEvent({ kind: "ended", conversationId: convId, reason: reason ?? "exited" });
}

/** Conversations the USER is stopping right now (the Stop button, the `stop_stream` tool): the
 *  only stop a watcher hears about. Every other one is the app's own plumbing — a restart, a
 *  rewind, a fork, an account switch, a removed worktree — after which the conversation carries
 *  on, so announcing it "stopped" would wake watchers for nothing and use up the 'once' watch
 *  its real outcome was owed to. */
const userStops = new Set<string>();

/** Mark the coming stop of `convId` as the user's own (call BEFORE `stopConversationSession`). */
export function noteUserStop(convId: string): void {
  userStops.add(convId);
}

/** How long a removal waits before it is final for watchers: ⌘Z within it restores the
 *  conversation as it was, its watches included, and nobody is woken for nothing. */
export const REMOVAL_GRACE_MS = 10_000;

interface PendingRemoval {
  /** The subscriptions the removed conversation HELD as a watcher — restored by ⌘Z. */
  held: WatchSubscription[];
  /** Events on its targets that landed while it was gone — delivered if it comes back, at the
   *  loop-guard depth they had when they happened. */
  missed: Array<{ event: WatchEvent; footer: Footer; depth: number }>;
  /** It had a process at work when removed (the removal killed that turn), and the loop-guard
   *  depth of that turn — read then: the removal drops its session entry. */
  wasAtWork: boolean;
  workDepth: number;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRemovals = new Map<string, PendingRemoval>();

function finalizeRemoval(convId: string): void {
  pendingRemovals.delete(convId);
  publishWatchEvent({ kind: "ended", conversationId: convId, reason: "removed" });
  reportedEnd.delete(convId);
  removedTitles.delete(convId);
}

/** ⌘Z inside the grace window: its watches come back, the events it missed meanwhile are
 *  delivered, and — if the removal killed a turn at work — its watchers hear it was stopped. */
function restoreRemoval(convId: string, pending: PendingRemoval): void {
  clearTimeout(pending.timer);
  pendingRemovals.delete(convId);
  removedTitles.delete(convId);
  reportedEnd.delete(convId);
  if (!agentWatchEnabled()) return;
  const known = new Set(useConversationsStore.getState().conversations.map((c) => c.id));
  // A target that left the list for good meanwhile is not watched again (its `removed` is in
  // `missed` if it landed while this one was held).
  const alive = pending.held.filter((s) => known.has(s.targetId) || pendingRemovals.has(s.targetId));
  if (alive.length) setSubscriptions([...useConversationWatchStore.getState().subscriptions, ...alive]);
  for (const m of pending.missed) notifyWatcher(convId, m.event, m.depth, m.footer);
  if (pending.wasAtWork) {
    // Its session entry went with the removal: the depth is the one read when it was removed.
    publishWatchEvent({ kind: "ended", conversationId: convId, reason: "stopped" }, pending.workDepth + 1);
  }
}

/** Was this conversation at work (a turn in flight, a prompt up) a moment ago? */
function atWork(convId: string): boolean {
  const st = useConversationStore.getState().sessions[convId]?.state;
  return !!st && (st.busy || st.awaiting_permission);
}

/** Subscriptions persisted across a restart whose watcher or target is no longer listed (removed
 *  inside a grace window the app quit during, or while it was closed): the watchers still here
 *  are told their target was removed; the rest are dropped. Run once, on the first load. */
export function pruneOrphans(known: Set<string>): void {
  const subs = useConversationWatchStore.getState().subscriptions;
  if (subs.every((s) => known.has(s.watcherId) && known.has(s.targetId))) return;
  const goneTargets = new Set(
    subs.filter((s) => known.has(s.watcherId) && !known.has(s.targetId)).map((s) => s.targetId),
  );
  setSubscriptions(subs.filter((s) => known.has(s.watcherId)));
  for (const t of goneTargets) publishWatchEvent({ kind: "ended", conversationId: t, reason: "removed" });
}

let installed = false;

/**
 * Wire the endings the settled-transition point never sees, by diffing the conversations
 * store. A conversation that LEFT the list is removed — final for its watchers only after
 * {@link REMOVAL_GRACE_MS}, so a ⌘Z inside it restores everything. A live handle that went to
 * null without an `ended` state is reported only when the USER stopped it ({@link noteUserStop}).
 * Either way the conversation's OWN waits end at once: its tool call died with the process. On
 * the first load, prunes subscriptions persisted for conversations that are gone. Also empties
 * everything when the feature is turned off. Idempotent.
 */
export function installConversationWatch(): void {
  if (installed) return;
  installed = true;
  // Only once the persisted conversations are REALLY loaded: a failed load leaves the list empty
  // (and the first conversation created afterwards would read as the whole list).
  onConversationsBooted(() =>
    pruneOrphans(new Set(useConversationsStore.getState().conversations.map((c) => c.id))),
  );
  useConversationsStore.subscribe((s, prev) => {
    if (s.conversations === prev.conversations) return;
    const now = new Map(s.conversations.map((c) => [c.id, c]));
    for (const old of prev.conversations) {
      const cur = now.get(old.id);
      if (!cur) {
        removedTitles.set(old.id, old.name);
        cancelWaitsOf(old.id, "the waiting conversation was removed");
        userStops.delete(old.id);
        const all = useConversationWatchStore.getState().subscriptions;
        const held = all.filter((x) => x.watcherId === old.id);
        if (held.length) setSubscriptions(all.filter((x) => x.watcherId !== old.id));
        if (!pendingRemovals.has(old.id))
          pendingRemovals.set(old.id, {
            held,
            missed: [],
            wasAtWork: !!old.handle && atWork(old.id),
            workDepth: turnDepth(useConversationStore.getState().sessions[old.id]),
            timer: setTimeout(() => finalizeRemoval(old.id), REMOVAL_GRACE_MS),
          });
        continue;
      }
      if (old.handle && !cur.handle) {
        cancelWaitsOf(old.id, "the waiting conversation was stopped");
        const byUser = userStops.delete(old.id);
        if (reportedEnd.delete(old.id)) continue;
        if (!byUser) {
          // The app's own stop: quiet for watchers, but a wait on it can no longer be answered.
          settleWaitsOn(old.id, APP_STOP_WHY);
          continue;
        }
        publishWatchEvent({ kind: "ended", conversationId: old.id, reason: "stopped" });
      }
    }
    // Back inside its grace window (⌘Z).
    for (const [id, pending] of [...pendingRemovals]) if (now.has(id)) restoreRemoval(id, pending);
  });
  useAppControlPrefs.subscribe((s, prev) => {
    if (s.agentWatch || !prev.agentWatch) return;
    setSubscriptions([]);
    for (const p of pendingRemovals.values()) {
      p.held = [];
      p.missed = [];
    }
    for (const w of [...waiters]) settleWaiter(w, { kind: "cancelled", why: "disabled" });
  });
}

/** Test seam: forget every in-memory sequence, wait and subscription. */
export function resetConversationWatchForTests(): void {
  for (const w of [...waiters]) settleWaiter(w, { kind: "cancelled", why: "reset" });
  seqByConv.clear();
  lastEventByConv.clear();
  sentSeq.clear();
  reportedEnd.clear();
  removedTitles.clear();
  userStops.clear();
  for (const p of pendingRemovals.values()) clearTimeout(p.timer);
  pendingRemovals.clear();
  setSubscriptions([]);
}
