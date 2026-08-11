// A compact, pretty clickable card for an artifact LINK that Claude writes in its prose
// (`[label](https://claude.ai/code/artifact/<uuid>)`) — rendered in place of a plain anchor by
// StreamMarkdown's link renderer. When the artifact belongs to this conversation it is enriched
// from the registry (favicon + title) and opens in the in-app viewer; otherwise it opens the
// hosted page in the browser. Inline-block so it flows inside a paragraph.

import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Ico } from "../../ui/kit";
import { useArtifacts } from "./artifacts";
import { openArtifactView } from "./artifactOpen";

function childrenText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenText).join("");
  return "";
}

export function ArtifactRefCard({
  url,
  convId,
  inert = false,
  children,
}: {
  url: string;
  convId: string | null;
  /** Host with no side region (the Flight Deck reply modal) — the in-app viewer can't render
   *  there, so the click must open the hosted page. Passed down from the same MentionCtx that
   *  gives us `convId` (a prop, not a `useContext`, because FileMention imports THIS module). */
  inert?: boolean;
  children?: ReactNode;
}) {
  // Enrich from the conversation's artifact registry when the link points at one of its own
  // artifacts. An empty convId (off a FileMentionProvider) safely yields no matches.
  const artifacts = useArtifacts(convId ?? "");
  const match = artifacts.find((a) => a.url === url) ?? null;
  const favicon = match?.favicon ?? null;
  const label = childrenText(children).trim();
  const title = match?.title || (label && label !== url ? label : "Artifact");
  const filePath = match?.latestFilePath ?? null;

  const activate = (e: ReactMouseEvent | ReactKeyboardEvent) => {
    // Don't let the click bubble to the composer-focus / card-toggle handlers, and don't hijack a
    // selection-ending click (the user copying the link text).
    e.stopPropagation();
    if (e.type === "click" && !window.getSelection()?.isCollapsed) return;
    e.preventDefault();
    if (convId && (filePath || url)) {
      openArtifactView({ convId, title, favicon, url, filePath, inert });
    } else {
      void openUrl(url);
    }
  };

  return (
    <span
      className="cv-artref"
      role="button"
      tabIndex={0}
      data-filelink=""
      title={`Open artifact — ${title}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") activate(e);
      }}
    >
      <span className="cv-artref-fav" aria-hidden="true">
        {favicon || "🎨"}
      </span>
      <span className="cv-artref-t">{title}</span>
      <Ico name="external" className="sm" />
    </span>
  );
}
