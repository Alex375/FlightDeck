import { describe, it, expect } from "vitest";
import { useConversationStore } from "../store/conversationStore";
import type { ConversationItem } from "../ipc/client";
import type { SessionStatePayload } from "../store/types";
import { agentStatusForEntry } from "./useAgentStatus";

// A turn the user STOPPED reaches the store as `turn_result{subtype:"interrupted"}` (the
// Claude assembler normalizes the CLI's `error_during_execution` abort; Codex maps its
// `interrupted` status). The conversation must then rest at plain idle: no red error, no
// blue "to review" — the `[Request interrupted by user]` notice says it all.

const store = () => useConversationStore.getState();

function state(busy: boolean): SessionStatePayload {
  return {
    busy,
    session_id: null,
    cwd: null,
    model: null,
    permission_mode: null,
    output_style: null,
    effort: null,
    ultracode: false,
    ultracode_available: null,
    activity: null,
    awaiting_permission: false,
    retry: null,
    link: null,
    ended: false,
    context_tokens: null,
    context_window: null,
    context_usage: null,
    rate_limit: null,
  };
}

function turnResult(subtype: string, isError: boolean): ConversationItem {
  return {
    kind: "turn_result",
    subtype,
    is_error: isError,
    result: null,
    api_error_status: null,
    total_cost_usd: null,
    num_turns: 1,
    duration_ms: 1000,
    duration_api_ms: 500,
    ttft_ms: null,
    usage: null,
  };
}

/** Run one turn to its result, then derive the live conversation's status. */
function settle(session: string, item: ConversationItem) {
  store().ensureSession(session);
  store().applyState(session, state(true));
  store().applyItem(session, item);
  store().applyState(session, state(false));
  return agentStatusForEntry("session-1", store().sessions[session]);
}

describe("a user-interrupted turn", () => {
  it("rests at idle — neither error nor review", () => {
    expect(settle("int-idle", turnResult("interrupted", false)).kind).toBe("idle");
  });

  it("contrasts with a real failure (error) and a clean finish (review)", () => {
    expect(settle("int-err", turnResult("error_during_execution", true)).kind).toBe("error");
    expect(settle("int-ok", turnResult("success", false)).kind).toBe("review");
  });
});
