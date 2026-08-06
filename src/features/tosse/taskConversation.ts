// Opening a conversation ON a TOSSE task — the one path both buttons go through.
//
// It always creates a NEW one. A task can legitimately carry several conversations (a
// retry after a rewind, a second opinion, a discussion running alongside the work), and
// the tasks view offers the existing ones separately under "Open". What it still
// guarantees is that the new conversation is LINKED before anything is sent, so it is
// findable from the task even if the send fails.

import { sendConversationMessage } from "../../ipc/useCommands";
import {
  conversationsForTask,
  createConversationInRepo,
  useConversationsStore,
} from "../../store/conversationsStore";
import { useConversationStore } from "../../store/conversationStore";
import {
  discussPrompt,
  pickupCommand,
  pickupCommandName,
  pickupFallbackPrompt,
  pickupSupport,
  type LaunchTask,
  type PickupSupport,
} from "./taskPrompts";

/** Which button was pressed. See `taskLaunch` for what each one means. */
export type LaunchMode = "pickup" | "discuss";

export interface LaunchRequest {
  task: LaunchTask;
  /** The local folder to open the conversation in — already resolved (or picked) by
   *  the caller, see `taskFolder`. */
  repoId: string;
  mode: LaunchMode;
  /** "Discuss" only: what the user typed before opening. Empty is allowed — the prompt
   *  then asks the open question. */
  question?: string;
  /** "Start" only: an extra instruction for THIS run, typed in the button's drop-down. */
  extra?: string;
  /**
   * The pickup skill's published name in that folder, when the caller has just resolved
   * it (e.g. right after enabling the plugin, where the store's cache is fresher than
   * this call could re-derive). Omitted → resolved here.
   */
  pickupName?: string | null;
}

export interface LaunchOutcome {
  convId: string;
  /** How `/pickup` was resolved for this folder — "absent"/"unknown" means written
   *  instructions were sent instead, which the caller SAYS out loud. */
  pickup: PickupSupport | null;
}

/**
 * Open (or reopen) the conversation for a task and send its first message.
 *
 * Throws if the send fails — after having put the failure in the conversation's own
 * thread, so it is visible whether or not the caller navigates there.
 */
export async function launchTaskConversation(req: LaunchRequest): Promise<LaunchOutcome> {
  const store = useConversationsStore.getState();
  const repo = store.repos.find((r) => r.id === req.repoId);
  if (!repo) {
    // The folder disappeared between resolving it and clicking. Refusing loudly beats
    // opening a conversation in some other folder.
    throw new Error("This project's folder is no longer registered in Flight Deck.");
  }

  // How many this task already carries — the next one is numbered, so a second pass is
  // told apart from the first in the sidebar and in the task's own "Open" menu.
  const nth = conversationsForTask(store.conversations, req.task.id).length + 1;
  const convId = createConversationInRepo(repo.path);
  // Link BEFORE sending: if the send fails, the conversation still belongs to the task,
  // so it stays findable from there instead of being orphaned.
  store.linkConversationToTask(convId, {
    id: req.task.id,
    title: req.task.title,
    status: req.task.status,
  });
  // Name it after the TASK rather than leaving it to the auto-title: the task's own title
  // is the best name this conversation can have, it is known before the first token, and
  // it survives a send that fails. (A rename also takes the conversation out of
  // auto-title eligibility, so the model never overwrites it.)
  store.renameConversation(convId, nth > 1 ? `${req.task.title} (${nth})` : req.task.title);

  // Only "Start" needs the skill; "Discuss" is plain prose that works anywhere.
  const pickup = req.mode === "pickup" ? await pickupSupport(repo.path) : null;
  // The name the CLI actually publishes — `pickup` for a project skill,
  // `tosse-workflow:pickup` for the plugin's. NEVER guessed: sending a name this folder
  // does not know reaches the agent as plain text.
  const name = req.pickupName ?? (pickup === "available" ? pickupCommandName(repo.path) : null);
  const text =
    req.mode === "discuss"
      ? discussPrompt(req.task, req.question ?? "")
      : name
        ? pickupCommand(req.task.id, name, req.extra)
        : // No skill (or we could not find out): written instructions work everywhere,
          // whereas an unknown slash command arrives as one cryptic line and moves
          // nothing — the failure would look exactly like success.
          pickupFallbackPrompt(req.task, req.extra);

  try {
    await sendConversationMessage(convId, { text });
  } catch (e) {
    // Same treatment the composer gives a failed send: the error belongs in the thread,
    // not only in the dialog the user is about to close.
    const message = e instanceof Error ? e.message : String(e);
    useConversationStore.getState().addErrorTurn(convId, message);
    throw e;
  }
  return { convId, pickup };
}
