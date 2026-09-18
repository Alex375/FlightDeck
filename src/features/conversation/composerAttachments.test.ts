import { describe, expect, it, beforeEach } from "vitest";
import {
  appendMentions,
  attachPaths,
  attachmentFromBlob,
  attachmentsFor,
  basename,
  imageDataUrl,
  MAX_ATTACH_BYTES,
  mentionPath,
  normalizeWireMime,
  useComposerAttachments,
  wireImageMimeForPath,
  type ImageAttachmentDraft,
  type PathAttachResult,
} from "./composerAttachments";
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
    const res = await attachPaths(conv, ["/repo/shot.png", "/repo/notes.md", "/repo/dir"], "/repo", read);
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
    const pending = attachPaths(conv, ["/a.png"], null, read);
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
    await attachPaths(conv, ["/big.png", "/ok.png", "/boom.png", "/big.png"], null, read);
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
    await attachPaths(conv, ["/a.png", "/b.txt"], null, read);
    expect(useComposerDrafts.getState().drafts[conv]).toBe("typed meanwhile /b.txt ");
  });
});
