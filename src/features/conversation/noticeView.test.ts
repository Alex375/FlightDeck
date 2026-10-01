import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BackgroundTask } from "../../ipc/client";
import { NOTICE_ERROR_HEADINGS, NoticeBlock, compactSummary, taskFailedDetail } from "./noticeView";

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  task_id: "t1",
  kind: "agent",
  tool_use_id: null,
  label: "Explore the repo",
  command: null,
  subagent_type: null,
  model: null,
  agent_id: null,
  status: "failed",
  progress: null,
  tokens: null,
  tool_uses: null,
  duration_ms: null,
  summary: null,
  output_file: null,
  ...over,
});

describe("taskFailedDetail", () => {
  it("names the task and folds summary + output file into the technical detail", () => {
    expect(
      taskFailedDetail(task({ summary: "exit code 1", output_file: "/tmp/claude/tasks/t1.output" })),
    ).toEqual({
      message: "Background task failed: Explore the repo",
      label: "Explore the repo",
      detail: "exit code 1\noutput: /tmp/claude/tasks/t1.output",
    });
  });

  it("degrades to a generic line without a label or detail", () => {
    expect(taskFailedDetail(task({ label: "  " }))).toEqual({
      message: "Background task failed",
      label: null,
      detail: null,
    });
  });
});

// A failed background task is common and benign (Claude handles it via its
// <task-notification>): it must read like a failed tool step, never like the conversation
// itself failing.
describe("NoticeBlock task_failed", () => {
  it("renders a discreet inline line, not an alert bubble", () => {
    const html = renderToStaticMarkup(
      createElement(NoticeBlock, { subtype: "task_failed", detail: taskFailedDetail(task({ summary: "boom" })) }),
    );
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Background task failed");
    expect(html).toContain("<b>Explore the repo</b>");
    // Detail stays one click away (collapsed by default).
    expect(html).toContain("Details");
    expect(html).not.toContain("boom");
  });

  it("offers no detail toggle when there is nothing to show", () => {
    const html = renderToStaticMarkup(
      createElement(NoticeBlock, { subtype: "task_failed", detail: taskFailedDetail(task()) }),
    );
    expect(html).not.toContain("<button");
  });

  it("is no longer an error-bubble subtype", () => {
    expect(NOTICE_ERROR_HEADINGS.task_failed).toBeUndefined();
  });
});

// CRM `c9bf1482`: a terminal ssh-level failure (key refused / host identity changed)
// falls through the generic heading-lookup path, same as `process_exited`/`send_failed`.
describe("NoticeBlock remote_link_blocked", () => {
  it("renders via ErrorBlock with the 'Can't reach this server' heading", () => {
    expect(NOTICE_ERROR_HEADINGS.remote_link_blocked).toBe("Can't reach this server");
    const html = renderToStaticMarkup(
      createElement(NoticeBlock, {
        subtype: "remote_link_blocked",
        detail: {
          message:
            "This Mac's saved key was refused by this server. Reconnect this Mac in Settings → Control → Remote, then reopen this conversation.",
          reason: "ssh_key_refused",
        },
      }),
    );
    expect(html).toContain('role="alert"');
    // React escapes the apostrophe as an HTML entity in the raw markup — match
    // around it rather than the literal `'`.
    expect(html).toContain("Can");
    expect(html).toContain("reach this server");
    expect(html).toContain("This Mac");
    expect(html).toContain("saved key was refused");
  });
});

describe("compactSummary", () => {
  it("states the trigger, the tokens before → after and the duration (whole seconds)", () => {
    expect(
      compactSummary({ trigger: "auto", pre_tokens: 970407, post_tokens: 24986, duration_ms: 108596 }),
    ).toBe("auto · 970.4k → 25.0k tokens · 1m 49s");
    expect(compactSummary({ trigger: "manual", pre_tokens: 36488, post_tokens: 5964, duration_ms: 13250 })).toBe(
      "manual · 36.5k → 6.0k tokens · 13s",
    );
  });

  it("shows only what the backend reported", () => {
    // An older CLI: trigger + pre_tokens only.
    expect(compactSummary({ trigger: "auto", pre_tokens: 180000 })).toBe("auto · 180k tokens summarized");
    // Codex: nothing at all.
    expect(compactSummary({ message: "Conversation compacted", trigger: null, pre_tokens: null })).toBeNull();
    expect(compactSummary(null)).toBeNull();
  });
});

describe("NoticeBlock compact_boundary", () => {
  it("renders a separator with its facts line, never an alert", () => {
    const html = renderToStaticMarkup(
      createElement(NoticeBlock, {
        subtype: "compact_boundary",
        detail: { message: "Conversation compacted", trigger: "auto", pre_tokens: 970407, post_tokens: 24986, duration_ms: 108596 },
      }),
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain("Conversation compacted");
    expect(html).toContain("auto · 970.4k → 25.0k tokens · 1m 49s");
    expect(html).not.toContain('role="alert"');
  });

  it("renders bare when nothing is known beyond the fact (Codex)", () => {
    const html = renderToStaticMarkup(
      createElement(NoticeBlock, { subtype: "compact_boundary", detail: { message: "Conversation compacted" } }),
    );
    expect(html).toContain("Conversation compacted");
    expect(html).not.toContain("tokens");
  });

  it("a failed compaction is a visible error", () => {
    expect(NOTICE_ERROR_HEADINGS.compact_failed).toBe("Compaction failed");
    const html = renderToStaticMarkup(
      createElement(NoticeBlock, { subtype: "compact_failed", detail: { message: "Not enough messages to compact." } }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Compaction failed");
    expect(html).toContain("Not enough messages to compact.");
  });
});
