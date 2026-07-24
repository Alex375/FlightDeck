// The conversation store: a dumb reducer that applies pre-normalized events from
// the Rust core and reconciles them by id. The UI never reconstructs anything —
// it reads slices via fine-grained selectors so only affected turns re-render.
//
// Reconciliation rules (see the protocol):
//  - message_started opens a streaming Turn (blocks=[]) and an openBubble pointer.
//  - text_delta / thinking_delta append to the matching buffer (ignored once final).
//  - assistant_message carries ONE finalized content block of a message; Claude
//    sends a message's blocks as several same-id events (thinking, then text, then
//    tool_use). We APPEND its blocks to the turn and clear the live buffers — never
//    replace — so an earlier block (e.g. the text between two tools) is not wiped
//    by a later one. The turn stays "streaming" until turn_result. Mirrors
//    history.rs, which merges same-id transcript lines on resume.
//  - tool_result is joined to its tool_use lazily by tool_use_id.
//  - turn_result finalizes open bubbles and renders a footer — NEVER a new bubble.
//  - sub-agent (Task) turns carry parent_tool_use_id and are scoped to a sub-thread,
//    never leaking into the root timeline.
//  - all collections dedupe by id / tool_use_id (Tauri delivery is at-least-once).

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  ConversationItem,
  JsonValue,
  PermissionRequestPayload,
  SessionStatePayload,
} from "../ipc/client";
import type {
  ErrorItem,
  NoticeItem,
  NormalizedBlock,
  RoundMarker,
  SessionEntry,
  TimelineEntry,
  TodoItem,
  TodoSummary,
  ToolResult,
  Turn,
  TurnResultMeta,
  UserTurnImage,
} from "./types";
import { isBackgroundAgentInput, isDetachedAgentAck } from "../agent/subagentMeta";
import { latestTodosInBlocks, todoSummary } from "./todos";
import { THINKING_ACCRUAL_CAP_MS } from "./thinkingWords";
import { parseSpecialMessage } from "../features/conversation/specialMessage";

const connectingState: SessionStatePayload = {
  busy: false,
  session_id: null,
  cwd: null,
  model: null,
  permission_mode: null,
  effort: null,
  ultracode: false,
  activity: null,
  awaiting_permission: false,
  ended: false,
  context_tokens: null,
  context_window: null,
  rate_limit: null,
};

function emptyEntry(session: string): SessionEntry {
  return {
    session,
    state: { ...connectingState },
    timeline: [],
    turns: {},
    notices: {},
    errors: {},
    turnResults: {},
    toolResults: {},
    pendingPermissions: [],
    openBubble: {},
    subThreads: {},
    bgAgentIds: [],
    todos: [],
    // No finished turn yet → nothing to review (an idle, never-run session reads
    // as idle/off, not "ready for review").
    turnSeen: true,
    seq: 0,
    replayAnchor: 0,
    turnStartedAt: null,
    turnCount: 0,
    thinkingMs: 0,
    thinkingSince: null,
    thinkingStartedAt: null,
    thinkingDurations: {},
    toolStartedAt: {},
    toolDurations: {},
  };
}

const rootKey = (parentToolUseId: string | null) => parentToolUseId ?? "root";

/** tool_use ids of `Agent`/`Task` blocks launched detached (`run_in_background`). */
function backgroundAgentIdsIn(blocks: NormalizedBlock[]): string[] {
  const ids: string[] = [];
  for (const b of blocks) {
    if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && isBackgroundAgentInput(b.input)) {
      ids.push(b.id);
    }
  }
  return ids;
}

/**
 * Is `toolUseId` a DETACHED sub-agent that should join `bgAgentIds` because of its launch
 * ACK, even though its live `tool_use` block lacked `run_in_background`? Gated on the cheap
 * ack check first; only then confirms the spawning block is an `Agent`/`Task` (bgAgentIds is
 * Agent-only — Bash-bg/Monitor/Workflow have their own bars/cards). Folding an id here HIDES
 * its inline card, so we FAIL SAFE: if the block isn't found (result before its
 * assistant_message — which the stream-json ordering makes essentially impossible), we do
 * NOT fold — never hide a tool_use we can't positively confirm is a detached Agent. */
function isDetachedAgentByAck(entry: SessionEntry, toolUseId: string, content: JsonValue): boolean {
  if (!isDetachedAgentAck(content)) return false;
  for (const tid in entry.turns) {
    for (const b of entry.turns[tid].blocks) {
      if (b.type === "tool_use" && b.id === toolUseId) {
        return b.name === "Agent" || b.name === "Task";
      }
    }
  }
  return false; // block not found → don't fold (fail safe: never hide an unconfirmed tool_use)
}

function hasTimelineId(timeline: TimelineEntry[], id: string): boolean {
  return timeline.some((e) => e.id === id);
}

/** Clear the "en attente" badge on any queued user turns. Cheap to call on every
 *  boundary: bails out with zero allocation when nothing is waiting (the common
 *  case), then rebuilds only the entries that change. */
function clearQueuedBadges(entry: SessionEntry): SessionEntry {
  if (!Object.values(entry.turns).some((t) => t.queued)) return entry;
  const turns = { ...entry.turns };
  for (const [id, t] of Object.entries(turns)) {
    if (t.queued) turns[id] = { ...t, queued: false };
  }
  return { ...entry, turns };
}

interface ConversationState {
  sessions: Record<string, SessionEntry>;
  ensureSession: (session: string) => void;
  applyState: (session: string, state: SessionStatePayload) => void;
  /** Seed the context meter (tokens/window) from the on-disk transcript on open or
   *  stream-(re)start, so the ring shows the real fill BEFORE the first live turn.
   *  Only fills a field that's still null — never clobbers a fresher live value. */
  applyContextFill: (
    session: string,
    fill: { context_tokens: number | null; context_window: number | null },
  ) => void;
  /** Reset a session's live state to neutral (idle, not busy/ended) WITHOUT
   *  touching its timeline. Used when the stream is turned off: the terminal
   *  `ended` event is routed by the now-stale handle and gets dropped, so the
   *  last live state (e.g. busy=true) would otherwise linger and block the
   *  composer. Clears it so the conversation reads as off/idle (a send re-spawns). */
  clearState: (session: string) => void;
  /** Accrue the "Thinking…" spinner clock: `isGeneric` = the session is busy AND in the generic
   *  thinking state right now. Opens a spell (stamps `thinkingSince`) on enter, seals it into
   *  `thinkingMs` on leave; a no-op (same entry ref → no re-render) between transitions. Driven by
   *  a single global ticker so it accrues even for conversations not currently rendered. */
  accrueThinking: (session: string, isGeneric: boolean, now: number) => void;
  /** Apply one normalized item. `hydrating` marks a call that REPLAYS on-disk
   *  history (the `loadConversationHistory`/`reloadConversationHistory` loops) as
   *  opposed to a live stream event: it suppresses the wall-clock timing stamps
   *  (tool start / freeze, thinking freeze), which measure real elapsed time and
   *  would otherwise record a bogus ~0ms for every replayed tool. Live calls omit
   *  it (default false). */
  applyItem: (session: string, item: ConversationItem, hydrating?: boolean) => void;
  appendText: (session: string, messageId: string, text: string) => void;
  appendThinking: (session: string, messageId: string, text: string) => void;
  /** Append an optimistic user turn. `queued` marks it as sent mid-turn (the CLI
   *  injects it before the loop ends) → drives the "en attente" badge. */
  addUserTurn: (session: string, text: string, queued?: boolean, images?: UserTurnImage[]) => void;
  /** Append a visible error bubble to the timeline (e.g. a send that failed to
   *  spawn the session). Makes an otherwise-silent command failure self-evident.
   *  `detail` (optional) is the raw technical payload, shown behind a disclosure. */
  addErrorTurn: (session: string, message: string, detail?: string | null) => void;
  enqueuePermission: (session: string, request: PermissionRequestPayload) => void;
  removePermission: (session: string, requestId: string) => void;
  /** Acknowledge the last finished turn ("Vu" button): mark it seen so the
   *  conversation drops from review / open-question back to idle. */
  markSeen: (session: string) => void;
  resetSession: (session: string) => void;
  /**
   * Re-arm the remote-replay insert anchor to the END of the timeline. Called after a
   * history hydration (which appends chronologically but never fires a `turn_result`,
   * so the anchor would otherwise stay at 0) so the FIRST live remote turn splices at
   * the end of the restored history, not above it. See `SessionEntry.replayAnchor`.
   */
  reanchorReplay: (session: string) => void;
  /** Forget a session's timeline entirely (e.g. its conversation was deleted). */
  dropSession: (session: string) => void;
}

export const useConversationStore = create<ConversationState>((set) => {
  /** Replace one session immutably; `fn` returns a NEW entry (or the same to skip). */
  const withEntry = (session: string, fn: (entry: SessionEntry) => SessionEntry) =>
    set((s) => {
      const entry = s.sessions[session] ?? emptyEntry(session);
      const next = fn(entry);
      if (next === entry) return s;
      return { sessions: { ...s.sessions, [session]: next } };
    });

  const openTurn = (
    entry: SessionEntry,
    id: string,
    parentToolUseId: string | null,
  ): SessionEntry => {
    if (entry.turns[id]) return entry; // dedupe
    const turn: Turn = {
      id,
      role: "assistant",
      status: "streaming",
      streamingText: "",
      streamingThinking: "",
      blocks: [],
      parentToolUseId,
      hasThinking: false,
    };
    const next: SessionEntry = {
      ...entry,
      turns: { ...entry.turns, [id]: turn },
      openBubble: { ...entry.openBubble, [rootKey(parentToolUseId)]: id },
    };
    if (parentToolUseId === null) {
      next.timeline = hasTimelineId(entry.timeline, id)
        ? entry.timeline
        : [...entry.timeline, { kind: "turn", id }];
    } else {
      const existing = entry.subThreads[parentToolUseId] ?? [];
      next.subThreads = {
        ...entry.subThreads,
        [parentToolUseId]: existing.includes(id) ? existing : [...existing, id],
      };
    }
    return next;
  };

  const appendBuffer = (
    session: string,
    messageId: string,
    field: "streamingText" | "streamingThinking",
    text: string,
  ) =>
    withEntry(session, (entry) => {
      let turn = entry.turns[messageId];
      let base = entry;
      if (!turn) {
        // Defensive: a delta before its message_started — open the turn.
        base = openTurn(entry, messageId, null);
        turn = base.turns[messageId];
      }
      if (turn.status !== "streaming") return entry; // finalized: ignore late deltas
      // Stamp the start of a thinking block on the buffer's empty→non-empty edge: a NEW
      // block, since assistant_message resets streamingThinking + clears thinkingStartedAt
      // each time it finalizes one. Non-edge deltas leave the stamp untouched.
      const thinkStart = field === "streamingThinking" && turn.streamingThinking === "";
      const nextTurn: Turn = {
        ...turn,
        [field]: turn[field] + text,
        hasThinking: field === "streamingThinking" ? true : turn.hasThinking,
      };
      return {
        ...base,
        thinkingStartedAt: thinkStart ? Date.now() : base.thinkingStartedAt,
        turns: { ...base.turns, [messageId]: nextTurn },
      };
    });

  return {
    sessions: {},

    ensureSession: (session) =>
      set((s) =>
        s.sessions[session]
          ? s
          : { sessions: { ...s.sessions, [session]: emptyEntry(session) } },
      ),

    applyState: (session, state) =>
      // Carry forward the context meter + rate-limit snapshot when a state event
      // omits them (null): a freshly-spawned session's first states (system/init,
      // status) carry no usage yet, and would otherwise WIPE a value seeded from the
      // transcript (or set by an earlier message_start) — making the ring flicker
      // full → empty → full at the start of every (re)engaged conversation. The
      // assembler's real (non-null) values always win; only nulls defer to what we
      // already hold.
      withEntry(session, (entry) => {
        // Stamp the turn's wall-clock start on the false→true busy edge, clear it on
        // true→false. Gated on the EDGE (not every state event) so the LIVE elapsed
        // counter doesn't reset each time `system/init`/`status` re-emits busy:true
        // mid-turn. Left untouched while busy stays the same.
        let turnStartedAt = entry.turnStartedAt;
        let thinkingStartedAt = entry.thinkingStartedAt;
        // The same false→true edge bumps the turn count, which re-seeds the playful
        // "Thinking…" word so it changes on each new turn (the tier itself is driven by
        // cumulative thinking time — see thinkingWords.ts). Left untouched on true→false /
        // mid-turn re-emits.
        let turnCount = entry.turnCount;
        if (state.busy && !entry.state.busy) {
          turnStartedAt = Date.now();
          turnCount = entry.turnCount + 1;
        } else if (!state.busy && entry.state.busy) {
          turnStartedAt = null;
          thinkingStartedAt = null; // a turn ending also ends any in-flight thinking
        }
        return {
          ...entry,
          turnStartedAt,
          turnCount,
          thinkingStartedAt,
          state: {
            ...state,
            context_tokens: state.context_tokens ?? entry.state.context_tokens,
            context_window: state.context_window ?? entry.state.context_window,
            rate_limit: state.rate_limit ?? entry.state.rate_limit,
          },
        };
      }),

    applyContextFill: (session, fill) =>
      withEntry(session, (entry) => {
        const s = entry.state;
        const tokens = s.context_tokens ?? fill.context_tokens;
        const window = s.context_window ?? fill.context_window;
        if (tokens === s.context_tokens && window === s.context_window) return entry;
        return { ...entry, state: { ...s, context_tokens: tokens, context_window: window } };
      }),

    clearState: (session) =>
      // Also drop any "en attente" badge: the session is being turned off, so the
      // queued message will never be picked up — no message_started/turn_result will
      // arrive to clear it otherwise (the terminal `ended` event is routed by the
      // now-stale handle and dropped).
      withEntry(session, (entry) =>
        clearQueuedBadges({
          ...entry,
          state: { ...connectingState },
          turnStartedAt: null,
          thinkingSince: null, // seal the open spinner spell (kept thinkingMs = per-discussion total)
          thinkingStartedAt: null,
          toolStartedAt: {},
        }),
      ),

    accrueThinking: (session, isGeneric, now) =>
      withEntry(session, (entry) => {
        // Accrue INCREMENTALLY (each sample credits the delta since the last one, capped), not only
        // on the seal: the busy→false event that ends a turn is itself processed at wake time after
        // a sleep, so sealing the whole open spell then would still credit the sleep gap. Sampling
        // frequently + capping each delta bounds any frozen-ticker gap while a genuine long think
        // still accrues in full.
        if (isGeneric && entry.thinkingSince == null) return { ...entry, thinkingSince: now }; // open
        if (entry.thinkingSince == null) return entry; // not thinking, nothing open → no-op
        const delta = Math.min(Math.max(0, now - entry.thinkingSince), THINKING_ACCRUAL_CAP_MS);
        return {
          ...entry,
          thinkingMs: entry.thinkingMs + delta,
          thinkingSince: isGeneric ? now : null, // keep sampling while thinking; seal on leave
        };
      }),

    appendText: (session, messageId, text) =>
      appendBuffer(session, messageId, "streamingText", text),

    appendThinking: (session, messageId, text) =>
      appendBuffer(session, messageId, "streamingThinking", text),

    addUserTurn: (session, text, queued, images) =>
      withEntry(session, (entry) => {
        const id = `user_${entry.seq}`;
        const turn: Turn = {
          id,
          role: "user",
          status: "final",
          streamingText: text,
          streamingThinking: "",
          blocks: [],
          parentToolUseId: null,
          hasThinking: false,
          queued,
          images: images && images.length ? images : undefined,
          // Durable twin of `queued` for clean-output grouping: never cleared, so a mid-work
          // injection stays distinguishable from a fresh prompt long after the badge clears.
          injectedMidTurn: queued,
        };
        return {
          ...entry,
          seq: entry.seq + 1,
          turns: { ...entry.turns, [id]: turn },
          timeline: [...entry.timeline, { kind: "turn", id }],
          // A locally-sent turn is committed content at the current boundary: move the
          // replay anchor past it so a concurrent remote echo (multi-device: desktop +
          // phone in the same window) splices AFTER our own message, not before it.
          replayAnchor: entry.timeline.length + 1,
          // Sending the next message consumes any pending review/question: the
          // user has clearly moved on from the previous result.
          turnSeen: true,
        };
      }),

    addErrorTurn: (session, message, detail) =>
      withEntry(session, (entry) => {
        const id = `err_${entry.seq}`;
        // An error turn means the send failed (or a respawn fallback): a message
        // that was optimistically flagged "en attente" will never be delivered, so
        // clear its badge instead of leaving it stuck.
        return clearQueuedBadges({
          ...entry,
          seq: entry.seq + 1,
          errors: { ...entry.errors, [id]: { id, message, detail: detail ?? null } },
          timeline: [...entry.timeline, { kind: "error", id }],
          // Committed content at the boundary → advance the replay anchor past it so a
          // later remote echo doesn't render above this error (e.g. a failed
          // remote-control toggle's own error bubble).
          replayAnchor: entry.timeline.length + 1,
        });
      }),

    enqueuePermission: (session, request) =>
      withEntry(session, (entry) =>
        entry.pendingPermissions.some((p) => p.request_id === request.request_id)
          ? entry
          : { ...entry, pendingPermissions: [...entry.pendingPermissions, request] },
      ),

    removePermission: (session, requestId) =>
      withEntry(session, (entry) => {
        if (!entry.pendingPermissions.some((p) => p.request_id === requestId))
          return entry;
        return {
          ...entry,
          pendingPermissions: entry.pendingPermissions.filter(
            (p) => p.request_id !== requestId,
          ),
        };
      }),

    markSeen: (session) =>
      withEntry(session, (entry) =>
        entry.turnSeen ? entry : { ...entry, turnSeen: true },
      ),

    resetSession: (session) =>
      set((s) => ({ sessions: { ...s.sessions, [session]: emptyEntry(session) } })),

    reanchorReplay: (session) =>
      withEntry(session, (entry) => ({ ...entry, replayAnchor: entry.timeline.length })),

    dropSession: (session) =>
      set((s) => {
        if (!s.sessions[session]) return s;
        const next = { ...s.sessions };
        delete next[session];
        return { sessions: next };
      }),

    applyItem: (session, item, hydrating = false) =>
      withEntry(session, (entry) => {
        switch (item.kind) {
          case "message_started": {
            const opened = openTurn(entry, item.id, item.parent_tool_use_id);
            // A new ROOT assistant message = the agent's next model call, which is
            // past the boundary where the CLI injects queued messages. So a message
            // that was waiting "en attente" has now been delivered to the agent —
            // clear its badge here (not only at turn_result, the end of the whole
            // loop). Sub-agent (Task) messages don't count: the queued message is
            // injected into the ROOT loop, not the sub-thread.
            return item.parent_tool_use_id === null ? clearQueuedBadges(opened) : opened;
          }

          case "text_delta":
          case "thinking_delta": {
            // Normally deltas come via appendText/appendThinking (rAF-coalesced);
            // handle here too for completeness / out-of-band delivery.
            const field =
              item.kind === "text_delta" ? "streamingText" : "streamingThinking";
            const key = rootKey(null);
            const messageId = item.message_id ?? entry.openBubble[key];
            if (!messageId) return entry;
            const turn = entry.turns[messageId];
            if (!turn || turn.status !== "streaming") return entry;
            // Same thinking-start stamp as appendBuffer (this is the out-of-band path).
            const thinkStart =
              field === "streamingThinking" && turn.streamingThinking === "";
            const nextTurn: Turn = {
              ...turn,
              [field]: turn[field] + item.text,
              hasThinking:
                field === "streamingThinking" ? true : turn.hasThinking,
            };
            return {
              ...entry,
              thinkingStartedAt: thinkStart ? Date.now() : entry.thinkingStartedAt,
              turns: { ...entry.turns, [messageId]: nextTurn },
            };
          }

          case "user_message": {
            // A user turn from the stream. Our OWN turns are suppressed in the core (by
            // the uuid we stamped), so only REMOTE (phone/web) turns and history replays
            // reach here; both are keyed by their transcript uuid, so a re-delivery
            // dedupes. Mirrors addUserTurn (role "user", text in streamingText).
            if (entry.turns[item.id]) return entry;
            const turn: Turn = {
              id: item.id,
              role: "user",
              status: "final",
              streamingText: item.text,
              streamingThinking: "",
              blocks: [],
              parentToolUseId: item.parent_tool_use_id,
              hasThinking: false,
            };
            const line = { kind: "turn", id: item.id } as const;
            // A HISTORY restore (`replay:false`) is already chronological → APPEND. It
            // must NOT go through the splice: the anchor isn't re-armed during a resume
            // (the transcript carries no `turn_result`), so splicing would bunch every
            // user turn above the replies. Only a LIVE remote echo (`replay:true`) —
            // which can arrive out-of-order, after its own answer already streamed — is
            // spliced at the frozen anchor (the current turn boundary), landing right
            // before this turn's whole response; the anchor advances so several queued
            // replays keep their order. See `SessionEntry.replayAnchor`.
            if (!item.replay) {
              return {
                ...entry,
                turns: { ...entry.turns, [item.id]: turn },
                timeline: hasTimelineId(entry.timeline, item.id)
                  ? entry.timeline
                  : [...entry.timeline, line],
              };
            }
            const at = Math.min(entry.replayAnchor, entry.timeline.length);
            return {
              ...entry,
              turns: { ...entry.turns, [item.id]: turn },
              timeline: [...entry.timeline.slice(0, at), line, ...entry.timeline.slice(at)],
              replayAnchor: at + 1,
            };
          }

          case "assistant_message": {
            // Claude delivers one logical message (same id) as SEPARATE events,
            // one per finalized content block (thinking, then text, then tool_use).
            // APPEND the new block(s) to whatever the turn already shows — never
            // replace — otherwise the text rendered between two tools would be
            // overwritten by the following tool_use block and vanish. The live
            // buffers are cleared because the block they were typing is now
            // authoritative in `blocks`. The turn stays "streaming"; turn_result
            // finalizes it. (Resume takes a faster path: history.rs has already
            // merged the same-id lines, so this just appends the one merged event.)
            const base = openTurn(entry, item.id, item.parent_tool_use_id);
            const existing = base.turns[item.id];
            const blocks = [...existing.blocks, ...item.blocks];
            const turn: Turn = {
              ...existing,
              blocks,
              streamingText: "",
              streamingThinking: "",
              hasThinking: blocks.some((b) => b.type === "thinking"),
              // Codex: tag the turn with its backend turn id (for native rewind/fork by id).
              // Null on Claude; keep any prior value if a later block omits it.
              codexTurnId: item.turn_id ?? existing.codexTurnId,
            };
            // Freeze the elapsed of any thinking block finalized here, keyed by its text
            // (what the renderer receives). Clear the live start so the next block re-stamps.
            // Skipped during hydration: a replayed assistant_message carries no live delta,
            // so `thinkingStartedAt` is already null there — the guard is belt-and-suspenders.
            let thinkingStartedAt = base.thinkingStartedAt;
            let thinkingDurations = base.thinkingDurations;
            if (!hydrating && thinkingStartedAt != null) {
              const finalized = item.blocks.filter(
                (b): b is Extract<NormalizedBlock, { type: "thinking" }> =>
                  b.type === "thinking" && !!b.text,
              );
              if (finalized.length > 0) {
                const dur = Date.now() - thinkingStartedAt;
                thinkingDurations = { ...thinkingDurations };
                for (const b of finalized) thinkingDurations[b.text] = dur;
                thinkingStartedAt = null;
              }
            }
            // Stamp the start of each tool call appearing here (keyed by tool_use_id), so a
            // running tool row can show a live counter and its tool_result can freeze the
            // duration. Only the first sighting stamps (an assistant_message can't re-open a
            // tool). Sub-agent (Task) tool_uses are included — they get durations too.
            // NEVER stamp during hydration: replayed history has no wall-clock meaning, and
            // its tool_result lands in the SAME synchronous loop, freezing ~0ms → every tool
            // of a reloaded conversation would show a bogus "0ms" chip. Live only.
            let toolStartedAt = base.toolStartedAt;
            const toolUses = item.blocks.filter(
              (b): b is Extract<NormalizedBlock, { type: "tool_use" }> => b.type === "tool_use",
            );
            if (!hydrating && toolUses.length > 0) {
              const t = Date.now();
              toolStartedAt = { ...toolStartedAt };
              for (const b of toolUses) if (toolStartedAt[b.id] == null) toolStartedAt[b.id] = t;
            }
            let next = {
              ...base,
              turns: { ...base.turns, [item.id]: turn },
              thinkingStartedAt,
              thinkingDurations,
              toolStartedAt,
            };
            // Record any detached sub-agent (`Agent` with run_in_background) launched in
            // this message, so the pinned AgentBar can list it WITHOUT re-scanning every
            // block on each streamed token. Done once per assistant_message.
            const newBg = backgroundAgentIdsIn(item.blocks).filter(
              (id) => !next.bgAgentIds.includes(id),
            );
            if (newBg.length > 0) {
              next = { ...next, bgAgentIds: [...next.bgAgentIds, ...newBg] };
            }
            // Capture the agent's to-do list from a TodoWrite tool_use (last
            // write wins). Scoped to the MAIN thread: a sub-agent (Task) keeps
            // its own todos and must not overwrite the conversation-level list.
            if (item.parent_tool_use_id === null) {
              const todos = latestTodosInBlocks(item.blocks);
              if (todos) return { ...next, todos };
            }
            return next;
          }

          case "tool_result": {
            const result: ToolResult = {
              toolUseId: item.tool_use_id,
              content: item.content,
              isError: item.is_error,
              parentToolUseId: item.parent_tool_use_id,
            };
            // Freeze the tool's duration (tool_use → tool_result) if we stamped its start.
            // Skipped during hydration (belt-and-suspenders: a replayed tool_use never gets a
            // stamp, so `startedAt` is already null here — but make the intent explicit).
            let toolDurations = entry.toolDurations;
            const startedAt = entry.toolStartedAt[item.tool_use_id];
            if (!hydrating && startedAt != null && toolDurations[item.tool_use_id] == null) {
              toolDurations = { ...toolDurations, [item.tool_use_id]: Date.now() - startedAt };
            }
            const next: SessionEntry = {
              ...entry,
              toolResults: { ...entry.toolResults, [item.tool_use_id]: result },
              toolDurations,
            };
            // Robustness: a DETACHED sub-agent whose live `Agent` block arrived WITHOUT
            // `run_in_background` (a transient wire drop) would otherwise render inline as a
            // foreground card and never reach the AgentBar. Its launch ack is an independent,
            // reliable "detached" signal — fold the id into bgAgentIds so the AgentBar lists
            // it AND the inline hiding drops it, exactly as if the input flag had been present.
            if (
              isDetachedAgentByAck(entry, item.tool_use_id, item.content) &&
              !next.bgAgentIds.includes(item.tool_use_id)
            ) {
              next.bgAgentIds = [...next.bgAgentIds, item.tool_use_id];
            }
            return next;
          }

          case "turn_result": {
            const id = `tr_${entry.seq}`;
            const meta: TurnResultMeta = {
              subtype: item.subtype,
              isError: item.is_error,
              result: item.result,
              apiErrorStatus: item.api_error_status ?? null,
              totalCostUsd: item.total_cost_usd,
              numTurns: item.num_turns,
              durationMs: item.duration_ms,
              durationApiMs: item.duration_api_ms,
              ttftMs: item.ttft_ms,
            };
            // finalize any still-streaming turns
            const turns = { ...entry.turns };
            let touched = false;
            for (const [tid, t] of Object.entries(turns)) {
              if (t.status === "streaming") {
                turns[tid] = {
                  ...t,
                  status: item.subtype === "interrupted" ? "interrupted" : "final",
                };
                touched = true;
              }
            }
            // Safety net for the "en attente" badge: normally cleared at the next
            // message_started, but a loop can end (e.g. interrupted) without one, so
            // clear any still-queued user turn now that the loop is over.
            return clearQueuedBadges({
              ...entry,
              seq: entry.seq + 1,
              turns: touched ? turns : entry.turns,
              turnResults: { ...entry.turnResults, [id]: meta },
              timeline: [...entry.timeline, { kind: "turn_result", id }],
              openBubble: {},
              pendingPermissions: [],
              // Re-anchor the replay insert point to the (new) end of the timeline at
              // this turn boundary, so the NEXT remote turn's echo splices right after
              // this turn — never inside the response that just finished. (+1 = the
              // turn_result footer we just appended.) See `SessionEntry.replayAnchor`.
              replayAnchor: entry.timeline.length + 1,
              // A turn just finished → it's now "to review", UNLESS it was
              // interrupted (the user did that, so they're already aware).
              turnSeen: item.subtype === "interrupted",
            });
          }

          case "notice": {
            const id = `nt_${entry.seq}`;
            const notice: NoticeItem = {
              id,
              subtype: item.subtype,
              detail: item.detail,
            };
            return {
              ...entry,
              seq: entry.seq + 1,
              notices: { ...entry.notices, [id]: notice },
              timeline: [...entry.timeline, { kind: "notice", id }],
            };
          }

          default:
            // A ConversationItem kind we don't handle (a new core/protocol variant
            // landing before the front catches up). TS has no exhaustiveness guard on
            // this switch, so it would be dropped without a trace — log it instead.
            console.warn("[conversationStore] unhandled ConversationItem kind:", (item as { kind?: string }).kind);
            return entry;
        }
      }),
  };
});

// ---- Fine-grained selector hooks -------------------------------------------

const EMPTY_TIMELINE: TimelineEntry[] = [];
const EMPTY_PERMS: PermissionRequestPayload[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_TODOS: TodoItem[] = [];
const EMPTY_STRINGS: string[] = [];

export const useSessionState = (session: string): SessionStatePayload | undefined =>
  useConversationStore((s) => s.sessions[session]?.state);

/** Wall-clock start of the in-flight turn (`Date.now()`), or `null` when idle. Drives
 *  the live elapsed counter in the working indicator. See {@link SessionEntry.turnStartedAt}. */
export const useTurnStartedAt = (session: string): number | null =>
  useConversationStore((s) => s.sessions[session]?.turnStartedAt ?? null);

/** Wall-clock start of the thinking block currently streaming, or `null`. Drives the live
 *  counter on a streaming ThinkingBlock. See {@link SessionEntry.thinkingStartedAt}. */
export const useThinkingStartedAt = (session: string): number | null =>
  useConversationStore((s) => s.sessions[session]?.thinkingStartedAt ?? null);

/** Frozen duration (ms) of a finalized thinking block, looked up by its text, or `null`
 *  when unknown (still live, or hydrated from disk). See {@link SessionEntry.thinkingDurations}. */
export const useThinkingDuration = (session: string, text: string): number | null =>
  useConversationStore((s) => s.sessions[session]?.thinkingDurations[text] ?? null);

/** Wall-clock start of a tool call in flight (by tool_use_id), or `null`. Drives the live
 *  counter on a running tool row. See {@link SessionEntry.toolStartedAt}. */
export const useToolStartedAt = (session: string, toolUseId: string): number | null =>
  useConversationStore((s) => s.sessions[session]?.toolStartedAt[toolUseId] ?? null);

/** Frozen duration (ms) of a finished tool call (by tool_use_id), or `null` when unknown
 *  (still running, or hydrated from disk). See {@link SessionEntry.toolDurations}. */
export const useToolDuration = (session: string, toolUseId: string): number | null =>
  useConversationStore((s) => s.sessions[session]?.toolDurations[toolUseId] ?? null);

export const useTimeline = (session: string): TimelineEntry[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.timeline ?? EMPTY_TIMELINE),
  );

export const useTurn = (session: string, id: string): Turn | undefined =>
  useConversationStore((s) => s.sessions[session]?.turns[id]);

/** A render item for the thread. Consecutive main ASSISTANT turns coalesce into ONE
 *  `ai` group, so a run of tool calls spread over several assistant messages renders as
 *  one grouped response (not one section per message); a user message / error / etc.
 *  breaks the group. */
export type RenderItem =
  // `markers` (clean-output only) are in-band items — a control-change bar, a message injected
  // mid-work — absorbed into this round so they render inline WITHOUT cutting the work fold
  // (see coalesceCleanRounds). Absent/empty in the default plan.
  | { kind: "ai"; ids: string[]; markers?: RoundMarker[] }
  | { kind: "user"; id: string }
  | { kind: "notice"; id: string }
  | { kind: "turn_result"; id: string }
  | { kind: "error"; id: string };

const EMPTY_PLAN: RenderItem[] = [];

/** Pure: fold the timeline into render items, coalescing consecutive assistant turns. */
export function planTimelineRender(entry: SessionEntry | undefined): RenderItem[] {
  if (!entry) return EMPTY_PLAN;
  const out: RenderItem[] = [];
  let aiGroup: { kind: "ai"; ids: string[] } | null = null;
  for (const e of entry.timeline) {
    if (e.kind === "turn") {
      const t = entry.turns[e.id];
      if (t && t.role === "assistant") {
        if (!aiGroup) {
          aiGroup = { kind: "ai", ids: [] };
          out.push(aiGroup);
        }
        aiGroup.ids.push(e.id);
        continue;
      }
      aiGroup = null;
      out.push({ kind: "user", id: e.id });
      continue;
    }
    aiGroup = null;
    out.push({ kind: e.kind, id: e.id });
  }
  return out.length ? out : EMPTY_PLAN;
}

/** A `notice` that is a NEUTRAL in-band marker (folds into a clean-output round without
 *  cutting the work): a confirmed control change, or a local command's echoed output
 *  (`command_output` — "Compacted", "Set model to opus"). Every other notice — errors, and
 *  `interrupted`, which really does end the work — is a hard boundary that ends the round.
 *
 *  Keeping `command_output` soft matters: these lines used to arrive as fake USER bubbles,
 *  which split one response into two folded rounds. Turning them into hard notices would
 *  have preserved exactly that split under a new name. */
function isSoftNotice(subtype: string | undefined): boolean {
  return subtype === "control_change" || subtype === "command_output";
}

/**
 * Clean-output only: merge the `ai` groups of ONE assistant response that a mid-turn marker
 * split apart, back into a single round — absorbing the marker(s) as inline `markers` so they
 * render in place WITHOUT cutting the "Travail de Claude" fold or resetting the live window.
 * Two triggers, treated identically: a control-change bar (`notice control_change`) and a
 * message injected while Claude works (a `user` turn mid-response).
 *
 * A round ends at a HARD boundary — `turn_result` / `error` / a non-control notice — OR at a
 * genuine new user prompt. The critical distinction: a `user` item joins the round as a marker
 * ONLY when `userIsInjected(id)` says it was sent mid-work (durable `injectedMidTurn`); any
 * other user turn is a real new prompt that ENDS the round and stays its own item. This is what
 * keeps a RESUMED conversation correct: hydrated history carries no `turn_result` boundaries and
 * no injection flag, so without this gate every past prompt would be swallowed and the whole
 * conversation would collapse into one fold. A LEADING user message (round not started) is never
 * absorbed either. Pure + testable; the default plan (non-clean) is untouched.
 */
export function coalesceCleanRounds(
  plan: RenderItem[],
  noticeSubtype: (id: string) => string | undefined,
  userIsInjected: (id: string) => boolean,
): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < plan.length) {
    const item = plan[i];
    if (item.kind !== "ai") {
      out.push(item);
      i++;
      continue;
    }
    const ids = [...item.ids];
    const markers: RoundMarker[] = [];
    let j = i + 1;
    for (; j < plan.length; j++) {
      const nxt = plan[j];
      if (nxt.kind === "ai") {
        ids.push(...nxt.ids);
        continue;
      }
      if (nxt.kind === "notice" && isSoftNotice(noticeSubtype(nxt.id))) {
        markers.push({ markerKind: "notice", id: nxt.id, after: ids.length });
        continue;
      }
      if (nxt.kind === "user" && userIsInjected(nxt.id)) {
        markers.push({ markerKind: "user", id: nxt.id, after: ids.length });
        continue;
      }
      // A real new prompt, turn_result, error or hard notice ends the response (and this round).
      break;
    }
    out.push(markers.length ? { kind: "ai", ids, markers } : { kind: "ai", ids });
    i = j;
  }
  return out;
}

// Memoised on `timeline` identity: turn roles never change, so the plan is stable while
// the agent streams (timeline ref unchanged) and recomputes only when an entry is added.
const renderPlanCache = new Map<string, { timeline: TimelineEntry[]; result: RenderItem[] }>();

export const useTimelineRender = (session: string): RenderItem[] =>
  useConversationStore((s) => {
    const entry = s.sessions[session];
    if (!entry) return EMPTY_PLAN;
    const cached = renderPlanCache.get(session);
    if (cached && cached.timeline === entry.timeline) return cached.result;
    const result = planTimelineRender(entry);
    renderPlanCache.set(session, { timeline: entry.timeline, result });
    return result;
  });

export const useToolResult = (
  session: string,
  toolUseId: string,
): ToolResult | undefined =>
  useConversationStore((s) => s.sessions[session]?.toolResults[toolUseId]);

/** True if ANY of these tool_use ids has an error result. Lets a grouped run
 *  section surface a failure (and auto-expand) without expanding every row. Returns
 *  a primitive, so the default equality re-renders the section only on flip. */
export const useRunErrored = (session: string, ids: string[]): boolean =>
  useConversationStore((s) => {
    const tr = s.sessions[session]?.toolResults;
    if (!tr) return false;
    for (const id of ids) if (tr[id]?.isError) return true;
    return false;
  });

export const useTurnResult = (
  session: string,
  id: string,
): TurnResultMeta | undefined =>
  useConversationStore((s) => s.sessions[session]?.turnResults[id]);

export const useNotice = (session: string, id: string): NoticeItem | undefined =>
  useConversationStore((s) => s.sessions[session]?.notices[id]);

export const useError = (session: string, id: string): ErrorItem | undefined =>
  useConversationStore((s) => s.sessions[session]?.errors[id]);

export const usePendingPermissions = (
  session: string,
): PermissionRequestPayload[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.pendingPermissions ?? EMPTY_PERMS),
  );

/** Subscribe to the pending permission for ONE tool_use, or undefined. Unlike
 *  {@link usePendingPermissions} this does not observe the whole array: add/remove preserve the
 *  existing request object references, so `.find` returns a stable ref (Object.is-equal) and a
 *  permission raised/answered for another tool in the session never re-renders this subscriber. */
export const usePendingPermission = (
  session: string,
  toolUseId: string,
): PermissionRequestPayload | undefined =>
  useConversationStore((s) =>
    s.sessions[session]?.pendingPermissions.find((p) => p.tool_use_id === toolUseId),
  );

export const useSubThread = (
  session: string,
  parentToolUseId: string,
): string[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.subThreads[parentToolUseId] ?? EMPTY_IDS),
  );

/** The `prompt` an `Agent`/`Task` tool_use was launched with — read from the spawning
 *  tool_use block. A drill-down (AgentBar / FlightDeck badge) only has the
 *  `BackgroundTask` (no prompt), so it looks it up here to prepend it to the live
 *  sub-thread, which streams ONLY the sub-agent's replies. Scans turns lazily (called
 *  only while a transcript popover is open) and returns a primitive → no spurious
 *  re-renders. */
export const useSubAgentPrompt = (
  session: string,
  toolUseId: string,
): string | null =>
  useConversationStore((s) => {
    const entry = s.sessions[session];
    if (!entry || !toolUseId) return null;
    for (const id in entry.turns) {
      for (const b of entry.turns[id].blocks) {
        if (b.type === "tool_use" && b.id === toolUseId) {
          const p = (b.input as { prompt?: unknown } | null)?.prompt;
          return typeof p === "string" ? p : null;
        }
      }
    }
    return null;
  });

/**
 * tool_use ids of the sub-agents (`Agent`/`Task`) this conversation launched DETACHED
 * (`run_in_background: true`). Captured at write time (see `bgAgentIds` in the
 * reducer), so this is an O(1) field read — shallow-compared, re-renders only when a
 * new detached sub-agent appears. Detached sub-agents show in the pinned AgentBar,
 * not inline; the inline card suppresses itself for them. */
export const useBackgroundAgentIds = (session: string): string[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.bgAgentIds ?? EMPTY_IDS),
  );

/** The conversation's current to-do list (raw items, in agent order). */
export const useTodos = (session: string): TodoItem[] =>
  useConversationStore(
    useShallow((s) => s.sessions[session]?.todos ?? EMPTY_TODOS),
  );

/** Derived progress summary (counts + current item) for the conversation's todos.
 *  Shallow-compared so it only re-renders when the underlying list changes. */
export const useTodoSummary = (session: string): TodoSummary =>
  useConversationStore(
    useShallow((s) => todoSummary(s.sessions[session]?.todos ?? EMPTY_TODOS)),
  );

/**
 * Chronological (oldest→newest) list of the user's OWN messages in this
 * conversation — the root-level `role:"user"` turns, in timeline order. Drives the
 * composer's ↑/↓ shell-style history recall. Blank messages are dropped and
 * consecutive duplicates collapsed, like a shell history. Sub-agent (Task) user
 * turns (`parentToolUseId !== null`) are excluded. Shallow-compared so it only
 * re-renders when the user actually sends a new (distinct) message. */
/**
 * The user's OWN messages in a session, chronological — the root-level `role:"user"`
 * turns in timeline order. Blank messages are dropped and consecutive duplicates
 * collapsed (like a shell history); sub-agent (Task) user turns
 * (`parentToolUseId !== null`) are excluded, as are CLI-injected special messages
 * (`<task-notification>` &c. — Claude talking to itself, not the human), which arrive
 * as `role:"user"` turns but are NOT something the user sent. Pure (no hook, no memo)
 * so it is unit-testable; the hook below memoises it. */
export function selectUserMessageHistory(entry: SessionEntry | undefined): string[] {
  if (!entry) return EMPTY_STRINGS;
  const out: string[] = [];
  for (const t of entry.timeline) {
    if (t.kind !== "turn") continue;
    const turn = entry.turns[t.id];
    if (!turn || turn.role !== "user" || turn.parentToolUseId !== null) continue;
    const text = turn.streamingText;
    if (!text.trim()) continue;
    // Skip CLI-injected markers (task-notification…): they're rendered as a dedicated
    // card, never a user bubble — so they must not count as "the user's last message"
    // in the preview/pin or the composer's recall history.
    if (parseSpecialMessage(text)) continue;
    if (out.length && out[out.length - 1] === text) continue; // collapse consecutive dups
    out.push(text);
  }
  return out.length ? out : EMPTY_STRINGS;
}

// Memoised by `timeline` identity: the set of user root-turns (and their text, set
// once at creation, never streamed into) changes ONLY when a new timeline entry is
// pushed — the per-token streaming path replaces `turns` but keeps the same
// `timeline` reference. So while the agent streams a reply, this returns the cached
// array (same reference) instead of re-walking the whole history on every token.
const userHistoryCache = new Map<string, { timeline: TimelineEntry[]; result: string[] }>();

/** `selectUserMessageHistory` cached per session on the `timeline` reference. Pure
 *  (the cache is an arg-free module singleton) so the memo invariant is testable. */
export function memoizedUserMessageHistory(
  session: string,
  entry: SessionEntry | undefined,
): string[] {
  if (!entry) return EMPTY_STRINGS;
  const cached = userHistoryCache.get(session);
  if (cached && cached.timeline === entry.timeline) return cached.result;
  const result = selectUserMessageHistory(entry);
  userHistoryCache.set(session, { timeline: entry.timeline, result });
  return result;
}

export const useUserMessageHistory = (session: string): string[] =>
  useConversationStore(
    useShallow((s) => memoizedUserMessageHistory(session, s.sessions[session])),
  );
