import { describe, it, expect } from "vitest";
import { askReason, classifyAsk, field } from "./ask";
import type { PermissionRequestPayload } from "../ipc/client";

function req(p: Partial<PermissionRequestPayload>): PermissionRequestPayload {
  return {
    request_id: "r1",
    tool_name: "Bash",
    tool_use_id: "t1",
    input: {},
    title: null,
    description: null,
    suggestions: null,
    blocked_path: null,
    decision_reason: null,
    agent_id: null,
    ...p,
  };
}

describe("classifyAsk", () => {
  it("previews a Bash command", () => {
    const a = classifyAsk(req({ tool_name: "Bash", input: { command: "pnpm test" } }));
    expect(a).toEqual({
      kind: "permission",
      text: "Allow running the command?",
      cmd: "pnpm test",
    });
  });

  it("names the edited file for an edit/write tool", () => {
    const a = classifyAsk(req({ tool_name: "Edit", input: { file_path: "src/x.ts" } }));
    expect(a.kind).toBe("permission");
    expect(a.text).toContain("src/x.ts");
    expect(a.cmd).toBeUndefined();
  });

  it("prefers the request description when present", () => {
    const a = classifyAsk(
      req({ tool_name: "Write", description: "Créer le fichier", input: { file_path: "a" } }),
    );
    expect(a.text).toBe("Créer le fichier");
  });

  it("falls back to the tool name when nothing else is known", () => {
    const a = classifyAsk(req({ tool_name: "WebFetch", input: {} }));
    expect(a.text).toBe("Allow WebFetch?");
  });

  it("ignores an empty description and falls back to the file target", () => {
    // description "" is falsy, so the `||` chain must drop through to the file path.
    const a = classifyAsk(req({ tool_name: "Edit", description: "", input: { file_path: "src/y.ts" } }));
    expect(a.text).toBe("Allow editing src/y.ts?");
  });

  it("falls back to the tool name for an edit with neither description nor file_path", () => {
    const a = classifyAsk(req({ tool_name: "Edit", input: {} }));
    expect(a.text).toBe("Allow Edit?");
  });
});

describe("field", () => {
  it("reads a string field from an input object", () => {
    expect(field({ command: "ls" }, "command")).toBe("ls");
  });

  it("returns undefined for non-objects, arrays, missing keys, or non-strings", () => {
    expect(field(null, "x")).toBeUndefined();
    expect(field([1, 2], "0")).toBeUndefined();
    expect(field({ x: 3 }, "x")).toBeUndefined();
    expect(field({}, "x")).toBeUndefined();
  });
});

describe("askReason", () => {
  it("says nothing when the CLI gave no reason", () => {
    expect(askReason(req({}))).toBeUndefined();
  });

  it("surfaces a blocked path", () => {
    const r = askReason(req({ blocked_path: "/repo/src/App.tsx" }));
    expect(r).toBe("Blocked path: /repo/src/App.tsx");
  });

  it("reads a plain-string decision_reason", () => {
    expect(askReason(req({ decision_reason: "Outside the session worktree" }))).toBe(
      "Outside the session worktree",
    );
  });

  it("reads a conventional key out of an object decision_reason", () => {
    expect(askReason(req({ decision_reason: { message: "Path is fenced" } }))).toBe(
      "Path is fenced",
    );
  });

  it("combines the reason and the path, reason first", () => {
    const r = askReason(req({ decision_reason: "Fenced", blocked_path: "/repo/x.ts" }));
    expect(r).toBe("Fenced · Blocked path: /repo/x.ts");
  });

  it("drops a shapeless decision_reason rather than dumping JSON on the card", () => {
    // An unrecognised object must NOT be stringified: raw JSON in a permission
    // prompt is worse than no explanation at all.
    expect(askReason(req({ decision_reason: { unknown: [1, 2, 3] } }))).toBeUndefined();
    expect(askReason(req({ decision_reason: "   " }))).toBeUndefined();
  });
});
