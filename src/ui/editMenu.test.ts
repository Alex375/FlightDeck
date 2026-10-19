import { afterEach, describe, expect, it, vi } from "vitest";
import { editMenuRoute, runEditMenu, type EditMenuDeps } from "./editMenu";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.querySelector("[data-focus]")!;
}

function deps(over: Partial<EditMenuDeps> = {}): EditMenuDeps {
  return {
    undoConversation: vi.fn(() => false),
    monacoEdit: vi.fn(async () => true),
    nativeEdit: vi.fn(),
    frameEdit: vi.fn(async () => {}),
    reportFailure: vi.fn(),
    ...over,
  };
}

describe("editMenuRoute", () => {
  it("gives Monaco its own undo, even from its hidden textarea", () => {
    expect(editMenuRoute(mount('<div class="monaco-editor"><textarea data-focus></textarea></div>'))).toBe(
      "monaco",
    );
  });

  it("leaves the composer, inputs and the terminal their native undo", () => {
    expect(editMenuRoute(mount("<textarea data-focus></textarea>"))).toBe("field");
    expect(editMenuRoute(mount("<input data-focus />"))).toBe("field");
    expect(editMenuRoute(mount('<div class="xterm"><textarea data-focus></textarea></div>'))).toBe("field");
  });

  it("gives a focused frame (the artifact preview) its own native undo", () => {
    expect(editMenuRoute(mount("<iframe data-focus></iframe>"))).toBe("frame");
  });

  it("hands the app the key when nothing editable has focus", () => {
    expect(editMenuRoute(document.body)).toBe("app");
    expect(editMenuRoute(mount('<button data-focus>×</button>'))).toBe("app");
    expect(editMenuRoute(null)).toBe("app");
  });
});

describe("runEditMenu", () => {
  it("⌘Z outside a field restores the deleted conversation, and nothing else", () => {
    const d = deps({ undoConversation: vi.fn(() => true) });
    runEditMenu("undo", document.body, d);
    expect(d.undoConversation).toHaveBeenCalledOnce();
    expect(d.nativeEdit).not.toHaveBeenCalled();
  });

  it("⌘Z outside a field with nothing to restore keeps its native meaning", () => {
    const d = deps();
    runEditMenu("undo", document.body, d);
    expect(d.nativeEdit).toHaveBeenCalledWith("undo");
  });

  it("redo never touches the conversation undo stack", () => {
    const d = deps({ undoConversation: vi.fn(() => true) });
    runEditMenu("redo", document.body, d);
    expect(d.undoConversation).not.toHaveBeenCalled();
    expect(d.nativeEdit).toHaveBeenCalledWith("redo");
  });

  it("⌘Z in the composer is the composer's, never a conversation restore", () => {
    const d = deps({ undoConversation: vi.fn(() => true) });
    runEditMenu("undo", mount("<textarea data-focus></textarea>"), d);
    expect(d.undoConversation).not.toHaveBeenCalled();
    expect(d.nativeEdit).toHaveBeenCalledWith("undo");
  });

  it("⌘Z in Monaco runs Monaco's undo", async () => {
    const d = deps();
    runEditMenu("undo", mount('<div class="monaco-editor"><textarea data-focus></textarea></div>'), d);
    await vi.waitFor(() => expect(d.monacoEdit).toHaveBeenCalledWith("undo"));
    expect(d.nativeEdit).not.toHaveBeenCalled();
    expect(d.undoConversation).not.toHaveBeenCalled();
  });

  it("falls back to the native undo when no Monaco editor has text focus (its find box)", async () => {
    const d = deps({ monacoEdit: vi.fn(async () => false) });
    runEditMenu("undo", mount('<div class="monaco-editor"><input data-focus /></div>'), d);
    await vi.waitFor(() => expect(d.nativeEdit).toHaveBeenCalledWith("undo"));
  });

  it("falls back to the native undo when Monaco's own one throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ monacoEdit: vi.fn(async () => Promise.reject(new Error("boom"))) });
    runEditMenu("undo", mount('<div class="monaco-editor"><textarea data-focus></textarea></div>'), d);
    await vi.waitFor(() => expect(d.nativeEdit).toHaveBeenCalledWith("undo"));
    expect(err).toHaveBeenCalled();
    expect(d.undoConversation).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("⌘Z in the artifact preview is the preview's, never a conversation restore", async () => {
    const d = deps({ undoConversation: vi.fn(() => true) });
    runEditMenu("undo", mount("<iframe data-focus></iframe>"), d);
    await vi.waitFor(() => expect(d.frameEdit).toHaveBeenCalledWith("undo"));
    expect(d.undoConversation).not.toHaveBeenCalled();
    expect(d.nativeEdit).not.toHaveBeenCalled();
  });

  it("says so when the preview's native undo could not be sent", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ frameEdit: vi.fn(async () => Promise.reject(new Error("no main thread"))) });
    runEditMenu("redo", mount("<iframe data-focus></iframe>"), d);
    await vi.waitFor(() => expect(d.reportFailure).toHaveBeenCalledOnce());
    expect(vi.mocked(d.reportFailure).mock.calls[0][0]).toContain("redo");
    err.mockRestore();
  });
});
