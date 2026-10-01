import { beforeEach, describe, expect, it } from "vitest";
import { pauseChanges, showsGhost, usePromptSuggestions } from "./promptSuggestions";

describe("pauseChanges", () => {
  const live = [
    { convId: "a", handle: "session-1" },
    { convId: "b", handle: "session-2" },
  ];

  it("pauses only what is off screen, and a fresh process is unpaused already", () => {
    expect(pauseChanges(live, { a: 1 }, true, new Map())).toEqual([
      { handle: "session-2", paused: true },
    ]);
  });

  it("sends nothing the handle was already told", () => {
    const sent = new Map([["session-2", true]]);
    expect(pauseChanges(live, { a: 1 }, true, sent)).toEqual([]);
  });

  it("un-pauses a conversation whose composer came back on screen", () => {
    const sent = new Map([["session-2", true]]);
    expect(pauseChanges(live, { a: 1, b: 2 }, true, sent)).toEqual([
      { handle: "session-2", paused: false },
    ]);
  });

  it("pauses everything while the feature is off, on screen or not", () => {
    expect(pauseChanges(live, { a: 1, b: 1 }, false, new Map())).toEqual([
      { handle: "session-1", paused: true },
      { handle: "session-2", paused: true },
    ]);
  });

  it("re-sends to a respawned conversation: its new handle has been told nothing", () => {
    const sent = new Map([["session-2", true]]);
    const respawned = [{ convId: "b", handle: "session-3" }];
    expect(pauseChanges(respawned, {}, true, sent)).toEqual([
      { handle: "session-3", paused: true },
    ]);
  });
});

describe("showsGhost", () => {
  const base = { suggestion: "run the tests", text: "", attachments: 0, busy: false, enabled: true };

  it("shows in an empty box between turns", () => {
    expect(showsGhost(base)).toBe(true);
  });

  it.each([
    ["no suggestion", { suggestion: null }],
    ["text typed", { text: "r" }],
    ["an image joined", { attachments: 1 }],
    ["a turn running", { busy: true }],
    ["the feature off", { enabled: false }],
  ])("hides with %s", (_label, patch) => {
    expect(showsGhost({ ...base, ...patch })).toBe(false);
  });
});

describe("usePromptSuggestions", () => {
  beforeEach(() => usePromptSuggestions.setState({ byConv: {}, onScreen: {} }));

  it("counts composers, so closing the reply modal keeps the open conversation on screen", () => {
    const { mountComposer } = usePromptSuggestions.getState();
    const releaseView = mountComposer("a");
    const releaseModal = mountComposer("a");
    releaseModal();
    releaseModal(); // a double release must not steal the other mount
    expect(usePromptSuggestions.getState().onScreen).toEqual({ a: 1 });
    releaseView();
    expect(usePromptSuggestions.getState().onScreen).toEqual({});
  });

  it("clears one conversation's suggestion only", () => {
    const st = usePromptSuggestions.getState();
    st.set("a", "yes");
    st.set("b", "commit this");
    st.clear("a");
    expect(usePromptSuggestions.getState().byConv).toEqual({ b: "commit this" });
  });
});
