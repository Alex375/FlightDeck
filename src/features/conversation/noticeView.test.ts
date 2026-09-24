import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BackgroundTask } from "../../ipc/client";
import { NOTICE_ERROR_HEADINGS, NoticeBlock, taskFailedDetail } from "./noticeView";

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
