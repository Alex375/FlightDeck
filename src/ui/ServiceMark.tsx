import { createElement, useId, useMemo, type ReactNode } from "react";
import { SERVICE_MARK_ART, type SvgNode, type SvgProps } from "./serviceMarkArt";

/** One prop value with the mark's ids made unique to an instance: an `id` gets the suffix,
 *  and a reference to one — `url(#…)` inside a fill/mask/filter, or an `href="#…"` — is
 *  repointed at the renamed id. A mark repeats down a thread, and a shared id resolves to the
 *  FIRST definition in the document — which paints nothing once that copy sits in a
 *  collapsed/hidden subtree (same reason as TosseMark's per-instance gradients). */
export function scopeSvgValue(key: string, value: string, suffix: string): string {
  if (key === "id") return `${value}-${suffix}`;
  if ((key === "href" || key === "xlinkHref") && value.startsWith("#")) return `${value}-${suffix}`;
  return value.includes("url(#") ? value.replace(/url\(#([^)]+)\)/g, `url(#$1-${suffix})`) : value;
}

function scopeProps(props: SvgProps, suffix: string): SvgProps {
  const out: SvgProps = {};
  for (const [k, v] of Object.entries(props)) out[k] = typeof v === "string" ? scopeSvgValue(k, v, suffix) : v;
  return out;
}

function renderNodes(nodes: SvgNode[], suffix: string): ReactNode[] {
  return nodes.map(([tag, props, children], i) =>
    createElement(
      tag,
      { ...scopeProps(props, suffix), key: i },
      ...(children ? renderNodes(children, suffix) : []),
    ),
  );
}

/** The logo of a well-known service an MCP tool call went to (Gmail, Qonto, Playwright…),
 *  keyed by `McpService.id` (src/agent/mcpServices.ts). Sized via CSS (`.wf-svc-mark`).
 *  Full-colour marks keep their own colours; monochrome ones (GitHub, Apple, Railway…) are
 *  drawn in `currentColor`, so they take the surrounding glyph colour like any icon.
 *
 *  The art is an element tree from `serviceMarkArt.ts` rendered with createElement — React
 *  escapes every value, so no markup string ever reaches the DOM. An unknown id renders
 *  nothing: callers only ask for ids the registry returned. */
export function ServiceMark({ id, className }: { id: string; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const art = SERVICE_MARK_ART[id];
  const children = useMemo(() => (art ? renderNodes(art.nodes, `svc${uid}`) : null), [art, uid]);
  if (!art) return null;
  return (
    <svg className={"wf-svc-mark " + (className || "")} viewBox={art.viewBox} aria-hidden="true">
      {children}
    </svg>
  );
}
