import { describe, it, expect } from "vitest";
import type { DiskConversation, SearchHit } from "../../ipc/client";
import {
  applySearch,
  filterConversations,
  groupByRepoRoot,
  mergeListings,
  periodCutoff,
  repoKey,
  rowKey,
  serverNotices,
  timeAgo,
} from "./historyView";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function conv(over: Partial<DiskConversation> & { session_id: string }): DiskConversation {
  return {
    session_id: over.session_id,
    cwd: over.cwd ?? "/repo",
    repo_root: over.repo_root ?? "/repo",
    git_branch: over.git_branch ?? null,
    title: over.title ?? null,
    excerpt: over.excerpt ?? "",
    mtime_ms: over.mtime_ms ?? NOW,
    backend: over.backend ?? "claude",
    machine_id: over.machine_id ?? null,
  };
}

describe("periodCutoff", () => {
  it("maps buckets to the right cutoff", () => {
    expect(periodCutoff("all", NOW)).toBe(0);
    expect(periodCutoff("today", NOW)).toBe(NOW - DAY);
    expect(periodCutoff("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(periodCutoff("30d", NOW)).toBe(NOW - 30 * DAY);
  });
});

describe("filterConversations", () => {
  const convs = [
    conv({ session_id: "recent", repo_root: "/a", mtime_ms: NOW - DAY / 2 }),
    conv({ session_id: "old", repo_root: "/a", mtime_ms: NOW - 10 * DAY }),
    conv({ session_id: "other-repo", repo_root: "/b", mtime_ms: NOW }),
  ];

  it("filters by recency window", () => {
    const got = filterConversations(convs, { repoKey: null, period: "today", now: NOW });
    expect(got.map((c) => c.session_id)).toEqual(["recent", "other-repo"]);
  });

  it("filters by repo root", () => {
    const got = filterConversations(convs, { repoKey: repoKey({ repo_root: "/a" }), period: "all", now: NOW });
    expect(got.map((c) => c.session_id)).toEqual(["recent", "old"]);
  });

  it("with no repo + all period keeps everything", () => {
    expect(filterConversations(convs, { repoKey: null, period: "all", now: NOW })).toHaveLength(3);
  });
});

describe("groupByRepoRoot", () => {
  it("groups and orders groups + members by recency", () => {
    // Input is most-recent-first (as the core returns it).
    const convs = [
      conv({ session_id: "b-new", repo_root: "/b", mtime_ms: NOW }),
      conv({ session_id: "a-new", repo_root: "/a", mtime_ms: NOW - DAY }),
      conv({ session_id: "a-old", repo_root: "/a", mtime_ms: NOW - 5 * DAY }),
    ];
    const groups = groupByRepoRoot(convs);
    // /b has the most-recent conversation → first group.
    expect(groups.map((g) => g.repoRoot)).toEqual(["/b", "/a"]);
    expect(groups[1].conversations.map((c) => c.session_id)).toEqual(["a-new", "a-old"]);
  });
});

describe("applySearch", () => {
  const convs = [
    conv({ session_id: "x", mtime_ms: NOW - DAY }),
    conv({ session_id: "y", mtime_ms: NOW }),
    conv({ session_id: "z", mtime_ms: NOW }),
  ];

  it("orders by score, attaches snippets, drops non-matches", () => {
    const hits: SearchHit[] = [
      { session_id: "y", score: 40, snippet: "snip-y" },
      { session_id: "x", score: 100, snippet: "snip-x" },
    ];
    const rows = applySearch(convs, hits);
    expect(rows.map((r) => r.conv.session_id)).toEqual(["x", "y"]); // x scores higher
    expect(rows[0].snippet).toBe("snip-x");
    // z had no hit → absent.
    expect(rows.find((r) => r.conv.session_id === "z")).toBeUndefined();
  });

  it("breaks score ties by recency", () => {
    const hits: SearchHit[] = [
      { session_id: "x", score: 50, snippet: "" },
      { session_id: "y", score: 50, snippet: "" },
    ];
    const rows = applySearch(convs, hits);
    // y is newer → first on a score tie.
    expect(rows.map((r) => r.conv.session_id)).toEqual(["y", "x"]);
  });
});

describe("rows of paired servers", () => {
  // The same session id and the same path on this Mac and on a server are two rows and two
  // folders: a row is (machine, session), a folder (machine, path).
  const local = [
    conv({ session_id: "s1", repo_root: "/srv/app", mtime_ms: NOW - 2 * DAY }),
    conv({ session_id: "s2", repo_root: "/srv/app", mtime_ms: NOW - 4 * DAY }),
  ];
  const onServer = [
    conv({ session_id: "s1", repo_root: "/srv/app", mtime_ms: NOW - DAY, machine_id: "m1" }),
    conv({ session_id: "s3", repo_root: "/srv/app", mtime_ms: NOW - 3 * DAY, machine_id: "m1" }),
  ];

  it("merges this Mac's listing and each server's, most recent first", () => {
    const merged = mergeListings(local, [onServer, []]);
    expect(merged.map((c) => rowKey(c))).toEqual([
      rowKey({ session_id: "s1", machine_id: "m1" }),
      rowKey({ session_id: "s1" }),
      rowKey({ session_id: "s3", machine_id: "m1" }),
      rowKey({ session_id: "s2" }),
    ]);
    expect(rowKey({ session_id: "s1", machine_id: null })).toBe(rowKey({ session_id: "s1" }));
  });

  it("groups and filters by (machine, folder), never by path alone", () => {
    const merged = mergeListings(local, [onServer]);
    const groups = groupByRepoRoot(merged);
    expect(groups.map((g) => [g.machineId, g.repoRoot, g.conversations.length])).toEqual([
      ["m1", "/srv/app", 2],
      [null, "/srv/app", 2],
    ]);
    const serverOnly = filterConversations(merged, { repoKey: groups[0].key, period: "all", now: NOW });
    expect(serverOnly.map((c) => c.machine_id)).toEqual(["m1", "m1"]);
  });

  it("joins each hit to the row of its own machine", () => {
    const merged = mergeListings(local, [onServer]);
    const hits: SearchHit[] = [
      { session_id: "s1", machine_id: "m1", score: 10, snippet: "on the server" },
      { session_id: "s1", machine_id: null, score: 5, snippet: "on this Mac" },
      // A hit on a server whose rows are not shown (out of reach) joins nothing.
      { session_id: "s9", machine_id: "m2", score: 99, snippet: "" },
    ];
    const rows = applySearch(merged, hits);
    expect(rows.map((r) => [r.conv.machine_id, r.snippet])).toEqual([
      ["m1", "on the server"],
      [null, "on this Mac"],
    ]);
  });
});

describe("serverNotices", () => {
  const machines = [
    { id: "a", label: "josty-CC" },
    { id: "b", label: "Base" },
    { id: "c", label: "Quiet" },
    { id: "d", label: "Idle" },
  ];

  it("says which server is loading, out of reach, cut short or holding unreadable transcripts", () => {
    const notices = serverNotices(machines, {
      a: { status: "error", error: { kind: "unreachable", server: "josty-CC", reason: "connection timed out" } },
      b: { status: "ok", pending: 3, unreadable: 1 },
      c: { status: "loading" },
      d: { status: "ok", pending: 0, unreadable: 0 },
    });
    expect(notices).toEqual([
      { machineId: "a", tone: "error", text: "josty-CC unreachable: its conversations are not listed (connection timed out)." },
      { machineId: "b", tone: "info", text: "3 conversation(s) on Base not read yet — reopen History to read them." },
      { machineId: "b", tone: "error", text: "1 transcript(s) on Base could not be read (permission or I/O): not listed." },
      { machineId: "c", tone: "info", text: "Reading the conversations on Quiet…" },
    ]);
  });

  it("names the server in any other failure too", () => {
    const [n] = serverNotices(machines.slice(0, 1), {
      a: { status: "error", error: { kind: "io", server: "josty-CC", reason: "cannot read /home/josty/.claude/projects" } },
    });
    expect(n.text).toBe(
      "josty-CC's conversations are not listed: couldn't read it on josty-CC — cannot read /home/josty/.claude/projects.",
    );
  });
});

describe("timeAgo", () => {
  it("renders coarse relative buckets", () => {
    expect(timeAgo(NOW, NOW)).toBe("just now");
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(timeAgo(NOW - 4 * DAY, NOW)).toBe("4 d ago");
  });
});
