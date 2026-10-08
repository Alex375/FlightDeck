import { describe, expect, it } from "vitest";
import { distinctCwds, resolveReloadTargets } from "./pluginReload";
import type { Conversation, Repo } from "../../store/conversationsStore";
import type { ExtensionsTarget } from "./extensionsUiStore";

// Minimal conversation factory — only the fields the resolver reads (id, repoId,
// handle, cwd, liveCwd, kind). The rest of the type is irrelevant here.
function conv(over: Partial<Conversation>): Conversation {
  return { id: "c", repoId: "r1", cwd: "/repo", handle: null, liveCwd: null, kind: "claude", ...over } as unknown as Conversation;
}
const repos: Repo[] = [{ id: "r1", path: "/repo", addedAt: 0 } as unknown as Repo];

describe("resolveReloadTargets", () => {
  it("returns nothing when no target", () => {
    expect(resolveReloadTargets(null, [], repos)).toEqual({ liveConvs: [], currentConv: null });
  });

  it("project lens: repo matched by path, no current, only live convs", () => {
    const convs = [
      conv({ id: "a", repoId: "r1", handle: "session-1", cwd: "/repo" }),
      conv({ id: "b", repoId: "r1", handle: null }), // off
      conv({ id: "z", repoId: "r2", handle: "session-9" }), // other repo
    ];
    const target: ExtensionsTarget = { kind: "project", path: "/repo", title: "repo", session: null, backend: "claude" };
    const { liveConvs, currentConv } = resolveReloadTargets(target, convs, repos);
    expect(currentConv).toBeNull();
    expect(liveConvs.map((c) => c.id)).toEqual(["a"]);
  });

  it("conversation lens with a LIVE current: currentConv set, included in liveConvs", () => {
    const convs = [
      conv({ id: "a", repoId: "r1", handle: "session-1" }),
      conv({ id: "b", repoId: "r1", handle: "session-2" }),
    ];
    const target: ExtensionsTarget = { kind: "conversation", path: "/repo", title: "c", session: "a", backend: "claude" };
    const { liveConvs, currentConv } = resolveReloadTargets(target, convs, repos);
    expect(currentConv?.id).toBe("a");
    expect(liveConvs.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });

  it("conversation lens with an OFF current: no currentConv, still lists other live convs (like repo lens)", () => {
    const convs = [
      conv({ id: "a", repoId: "r1", handle: null }), // current, off
      conv({ id: "b", repoId: "r1", handle: "session-2" }), // sibling, live
    ];
    const target: ExtensionsTarget = { kind: "conversation", path: "/repo", title: "c", session: "a", backend: "claude" };
    const { liveConvs, currentConv } = resolveReloadTargets(target, convs, repos);
    expect(currentConv).toBeNull();
    expect(liveConvs.map((c) => c.id)).toEqual(["b"]);
  });

  it("project lens: a folder is (machine, path) — a same-path folder elsewhere is not it", () => {
    // Server folder FIRST: a path-only `find` would land on it and fail the local case.
    const samePath: Repo[] = [
      { id: "r-srv", path: "/repo", addedAt: 0, machineId: "m1" } as unknown as Repo,
      { id: "r-local", path: "/repo", addedAt: 0 } as unknown as Repo,
    ];
    const convs = [
      conv({ id: "l", repoId: "r-local", handle: "session-1" }),
      conv({ id: "s", repoId: "r-srv", handle: "session-2" }),
    ];
    const base = { kind: "project", path: "/repo", title: "repo", session: null, backend: "claude" } as const;
    const ids = (machineId: string | null) =>
      resolveReloadTargets({ ...base, machineId }, convs, samePath).liveConvs.map((c) => c.id);
    expect(ids(null)).toEqual(["l"]);
    expect(ids("m1")).toEqual(["s"]);
  });

  it("no live conversation → empty liveConvs (bar stays hidden)", () => {
    const convs = [conv({ id: "a", repoId: "r1", handle: null })];
    const target: ExtensionsTarget = { kind: "project", path: "/repo", title: "repo", session: null, backend: "claude" };
    expect(resolveReloadTargets(target, convs, repos).liveConvs).toEqual([]);
  });

  it("live CODEX conversations are out of scope (Claude-only action), as current AND in liveConvs", () => {
    // The bar's action = settings.json toggle + `reload_plugins` (a Claude control
    // request the Codex actor no-ops) + an ephemeral `claude` spawn per cwd — none of
    // it applies to a Codex session, so it must not be counted nor targeted.
    const convs = [
      conv({ id: "a", repoId: "r1", handle: "session-1", kind: "codex" }), // live, but codex
      conv({ id: "b", repoId: "r1", handle: "session-2" }), // live claude
    ];
    const target: ExtensionsTarget = { kind: "conversation", path: "/repo", title: "c", session: "a", backend: "codex" };
    const { liveConvs, currentConv } = resolveReloadTargets(target, convs, repos);
    expect(currentConv).toBeNull(); // the codex lens conv is never a reload target
    expect(liveConvs.map((c) => c.id)).toEqual(["b"]);
  });

  it("a repo with ONLY live codex conversations yields no targets (bar stays hidden)", () => {
    const convs = [
      conv({ id: "a", repoId: "r1", handle: "session-1", kind: "codex" }),
      conv({ id: "b", repoId: "r1", handle: "session-2", kind: "codex" }),
    ];
    const target: ExtensionsTarget = { kind: "project", path: "/repo", title: "repo", session: null, backend: "claude" };
    expect(resolveReloadTargets(target, convs, repos).liveConvs).toEqual([]);
  });
});

describe("distinctCwds", () => {
  it("dedupes effective cwds, prefers liveCwd, skips handle-less convs", () => {
    const convs = [
      conv({ id: "a", handle: "s1", cwd: "/repo", liveCwd: null }),
      conv({ id: "b", handle: "s2", cwd: "/repo", liveCwd: "/repo/.claude/worktrees/x" }),
      conv({ id: "c", handle: "s3", cwd: "/repo", liveCwd: null }), // same as a
      conv({ id: "d", handle: null, cwd: "/other" }), // no handle → skipped
    ];
    expect(distinctCwds(convs).sort()).toEqual(["/repo", "/repo/.claude/worktrees/x"]);
  });
});
