import { describe, expect, it } from "vitest";
import {
  askWaiting,
  extensionsBody,
  groupByPlugin,
  NO_ASK,
  pluginOverrides,
  remoteListView,
  visibleAskError,
} from "./remoteExtensions";
import { EMPTY_LEVEL } from "./mcpToolPermissions";

describe("extensionsBody", () => {
  it("never describes a remote repository with this Mac's pictures", () => {
    expect(extensionsBody({ remote: true, liveBackend: "codex", activeTab: "codex" })).toBe("remote-codex");
    expect(extensionsBody({ remote: true, liveBackend: "claude", activeTab: "claude" })).toBe("conversation");
    expect(extensionsBody({ remote: true, liveBackend: null, activeTab: "claude" })).toBe("remote-repository");
    // A stale Codex tab on a remote repository changes nothing.
    expect(extensionsBody({ remote: true, liveBackend: null, activeTab: "codex" })).toBe("remote-repository");
  });

  it("keeps a local Codex conversation on its Codex body, detected or not", () => {
    expect(extensionsBody({ remote: false, liveBackend: "codex", activeTab: "codex" })).toBe("codex");
  });

  it("keeps the local lenses as they were", () => {
    expect(extensionsBody({ remote: false, liveBackend: "claude", activeTab: "claude" })).toBe("conversation");
    expect(extensionsBody({ remote: false, liveBackend: "claude", activeTab: "codex" })).toBe("codex");
    expect(extensionsBody({ remote: false, liveBackend: "codex", activeTab: "claude" })).toBe("repository");
    expect(extensionsBody({ remote: false, liveBackend: null, activeTab: "claude" })).toBe("repository");
    expect(extensionsBody({ remote: false, liveBackend: null, activeTab: "codex" })).toBe("codex");
  });
});

describe("remoteListView", () => {
  it("shows the list once known, whatever the request state", () => {
    const timedOut = { askedHandle: "s1", error: "no answer" };
    expect(remoteListView(["a"], "s1", true, timedOut)).toBe("list");
    expect(remoteListView([], "s1", true, timedOut)).toBe("empty");
  });

  it("needs a live session to report anything", () => {
    expect(remoteListView(null, null, true, NO_ASK)).toBe("no-session");
    expect(remoteListView(undefined, null, false, NO_ASK)).toBe("no-session");
  });

  it("offers to ask only where a request returns the list", () => {
    expect(remoteListView(null, "s1", true, NO_ASK)).toBe("can-ask");
    expect(remoteListView(null, "s1", false, NO_ASK)).toBe("next-turn");
  });

  it("is asking only for the session the request went to, until it fails", () => {
    expect(remoteListView(null, "s1", true, { askedHandle: "s1", error: null })).toBe("asking");
    // A new session (the old one stopped): the earlier request is not this one's.
    expect(remoteListView(null, "s2", true, { askedHandle: "s1", error: null })).toBe("can-ask");
    // Failed: offer to ask again (the error is shown alongside).
    expect(remoteListView(null, "s1", true, { askedHandle: "s1", error: "x" })).toBe("can-ask");
  });
});

describe("visibleAskError", () => {
  it("shows the error for this session while the answer is missing", () => {
    expect(visibleAskError(null, "s1", { askedHandle: "s1", error: "x" })).toBe("x");
  });

  it("hides it once the list arrives late", () => {
    expect(visibleAskError(["p"], "s1", { askedHandle: "s1", error: "x" })).toBeNull();
  });

  it("never pins an earlier session's error on a new one", () => {
    expect(visibleAskError(null, "s2", { askedHandle: "s1", error: "x" })).toBeNull();
    expect(visibleAskError(null, null, { askedHandle: "s1", error: "x" })).toBeNull();
  });
});

describe("askWaiting", () => {
  it("waits only while this session's request is unanswered and has not failed", () => {
    expect(askWaiting(null, "s1", { askedHandle: "s1", error: null })).toBe(true);
    expect(askWaiting(["p"], "s1", { askedHandle: "s1", error: null })).toBe(false);
    expect(askWaiting(null, "s1", { askedHandle: "s1", error: "x" })).toBe(false);
    expect(askWaiting(null, "s2", { askedHandle: "s1", error: null })).toBe(false);
    expect(askWaiting(null, null, { askedHandle: "s1", error: null })).toBe(false);
  });
});

describe("groupByPlugin", () => {
  it("puts bare names first, then one group per plugin, sorted", () => {
    const groups = groupByPlugin(
      ["tosse-workflow:pickup", "deep-research", "railway:use-railway", "tosse-workflow:done", "batch"],
      (n) => n,
    );
    expect(groups.map((g) => [g.plugin, g.items.map((i) => i.label)])).toEqual([
      [null, ["batch", "deep-research"]],
      ["railway", ["use-railway"]],
      ["tosse-workflow", ["done", "pickup"]],
    ]);
  });

  it("splits on the first colon only, and treats a leading colon as bare", () => {
    const groups = groupByPlugin(["p:a:b", ":odd"], (n) => n);
    expect(groups.map((g) => [g.plugin, g.items.map((i) => i.label)])).toEqual([
      [null, [":odd"]],
      ["p", ["a:b"]],
    ]);
  });

  it("is empty for no items", () => {
    expect(groupByPlugin([], (n: string) => n)).toEqual([]);
  });
});

describe("pluginOverrides", () => {
  const cascade = {
    global: { ...EMPTY_LEVEL, plugins: { "g@m": false } },
    repository: { ...EMPTY_LEVEL, plugins: { "a@m": false, "b@m": true } },
    conversation: { ...EMPTY_LEVEL, plugins: { "a@m": true } },
  };

  it("lists Flight Deck's own settings, the narrowest winning — never the global file's", () => {
    expect(pluginOverrides(cascade, ["conversation", "repository"])).toEqual([
      { id: "a@m", enabled: true, level: "conversation" },
      { id: "b@m", enabled: true, level: "repository" },
    ]);
  });

  it("sees only the levels the lens covers", () => {
    expect(pluginOverrides(cascade, ["repository"])).toEqual([
      { id: "a@m", enabled: false, level: "repository" },
      { id: "b@m", enabled: true, level: "repository" },
    ]);
    expect(pluginOverrides({}, ["conversation", "repository"])).toEqual([]);
  });
});
