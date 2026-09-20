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

  it("matches the 2.1.272+ shape (claude.ai/artifact/<id>) — else a prose link renders as a bare anchor", () => {
    expect(isArtifactUrl("https://claude.ai/artifact/66XHYkMzjJ4BdfJ64qa3cy")).toBe(true);
  });

  it("rejects other claude.ai URLs and non-artifact links", () => {
    expect(isArtifactUrl("https://claude.ai/code/artifacts")).toBe(false); // the gallery, not one artifact
    expect(isArtifactUrl("https://claude.ai/artifacts")).toBe(false);
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

  it("shows the HOSTED page in-app when the temp file is gone", () => {
    expect(routeArtifactOpen({ ...base, filePath: null })).toEqual({
      kind: "viewer",
      view: { ...base, filePath: null, kind: "hosted" },
    });
  });

  it("falls back to the browser when the temp file is gone and the in-app hosted view is OFF", () => {
    expect(routeArtifactOpen({ ...base, filePath: null, hostedInApp: false })).toEqual({
      kind: "browser",
      url: base.url,
    });
  });

  it("still previews a local PAGE in-app with the hosted view OFF (the pref only governs hosted)", () => {
    expect(routeArtifactOpen({ ...base, hostedInApp: false })).toEqual({
      kind: "viewer",
      view: { ...base, kind: "html" },
    });
  });

  describe("typed artifacts (Claude Design…)", () => {
    // The real fill publish of a Design canvas: its file_path is the DATA index, not a page.
    const typed = {
      ...base,
      title: "Flight Deck — sidebar conversation",
      url: "https://claude.ai/artifact/EB7RRtdoZg1CDk4L3R1Nqg",
      filePath: "/private/tmp/claude-501/x/scratchpad/sidebar-canvas/project/canvas.json",
      typed: true,
    };

    it("NEVER renders the local data file — shows the hosted page in-app instead", () => {
      // Rendering canvas.json as HTML in the iframe was the broken screen this fixes.
      expect(routeArtifactOpen(typed)).toEqual({
        kind: "viewer",
        view: {
          convId: typed.convId,
          title: typed.title,
          favicon: typed.favicon,
          url: typed.url,
          filePath: null,
          kind: "hosted",
        },
      });
    });

    it("goes to the browser with the in-app hosted view OFF", () => {
      expect(routeArtifactOpen({ ...typed, hostedInApp: false })).toEqual({ kind: "browser", url: typed.url });
    });

    it("goes to the browser on an inert host", () => {
      expect(routeArtifactOpen({ ...typed, inert: true })).toEqual({ kind: "browser", url: typed.url });
    });

    it("⚠️ a MULTI-FILE page artifact is hosted too — the local preview can't serve its siblings", () => {
      // A page published with `files` loads them relatively; a srcDoc document under our CSP has
      // no origin to resolve them against, so the preview would silently drop its stylesheet,
      // its script or its data.
      const multi = { ...base, multiFile: true };
      expect(routeArtifactOpen(multi)).toEqual({
        kind: "viewer",
        view: { convId: multi.convId, title: multi.title, favicon: multi.favicon, url: multi.url, filePath: null, kind: "hosted" },
      });
    });

    it("has no route while its creation has no URL yet", () => {
      expect(routeArtifactOpen({ ...typed, url: null, filePath: null })).toEqual({ kind: "none" });
    });
  });

  describe("a prose link is canonicalised before the in-app host sees it", () => {
    // `isArtifactUrl` (what turns a link into a card) is tolerant; the Rust host takes the exact
    // shape only. Without this, a perfectly good link opened an error panel — before the host
    // existed, it opened the browser.
    const prose = { ...base, filePath: null };
    const canonical = "https://claude.ai/artifact/EB7RRtdoZg1CDk4L3R1Nqg";

    it("drops a trailing slash", () => {
      expect(routeArtifactOpen({ ...prose, url: `${canonical}/` })).toEqual({
        kind: "viewer",
        view: { ...prose, url: canonical, filePath: null, kind: "hosted" },
      });
    });

    it("drops an extra path segment and fixes drifted casing", () => {
      expect(routeArtifactOpen({ ...prose, url: `${canonical}/preview` })).toMatchObject({
        kind: "viewer",
        view: { url: canonical },
      });
      expect(routeArtifactOpen({ ...prose, url: "HTTPS://Claude.ai/Artifact/EB7RRtdoZg1CDk4L3R1Nqg" })).toMatchObject({
        kind: "viewer",
        view: { url: canonical },
      });
    });

    it("sends anything that isn't an artifact URL to the browser rather than erroring in-app", () => {
      expect(routeArtifactOpen({ ...prose, url: "https://claude.ai/artifacts" })).toEqual({
        kind: "browser",
        url: "https://claude.ai/artifacts",
      });
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
