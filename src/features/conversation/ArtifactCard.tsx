// The inline card for ONE `Artifact` publish, rendered in the thread where Claude published
// it (its own segment — never grouped into a run, never hidden by clean-output). Clicking it
// routes through the shared `openArtifactView`: the in-app viewer when the local temp file is
// still there, else the hosted page on claude.ai.
//
// Like WorkflowCard, it derives its link from the plain-text tool_result (the URL is only there,
// not in the tool_use input). Until the result lands it shows a "Publishing…" pending state; if
// the ack is ever reworded past the canonical URL shape it degrades to a non-clickable card
// (no dead link) rather than guessing. The local file_path is only ever a RENDER source (it is an
// ephemeral temp path that disappears); the durable, versioned copy is always the hosted URL.

import type { JsonValue } from "../../ipc/client";
import { field } from "../../agent/ask";
import { resultText } from "../../agent/subagentMeta";
import { useToolResult } from "../../store/conversationStore";
import { Dot, Ico } from "../../ui/kit";
import { artifactUrlFromResult } from "./artifacts";
import { openArtifactView } from "./artifactOpen";
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
  // tool literally named `Artifact` carrying a `file_path` (see toolGroup.ts), and with no
  // parseable URL the card simply renders non-clickable ("Unavailable") — never a dead link.
  // An earlier `if (isCodex) return null` made the whole tool call DISAPPEAR from the thread,
  // which is a silent drop: the user would see the model act with no trace of what it did.
  const url = artifactUrlFromResult(result?.content);
  const favicon = field(input, "favicon");
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
  const headline = description || label || base || "Artifact";
  const pending = !result;
  const clickable = !!url && !errored;
  const open = () =>
    openArtifactView({
      convId: session,
      title: headline,
      favicon: favicon ?? null,
      url,
      filePath: filePath || null,
      inert,
    });
  const detail = errored
    ? reason
    : pending
      ? "Publishing…"
      : !url
        ? "Unavailable"
        : label && label !== headline
          ? label
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
            ? inert
              ? "Open artifact on claude.ai"
              : "Open artifact in Flight Deck"
            : undefined
      }
    >
      <span className="cv-art-tile" aria-hidden="true">
        {favicon || "🎨"}
      </span>
      <span className="cv-art-body">
        <span className="cv-art-title">{headline}</span>
        <span className="cv-art-sub">
          <span className="cv-art-kind">{errored ? "Artifact · failed" : "Artifact"}</span>
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
