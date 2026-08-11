import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { artifactKind, isArtifactUrl, openArtifactView, routeArtifactOpen } from "./artifactOpen";
import { useAppErrors } from "../../store/appErrors";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const openUrlMock = vi.mocked(openUrl);

describe("isArtifactUrl", () => {
  it("matches a canonical hosted-artifact URL", () => {
    expect(isArtifactUrl("https://claude.ai/code/artifact/acecfb35-f63b-49c3-b835-d0c856695a94")).toBe(true);
  });

  it("rejects other claude.ai URLs and non-artifact links", () => {
    expect(isArtifactUrl("https://claude.ai/code/artifacts")).toBe(false); // the gallery, not one artifact
    expect(isArtifactUrl("https://claude.ai/code/session_01ABC")).toBe(false);
    expect(isArtifactUrl("https://example.com/x")).toBe(false);
    expect(isArtifactUrl("/abs/path.html")).toBe(false);
    expect(isArtifactUrl(undefined)).toBe(false);
    expect(isArtifactUrl(null)).toBe(false);
  });

  it("is anchored — must START with the artifact URL, not merely contain it", () => {
    expect(isArtifactUrl("see https://claude.ai/code/artifact/abc")).toBe(false);
  });
});

describe("routeArtifactOpen", () => {
  const base = {
    convId: "conv_1",
    title: "My page",
    favicon: "📊",
    url: "https://claude.ai/code/artifact/abc",
    filePath: "/tmp/claude-501/scratchpad/page.html",
  };

  it("renders a local file in the in-app viewer on a normal host", () => {
    expect(routeArtifactOpen(base)).toEqual({
      kind: "viewer",
      view: { ...base, kind: "html" },
    });
  });

  it("falls back to the browser on an INERT host, even with a local file", () => {
    // The Flight Deck reply modal mounts no side region: routing to the viewer there was a dead
    // click that also left `artifactView` set, popping it open on the next full-screen visit.
    expect(routeArtifactOpen({ ...base, inert: true })).toEqual({
      kind: "browser",
      url: base.url,
    });
  });

  it("falls back to the browser when the temp file is gone", () => {
    expect(routeArtifactOpen({ ...base, filePath: null })).toEqual({
      kind: "browser",
      url: base.url,
    });
  });

  it("has NO route when an inert host has no published link — never a silent dead click", () => {
    expect(routeArtifactOpen({ ...base, url: null, inert: true })).toEqual({ kind: "none" });
    expect(routeArtifactOpen({ ...base, url: null, filePath: null })).toEqual({ kind: "none" });
  });
});

// Every click from an inert host (the Flight Deck reply modal) now goes to the browser, so a
// rejected hand-off is the one reachable failure of this action. Dropping it would leave a
// click that did nothing, with nothing to read.
describe("openArtifactView surfaces a failed browser open", () => {
  const meta = {
    convId: "conv_1",
    title: "My page",
    favicon: null,
    url: "https://claude.ai/code/artifact/abc",
    filePath: "/tmp/page.html",
    inert: true,
  };

  beforeEach(() => {
    openUrlMock.mockReset();
    useAppErrors.setState({ errors: [] });
  });

  it("says nothing when the browser takes it", async () => {
    openUrlMock.mockResolvedValue(undefined);
    openArtifactView(meta);
    await Promise.resolve();
    expect(useAppErrors.getState().errors).toEqual([]);
  });

  it("pushes an app error when the hand-off rejects", async () => {
    openUrlMock.mockRejectedValue(new Error("no handler for https"));
    openArtifactView(meta);
    await Promise.resolve();
    await Promise.resolve();
    const [err] = useAppErrors.getState().errors;
    expect(err?.message).toContain("My page");
    expect(err?.detail).toContain("no handler for https");
  });
});

describe("artifactKind", () => {
  it("md for .md/.markdown, html otherwise", () => {
    expect(artifactKind("/tmp/x.md")).toBe("md");
    expect(artifactKind("/tmp/x.MARKDOWN")).toBe("md");
    expect(artifactKind("/tmp/x.html")).toBe("html");
    expect(artifactKind("/tmp/x")).toBe("html");
    expect(artifactKind(null)).toBe("html");
  });
});
