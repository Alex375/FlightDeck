// What the tasks view actually SENDS when you press "Start" or "Discuss".
//
// The two buttons mean different things and must keep meaning them:
//  - "Start" hands the task to the repo's own `/pickup` skill. ALWAYS `/pickup`, never
//    `/start`, even in a repo that has both — one gesture, one meaning, everywhere. The
//    skill is what moves the task to "En cours" (after reading the contexts and checking
//    the blockers), so the app never writes that status itself and the two can't drift.
//  - "Discuss" opens a conversation that thinks and does NOT begin. The task travels
//    PASTED INTO the prompt rather than as an id to look up: it is useful from the first
//    token, and it works in a repo where the TOSSE MCP connector isn't available.
//
// The prompts are built by pure functions so their wording is testable and lives in one
// place — a prompt assembled inline in a click handler is a prompt nobody ever reviews.

import { prefetchSlashCommands, useCommandsStore } from "../../store/commandsStore";
import type { TosseTask, TosseTaskDetail } from "../../ipc/client";

/** The skill the "Start" button drives. */
const PICKUP = "pickup";

/**
 * Whether this folder's agent understands the pickup skill, and UNDER WHICH NAME.
 *
 * ⚠️ The name is not guessable, and guessing it is how this shipped broken once:
 * VERIFIED against the real binary, a PLUGIN-provided skill is published to the
 * `initialize` catalogue fully qualified — `tosse-workflow:pickup` — while a project
 * skill is bare (`start`, `land`). Matching on `"pickup"` therefore found nothing in the
 * very repo where the plugin was enabled, and `/pickup` alone is not a command there
 * either. So we never invent the name: we send back the one the CLI advertised.
 *
 * ⚠️ And the guard itself is not optional. Where no such skill exists, `/pickup <id>`
 * reaches the agent as plain text: one cryptic line, the task never moves, nothing looks
 * broken. `null` (unknown / absent) makes the caller send written instructions instead —
 * they work everywhere, which is the fail-safe direction.
 */
export type PickupSupport = "available" | "absent" | "unknown";

/**
 * The catalogue name of the pickup skill in `cwd`, or null when there is none.
 *
 * A BARE `pickup` wins over a plugin-qualified one: a repo that ships its own skill means
 * it deliberately, and its version is the one to drive. EXACT cwd only — the store's
 * `lastSeen` fallback answers "what do repos generally have", and this question is about
 * THIS repo.
 */
export function pickupCommandName(cwd: string): string | null {
  const cached = useCommandsStore.getState().byCwd[cwd];
  if (!cached || cached.length === 0) return null;
  const names = cached.map((c) => c.name);
  if (names.includes(PICKUP)) return PICKUP;
  // Any plugin that provides the skill qualifies — the TOSSE one is simply the usual
  // provider, not a hard-coded requirement.
  return names.find((n) => n.endsWith(`:${PICKUP}`)) ?? null;
}

/** Read the cached catalogue for `cwd`. "unknown" = never fetched (so nothing can be
 *  concluded); "absent" = fetched, and it holds no pickup skill. */
export function pickupSupportFromCache(cwd: string): PickupSupport {
  const cached = useCommandsStore.getState().byCwd[cwd];
  if (!cached || cached.length === 0) return "unknown";
  return pickupCommandName(cwd) ? "available" : "absent";
}

/**
 * Whether the pickup skill will be understood in `cwd`, fetching the catalogue once if we
 * have never seen this folder (the same short-lived spawn the `/` menu uses). Falls back
 * to "unknown" when that fetch fails — never blocks the launch on it.
 */
export async function pickupSupport(cwd: string): Promise<PickupSupport> {
  const cached = pickupSupportFromCache(cwd);
  if (cached !== "unknown") return cached;
  await prefetchSlashCommands(cwd);
  return pickupSupportFromCache(cwd);
}

/**
 * The invocation for a task, under the name this folder actually publishes.
 *
 * `extra` is what the user typed in the Start button's drop-down — a nudge for this run
 * ("plan first", "don't touch the CSS"). It rides in the command's own arguments, on its
 * own lines and clearly labelled, so the skill still reads the id it expects and the agent
 * still reads the instruction.
 */
export function pickupCommand(
  taskId: string,
  commandName: string = PICKUP,
  extra?: string,
): string {
  const note = extra?.trim();
  return note ? `/${commandName} ${taskId}\n\nAlso, for this run: ${note}` : `/${commandName} ${taskId}`;
}

/**
 * What to send instead when the folder has no `/pickup` skill — the same intent, spelled
 * out. It names the task AND its id, so an agent with the TOSSE MCP can still fetch the
 * rest, and one without it still knows what it was asked to do.
 */
export function pickupFallbackPrompt(task: LaunchTask, extra?: string): string {
  const note = extra?.trim();
  return [
    `Start working on this TOSSE task.`,
    ``,
    taskFacts(task, true),
    ``,
    `This repository has no /pickup skill, so do it by hand: read the task's context,`,
    `check that nothing blocks it, move it to « En cours » in TOSSE (via the TOSSE MCP if`,
    `you have it — otherwise say so rather than assuming it moved), then start the work.`,
    // The user's own instruction goes LAST, where it reads as the final word on how this
    // particular run should go.
    ...(note ? [``, `Also, for this run: ${note}`] : []),
  ].join("\n");
}

/** The subset of a task the prompts need. Built from the briefing row, enriched with
 *  the detail panel's own fields when it has been opened (they are already on screen —
 *  pasting them costs nothing and saves a round-trip the agent would otherwise make). */
export interface LaunchTask {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  kind: string | null;
  assignedTo: string | null;
  dueDate: string | null;
  projectName: string | null;
  /** Long-form fields, when the detail panel has them. */
  notes: string | null;
  context: string | null;
  content: string | null;
  /** Titles of the tasks blocking this one, unresolved ones only. */
  blockedBy: string[];
}

/** Build a {@link LaunchTask} from what the view has: always the row, plus the detail
 *  when that task's panel is open. */
export function launchTask(
  task: TosseTask,
  projectName: string | null,
  detail?: TosseTaskDetail | null,
): LaunchTask {
  const isSame = detail?.task.id === task.id;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    kind: task.kind,
    assignedTo: task.assignedTo,
    dueDate: task.dueDate,
    projectName: (isSame ? detail?.projectName : null) ?? projectName,
    notes: task.notes,
    context: isSame ? (detail?.context ?? null) : null,
    content: isSame ? (detail?.content ?? null) : null,
    blockedBy: isSame ? (detail?.blockedBy ?? []).filter((b) => !b.resolved).map((b) => b.title) : [],
  };
}

/**
 * The task's identity as a short block of facts — shared by both prompts so they describe
 * a task the same way. Absent fields are omitted, never printed as "null".
 *
 * `withId` carries the CRM's uuid, and only the START path asks for it: there the id IS
 * the instruction (it is what `/pickup` would have received, and what the agent must move
 * to « En cours »). A discussion has no use for it — it is noise in a conversation a human
 * reads, and the task is already fully pasted below.
 */
function taskFacts(task: LaunchTask, withId: boolean): string {
  const lines = [`Task: ${task.title}`];
  if (withId) lines.push(`Id: ${task.id}`);
  if (task.projectName) lines.push(`Project: ${task.projectName}`);
  lines.push(`Status: ${task.status}`);
  if (task.priority) lines.push(`Priority: ${task.priority}`);
  if (task.kind) lines.push(`Type: ${task.kind}`);
  if (task.assignedTo) lines.push(`Assigned to: ${task.assignedTo}`);
  if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.join(", ")}`);
  return lines.join("\n");
}

/**
 * The "Discuss" prompt: think about this task, do not start it.
 *
 * The instruction not to begin comes FIRST and is repeated at the end, because it is the
 * whole difference between this button and the other one — an agent that starts editing
 * files here has done the one thing the user did not ask for.
 */
export function discussPrompt(task: LaunchTask, question: string): string {
  const parts = [
    `Let's think about this TOSSE task together. **Do not start working on it** — no code,`,
    `no file changes, no status change in TOSSE. I want to think it through first.`,
    ``,
    taskFacts(task, false),
  ];
  const longForm = [
    task.notes ? `Notes:\n${task.notes}` : null,
    task.content ? `Description:\n${task.content}` : null,
    task.context ? `Context:\n${task.context}` : null,
  ].filter((s): s is string => s != null);
  if (longForm.length > 0) parts.push(``, longForm.join("\n\n"));
  const asked = question.trim();
  parts.push(``, asked ? `My question: ${asked}` : `Where would you start, and what worries you?`);
  parts.push(
    ``,
    `If you need more than what is above, the TOSSE MCP can look this task up by its`,
    `title and read its contexts — but answer with what you have rather than stalling if`,
    `it is not available.`,
    `Again: think and answer, don't start.`,
  );
  return parts.join("\n");
}
