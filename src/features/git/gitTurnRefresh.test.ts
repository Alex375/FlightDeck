import { afterEach, describe, it, expect, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  createGitFsRefresh,
  gitKeysToRefreshOnTurnEnd,
  invalidateGitQueries,
  isGitRefreshEdge,
  localGitCwd,
  pathsTouchCwd,
} from "./gitTurnRefresh";
import type { SessionStatePayload } from "../../ipc/client";

const state = (over: Partial<SessionStatePayload> = {}) =>
  ({ busy: false, ended: false, cwd: null, ...over }) as SessionStatePayload;

const conv = (cwd: string, liveCwd: string | null = null) => ({ cwd, liveCwd });
const local = { path: "/repo" };
const remote = { path: "/srv/repo", machineId: "m1" };

describe("localGitCwd", () => {
  it("follows the effective cwd: liveCwd, then the session's cwd, then the spawn cwd", () => {
    expect(localGitCwd(conv("/repo"), undefined, local)).toBe("/repo");
    expect(localGitCwd(conv("/repo"), state({ cwd: "/repo/sub" }), local)).toBe("/repo/sub");
    expect(
      localGitCwd(conv("/repo", "/repo/.claude/worktrees/x"), state({ cwd: "/repo" }), local),
    ).toBe("/repo/.claude/worktrees/x");
  });

  it("is null for a remote repository — its path is the server's", () => {
    expect(localGitCwd(conv("/srv/repo"), undefined, remote)).toBeNull();
  });

  it("is null for the relative default project", () => {
    expect(localGitCwd(conv("."), undefined, { path: "." })).toBeNull();
  });
});

describe("isGitRefreshEdge", () => {
  it("fires when a turn ends", () => {
    expect(isGitRefreshEdge(state({ busy: true }), state({ busy: false }))).toBe(true);
  });

  it("fires when the process ends", () => {
    expect(isGitRefreshEdge(state(), state({ ended: true }))).toBe(true);
    expect(isGitRefreshEdge(undefined, state({ ended: true }))).toBe(true);
  });

  it("fires once when both happen in the same event", () => {
    expect(isGitRefreshEdge(state({ busy: true }), state({ ended: true }))).toBe(true);
  });

  it("does not fire on a turn start, a steady state or a duplicated event", () => {
    expect(isGitRefreshEdge(state(), state({ busy: true }))).toBe(false);
    expect(isGitRefreshEdge(state({ busy: true }), state({ busy: true }))).toBe(false);
    expect(isGitRefreshEdge(state(), state())).toBe(false);
    expect(isGitRefreshEdge(state({ ended: true }), state({ ended: true }))).toBe(false);
    expect(isGitRefreshEdge(undefined, state())).toBe(false);
  });
});

describe("gitKeysToRefreshOnTurnEnd", () => {
  it("covers the cwd's git reads and the repo's worktree list", () => {
    expect(gitKeysToRefreshOnTurnEnd(conv("/repo", "/repo/.claude/worktrees/x"), undefined, local)).toEqual([
      ["git", "/repo/.claude/worktrees/x", "status"],
      ["git", "/repo/.claude/worktrees/x", "diff"],
      ["git", "/repo/.claude/worktrees/x", "log"],
      ["git", "/repo/.claude/worktrees/x", "branches"],
      ["worktree-status", "/repo/.claude/worktrees/x"],
      ["worktrees", "/repo"],
    ]);
  });

  it("uses the exact cwd string the views key on (no normalising)", () => {
    const keys = gitKeysToRefreshOnTurnEnd(conv("/repo"), state({ cwd: "/repo/sub" }), local);
    expect(keys[0]).toEqual(["git", "/repo/sub", "status"]);
  });

  it("is empty for a remote repository", () => {
    expect(gitKeysToRefreshOnTurnEnd(conv("/srv/repo"), undefined, remote)).toEqual([]);
  });

  it("is empty for a relative cwd", () => {
    expect(gitKeysToRefreshOnTurnEnd(conv("."), undefined, { path: "." })).toEqual([]);
  });

  it("still refreshes the cwd when the repo is unknown", () => {
    expect(gitKeysToRefreshOnTurnEnd(conv("/repo"), undefined, null)).toHaveLength(5);
  });
});

describe("pathsTouchCwd", () => {
  it("matches the folder itself and anything under it", () => {
    expect(pathsTouchCwd(["/repo"], "/repo")).toBe(true);
    expect(pathsTouchCwd(["/other/a", "/repo/src/a.ts"], "/repo")).toBe(true);
    expect(pathsTouchCwd(["/repo/a"], "/repo/")).toBe(true);
  });

  it("ignores a sibling that merely shares the prefix", () => {
    expect(pathsTouchCwd(["/repo-2/a.ts"], "/repo")).toBe(false);
  });

  it("ignores events about another folder", () => {
    expect(pathsTouchCwd(["/elsewhere/a.ts"], "/repo")).toBe(false);
    expect(pathsTouchCwd([], "/repo")).toBe(false);
  });

  it("a cwd it cannot place counts every batch rather than going deaf", () => {
    // "." — the default project before its process reports a real path; the Git workspace keys
    // on it, and every batch refreshed it before the filter existed.
    expect(pathsTouchCwd(["/anywhere/a.ts"], ".")).toBe(true);
    expect(pathsTouchCwd([], ".")).toBe(false);
  });

  it("the filesystem root holds every absolute path", () => {
    expect(pathsTouchCwd(["/anywhere/a.ts"], "/")).toBe(true);
  });

  it("matches the REAL paths the watcher reports for a folder opened another way", () => {
    // FSEvents canonicalizes the watched root: /tmp/x is reported as /private/tmp/x.
    expect(pathsTouchCwd(["/private/tmp/proj/a.ts"], "/tmp/proj")).toBe(true);
    expect(pathsTouchCwd(["/private/var/folders/x/a"], "/var/folders/x")).toBe(true);
    // The default APFS volume ignores case.
    expect(pathsTouchCwd(["/Users/me/Repos/App/a.ts"], "/Users/me/repos/app")).toBe(true);
    // …without widening the match to a sibling.
    expect(pathsTouchCwd(["/private/tmp/proj-2/a.ts"], "/tmp/proj")).toBe(false);
  });
});

describe("invalidateGitQueries", () => {
  const KEY = ["git", "/repo", "status"] as const;
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  afterEach(() => {
    hidden = false;
  });

  /** A query with one ACTIVE observer (a mounted view) whose reads resolve on demand, and a
   *  record of how many ran at once — the `git` process count on the Rust side. */
  function setup() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pending: (() => void)[] = [];
    const t = { calls: 0, inFlight: 0, maxInFlight: 0 };
    const queryFn = () => {
      t.calls++;
      t.inFlight++;
      t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
      const n = t.calls;
      return new Promise<number>((resolve) =>
        pending.push(() => {
          t.inFlight--;
          resolve(n);
        }),
      );
    };
    const observer = new QueryObserver(qc, { queryKey: KEY, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    /** Land the oldest read in flight, then let the promise chains run. */
    const land = async () => {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { qc, t, land, unsubscribe };
  }

  it("re-reads a mounted view at once when nothing is in flight", async () => {
    const { qc, t, land, unsubscribe } = setup();
    await land(); // the mount read
    invalidateGitQueries(qc, ["git", "/repo"]);
    expect(t.calls).toBe(2);
    await land();
    expect(t.calls).toBe(2);
    unsubscribe();
  });

  it("joins a read in flight, then reads once more after it lands — never two at once", async () => {
    const { qc, t, land, unsubscribe } = setup();
    expect(t.inFlight).toBe(1); // the mount read, started BEFORE the change
    invalidateGitQueries(qc, ["git", "/repo"]);
    expect(t.calls).toBe(1);
    await land();
    expect(t.calls).toBe(2);
    await land();
    expect(t.maxInFlight).toBe(1);
    expect(qc.getQueryData(KEY)).toBe(2);
    unsubscribe();
  });

  it("only marks the query stale while the window is hidden", async () => {
    const { qc, t, land, unsubscribe } = setup();
    await land();
    hidden = true;
    invalidateGitQueries(qc, ["git", "/repo"]);
    expect(t.calls).toBe(1);
    expect(qc.getQueryState(KEY)?.isInvalidated).toBe(true);
    unsubscribe();
  });

  it("hidden with a read in flight: the old read landing does not settle the view", async () => {
    // The in-flight read started BEFORE the change; when it lands TanStack clears the
    // invalidation. The follow-up must wait for THAT read — not for this call's own (no-op)
    // refetch — or the view would stay fresh-looking on a pre-change answer.
    const { qc, t, land, unsubscribe } = setup();
    hidden = true;
    invalidateGitQueries(qc, ["git", "/repo"]);
    await land(); // the pre-change read lands
    expect(t.calls).toBe(1); // still hidden: nothing re-read…
    expect(qc.getQueryState(KEY)?.isInvalidated).toBe(true); // …but it stays stale
    unsubscribe();
  });

  it("re-reads only the query that was in flight, never its idle siblings twice", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: Record<string, number> = { a: 0, b: 0 };
    const pending: (() => void)[] = [];
    const observe = (path: string, hold: boolean) =>
      new QueryObserver(qc, {
        queryKey: ["git", "/repo", "diff", path],
        queryFn: () => {
          calls[path]++;
          return hold ? new Promise<number>((r) => pending.push(() => r(calls[path]))) : calls[path];
        },
      }).subscribe(() => {});
    const offA = observe("a", false);
    await new Promise((r) => setTimeout(r, 0)); // a's mount read lands
    const offB = observe("b", true); // b's mount read stays in flight
    invalidateGitQueries(qc, ["git", "/repo", "diff"]);
    expect(calls).toEqual({ a: 2, b: 1 });
    pending.shift()?.(); // b's pre-change read lands
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual({ a: 2, b: 2 });
    offA();
    offB();
  });
});

describe("createGitFsRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake fs-change source: `emit` delivers a batch to every live subscription. */
  function source() {
    const subs = new Set<(paths: readonly string[]) => void>();
    const s = {
      listens: 0,
      live: () => subs.size,
      emit: (...paths: string[]) => subs.forEach((cb) => cb(paths)),
      listen: (cb: (paths: readonly string[]) => void) => {
        s.listens++;
        subs.add(cb);
        return Promise.resolve(() => void subs.delete(cb));
      },
    };
    return s;
  }

  function setup() {
    vi.useFakeTimers();
    const src = source();
    const refreshed: string[] = [];
    const retain = createGitFsRefresh({
      listen: src.listen,
      refresh: (cwd) => refreshed.push(cwd),
      throttleMs: 1000,
    });
    return { src, refreshed, retain };
  }

  it("refreshes once per burst, at its END, with every batch in it", async () => {
    const { src, refreshed, retain } = setup();
    const release = retain("/repo");
    await vi.advanceTimersByTimeAsync(0); // the subscription resolves
    src.emit("/repo/a.ts");
    await vi.advanceTimersByTimeAsync(400);
    src.emit("/repo/b.ts");
    await vi.advanceTimersByTimeAsync(599);
    expect(refreshed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshed).toEqual(["/repo"]);
    // A later batch starts a new window.
    src.emit("/repo/c.ts");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshed).toEqual(["/repo", "/repo"]);
    release();
  });

  it("ignores batches about another folder, and arms no timer for them", async () => {
    const { src, refreshed, retain } = setup();
    const release = retain("/repo");
    await vi.advanceTimersByTimeAsync(0);
    src.emit("/repo-2/a.ts", "/elsewhere/b.ts");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refreshed).toEqual([]);
    release();
  });

  it("two views on one folder share ONE listener and ONE refresh per burst", async () => {
    const { src, refreshed, retain } = setup();
    const releaseA = retain("/repo");
    const releaseB = retain("/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(src.listens).toBe(1);
    src.emit("/repo/a.ts");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshed).toEqual(["/repo"]);
    // One view going away keeps the other's refresher alive.
    releaseA();
    src.emit("/repo/a.ts");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshed).toEqual(["/repo", "/repo"]);
    releaseB();
    expect(src.live()).toBe(0);
  });

  it("the last release unsubscribes and drops a pending refresh", async () => {
    const { src, refreshed, retain } = setup();
    const release = retain("/repo");
    await vi.advanceTimersByTimeAsync(0);
    src.emit("/repo/a.ts");
    release();
    release(); // idempotent
    expect(src.live()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refreshed).toEqual([]);
  });

  it("a release before the subscription resolves still unsubscribes", async () => {
    const { src, retain } = setup();
    const release = retain("/repo");
    release(); // the listen promise has not resolved yet
    await vi.advanceTimersByTimeAsync(0);
    expect(src.live()).toBe(0);
    // …and a new view on the folder gets a fresh refresher.
    const again = retain("/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(src.live()).toBe(1);
    again();
  });

  it("different folders get separate refreshers", async () => {
    const { src, refreshed, retain } = setup();
    const a = retain("/a");
    const b = retain("/b");
    await vi.advanceTimersByTimeAsync(0);
    expect(src.listens).toBe(2);
    src.emit("/b/x");
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshed).toEqual(["/b"]);
    a();
    b();
  });

  it("a listener that fails to subscribe is reported, never swallowed", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const retain = createGitFsRefresh({
      listen: () => Promise.reject(new Error("no bus")),
      refresh: () => {},
      throttleMs: 1000,
      onListenError: (e) => errors.push(e),
    });
    const release = retain("/repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    release();
  });
});
