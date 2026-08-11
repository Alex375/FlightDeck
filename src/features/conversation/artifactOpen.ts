// Shared "open this artifact" action, used by every artifact surface (the inline card, the
// composer chip rows, and the prose link card). It routes to the IN-APP viewer when a local
// file is available to render AND the host has a side region to render it in, and falls back
// to opening the hosted claude.ai page in the browser otherwise (e.g. a link to an artifact
// from another conversation, an inert host, or after a reload once the ephemeral temp file is
// gone and we only have the URL).

import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppErrors } from "../../store/appErrors";
import { useEditorStore, type ArtifactView } from "../editor/editorStore";
import { ARTIFACT_URL_RE } from "./artifacts";

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
 * The tolerance is safe downstream: a case-drifted URL simply fails the exact `a.url === url`
 * lookup in ArtifactRefCard and degrades to opening the hosted page in the browser.
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
   * True when the host mounts NO side region (the Flight Deck reply modal). Mirrors
   * FileMentionProvider's `inert`, the same gate every other click-to-reveal surface honours.
   */
  inert?: boolean;
}

/** Where a click on an artifact must go. Pure, so the routing rule is testable on its own. */
export type ArtifactRoute =
  | { kind: "viewer"; view: ArtifactView }
  | { kind: "browser"; url: string }
  | { kind: "none" };

/**
 * Decide where an artifact opens: the in-app viewer when there is a local file to render AND a
 * side region to render it in, else the hosted page, else nowhere.
 *
 * ⚠️ The `inert` branch is load-bearing, not defensive. An inert host (the reply modal mounts a
 * bare pane, no MainArea) has no side region, so routing there was a DEAD CLICK — and worse, it
 * still set the global `artifactView`, which then popped the viewer open the next time that
 * conversation was opened full-screen.
 */
export function routeArtifactOpen(meta: ArtifactOpenMeta): ArtifactRoute {
  if (meta.filePath && !meta.inert) {
    return {
      kind: "viewer",
      view: {
        convId: meta.convId,
        title: meta.title,
        favicon: meta.favicon,
        url: meta.url,
        filePath: meta.filePath,
        kind: artifactKind(meta.filePath),
      },
    };
  }
  if (meta.url) return { kind: "browser", url: meta.url };
  return { kind: "none" };
}

/**
 * Open an artifact: render it in the side-region viewer, else open the hosted page in the
 * browser. When neither route exists the click is surfaced as an app error — never swallowed
 * (a click that does nothing at all reads as a broken app).
 */
export function openArtifactView(meta: ArtifactOpenMeta): void {
  const route = routeArtifactOpen(meta);
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
  useAppErrors
    .getState()
    .pushError(
      `Couldn't open the artifact "${meta.title}".`,
      meta.inert
        ? "This view has no side panel to render its local file, and the artifact has no published link yet."
        : "It has no local file to render and no published link.",
    );
}
