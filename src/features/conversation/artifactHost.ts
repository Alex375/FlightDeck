// The in-app claude.ai ARTIFACT HOST, front half. The page itself is a NATIVE child webview
// (Rust `artifact_host/`) — the only way to show a hosted artifact in-app: claude.ai refuses to
// be framed, sits behind a Cloudflare challenge and needs the user's session. This module owns
// WHERE that webview sits and WHEN it is visible, outside React (like `termManager`): components
// only lend it a placeholder element (`attachArtifactHost`) and read its status.
//
// ⚠️ A native view ALWAYS paints above the HTML document — z-index means nothing to it. So the
// host must be HIDDEN whenever anything of ours overlaps its box (a menu, a modal, a toast…),
// or that overlay would be drawn underneath and look missing. `isOccluded` is that check; it
// runs on every DOM mutation (coalesced to one per frame) while a host is attached.

import { create } from "zustand";
import { commands, events } from "../../ipc/client";
import type { ArtifactHostEventKind, HostBounds } from "../../ipc/client";
import { useAppErrors } from "../../store/appErrors";
import { useDisplay } from "../../store/display";
import { canonicalArtifactUrl } from "./artifacts";

/** What the host shows, for the viewer's status line and placeholder. */
export type HostPhase =
  /** A page is loading (the native view may still be blank). */
  | "loading"
  /** The artifact's page is up. */
  | "ready"
  /** The page is claude.ai's sign-in (or an identity provider's): no session yet. */
  | "signin"
  /** The host is on some OTHER site — a link followed inside it, or a redirect. Named apart from
   *  `signin` so the app never labels a third-party page "sign in to claude.ai" (which would put
   *  trusted app chrome over whatever credential form that page shows). */
  | "offsite"
  /** The host could not be created / shown, or its page never loaded. The view stays hidden
   *  until a retry. */
  | "error";

export interface HostStatus {
  /** The artifact URL the host was asked to show, or null. */
  url: string | null;
  phase: HostPhase;
  /** The page the host is actually on (after redirects), when known. */
  pageUrl: string | null;
  /** Why the host failed (phase "error"). */
  error: string | null;
}

export const useArtifactHostStatus = create<HostStatus>(() => ({
  url: null,
  phase: "loading",
  pageUrl: null,
  error: null,
}));

/** Below this size (CSS px) the host is hidden rather than squeezed — the panel is sliding in
 *  or out, or folded away. */
const MIN_VISIBLE_PX = 24;
/** How long a hidden, detached host keeps its page alive before it is destroyed. Long enough to
 *  flip to the editor and back without a reload; short enough that a claude.ai page (a whole web
 *  content process) doesn't linger for the rest of the run once nothing shows it. */
const IDLE_CLOSE_MS = 2 * 60_000;
/** Belt for layout moves nothing else reports (a pure position change with no resize and no
 *  DOM mutation). One `getBoundingClientRect` per tick. */
const POLL_MS = 400;
/** Hit-test spacing (CSS px): tighter than the smallest overlay that matters (a ~60px toast),
 *  capped so a huge panel never costs more than {@link MAX_PROBES} hit tests per frame. */
const PROBE_STEP_PX = 40;
const MAX_PROBES = 120;
/**
 * How long a requested page may take before the viewer calls it a failure.
 *
 * ⚠️ NOT a nicety — it is the ONLY thing that reports a failed load. wry implements neither
 * `didFailProvisionalNavigation` nor `didFailNavigation`, so a navigation that fails before it
 * commits (offline, dead VPN, DNS, TLS refused, claude.ai unreachable) emits NO page-load event at
 * all, and WebKit paints no error page of its own. Without this the panel stayed a dark rectangle
 * reading "Loading…" forever, with the real reason lost.
 */
const LOAD_TIMEOUT_MS = 25_000;

// ---- Pure helpers ---------------------------------------------------------------------------

/** A viewport rect (CSS px of the app document) → the host's bounds in the main window's
 *  LOGICAL px. The app's UI zoom is the WebKit page zoom, so one CSS px is `zoom` logical px. */
export function toLogicalBounds(
  r: { left: number; top: number; width: number; height: number },
  zoom: number,
): HostBounds {
  const round = (v: number) => Math.round(v * zoom * 100) / 100;
  return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
}

/** Two bounds are the same placement (sub-pixel noise is not a move). */
export function sameBounds(a: HostBounds | null, b: HostBounds): boolean {
  if (!a) return false;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

/** Paths on claude.ai that mean "you are not signed in". */
const SIGN_IN_PATH_RE = /^\/(?:login|signin|sign-in|logout|magic-link|sso)(?:[/?#]|$)/i;
/** The identity providers claude.ai hands a sign-in off to. */
const IDP_HOSTS = ["accounts.google.com", "appleid.apple.com"];
/** An artifact's own path on claude.ai (both shapes the CLI has emitted). */
const ARTIFACT_PATH_RE = /^\/(?:code\/)?artifact\/[A-Za-z0-9-]+(?:[/?#]|$)/;

/**
 * What the page the host landed on IS: the artifact itself, a sign-in step, or some other site.
 *
 * ⚠️ "not claude.ai" does NOT mean "sign-in". Saying so put the app's own, trusted
 * "Sign in to claude.ai" label over any third-party page the host ended up on — the one place a
 * fake credential form would want it. Only claude.ai's sign-in paths and the known identity
 * providers count; everything else is `offsite` and shows its real hostname.
 */
export function pageKind(pageUrl: string): "artifact" | "signin" | "offsite" {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return "artifact"; // no verdict — don't label a page we can't read
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "artifact";
  const host = u.hostname.toLowerCase();
  if (host === "claude.ai") {
    if (SIGN_IN_PATH_RE.test(u.pathname)) return "signin";
    // Only an ARTIFACT path is the artifact. Any other claude.ai page (the app, the gallery, a
    // 404) is somewhere else — saying "ready" there told the user the artifact was up while the
    // panel showed something else entirely.
    return ARTIFACT_PATH_RE.test(u.pathname) ? "artifact" : "offsite";
  }
  if (IDP_HOSTS.includes(host) || host.endsWith(".anthropic.com") || host === "anthropic.com") return "signin";
  return "offsite";
}

/** The page's hostname, for telling the user WHERE the host actually is (`offsite`). */
export function pageHost(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  try {
    return new URL(pageUrl).hostname || null;
  } catch {
    return null;
  }
}

/** The phase a top-level page-load event moves the host to (null: not a page load). */
export function phaseForPageLoad(kind: ArtifactHostEventKind, pageUrl: string): HostPhase | null {
  if (kind === "started") return "loading";
  if (kind !== "finished") return null;
  const where = pageKind(pageUrl);
  return where === "artifact" ? "ready" : where;
}

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** True when two rects overlap by more than a hairline. */
export function rectsOverlap(a: RectLike, b: RectLike): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

/** Elements that never paint, among `<body>`'s children. */
const NON_VISUAL = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);

/** True when `node` (a portal root) paints something over `r`. A click-through layer
 *  (`pointer-events: none` — a toast stack, an animation overlay) is only as occluding as the
 *  children it actually paints, so it is descended into rather than counted whole. */
function paintsOver(node: Element, r: RectLike, depth: number): boolean {
  const box = node.getBoundingClientRect();
  if (box.width === 0 || box.height === 0 || !rectsOverlap(box, r)) return false;
  const style = getComputedStyle(node);
  if (style.visibility === "hidden" || style.opacity === "0") return false;
  if (style.pointerEvents !== "none" || depth >= 3) return true;
  return Array.from(node.children).some((c) => paintsOver(c, r, depth + 1));
}

/**
 * True when something of ours is drawn over `el`'s box, so the native host must step aside.
 * Two complementary probes:
 *  1. PORTALS — every popover/menu/dialog rendered into `document.body` (the app's `Menu`,
 *     `ConfirmDialog`, context menus…): any painted body child other than the one holding `el`
 *     that intersects the box. Catches a small menu wherever it lands.
 *  2. HIT-TESTING — a grid of points over the box: an overlay rendered INSIDE the app root (a
 *     fixed modal with its scrim, a toast) is what `elementFromPoint` returns there instead of
 *     `el` or its content. A point outside the viewport returns null: no verdict, skipped.
 */
export function isOccluded(el: HTMLElement, r: RectLike, doc: Document = document): boolean {
  for (const child of Array.from(doc.body.children)) {
    if (child.contains(el) || NON_VISUAL.has(child.tagName)) continue;
    if (paintsOver(child, r, 0)) return true;
  }
  // Hit-testing is the second probe, not the only one: a document without it (jsdom, a very old
  // engine) still gets the portal check above rather than an exception.
  if (typeof doc.elementFromPoint !== "function") return false;
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  let cols = Math.max(2, Math.ceil(w / PROBE_STEP_PX));
  let rows = Math.max(2, Math.ceil(h / PROBE_STEP_PX));
  if (cols * rows > MAX_PROBES) {
    const k = Math.sqrt(MAX_PROBES / (cols * rows));
    cols = Math.max(2, Math.floor(cols * k));
    rows = Math.max(2, Math.floor(rows * k));
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const hit = doc.elementFromPoint(r.left + ((i + 0.5) * w) / cols, r.top + ((j + 0.5) * h) / rows);
      if (hit && hit !== el && !el.contains(hit)) return true;
    }
  }
  return false;
}

// ---- The manager (module singleton) ----------------------------------------------------------

interface Attachment {
  el: HTMLElement;
  url: string;
}

/** The placeholder the host currently follows, or null. */
let current: Attachment | null = null;
/** What the NATIVE view was last told (the intended state, updated as calls are queued). */
const native = {
  exists: false,
  visible: false,
  /** The URL the last show was ASKED for (optimistic — it may still fail). */
  url: null as string | null,
  /** The URL the native view is actually pointed at — only written once a show SUCCEEDED.
   *  ⚠️ Kept apart from `url`: a failed show left the refused URL in `url` while Rust still had
   *  the previous one, so re-opening the previous artifact set the status to "loading" while Rust
   *  (rightly) skipped re-navigating — no page-load event, "Loading…" forever. */
  shownUrl: null as string | null,
  bounds: null as HostBounds | null,
  zoom: 1,
};
/**
 * The artifact whose page failed, WITH the reason — not retried on every frame (that would spam
 * the same failure) until the user asks (`retryArtifactHost`), a page load contradicts it, or
 * another artifact is opened.
 *
 * ⚠️ The reason lives here, not only in the status store: a failure can land while the panel is
 * closed (the watchdog stays armed across a detach), and re-opening then showed an error panel
 * with no message at all.
 */
let failed: { url: string; reason: string } | null = null;
/**
 * A one-shot "show it again even though we believe it is already shown", set by a retry.
 *
 * ⚠️ It exists so `native.visible` can stay TRUE to what Rust was told. Faking `visible = false`
 * to re-trigger a show also disarmed every hide — they are all gated on that flag — so a failed
 * retry left the native view painting over the error panel, over menus, and over the editor after
 * the panel closed.
 */
let forceShow = false;
/** The last page load the host REPORTED, and for which artifact — the only trustworthy account
 *  of what the view is on when no new navigation is issued. */
let lastLoad: { artifact: string; phase: HostPhase; pageUrl: string } | null = null;
let frame = 0;
let poll: ReturnType<typeof setInterval> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let mutations: MutationObserver | null = null;
let resize: ResizeObserver | null = null;
let unsubscribeZoom: (() => void) | null = null;
let listening = false;
/** Armed while a requested page is expected to load — see {@link LOAD_TIMEOUT_MS}. */
let loadTimer: ReturnType<typeof setTimeout> | null = null;
/** The artifact that watchdog is watching for. */
let loadTimerUrl: string | null = null;
/** Native calls run strictly in order (a hide must never overtake the show before it). */
let queue: Promise<void> = Promise.resolve();

/**
 * Put the host in its error state for `url`: hidden (so the panel underneath is readable), not
 * retried on its own, with the reason on screen.
 *
 * ⚠️ SCOPED to the artifact on screen. A failure that lands after the user has moved to another
 * artifact (a queued show resolving late) must not stamp its error onto that one — the status is
 * global, so writing it blindly froze an innocent viewer in "error".
 */
function fail(url: string, reason: string): void {
  failed = { url, reason };
  if (current?.url !== url) {
    // Recorded (with its reason) for whoever opens it next — but the viewer on screen belongs to
    // another artifact, and this failure is not its news.
    console.error(`artifact host: ${url} failed while it wasn't on screen -`, reason);
    return;
  }
  clearLoadTimer();
  if (native.visible) queueHide();
  useArtifactHostStatus.setState({ url, phase: "error", error: reason });
}

function clearLoadTimer(): void {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = null;
  loadTimerUrl = null;
}

/** Arm the load watchdog for `url`: if no page load is reported in time, the load is reported as
 *  failed instead of waiting forever (see {@link LOAD_TIMEOUT_MS}). */
function armLoadTimer(url: string): void {
  clearLoadTimer();
  loadTimerUrl = url;
  loadTimer = setTimeout(() => {
    loadTimer = null;
    loadTimerUrl = null;
    if (useArtifactHostStatus.getState().phase !== "loading") return; // it loaded after all
    fail(url, "claude.ai didn’t respond. Check your connection, then try again.");
  }, LOAD_TIMEOUT_MS);
}

/** True while a page load is still expected for `url` (the watchdog is armed for it). */
function loadPending(url: string): boolean {
  return loadTimer !== null && loadTimerUrl === url;
}

function enqueue(step: () => Promise<void>): void {
  queue = queue.then(step, step);
}

type IpcResult = { status: "ok"; data: null } | { status: "error"; error: string };

/** Run one native call. Returns null on success, else the reason (already logged) — callers
 *  decide what a failure means (a failed show parks the host; a failed hide is surfaced). */
async function call(what: string, run: () => Promise<IpcResult>): Promise<string | null> {
  let reason: string | null = null;
  try {
    const res = await run();
    if (res.status === "error") reason = res.error;
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  if (reason !== null) console.error(`artifact host: ${what} failed -`, reason);
  return reason;
}

/** Queue a hide; a host that can't be hidden sits on top of whatever it should have made way
 *  for, so the failure is said out loud rather than leaving a menu mysteriously invisible. */
function queueHide(): void {
  native.visible = false;
  enqueue(async () => {
    const reason = await call("hide", () => commands.artifactHostHide());
    if (reason !== null) useAppErrors.getState().pushError("Couldn't hide the artifact view.", reason);
  });
}

function ensureListener(): void {
  if (listening) return;
  listening = true;
  void events.artifactHostEvent.listen((e) => {
    const { kind, url } = e.payload;
    // ⚠️ The URL goes in the MESSAGE, not only in the detail: `pushError` de-duplicates on the
    // message, so two different blocked links in a row would have collapsed into one banner
    // naming only the first — the second click dropped in silence, which is what these events
    // exist to prevent.
    if (kind === "external_open_failed") {
      useAppErrors.getState().pushError(`Couldn't open ${url} in your browser.`);
      return;
    }
    if (kind === "popup_refused") {
      useAppErrors
        .getState()
        .pushError(`Blocked a link to ${url}`, "It would have launched another app. Only web links open from here.");
      return;
    }
    if (kind === "popup_blank_refused") {
      useAppErrors
        .getState()
        .pushError(
          "Blocked a pop-up window from this artifact.",
          "An artifact can't open a blank window of its own — only a sign-in can. Its links still open in your browser.",
        );
      return;
    }
    const phase = phaseForPageLoad(kind, url);
    if (!phase) return;
    // The host holds ONE page. Whose is it? What the panel asked for, else what the view was last
    // confirmed on — so an event still counts while the panel is closed (the watchdog is armed
    // across a detach) or in the window before a show is confirmed.
    const held = current?.url ?? native.shownUrl ?? native.url;
    // ⚠️ A load of a DIFFERENT artifact is stale — the previous artifact's page finishing after
    // the user moved on. Believing it would report the new artifact "ready" and, worse, disarm
    // the watchdog that is the only thing watching the new one.
    if (pageKind(url) === "artifact" && held && canonicalArtifactUrl(url) !== canonicalArtifactUrl(held)) return;
    // The page is loading or has loaded — whatever else happens, it is not the dead silence the
    // watchdog exists for.
    if (kind === "finished") clearLoadTimer();
    // ⚠️ A page load OVERRULES an error. The watchdog only ever says "nothing has happened yet",
    // and a page that lands a second late (a Cloudflare interstitial, a cold page) contradicts it
    // — leaving the error up would hide a view that works, with no way back. Only the host's own
    // refusal (a failed show) is terminal, and that one can't be contradicted by a page load
    // because no page loads without a view.
    if (failed && failed.url === held) failed = null;
    if (held) lastLoad = { artifact: held, phase, pageUrl: url };
    useArtifactHostStatus.setState({ phase, pageUrl: url, error: null });
    schedule(); // it was hidden while "failed" — bring it back
  });
}

function schedule(): void {
  if (frame || !current) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    sync();
  });
}

/** Reconcile the native view with the placeholder: hidden, moved, or (re)shown. */
function sync(): void {
  const a = current;
  if (!a) return;
  const r = a.el.getBoundingClientRect();
  const zoom = useDisplay.getState().uiZoom;
  const hide =
    !a.el.isConnected ||
    r.width < MIN_VISIBLE_PX ||
    r.height < MIN_VISIBLE_PX ||
    failed?.url === a.url ||
    isOccluded(a.el, r);
  if (hide) {
    if (native.visible) queueHide();
    return;
  }
  const bounds = toLogicalBounds(r, zoom);
  if (forceShow || !native.visible || native.url !== a.url || native.zoom !== zoom) {
    const url = a.url;
    forceShow = false;
    // A show that changes the page is the one that must be watched: re-showing the page already
    // on screen (unhiding after a menu closed, a zoom change) reports no page load, and arming
    // the watchdog for it would time out a page that is up and fine.
    const navigates = native.shownUrl !== url;
    Object.assign(native, { exists: true, visible: true, url, bounds, zoom });
    // ⚠️ While a navigating show is in flight, the view is on NEITHER page: clearing `shownUrl`
    // now keeps "confirmed on screen" honest, so a re-attach in that window says "loading" (and
    // arms a watchdog) instead of claiming the previous page is still up.
    if (navigates) {
      native.shownUrl = null;
      armLoadTimer(url);
    }
    enqueue(async () => {
      let navigated = false;
      let reason: string | null = null;
      try {
        const res = await commands.artifactHostShow(url, bounds, zoom);
        if (res.status === "error") reason = res.error;
        else navigated = res.data;
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
      }
      if (reason !== null) {
        console.error("artifact host: show failed -", reason);
        fail(url, reason);
        return;
      }
      native.shownUrl = url;
      // ⚠️ Rust says whether it actually NAVIGATED. We expected one and it didn't → it already
      // held this page, so no page-load event is coming for this call, and waiting (then timing
      // out) would report a page that is up as a failure.
      //
      // But "it already holds it" does NOT mean "it finished loading it": Rust records the URL
      // when the navigation STARTS. Only a load it actually reported settles that — so the
      // status is restated from `lastLoad`, and when there is none, the earlier load is still in
      // flight and its watchdog must stay armed.
      if (navigates && !navigated) {
        if (lastLoad?.artifact === url) {
          clearLoadTimer();
          useArtifactHostStatus.setState({ phase: lastLoad.phase, pageUrl: lastLoad.pageUrl, error: null });
        }
      }
    });
    return;
  }
  if (!sameBounds(native.bounds, bounds)) {
    native.bounds = bounds;
    enqueue(async () => {
      await call("move", () => commands.artifactHostSetBounds(bounds));
    });
  }
}

function observe(el: HTMLElement): void {
  unobserve();
  resize = new ResizeObserver(schedule);
  resize.observe(el);
  mutations = new MutationObserver(schedule);
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "open", "data-state", "data-open"],
  });
  window.addEventListener("resize", schedule);
  unsubscribeZoom = useDisplay.subscribe((s, prev) => {
    if (s.uiZoom !== prev.uiZoom) schedule();
  });
  poll = setInterval(() => {
    if (!document.hidden) schedule();
  }, POLL_MS);
}

function unobserve(): void {
  resize?.disconnect();
  resize = null;
  mutations?.disconnect();
  mutations = null;
  window.removeEventListener("resize", schedule);
  unsubscribeZoom?.();
  unsubscribeZoom = null;
  if (poll) clearInterval(poll);
  poll = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

/**
 * Lay the host over `el` showing `url`, and keep it there — following the element's box,
 * stepping aside for overlays — until the returned detach is called. A later attach replaces an
 * earlier one (only one artifact is ever hosted).
 */
export function attachArtifactHost(el: HTMLElement, url: string): () => void {
  ensureListener();
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  // "Loading" is claimed against what the native view is REALLY showing (`shownUrl`), not against
  // the last URL asked for: re-attaching the artifact already on screen must keep its status
  // (Rust skips re-navigating it, so no page-load event would ever clear a fresh "loading").
  if (native.shownUrl !== url) {
    failed = null;
    clearLoadTimer();
    useArtifactHostStatus.setState({ url, phase: "loading", pageUrl: null, error: null });
  } else {
    // The native view is ALREADY on this artifact: Rust won't re-navigate, so no page-load event
    // is coming — the status must be restated from what is ACTUALLY on screen, not left as it was
    // (it may describe another artifact) and not assumed good:
    //  - this artifact failed → keep saying so, with its reason and a way to retry;
    //  - its page is still loading → keep waiting, and keep the watchdog armed (claiming "ready"
    //    here disarmed the only failure detector there is);
    //  - otherwise → what its last page load said.
    const { pageUrl } = useArtifactHostStatus.getState();
    const phase: HostPhase =
      failed?.url === url
        ? "error"
        : loadPending(url)
          ? "loading"
          : pageUrl
            ? phaseForPageLoad("finished", pageUrl) ?? "ready"
            : "ready";
    // The reason comes from `failed`, which kept it even while the panel was closed.
    useArtifactHostStatus.setState({ url, phase, error: phase === "error" ? failed?.reason ?? null : null });
  }
  current = { el, url };
  observe(el);
  schedule();
  return () => detach(el);
}

function detach(el: HTMLElement): void {
  if (current?.el !== el) return; // a newer attach already took over
  current = null;
  unobserve();
  // ⚠️ The watchdog is left ARMED on purpose. Closing the panel doesn't make a stalled load land,
  // and disarming it made a re-open report "ready" over a page that was still (or never) loading
  // — with no detector left to ever say otherwise. It fires harmlessly while detached: `fail` is
  // scoped to the artifact on screen, so it only records the failure for the next attach.
  if (native.visible) queueHide();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (current || !native.exists) return;
    Object.assign(native, { exists: false, url: null, shownUrl: null, bounds: null });
    enqueue(async () => {
      await call("close", () => commands.artifactHostClose());
    });
  }, IDLE_CLOSE_MS);
}

/**
 * Spend a claude.ai sign-in link the user pasted, IN the panel.
 *
 * ⚠️ The panel can't offer what a browser offers: macOS gives passkeys-on-this-Mac and password
 * AutoFill only to apps with Apple's browser entitlement (issued through a provisioning profile;
 * a self-signed app can't have one). So signing in here means a typed password, a passkey from
 * your phone, or the link claude.ai emails — and that link, clicked in Mail, opens the default
 * browser and signs in a session this webview never sees. Pasting it here spends it in the right
 * place. Rejected unless it points at claude.ai (the panel is not a browser).
 */
export function signInWithPastedLink(link: string): Promise<string | null> {
  const url = link.trim();
  if (!current) return Promise.resolve("Open an artifact first.");
  const artifact = current.url;
  useArtifactHostStatus.setState({ phase: "loading", error: null });
  armLoadTimer(artifact);
  return new Promise((resolve) => {
    enqueue(async () => {
      const reason = await call("sign-in link", () => commands.artifactHostOpenClaudeUrl(url));
      if (reason !== null) {
        clearLoadTimer();
        useArtifactHostStatus.setState({ phase: "signin" });
      }
      resolve(reason);
    });
  });
}

/** Re-open the hosted artifact (refresh, or back to it after navigating away / signing in).
 *  After a failure, this is also the retry. */
export function retryArtifactHost(): void {
  if (!current) return;
  const url = current.url;
  failed = null;
  forceShow = true; // ⚠️ an INTENT — never fake `native.visible`, which every hide is gated on
  useArtifactHostStatus.setState({ url, phase: "loading", error: null });
  armLoadTimer(url);
  // ⚠️ Re-SHOWING is not retrying. `show` is idempotent on the Rust side — asked for the URL it
  // already holds, it skips the navigation — so after a load that timed out (where the show had
  // SUCCEEDED and only the page never came) another show does nothing at all, and the watchdog
  // just fires again. Only `reload` navigates. So: reload whenever the view exists and holds this
  // artifact; show only when there is no view to reload (the show itself is what failed).
  const canReload = native.exists && native.shownUrl === url;
  if (!canReload) native.shownUrl = null;
  schedule(); // (re)show the view — it was hidden by the failure
  if (canReload) {
    enqueue(async () => {
      const reason = await call("reload", () => commands.artifactHostReload());
      // A reload that could not even be issued is a failure of THIS action: report it where the
      // user is looking (the panel), not only as a toast, and stop the watchdog from blaming the
      // network for it.
      if (reason !== null) fail(url, reason);
    });
  }
}
