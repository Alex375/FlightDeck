// What the two buttons actually send.
//
// These prompts are the whole behaviour of "Start" and "Discuss": if "Discuss" stops
// saying "don't start", the button silently becomes the other one. So the wording that
// carries the meaning is asserted, not just the shape.

import { describe, expect, it } from "vitest";
import type { TosseTask, TosseTaskDetail } from "../../ipc/client";
import {
  discussPrompt,
  launchTask,
  pickupCommand,
  pickupCommandName,
  pickupFallbackPrompt,
} from "./taskPrompts";
import { useCommandsStore } from "../../store/commandsStore";

function task(over: Partial<TosseTask> = {}): TosseTask {
  return {
    id: "t-1",
    title: "Fix the login bug",
    status: "À faire",
    priority: "Haute",
    kind: "Bug",
    assignedTo: "Alexandre",
    dueDate: null,
    notes: null,
    subtaskCount: 0,
    subtaskDone: 0,
    ...over,
  };
}

const detail = (over: Partial<TosseTaskDetail> = {}): TosseTaskDetail => ({
  task: task(),
  projectId: "p-1",
  projectName: "Tosse Code",
  context: "Only the panel has this.",
  content: null,
  subtasks: [],
  blockedBy: [],
  blocks: [],
  ...over,
});

describe("pickupCommand", () => {
  // ALWAYS pickup, never `/start`, even where both exist — one gesture, one meaning.
  it("is /pickup with the task id", () => {
    expect(pickupCommand("t-1")).toBe("/pickup t-1");
  });

  // ⚠️ The regression this argument exists for. VERIFIED against the real binary: a
  // PLUGIN-provided skill is published fully qualified (`tosse-workflow:pickup`), and
  // `/pickup` is not a command in that folder at all — it would arrive as plain text and
  // move nothing. So the name always comes from the catalogue, never from a guess.
  it("uses the name the folder publishes, plugin prefix included", () => {
    expect(pickupCommand("t-1", "tosse-workflow:pickup")).toBe("/tosse-workflow:pickup t-1");
  });

  // The Start button's drop-down. The id stays the command's FIRST argument — the skill
  // reads it from there — and the instruction follows, labelled, on its own lines.
  it("carries an extra instruction after the id", () => {
    const text = pickupCommand("t-1", "pickup", "  plan it out first  ");
    expect(text.startsWith("/pickup t-1\n")).toBe(true);
    expect(text).toContain("Also, for this run: plan it out first");
  });

  it("ignores an empty instruction rather than sending a dangling label", () => {
    expect(pickupCommand("t-1", "pickup", "   ")).toBe("/pickup t-1");
    expect(pickupCommand("t-1", "pickup", undefined)).toBe("/pickup t-1");
  });
});

describe("pickupCommandName", () => {
  const seed = (cwd: string, names: string[]) =>
    useCommandsStore.getState().setCommands(
      cwd,
      names.map((name) => ({ name, description: "", argument_hint: "" })),
    );

  it("finds a plugin-qualified skill", () => {
    seed("/tmp/a", ["build-app", "tosse-workflow:pickup", "doctor"]);
    expect(pickupCommandName("/tmp/a")).toBe("tosse-workflow:pickup");
  });

  // A repo that ships its OWN pickup skill means it deliberately: its version wins.
  it("prefers a bare project skill over a plugin's", () => {
    seed("/tmp/b", ["tosse-workflow:pickup", "pickup"]);
    expect(pickupCommandName("/tmp/b")).toBe("pickup");
  });

  it("answers null for a folder with no such skill, and for one never fetched", () => {
    seed("/tmp/c", ["build-app", "doctor"]);
    expect(pickupCommandName("/tmp/c")).toBeNull();
    expect(pickupCommandName("/tmp/never-seen")).toBeNull();
  });

  // A command merely CONTAINING "pickup" is not the skill — `/pickup-order` must not
  // pass for it.
  it("does not match a lookalike command name", () => {
    seed("/tmp/d", ["pickup-order", "plugin:pickupx"]);
    expect(pickupCommandName("/tmp/d")).toBeNull();
  });
});

describe("launchTask", () => {
  it("carries the row's facts, and the panel's long-form fields when it is the same task", () => {
    const built = launchTask(task(), "Tosse Code", detail());
    expect(built.projectName).toBe("Tosse Code");
    expect(built.context).toBe("Only the panel has this.");
  });

  // The panel can be open on ANOTHER task while a row's button is pressed. Pasting that
  // task's description into this one's prompt would brief the agent on the wrong work.
  it("ignores a detail payload belonging to a different task", () => {
    const built = launchTask(task({ id: "t-2" }), "Tosse Code", detail());
    expect(built.context).toBeNull();
    expect(built.blockedBy).toEqual([]);
  });

  it("keeps only the blockers that are still live", () => {
    const built = launchTask(
      task(),
      null,
      detail({
        blockedBy: [
          { id: "b1", title: "Lot 2", status: "Review", resolved: false },
          { id: "b2", title: "Lot 1", status: "Fait", resolved: true },
        ],
      }),
    );
    expect(built.blockedBy).toEqual(["Lot 2"]);
  });
});

describe("discussPrompt", () => {
  const built = () => launchTask(task(), "Tosse Code", detail());

  it("says not to start, and repeats it", () => {
    const text = discussPrompt(built(), "");
    expect(text).toContain("Do not start working on it");
    expect(text.toLowerCase()).toContain("don't start");
  });

  it("pastes the task rather than pointing at an id to fetch", () => {
    const text = discussPrompt(built(), "");
    expect(text).toContain("Fix the login bug");
    expect(text).toContain("Tosse Code");
    expect(text).toContain("Only the panel has this.");
  });

  // The CRM's uuid is machine plumbing: it means nothing to the human reading this
  // conversation, and the task is pasted in full anyway. It belongs to the START path,
  // where it IS the instruction.
  it("carries no CRM id", () => {
    const text = discussPrompt(built(), "");
    expect(text).not.toContain("t-1");
    expect(text).not.toContain("Id:");
  });

  it("carries the user's question, and asks an open one when there is none", () => {
    expect(discussPrompt(built(), "  Should we split it?  ")).toContain(
      "My question: Should we split it?",
    );
    expect(discussPrompt(built(), "   ")).toContain("Where would you start");
  });

  it("never prints an absent field as an empty or null line", () => {
    const bare = launchTask(task({ priority: null, kind: null, assignedTo: null }), null);
    const text = discussPrompt(bare, "");
    expect(text).not.toContain("null");
    expect(text).not.toMatch(/^(Priority|Type|Assigned to|Project):\s*$/m);
  });
});

describe("pickupFallbackPrompt", () => {
  // Sent where `/pickup` would arrive as plain text. It has to carry the same intent —
  // including the status move the skill would have made — or the task silently stays put.
  it("spells out what the skill would have done", () => {
    const text = pickupFallbackPrompt(launchTask(task(), "Tosse Code"));
    expect(text).toContain("t-1");
    expect(text).toContain("Fix the login bug");
    expect(text).toContain("En cours");
    expect(text).toContain("blocks");
  });

  // The same instruction must reach the agent whether or not the folder has the skill —
  // otherwise the drop-down would silently do nothing in half the repositories.
  it("carries the extra instruction too, last", () => {
    const text = pickupFallbackPrompt(launchTask(task(), "Tosse Code"), "plan it out first");
    expect(text.trimEnd().endsWith("Also, for this run: plan it out first")).toBe(true);
    expect(pickupFallbackPrompt(launchTask(task(), "Tosse Code"), "  ")).not.toContain("for this run");
  });
});
