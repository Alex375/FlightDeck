// Regression test for the artifact viewer's refresh poll — the RECOVERY path.
//
// The poll used to bail while its stamp was null, and only a SUCCESSFUL read ever set that
// stamp: a first read that failed (temp file swept, or the viewer opened before the file
// landed) therefore froze the panel on its error message forever, even though Claude
// re-publishes to the very same path seconds later. The other half of the contract matters
// just as much: retrying must stay bounded, so a file that is durably gone must NOT cost a
// full read every two seconds.
//
// Built with createElement in a `*.test.ts` file (the vitest glob), rendered through
// react-dom/client because the behaviour under test is entirely effects + timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The IPC boundary: a controllable readFile + statFiles. `events` is stubbed because modules
// pulled in by the viewer's import graph arm fs listeners lazily through it.
vi.mock("../../ipc/client", () => ({
  commands: { readFile: vi.fn(), statFiles: vi.fn(), pathExists: vi.fn(async () => false) },
  events: { fsChangeEvent: { listen: vi.fn(async () => () => {}) } },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ArtifactViewer } from "./ArtifactViewer";
import { commands } from "../../ipc/client";

const readFile = commands.readFile as unknown as ReturnType<typeof vi.fn>;
const statFiles = commands.statFiles as unknown as ReturnType<typeof vi.fn>;

/** Must match POLL_MS in ArtifactViewer.tsx. */
const POLL_MS = 2000;
const PATH = "/tmp/claude-501/scratchpad/demo.html";

let container: HTMLDivElement;
let root: Root;

/** A readable file, as `read_file` reports it. */
const okRead = (content: string, size: number, mtime: number) => ({
  status: "ok" as const,
  data: { path: PATH, content, too_large: false, binary: false, size, mtime_ms: mtime },
});

/** The same file as `stat_files` reports it — same size, per the stat↔read consistency rule. */
const okStat = (size: number, mtime: number) => ({
  status: "ok" as const,
  data: [{ path: PATH, exists: true, size, mtime_ms: mtime }],
});

function mount() {
  act(() => {
    root.render(
      createElement(ArtifactViewer, {
        view: { convId: "c1", title: "Demo", favicon: "🎨", url: null, filePath: PATH, kind: "html" },
        onClose: () => {},
      }),
    );
  });
}

/** Let the in-flight IPC promises settle and React apply what they produced. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Run `n` poll ticks, settling the reads each one may trigger. */
async function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await settle();
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  readFile.mockReset();
  statFiles.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("ArtifactViewer refresh poll", () => {
  it("recovers on its own after a failed first read, then goes quiet", async () => {
    readFile.mockResolvedValueOnce({ status: "error", error: "No such file (os error 2)" });
    readFile.mockResolvedValue(okRead("<h1>published</h1>", 18, 1000));
    statFiles.mockResolvedValue(okStat(18, 1000));

    mount();
    await settle();
    // The failure is surfaced verbatim — and nothing is rendered yet.
    expect(container.textContent).toContain("No such file (os error 2)");
    expect(container.querySelector("iframe")).toBeNull();

    await tick();
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("srcdoc")).toContain("<h1>published</h1>");

    // ...and the file being unchanged from here on costs stats only, never re-reads.
    await tick(3);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("retries a doomed read once per distinct file state, not every tick", async () => {
    readFile.mockResolvedValue({ status: "error", error: "permission denied" });
    statFiles.mockResolvedValue({ status: "ok", data: [{ path: PATH, exists: false, size: 0, mtime_ms: null }] });

    mount();
    await settle();
    await tick(5);

    // One initial read + exactly one retry for the "gone" state the poll observed.
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("permission denied");
  });

  it("leaves a healthy preview alone while the file doesn't move", async () => {
    readFile.mockResolvedValue(okRead("<h1>v1</h1>", 11, 500));
    statFiles.mockResolvedValue(okStat(11, 500));

    mount();
    await settle();
    await tick(3);

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>v1</h1>");
  });

  it("re-reads when the same path is re-published under it", async () => {
    readFile.mockResolvedValueOnce(okRead("<h1>v1</h1>", 11, 500));
    readFile.mockResolvedValue(okRead("<h1>v2</h1>", 11, 900));
    statFiles.mockResolvedValueOnce(okStat(11, 500));
    statFiles.mockResolvedValue(okStat(11, 900));

    mount();
    await settle();
    await tick(); // same stamp → no re-read
    expect(readFile).toHaveBeenCalledTimes(1);

    await tick(); // rewritten → new stamp → re-read
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>v2</h1>");
  });
});
