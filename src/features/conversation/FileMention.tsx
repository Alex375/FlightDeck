// Clickable file mentions in the conversation. A "mention" is any token that
// (a) looks like a path (see fileMentions.ts) AND (b) resolves to a real file
// under the conversation's live cwd. On click it opens that file in the side
// editor with the tree collapsed (focus-on-file), jumping to the line when the
// mention carried a `:line` suffix.
//
// Two render surfaces use this: inline-code paths in prose (StreamMarkdown) and
// the file_path chips on tool cards (ConductorToolCard / DiffView). Both read the
// conversation id + cwd from FileMentionProvider, so the rendered components stay
// prop-light. Off a provider (e.g. a standalone sub-agent transcript), mentions
// degrade to plain, non-clickable text.

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useEditorStore } from "../editor/editorStore";
import { useDisplay } from "../../store/display";
import {
  parseFileMention,
  resolveMentionAbs,
  routeMarkdownLink,
  SCHEME,
  type FileMention,
} from "./fileMentions";
import { cachedStatus, ensureMentionChecked, subscribeMention } from "./mentionCache";
import { ArtifactRefCard } from "./ArtifactRefCard";
import { isArtifactUrl } from "./artifactOpen";
import { useMarkdownDemo } from "./markdownMode";
import { looksLikeFile, looksLikePath, segmentPath, type PathParts } from "./pathSegments";

// ---- Provider: which conversation/cwd a rendered mention belongs to ----------

interface MentionCtx {
  convId: string;
  cwd: string;
  /** True when the host has no editor to reveal into (Flight Deck reply modal, where a
   *  click would be a dead link that also flips the persisted `editorOpen` flag). This is
   *  the ONLY universal gate: when set, every mention surface degrades to plain text. */
  inert: boolean;
  /** True when the tool STEP ROW's filename must not be clickable — i.e. the host is inert
   *  OR the user turned the "clickable file paths (Read/Write tools)" pref off. That pref is
   *  DELIBERATELY narrow: it only removes the navigation from the row that also expands the
   *  card (a dual-purpose click), and touches NOTHING else — not the filename in the expanded
   *  diff/snippet header, not prose paths, not Markdown file links. */
  stepRowInert: boolean;
}

const Ctx = createContext<MentionCtx | null>(null);

export function FileMentionProvider({
  convId,
  cwd,
  inert = false,
  children,
}: {
  convId: string;
  cwd: string;
  inert?: boolean;
  children: ReactNode;
}) {
  // The "clickable file paths (Read/Write tools)" pref gates ONE surface: the filename on a
  // tool step row (ToolStepRow). Everything else — prose inline-code paths, Markdown file
  // links, the filename in a diff/snippet header — stays clickable regardless of it.
  const clickableStepRow = useDisplay((s) => s.clickableFileMentions);
  const value = useMemo(
    () => ({ convId, cwd, inert, stepRowInert: inert || !clickableStepRow }),
    [convId, cwd, inert, clickableStepRow],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useFileMentionCtx(): MentionCtx | null {
  return useContext(Ctx);
}

// ---- Hook: a token → a clickable target, or null ----------------------------

interface MentionTarget {
  ctx: MentionCtx;
  abs: string;
  mention: FileMention;
}

/**
 * Resolve a candidate token to a clickable target — non-null only when it parses
 * as a path AND that path exists under the conversation cwd. Hooks run
 * unconditionally (rules of hooks); the gating happens in the returned value.
 */
function useMentionTarget(raw: string): MentionTarget | null {
  const ctx = useFileMentionCtx();
  const cwd = ctx?.cwd ?? null;
  const mention = useMemo(() => parseFileMention(raw), [raw]);
  const abs = useMemo(
    () => (mention && cwd ? resolveMentionAbs(cwd, mention.path) : null),
    [mention, cwd],
  );
  const subscribeAbs = useCallback(
    (cb: () => void) => (abs ? subscribeMention(abs, cb) : () => {}),
    [abs],
  );
  const getStatus = useCallback(() => (abs ? cachedStatus(abs) : undefined), [abs]);
  const status = useSyncExternalStore(subscribeAbs, getStatus);
  // Re-check when `abs` changes OR when an fs-change invalidation cleared the
  // cached answer (status → undefined): the path may have just been created.
  useEffect(() => {
    if (abs) ensureMentionChecked(abs);
  }, [abs, status]);

  if (!ctx || ctx.inert || !mention || !abs || status !== "exists") return null;
  return { ctx, abs, mention };
}

function openTarget(t: MentionTarget): void {
  useEditorStore
    .getState()
    .revealInEditor(
      t.ctx.convId,
      t.ctx.cwd,
      t.abs,
      t.mention.line != null ? { line: t.mention.line, column: t.mention.column } : undefined,
    );
}

/**
 * A tool-card / diff `file_path` is AUTHORITATIVE: it is a real file the agent
 * just read/edited/wrote, so the chip is always clickable — no heuristic parse,
 * no existence gate. The gate is there for PROSE (to avoid dead links from
 * guessed paths); applying it here would flicker and, worse, leave a file the
 * agent just CREATED non-clickable (it didn't exist at first render). openFile
 * surfaces a read error if the path is truly gone.
 */
function useAuthoritativeTarget(path: string | undefined, stepRow: boolean): MentionTarget | null {
  const ctx = useFileMentionCtx();
  const cwd = ctx?.cwd ?? null;
  const blocked = ctx ? (stepRow ? ctx.stepRowInert : ctx.inert) : true;
  return useMemo(() => {
    const trimmed = path?.trim();
    // Guard the one non-filesystem shape that can slip through an authoritative
    // arg: a URL/remote handle (a tool naming its arg `file_path` with a URL).
    if (!ctx || blocked || !cwd || !trimmed || SCHEME.test(trimmed)) return null;
    return { ctx, abs: resolveMentionAbs(cwd, trimmed), mention: { path: trimmed } };
  }, [ctx, blocked, cwd, path]);
}

// ---- Shared clickable element ------------------------------------------------

/**
 * Render `display` as a clickable link when `target` resolves, else as plain
 * `<Tag className>` text. `role="button"` keeps the background "click to focus
 * composer" handler (and the tool-card expand toggle) from swallowing the click;
 * we also stop propagation so the card doesn't toggle.
 */
function ClickableFile({
  element: Tag,
  className,
  display,
  target,
}: {
  element: "code" | "span" | "a";
  className?: string;
  display: ReactNode;
  target: MentionTarget | null;
}) {
  if (!target) {
    return <Tag className={className}>{display}</Tag>;
  }
  const activate = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    // Always stop the event bubbling to the tool-card header toggle / the
    // composer-focus background handler — even when we bail below, so a
    // selection-ending click on the chip never flips a toggleable card.
    e.stopPropagation();
    // Mirror focusComposerOnClick: a click that ENDS a text selection (the user
    // copying the path) must not hijack into opening the editor. Keyboard
    // activation (Enter/Space) always opens.
    if (e.type === "click" && !window.getSelection()?.isCollapsed) return;
    e.preventDefault();
    openTarget(target);
  };
  const suffix = target.mention.line != null ? `:${target.mention.line}` : "";
  return (
    <Tag
      className={className}
      role="button"
      tabIndex={0}
      data-filelink=""
      title={`Open ${target.abs}${suffix}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") activate(e);
      }}
    >
      {display}
    </Tag>
  );
}

// ---- Public components -------------------------------------------------------

/** A leading path glyph, shown only in warm/minimal modes (CSS gates `.fico`). A document
 *  for a file (last segment has an extension), a folder for a directory-shaped path. */
function PathGlyph({ isFile }: { isFile: boolean }) {
  return isFile ? (
    <svg className="fico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
      <path d="M4 1.6h5L13 5v9.4H4z" />
      <path d="M9 1.6V5h4" />
    </svg>
  ) : (
    <svg className="fico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
      <path d="M1.6 4.2h4L7 5.8h7.4v7.6H1.6z" />
    </svg>
  );
}

/**
 * Render a path token as segmented spans so the CSS modes can theme it: an icon,
 * dimmed directory segments each followed by a break-friendly `/`, the salient
 * filename, and the coloured `:line` suffix. `<wbr/>` after each separator makes the
 * chip wrap at slashes (never mid-segment). The Classic mode keeps it uniform; Warm and
 * Minimal make the filename pop and colour the line number. See pathSegments.ts.
 */
function PathDisplay({ parts }: { parts: PathParts }) {
  return (
    <>
      <PathGlyph isFile={looksLikeFile(parts.file)} />
      {parts.dirs.map((d, i) => (
        <Fragment key={i}>
          <span className="fdir">{d}</span>
          <span className="fsep">/</span>
          <wbr />
        </Fragment>
      ))}
      <span className="ffile">{parts.file}</span>
      {parts.line ? <span className="fline">{parts.line}</span> : null}
    </>
  );
}

/** Inline-code path in prose: clickable only when it resolves to a real file
 *  (heuristic detection ⇒ existence-gated to avoid dead links). Path-shaped tokens
 *  (containing a slash) render as a segmented chip; everything else stays plain. */
export function MentionInlineCode({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const raw = childrenText(children);
  const target = useMentionTarget(raw);
  const demo = useMarkdownDemo();
  // Only treat a token as a file PATH (segmented chip + icon) when it looks like one AND
  // it is a REAL file (resolves), or in the Settings preview (demo). A slash-bearing
  // non-file — e.g. a skill name like `foo/bar` — stays plain: no chip, no file icon.
  const isPath = looksLikePath(raw) && (target != null || demo);
  const display = isPath ? <PathDisplay parts={segmentPath(raw)} /> : children;
  const cn = isPath ? `${className ?? ""} fpath`.trim() : className;
  return <ClickableFile element="code" className={cn} display={display} target={target} />;
}

/**
 * A tool-card / diff file chip: `display` (the basename) is clickable, opening
 * the full authoritative `path`. Renders nothing when there is no path.
 *
 * `stepRow` marks the ONE surface the "clickable file paths (Read/Write tools)" pref
 * governs: the filename on a tool STEP ROW, whose click competes with the row's own
 * expand toggle. Everywhere else (diff/snippet header) the chip ignores that pref.
 */
export function MentionPathChip({
  path,
  className,
  display,
  stepRow = false,
}: {
  path: string | undefined;
  className?: string;
  display: ReactNode;
  stepRow?: boolean;
}) {
  const target = useAuthoritativeTarget(path, stepRow);
  if (!path) return null;
  return <ClickableFile element="span" className={className} display={display} target={target} />;
}

/**
 * A Markdown link (`[label](href)`) in prose. Codex references files as real
 * Markdown links whose href is a filesystem path (`[foo.py:42](/abs/foo.py:42)`),
 * so a path-shaped href opens the file in the side editor at the line, while a
 * genuine web URL keeps opening externally.
 *
 * ⚠️ These links are AUTHORITATIVE (a deliberate reference — Codex just acted on
 * that file), so — like a tool-card `file_path` chip and UNLIKE an inline-code path
 * guessed from prose — they are clickable WITHOUT an existence gate. Existence-
 * gating them made real links render as dead, non-clickable text whenever the
 * `pathExists` probe didn't confirm the file (a just-created file, a path outside
 * the checked dir, or a stale/temp path). `revealInEditor` surfaces a read error if
 * the file is genuinely gone. See routeMarkdownLink + StreamMarkdown's `urlTransform`.
 */
export function MentionLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const ctx = useFileMentionCtx();
  // Gated by `inert` alone: a file link the model wrote in its conversation is clickable
  // regardless of the "clickable file paths (Read/Write tools)" pref — only a host with no
  // editor to reveal into (the reply modal) forces plain text.
  const route = useMemo(
    () => routeMarkdownLink(href ?? "", { cwd: ctx?.cwd ?? "", inert: ctx?.inert ?? true }),
    [href, ctx?.cwd, ctx?.inert],
  );
  // A hosted-artifact URL renders as a compact artifact card (opens the in-app viewer / browser),
  // not a plain anchor — regardless of host, so it's recognisable everywhere Claude links one.
  // Checked AFTER the hook above so hook order stays stable if a streaming href flips.
  if (isArtifactUrl(href)) {
    return (
      <ArtifactRefCard url={href!} convId={ctx?.convId ?? null}>
        {children}
      </ArtifactRefCard>
    );
  }
  if (route.kind === "external") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  if (route.kind === "file" && ctx) {
    const target: MentionTarget = {
      ctx,
      abs: route.abs,
      mention: { path: route.abs, line: route.line, column: route.column },
    };
    return <ClickableFile element="a" display={children} target={target} />;
  }
  // No editor host (reply modal) / relative path with no cwd → plain text.
  return <>{children}</>;
}

/** Flatten react-markdown's inline-code children into their plain text. */
function childrenText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenText).join("");
  return "";
}
