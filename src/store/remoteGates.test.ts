// What a conversation on a paired server can't do from this Mac is refused by the STORE too, not
// only hidden by the UI: rewind and fork cut/copy the transcript on this Mac's disk, and a server's
// lives on the server. The refusal must touch NOTHING — above all not stop the live session,
// which can't be undone — and say why, naming the server.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => {
  const ok = (data: unknown = null) => Promise.resolve({ status: "ok", data });
  return {
    commands: {
      upsertConversation: vi.fn(() => ok()),
      upsertRepo: vi.fn(() => ok()),
      stopSession: vi.fn(() => ok()),
      checkRewindTarget: vi.fn(() => ok(null)),
      rewindConversation: vi.fn(() => ok({ removed_prompt: null, removed_lines: 1 })),
      forkConversation: vi.fn(() => ok(null)),
      codexFork: vi.fn(() => ok(null)),
      loadSessionHistory: vi.fn(() => ok([])),
      loadSessionContext: vi.fn(() => ok({ context_tokens: 0 })),
      loadSessionGoal: vi.fn(() => ok(null)),
      loadSessionUsage: vi.fn(() => ok(null)),
      uploadAttachment: vi.fn(() => ok("/home/agent/.cache/flightdeck/uploads/c-remote/notes.md")),
    },
  };
});

import { commands } from "../ipc/client";
import { useAppErrors } from "./appErrors";
import {
  convServerName,
  forkConversation,
  rewindConversation,
  useConversationsStore,
  type Conversation,
} from "./conversationsStore";
import { rewindForkUnavailable, serverLabel } from "./remoteGates";
import { remoteUploadFor } from "../features/conversation/remoteAttach";

const conv = (id: string, repoId: string): Conversation =>
  ({
    id,
    name: id,
    repoId,
    cwd: "/srv/app",
    createdAt: 1,
    lastActivityAt: 1,
    sessionId: `sid-${id}`,
    handle: "session-1",
    liveCwd: null,
    kind: "claude",
  }) as unknown as Conversation;

beforeEach(() => {
  vi.clearAllMocks();
  useAppErrors.setState({ errors: [] });
  useConversationsStore.setState({
    machines: [{ id: "m1", label: "Base" }] as never,
    repos: [
      { id: "r-remote", path: "/srv/app", addedAt: 1, machineId: "m1" },
      { id: "r-orphan", path: "/srv/old", addedAt: 1, machineId: "m-gone" },
      { id: "r-local", path: "/srv/app", addedAt: 1, machineId: null },
    ],
    conversations: [conv("c-remote", "r-remote"), conv("c-orphan", "r-orphan"), conv("c-local", "r-local")],
    activeId: "c-remote",
  });
});

describe("convServerName", () => {
  it("names the server, never 'this Mac' for an unpaired one, and null on this Mac", () => {
    const s = useConversationsStore.getState();
    expect(convServerName(s, "c-remote")).toBe("Base");
    expect(convServerName(s, "c-orphan")).toBe("a server that is no longer paired");
    expect(convServerName(s, "c-local")).toBeNull();
    expect(convServerName(s, "no-such")).toBeNull();
  });

  it("falls back on the phrase for a blank label", () => {
    expect(serverLabel([{ id: "m", label: "  " }], "m")).toBe("a server that is no longer paired");
  });
});

describe("rewind / fork of a conversation on a paired server", () => {
  it("rewind rejects BEFORE any IPC — the live session is never stopped", async () => {
    await expect(rewindConversation("c-remote", "u2", true, "again", 0)).rejects.toThrow(
      rewindForkUnavailable("Base"),
    );
    expect(commands.checkRewindTarget).not.toHaveBeenCalled();
    expect(commands.stopSession).not.toHaveBeenCalled();
    expect(commands.rewindConversation).not.toHaveBeenCalled();
    // Surfaced like every other rewind failure, naming the server.
    expect(useAppErrors.getState().errors.map((e) => e.detail)).toEqual([rewindForkUnavailable("Base")]);
  });

  it("fork rejects before any IPC — no copy, no re-import under a local folder", async () => {
    await expect(forkConversation("c-remote", "a1", false, null, null)).rejects.toThrow(/history lives on that server/);
    expect(commands.forkConversation).not.toHaveBeenCalled();
    expect(useConversationsStore.getState().conversations).toHaveLength(3);
  });

  it("a local conversation still goes through the usual check → stop → cut", async () => {
    await rewindConversation("c-local", "u2", true, "again", 0);
    expect(commands.checkRewindTarget).toHaveBeenCalled();
    expect(commands.rewindConversation).toHaveBeenCalled();
  });
});

describe("remoteUploadFor (the composer's non-image attachments)", () => {
  it("has no uploader on this Mac — the file is mentioned where it is", () => {
    expect(remoteUploadFor("c-local")).toBeUndefined();
  });

  it("copies to the conversation's server, routed by the conversation id", async () => {
    const upload = remoteUploadFor("c-remote");
    expect(upload?.server).toBe("Base");
    expect(await upload!.send("/Users/me/notes.md")).toEqual({
      path: "/home/agent/.cache/flightdeck/uploads/c-remote/notes.md",
    });
    expect(commands.uploadAttachment).toHaveBeenCalledWith("c-remote", "/Users/me/notes.md");
  });

  it("hands the core's refusal back as the inline reason", async () => {
    (commands.uploadAttachment as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "error",
      error: "Couldn't send notes.md to Base: could not reach the server.",
    });
    expect(await remoteUploadFor("c-remote")!.send("/Users/me/notes.md")).toEqual({
      error: "Couldn't send notes.md to Base: could not reach the server.",
    });
  });
});
