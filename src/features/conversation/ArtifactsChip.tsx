// The composer's "Artifacts (N)" chip: the always-reachable, per-conversation index of every
// artifact Claude published in this conversation, grouped by artifact with its version history.
// Click the chip → a portal popover (fixed-positioned under it, opening upward from the composer)
// listing each artifact newest-first; click a row → open it (in-app viewer, or the hosted page on
// claude.ai when this host has no side region to render it in — see routeArtifactOpen).
//
// Rendered ONLY when the conversation has ≥1 artifact (Codex conversations never do — the
// Artifact tool is Claude-only). READ-ONLY toward claude.ai — it only surfaces what was already
// published; it never issues a publish/list call. The portal escapes the composer's overflow the
// same way <BackgroundTaskBadge> does.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dot, Ico } from "../../ui/kit";
import { useArtifacts, type Artifact } from "./artifacts";
import { openArtifactView } from "./artifactOpen";

/** Fixed placement of the portaled popover, anchored to the chip. */
interface ArtifactPopPos {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** Popover width (kept in sync with `.cv-artpop { max-width }` in conductor-conversation.css) —
 *  used to clamp the popover inside the viewport before it has been measured. */
const POP_W = 320;

/**
 * Pure: where to put the popover given the chip's live rect. Extracted so the placement can be
 * RE-RUN cheaply from a resize/scroll listener (see the effect below) instead of being frozen at
 * click time — a frozen `position:fixed` popover visibly detaches from its chip as soon as the
 * window resizes or an ancestor scrolls.
 */
function artifactPopPlacement(r: DOMRect): ArtifactPopPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, r.left), vw - POP_W - 8);
  const belowSpace = vh - r.bottom - 12;
  const aboveSpace = r.top - 12;
  // The chip lives in the composer near the bottom, so there is usually more room ABOVE:
  // open upward unless below genuinely has more space.
  if (belowSpace > aboveSpace && belowSpace >= 220) {
    return { left, top: r.bottom + 6, maxHeight: belowSpace };
  }
  return { left, bottom: vh - r.top + 6, maxHeight: aboveSpace };
}

/** One artifact in the popover: its favicon + title + description + version count, opening the
 *  artifact in the in-app viewer (or the hosted page on an `inert` host); its versions expand
 *  inline (informational — the wire exposes one canonical URL, not a per-version link, so we
 *  never fabricate one). */
function ArtifactRow({
  art,
  session,
  inert,
  onOpened,
}: {
  art: Artifact;
  session: string;
  inert: boolean;
  onOpened: () => void;
}) {
  const [showVersions, setShowVersions] = useState(false);
  const url = art.url;
  const vcount = art.versions.length;
  const open = () => {
    openArtifactView({
      convId: session,
      title: art.title,
      favicon: art.favicon,
      url,
      filePath: art.latestFilePath,
      inert,
    });
    onOpened();
  };
  return (
    <div className="cv-artpop-item">
      <div className="cv-artpop-head">
        <button
          type="button"
          className="cv-artpop-open"
          disabled={!url}
          onClick={open}
          title={url ? (inert ? "Open on claude.ai" : "Open in Flight Deck") : "Not published yet"}
        >
          <span className="cv-artpop-fav" aria-hidden="true">
            {art.favicon || "🎨"}
          </span>
          <span className="cv-artpop-main">
            <span className="cv-artpop-title">{art.title}</span>
            {art.description ? <span className="cv-artpop-desc">{art.description}</span> : null}
          </span>
          {url ? <Ico name="external" className="sm" /> : <Dot s="off" />}
        </button>
        {vcount > 1 ? (
          <button
            type="button"
            className="cv-artpop-vbtn"
            onClick={() => setShowVersions((v) => !v)}
            aria-expanded={showVersions}
            title={showVersions ? "Hide versions" : "Show versions"}
          >
            <span className="wf-mono">v{vcount}</span>
            <Ico name="chev" className="sm" />
          </button>
        ) : (
          <span className="cv-artpop-v1 wf-mono">v1</span>
        )}
      </div>
      {vcount > 1 && showVersions ? (
        <div className="cv-artpop-versions">
          {art.versions
            .slice()
            .reverse()
            .map((v, i) => (
              <div key={v.toolUseId} className="cv-artpop-vrow">
                <span className="cv-artpop-vn wf-mono">v{vcount - i}</span>
                <span className="cv-artpop-vlabel">{v.label ?? "—"}</span>
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

// ⚠️ Do NOT migrate this popover to the shared <Menu portal> component, tempting as the overlap
// looks: `Menu` closes on ANY click inside its popover (`onClick={() => setOpen(false)}` on the
// popover root), which would make the per-artifact "vN" version-expand button close the popover
// instead of expanding it. This one owns its own portal + placement precisely to keep clicks
// inside it non-dismissing; only a row click (which navigates away) closes it.
export function ArtifactsChip({
  session,
  inert = false,
}: {
  session: string;
  /**
   * True when the host mounts NO side region to reveal an artifact into (the Flight Deck
   * reply modal). Same question `FileMentionProvider`'s `inert` answers for the thread — but
   * the composer sits OUTSIDE that provider, so the host passes it down instead.
   *
   * ⚠️ It used to be re-derived here by asking the reply-modal store whether IT was showing
   * this conversation. That hard-coded one host into a shared question: a second host without
   * a side region, or a differently keyed modal store, and clicks would silently route back
   * into a viewer that cannot render — the dead click (plus the leaked `artifactView` that
   * popped open later) this gate exists to prevent.
   */
  inert?: boolean;
}) {
  const artifacts = useArtifacts(session);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<ArtifactPopPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on Escape while open. This popover owns Escape while open, so stopPropagation keeps an
  // outer window-level modal (the Flight Deck reply modal) from also closing on the same keypress.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Place the popover while open, and KEEP IT GLUED to the chip: the placement is `position:fixed`
  // in a portal, so anything that moves the chip in viewport space (a window resize, an ancestor
  // scrolling) leaves a stale popover floating away from its trigger. Same treatment as the shared
  // <Menu portal>: measure on open, then re-measure on resize and on scroll in the CAPTURE phase
  // (scroll doesn't bubble — a capture listener on `window` is the only way to see an inner
  // scroller move). Layout effect so the first placement lands BEFORE paint (no flash at 0,0), and
  // measuring is a single `getBoundingClientRect` + arithmetic, so the scroll path stays cheap.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos(artifactPopPlacement(r));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const n = artifacts.length;
  if (n === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="wf-chip"
        data-open={open || undefined}
        onClick={() => setOpen((o) => !o)}
        title={`${n} artifact${n === 1 ? "" : "s"} published in this conversation`}
        aria-label="Artifacts"
      >
        <Ico name="artifact" className="sm" />
        <span className="wf-mono">{n}</span>
      </button>

      {open && pos
        ? createPortal(
            <div className="cv-artpop-backdrop" onClick={() => setOpen(false)}>
              <div
                className="cv-artpop"
                style={{
                  position: "fixed",
                  left: pos.left,
                  top: pos.top,
                  bottom: pos.bottom,
                  maxHeight: pos.maxHeight,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="cv-artpop-h">
                  <Ico name="artifact" className="sm" />
                  Artifacts
                  <span className="cv-artpop-count wf-mono">{n}</span>
                </div>
                {artifacts
                  .slice()
                  .reverse()
                  .map((a) => (
                    <ArtifactRow
                      key={a.url ?? a.latestFilePath}
                      art={a}
                      session={session}
                      inert={inert}
                      onOpened={() => setOpen(false)}
                    />
                  ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
