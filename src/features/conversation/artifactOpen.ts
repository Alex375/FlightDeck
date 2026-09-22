// Shared "open this artifact" action, used by every artifact surface (the inline card, the
// composer chip rows, and the prose link card). It routes to the IN-APP viewer whenever the host
// has a side region to render in:
//  - a PAGE artifact (self-contained HTML/Markdown) with its local temp file → rendered locally;
//  - otherwise the HOSTED page on claude.ai, shown in-app in a native webview — a TYPED artifact
//    (Claude Design…, whose page belongs to its type and only exists hosted), a link to an
//    artifact from another conversation, or a page artifact whose temp file is gone.
// It falls back to the browser only when the host has no side region (an inert host) or the user
// turned the in-app hosted view off (`artifactsInApp`).

import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppErrors } from "../../store/appErrors";
import { useDisplay } from "../../store/display";
import { useEditorStore, type ArtifactView } from "../editor/editorStore";
import { ARTIFACT_URL_RE, canonicalArtifactUrl } from "./artifacts";

/**
 * {@link ARTIFACT_URL_RE} anchored at the start, compiled ONCE at module load.
 *
 * ⚠️ HOT PATH: `isArtifactUrl` runs for EVERY markdown link StreamMarkdown renders in a thread
 * (see MentionLink), so building a fresh `RegExp` per call would allocate + recompile a pattern
 * on a render path that can fire hundreds of times per streamed turn. Hoisted, not inlined.
 *
 * ⚠️ Deliberate asymmetry: this anchored form is case-INSENSITIVE while `ARTIFACT_URL_RE` (which
 * parses the publish tool_result) is case-SENSITIVE. They read from opposite sides of the trust
 * boundary: the tool_result is text the CLI itself emits in one exact canonical shape, so the
 * parse stays strict (a lookalike in surrounding prose must not be mistaken for the ack's URL);
 * an href, on the other hand, is prose the model (or the user) typed, where scheme/host casing
 * legitimately drifts (`HTTPS://Claude.ai/…` is the SAME resource per RFC 3986). A false negative
 * here silently downgrades a real artifact link to a plain anchor, so recognition is tolerant.
 * The tolerance is safe downstream because `routeArtifactOpen` canonicalises before handing a URL
 * to the in-app host (see {@link canonicalArtifactUrl}): a case-drifted link still opens the right
 * artifact, and anything that can't be canonicalised goes to the browser rather than erroring.
 *
 * No `g` flag — a shared `/g/` regex carries `lastIndex` between `.test()` calls and would
 * alternate true/false on the same input. Keep it stateless.
 */
const ARTIFACT_URL_ANCHORED_RE = new RegExp(`^${ARTIFACT_URL_RE.source}`, "i");

/** True when `href` is a canonical hosted-artifact URL (anchored at the start). */
export function isArtifactUrl(href: string | undefined | null): boolean {
  return !!href && ARTIFACT_URL_ANCHORED_RE.test(href);
}

/** An artifact renders as Markdown when its file is `.md`/`.markdown`, else as HTML. */
export function artifactKind(filePath: string | null): "html" | "md" {
  return filePath && /\.(md|markdown)$/i.test(filePath) ? "md" : "html";
}

export interface ArtifactOpenMeta {
  convId: string;
  title: string;
  favicon: string | null;
  url: string | null;
  /** Local temp file to render in the viewer, or null. */
  filePath: string | null;
  /**
   * True for a TYPED artifact (Claude Design…): its page is the type's, hosted on claude.ai, and
   * its local file is DATA (`canvas.json`…). Rendering that file as a page is what showed a broken
   * screen — so a typed artifact is only ever shown hosted, whatever `filePath` says.
   */
  typed?: boolean;
  /**
   * True when the artifact was published WITH sibling files. Its page loads them relatively, and
   * the local preview (a `srcDoc` document with no origin, under our CSP) can serve none of them
   * — it would render the page missing its stylesheet, its script or its data, silently. Hosted.
   */
  multiFile?: boolean;
  /**
   * True when the host mounts NO side region (the Flight Deck reply modal). Mirrors
   * FileMentionProvider's `inert`, the same gate every other click-to-reveal surface honours.
   */
  inert?: boolean;
  /**
   * Whether a HOSTED page may be shown in-app (the `artifactsInApp` display pref). False → the
   * hosted page opens in the browser, as before the in-app host existed. Defaults to true.
   */
  hostedInApp?: boolean;
}

/** Where a click on an artifact must go. Pure, so the routing rule is testable on its own. */
export type ArtifactRoute =
  | { kind: "viewer"; view: ArtifactView }
  | { kind: "browser"; url: string }
  | { kind: "none" };

/**
 * Decide where an artifact opens, most in-app first:
 *  1. the local PAGE (a non-typed artifact's HTML/Markdown temp file) in the viewer;
 *  2. the HOSTED page in the viewer's native webview (typed artifacts, links without a local
 *     file) — unless the user turned that off, in which case the browser;
 *  3. nowhere.
 *
 * ⚠️ The `inert` branch is load-bearing, not defensive. An inert host (the reply modal mounts a
 * bare pane, no MainArea) has no side region, so routing there was a DEAD CLICK — and worse, it
 * still set the global `artifactView`, which then popped the viewer open the next time that
 * conversation was opened full-screen.
 */
export function routeArtifactOpen(meta: ArtifactOpenMeta): ArtifactRoute {
  if (meta.inert) return meta.url ? { kind: "browser", url: meta.url } : { kind: "none" };
  const base = { convId: meta.convId, title: meta.title, favicon: meta.favicon, url: meta.url };
  const localPage = meta.typed || meta.multiFile ? null : meta.filePath;
  if (localPage) {
    return { kind: "viewer", view: { ...base, filePath: localPage, kind: artifactKind(localPage) } };
  }
  if (meta.url) {
    // ⚠️ The hosted view takes the CANONICAL URL only. `isArtifactUrl` (which lets a prose link
    // become an artifact card) is tolerant of casing and a trailing slash, while the Rust host
    // refuses anything but the exact shape — so a link the front accepted could land on an error
    // panel for a perfectly good artifact. Canonicalise; if it can't be, the browser takes it,
    // exactly as it did before the in-app host existed.
    const canonical = canonicalArtifactUrl(meta.url);
    return meta.hostedInApp === false || !canonical
      ? { kind: "browser", url: meta.url }
      : { kind: "viewer", view: { ...base, url: canonical, filePath: null, kind: "hosted" } };
  }
  return { kind: "none" };
}

/**
 * Open an artifact: render it in the side-region viewer, else open the hosted page in the
 * browser. When neither route exists the click is surfaced as an app error — never swallowed
 * (a click that does nothing at all reads as a broken app).
 */
export function openArtifactView(meta: ArtifactOpenMeta): void {
  const route = routeArtifactOpen({
    ...meta,
    hostedInApp: meta.hostedInApp ?? useDisplay.getState().artifactsInApp,
  });
  if (route.kind === "viewer") {
    useEditorStore.getState().openArtifact(route.view);
    return;
  }
  if (route.kind === "browser") {
    // Every click from an inert host now lands here, so a failed hand-off to the browser is
    // the ONE reachable failure of this action — dropping the rejection would leave the user
    // with a click that did nothing and nothing to read.
    openUrl(route.url).catch((e: unknown) => {
      useAppErrors
        .getState()
        .pushError(
          `Couldn't open the artifact "${meta.title}".`,
          e instanceof Error ? e.message : String(e),
        );
    });
    return;
  }
  // BACKSTOP, not a designed state: `routeArtifactOpen` is total, but every caller already
  // refuses to invoke this without a url (the card is unclickable, the popover row disabled,
  // the prose card only exists for a matched artifact URL). Kept because the pure function's
  // contract covers the case; deliberately ONE wording, since no user path reaches it and a
  // second one tuned per host would be dead prose maintained as though it were live.
  useAppErrors
    .getState()
    .pushError(
      `Couldn't open the artifact "${meta.title}".`,
      "It has no local file to render and no published link.",
    );
}
