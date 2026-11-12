// A remote link flapping (lost / reconnected, over and over) must leave ONE line in the thread
// per run — and that line must fold into clean output's work like any in-band marker, never cut
// a response in two. See `store/linkNotices.ts`.
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationItem } from "../ipc/client";
import { coalesceCleanRounds, noticeFoldKind, planTimelineRender, useConversationStore } from "./conversationStore";

const S = "conv";
const st = () => useConversationStore.getState();
const entry = () => st().sessions[S];

const lost = (atMs: number): ConversationItem =>
  ({
    kind: "notice",
    subtype: "remote_link",
    detail: { message: "Connection to the server lost — reconnecting…", link: "lost", attached_before: true, hint: null, at_ms: atMs },
  }) as ConversationItem;
const restored = (atMs: number): ConversationItem =>
  ({
    kind: "notice",
    subtype: "remote_link",
    detail: { message: "Reconnected to the server.", link: "restored", at_ms: atMs },
  }) as ConversationItem;
const assistant = (id: string): ConversationItem[] =>
  [
    { kind: "message_started", id, role: "assistant", parent_tool_use_id: null },
    {
      kind: "assistant_message",
      id,
      parent_tool_use_id: null,
      turn_id: null,
      blocks: [{ type: "text", text: `Working (${id}).` }],
    },
  ] as ConversationItem[];

const at = (m: number) => new Date(2026, 9, 17, 10, m).getTime();
const notices = () => entry().timeline.filter((e) => e.kind === "notice");
const message = (id: string) => (entry().notices[id].detail as { message: string }).message;

beforeEach(() => {
  st().resetSession(S);
});

describe("a flapping remote link", () => {
  it("keeps ONE line however many times it drops and comes back", () => {
    st().applyItems(S, assistant("m1"), false);
    for (const m of [2, 5, 9]) {
      st().applyItem(S, lost(at(m)));
      st().applyItem(S, restored(at(m) + 4_000));
    }
    expect(notices()).toHaveLength(1);
    expect(message(notices()[0].id)).toBe(
      "Connection to the server dropped 3 times between 10:02 and 10:09, and came back each time.",
    );
  });

  it("opens a new line once anything else landed in the thread — each run at its place", () => {
    st().applyItem(S, lost(at(2)));
    st().applyItem(S, restored(at(2) + 10_000));
    st().applyItems(S, assistant("m1"), false);
    st().applyItem(S, lost(at(20)));
    expect(notices()).toHaveLength(2);
    expect(message(notices()[0].id)).toBe("Connection to the server lost at 10:02 — back after 10 s.");
    expect(message(notices()[1].id)).toBe("Connection to the server lost at 10:20.");
  });

  it("leaves every other remote_link line alone — they are news, not lifecycle", () => {
    st().applyItem(S, lost(at(2)));
    st().applyItem(S, {
      kind: "notice",
      subtype: "remote_link",
      detail: { message: "Your last message never reached Claude Code on Target — the link dropped first. Send it again." },
    } as ConversationItem);
    st().applyItem(S, restored(at(3)));
    expect(notices()).toHaveLength(3);
    expect(noticeFoldKind(entry().notices[notices()[1].id])).toBe("remote_link");
  });

  it("folds into clean output's work instead of cutting the response in two", () => {
    st().applyItems(S, assistant("m1"), false);
    st().applyItem(S, lost(at(2)));
    st().applyItem(S, restored(at(3)));
    st().applyItems(S, assistant("m2"), false);
    const plan = planTimelineRender(entry());
    expect(plan.map((p) => p.kind)).toEqual(["ai", "notice", "ai"]);
    const clean = coalesceCleanRounds(
      plan,
      (id) => noticeFoldKind(entry().notices[id]),
      () => false,
    );
    expect(clean).toHaveLength(1);
    expect(clean[0]).toMatchObject({ kind: "ai", ids: ["m1", "m2"], markers: [{ markerKind: "notice" }] });
  });
});
