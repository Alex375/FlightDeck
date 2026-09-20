// The inline card for ONE `Artifact` publish, rendered in the thread where Claude published
// it (its own segment — never grouped into a run, never hidden by clean-output). Clicking it
// routes through the shared `openArtifactView`: the local page in the in-app viewer while its
// temp file is there, else the hosted claude.ai page — in-app too, unless the host is inert or
// the user turned that off. A TYPED artifact (Claude Design…) always opens hosted: its local
// files are data, not a page.
//
// Like WorkflowCard, it derives its link from the plain-text tool_result (the URL is only there
// for a new artifact; an in-place update also names it in its input). Until the result lands it
// shows a "Publishing…" pending state; if
// the ack is ever reworded past the canonical URL shape it degrades to a non-clickable card
// (no dead link) rather than guessing. The local file_path is only ever a RENDER source (it is an
// ephemeral temp path that disappears); the durable, versioned copy is always the hosted URL.

import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { useToolResult } from "../../store/conversationStore";
import { Dot, Ico } from "../../ui/kit";
import { useDisplay } from "../../store/display";
import { artifactHeadline, publishInfo, useArtifacts } from "./artifacts";
import { openArtifactView, routeArtifactOpen } from "./artifactOpen";
import { useHostInert } from "./FileMention";
import { basename } from "./toolMeta";

export function ArtifactCard({
  session,
  toolUseId,
  input,
}: {
  session: string;
  toolUseId: string;
  input: JsonValue;
}) {
  const result = useToolResult(session, toolUseId);
  // No side region on this host (the Flight Deck reply modal) → the in-app viewer can't render,
  // so the click opens the hosted page instead of dying silently. See routeArtifactOpen.
  const inert = useHostInert();
  // NO backend guard on purpose. `Artifact` is a Claude-only tool today, but the card is
  // backend-agnostic and DEGRADES instead of vanishing: the segment is only ever produced for a
  // tool literally named `Artifact` that publishes (see isArtifactPublish), and with no
  // parseable URL the card simply renders non-clickable ("Unavailable") — never a dead link.
  // An earlier `if (isCodex) return null` made the whole tool call DISAPPEAR from the thread,
  // which is a silent drop: the user would see the model act with no trace of what it did.
  const info = publishInfo(input, result?.content);
  const url = info.url;
  // The conversation-level artifact this publish belongs to: it knows what ONE publish can't — a
  // typed artifact's name (set at creation, while this may be the later data fill) and its type.
  const artifact = useArtifacts(session).find((a) => (url ? a.url === url : a.versions.some((v) => v.toolUseId === toolUseId)));
  const typed = info.typed || !!artifact?.typed;
  const favicon = field(input, "favicon") ?? artifact?.favicon ?? null;
  const label = field(input, "label")?.trim() || null;
  const description = field(input, "description")?.trim() || null;
  const filePath = field(input, "file_path") ?? "";
  const base = basename(filePath).replace(/\.[^./]+$/, "");

  // A failed/refused publish comes back is_error:true (with a human reason) and no URL. Surface
  // it explicitly — NEVER let it read as the benign "reworded-ack" degrade (zero-silent-error).
  const errored = !!result?.isError;
  const reason = errored ? resultText(result?.content).trim() || "Publishing failed" : null;

  // Headline = the most human descriptor available; sub = an "Artifact" eyebrow plus either the
  // version label, the failure reason, or the publish status.
  // ONE naming rule, in `artifacts.ts`: `artifactTitle` (applied across every publish of this
  // artifact — a typed artifact is named by its CREATION, which this card may not be) wrapped in
  // `artifactHeadline` for this single-line surface. The local chain is only for a publish the
  // registry has no entry for yet (in flight, or every publish failed).
  // ⚠️ THIS publish's own name wins. The artifact-level title is the LAST label any publish used,
  // so borrowing it first retitled an earlier version's card with a later one's label — and
  // changed it retroactively as the user watched. A typed fill carries no name of its own, which
  // is exactly when inheriting the artifact's (set at creation) is right.
  const ownTitle = field(input, "title")?.trim() || label;
  const headline = artifactHeadline(ownTitle || artifact?.title || (typed ? "" : base) || "Artifact", description);
  const kind = typed && artifact?.typeName ? `${artifact.typeName} artifact` : "Artifact";
  const pending = !result;
  const clickable = !!url && !errored;
  const hostedInApp = useDisplay((s) => s.artifactsInApp);
  const meta = {
    convId: session,
    title: headline,
    favicon,
    url,
    filePath: filePath || null,
    typed,
    inert,
    hostedInApp,
  };
  const inApp = routeArtifactOpen(meta).kind === "viewer";
  const open = () => openArtifactView(meta);
  const detail = errored
    ? reason
    : pending
      ? "Publishing…"
      : !url
        ? "Unavailable"
        : label && label !== headline
          ? label
          : // A typed artifact takes two publishes under ONE name (create, then its content):
            // without this, two identical cards sit one after the other.
            typed
            ? field(input, "type_url")
              ? "Created"
              : "Updated"
            : null;

  return (
    <div
      className="cv-art"
      data-open={clickable || undefined}
      data-state={errored ? "error" : undefined}
      onClick={clickable ? open : undefined}
      role={clickable ? "button" : undefined}
      title={
        errored
          ? reason ?? undefined
          : clickable
            ? inApp
              ? "Open artifact in Flight Deck"
              : "Open artifact in the browser"
            : undefined
      }
    >
      <span className="cv-art-tile" aria-hidden="true">
        {favicon || "🎨"}
      </span>
      <span className="cv-art-body">
        <span className="cv-art-title">{headline}</span>
        <span className="cv-art-sub">
          <span className="cv-art-kind">{errored ? `${kind} · failed` : kind}</span>
          {detail ? <span className="cv-art-detail">{detail}</span> : null}
        </span>
      </span>
      <span className="cv-art-go">
        {errored ? (
          <Ico name="alert" className="sm" />
        ) : pending ? (
          <Dot s="work" pulse />
        ) : clickable ? (
          <Ico name="external" className="sm" />
        ) : (
          <Dot s="off" />
        )}
      </span>
    </div>
  );
}
