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
import { isRemotePlace, repoPlace } from "../../store/commandsPlace";
import { ASSUMED_PICKUP, missingPickupMessage, watchSentPickup } from "./remotePickup";
import { ensurePickupPlugin, type PickupPlugin, type PluginActivation } from "./pickupPlugin";
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

/**
 * Whether a successful launch should hand the WINDOW over to the new conversation.
 *
 * The two buttons are not the same gesture, so one preference cannot govern both:
 *   - "Discuss" ALWAYS hands over — it exists to ask something, and the answer is the
 *     point of pressing it. `startStaysOnTasks` deliberately has no say here.
 *   - "Start" hands the task to the pickup skill and has nothing to show yet, so it
 *     follows the preference (which defaults to staying, see `tosseStartStaysOnTasks`).
 *
 * Pure, because it is the whole product decision: the launch itself is identical either
 * way (the conversation is created, linked and sent to regardless), and only this answers
 * "does the window move".
 */
export function launchFocusesConversation(mode: LaunchMode, startStaysOnTasks: boolean): boolean {
  return mode !== "pickup" || !startStaysOnTasks;
}

export interface LaunchRequest {
  task: LaunchTask;
  /** The registered folder to open the conversation in (on this Mac or on a paired
   *  server) — already resolved (or picked) by the caller, see `taskFolder`. */
  repoId: string;
  mode: LaunchMode;
  /** "Discuss" only: what the user typed before opening. Empty is allowed — the prompt
   *  then asks the open question. */
  question?: string;
  /** "Start" only: an extra instruction for THIS run, typed in the button's drop-down. */
  extra?: string;
  /** The provider plugin the caller ALREADY scanned for this folder (`null` = it looked
   *  and found none). Omit when the caller has not looked, and the launch scans itself.
   *  The dialog scans before the button is pressed, so passing its answer here is what
   *  keeps one launch from reading the same config files twice. */
  plugin?: PickupPlugin | null;
}

export interface LaunchOutcome {
  convId: string;
  /** How `/pickup` was resolved for this folder — "absent"/"unknown" means written
   *  instructions were sent instead, which the caller SAYS out loud. */
  pickup: PickupSupport | null;
  /** What equipping the folder with the TOSSE plugin did. The caller passes it to
   *  `activationProblem` and says whatever comes back. */
  plugin: PluginActivation;
}

/**
 * Open (or reopen) the conversation for a task and send its first message.
 *
 * Throws if the send fails — after having put the failure in the conversation's own
 * thread, so it is visible whether or not the caller navigates there.
 */
export async function launchTaskConversation(req: LaunchRequest): Promise<LaunchOutcome> {
  const repo = useConversationsStore.getState().repos.find((r) => r.id === req.repoId);
  if (!repo) {
    // The folder disappeared between resolving it and clicking. Refusing loudly beats
    // opening a conversation in some other folder.
    throw new Error("This project's folder is no longer registered in Flight Deck.");
  }
  // The folder WITH its machine — every catalogue read and the plugin step below need it: a
  // server's clone at the same path as a Mac clone has the server's skills, not the Mac's.
  const place = repoPlace(repo);

  // Equip the folder FIRST — before the conversation exists, and well before the send that
  // spawns `claude`. BOTH buttons need this, not just "Start": the skill only matters to
  // the first message, but the conversation that opens lives on, and a "Discuss" that turns
  // into work has to have `/pickup`, `/done`… available. It is also the last moment where
  // enabling is enough on its own — `set_plugin_enabled` writes `settings.json`, which is
  // read at startup, so a session already spawned would need `reload_plugins` too.
  // (A folder on a server is left alone: that config is the server's, see `pickupPlugin`.)
  const plugin = await ensurePickupPlugin(place, req.plugin);

  // ⚠️ Read the store AFTER the await, never before it. Equipping the folder can take
  // seconds (a config scan, and on the dormant path a short-lived `claude`), and a snapshot
  // taken on the near side would have two launches fired inside that window both count the
  // conversations as they were — so both would number themselves "the first", losing the
  // very distinction the count exists to draw.
  const store = useConversationsStore.getState();
  // How many this task already carries — the next one is numbered, so a second pass is
  // told apart from the first in the sidebar and in the task's own "Open" menu.
  const nth = conversationsForTask(store.conversations, req.task.id).length + 1;
  // By id: resolving back from the folder's path could land on another folder sharing it.
  // Throws if the folder was removed during the await above — the same refusal as on entry.
  const convId = createConversationInRepo(req.repoId);
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

  // Only "Start" SENDS the skill; "Discuss" is plain prose that works anywhere (it still
  // needed the plugin above — being equipped and invoking a command are two things).
  // Asked after the plugin work, so an activation that just refreshed the catalogue is
  // reflected here instead of a stale "absent".
  const pickup = req.mode === "pickup" ? await pickupSupport(place) : null;
  // The name the CLI actually publishes — `pickup` for a project skill,
  // `tosse-workflow:pickup` for the plugin's. NEVER guessed on this Mac: sending a name
  // this folder does not know reaches the agent as plain text.
  //
  // On a server, "unknown" (no session has run there yet) is the one exception: the TOSSE
  // plugin is ASSUMED on — a product decision — and checked once the session starts, below.
  const remote = isRemotePlace(place);
  const name =
    pickup === "available"
      ? pickupCommandName(place)
      : remote && pickup === "unknown"
        ? ASSUMED_PICKUP
        : null;
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
  // A slash command sent to a server is checked against what the session there actually
  // loaded: an assumed name, or one read from a catalogue that may predate a plugin change —
  // nothing on this Mac vouches for the server's config as it is now. A miss is said in the
  // thread, where the line that reached the agent as plain text sits.
  if (remote && name && req.mode === "pickup") {
    const sent = name;
    watchSentPickup(convId, sent, () => {
      const server =
        useConversationsStore.getState().machines.find((m) => m.id === repo.machineId)?.label ??
        "this server";
      useConversationStore.getState().addErrorTurn(convId, missingPickupMessage(sent, server));
    });
  }
  return { convId, pickup, plugin };
}
