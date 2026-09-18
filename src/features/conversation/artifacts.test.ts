import { describe, expect, it } from "vitest";
import type { JsonValue, NormalizedBlock } from "../../ipc/client";
import type { SessionEntry } from "../../store/types";
import {
  artifactUrlFromResult,
  clearAllArtifactsCache,
  clearArtifactsCache,
  memoizedArtifacts,
  selectArtifacts,
} from "./artifacts";

const URL_A = "https://claude.ai/code/artifact/acecfb35-f63b-49c3-b835-d0c856695a94";
const URL_B = "https://claude.ai/code/artifact/cfabdbd7-3294-4092-9927-80c6e795f0d2";

// Verbatim shapes captured from real transcripts (long form 2.1.204+, short form 2.1.201/2).
const LONG = (path: string, url: string) =>
  `Published ${path} at ${url}\n\nTo update: republish the same file path in this conversation (keeps this URL), or pass the URL as \`url\` from any other conversation — a conversation that didn't publish this artifact otherwise mints a new URL. Artifacts are private unless shared from the page's share menu.`;
const SHORT = (path: string, url: string) => `Published ${path} at ${url}`;

function tuse(id: string, input: Record<string, unknown>, name = "Artifact"): NormalizedBlock {
  return { type: "tool_use", id, name, input } as unknown as NormalizedBlock;
}

/** Build a minimal SessionEntry with just the fields selectArtifacts reads. `errored` lists the
 *  tool_use ids whose result should carry is_error:true. */
function entryOf(
  turns: Array<{ id: string; role?: "assistant" | "user"; parent?: string | null; blocks: NormalizedBlock[] }>,
  results: Record<string, JsonValue> = {},
  errored: string[] = [],
): SessionEntry {
  const turnMap: Record<string, unknown> = {};
  const timeline: Array<{ kind: "turn"; id: string }> = [];
  for (const t of turns) {
    turnMap[t.id] = {
      id: t.id,
      role: t.role ?? "assistant",
      status: "final",
      streamingText: "",
      streamingThinking: "",
      blocks: t.blocks,
      parentToolUseId: t.parent ?? null,
      hasThinking: false,
    };
    timeline.push({ kind: "turn", id: t.id });
  }
  const errSet = new Set(errored);
  const toolResults: Record<string, unknown> = {};
  for (const [id, content] of Object.entries(results)) {
    toolResults[id] = { toolUseId: id, content, isError: errSet.has(id), parentToolUseId: null };
  }
  return { timeline, turns: turnMap, toolResults } as unknown as SessionEntry;
}

describe("artifactUrlFromResult", () => {
  it("parses the URL from the long publish ack", () => {
    expect(artifactUrlFromResult(LONG("/tmp/x.html", URL_A))).toBe(URL_A);
  });
  it("parses the URL from the short publish ack", () => {
    expect(artifactUrlFromResult(SHORT("/tmp/x.html", URL_A))).toBe(URL_A);
  });
  it("handles the array content shape ({text})", () => {
    expect(artifactUrlFromResult([{ type: "text", text: SHORT("/tmp/x.html", URL_B) }] as unknown as JsonValue)).toBe(URL_B);
  });
  it("parses the 2.1.272+ URL shape (claude.ai/artifact/<base58 id>, no /code/)", () => {
    // Verbatim first lines of a real 2.1.272 ack: new host path + "(Version N)" suffix + a
    // "Stored — contract …" paragraph. Missing this shape turned every card "Unavailable".
    const url = "https://claude.ai/artifact/66XHYkMzjJ4BdfJ64qa3cy";
    const ack = `Published /private/tmp/claude-501/x/scratchpad/catalogue/index.html at ${url} (Version 1)\n\nStored — contract 0.2.52 · capabilities db · sharing owner.`;
    expect(artifactUrlFromResult(ack)).toBe(url);
  });
  it("does not mistake the artifacts GALLERY for an artifact", () => {
    expect(artifactUrlFromResult("See https://claude.ai/code/artifacts")).toBeNull();
    expect(artifactUrlFromResult("See https://claude.ai/artifacts")).toBeNull();
  });
  it("returns null on empty / missing / non-canonical text (degrade, no dead link)", () => {
    expect(artifactUrlFromResult(undefined)).toBeNull();
    expect(artifactUrlFromResult("")).toBeNull();
    expect(artifactUrlFromResult("something else entirely")).toBeNull();
  });
});

describe("selectArtifacts", () => {
  it("returns [] for an empty/undefined entry", () => {
    expect(selectArtifacts(undefined)).toEqual([]);
    expect(selectArtifacts(entryOf([]))).toEqual([]);
  });

  it("maps one publish → one artifact with url/title/favicon/description", () => {
    const e = entryOf(
      [{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/audit.html", description: "Audit", favicon: "🛫", label: "audit-v1" })] }],
      { u1: SHORT("/tmp/audit.html", URL_A) },
    );
    const arts = selectArtifacts(e);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ url: URL_A, favicon: "🛫", description: "Audit", title: "audit-v1", latestFilePath: "/tmp/audit.html" });
    expect(arts[0].versions).toHaveLength(1);
  });

  it("groups republishes of the same file_path into ONE artifact with N versions (same URL)", () => {
    const e = entryOf(
      [
        { id: "t1", blocks: [tuse("u1", { file_path: "/tmp/f.html", label: "v1", favicon: "🍽️" })] },
        { id: "t2", blocks: [tuse("u2", { file_path: "/tmp/f.html", label: "v2", favicon: "🥗", description: "newer" })] },
      ],
      { u1: SHORT("/tmp/f.html", URL_A), u2: SHORT("/tmp/f.html", URL_A) },
    );
    const arts = selectArtifacts(e);
    expect(arts).toHaveLength(1);
    expect(arts[0].versions).toHaveLength(2);
    expect(arts[0].url).toBe(URL_A);
    // Header reflects the NEWEST version.
    expect(arts[0]).toMatchObject({ favicon: "🥗", description: "newer", title: "v2" });
    expect(arts[0].versions[0].label).toBe("v1"); // oldest-first
    expect(arts[0].versions[1].label).toBe("v2");
  });

  it("keeps distinct file_paths as distinct artifacts, oldest-first", () => {
    const e = entryOf(
      [{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/a.html" }), tuse("u2", { file_path: "/tmp/b.html" })] }],
      { u1: SHORT("/tmp/a.html", URL_A), u2: SHORT("/tmp/b.html", URL_B) },
    );
    const arts = selectArtifacts(e);
    expect(arts.map((a) => a.url)).toEqual([URL_A, URL_B]);
  });

  it("does NOT merge by label (labels repeat across different files)", () => {
    const e = entryOf(
      [{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/a.html", label: "samedi" }), tuse("u2", { file_path: "/tmp/b.html", label: "samedi" })] }],
      { u1: SHORT("/tmp/a.html", URL_A), u2: SHORT("/tmp/b.html", URL_B) },
    );
    expect(selectArtifacts(e)).toHaveLength(2);
  });

  it("excludes sub-agent (parentToolUseId != null) publishes — matches reload's skip_sidechain", () => {
    const e = entryOf(
      [{ id: "t1", parent: "parent-tool", blocks: [tuse("u1", { file_path: "/tmp/sub.html" })] }],
      { u1: SHORT("/tmp/sub.html", URL_A) },
    );
    expect(selectArtifacts(e)).toEqual([]);
  });

  it("skips tool_uses with no file_path (action:list / bare url-update)", () => {
    const e = entryOf([{ id: "t1", blocks: [tuse("u1", { limit: 25 })] }]);
    expect(selectArtifacts(e)).toEqual([]);
  });

  it("skips asset uploads (asset:true carries a file_path but is not a page of its own)", () => {
    const e = entryOf(
      [{ id: "t1", blocks: [tuse("a1", { url: URL_A, file_path: "/tmp/logo.png", asset: true })] }],
      { a1: "Uploaded" },
    );
    expect(selectArtifacts(e)).toEqual([]);
  });

  it("ignores non-Artifact tool_uses", () => {
    const e = entryOf([{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/x.html" }, "Write")] }]);
    expect(selectArtifacts(e)).toEqual([]);
  });

  it("surfaces a pending publish (no result yet) with url null", () => {
    const e = entryOf([{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/x.html", label: "wip" })] }]);
    const arts = selectArtifacts(e);
    expect(arts).toHaveLength(1);
    expect(arts[0].url).toBeNull();
    expect(arts[0].title).toBe("wip");
  });

  it("falls back to the file basename (no extension) when there is no label", () => {
    const e = entryOf(
      [{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/scratch/my-report.html" })] }],
      { u1: SHORT("/tmp/scratch/my-report.html", URL_A) },
    );
    expect(selectArtifacts(e)[0].title).toBe("my-report");
  });

  it("keeps LAST-KNOWN-GOOD header (title/favicon/description) when a republish omits fields", () => {
    const e = entryOf(
      [
        { id: "t1", blocks: [tuse("u1", { file_path: "/tmp/f.html", label: "v1", favicon: "🍽️", description: "first" })] },
        // v2 omits favicon/description/label entirely.
        { id: "t2", blocks: [tuse("u2", { file_path: "/tmp/f.html" })] },
      ],
      { u1: SHORT("/tmp/f.html", URL_A), u2: SHORT("/tmp/f.html", URL_A) },
    );
    const a = selectArtifacts(e)[0];
    // Header keeps the last-known-good values — not blanked by the field-less republish.
    expect(a.favicon).toBe("🍽️");
    expect(a.description).toBe("first");
    expect(a.title).toBe("v1");
    expect(a.versions).toHaveLength(2);
  });

  it("drops an artifact whose every publish terminally FAILED (is_error, no URL)", () => {
    const e = entryOf(
      [{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/f.html", label: "boom" })] }],
      { u1: "Publishing failed: external resource blocked" },
      ["u1"], // errored
    );
    expect(selectArtifacts(e)).toEqual([]);
  });

  it("keeps a still-PENDING publish (no result yet — not an error)", () => {
    const e = entryOf([{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/f.html", label: "wip" })] }]);
    const arts = selectArtifacts(e);
    expect(arts).toHaveLength(1);
    expect(arts[0].url).toBeNull();
  });

  it("keeps an artifact when an EARLIER publish succeeded and a later one failed (URL survives)", () => {
    const e = entryOf(
      [
        { id: "t1", blocks: [tuse("u1", { file_path: "/tmp/f.html", label: "v1" })] },
        { id: "t2", blocks: [tuse("u2", { file_path: "/tmp/f.html", label: "v2" })] },
      ],
      { u1: SHORT("/tmp/f.html", URL_A), u2: "Publishing failed" },
      ["u2"],
    );
    const arts = selectArtifacts(e);
    expect(arts).toHaveLength(1);
    expect(arts[0].url).toBe(URL_A);
    expect(arts[0].versions[1].isError).toBe(true);
  });
});

describe("memoizedArtifacts — ref stability", () => {
  it("returns the SAME array ref while timeline & toolResults are unchanged", () => {
    const e = entryOf([{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/x.html" })] }], { u1: SHORT("/tmp/x.html", URL_A) });
    const a = memoizedArtifacts("s-stable", e);
    const b = memoizedArtifacts("s-stable", e);
    expect(a).toBe(b);
  });

  it("keeps the ref across a recompute whose derived list is unchanged (unrelated result landed)", () => {
    const blocks = [tuse("u1", { file_path: "/tmp/x.html" })];
    const e1 = entryOf([{ id: "t1", blocks }], { u1: SHORT("/tmp/x.html", URL_A) });
    const a = memoizedArtifacts("s-content", e1);
    // A new entry (fresh timeline/toolResults refs) but the SAME artifacts content.
    const e2 = entryOf([{ id: "t1", blocks }], { u1: SHORT("/tmp/x.html", URL_A), other: SHORT("/tmp/y.html", URL_B) });
    const b = memoizedArtifacts("s-content", e2);
    expect(b).toBe(a); // signature unchanged → previous ref kept
  });

  it("produces a NEW ref when an artifact is added", () => {
    const e1 = entryOf([{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/x.html" })] }], { u1: SHORT("/tmp/x.html", URL_A) });
    const a = memoizedArtifacts("s-added", e1);
    const e2 = entryOf(
      [{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/x.html" }), tuse("u2", { file_path: "/tmp/z.html" })] }],
      { u1: SHORT("/tmp/x.html", URL_A), u2: SHORT("/tmp/z.html", URL_B) },
    );
    const b = memoizedArtifacts("s-added", e2);
    expect(b).not.toBe(a);
    expect(b).toHaveLength(2);
  });
});

describe("artifacts cache lifecycle", () => {
  const oneArtifact = () =>
    entryOf([{ id: "t1", blocks: [tuse("u1", { file_path: "/tmp/x.html", label: "keep" })] }], {
      u1: SHORT("/tmp/x.html", URL_A),
    });

  it("clearArtifactsCache drops the memo — the SAME entry recomputes into a fresh array", () => {
    const e = oneArtifact();
    const a = memoizedArtifacts("s-clear", e);
    expect(memoizedArtifacts("s-clear", e)).toBe(a); // memo hit (same timeline/toolResults refs)
    clearArtifactsCache("s-clear");
    const b = memoizedArtifacts("s-clear", e);
    // Recomputed, not the pinned array: nothing of the removed conversation is retained.
    expect(b).not.toBe(a);
    expect(b).toEqual(a); // …but the derivation itself is unchanged
  });

  it("clearArtifactsCache only drops the session asked for", () => {
    const e1 = oneArtifact();
    const e2 = oneArtifact();
    const a = memoizedArtifacts("s-keep-a", e1);
    const b = memoizedArtifacts("s-keep-b", e2);
    clearArtifactsCache("s-keep-a");
    expect(memoizedArtifacts("s-keep-a", e1)).not.toBe(a);
    expect(memoizedArtifacts("s-keep-b", e2)).toBe(b); // untouched neighbour keeps its memo
  });

  it("clearAllArtifactsCache drops every session (wipe-all)", () => {
    const e1 = oneArtifact();
    const e2 = oneArtifact();
    const a = memoizedArtifacts("s-wipe-a", e1);
    const b = memoizedArtifacts("s-wipe-b", e2);
    clearAllArtifactsCache();
    expect(memoizedArtifacts("s-wipe-a", e1)).not.toBe(a);
    expect(memoizedArtifacts("s-wipe-b", e2)).not.toBe(b);
  });

  it("clearing an unknown session is a harmless no-op", () => {
    expect(() => clearArtifactsCache("never-cached")).not.toThrow();
  });
});
