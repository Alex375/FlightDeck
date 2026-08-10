import { describe, it, expect } from "vitest";
import type { ConversationItem } from "../../ipc/client";
import { toRows, userMarksFromItems } from "./SubAgentTranscript";

// Regression guard for the "zero silent error" contract on the read-only transcript view
// (history-panel preview + sub-agent drill-in): a `notice` item — e.g. `history_error` from
// a corrupt/unreadable rollout or transcript — must surface as its own row, never be dropped.
describe("SubAgentTranscript.toRows — notices are never dropped", () => {
  const user = (id: string, text: string): ConversationItem =>
    ({ kind: "user_message", id, text, parent_tool_use_id: null, replay: false }) as ConversationItem;
  const assistant = (id: string, text: string): ConversationItem =>
    ({ kind: "assistant_message", id, blocks: [{ type: "text", text }], parent_tool_use_id: null, turn_id: null }) as ConversationItem;
  const notice = (subtype: string, message: string): ConversationItem =>
    ({ kind: "notice", subtype, detail: { message } }) as ConversationItem;

  it("emits a notice row for a history_error item (does not swallow it)", () => {
    const rows = toRows([user("u1", "hi"), notice("history_error", "incomplete history")]);
    const n = rows.find((r) => r.kind === "notice");
    expect(n).toBeDefined();
    expect(n).toMatchObject({ kind: "notice", subtype: "history_error" });
  });

  it("renders even a notice-only transcript (the blank-preview bug)", () => {
    // parse_rollout can return a notice-only vec when a rollout is unreadable; that must
    // produce a visible row, not an empty render.
    const rows = toRows([notice("history_error", "unreadable")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("notice");
  });

  it("breaks the assistant run so the notice renders in place", () => {
    const rows = toRows([
      assistant("a1", "before"),
      notice("history_error", "cut here"),
      assistant("a2", "after"),
    ]);
    // Two distinct assistant rows split by the notice → the notice is not merged/lost.
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "notice", "assistant"]);
  });

  // The message minimap over the History preview maps THESE marks onto the rows above, by
  // key. A mark that doesn't correspond to a rendered user bubble would scroll nowhere.
  describe("userMarksFromItems", () => {
    it("carries the row key, so a mark and its bubble always agree", () => {
      const items = [user("u1", "first"), assistant("a1", "reply"), user("u2", "second")];
      expect(userMarksFromItems(items)).toEqual([
        { id: "u1", text: "first" },
        { id: "u2", text: "second" },
      ]);
      // Same keys the renderer stamps as `data-user-turn`.
      const keys = toRows(items).filter((r) => r.kind === "user").map((r) => r.key);
      expect(userMarksFromItems(items).map((m) => m.id)).toEqual(keys);
    });

    it("skips a CLI-injected marker — it renders as a card, not a user bubble", () => {
      const notif = "<task-notification>\n<status>completed</status>\n</task-notification>";
      const items = [user("u1", "real ask"), user("tn", notif)];
      expect(userMarksFromItems(items).map((m) => m.id)).toEqual(["u1"]);
    });

    it("skips blank messages", () => {
      expect(userMarksFromItems([user("u1", "  "), user("u2", "ok")]).map((m) => m.id)).toEqual([
        "u2",
      ]);
    });

    it("skips a sub-agent transcript's opening turn — Claude wrote it, not the human", () => {
      const items = [user("u1", "go audit this"), assistant("a1", "on it"), user("u2", "and now?")];
      expect(userMarksFromItems(items, true).map((m) => m.id)).toEqual(["u2"]);
      // The History preview has no such turn: its first message IS the human's.
      expect(userMarksFromItems(items).map((m) => m.id)).toEqual(["u1", "u2"]);
    });
  });
});
