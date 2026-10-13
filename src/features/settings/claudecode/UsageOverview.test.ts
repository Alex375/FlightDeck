// Settings → Claude Code → Overview: the main agents and their helpers on one page, compared.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const day = new Date().toISOString().slice(0, 10);
  const turn = (
    thread: "main" | "helper",
    over: { workflow?: boolean; turns: number; output: number; cacheRead?: number; repo?: string },
  ) => {
    const repo = over.repo ?? "/Users/me/app";
    return {
      day,
      repo,
      repo_label: repo.split("/").pop(),
      thread,
      agent: thread === "main" ? "" : "Explore",
      model: "claude-opus-4-8",
      workflow: over.workflow ?? false,
      turns: over.turns,
      input_tokens: 0,
      output_tokens: over.output,
      cache_read_tokens: over.cacheRead ?? 0,
      cache_creation_tokens: 0,
    };
  };
  return {
    commands: {
      claudeSpend: vi.fn(() =>
        Promise.resolve({
          status: "ok",
          data: {
            buckets: [
              turn("main", { turns: 10, output: 600, cacheRead: 1_000_000 }),
              turn("helper", { turns: 30, output: 300 }),
              turn("helper", { turns: 5, output: 100, workflow: true, repo: "/Users/me/other" }),
            ],
            files_scanned: 3,
            files_unreadable: 0,
            lines_unparsed: 0,
            warnings: [],
          },
        }),
      ),
    },
  };
});
vi.mock("../../../ipc/client", () => ipc);

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConversationsStore } from "../../../store/conversationsStore";
import { ClaudeCodeOverview } from "./UsageOverview";

let container: HTMLDivElement;
let root: Root;
let hadObserver = false;
const onOpenHelpers = vi.fn();

function mount() {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(ClaudeCodeOverview, { onOpenHelpers }),
      ),
    );
  });
}
const text = () => container.textContent ?? "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The charts measure themselves; jsdom has no ResizeObserver.
  const g = globalThis as { ResizeObserver?: unknown };
  hadObserver = "ResizeObserver" in g;
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.clearAllMocks();
  useConversationsStore.setState({ activeId: null, repos: [], conversations: [], machines: [] as never });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (!hadObserver) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

describe("Claude Code → Overview", () => {
  it("counts the main agents and the helpers together, and says how the work splits", async () => {
    mount();
    await vi.waitFor(() => expect(container.querySelector(".cc-tiles")?.textContent).toContain("Turns45"));
    const tiles = container.querySelector(".cc-tiles")!.textContent!;
    expect(tiles).toContain("Output tokens1.0k");
    // 400 of 1 000 output tokens came from helpers (workflow helpers included).
    expect(tiles).toContain("Done by helpers40%");
  });

  it("compares the roles row by row — the main agent's context is what sets it apart", async () => {
    mount();
    await vi.waitFor(() => expect(container.querySelector(".cc-roletable")).not.toBeNull());
    await vi.waitFor(() => expect(container.querySelector(".cc-roletable")?.textContent).toContain("Main agents10"));
    const rows = [...container.querySelectorAll(".cc-roletable tbody tr")].map((r) => r.textContent);
    expect(rows).toHaveLength(3);
    // 1 000 000 cache-read tokens over 10 turns → 100k of context per turn, all from cache.
    expect(rows[0]).toContain("100k");
    expect(rows[0]).toContain("100%");
    expect(rows[1]).toMatch(/^Helpers30/);
    expect(rows[2]).toMatch(/^Workflow helpers5/);
  });

  it("offers every folder the scan saw, main-agent-only folders included", async () => {
    mount();
    await vi.waitFor(() => expect(text()).toContain("Main agents vs helpers"));
    const options = [...container.querySelectorAll("select[aria-label='Folder'] option")].map((o) => o.textContent);
    expect(options).toEqual(["All folders", "app", "other"]);
  });

  it("measures the bar charts in tokens by default, in API cost on request", async () => {
    mount();
    const figure = () =>
      [...container.querySelectorAll("figure")].find((f) =>
        f.querySelector("figcaption")?.textContent?.startsWith("Which models each role runs on"),
      )!;
    const values = () => [...figure().querySelectorAll(".cc-hvalue")].map((v) => v.textContent);
    await vi.waitFor(() => expect(values()).toEqual(["600", "300", "100"]));
    const costButton = [...figure().querySelectorAll("button")].find((b) => b.textContent === "API cost")!;
    act(() => costButton.click());
    // Opus 4.8 ($5 in / $25 out): the main agent's 1M cache-read tokens at 0.1× input dominate.
    expect(values()[0]).toBe("$0.52");
    expect(values().slice(1)).toEqual(["<$0.01", "<$0.01"]);
    // The other bar chart keeps its own switch — still in tokens.
    const folderValues = [...container.querySelectorAll("figure")]
      .find((f) => f.querySelector("figcaption")?.textContent?.startsWith("Per folder"))!
      .querySelectorAll(".cc-hvalue");
    expect([...folderValues].map((v) => v.textContent)).toEqual(["900", "100"]);
  });

  it("links to the Helpers page for the per-helper detail", async () => {
    mount();
    await vi.waitFor(() => expect(text()).toContain("Main agents vs helpers"));
    act(() => (container.querySelector(".cc-footnote button") as HTMLButtonElement).click());
    expect(onOpenHelpers).toHaveBeenCalledOnce();
  });
});
