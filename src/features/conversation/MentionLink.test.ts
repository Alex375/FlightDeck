// Real render test for MentionLink (StreamMarkdown's `a` renderer). Uses
// react-dom/server so it lives in a `*.test.ts` file (the vitest glob) without JSX.
// Proves the DOM the user actually gets: a Markdown file link renders as a clickable
// element WITHOUT any filesystem/existence check — the regression that made real
// Codex file links render as dead, non-clickable text.

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { FileMentionProvider, MentionLink } from "./FileMention";
import { useDisplay } from "../../store/display";

function tree(href: string, cwd: string, inert: boolean) {
  return createElement(FileMentionProvider, {
    convId: "c1",
    cwd,
    inert,
    children: createElement(MentionLink, { href }, "label"),
  });
}

function render(href: string, cwd: string, inert = false): string {
  return renderToStaticMarkup(tree(href, cwd, inert));
}

/**
 * Render through react-dom/client instead of the server renderer. Needed for anything that
 * asserts on a display PREF: zustand's SSR path feeds `useSyncExternalStore` the store's
 * INITIAL state, so a server render never sees a flipped pref and the assertion would pass
 * whatever the code does.
 */
function renderLive(href: string, cwd: string): string {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(tree(href, cwd, false)));
  const html = container.innerHTML;
  act(() => root.unmount());
  container.remove();
  return html;
}

describe("MentionLink rendering", () => {
  it("renders an absolute Codex file link as a clickable element (no existence gate)", () => {
    const html = render("/Users/a/wind_get/app/tide_compute.py:232", "/repo");
    expect(html).toContain("data-filelink");
    expect(html).toContain('role="button"');
    expect(html).toContain("tide_compute.py:232"); // the resolved target is in the title
    expect(html).not.toContain('target="_blank"'); // not a dead web anchor
  });

  it("renders a NON-existent file link as clickable too — the fix", () => {
    // The whole regression: routing never touches the filesystem, so a real link is
    // never downgraded to plain text just because a pathExists probe can't confirm it.
    const html = render("/does/not/exist/foo.ts:9", "/repo");
    expect(html).toContain("data-filelink");
  });

  it("renders a real web URL as an external anchor (unchanged)", () => {
    const html = render("https://example.com", "/repo");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("data-filelink");
  });

  it("renders plain text (never a dead link) when the host has no editor (inert prop)", () => {
    const html = render("/abs/foo.ts", "/repo", true);
    expect(html).not.toContain("data-filelink");
    expect(html).not.toContain("<a ");
    expect(html).toContain("label");
  });

  it("stays clickable when the 'make file paths clickable' pref is OFF (decoupled)", () => {
    // That pref is scoped to the filename on a Read/Write tool STEP ROW; a file link the
    // model wrote in its conversation must be clickable regardless of it.
    useDisplay.getState().set({ clickableFileMentions: false });
    const html = renderLive("/Users/a/app/tide_compute.py:232", "/repo");
    expect(html).toContain("data-filelink");
  });
});

afterEach(() => {
  // Restore the pref (persisted to jsdom localStorage by set()) so tests don't leak.
  useDisplay.getState().set({ clickableFileMentions: true });
});
