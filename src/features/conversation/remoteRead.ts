// Words for a read routed by conversation (`read_task_output`, `load_subagent_transcript`,
// `load_workflow_run`, `load_session_goal`). Those reads go to this Mac's disk for a local
// conversation and to the conversation's SERVER for a remote one, and fail typed
// (`FileReadError`) so a drill-in can say WHERE and WHAT — "couldn't reach Target", not
// "couldn't load it" — instead of blaming a file this Mac was never going to have.
//
// Pure, React-free: every surface wraps the sentence in its own lead ("Unreadable output: …",
// "Transcript unreadable: …").

import type { FileReadError } from "../../ipc/client";

/** A read failure as one plain sentence fragment, naming the server when there is one. A bare
 *  string (a thrown IPC/transport error caught by the caller) passes through. */
export function fileReadErrorText(err: FileReadError | string): string {
  if (typeof err === "string") return err;
  switch (err.kind) {
    case "unknown_conversation":
      return "this conversation is no longer known to Flight Deck";
    case "unreachable":
      return `couldn't reach ${err.server} — ${err.reason}`;
    case "refused":
      return err.server ? `${err.server} refused the read — ${err.reason}` : err.reason;
    case "io":
      return err.server ? `couldn't read it on ${err.server} — ${err.reason}` : err.reason;
  }
}
