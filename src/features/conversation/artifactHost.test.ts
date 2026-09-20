import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The manager talks to the native view over IPC — mocked here so the whole state machine (show /
// hide / move / retry / idle-close, and the load watchdog) is testable without a webview.
type HostEvent = { payload: { kind: string; url: string } };
// `vi.hoisted` — the mock factory is hoisted above the file, so it cannot close over ordinary
// top-level consts.
type IpcResult = { status: "ok"; data: null } | { status: "error"; error: string };
type ShowResult = { status: "ok"; data: boolean } | { status: "error"; error: string };
const mocked = vi.hoisted(() => {
  type R = { status: "ok"; data: null } | { status: "error"; error: string };
  type ShowR = { status: "ok"; data: boolean } | { status: "error"; error: string };
  type Bounds = { x: number; y: number; width: number; height: number };
  const ok = async (): Promise<R> => ({ status: "ok", data: null });
  // Mirrors the REAL host: `show` navigates only when the view isn't already on that URL, and
  // says so. Modelling that idempotency is the point — assuming a navigation always happens is
  // what hid a retry that could never recover.
  const held = { url: null as string | null };
  const show = async (url: string, _bounds: Bounds, _zoom: number): Promise<ShowR> => {
    const navigated = held.url !== url;
    held.url = url;
    return { status: "ok", data: navigated };
  };
  const reload = async (): Promise<R> =>
    held.url ? { status: "ok", data: null } : { status: "error", error: "no artifact is loaded in the view" };
  const close = async (): Promise<R> => {
    held.url = null;
    return { status: "ok", data: null };
  };
  const commands = {
    artifactHostShow: vi.fn(show),
    artifactHostSetBounds: vi.fn(async (_bounds: Bounds): Promise<R> => ok()),
    artifactHostHide: vi.fn(ok),
    artifactHostReload: vi.fn(reload),
    artifactHostClose: vi.fn(close),
  };
  return {
    held,
    /** Put every mock back to the behaviour that models the real host. */
    reset: () => {
      held.url = null;
      commands.artifactHostShow.mockClear().mockImplementation(show);
      commands.artifactHostSetBounds.mockClear().mockImplementation(async () => ok());
      commands.artifactHostHide.mockClear().mockImplementation(ok);
      commands.artifactHostReload.mockClear().mockImplementation(reload);
      commands.artifactHostClose.mockClear().mockImplementation(close);
    },
    commands,
    listener: { current: null as ((e: { payload: { kind: string; url: string } }) => void) | null },
  };
});
const commands = mocked.commands;
const fireHostEvent = (e: HostEvent) => mocked.listener.current?.(e);
vi.mock("../../ipc/client", () => ({
  commands: mocked.commands,
  events: {
    artifactHostEvent: {
      listen: (cb: (e: { payload: { kind: string; url: string } }) => void) => {
        mocked.listener.current = cb;
        return Promise.resolve(() => {
          mocked.listener.current = null;
        });
      },
    },
  },
}));

import { useAppErrors } from "../../store/appErrors";
import {
  attachArtifactHost,
  isOccluded,
  pageHost,
  pageKind,
  phaseForPageLoad,
  rectsOverlap,
  retryArtifactHost,
  sameBounds,
  toLogicalBounds,
  useArtifactHostStatus,
} from "./artifactHost";

describe("toLogicalBounds", () => {
  it("scales the CSS rect by the UI zoom (WebKit page zoom → logical px)", () => {
    expect(toLogicalBounds({ left: 100, top: 50, width: 400, height: 300 }, 1.25)).toEqual({
      x: 125,
      y: 62.5,
      width: 500,
      height: 375,
    });
  });
  it("is the identity at 100 %", () => {
    expect(toLogicalBounds({ left: 10.5, top: 20, width: 30, height: 40 }, 1)).toEqual({ x: 10.5, y: 20, width: 30, height: 40 });
  });
});

describe("sameBounds", () => {
  const b = { x: 10, y: 20, width: 300, height: 200 };
  it("treats sub-pixel noise as the same placement (no IPC per jitter)", () => {
    expect(sameBounds(b, { ...b, x: 10.2, height: 199.7 })).toBe(true);
  });
  it("sees a real move / resize", () => {
    expect(sameBounds(b, { ...b, x: 11 })).toBe(false);
    expect(sameBounds(b, { ...b, width: 290 })).toBe(false);
    expect(sameBounds(null, b)).toBe(false);
  });
});

describe("pageKind / pageHost / phaseForPageLoad", () => {
  it("the artifact page itself is the artifact", () => {
    expect(pageKind("https://claude.ai/artifact/EB7RRtdoZg1CDk4L3R1Nqg")).toBe("artifact");
    expect(pageKind("https://claude.ai/code/artifact/acecfb35-f63b-49c3-b835-d0c856695a94")).toBe("artifact");
  });
  it("claude.ai's login redirect and the known identity providers are sign-in", () => {
    expect(pageKind("https://claude.ai/login?returnTo=%2Fartifact%2FEB7")).toBe("signin");
    expect(pageKind("https://claude.ai/magic-link#abc")).toBe("signin");
    expect(pageKind("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe("signin");
    expect(pageKind("https://appleid.apple.com/auth/authorize")).toBe("signin");
    expect(pageKind("https://console.anthropic.com/login")).toBe("signin");
  });
  it("⚠️ any OTHER host is OFFSITE, never 'sign in to claude.ai'", () => {
    // Labelling a third-party page with the app's own claude.ai sign-in prompt is the frame a
    // credential-phishing page would want.
    expect(pageKind("https://claude-ai-login.evil.example/")).toBe("offsite");
    expect(pageKind("https://github.com/anthropics")).toBe("offsite");
  });
  it("does not mistake a path that merely starts like a sign-in one", () => {
    expect(pageKind("https://claude.ai/loginhelp")).toBe("offsite"); // not sign-in — and not the artifact
  });
  it("⚠️ any other claude.ai page is not 'the artifact is up' either", () => {
    // Saying "ready" on claude.ai/new told the user the artifact was showing while the panel had
    // wandered somewhere else entirely.
    expect(pageKind("https://claude.ai/new")).toBe("offsite");
    expect(pageKind("https://claude.ai/code/artifacts")).toBe("offsite"); // the gallery
  });
  it("an unparseable or blank page is no verdict", () => {
    expect(pageKind("not a url")).toBe("artifact");
    expect(pageKind("about:blank")).toBe("artifact");
  });
  it("names the host for the offsite warning", () => {
    expect(pageHost("https://claude-ai-login.evil.example/x")).toBe("claude-ai-login.evil.example");
    expect(pageHost("not a url")).toBeNull();
    expect(pageHost(null)).toBeNull();
  });
  it("maps page loads to phases", () => {
    expect(phaseForPageLoad("started", "https://claude.ai/artifact/x")).toBe("loading");
    expect(phaseForPageLoad("finished", "https://claude.ai/artifact/x")).toBe("ready");
    expect(phaseForPageLoad("finished", "https://claude.ai/login")).toBe("signin");
    expect(phaseForPageLoad("finished", "https://evil.example/")).toBe("offsite");
    expect(phaseForPageLoad("external_open_failed", "https://example.com")).toBeNull();
    expect(phaseForPageLoad("popup_refused", "smb://x/y")).toBeNull();
  });
});

describe("rectsOverlap", () => {
  const panel = { left: 600, top: 80, right: 1200, bottom: 800 };
  it("sees a menu that spills over the panel", () => {
    expect(rectsOverlap({ left: 500, top: 100, right: 700, bottom: 300 }, panel)).toBe(true);
  });
  it("ignores something beside it, or merely touching its edge", () => {
    expect(rectsOverlap({ left: 100, top: 100, right: 599, bottom: 300 }, panel)).toBe(false);
    expect(rectsOverlap({ left: 100, top: 100, right: 600.5, bottom: 300 }, panel)).toBe(false);
  });
});

// ---- isOccluded, against a fake document -----------------------------------------------------

/** A stand-in body child with a fixed box and computed style. */
function fakeChild(
  tag: string,
  box: { left: number; top: number; width: number; height: number },
  style: Partial<CSSStyleDeclaration> = {},
  children: Element[] = [],
) {
  return {
    tagName: tag,
    children,
    contains: () => false,
    getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }),
    __style: { visibility: "visible", opacity: "1", pointerEvents: "auto", ...style },
  } as unknown as Element;
}

function fakeDoc(children: Element[], hit: Element | null = null): Document {
  return {
    body: { children },
    elementFromPoint: () => hit,
  } as unknown as Document;
}

describe("isOccluded", () => {
  const rect = { left: 600, top: 80, right: 1200, bottom: 800 };
  const el = { contains: (n: unknown) => n === el } as unknown as HTMLElement;
  const realGetComputedStyle = window.getComputedStyle;

  beforeEach(() => {
    // Route getComputedStyle to whatever the fake child declares.
    vi.stubGlobal("getComputedStyle", (n: unknown) => (n as { __style?: unknown }).__style ?? realGetComputedStyle(document.body));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false with nothing over the panel", () => {
    expect(isOccluded(el, rect, fakeDoc([fakeChild("DIV", { left: 0, top: 0, width: 400, height: 400 })], el))).toBe(false);
  });

  it("sees a portalled menu that overlaps it", () => {
    const menu = fakeChild("DIV", { left: 700, top: 200, width: 200, height: 150 });
    expect(isOccluded(el, rect, fakeDoc([menu], el))).toBe(true);
  });

  it("ignores non-visual and invisible body children", () => {
    const script = fakeChild("SCRIPT", { left: 600, top: 80, width: 600, height: 700 });
    const hidden = fakeChild("DIV", { left: 600, top: 80, width: 600, height: 700 }, { visibility: "hidden" });
    const transparent = fakeChild("DIV", { left: 600, top: 80, width: 600, height: 700 }, { opacity: "0" });
    expect(isOccluded(el, rect, fakeDoc([script, hidden, transparent], el))).toBe(false);
  });

  it("⚠️ a click-through layer only occludes where it actually PAINTS", () => {
    // A toast stack is a full-screen `pointer-events: none` container. Counting it whole would
    // keep the host hidden forever; counting it as nothing would hide a toast behind the native
    // view. So: descend into its children.
    const emptyStack = fakeChild("DIV", { left: 0, top: 0, width: 1400, height: 900 }, { pointerEvents: "none" });
    expect(isOccluded(el, rect, fakeDoc([emptyStack], el))).toBe(false);

    const toast = fakeChild("DIV", { left: 900, top: 90, width: 360, height: 60 });
    const stackWithToast = fakeChild("DIV", { left: 0, top: 0, width: 1400, height: 900 }, { pointerEvents: "none" }, [toast]);
    expect(isOccluded(el, rect, fakeDoc([stackWithToast], el))).toBe(true);
  });

  it("hit-testing catches an overlay rendered INSIDE the app root", () => {
    const modal = { contains: () => false } as unknown as Element;
    expect(isOccluded(el, rect, fakeDoc([], modal))).toBe(true);
  });

  it("a point outside the viewport (null hit) is no verdict", () => {
    expect(isOccluded(el, rect, fakeDoc([], null))).toBe(false);
  });
});

// ---- The manager's state machine --------------------------------------------------------------

const URL_A = "https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAAA";
const URL_B = "https://claude.ai/artifact/BBBBBBBBBBBBBBBBBBBBBB";

/** A placeholder with a real box, plus the observers the manager attaches to it. */
function placeholder(): HTMLElement {
  // Only ever ONE in the document: a leftover placeholder is a body child overlapping the new
  // one, which the occlusion probe would (correctly) read as something drawn over the host.
  document.body.innerHTML = "";
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ left: 600, top: 80, width: 600, height: 700, right: 1200, bottom: 780, x: 600, y: 80, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/** Let the manager's rAF tick and its IPC queue drain. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
}

describe("the artifact host manager", () => {
  let detach: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    mocked.reset();
    useAppErrors.setState({ errors: [] });
    // jsdom has no layout observers; the manager only uses them as "something moved" triggers.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });

  afterEach(async () => {
    detach?.();
    detach = null;
    // Run past the idle-close so the next test starts from a closed host.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await settle();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the artifact once and reports it ready on the page-load event", async () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    expect(commands.artifactHostShow).toHaveBeenCalledTimes(1);
    expect(commands.artifactHostShow.mock.calls[0][0]).toBe(URL_A);
    expect(useArtifactHostStatus.getState()).toMatchObject({ url: URL_A, phase: "loading" });
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    expect(useArtifactHostStatus.getState().phase).toBe("ready");
  });

  it("⚠️ reports a load that never arrives instead of waiting forever", async () => {
    // wry emits NO event when a navigation fails before it commits (offline, DNS, TLS) — the
    // watchdog is the only thing that turns that silence into something the user can read.
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("loading");
    await vi.advanceTimersByTimeAsync(26_000);
    await settle();
    const s = useArtifactHostStatus.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/didn’t respond/);
    expect(commands.artifactHostHide).toHaveBeenCalled(); // hidden, so the panel is readable
  });

  it("does not fire the watchdog once the page has loaded", async () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("ready");
  });

  it("parks a failed show and does NOT retry it every frame", async () => {
    commands.artifactHostShow.mockImplementation(async (): Promise<ShowResult> => ({ status: "error", error: "nope" }));
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    expect(useArtifactHostStatus.getState()).toMatchObject({ phase: "error", error: "nope" });
    await vi.advanceTimersByTimeAsync(2_000); // several poll ticks
    await settle();
    expect(commands.artifactHostShow).toHaveBeenCalledTimes(1);
  });

  it("⚠️ 'Try again' after a timeout RE-NAVIGATES (a re-show would be a no-op in Rust)", async () => {
    // The show succeeded — only the page never came. Rust's `show` is idempotent for the URL it
    // already holds, so showing again navigates nothing and the watchdog just fires again: only
    // `reload` gets the user out.
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    await vi.advanceTimersByTimeAsync(26_000);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("error");
    retryArtifactHost();
    await settle();
    expect(commands.artifactHostReload).toHaveBeenCalledTimes(1);
    expect(useArtifactHostStatus.getState().phase).toBe("loading");
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    expect(useArtifactHostStatus.getState().phase).toBe("ready");
  });

  it("⚠️ a page that lands AFTER the timeout overrules the error and comes back on screen", async () => {
    // A Cloudflare interstitial or a cold page can outlast the watchdog. The verdict was "nothing
    // happened yet"; the page happening contradicts it.
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    await vi.advanceTimersByTimeAsync(26_000);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("error");
    const showsBefore = commands.artifactHostShow.mock.calls.length;
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    await settle();
    const s = useArtifactHostStatus.getState();
    expect(s.phase).toBe("ready");
    expect(s.error).toBeNull();
    expect(commands.artifactHostShow.mock.calls.length).toBeGreaterThan(showsBefore); // shown again
  });

  it("⚠️ re-opening an artifact whose load failed keeps saying so (never a blank 'ready')", async () => {
    const el = placeholder();
    detach = attachArtifactHost(el, URL_A);
    await settle();
    await vi.advanceTimersByTimeAsync(26_000);
    await settle();
    detach();
    await settle();
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    const s = useArtifactHostStatus.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/didn’t respond/);
  });

  it("⚠️ re-opening a STILL-LOADING artifact keeps waiting (and keeps the watchdog armed)", async () => {
    const el = placeholder();
    detach = attachArtifactHost(el, URL_A);
    await settle();
    detach();
    await settle();
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("loading"); // not a false "ready"
    await vi.advanceTimersByTimeAsync(26_000);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("error"); // the detector still fires
  });

  it("⚠️ a failure that lands after the user moved on does not stamp the new artifact", async () => {
    let failNext = false;
    commands.artifactHostShow.mockImplementation(async (): Promise<ShowResult> =>
      failNext ? { status: "error", error: "late failure" } : { status: "ok", data: true },
    );
    const el = placeholder();
    failNext = true;
    detach = attachArtifactHost(el, URL_A);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("error");
    failNext = false;
    detach();
    await settle();
    detach = attachArtifactHost(placeholder(), URL_B);
    await settle();
    fireHostEvent({ payload: { kind: "finished", url: URL_B } });
    const s = useArtifactHostStatus.getState();
    expect(s.url).toBe(URL_B);
    expect(s.phase).toBe("ready"); // A's failure stayed with A
    expect(s.error).toBeNull();
  });

  it("⚠️ a failed RELOAD still hides the view (it must not keep painting over the error panel)", async () => {
    // The retry used to fake `native.visible = false` to re-trigger a show — which also disarmed
    // every hide, leaving the page over the error panel, over menus, and over the app after the
    // panel closed.
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    commands.artifactHostReload.mockImplementation(async (): Promise<IpcResult> => ({ status: "error", error: "view is gone" }));
    retryArtifactHost();
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("error");
    expect(commands.artifactHostHide).toHaveBeenCalled();
  });

  it("⚠️ a failure recorded while the panel was closed re-opens WITH its reason", async () => {
    const el = placeholder();
    detach = attachArtifactHost(el, URL_A);
    await settle();
    detach(); // closed while still loading
    await settle();
    await vi.advanceTimersByTimeAsync(26_000); // the watchdog fires with nobody watching
    await settle();
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    const s = useArtifactHostStatus.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/didn’t respond/); // not a reasonless panel
  });

  it("⚠️ a page load that lands while the panel is closed still pardons the failure", async () => {
    const el = placeholder();
    detach = attachArtifactHost(el, URL_A);
    await settle();
    detach();
    await settle();
    await vi.advanceTimersByTimeAsync(26_000);
    await settle();
    fireHostEvent({ payload: { kind: "finished", url: URL_A } }); // it landed, late
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("ready");
  });

  it("⚠️ ignores a page load belonging to the PREVIOUS artifact", async () => {
    const el = placeholder();
    detach = attachArtifactHost(el, URL_A);
    await settle();
    detach();
    await settle();
    detach = attachArtifactHost(placeholder(), URL_B);
    await settle();
    // A's page finishes after the user moved on: believing it would report B ready AND disarm the
    // watchdog that is the only thing watching B.
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    expect(useArtifactHostStatus.getState().phase).toBe("loading");
    await vi.advanceTimersByTimeAsync(26_000);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("error"); // B's watchdog still fired
  });

  it("retries a failed show on demand", async () => {
    commands.artifactHostShow.mockImplementation(async (): Promise<ShowResult> => ({ status: "error", error: "nope" }));
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    commands.artifactHostShow.mockImplementation(async (url: string) => {
      const navigated = mocked.held.url !== url;
      mocked.held.url = url;
      return { status: "ok", data: navigated } as const;
    });
    retryArtifactHost();
    await settle();
    expect(commands.artifactHostShow).toHaveBeenCalledTimes(2);
    expect(useArtifactHostStatus.getState().phase).toBe("loading");
  });

  it("reloads (not re-shows) when the page is up, and surfaces a reload that can't be issued", async () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    commands.artifactHostReload.mockImplementation(async (): Promise<IpcResult> => ({ status: "error", error: "no artifact is loaded in the view" }));
    retryArtifactHost();
    await settle();
    expect(commands.artifactHostReload).toHaveBeenCalledTimes(1);
    expect(useArtifactHostStatus.getState()).toMatchObject({ phase: "error", error: "no artifact is loaded in the view" });
  });

  it("⚠️ re-attaching the artifact ALREADY shown keeps its status (Rust won't re-navigate it)", async () => {
    const el = placeholder();
    detach = attachArtifactHost(el, URL_A);
    await settle();
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    expect(useArtifactHostStatus.getState().phase).toBe("ready");
    detach();
    await settle();
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("ready"); // not stuck on a fresh "loading"
  });

  it("a failed show for ANOTHER artifact doesn't strand the one still loaded", async () => {
    const el = placeholder();
    detach = attachArtifactHost(el, URL_A);
    await settle();
    fireHostEvent({ payload: { kind: "finished", url: URL_A } });
    detach();
    await settle();
    commands.artifactHostShow.mockImplementation(async (): Promise<ShowResult> => ({ status: "error", error: "refused" }));
    const detachB = attachArtifactHost(placeholder(), URL_B);
    await settle();
    expect(useArtifactHostStatus.getState().phase).toBe("error");
    detachB();
    await settle();
    commands.artifactHostShow.mockImplementation(async (url: string) => {
      const navigated = mocked.held.url !== url;
      mocked.held.url = url;
      return { status: "ok", data: navigated } as const;
    });
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    // Back on the artifact that IS loaded: ready, not a "loading" nothing will ever resolve.
    expect(useArtifactHostStatus.getState().phase).toBe("ready");
  });

  it("hides on detach and closes the view once it stays unused", async () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    detach();
    detach = null;
    await settle();
    expect(commands.artifactHostHide).toHaveBeenCalled();
    expect(commands.artifactHostClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 100);
    await settle();
    expect(commands.artifactHostClose).toHaveBeenCalledTimes(1);
  });

  it("a re-attach before the idle close keeps the page alive", async () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    detach();
    await vi.advanceTimersByTimeAsync(30_000);
    detach = attachArtifactHost(placeholder(), URL_A);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await settle();
    expect(commands.artifactHostClose).not.toHaveBeenCalled();
  });

  it("surfaces a hide that fails — the native view would sit over the overlay it must clear", async () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    commands.artifactHostHide.mockImplementation(async (): Promise<IpcResult> => ({ status: "error", error: "stuck" }));
    detach();
    detach = null;
    await settle();
    expect(useAppErrors.getState().errors[0]?.message).toMatch(/Couldn't hide/);
  });

  it("surfaces a pop-up the host refused (a non-web scheme) instead of dropping the click", async () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    await settle();
    fireHostEvent({ payload: { kind: "popup_refused", url: "smb://attacker.example/share" } });
    const err = useAppErrors.getState().errors[0];
    expect(err?.message).toContain("smb://attacker.example/share");
    expect(err?.detail).toMatch(/another app/);
  });

  it("⚠️ reports a SECOND blocked link too (the banner de-dupes on the message)", () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    fireHostEvent({ payload: { kind: "popup_refused", url: "vscode://x/y" } });
    fireHostEvent({ payload: { kind: "popup_refused", url: "smb://attacker.example/share" } });
    const msgs = useAppErrors.getState().errors.map((e) => e.message);
    expect(msgs).toHaveLength(2);
    expect(msgs.join(" ")).toContain("smb://attacker.example/share");
  });

  it("explains a blocked BLANK pop-up as what it is, not as 'it would launch another app'", () => {
    detach = attachArtifactHost(placeholder(), URL_A);
    fireHostEvent({ payload: { kind: "popup_blank_refused", url: "about:blank" } });
    const err = useAppErrors.getState().errors[0];
    expect(err?.message).toMatch(/pop-up/i);
    expect(err?.detail).not.toMatch(/another app/);
  });
});
