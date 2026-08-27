// Fleet events → spoken announcements: the queue and the line builder.
//
// Pure and framework-free so the formatting is unit-testable. The producer is
// the SAME settled notification point that feeds OS notifications and the
// voice-bridge journal (`fireAgentNotification` in useGlobalSessionEvents.ts):
// the voice agent announces exactly what would have pinged the human — after
// the settle window, minus no-op turns, minus interrupted turns. The consumer
// (VoiceHost) drains one announcement at a time so the agent never talks over
// itself.

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
 * the SPOKEN text — the agent rephrases it (its instructions ask for one or
 * two spoken sentences) — so this stays structured and complete rather than
 * pretty.
 */
export function announcementText(a: FleetAnnouncement): string {
  const where = a.repository ? ` (repo ${a.repository})` : "";
  if (a.kind === "needs_attention") {
    const what =
      a.reason === "permission"
        ? `is blocked on a permission prompt${a.tool ? ` for the ${a.tool} tool` : ""}`
        : "asked a question and is waiting for an answer";
    const detail = a.prompt ? `\nPrompt: ${a.prompt}` : "";
    return `[Flight Deck event] The conversation "${a.title}"${where} ${what}.${detail}\nTell the user briefly and ask what to answer. conversation_id: ${a.conversationId}`;
  }
  const how = a.outcome === "error" ? "finished its turn WITH AN ERROR" : "finished its turn";
  const detail = a.lastAssistantText ? `\nIts last reply: ${a.lastAssistantText}` : "";
  return `[Flight Deck event] The conversation "${a.title}"${where} ${how}.${detail}\nSummarize that to the user in one or two spoken sentences and ask if they want to reply. conversation_id: ${a.conversationId}`;
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
