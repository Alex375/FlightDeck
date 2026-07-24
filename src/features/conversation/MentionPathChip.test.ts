// Scope test for the "clickable file paths (Read/Write tools)" pref. It governs exactly ONE
// surface — the filename on a tool STEP ROW, whose click competes with the row's own expand
// toggle. The regression it locks: folding that pref into the provider's global `inert` made
// it kill EVERY clickable path in the app (prose, Markdown links, snippet headers), in the
// conversation and on Flight Deck alike.
//
// Renders through react-dom/client (NOT renderToStaticMarkup): zustand's SSR path feeds
// `useSyncExternalStore` the store's INITIAL state, so a server render can never observe a
// pref flip — the assertions would pass no matter what the pref does. Lives in a `*.test.ts`
// file (the vitest glob) so it builds its elements with createElement, no JSX.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileMentionProvider, MentionPathChip } from "./FileMention";
import { useDisplay } from "../../store/display";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // Restore the pref (persisted to jsdom localStorage by set()) so tests don't leak.
  useDisplay.getState().set({ clickableFileMentions: true });
});

/** Mount one chip and report whether it rendered as a clickable link. */
function isClickable({ stepRow, inert = false }: { stepRow: boolean; inert?: boolean }): boolean {
  act(() => {
    root.render(
      createElement(FileMentionProvider, {
        convId: "c1",
        cwd: "/repo",
        inert,
        children: createElement(MentionPathChip, {
          path: "/repo/src/app.ts",
          display: "app.ts",
          stepRow,
        }),
      }),
    );
  });
  expect(container.textContent).toBe("app.ts"); // rendered either way, only the link differs
  return container.querySelector("[data-filelink]") != null;
}

describe("MentionPathChip and the clickable-file-paths pref", () => {
  it("is clickable on both surfaces when the pref is ON", () => {
    expect(isClickable({ stepRow: true })).toBe(true);
    expect(isClickable({ stepRow: false })).toBe(true);
  });

  it("drops clickability on the STEP ROW when the pref is OFF", () => {
    useDisplay.getState().set({ clickableFileMentions: false });
    expect(isClickable({ stepRow: true })).toBe(false);
  });

  it("keeps the snippet-header chip clickable when the pref is OFF — the fix", () => {
    useDisplay.getState().set({ clickableFileMentions: false });
    expect(isClickable({ stepRow: false })).toBe(true);
  });

  it("renders plain text on every surface when the host has no editor (inert)", () => {
    expect(isClickable({ stepRow: false, inert: true })).toBe(false);
    expect(isClickable({ stepRow: true, inert: true })).toBe(false);
  });
});
