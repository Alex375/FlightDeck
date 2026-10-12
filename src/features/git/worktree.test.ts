import { describe, it, expect } from "vitest";
import { parseEnterWorktreePath, worktreeCwdFromTranscript } from "./worktree";
import type { ConversationItem } from "../../ipc/client";

const enter = (id: string): ConversationItem => ({
  kind: "assistant_message",
  id: `msg-${id}`,
  blocks: [{ type: "tool_use", id, name: "EnterWorktree", input: {} }],
  parent_tool_use_id: null,
});

const exit = (id: string): ConversationItem => ({
  kind: "assistant_message",
  id: `msg-${id}`,
  blocks: [{ type: "tool_use", id, name: "ExitWorktree", input: {} }],
  parent_tool_use_id: null,
});

const result = (toolUseId: string, content: unknown, isError = false): ConversationItem => ({
  kind: "tool_result",
  tool_use_id: toolUseId,
  content: content as never,
  is_error: isError,
  parent_tool_use_id: null,
});

const text = (s: string): ConversationItem => ({
  kind: "assistant_message",
  id: `msg-text`,
  blocks: [{ type: "text", text: s }],
  parent_tool_use_id: null,
});

const WT = "/Users/me/repo/.claude/worktrees/foo";

describe("parseEnterWorktreePath", () => {
  it("reads the path from a 'Created worktree at … on branch …' message", () => {
    expect(parseEnterWorktreePath(`Created worktree at ${WT} on branch foo. The session…`)).toBe(WT);
  });

  it("reads the path from a 'Switched to worktree at …' message", () => {
    expect(parseEnterWorktreePath(`Switched to worktree at ${WT}\nnext line`)).toBe(WT);
  });

  it("reads the path from an array content of {text} blocks", () => {
    expect(parseEnterWorktreePath([{ text: `worktree at ${WT} on commit abc123` }])).toBe(WT);
  });

  it("returns null when no path is present", () => {
    expect(parseEnterWorktreePath("nothing useful here")).toBeNull();
    expect(parseEnterWorktreePath(undefined)).toBeNull();
  });
});

describe("worktreeCwdFromTranscript", () => {
  it("returns null for a transcript with no worktree activity", () => {
    expect(worktreeCwdFromTranscript([text("hello"), text("world")])).toBeNull();
  });

  it("returns the worktree path after an EnterWorktree", () => {
    const items = [enter("t1"), result("t1", `Created worktree at ${WT} on branch foo`)];
    expect(worktreeCwdFromTranscript(items)).toBe(WT);
  });

  it("returns null after an EnterWorktree followed by an ExitWorktree", () => {
    const items = [
      enter("t1"),
      result("t1", `Created worktree at ${WT} on branch foo`),
      exit("t2"),
      result("t2", "Returned to the main worktree"),
    ];
    expect(worktreeCwdFromTranscript(items)).toBeNull();
  });

  it("follows the LAST EnterWorktree when the agent switches worktrees", () => {
    const other = "/Users/me/repo/.claude/worktrees/bar";
    const items = [
      enter("t1"),
      result("t1", `Created worktree at ${WT} on branch foo`),
      enter("t2"),
      result("t2", `Switched to worktree at ${other} on branch bar`),
    ];
    expect(worktreeCwdFromTranscript(items)).toBe(other);
  });

  it("ignores a failed EnterWorktree (is_error)", () => {
    const items = [enter("t1"), result("t1", "boom", true)];
    expect(worktreeCwdFromTranscript(items)).toBeNull();
  });

  it("stays in the worktree when an ExitWorktree is REFUSED (is_error)", () => {
    // A refused exit ("Worktree has N commits — confirm with the user") did not
    // leave the worktree: the session is still in it, so cwd must stay put.
    const items = [
      enter("t1"),
      result("t1", `Created worktree at ${WT} on branch foo`),
      exit("t2"),
      result("t2", "Worktree has 1 commit — confirm with the user, then re-invoke", true),
    ];
    expect(worktreeCwdFromTranscript(items)).toBe(WT);
  });

  it("exits only on a SUCCESSFUL exit after a refused one (refused → confirmed)", () => {
    const items = [
      enter("t1"),
      result("t1", `Created worktree at ${WT} on branch foo`),
      exit("t2"),
      result("t2", "Worktree has 1 commit — confirm with the user", true),
      exit("t3"),
      result("t3", "Returned to the main worktree"),
    ];
    expect(worktreeCwdFromTranscript(items)).toBeNull();
  });

  it("ignores an EnterWorktree whose result carries no parseable path", () => {
    const items = [enter("t1"), result("t1", "done, no path here")];
    expect(worktreeCwdFromTranscript(items)).toBeNull();
  });
});
