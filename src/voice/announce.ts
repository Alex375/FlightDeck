// Fleet events → spoken announcements: the queue and the line builder.
//
// Pure and framework-free so the formatting is unit-testable. The producer is
// the SAME settled notification point that feeds OS notifications and the
// voice-bridge journal (`fireAgentNotification` in useGlobalSessionEvents.ts):
// the voice agent announces exactly what would have pinged the human — after
// the settle window, minus no-op turns, minus interrupted turns. The consumer
// (VoiceHost) drains one announcement at a time so the agent never talks over
// itself.

import type { JsonValue, PermissionRequestPayload } from "../ipc/client";
import { parseQuestions } from "../features/conversation/questionnaire";

/** A pending request reduced to what the attention surfaces read from it. */
type PendingLike = Pick<PermissionRequestPayload, "tool_name" | "input" | "title" | "description">;

/** Is this pending request a QUESTION to the user (the AskUserQuestion tool)
 *  rather than a permission prompt? A question does not gate a tool run — it
 *  collects the user's choice — so it must NEVER be announced as "asks
 *  permission" (the bug this guards: an AskUserQuestion is itself a pending
 *  `can_use_tool`, so a naive "is there a pending permission?" reads it as one). */
export function pendingIsQuestion(pending: Pick<PendingLike, "tool_name"> | null | undefined): boolean {
  return pending?.tool_name === "AskUserQuestion";
}

/** The attention fields shared by the OS ping, the voice-bridge journal and the
 *  spoken announcement, derived from the conversation's first pending request.
 *  An AskUserQuestion (or nothing pending — a settled open question) is a
 *  QUESTION: reason "question", no `tool`, and `prompt` carries the question
 *  text so the line can read it. Any other pending tool is a permission prompt. */
export function attentionFields(pending: PendingLike | null | undefined): {
  reason: "permission" | "question";
  tool: string | null;
  prompt: string | null;
} {
  if (!pending || pendingIsQuestion(pending)) {
    return { reason: "question", tool: null, prompt: questionPromptText(pending) };
  }
  return {
    reason: "permission",
    tool: pending.tool_name,
    prompt: pending.title ?? pending.description ?? null,
  };
}

/** The text to read for a question: the question(s) from the tool input, else
 *  the CLI-provided title/description. */
function questionPromptText(pending: PendingLike | null | undefined): string | null {
  if (!pending) return null;
  const qs = parseQuestions(pending.input as JsonValue);
  if (qs.length) return qs.map((q) => q.question).join(" / ");
  return pending.title ?? pending.description ?? null;
}

export interface FleetAnnouncement {
  kind: "turn_completed" | "needs_attention";
  conversationId: string;
  title: string;
  /** For turn_completed: the outcome + last assistant text (clipped upstream). */
  outcome?: "success" | "error";
  lastAssistantText?: string | null;
  /** For needs_attention: what blocks (permission tool / question). */
  reason?: "permission" | "question";
  tool?: string | null;
  prompt?: string | null;
  repository?: string | null;
}

/**
 * The line handed to the Realtime session as a user-role event message. Not
 * the SPOKEN text — the agent rephrases it, telegraphically (see
 * instructions.ts) — so this stays structured and complete rather than pretty.
 * The closing directive repeats the no-filler rule on purpose: the event line is
 * the last thing in the context before the agent speaks, and that is exactly
 * where a padded "c'est bon, je reviens vers toi" used to creep back in.
 */
export function announcementText(a: FleetAnnouncement): string {
  const where = a.repository ? ` (repo ${a.repository})` : "";
  if (a.kind === "needs_attention") {
    if (a.reason === "question") {
      // A QUESTION, not a permission prompt: read it. Never say "asks
      // permission" (the old classification bug). get_pending_request returns the
      // exact options; answer_request settles it (a dictated answer is accepted
      // as the "Other" choice) — never send_message, which only queues behind the
      // open question.
      const detail = a.prompt ? `\nQuestion: ${a.prompt}` : "";
      return `[Flight Deck event] The conversation "${a.title}"${where} asked the user a question and is waiting for an answer.${detail}\nThis is a QUESTION, NOT a permission prompt — do not say it asks permission. Read the question in ONE sentence and let the user answer; get_pending_request has the exact options. No preamble, no filler. conversation_id: ${a.conversationId}`;
    }
    const detail = a.prompt ? `\nPrompt: ${a.prompt}` : "";
    return `[Flight Deck event] The conversation "${a.title}"${where} is blocked on a permission prompt${a.tool ? ` for the ${a.tool} tool` : ""}.${detail}\nSay what it is blocked on in ONE sentence, then the question it needs answered. No preamble, no filler. conversation_id: ${a.conversationId}`;
  }
  const how = a.outcome === "error" ? "finished its turn WITH AN ERROR" : "finished its turn";
  const detail = a.lastAssistantText ? `\nIts last reply: ${a.lastAssistantText}` : "";
  return `[Flight Deck event] The conversation "${a.title}"${where} ${how}.${detail}\nSay it finished, then the substance of its reply in ONE sentence, then ask what to answer. No preamble, no filler, no "I'll get back to you". conversation_id: ${a.conversationId}`;
}

// ---- The queue --------------------------------------------------------------

type Listener = () => void;

const queue: FleetAnnouncement[] = [];
const listeners = new Set<Listener>();

/** Cap: if the user was away while many turns finished, speaking the backlog
 *  one by one would monologue for minutes — keep the freshest few. */
const MAX_QUEUE = 5;

/** Enqueue an announcement (producer: the notification router). The GATING
 *  (prefs + key configured) happens at the producer so a disabled feature
 *  costs nothing here. */
export function queueVoiceAnnouncement(a: FleetAnnouncement): void {
  queue.push(a);
  while (queue.length > MAX_QUEUE) queue.shift();
  listeners.forEach((l) => l());
}

/** Take the next announcement, or null. Consumer: VoiceHost's drain loop. */
export function nextVoiceAnnouncement(): FleetAnnouncement | null {
  return queue.shift() ?? null;
}

export function pendingVoiceAnnouncements(): number {
  return queue.length;
}

/** Subscribe to "something was queued". Returns the unsubscribe. */
export function onVoiceAnnouncement(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test/reset hook. */
export function clearVoiceAnnouncements(): void {
  queue.length = 0;
}
