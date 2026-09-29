// The conversations this one has exchanged with — the data behind the side panel's "Linked
// conversations" widget. A PURE derivation from the conversation's OWN entry: both directions
// of an agent-to-agent exchange leave a durable trace in the thread that made or received it,
// so nothing is fetched, persisted or polled, and the list survives a reload for free.
//
//  - RECEIVED: a user turn whose text is a `<flightdeck-message>` envelope (see agentMessage.ts)
//    — it names the sender by its stable id, with title/repo snapshots and the message id.
//  - SENT / CREATED: a main-thread `send_message` / `create_conversation` tool_use, joined to its
//    tool_result (the executor's JSON: the recipient's id and the message id it minted).
//
// Grouped per partner, newest exchange first. ⚠️ No timestamps: neither side carries one after a
// reload (tool clocks are live-only), so the ORDER is the timeline's and no time is shown.

import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { useConversationStore } from "../../store/conversationStore";
import type { JumpAnchor } from "../../store/threadJump";
import type { SessionEntry } from "../../store/types";
import {
  CREATE_CONVERSATION_TOOL,
  SEND_MESSAGE_TOOL,
  parseAgentMessage,
  parseSendMessageResult,
} from "./agentMessage";

/** One conversation this one exchanged with, and how. */
export interface LinkedConversation {
  /** The partner's stable conversation id. */
  partnerId: string;
  /** Messages this conversation sent it — `send_message` calls that were not refused, plus the
   *  first message of a conversation it created. Counts a call still awaiting its result (see
   *  {@link unconfirmed}): the agent did send it. */
  sent: number;
  /** Of {@link sent}: calls with no result — in flight, or the session ended before the tool
   *  answered (a truncated transcript). Not proof of delivery, so the widget says so. */
  unconfirmed: number;
  /** Messages it sent this conversation (envelopes that arrived here). */
  received: number;
  /** This conversation created it (`create_conversation`). */
  created: boolean;
  /** Sends to it that were refused (`is_error`: a permission denial, an unknown id…). Never
   *  counted in {@link sent} — nothing crossed. */
  failed: number;
  /** The newest refusal's reason, clipped — what the "!" explains. */
  failureReason: string | null;
  /** Newest name snapshot we hold — the envelope's `<from>`, or the title/folder a creation was
   *  given. `null` for a partner only ever SENT to: a send records no recipient name. The LIVE
   *  name (by id) wins while the partner still exists. */
  snapshotTitle: string | null;
  /** Newest repo snapshot (envelope's `<from-repo>`, or the created conversation's folder). */
  snapshotRepo: string | null;
  /** Where to land in the PARTNER's thread: its card for the newest exchange that reached it —
   *  the arrival of our newest delivered message (`received`), or its send card for the newest
   *  message it sent us (`sent`). `null` when no exchange carries a message id (a creation
   *  with no first message): the conversation just opens. */
  remoteAnchor: JumpAnchor | null;
  /** Where the newest exchange sits in THIS thread: our messaging card by its tool_use id
   *  (`sentTool`, refused or not), or the arrival card by message id (`received`). */
  localAnchor: JumpAnchor | null;
  /** Position of the newest exchange in the timeline walk — the sort key (newest first). */
  lastOrder: number;
}

/** Longest refusal reason kept for the tooltip. */
const REASON_MAX = 160;

const EMPTY_LINKED: LinkedConversation[] = [];

/** A folder's last segment, trailing slashes ignored. ⚠️ Deliberately NOT conversationRef's
 *  `repoLabel`: that module pulls in hooks and both conversation stores, and conversationsStore
 *  imports THIS module (for the cache clears) — importing it back would close a cycle. */
function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A partner's running aggregate while the timeline is walked. */
type Acc = LinkedConversation;

function accFor(map: Map<string, Acc>, partnerId: string): Acc {
  let acc = map.get(partnerId);
  if (!acc) {
    acc = {
      partnerId,
      sent: 0,
      unconfirmed: 0,
      received: 0,
      created: false,
      failed: 0,
      failureReason: null,
      snapshotTitle: null,
      snapshotRepo: null,
      remoteAnchor: null,
      localAnchor: null,
      lastOrder: -1,
    };
    map.set(partnerId, acc);
  }
  return acc;
}

/**
 * Pure: every conversation `entry`'s thread exchanged with, grouped per partner, newest first.
 *
 *  - MAIN THREAD ONLY (`parentToolUseId === null`), like `selectArtifacts`: a sub-agent's send is
 *    replayed live but SKIPPED on reload (history.rs skips sidechain lines), so counting it would
 *    make the widget change on reload.
 *  - A REFUSED send is counted in `failed`, never in `sent`; a partner with nothing BUT refusals
 *    is left out — nothing was exchanged, and the thread's own card already shows the refusal
 *    with its reason (typically an id the model got wrong, which names no conversation at all).
 *  - A creation is only known once its result names the new conversation; a refused or
 *    result-less `create_conversation` has no partner and is skipped.
 *  - `selfId` is never listed (a fork inherits its parent's thread, whose exchanges may name it).
 *
 * The received-side gate is `parseAgentMessage`'s strict "text OPENS on the tag" — never a
 * hand-rolled regex — and results are JSON-parsed only for messaging calls.
 */
export function selectLinkedConversations(
  entry: SessionEntry | undefined,
  selfId: string | null = null,
): LinkedConversation[] {
  if (!entry) return EMPTY_LINKED;
  const byPartner = new Map<string, Acc>();
  let order = 0;
  for (const t of entry.timeline) {
    if (t.kind !== "turn") continue;
    const turn = entry.turns[t.id];
    if (!turn || turn.parentToolUseId !== null) continue;

    if (turn.role === "user") {
      const msg = parseAgentMessage(turn.streamingText);
      const from = msg?.fromConversationId;
      if (!msg || !from || from === selfId) continue;
      const acc = accFor(byPartner, from);
      acc.received += 1;
      acc.lastOrder = order++;
      if (msg.fromTitle) acc.snapshotTitle = msg.fromTitle;
      if (msg.fromRepo) acc.snapshotRepo = msg.fromRepo;
      if (msg.messageId) {
        acc.remoteAnchor = { kind: "sent", messageId: msg.messageId };
        acc.localAnchor = { kind: "received", messageId: msg.messageId };
      }
      continue;
    }

    if (turn.role !== "assistant") continue;
    for (const b of turn.blocks) {
      if (b.type !== "tool_use") continue;
      const isSend = b.name === SEND_MESSAGE_TOOL;
      if (!isSend && b.name !== CREATE_CONVERSATION_TOOL) continue;
      const result = entry.toolResults[b.id];
      const refused = !!result?.isError;
      const outcome = result && !refused ? parseSendMessageResult(result.content) : null;

      if (isSend) {
        // The result names the recipient it actually resolved; the input is the fallback (a
        // refused or result-less call has nothing else).
        const partnerId = outcome?.conversationId ?? field(b.input, "conversation_id") ?? null;
        if (!partnerId || partnerId === selfId) continue;
        const acc = accFor(byPartner, partnerId);
        acc.lastOrder = order++;
        acc.localAnchor = { kind: "sentTool", toolUseId: b.id };
        if (refused) {
          acc.failed += 1;
          acc.failureReason = clip(resultText(result?.content), REASON_MAX) || null;
          continue;
        }
        acc.sent += 1;
        if (!result) acc.unconfirmed += 1;
        if (outcome?.messageId) acc.remoteAnchor = { kind: "received", messageId: outcome.messageId };
        continue;
      }

      // create_conversation: the new conversation's id only exists in the result.
      const partnerId = outcome?.conversationId ?? null;
      if (!partnerId || partnerId === selfId) continue;
      const acc = accFor(byPartner, partnerId);
      acc.created = true;
      acc.lastOrder = order++;
      acc.localAnchor = { kind: "sentTool", toolUseId: b.id };
      const repoPath = field(b.input, "repo_path")?.trim() ?? "";
      const title = field(b.input, "title")?.trim() || (repoPath ? basename(repoPath) : "");
      if (title) acc.snapshotTitle = title;
      if (repoPath) acc.snapshotRepo = basename(repoPath);
      // Its first message is a message like any other: the child counts it as received.
      if ((field(b.input, "first_message") ?? "").trim()) acc.sent += 1;
      if (outcome?.messageId) acc.remoteAnchor = { kind: "received", messageId: outcome.messageId };
    }
  }
  if (byPartner.size === 0) return EMPTY_LINKED;
  const out = [...byPartner.values()]
    .filter((l) => l.sent > 0 || l.received > 0 || l.created)
    .sort((a, b) => b.lastOrder - a.lastOrder);
  return out.length === 0 ? EMPTY_LINKED : out;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pure: the exchange in words — what the row's compact figures stand for, for its tooltip and
 *  its accessible label. Only what the thread holds; nothing when the count is zero. */
export function linkSummary(l: LinkedConversation): string {
  const parts: string[] = [];
  if (l.created) parts.push("Created by this conversation");
  if (l.sent > 0) {
    parts.push(
      plural(l.sent, "message sent", "messages sent") +
        (l.unconfirmed > 0 ? ` (${l.unconfirmed} not confirmed)` : ""),
    );
  }
  if (l.received > 0) parts.push(plural(l.received, "message received", "messages received"));
  return parts.join(" · ");
}

/** Pure: what the red "!" explains — how many sends were refused and the latest reason.
 *  `null` when none was. */
export function failureNote(l: LinkedConversation): string | null {
  if (l.failed === 0) return null;
  const head =
    l.failed === 1 ? "1 message to it was refused" : `${l.failed} messages to it were refused`;
  if (!l.failureReason) return `${head}.`;
  return l.failed === 1 ? `${head}: ${l.failureReason}` : `${head}. Latest: ${l.failureReason}`;
}

/** Content signature, so {@link memoizedLinked} hands back the SAME array while nothing a
 *  surface reads has changed (an unrelated tool call is frequent). ⚠️ It must cover EVERY field
 *  of {@link LinkedConversation}, or a change would be swallowed by the previous array — hence
 *  the whole list serialised rather than a hand-picked field list a new field could miss. Stable
 *  because `accFor` builds every entry with the same key order; cheap because the list is a
 *  handful of small records. */
function linkedSig(list: LinkedConversation[]): string {
  return JSON.stringify(list);
}

const cache = new Map<
  string,
  {
    timeline: SessionEntry["timeline"];
    toolResults: SessionEntry["toolResults"];
    toolStartedAt: SessionEntry["toolStartedAt"];
    sig: string;
    result: LinkedConversation[];
  }
>();

/**
 * `selectLinkedConversations` memoised per conversation on THREE references:
 *  - `timeline`: a received envelope is a new user turn (set once, never streamed);
 *  - `toolResults`: a send's delivery, and a creation's new conversation id, arrive as results;
 *  - `toolStartedAt`: ⚠️ an assistant turn's tool_use blocks are appended WITHOUT touching
 *    `timeline`, so a send whose result has not landed yet would stay invisible until the next
 *    timeline push. This map gains a key once per live tool_use — never per streamed token.
 * Per-token streaming replaces `turns` only, so it always takes the fast path. Ref-stable across
 * unrelated recomputes through the content signature. Pure (module-singleton cache).
 */
export function memoizedLinked(
  convId: string,
  entry: SessionEntry | undefined,
): LinkedConversation[] {
  if (!entry) return EMPTY_LINKED;
  const cached = cache.get(convId);
  if (
    cached &&
    cached.timeline === entry.timeline &&
    cached.toolResults === entry.toolResults &&
    cached.toolStartedAt === entry.toolStartedAt
  ) {
    return cached.result;
  }
  const result = selectLinkedConversations(entry, convId);
  const sig = linkedSig(result);
  const keep = cached && cached.sig === sig ? cached.result : result;
  cache.set(convId, {
    timeline: entry.timeline,
    toolResults: entry.toolResults,
    toolStartedAt: entry.toolStartedAt,
    sig,
    result: keep,
  });
  return keep;
}

/**
 * Forget one conversation's memoised links. MUST be called on every conversation-removal path
 * (next to `clearArtifactsCache`): the entry pins the conversation's whole `timeline` and
 * `toolResults` (full tool output, base64 images included) for the rest of the run, and a stale
 * entry under a reused id would hand another conversation's links back.
 */
export function clearLinkedCache(convId: string): void {
  cache.delete(convId);
}

/** Forget EVERY conversation's memoised links (wipe-all). */
export function clearAllLinkedCache(): void {
  cache.clear();
}

/** The conversations `convId` exchanged with, newest first; empty when none. Ref-stable while
 *  unchanged. Call it only where the list is shown (the widget, mounted only when switched on):
 *  it subscribes to the message store. */
export function useLinkedConversations(convId: string): LinkedConversation[] {
  return useConversationStore((s) => memoizedLinked(convId, s.sessions[convId]));
}
