// The side-region ARTIFACT VIEWER, in one of two modes:
//  - LOCAL: reads a page artifact's local file and renders it in place — self-contained HTML in a
//    sandboxed (null-origin) iframe under our own CSP, Markdown via the thread renderer. READ-ONLY,
//    and the iframe's scripts can reach neither the app nor the network.
//  - HOSTED: the artifact's claude.ai page itself, in the native webview the artifact host lays
//    over the panel (see artifactHost.ts). The only way to see a TYPED artifact (Claude Design…)
//    in-app — its page exists nowhere else — and the fallback whenever the local file can't be
//    rendered (the temp path is ephemeral: gone, too large, not text, unreadable).
// When neither works (no hosted link, or the user turned the in-app hosted view off) the viewer
// says WHICH local failure happened and offers the browser.

import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../../ipc/client";
import type { FileStat } from "../../ipc/client";
import { useDisplay } from "../../store/display";
import { Ico } from "../../ui/kit";
import type { ArtifactView } from "../editor/editorStore";
import { withArtifactCsp } from "./artifactCsp";
import {
  attachArtifactHost,
  pageHost,
  retryArtifactHost,
  signInWithPastedLink,
  useArtifactHostStatus,
  type HostPhase,
} from "./artifactHost";
import { StreamMarkdown } from "./StreamMarkdown";

/** How often the local file is re-checked for a rewrite. No fs watch reaches it:
 *  artifacts live in a temp dir outside the watched cwd, and opening this viewer
 *  unmounts the editor panel (which is what owns the watch). */
const POLL_MS = 2000;

/**
 * A stat reduced to "is this a different file state than last time".
 *
 * Deliberately NOT the editor's `diskStampChanged`, which answers "might this be
 * stale?" and so treats an unreadable path as changed — correct for a one-shot
 * check, but on a repeating tick a deleted file would then re-trigger a failing
 * reload every two seconds, forever. Comparing successive observations instead
 * makes "still gone" a non-event, while a file that comes back is one.
 */
function statKey(s: FileStat): string {
  return s.exists ? `${s.size}:${s.mtime_ms ?? "?"}` : "gone";
}

/**
 * Why the file can't be shown. These stay DISTINCT outcomes on purpose: they used to collapse
 * into one vague "isn't available", which told the user nothing and (for a genuine read failure)
 * swallowed the reason entirely. Each one gets its own honest message — zero silent error.
 */
type LoadFailure =
  /** The artifact carries no local path at all — there is nothing to read. */
  | { status: "nopath" }
  /** `read_file` failed (file swept from /tmp, permissions, I/O). `reason` is surfaced verbatim. */
  | { status: "unreadable"; reason: string }
  /** Over `fs::MAX_FILE_BYTES` — the backend returns EMPTY content, so there is nothing to render. */
  | { status: "tooLarge"; size: number }
  /** A NUL byte was found → not text; `content` is empty and it can never render as HTML/Markdown. */
  | { status: "binary" };

type Load = { status: "loading" } | { status: "ready"; content: string } | LoadFailure;

/** Human-readable byte size, for the "too large" message only. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the user is told for each failure: what happened, and why when we know it. */
function failureMessage(f: LoadFailure): { headline: string; detail: string | null } {
  switch (f.status) {
    case "nopath":
      return {
        headline: "The local copy of this artifact is gone.",
        detail: "No local file was recorded for it (its temp file is ephemeral and doesn’t survive a reload).",
      };
    case "tooLarge":
      return {
        headline: "This artifact is too large to preview here.",
        detail: `${formatBytes(f.size)} — over the app’s 16 MiB read limit.`,
      };
    case "binary":
      return {
        headline: "This artifact isn’t previewable text.",
        detail: "Its file contains binary data, so it can’t be rendered as HTML or Markdown.",
      };
    case "unreadable":
      return { headline: "This artifact’s local file couldn’t be read.", detail: f.reason };
  }
}

/** The failure panel: the reason, plus the hosted copy as a way out whenever we know its URL. */
function ArtifactUnavailable({
  failure,
  favicon,
  url,
}: {
  failure: LoadFailure;
  favicon: string | null;
  url: string | null;
}) {
  const { headline, detail } = failureMessage(failure);
  return (
    <div className="cv-artview-msg">
      <span className="cv-artview-fav cv-artview-msgfav" aria-hidden="true">
        {favicon || "🎨"}
      </span>
      <p>{headline}</p>
      {detail ? <p style={{ opacity: 0.75 }}>{detail}</p> : null}
      {url ? (
        <button type="button" className="cv-artview-open" onClick={() => void openUrl(url)}>
          <Ico name="external" className="sm" /> Open in browser
        </button>
      ) : (
        <p style={{ opacity: 0.75 }}>No hosted link is known for it either.</p>
      )}
    </div>
  );
}

/**
 * What the header says about the hosted page (null: nothing to say).
 *
 * ⚠️ `offsite` names the page's REAL host and never claims it is claude.ai: the app's own chrome
 * saying "sign in to claude.ai" over a page on some other domain is exactly the frame a fake
 * credential form would want.
 */
export function hostStatusText(phase: HostPhase, host: string | null): string | null {
  switch (phase) {
    case "loading":
      return "Loading…";
    case "ready":
      return null;
    case "signin":
      return "Sign in to claude.ai to see it — once";
    case "offsite":
      return host ? `Showing ${host} — not the artifact` : "Showing another site — not the artifact";
    case "error":
      return "Couldn’t show it here";
  }
}

/**
 * The HOSTED mode's body: a placeholder the native artifact host is laid over (it follows this
 * element's box and steps aside for any overlay). What renders here is only seen while the host
 * is not painting — loading, hidden under a menu, or failed.
 */
/**
 * What the panel offers while claude.ai asks for a sign-in.
 *
 * It says plainly what does NOT work here and why — macOS reserves passkeys-on-this-Mac and
 * password AutoFill for apps with Apple's browser entitlement, which a self-signed app cannot
 * hold — because the alternative is the user fighting a passkey prompt that can only ever fall
 * back to their phone. And it carries the one path a browser would otherwise steal: the emailed
 * link, which opens in the default browser and signs in a session this webview never sees.
 */
function SignInHelp() {
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    if (!link.trim()) return;
    void signInWithPastedLink(link).then((reason) => {
      setProblem(reason);
      if (!reason) setLink("");
    });
  };
  return (
    <div className="cv-artview-signin">
      <p>
        Sign in with your <strong>password</strong>, a passkey <strong>from your phone</strong>, or the link claude.ai
        emails you. Passkeys on this Mac and saved-password autofill only work in a browser — macOS doesn’t offer them
        to this window.
      </p>
      <div className="cv-artview-signin-row">
        <input
          type="url"
          value={link}
          spellCheck={false}
          placeholder="Paste the sign-in link from your email"
          aria-label="Paste the sign-in link from your email"
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button type="button" className="cv-artview-open" onClick={submit} disabled={!link.trim()}>
          Open it here
        </button>
      </div>
      {problem ? <p className="cv-artview-signin-err">{problem}</p> : null}
    </div>
  );
}

function HostedArtifact({ url, favicon }: { url: string; favicon: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const phase = useArtifactHostStatus((s) => (s.url === url ? s.phase : "loading"));
  const error = useArtifactHostStatus((s) => (s.url === url ? s.error : null));
  const pageUrl = useArtifactHostStatus((s) => (s.url === url ? s.pageUrl : null));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachArtifactHost(el, url);
  }, [url]);
  return (
    <>
      {/* ⚠️ OUTSIDE the tracked box: the native view covers that box entirely while it is up, so
          anything rendered inside it during sign-in would be invisible behind the page. */}
      {phase === "signin" ? <SignInHelp /> : null}
      <div ref={ref} className="cv-artview-host">
      {phase === "error" ? (
        <div className="cv-artview-msg">
          <span className="cv-artview-fav cv-artview-msgfav" aria-hidden="true">
            {favicon || "🎨"}
          </span>
          <p>This artifact’s claude.ai page couldn’t be shown here.</p>
          {error ? <p style={{ opacity: 0.75 }}>{error}</p> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="cv-artview-open" onClick={retryArtifactHost}>
              <Ico name="refresh" className="sm" /> Try again
            </button>
            <button type="button" className="cv-artview-open" onClick={() => void openUrl(url)}>
              <Ico name="external" className="sm" /> Open in browser
            </button>
          </div>
        </div>
      ) : (
        <div className="cv-artview-msg">
          <span className="cv-artview-fav cv-artview-msgfav" aria-hidden="true">
            {favicon || "🎨"}
          </span>
          {/* Same source as the header — this shows whenever the native view steps aside (a menu,
              a toast, a folded panel), and it must not call another site "claude.ai". */}
          <p>{phase === "loading" ? "Loading from claude.ai…" : hostStatusText(phase, pageHost(pageUrl)) ?? "claude.ai"}</p>
        </div>
      )}
      </div>
    </>
  );
}

export function ArtifactViewer({ view, onClose }: { view: ArtifactView; onClose: () => void }) {
  // Hosted view: nothing local to read — the whole body is the claude.ai page.
  if (view.kind === "hosted") return <HostedArtifactViewer view={view} onClose={onClose} />;
  return <LocalArtifactViewer view={view} onClose={onClose} />;
}

/** The viewer's header: favicon, title, the hosted page's status and its actions. */
function ViewerHeader({
  view,
  hosted,
  onClose,
}: {
  view: ArtifactView;
  /** True while the body shows the claude.ai page (adds its status + a reload). */
  hosted: boolean;
  onClose: () => void;
}) {
  const url = view.url;
  const live = useArtifactHostStatus((s) => (hosted && url && s.url === url ? s : null));
  const phase = live?.phase ?? null;
  const status = phase ? hostStatusText(phase, pageHost(live?.pageUrl ?? null)) : null;
  return (
    <div className="cv-artview-h">
      <span className="cv-artview-fav" aria-hidden="true">
        {view.favicon || "🎨"}
      </span>
      <span className="cv-artview-title" title={view.title}>
        {view.title}
      </span>
      {status ? (
        // `title`: the panel can be narrow enough to ellipse the host name away, and that name is
        // the whole point of the offsite warning.
        <span className="cv-artview-status" data-phase={phase ?? undefined} title={status}>
          {status}
        </span>
      ) : null}
      {hosted ? (
        <button
          type="button"
          className="cv-artview-btn"
          // Off-site, this button is the way BACK: it re-opens the artifact's own URL.
          title={phase === "offsite" ? "Back to the artifact" : "Reload from claude.ai"}
          aria-label={phase === "offsite" ? "Back to the artifact" : "Reload from claude.ai"}
          onClick={retryArtifactHost}
        >
          <Ico name="refresh" className="sm" />
        </button>
      ) : null}
      {url ? (
        <button
          type="button"
          className="cv-artview-btn"
          title="Open in browser"
          aria-label="Open in browser"
          onClick={() => void openUrl(url)}
        >
          <Ico name="external" className="sm" />
        </button>
      ) : null}
      <button type="button" className="cv-artview-btn" title="Close" aria-label="Close artifact viewer" onClick={onClose}>
        <Ico name="x" className="sm" />
      </button>
    </div>
  );
}

function HostedArtifactViewer({ view, onClose }: { view: ArtifactView; onClose: () => void }) {
  return (
    <div className="cv-artview">
      <ViewerHeader view={view} hosted={!!view.url} onClose={onClose} />
      <div className="cv-artview-body">
        {view.url ? (
          <HostedArtifact url={view.url} favicon={view.favicon} />
        ) : (
          // Unreachable by construction (routing only builds a hosted view from a URL) — kept
          // so a malformed view still explains itself instead of rendering a blank panel.
          <ArtifactUnavailable failure={{ status: "nopath" }} favicon={view.favicon} url={null} />
        )}
      </div>
    </div>
  );
}

function LocalArtifactViewer({ view, onClose }: { view: ArtifactView; onClose: () => void }) {
  const hostedInApp = useDisplay((s) => s.artifactsInApp);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /** Bumped when the file changed underneath us, to re-run the load effect. */
  const [rev, setRev] = useState(0);
  /** The file state the panel has already ACTED on (see `statKey`): stamped by a successful
   *  read, and by the poll each time it triggers a reload. `null` means "nothing acted on
   *  yet" — first open, or a read that failed before it could stamp anything. */
  const seenKey = useRef<string | null>(null);
  /** Which artifact is currently on screen, to tell "a different one" from "the
   *  same one, rewritten". */
  const shownPath = useRef<string | null>(null);
  const url = view.url;

  useEffect(() => {
    let cancelled = false;
    const path = view.filePath;
    // Switching to a DIFFERENT artifact blanks the panel (its content has nothing
    // to do with what's on screen). A re-publish of the SAME one doesn't: the
    // current version stays visible until the new bytes are in, so an artifact
    // being iterated on doesn't strobe.
    if (shownPath.current !== path) {
      setLoad({ status: "loading" });
      seenKey.current = null;
      shownPath.current = path;
    }
    if (!path) {
      setLoad({ status: "nopath" });
      return;
    }
    commands
      .readFile(path)
      .then((res) => {
        if (cancelled) return;
        if (res.status === "ok") {
          // Remember what we just rendered, so the poll below only reacts to
          // changes that landed AFTER it.
          seenKey.current = `${res.data.size}:${res.data.mtime_ms ?? "?"}`;
        }
        if (res.status !== "ok") {
          // A failed read is a REAL failure (temp file swept, permissions, I/O): log it and show
          // the underlying reason instead of a generic message that hides what went wrong.
          console.error("ArtifactViewer: readFile failed for", path, "-", res.error);
          setLoad({ status: "unreadable", reason: res.error });
          return;
        }
        const f = res.data;
        // `too_large` and `binary` both come back with EMPTY content — rendering that would show a
        // blank frame and look like a bug, so each is reported as what it is.
        if (f.too_large) setLoad({ status: "tooLarge", size: f.size });
        else if (f.binary) setLoad({ status: "binary" });
        else setLoad({ status: "ready", content: f.content });
      })
      .catch((e: unknown) => {
        // The generated bindings RETHROW genuine `Error`s (only string command errors become error
        // Results). Without this branch a transport failure would leave the viewer stuck on
        // "Loading…" forever, with nothing in the console to explain it.
        if (cancelled) return;
        const reason = e instanceof Error ? e.message : String(e);
        console.error("ArtifactViewer: readFile threw for", path, "-", reason);
        setLoad({ status: "unreadable", reason });
      });
    return () => {
      cancelled = true;
    };
  }, [view.filePath, rev]);

  // Keep the preview honest while it's on screen. Re-publishing an artifact rewrites
  // the SAME temp path, so nothing here changes prop-wise and the panel would go on
  // showing the previous version as though it were the current one. Nothing else can
  // tell us: the file lives outside the watched cwd, and this viewer replaces the
  // editor panel that owns the fs watch. Cost is one stat every couple of seconds.
  useEffect(() => {
    const path = view.filePath;
    if (!path) return;
    let stopped = false;
    const check = async () => {
      if (stopped || (typeof document !== "undefined" && document.hidden)) return;
      let stat: FileStat | undefined;
      try {
        const res = await commands.statFiles([path]);
        if (res.status !== "ok") {
          console.error("ArtifactViewer: statFiles failed for", path, "-", res.error);
          return;
        }
        stat = res.data[0];
      } catch (e) {
        console.error("ArtifactViewer: statFiles threw for", path, "-", e);
        return;
      }
      if (stopped || !stat) return;
      const key = statKey(stat);
      // A null stamp means the panel has acted on NOTHING yet — the read failed (temp file
      // swept, or the viewer was opened before the file landed). That has to mean "try this
      // observation", never "stop polling": bailing on null left a viewer whose first read
      // failed stuck on the error panel forever, even after Claude re-published seconds later
      // to the very same path. Claiming the key BEFORE reloading is what keeps that honest AND
      // cheap: a doomed retry costs one read per DISTINCT file state, so a file that stays
      // gone (or stays unreadable at the same size+mtime) is a non-event from the next tick on.
      if (key === seenKey.current) return;
      seenKey.current = key;
      setRev((r) => r + 1);
    };
    const id = setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [view.filePath]);

  // Splice the CSP in ONCE per loaded document, not on every render: the artifact's HTML can be
  // megabytes and this component re-renders on any layout change (a splitter drag re-renders
  // MainArea), so doing it inline would re-scan + re-copy that string on every animation frame.
  const frameHtml = useMemo(
    () => (load.status === "ready" && view.kind === "html" ? withArtifactCsp(load.content) : null),
    [load, view.kind],
  );

  // The local file can't be rendered (gone, too large, not text, unreadable) but the artifact has
  // a hosted copy → show THAT, in-app, rather than a dead end. Off (pref), or no URL → the
  // failure panel below, which names what went wrong and offers the browser.
  const hostedFallback =
    hostedInApp && !!url && load.status !== "loading" && load.status !== "ready" ? url : null;

  return (
    <div className="cv-artview">
      <ViewerHeader view={view} hosted={!!hostedFallback} onClose={onClose} />
      <div className="cv-artview-body">
        {hostedFallback ? (
          <HostedArtifact url={hostedFallback} favicon={view.favicon} />
        ) : load.status === "loading" ? (
          <div className="cv-artview-msg">Loading…</div>
        ) : load.status === "ready" ? (
          view.kind === "md" ? (
            <div className="cv-artview-md">
              <StreamMarkdown text={load.content} />
            </div>
          ) : (
            <iframe
              className="cv-artview-frame"
              // Sandboxed to a NULL origin (NO allow-same-origin): the artifact's own scripts run
              // but cannot reach the app / its storage. srcDoc renders the self-contained HTML.
              //
              // `allow-popups` is a DELIBERATE choice, not an oversight: an artifact may
              // legitimately link out (a source, a doc), and a popup opened from a sandboxed frame
              // INHERITS the sandbox — so the escape hatch it grants is a new null-origin window,
              // not a privileged one.
              //
              // The sandbox alone gives isolation but NOT network restriction, and the app's own
              // Tauri CSP is `null` — while on claude.ai the very same page runs behind a strict
              // CSP blocking every external host. `withArtifactCsp` re-creates that guarantee
              // inside the document, so an in-app preview is never more capable than the hosted
              // page. See artifactCsp.ts.
              sandbox="allow-scripts allow-popups"
              srcDoc={frameHtml ?? ""}
              title={view.title}
            />
          )
        ) : (
          <ArtifactUnavailable failure={load} favicon={view.favicon} url={url} />
        )}
      </div>
    </div>
  );
}
