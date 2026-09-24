// What `WorkingIndicator` says about a live REMOTE session's SSH link — a pure
// function, so the "Connecting…"/"Reconnecting…" wording is pinned by a test rather
// than by reading JSX. Mirrors `features/tosse/liveIndicator.ts`'s own tested shape.
//
// This is highest priority in `WorkingIndicator`, above the CLI's own `retry` line: a
// remote conversation with `link` set has not even reached the daemon yet, so there is
// nothing else true to say about the turn — see `SessionStatePayload.link`'s own doc
// (Rust) for when it is set/cleared.
import type { RemoteLinkState } from "../../ipc/client";

/** The line to show while `link` is set — `null` for a local session (`link` is
 *  `null`) or once the link has attached (also `null`). */
export function remoteLinkText(link: RemoteLinkState | null | undefined): string | null {
  if (!link) return null;
  switch (link.kind) {
    case "connecting":
      return "Connecting to the server…";
    case "reconnecting":
      return "Reconnecting to the server…";
    default:
      return null;
  }
}
