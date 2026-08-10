// The stored bar is hand-editable JSON in localStorage, so every load path has to
// degrade rather than poison the render. These tests pin that behaviour.
import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "tosse:composer";

/** Seed storage, then import the module fresh so its load() runs against that seed. */
async function loadWith(raw: string | null) {
  localStorage.clear();
  if (raw !== null) localStorage.setItem(STORAGE_KEY, raw);
  vi.resetModules();
  return await import("./composerBar");
}

beforeEach(() => {
  localStorage.clear();
});

describe("loading a stored arrangement", () => {
  it("starts empty when nothing is stored", async () => {
    const { useComposerBar } = await loadWith(null);
    const s = useComposerBar.getState();
    expect(s.hidden).toEqual([]);
    expect(s.customs).toEqual([]);
    expect(s.compactLeft).toEqual({});
  });

  it("falls back to empty on unparsable JSON instead of throwing", async () => {
    const { useComposerBar } = await loadWith("{not json");
    expect(useComposerBar.getState().customs).toEqual([]);
  });

  it("drops a hidden id that names a LEFT-hand chip", async () => {
    // The left side is never hideable. Keeping such an id would make the budget maths
    // and the render disagree — the count would free a slot the bar still draws.
    const { useComposerBar } = await loadWith(JSON.stringify({ hidden: ["model", "cleanOutput"] }));
    expect(useComposerBar.getState().hidden).toEqual(["cleanOutput"]);
  });

  it("keeps compact flags only for left-hand chips", async () => {
    const { useComposerBar } = await loadWith(
      JSON.stringify({ compactLeft: { model: true, cleanOutput: true, ghost: true, effort: false } }),
    );
    expect(useComposerBar.getState().compactLeft).toEqual({ model: true });
  });

  it("drops custom buttons missing an id or an action", async () => {
    const { useComposerBar } = await loadWith(
      JSON.stringify({
        customs: [
          { id: "a", action: "insert-text", icon: "spark", label: "A" },
          { id: "b" },
          { action: "insert-text" },
          null,
        ],
      }),
    );
    expect(useComposerBar.getState().customs.map((c) => c.id)).toEqual(["a"]);
  });

  it("de-duplicates custom buttons sharing an id", async () => {
    const { useComposerBar } = await loadWith(
      JSON.stringify({
        customs: [
          { id: "a", action: "insert-text", label: "first" },
          { id: "a", action: "send-text", label: "second" },
        ],
      }),
    );
    const customs = useComposerBar.getState().customs;
    expect(customs).toHaveLength(1);
    expect(customs[0].label).toBe("first");
  });

  it("gives a button with no icon a usable default", async () => {
    const { useComposerBar } = await loadWith(
      JSON.stringify({ customs: [{ id: "a", action: "insert-text" }] }),
    );
    expect(useComposerBar.getState().customs[0].icon).toBeTruthy();
  });
});

describe("mutations", () => {
  it("persists across a reload", async () => {
    const { useComposerBar } = await loadWith(null);
    useComposerBar.getState().setHidden("cleanOutput", true);
    useComposerBar.getState().setLeftCompact("model", true);

    const again = await loadWith(localStorage.getItem(STORAGE_KEY));
    expect(again.useComposerBar.getState().hidden).toEqual(["cleanOutput"]);
    expect(again.useComposerBar.getState().compactLeft).toEqual({ model: true });
  });

  it("refuses to hide a left-hand chip", async () => {
    const { useComposerBar } = await loadWith(null);
    useComposerBar.getState().setHidden("model", true);
    expect(useComposerBar.getState().hidden).toEqual([]);
  });

  it("refuses a compact flag on a right-hand chip", async () => {
    const { useComposerBar } = await loadWith(null);
    useComposerBar.getState().setLeftCompact("cleanOutput", true);
    expect(useComposerBar.getState().compactLeft).toEqual({});
  });

  it("scrubs a deleted button from the arrangement and the hidden list", async () => {
    // Otherwise the id lingers as a ghost that still holds a position in the order.
    const { useComposerBar } = await loadWith(null);
    const st = useComposerBar.getState();
    st.addCustom({ id: "x", icon: "spark", label: "X", action: "insert-text", arg: "hi" });
    st.setHidden("x", true);
    useComposerBar.getState().setRightOrder(["x", "extensions"]);
    useComposerBar.getState().removeCustom("x");

    const after = useComposerBar.getState();
    expect(after.customs).toEqual([]);
    expect(after.hidden).not.toContain("x");
    expect(after.rightOrder).toEqual(["extensions"]);
  });

  it("edits a button without letting its id be rewritten", async () => {
    const { useComposerBar } = await loadWith(null);
    useComposerBar.getState().addCustom({ id: "x", icon: "spark", label: "X", action: "insert-text" });
    useComposerBar.getState().updateCustom("x", { label: "Renamed" } as never);
    const c = useComposerBar.getState().customs[0];
    expect(c.id).toBe("x");
    expect(c.label).toBe("Renamed");
  });

  it("reset clears everything and the stored blob", async () => {
    const { useComposerBar } = await loadWith(null);
    useComposerBar.getState().setHidden("worktree", true);
    useComposerBar.getState().reset();
    expect(useComposerBar.getState().hidden).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      compactLeft: {},
      hidden: [],
      rightOrder: [],
      customs: [],
    });
  });
});
