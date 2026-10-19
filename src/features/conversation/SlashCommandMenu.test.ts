import { describe, it, expect } from "vitest";
import {
  commandScope,
  cleanDescription,
  filterSlashCommands,
  isReloadSkillsCommand,
} from "./SlashCommandMenu";
import type { SlashCommand } from "../../ipc/client";

function cmd(name: string, description = "", argument_hint = ""): SlashCommand {
  return { name, description, argument_hint };
}

// Scope is derived purely from the shapes the CLI emits on the wire (verified
// live on 2.1.187): a plugin skill carries a LEADING `(plugin)` hint or a
// `plugin:command` name; a repo-local skill ends with `(project)`; a dynamic
// workflow ends with `(dynamic workflow)`; everything else has no hint.
describe("commandScope", () => {
  it("classifies a `plugin:command` name as that plugin", () => {
    expect(commandScope(cmd("tosse-workflow:pickup", "Start a task"))).toEqual({
      kind: "plugin",
      plugin: "tosse-workflow",
    });
  });

  it("classifies a bare name with a leading `(plugin)` hint as that plugin", () => {
    expect(commandScope(cmd("algorithmic-art", "(example-skills) Creating art"))).toEqual({
      kind: "plugin",
      plugin: "example-skills",
    });
  });

  it("classifies a trailing `(project)` marker as a repo-local skill", () => {
    expect(commandScope(cmd("build-app", "Build the app. (project)"))).toEqual({
      kind: "project",
    });
  });

  it("is case-insensitive on the project marker", () => {
    expect(commandScope(cmd("land", "Land it. (Project)"))).toEqual({ kind: "project" });
  });

  it("treats a `(dynamic workflow)` as a general command, not a plugin", () => {
    expect(commandScope(cmd("deep-research", "Research harness. (dynamic workflow)"))).toEqual({
      kind: "global",
    });
  });

  it("classifies a hint-less command (built-in / global skill) as global", () => {
    expect(commandScope(cmd("compact", "Compact the conversation"))).toEqual({ kind: "global" });
    expect(commandScope(cmd("verify", "Verify a change works"))).toEqual({ kind: "global" });
  });

  it("does NOT mistake a built-in's meaningful trailing parenthetical for a scope marker", () => {
    // e.g. /clear → "Clear the conversation (resumable with /resume)"
    expect(commandScope(cmd("clear", "Clear the conversation (resumable with /resume)"))).toEqual({
      kind: "global",
    });
  });
});

describe("cleanDescription", () => {
  it("strips a leading `(plugin)` hint", () => {
    expect(cleanDescription("(example-skills) Creating art")).toBe("Creating art");
  });

  it("strips a trailing `(project)` marker", () => {
    expect(cleanDescription("Build the app. (project)")).toBe("Build the app.");
  });

  it("strips a trailing `(dynamic workflow)` marker", () => {
    expect(cleanDescription("Research harness. (dynamic workflow)")).toBe("Research harness.");
  });

  it("keeps a meaningful trailing parenthetical", () => {
    // e.g. `/clear` → "Clear the conversation (resumable with /resume)"
    expect(cleanDescription("Clear the conversation (resumable with /resume)")).toBe(
      "Clear the conversation (resumable with /resume)",
    );
  });

  it("leaves a plain description untouched", () => {
    expect(cleanDescription("Compact the conversation")).toBe("Compact the conversation");
  });
});

// A description comes from the `claude` this conversation runs — on a remote conversation, a
// server's: an end-anchored regex over a long inner run of spaces or parentheses tried every
// start position and scanned to the run's end (quadratic), freezing the webview as the user
// typed "/".
describe("description helpers stay linear on hostile input", () => {
  const RUN = 100_000;

  it("cleanDescription", () => {
    const t0 = performance.now();
    const desc = "x" + " ".repeat(RUN) + "y";
    expect(cleanDescription(desc)).toBe(desc);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("the trailing scope hint", () => {
    const t0 = performance.now();
    expect(commandScope(cmd("n", "(".repeat(RUN)))).toEqual({ kind: "global" });
    expect(commandScope(cmd("n", "x" + "(".repeat(RUN) + "a) "))).toEqual({ kind: "global" });
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("still reads a trailing marker after the rewrite", () => {
    expect(commandScope(cmd("n", "Do it. ((project)  "))).toEqual({ kind: "global" });
    expect(commandScope(cmd("n", "Do it. (project)\n"))).toEqual({ kind: "project" });
    expect(cleanDescription("Do it. (PROJECT)  ")).toBe("Do it.");
  });
});

describe("filterSlashCommands", () => {
  const cmds = [
    cmd("compact", "Compact the conversation"),
    cmd("verify", "Verify a change works"),
    cmd("start", "Start a task. (project)"),
    cmd("build-app", "Build the app. (project)"),
    cmd("algorithmic-art", "(example-skills) Creating art"),
    cmd("pickup", "(tosse-workflow) Start a task"),
    cmd("deep-research", "Research harness. (dynamic workflow)"),
  ];

  it("orders sections: project first, then general, then plugins A→Z", () => {
    const names = filterSlashCommands(cmds, "").map((c) => c.name);
    // Projet block (alphabetical within): build-app, start
    expect(names.slice(0, 2)).toEqual(["build-app", "start"]);
    // Then general commands (built-ins + dynamic workflow), alphabetical
    expect(names.slice(2, 5)).toEqual(["compact", "deep-research", "verify"]);
    // Then plugins A→Z: example-skills before tosse-workflow
    expect(names.slice(5)).toEqual(["algorithmic-art", "pickup"]);
  });

  it("keeps each scope contiguous (no interleaving)", () => {
    const scopes = filterSlashCommands(cmds, "").map((c) => {
      const s = commandScope(c);
      return s.kind === "plugin" ? `plugin:${s.plugin}` : s.kind;
    });
    // A contiguous grouping has no scope id reappearing after it changed.
    const seen = new Set<string>();
    let prev = "";
    for (const s of scopes) {
      if (s !== prev) {
        expect(seen.has(s)).toBe(false);
        seen.add(s);
        prev = s;
      }
    }
  });

  it("filters across every section for a query", () => {
    // "task" appears in `start` (project) and `pickup` (plugin) descriptions.
    const names = filterSlashCommands(cmds, "task").map((c) => c.name);
    expect(names).toContain("start");
    expect(names).toContain("pickup");
    expect(names).not.toContain("compact");
  });

  it("ranks an exact name match ahead of a description-only match WITHIN a scope", () => {
    // Both global; "reset" matches by exact name (rank 0), "compact" only via its
    // description (rank 4). A working ranking must put "reset" first — a fixture
    // where only one command matched would pass even with a broken score().
    const both = [cmd("compact", "reset and shrink"), cmd("reset", "Clear the buffer")];
    expect(filterSlashCommands(both, "reset").map((c) => c.name)).toEqual(["reset", "compact"]);
  });

  it("orders plugin sections by PLUGIN name, not by command name", () => {
    // Plugin alpha order (a-plugin < z-plugin) is the REVERSE of the command
    // alpha order (apple < zebra), so a sort that keyed on the command name
    // instead of the plugin would flip these.
    const cross = [cmd("apple", "(z-plugin) x"), cmd("zebra", "(a-plugin) y")];
    expect(filterSlashCommands(cross, "").map((c) => c.name)).toEqual(["zebra", "apple"]);
  });
});

describe("isReloadSkillsCommand", () => {
  it("matches the bare command", () => {
    expect(isReloadSkillsCommand("/reload-skills")).toBe(true);
  });

  it("tolerates surrounding whitespace and trailing args", () => {
    expect(isReloadSkillsCommand("  /reload-skills  ")).toBe(true);
    expect(isReloadSkillsCommand("/reload-skills now")).toBe(true);
  });

  it("rejects other commands and prose that merely mentions it", () => {
    expect(isReloadSkillsCommand("/reload")).toBe(false);
    expect(isReloadSkillsCommand("/reload-skillz")).toBe(false);
    expect(isReloadSkillsCommand("reload-skills")).toBe(false);
    expect(isReloadSkillsCommand("please run /reload-skills")).toBe(false);
  });
});
