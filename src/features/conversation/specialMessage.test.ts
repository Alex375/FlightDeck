import { describe, it, expect } from "vitest";
import {
  parseSpecialMessage as parseAny,
  taskNotificationStyle,
  type TaskNotification,
} from "./specialMessage";

/** These cases only ever feed task notifications — narrow the union so their fields read. */
const parseTask = (text: string) => parseAny(text) as TaskNotification | null;

describe("parseSpecialMessage", () => {
  it("parses a background-command notification (summary only, no body)", () => {
    const text = `<task-notification>
<task-id>b9bv954mn</task-id>
<tool-use-id>toolu_01JvXJnRAY1zhBnCZeLsvbqc</tool-use-id>
<output-file>/private/tmp/claude-501/proj/tasks/b9bv954mn.output</output-file>
<status>completed</status>
<summary>Background command "Rebuild dev build via overlay config" completed (exit code 0)</summary>
</task-notification>`;
    expect(parseTask(text)).toEqual({
      type: "task-notification",
      taskId: "b9bv954mn",
      toolUseId: "toolu_01JvXJnRAY1zhBnCZeLsvbqc",
      outputFile: "/private/tmp/claude-501/proj/tasks/b9bv954mn.output",
      status: "completed",
      summary: 'Background command "Rebuild dev build via overlay config" completed (exit code 0)',
      note: null,
      result: null,
      usage: null,
    });
  });

  it("parses a sub-agent notification with note, result and usage", () => {
    const text = `<task-notification>
<task-id>abb2d4fb32dcba467</task-id>
<tool-use-id>toolu_012fofkZ36cxYbMiAc2Pzb29</tool-use-id>
<output-file>/private/tmp/claude-501/proj/tasks/abb2d4fb32dcba467.output</output-file>
<status>completed</status>
<summary>Agent "Explore backend routes structure" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own.</note>
<result>## Report

The routes are **multi-user** (devis, qonto) with a \`currentUserId\` check.</result>
<usage><subagent_tokens>85450</subagent_tokens><tool_uses>20</tool_uses><duration_ms>41525</duration_ms></usage>
</task-notification>`;
    const parsed = parseTask(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("task-notification");
    expect(parsed?.status).toBe("completed");
    expect(parsed?.summary).toBe('Agent "Explore backend routes structure" finished');
    expect(parsed?.note).toContain("fires each time this agent stops");
    expect(parsed?.result).toBe(
      "## Report\n\nThe routes are **multi-user** (devis, qonto) with a `currentUserId` check.",
    );
    expect(parsed?.usage).toEqual({ tokens: 85450, toolUses: 20, durationMs: 41525 });
  });

  it("keeps a result that itself contains angle brackets and a stray </result>", () => {
    const text = `<task-notification>
<task-id>x1</task-id>
<status>completed</status>
<result>Here is code: <div class="a">1 &lt; 2</div> and a stray </result> mid-report.</result>
</task-notification>`;
    // First `<result>` → LAST `</result>`, so the inner stray tag stays in the body.
    expect(parseTask(text)?.result).toBe(
      'Here is code: <div class="a">1 &lt; 2</div> and a stray </result> mid-report.',
    );
  });

  it("maps the failed / killed / stopped statuses", () => {
    for (const status of ["failed", "killed", "stopped"] as const) {
      const parsed = parseTask(
        `<task-notification>\n<task-id>t</task-id>\n<status>${status}</status>\n<summary>s</summary>\n</task-notification>`,
      );
      expect(parsed?.status).toBe(status);
    }
  });

  it("tolerates leading whitespace before the opening tag", () => {
    const text = "\n  <task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n</task-notification>";
    expect(parseTask(text)?.taskId).toBe("t");
  });

  it("returns null for prose that merely MENTIONS the tag (no false positive)", () => {
    // The exact shape of a real prompt that discusses the feature — must NOT parse.
    expect(
      parseTask(
        "Explain how to cleanly render the <task-notification> blocks injected into the thread.",
      ),
    ).toBeNull();
    expect(
      parseTask(
        "See the example below:\n<task-notification>\n<task-id>t</task-id>\n</task-notification>",
      ),
    ).toBeNull(); // opens with prose, not the tag
  });

  it("returns null for a normal prompt, a slash command and empty text", () => {
    expect(parseTask("just fix the login bug please")).toBeNull();
    expect(parseTask("<command-name>/clear</command-name>")).toBeNull();
    expect(parseTask("")).toBeNull();
  });

  it("still parses a truncated block whose closing tag is missing (opens on the tag)", () => {
    // Having opened strictly on the tag, it IS an injection — parse to the end rather
    // than dumping raw XML into a user bubble. (Prose can't reach here: it never opens
    // on the tag, so the anti-false-positive gate is untouched.)
    const parsed = parseTask(
      "<task-notification>\n<task-id>t</task-id>\n<status>completed</status>",
    );
    expect(parsed?.taskId).toBe("t");
    expect(parsed?.status).toBe("completed");
  });

  it("scans header fields and <usage> OUTSIDE the result body (no contamination)", () => {
    // A sub-agent report that literally discusses this very format must NOT leak into the
    // parsed fields: the real <usage> sits AFTER </result>, and there is no top-level
    // <note>, so the <note>/<usage> INSIDE the report must be ignored.
    const text = `<task-notification>
<task-id>t</task-id>
<status>completed</status>
<summary>real summary</summary>
<result>Example body discussing the format:
<note>fake note living inside the report</note>
<usage><subagent_tokens>999</subagent_tokens><tool_uses>1</tool_uses></usage></result>
<usage><subagent_tokens>500</subagent_tokens><tool_uses>7</tool_uses><duration_ms>1234</duration_ms></usage>
</task-notification>`;
    const parsed = parseTask(text);
    expect(parsed?.summary).toBe("real summary");
    expect(parsed?.note).toBeNull(); // the <note> inside the report must not count
    expect(parsed?.usage).toEqual({ tokens: 500, toolUses: 7, durationMs: 1234 });
  });
});

describe("taskNotificationStyle", () => {
  it("maps known statuses to tone / icon / label", () => {
    expect(taskNotificationStyle("completed")).toEqual({ icon: "check", tone: "ok", label: "Completed" });
    expect(taskNotificationStyle("failed")).toEqual({ icon: "alert", tone: "err", label: "Failed" });
    expect(taskNotificationStyle("killed")).toEqual({ icon: "x", tone: "err", label: "Killed" });
    expect(taskNotificationStyle("stopped")).toEqual({ icon: "stopc", tone: "warn", label: "Stopped" });
  });

  it("is case-insensitive and falls back to the raw status for unknown values", () => {
    expect(taskNotificationStyle("COMPLETED").tone).toBe("ok");
    expect(taskNotificationStyle("running")).toEqual({ icon: "bolt", tone: "muted", label: "running" });
    expect(taskNotificationStyle(null)).toEqual({ icon: "bolt", tone: "muted", label: "Notification" });
  });
});
