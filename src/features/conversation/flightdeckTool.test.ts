import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../ipc/client";
import {
  flightdeckStepCount,
  flightdeckStepLabel,
  flightdeckTargetIds,
  isFlightdeckMcpTool,
  parseFlightdeckTool,
} from "./flightdeckTool";

const fd = (tool: string) => `mcp__flightdeck__${tool}`;
/** A tool result as the Rust router wraps the executor's return value. */
const json = (v: unknown): JsonValue => [{ type: "text", text: JSON.stringify(v, null, 2) }];
const titleOf = (id: string) => ({ c1: "Refactor auth", c2: "Ship the release" })[id] ?? null;

describe("parseFlightdeckTool", () => {
  it("claims the app's own server only", () => {
    expect(parseFlightdeckTool(fd("list_conversations"))).toBe("list_conversations");
    expect(isFlightdeckMcpTool(fd("whoami"))).toBe(true);
    expect(isFlightdeckMcpTool("mcp__claude_ai_TOSSE__get_tasks")).toBe(false);
    expect(isFlightdeckMcpTool("mcp__flightdeck_extra__whoami")).toBe(false);
    expect(isFlightdeckMcpTool("Read")).toBe(false);
  });
});

describe("flightdeckStepLabel", () => {
  it("is null for anything that is not a Flight Deck call", () => {
    expect(flightdeckStepLabel("Read", { file_path: "/x" })).toBeNull();
    expect(flightdeckStepLabel("mcp__playwright__browser_click", {})).toBeNull();
  });

  it("names the target conversation by its LIVE name", () => {
    expect(flightdeckStepLabel(fd("read_conversation"), { conversation_id: "c1" }, { titleOf })).toBe(
      'Read "Refactor auth"',
    );
    expect(flightdeckStepLabel(fd("interrupt_conversation"), { conversation_id: "c2" }, { titleOf })).toBe(
      'Interrupt "Ship the release"',
    );
  });

  it("falls back to the result's title, then to a neutral phrase", () => {
    // Removed from the list → no live name, but the result echoes the title it had.
    const removed = json({ conversation_id: "gone", title: "Old spike", removed: true });
    expect(
      flightdeckStepLabel(fd("remove_conversation"), { conversation_id: "gone" }, { titleOf, result: removed }),
    ).toBe('Remove "Old spike" from the list');
    expect(flightdeckStepLabel(fd("focus_conversation"), { conversation_id: "gone" }, { titleOf })).toBe(
      "Open a conversation",
    );
    // An error result is text, not JSON — never a crash.
    expect(
      flightdeckStepLabel(fd("read_conversation"), { conversation_id: "gone" }, {
        result: [{ type: "text", text: "no conversation with id 'gone'" }],
      }),
    ).toBe("Read a conversation");
  });

  it("says 'this conversation' for a tool that defaults to the caller", () => {
    expect(flightdeckStepLabel(fd("acknowledge_conversation"), {})).toBe("Mark this conversation as seen");
    expect(flightdeckStepLabel(fd("open_panel"), { panel: "terminal" })).toBe("Open the terminal");
    expect(flightdeckStepLabel(fd("open_panel"), { panel: "git", conversation_id: "c1" }, { titleOf })).toBe(
      'Open the git panel in "Refactor auth"',
    );
  });

  it("reads a reopened conversation's name off the result (the input is a disk session id)", () => {
    const result = json({ conversation_id: "c2", session_id: "s", title: "Disk title", reopened: true });
    expect(flightdeckStepLabel(fd("reopen_conversation"), { session_id: "s" }, { titleOf, result })).toBe(
      'Reopen "Ship the release"',
    );
    expect(flightdeckStepLabel(fd("reopen_conversation"), { session_id: "s" })).toBe(
      "Reopen a past conversation",
    );
  });

  it("phrases the controls with their values", () => {
    expect(
      flightdeckStepLabel(fd("set_conversation_model"), { conversation_id: "c1", model: "opus" }, { titleOf }),
    ).toMatch(/^Set model to .+ for "Refactor auth"$/);
    expect(
      flightdeckStepLabel(
        fd("set_conversation_effort"),
        { conversation_id: "c1", effort: "high", ultracode: true },
        { titleOf },
      ),
    ).toBe('Set effort to high, Ultracode on for "Refactor auth"');
    expect(flightdeckStepLabel(fd("answer_request"), { conversation_id: "c1", behavior: "deny" }, { titleOf })).toBe(
      'Deny a request in "Refactor auth"',
    );
    expect(
      flightdeckStepLabel(
        fd("answer_request"),
        { conversation_id: "c1", behavior: "allow", answers: { "Which DB?": "Postgres" } },
        { titleOf },
      ),
    ).toBe('Answer a question in "Refactor auth"');
  });

  it("names files, folders, views and notifications by their argument", () => {
    expect(flightdeckStepLabel(fd("open_file"), { path: "/repo/src/App.tsx", line: 42 })).toBe("Open App.tsx:42");
    expect(
      flightdeckStepLabel(fd("open_diff"), { left_path: "/repo/old/App.tsx", right_path: "src/App.tsx" }),
    ).toBe("Compare App.tsx ↔ App.tsx");
    expect(flightdeckStepLabel(fd("open_diff"), { left_path: "a.ts" })).toBe("Compare two files");
    expect(flightdeckStepLabel(fd("add_repo"), { path: "/Users/me/Repos/api/" })).toBe("Add folder api");
    expect(flightdeckStepLabel(fd("browse_folders"), {})).toBe("Browse the home folder");
    expect(flightdeckStepLabel(fd("open_view"), { view: "flightdeck" })).toBe("Switch to the Flight Deck view");
    expect(flightdeckStepLabel(fd("notify_user"), { message: "Build is green" })).toBe('Notify: "Build is green"');
    expect(flightdeckStepLabel(fd("search_past_conversations"), { query: "auth" })).toBe(
      'Search history for "auth"',
    );
    expect(flightdeckStepLabel(fd("rename_conversation"), { name: "New name" })).toBe('Rename to "New name"');
  });

  it("clips a long name", () => {
    const long = "x".repeat(80);
    expect(flightdeckStepLabel(fd("rename_conversation"), { name: long })).toBe(`Rename to "${"x".repeat(39)}…"`);
  });

  it("says how a wait ended once its outcome is in, and which watch it is", () => {
    const input = { conversation_id: "c1" };
    expect(flightdeckStepLabel(fd("wait_for_conversation"), input, { titleOf })).toBe('Wait for "Refactor auth"');
    expect(
      flightdeckStepLabel(fd("wait_for_conversation"), input, { titleOf, result: json({ outcome: "timeout" }) }),
    ).toBe('Wait for "Refactor auth" · still working');
    expect(flightdeckStepLabel(fd("watch_conversation"), input, { titleOf })).toBe('Watch "Refactor auth"');
    expect(flightdeckStepLabel(fd("watch_conversation"), { ...input, mode: "persistent" }, { titleOf })).toBe(
      'Watch "Refactor auth" until told otherwise',
    );
    expect(flightdeckStepLabel(fd("unwatch_conversation"), input, { titleOf })).toBe('Stop watching "Refactor auth"');
  });

  it("still reads plainly for a tool the table does not know", () => {
    expect(flightdeckStepLabel(fd("frobnicate_widget"), {})).toBe("Flight Deck · frobnicate widget");
  });

  it("has a tailored label for EVERY tool of the Rust catalogue", () => {
    // Built with `path`, not `new URL(…, import.meta.url)` (Vite rewrites that form).
    const toolsRs = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/appmcp/tools.rs"),
      "utf8",
    );
    const names = [...toolsRs.matchAll(/^\s*name: "([a-z_]+)",$/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      expect(flightdeckStepLabel(fd(name), {}), name).not.toMatch(/^Flight Deck · /);
    }
  });
});

describe("flightdeckStepCount", () => {
  it("counts what a lookup brought back", () => {
    expect(flightdeckStepCount(fd("list_conversations"), json([{}, {}, {}]))).toBe("3 conversations");
    expect(flightdeckStepCount(fd("list_conversations"), json([{}]))).toBe("1 conversation");
    expect(flightdeckStepCount(fd("search_past_conversations"), json({ count: 2, conversations: [{}, {}] }))).toBe(
      "2 results",
    );
    expect(flightdeckStepCount(fd("get_pending_request"), json({ conversation_id: "c1", requests: [] }))).toBe(
      "0 requests",
    );
    expect(flightdeckStepCount(fd("read_conversation"), json({ turns: [{}, {}] }))).toBe("2 turns");
  });

  it("says nothing for an action, an error, or an unknown shape", () => {
    expect(flightdeckStepCount(fd("focus_conversation"), json({ focused: true }))).toBeNull();
    expect(flightdeckStepCount(fd("list_conversations"), [{ type: "text", text: "boom" }])).toBeNull();
    expect(flightdeckStepCount(fd("list_background_tasks"), json({ tasks: "?" }))).toBeNull();
    expect(flightdeckStepCount("Read", json([]))).toBeNull();
  });
});

describe("flightdeckTargetIds", () => {
  it("lists the conversations a label must resolve", () => {
    expect(flightdeckTargetIds(fd("read_conversation"), { conversation_id: "c1" })).toEqual(["c1"]);
    expect(flightdeckTargetIds(fd("list_conversations"), {})).toEqual([]);
    expect(
      flightdeckTargetIds(fd("reopen_conversation"), { session_id: "s" }, json({ conversation_id: "c2" })),
    ).toEqual(["c2"]);
    expect(flightdeckTargetIds("Read", { conversation_id: "c1" })).toEqual([]);
  });
});
