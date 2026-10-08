// Announcing the one-shot folder-routing repair the core ran at launch.
//
// Older versions picked a spawn's machine from the conversation's PATH alone, so with a
// folder on this Mac and one on a server at the same path, a conversation could run on the
// machine its folder is NOT on. Now that a spawn follows the folder, the core re-attaches
// such conversations to the folder they really ran in (on evidence — see Rust
// `Store::reconcile_path_routed_conversations`). Moving a conversation between groups
// without a word would look like data shuffling on its own, so whatever the repair did —
// or could not do — is said here, once.

import { commands, type FolderRoutingReport } from "../ipc/client";
import { useAppErrors } from "./appErrors";
import { pushInfoToast } from "./toasts";

export interface FolderRoutingAnnouncement {
  /** What was moved — informational, nothing for the user to do. */
  info: string | null;
  /** What could not be settled — kept on screen, the user should look. */
  warning: { message: string; detail: string } | null;
}

const MAX_NAMED = 3;

function quoteNames(names: string[]): string {
  const shown = names.slice(0, MAX_NAMED).map((n) => `"${n}"`);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** Turn the core's repair report into what the user is told. Pure. */
export function folderRoutingAnnouncement(report: FolderRoutingReport | null): FolderRoutingAnnouncement {
  if (!report) return { info: null, warning: null };
  const { moved, unresolved, error } = report;

  let info: string | null = null;
  if (moved.length > 0) {
    const destinations = [...new Set(moved.map((m) => m.to_machine))];
    const destination =
      destinations.length > 1
        ? "the folders of the machines they ran on"
        : destinations[0] === null
          ? "this Mac's folder at the same path"
          : `the folder on server ${destinations[0]}`;
    const count = moved.length === 1 ? "1 conversation was" : `${moved.length} conversations were`;
    const pronoun = moved.length === 1 ? "it" : "them";
    info =
      `${count} moved to ${destination} — an earlier version ran ${pronoun} there: ` +
      `${quoteNames(moved.map((m) => m.conversation_name))}.`;
  }

  const lines: string[] = [];
  for (const u of unresolved) lines.push(`"${u.conversation_name}": ${u.reason}.`);
  if (error) lines.push(error);
  const warning =
    lines.length === 0
      ? null
      : {
          message:
            unresolved.length > 0
              ? `${unresolved.length === 1 ? "1 conversation" : `${unresolved.length} conversations`} may be filed under the wrong machine's folder`
              : "Couldn't finish checking which machine past conversations ran on",
          detail: lines.join("\n"),
        };
  return { info, warning };
}

/** Fetch the launch's repair report (once) and tell the user what it did. A failure to
 *  even fetch it is said too — a silent miss would hide moved conversations. */
export async function announceFolderRoutingRepair(): Promise<void> {
  let report: FolderRoutingReport | null;
  try {
    report = await commands.takeFolderRoutingReport();
  } catch (e) {
    useAppErrors
      .getState()
      .pushError(
        "Couldn't read the result of the conversation-folder check",
        e instanceof Error ? e.message : String(e),
      );
    return;
  }
  const { info, warning } = folderRoutingAnnouncement(report);
  // Sticky: the moves are permanent and happen once — a toast that fades in seconds at
  // boot could go unseen, and the conversations would just have changed group unexplained.
  if (info) pushInfoToast(info, { sticky: true });
  if (warning) useAppErrors.getState().pushError(warning.message, warning.detail);
}
