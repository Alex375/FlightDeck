import { describe, expect, it, beforeEach } from "vitest";
import {
  appendMentions,
  attachBlobs,
  attachPaths,
  attachmentFromBlob,
  attachmentsFor,
  basename,
  dropAttachErrors,
  imageDataUrl,
  MAX_ATTACH_BYTES,
  mentionPath,
  mergeAttachErrors,
  normalizeWireMime,
  quoteMention,
  useComposerAttachments,
  wireImageMimeForPath,
  type ImageAttachmentDraft,
  type PathAttachResult,
} from "./composerAttachments";
import { resolveMentionAbs } from "./fileMentions";
import { useComposerDrafts } from "../../store/composerDrafts";

describe("wireImageMimeForPath", () => {
  it("maps model-attachable image extensions to their wire MIME", () => {
    expect(wireImageMimeForPath("/a/b/shot.png")).toBe("image/png");
    expect(wireImageMimeForPath("photo.JPG")).toBe("image/jpeg");
    expect(wireImageMimeForPath("x.jpeg")).toBe("image/jpeg");
    expect(wireImageMimeForPath("x.jfif")).toBe("image/jpeg");
    expect(wireImageMimeForPath("anim.gif")).toBe("image/gif");
    expect(wireImageMimeForPath("pic.webp")).toBe("image/webp");
  });

  it("returns null for non-attachable files (routed to a path mention instead)", () => {
    expect(wireImageMimeForPath("notes.md")).toBeNull();
    expect(wireImageMimeForPath("main.rs")).toBeNull();
    // Image-ish but NOT accepted as an image block by the model.
    expect(wireImageMimeForPath("icon.svg")).toBeNull();
    expect(wireImageMimeForPath("photo.heic")).toBeNull();
    expect(wireImageMimeForPath("Makefile")).toBeNull();
  });
});

describe("normalizeWireMime", () => {
  it("keeps the four supported types and normalizes aliases", () => {
    expect(normalizeWireMime("image/png")).toBe("image/png");
    expect(normalizeWireMime("image/jpeg")).toBe("image/jpeg");
    expect(normalizeWireMime("image/jpg")).toBe("image/jpeg");
    expect(normalizeWireMime("image/apng")).toBe("image/png");
    expect(normalizeWireMime("IMAGE/GIF")).toBe("image/gif");
    expect(normalizeWireMime("image/webp")).toBe("image/webp");
  });

  it("rejects unsupported types", () => {
    expect(normalizeWireMime("image/svg+xml")).toBeNull();
    expect(normalizeWireMime("application/pdf")).toBeNull();
    expect(normalizeWireMime("text/plain")).toBeNull();
  });
});

describe("basename", () => {
  it("returns the last path segment, tolerating trailing slashes", () => {
    expect(basename("/a/b/c.png")).toBe("c.png");
    expect(basename("c.png")).toBe("c.png");
    expect(basename("/a/b/")).toBe("b");
  });
});

describe("imageDataUrl", () => {
  it("builds a data URL from mediaType + base64", () => {
    expect(imageDataUrl({ mediaType: "image/png", dataBase64: "AAAA" })).toBe(
      "data:image/png;base64,AAAA",
    );
  });
});

describe("attachments store", () => {
  const conv = "conv-1";
  const att = (id: string): ImageAttachmentDraft => ({
    id,
    name: `${id}.png`,
    mediaType: "image/png",
    dataBase64: "AAAA",
  });

  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {} });
  });

  it("adds, removes, and clears per conversation", () => {
    const s = useComposerAttachments.getState();
    s.add(conv, att("a"));
    s.add(conv, att("b"));
    s.add("other", att("c"));
    expect(attachmentsFor(conv).map((a) => a.id)).toEqual(["a", "b"]);
    expect(attachmentsFor("other").map((a) => a.id)).toEqual(["c"]);

    s.remove(conv, "a");
    expect(attachmentsFor(conv).map((a) => a.id)).toEqual(["b"]);

    s.clear(conv);
    expect(attachmentsFor(conv)).toEqual([]);
    // Clearing one conversation must not touch another.
    expect(attachmentsFor("other").map((a) => a.id)).toEqual(["c"]);
  });

  it("clearAll drops every conversation's attachments", () => {
    const s = useComposerAttachments.getState();
    s.add(conv, att("a"));
    s.add("other", att("c"));
    s.clearAll();
    expect(attachmentsFor(conv)).toEqual([]);
    expect(attachmentsFor("other")).toEqual([]);
    expect(useComposerAttachments.getState().byConv).toEqual({});
  });

  it("returns a stable empty array for an unknown conversation", () => {
    expect(attachmentsFor("nope")).toEqual([]);
  });
});

describe("attachmentFromBlob", () => {
  it("returns null for an unsupported blob type", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/svg+xml" });
    expect(await attachmentFromBlob(blob, "x.svg")).toBeNull();
  });

  it("rejects a blob over the size ceiling without reading it", async () => {
    // A stub blob past the cap — attachmentFromBlob must bail on size before FileReader.
    const huge = { type: "image/png", size: MAX_ATTACH_BYTES + 1 } as unknown as Blob;
    const res = await attachmentFromBlob(huge, "big.png");
    expect(res && "error" in res ? res.error : null).toMatch(/too large/i);
  });

  it("reads a small supported image into a wire-ready base64 draft", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const res = await attachmentFromBlob(blob, "small.png");
    expect(res && !("error" in res) ? res.mediaType : null).toBe("image/png");
    expect(res && !("error" in res) ? res.dataBase64.length > 0 : false).toBe(true);
  });
});

describe("attachments store — reads in flight + inline error", () => {
  const conv = "conv-1";
  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
  });

  it("counts overlapping reads and forgets the key once they all settle", () => {
    const s = useComposerAttachments.getState();
    s.beginRead(conv);
    s.beginRead(conv);
    expect(useComposerAttachments.getState().reading[conv]).toBe(2);
    s.endRead(conv);
    expect(useComposerAttachments.getState().reading[conv]).toBe(1);
    s.endRead(conv);
    expect(conv in useComposerAttachments.getState().reading).toBe(false);
    // An unbalanced end never goes negative.
    s.endRead(conv);
    expect(conv in useComposerAttachments.getState().reading).toBe(false);
  });

  it("clear drops the conversation's error with its attachments, not another's", () => {
    const s = useComposerAttachments.getState();
    s.setError(conv, "Image too large: a.png");
    s.setError("other", "boom");
    s.clear(conv);
    expect(useComposerAttachments.getState().errors).toEqual({ other: "boom" });
    s.clearAll();
    expect(useComposerAttachments.getState().errors).toEqual({});
  });
});

describe("mentionPath / appendMentions", () => {
  it("makes a path under the cwd relative, keeps any other absolute", () => {
    expect(mentionPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(mentionPath("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
    expect(mentionPath("/elsewhere/doc.pdf", "/repo")).toBe("/elsewhere/doc.pdf");
    // A sibling sharing the prefix is NOT under the cwd.
    expect(mentionPath("/repo-2/x.md", "/repo")).toBe("/repo-2/x.md");
    expect(mentionPath("/repo/x.md", null)).toBe("/repo/x.md");
  });

  it("appends space-separated mentions after the draft, with a trailing space", () => {
    expect(appendMentions("", ["/repo/a.md"], "/repo")).toBe("a.md ");
    expect(appendMentions("look at  \n", ["/repo/a.md", "/b.pdf"], "/repo")).toBe("look at a.md /b.pdf ");
    expect(appendMentions("keep", [], "/repo")).toBe("keep");
  });
});

describe("attachPaths (the + picker and a Finder drop)", () => {
  const conv = "conv-drop";
  const img = (name: string): ImageAttachmentDraft => ({
    id: `id-${name}`,
    name,
    mediaType: "image/png",
    dataBase64: "AAAA",
  });

  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft(conv, "");
  });

  it("routes images to attachments and every other path to a draft mention", async () => {
    useComposerDrafts.getState().setDraft(conv, "see");
    const read = async (p: string): Promise<PathAttachResult> => img(basename(p));
    const res = await attachPaths(conv, ["/repo/shot.png", "/repo/notes.md", "/repo/dir"], "/repo", { read });
    expect(res).toEqual({ mentions: 2 });
    expect(attachmentsFor(conv).map((a) => a.name)).toEqual(["shot.png"]);
    expect(useComposerDrafts.getState().drafts[conv]).toBe("see notes.md dir ");
    expect(useComposerAttachments.getState().errors[conv]).toBeUndefined();
  });

  it("locks the send while images are read, and unlocks after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = async (p: string): Promise<PathAttachResult> => {
      await gate;
      return img(basename(p));
    };
    const pending = attachPaths(conv, ["/a.png"], null, { read });
    expect(useComposerAttachments.getState().reading[conv]).toBe(1);
    release();
    await pending;
    expect(conv in useComposerAttachments.getState().reading).toBe(false);
  });

  it("surfaces every failure at once (deduplicated), keeping the successes", async () => {
    const read = async (p: string): Promise<PathAttachResult> => {
      if (p.endsWith("big.png")) return { error: "Image too large: big.png" };
      if (p.endsWith("boom.png")) throw new Error("ipc down");
      return img(basename(p));
    };
    await attachPaths(conv, ["/big.png", "/ok.png", "/boom.png", "/big.png"], null, { read });
    expect(attachmentsFor(conv).map((a) => a.name)).toEqual(["ok.png"]);
    const err = useComposerAttachments.getState().errors[conv];
    expect(err).toBe("Image too large: big.png · Failed to read image boom.png: ipc down");
    // The lock is released even when a read threw.
    expect(conv in useComposerAttachments.getState().reading).toBe(false);
  });

  it("clears the previous error on a new attempt, even an empty one (cancelled picker)", async () => {
    useComposerAttachments.getState().setError(conv, "old");
    const res = await attachPaths(conv, [], null);
    expect(res).toEqual({ mentions: 0 });
    expect(useComposerAttachments.getState().errors[conv]).toBeUndefined();
  });

  it("appends to the draft as it is AFTER the reads (typing during a read is kept)", async () => {
    const read = async (p: string): Promise<PathAttachResult> => {
      useComposerDrafts.getState().setDraft(conv, "typed meanwhile");
      return img(basename(p));
    };
    await attachPaths(conv, ["/a.png", "/b.txt"], null, { read });
    expect(useComposerDrafts.getState().drafts[conv]).toBe("typed meanwhile /b.txt ");
  });
});

describe("quoteMention", () => {
  it("leaves a whitespace-free path alone", () => {
    expect(quoteMention("docs/spec.md")).toBe("docs/spec.md");
    expect(quoteMention("/a/b-c_d.png")).toBe("/a/b-c_d.png");
  });

  it("wraps a path containing whitespace so it stays ONE token for the agent", () => {
    expect(quoteMention("Capture d ecran 2026-09-19 a 14.03.21.pdf")).toBe(
      "`./Capture d ecran 2026-09-19 a 14.03.21.pdf`",
    );
    // A backtick inside the path widens the fence (and pads it when it sits on an edge)
    // so the span still closes around the whole path.
    expect(quoteMention("a `b` c.md")).toBe("``./a `b` c.md``");
    expect(quoteMention("my file`")).toBe("`` ./my file` ``");
  });

  it("anchors a RELATIVE quoted path with ./ (an absolute one is already anchored)", () => {
    // The anchor is not cosmetic: it is the whole reason the resolver takes the path
    // back once the fence is gone — see the round-trip test below.
    expect(quoteMention("shots/my file.png")).toBe("`./shots/my file.png`");
    expect(quoteMention("/Volumes/nas/My Pictures/a b.png")).toBe(
      "`/Volumes/nas/My Pictures/a b.png`",
    );
    expect(quoteMention("../out/my file.png")).toBe("`../out/my file.png`");
  });

  it("appendMentions quotes only the mentions that need it", () => {
    expect(appendMentions("", ["/repo/my file.pdf", "/repo/a.md"], "/repo")).toBe(
      "`./my file.pdf` a.md ",
    );
  });
});

// What the composer puts on the WIRE for a path with spaces: one inline-code token, so
// the agent reads a single path instead of several. The resolver deliberately does NOT
// take it back (see quoteMention's note) — a chip was never at stake on a user turn, so
// these pin the wire shape only.
describe("quoteMention — the shape that reaches the agent", () => {
  /** What a Markdown parser hands a consumer for an inline-code span: the span's
   *  CONTENT — fence stripped, one padding space removed from each end. */
  const codeSpanContent = (md: string): string => {
    const m = /^(`+)([\s\S]*?)\1$/.exec(md.trim());
    if (!m) return md.trim();
    const body = m[2];
    return body.startsWith(" ") && body.endsWith(" ") ? body.slice(1, -1) : body;
  };

  it("sends a spaced path under the cwd as ONE ./-anchored token", () => {
    const abs = "/repo/shots/Capture d ecran 2026-09-19 a 14.03.21.png";
    const inner = codeSpanContent(appendMentions("", [abs], "/repo"));
    expect(inner).toBe("./shots/Capture d ecran 2026-09-19 a 14.03.21.png");
    expect(resolveMentionAbs("/repo", inner)).toBe(abs);
  });

  it("sends a spaced path outside the cwd as ONE absolute token", () => {
    const abs = "/Volumes/nas/My Pictures/holiday 01.png";
    const inner = codeSpanContent(appendMentions("", [abs], "/repo"));
    expect(inner).toBe(abs);
    expect(resolveMentionAbs("/repo", inner)).toBe(abs);
  });
});

describe("mergeAttachErrors", () => {
  it("unions with what another batch already surfaced, deduplicated", () => {
    expect(mergeAttachErrors(null, ["a"])).toBe("a");
    expect(mergeAttachErrors("a", ["b"])).toBe("a · b");
    expect(mergeAttachErrors("a · b", ["b", "c"])).toBe("a · b · c");
    expect(mergeAttachErrors(null, [])).toBeNull();
  });
});

describe("attachPaths — a read that never settles", () => {
  const conv = "conv-stall";
  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft(conv, "");
  });

  it("gives up on the deadline, so the send lock is never permanent", async () => {
    // A network share that went away: read_image stays blocked in fs::read and the
    // invoke never resolves. Without a deadline `reading[conv]` would stay at 1 forever
    // and Enter would be a silent no-op for the rest of the app's life.
    const read = () => new Promise<PathAttachResult>(() => {});
    await attachPaths(conv, ["/Volumes/nas/shot.png"], null, { read, timeoutMs: 5 });
    expect(conv in useComposerAttachments.getState().reading).toBe(false);
    expect(useComposerAttachments.getState().errors[conv]).toMatch(/timed out/i);
  });
});

describe("attachPaths — the conversation is deleted while reading", () => {
  const conv = "conv-gone";
  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft(conv, "");
  });

  it("writes back neither attachments nor a persisted draft for a dead conversation", async () => {
    let alive = true;
    const read = async (p: string): Promise<PathAttachResult> => {
      alive = false; // the card was removed while the image was being read
      return { id: "i", name: basename(p), mediaType: "image/png", dataBase64: "AAAA" };
    };
    const res = await attachPaths(conv, ["/a.png", "/notes.md"], null, {
      read,
      isAlive: () => alive,
    });
    expect(res).toEqual({ mentions: 0 });
    expect(attachmentsFor(conv)).toEqual([]);
    expect(useComposerDrafts.getState().drafts[conv] ?? "").toBe("");
    expect(useComposerAttachments.getState().errors[conv]).toBeUndefined();
  });
});

describe("attachPaths — overlapping batches", () => {
  const conv = "conv-overlap";
  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft(conv, "");
  });

  it("keeps a fast batch's failure when a slower one finishes after it", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const slow = attachPaths(conv, ["/slow.png"], null, {
      read: async () => {
        await slowGate;
        return { error: "Image too large: slow.png" };
      },
    });
    // B starts while A is still reading, fails, and posts its error…
    await attachPaths(conv, ["/fast.png"], null, {
      read: async () => ({ error: "Failed to read image: fast.png" }),
    });
    expect(useComposerAttachments.getState().errors[conv]).toBe("Failed to read image: fast.png");
    // …A settling afterwards must ADD to it, not erase it.
    releaseSlow();
    await slow;
    expect(useComposerAttachments.getState().errors[conv]).toBe(
      "Failed to read image: fast.png · Image too large: slow.png",
    );
  });
});

describe("attachBlobs (pasting an image)", () => {
  const conv = "conv-paste";
  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft(conv, "");
  });

  it("goes through the same send lock as the + button and lands as an attachment", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const pending = attachBlobs(conv, [{ blob, name: "Pasted image" }]);
    expect(useComposerAttachments.getState().reading[conv]).toBe(1);
    await pending;
    expect(conv in useComposerAttachments.getState().reading).toBe(false);
    expect(attachmentsFor(conv).map((a) => a.name)).toEqual(["Pasted image"]);
  });

  it("surfaces an unsupported blob and an oversized one together, merged", async () => {
    const svg = new Blob([new Uint8Array([1])], { type: "image/svg+xml" });
    const huge = { type: "image/png", size: MAX_ATTACH_BYTES + 1 } as unknown as Blob;
    await attachBlobs(conv, [
      { blob: svg, name: "logo.svg" },
      { blob: huge, name: "big.png" },
    ]);
    const err = useComposerAttachments.getState().errors[conv] ?? "";
    expect(err).toMatch(/Unsupported image format.*logo\.svg/);
    expect(err).toMatch(/too large.*big\.png/);
    expect(attachmentsFor(conv)).toEqual([]);
  });
});

// Unit spec of a helper introduced with the narrow cleanup below (it could not exist
// before, so this is a spec rather than a before/after proof — the proof is the
// "dead conversation cleans up only its OWN batch" case).
describe("dropAttachErrors", () => {
  it("removes only the listed failures, keeping everything else", () => {
    expect(dropAttachErrors("a · b · c", ["b"])).toBe("a · c");
    expect(dropAttachErrors("a", ["a"])).toBeNull();
    expect(dropAttachErrors("a · b", ["zzz"])).toBe("a · b");
    expect(dropAttachErrors(null, ["a"])).toBeNull();
  });
});

describe("attachPaths — a whole multi-file batch", () => {
  const conv = "conv-batch";
  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft(conv, "");
  });

  it("bounds the BATCH, not just each read, and says how many it skipped", async () => {
    // 5 images from a share that went away. The send lock is taken ONCE for the whole
    // batch and the reads run one after another, so a per-file deadline alone would keep
    // the composer disabled for 5 × timeoutMs with no way to cancel — at production
    // values (60 s each) a 30-image drop is half an hour of dead composer.
    const read = () => new Promise<PathAttachResult>(() => {});
    const paths = Array.from({ length: 5 }, (_, i) => `/Volumes/nas/${i}.png`);
    const startedAt = Date.now();
    await attachPaths(conv, paths, null, { read, timeoutMs: 200, batchTimeoutMs: 30 });
    // Bounded by the BATCH budget (~30 ms), not by 5 × 200 ms.
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(conv in useComposerAttachments.getState().reading).toBe(false);
    const err = useComposerAttachments.getState().errors[conv] ?? "";
    expect(err).toMatch(/timed out/i);
    expect(err).toMatch(/4 images not read/);
  });

  it("shows a failure WHILE the rest of the batch is still reading", async () => {
    // The user has to learn that a file failed as it fails, not once the slowest read in
    // the batch settles (which may be a minute later, or never).
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const pending = attachPaths(conv, ["/boom.png", "/slow.png"], null, {
      read: async (p) => {
        if (p.endsWith("boom.png")) return { error: "Image too large: boom.png" };
        await slowGate;
        return { id: "slow", name: "slow.png", mediaType: "image/png", dataBase64: "AAAA" };
      },
    });
    // A macrotask: every pending microtask has run, so the first read has settled while
    // the second is still parked on its gate.
    await new Promise((r) => setTimeout(r, 0));
    expect(useComposerAttachments.getState().reading[conv]).toBe(1);
    expect(useComposerAttachments.getState().errors[conv]).toBe("Image too large: boom.png");
    releaseSlow();
    await pending;
  });
});

describe("attachPaths — a dead conversation cleans up only its OWN batch", () => {
  const conv = "conv-shared";
  const img = (name: string): ImageAttachmentDraft => ({
    id: `id-${name}`,
    name,
    mediaType: "image/png",
    dataBase64: "AAAA",
  });

  beforeEach(() => {
    useComposerAttachments.setState({ byConv: {}, reading: {}, errors: {} });
    useComposerDrafts.getState().setDraft(conv, "");
  });

  it("takes back its own attachment and leaves a concurrent batch's untouched", async () => {
    // Two drops land on the same Flight Deck card. The first one is still reading when
    // the card is removed; wiping the conversation's whole slate would also delete what
    // the second drop had already put there.
    let alive = true;
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const batchA = attachPaths(conv, ["/a1.png", "/a2.png"], null, {
      read: async (p) => {
        if (p.endsWith("a2.png")) {
          await gateA;
          alive = false; // the card went away mid-read
        }
        return img(basename(p));
      },
      isAlive: () => alive,
    });
    await attachPaths(conv, ["/b.png", "/bad.png"], null, {
      read: async (p) =>
        p.endsWith("bad.png") ? { error: "Image too large: bad.png" } : img(basename(p)),
    });
    expect(attachmentsFor(conv).map((a) => a.name).sort()).toEqual(["a1.png", "b.png"]);
    expect(useComposerAttachments.getState().errors[conv]).toBe("Image too large: bad.png");

    releaseA();
    await batchA;
    expect(attachmentsFor(conv).map((a) => a.name)).toEqual(["b.png"]);
    expect(useComposerAttachments.getState().errors[conv]).toBe("Image too large: bad.png");
  });
});
