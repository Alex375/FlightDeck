import { describe, expect, it } from "vitest";
import {
  CARET_MARK,
  COMPOSER_ACTIONS,
  actionById,
  availability,
  parseConfigArg,
  runComposerAction,
  serializeConfigArg,
  splitCaret,
  type ActionEnv,
} from "./composerActions";
import type { CustomButton } from "./composerLayout";

const btn = (over: Partial<CustomButton> = {}): CustomButton => ({
  id: "b1",
  icon: "spark",
  label: "Button",
  action: "insert-text",
  ...over,
});

const env = (over: Partial<ActionEnv> = {}): ActionEnv => ({
  backend: "claude",
  locked: false,
  live: true,
  commands: ["pickup", "tosse-workflow:done"],
  effortsFor: () => ["low", "medium", "high", "xhigh"],
  currentModel: "opus",
  bypassBlocked: null,
  hostHasPanels: true,
  ...over,
});

describe("caret marker", () => {
  it("splits the template and reports where the caret goes", () => {
    expect(splitCaret(`Refactor ${CARET_MARK} keeping tests`)).toEqual({
      text: "Refactor  keeping tests",
      caret: 9,
    });
  });

  it("reports no caret when the template has no marker", () => {
    expect(splitCaret("plain")).toEqual({ text: "plain", caret: null });
  });

  it("only honours the first marker", () => {
    const { caret } = splitCaret(`a${CARET_MARK}b${CARET_MARK}c`);
    expect(caret).toBe(1);
  });
});

describe("config argument", () => {
  it("round-trips a partial configuration", () => {
    const cfg = { model: "opus", effort: "xhigh" };
    expect(parseConfigArg(serializeConfigArg(cfg))).toEqual(cfg);
  });

  it("degrades to an empty config instead of throwing on junk", () => {
    expect(parseConfigArg("{not json")).toEqual({});
    expect(parseConfigArg(undefined)).toEqual({});
    expect(parseConfigArg('{"model":42}')).toEqual({});
  });
});

describe("availability", () => {
  it("refuses a button whose action was removed from the catalogue", () => {
    const a = availability(btn({ action: "ghost-action" }), env());
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/no longer exists/);
  });

  it("refuses an empty text button", () => {
    expect(availability(btn({ arg: "   " }), env()).ok).toBe(false);
  });

  it("accepts a command the repository offers, with or without the slash", () => {
    expect(availability(btn({ action: "run-command", arg: "pickup" }), env()).ok).toBe(true);
    expect(availability(btn({ action: "run-command", arg: "/pickup" }), env()).ok).toBe(true);
  });

  it("refuses a command absent from a KNOWN catalogue", () => {
    // Sent anyway it would reach the agent as prose: the task never moves and the
    // failure looks like success. This is the whole point of gating on the catalogue.
    const a = availability(btn({ action: "run-command", arg: "land" }), env());
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("/land");
  });

  it("allows a command when the catalogue is not known YET", () => {
    // null = "we haven't looked", not "it isn't there" — refusing here would grey out a
    // good button on every cold start.
    expect(availability(btn({ action: "run-command", arg: "land" }), env({ commands: null })).ok).toBe(true);
  });

  it("refuses an empty configuration", () => {
    const a = availability(btn({ action: "apply-config", arg: "{}" }), env());
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/nothing to apply/);
  });

  it("refuses a cross-backend model once the conversation is locked", () => {
    const a = availability(
      btn({ action: "apply-config", arg: '{"model":"gpt-5.6-sol"}' }),
      env({ locked: true, backend: "claude" }),
    );
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("Claude");
  });

  it("allows a cross-backend model while the conversation is still fresh", () => {
    const a = availability(
      btn({ action: "apply-config", arg: '{"model":"gpt-5.6-sol"}' }),
      env({ locked: false }),
    );
    expect(a.ok).toBe(true);
  });

  it("validates the effort against the model the config SWITCHES to", () => {
    const a = availability(
      btn({ action: "apply-config", arg: '{"model":"haiku","effort":"ultracode"}' }),
      env({ effortsFor: (m) => (m === "haiku" ? [] : ["low", "ultracode"]) }),
    );
    // Haiku advertises no rungs at all → nothing to contradict, so it passes; the guard
    // fires when the target model has a ladder that lacks the requested rung.
    expect(a.ok).toBe(true);
    const b = availability(
      btn({ action: "apply-config", arg: '{"model":"sonnet","effort":"ultracode"}' }),
      env({ effortsFor: () => ["low", "medium", "high"] }),
    );
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/ultracode/);
  });

  it("refuses a permission mode on a Codex conversation", () => {
    const a = availability(
      btn({ action: "apply-config", arg: '{"permission":"plan"}' }),
      env({ backend: "codex" }),
    );
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/Claude setting/);
  });

  it("passes the bypass refusal through verbatim", () => {
    const a = availability(
      btn({ action: "apply-config", arg: '{"permission":"bypassPermissions"}' }),
      env({ bypassBlocked: "Turn it on in Settings → General." }),
    );
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("Turn it on in Settings → General.");
  });

  it("refuses turn actions on a conversation that isn't running", () => {
    expect(availability(btn({ action: "compact" }), env({ live: false })).ok).toBe(false);
    expect(availability(btn({ action: "interrupt" }), env({ live: false })).ok).toBe(false);
    expect(availability(btn({ action: "compact" }), env({ live: true })).ok).toBe(true);
  });

  it("allows the panel actions in a host that has panels", () => {
    for (const id of ["open-editor", "open-terminal", "open-git", "open-extensions", "open-history"]) {
      expect(availability(btn({ action: id }), env({ live: false })).ok, id).toBe(true);
    }
  });

  it("refuses editor/terminal/Git in a host with no side panel", () => {
    // The Flight Deck reply modal mounts a bare pane. Left available, these buttons
    // flipped app-wide persisted layout flags with no visible effect — a dead click.
    for (const id of ["open-editor", "open-terminal", "open-git"]) {
      const a = availability(btn({ action: id }), env({ hostHasPanels: false }));
      expect(a.ok, id).toBe(false);
      expect(a.reason, id).toMatch(/no side panel/);
    }
  });

  it("still allows panel-less actions in such a host", () => {
    // Extensions and History open their own overlay, so they work anywhere.
    for (const id of ["open-extensions", "open-history", "new-conversation"]) {
      expect(availability(btn({ action: id }), env({ hostHasPanels: false })).ok, id).toBe(true);
    }
  });
});

describe("running a button", () => {
  const handlers = () => {
    const calls: string[] = [];
    return {
      calls,
      h: {
        insert: (t: string, c: number | null) => calls.push(`insert:${t}:${c}`),
        send: (t: string) => calls.push(`send:${t}`),
        compact: () => calls.push("compact"),
        interrupt: () => calls.push("interrupt"),
      },
    };
  };

  it("inserts the text and reports where the caret goes", () => {
    const { calls, h } = handlers();
    const ok = runComposerAction(btn({ arg: `a${CARET_MARK}b` }), "conv-1", h, () => {});
    expect(ok).toBe(true);
    expect(calls).toEqual(["insert:ab:1"]);
  });

  it("strips the caret marker from a straight send", () => {
    // The marker means nothing to the agent — shipping a stray "$|" would be noise.
    const { calls, h } = handlers();
    runComposerAction(btn({ action: "send-text", arg: `ship ${CARET_MARK}it` }), "conv-1", h, () => {});
    expect(calls).toEqual(["send:ship it"]);
  });

  it("sends a slash command with exactly one leading slash", () => {
    const { calls, h } = handlers();
    runComposerAction(btn({ action: "run-command", arg: "/done" }), "conv-1", h, () => {});
    expect(calls).toEqual(["send:/done"]);
  });

  it("hands the parsed configuration to applyConfig", () => {
    let applied: unknown = null;
    runComposerAction(
      btn({ action: "apply-config", arg: '{"model":"opus","effort":"xhigh"}' }),
      "conv-1",
      handlers().h,
      (cfg) => (applied = cfg),
    );
    expect(applied).toEqual({ model: "opus", effort: "xhigh" });
  });

  it("returns false — never a silent no-op — when there is nothing to do", () => {
    // The caller surfaces this; a dropped `false` would look exactly like success.
    const { calls, h } = handlers();
    expect(runComposerAction(btn({ action: "ghost" }), "conv-1", h, () => {})).toBe(false);
    expect(runComposerAction(btn({ arg: "" }), "conv-1", h, () => {})).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("dead-click guards", () => {
  it("refuses a template that is only the caret marker", () => {
    // `"$|".trim()` is non-empty, so a naive check passed it — then splitCaret produced
    // an empty string and the click did nothing at all.
    const a = availability(btn({ arg: CARET_MARK }), env());
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/no text/);
  });

  it("still accepts a template that has real text around the marker", () => {
    expect(availability(btn({ arg: `x${CARET_MARK}` }), env()).ok).toBe(true);
  });

  it("allows a permission mode when the same config switches to a Claude model", () => {
    // The config LANDS on Claude, where the mode is valid; judging it against the
    // conversation's current (Codex) backend refused a button that works.
    const a = availability(
      btn({ action: "apply-config", arg: '{"model":"opus","permission":"plan"}' }),
      env({ backend: "codex", locked: false }),
    );
    expect(a.ok).toBe(true);
  });

  it("still refuses it once the conversation is locked to Codex", () => {
    const a = availability(
      btn({ action: "apply-config", arg: '{"model":"opus","permission":"plan"}' }),
      env({ backend: "codex", locked: true }),
    );
    expect(a.ok).toBe(false);
  });
});

describe("catalogue", () => {
  it("keeps ids unique and resolvable", () => {
    expect(new Set(COMPOSER_ACTIONS.map((a) => a.id)).size).toBe(COMPOSER_ACTIONS.length);
    expect(actionById("insert-text")?.arg).toBe("text");
    expect(actionById("nope")).toBeNull();
  });

  it("gives every action a reason to exist in the picker", () => {
    for (const a of COMPOSER_ACTIONS) {
      expect(a.label, a.id).toBeTruthy();
      expect(a.hint, a.id).toBeTruthy();
    }
  });
});
