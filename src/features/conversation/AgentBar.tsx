// Discreet, pinned list of the conversation's DETACHED sub-agents (the `Agent` tool
// launched with run_in_background). Deliberately subtle — one slim line per agent,
// echoing the inline sub-agent look — so several running at once never crowd the
// view. A running agent shows the bouncing "thinking" dots (same as the main
// composer's working indicator); a finished one shows a small status dot. Clicking a
// line opens its full transcript in a floating <TranscriptPopover>.
//
// Detached sub-agents are kept OUT of the message thread (the inline card suppresses
// itself for them) and surfaced here instead.

import { useMemo, useState } from "react";
import { useBackgroundAgentIds, useToolResult } from "../../store/conversationStore";
import { useSessionTasks } from "../../store/backgroundTasksStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useStopTask } from "../../ipc/useCommands";
import { fmtDuration, resolveAgentId, shortModel } from "../../agent/subagentMeta";
import { fmtTokens } from "../../store/contextData";
import type { BackgroundTask } from "../../ipc/client";
import { Ico, RunDots } from "../../ui/kit";
import { useIsCodex } from "./ConvMark";
import { TranscriptPopover } from "./TranscriptPopover";

export function AgentBar({ session }: { session: string }) {
  const bgIds = useBackgroundAgentIds(session);
  const tasks = useSessionTasks(session);
  // Phase 4.5 (Bloc C): Codex multi-agent (collab/subAgentActivity) is emitted as `agent`
  // background tasks too — but there is no detached-launch ACK (`bgIds` is Claude-only) and
  // no routed sub-agent thread. So on Codex we list EVERY running sub-agent, and render each
  // display-only (no transcript to drill, no per-agent stop wire).
  const isCodex = useIsCodex(session);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.sessionId ?? null,
  );
  const stopTask = useStopTask(session);
  const [opened, setOpened] = useState<BackgroundTask | null>(null);

  // Only sub-agents still RUNNING in the background — a finished one drops out (its
  // result is already back in the conversation). Resuming one via SendMessage RE-USES its
  // task_id (== its agentId) and keeps the original Agent tool_use_id, so the socle just
  // flips it back to Running (assembler `resume_agent_via_send_message` / the task_progress
  // backstop) and it reappears here on the SAME row.
  const rows = useMemo(() => {
    const ids = new Set(bgIds);
    return Object.values(tasks)
      .filter(
        (t) =>
          t.kind === "agent" &&
          t.status === "running" &&
          // Claude: only DETACHED sub-agents (foreground ones render inline). Codex: every
          // running sub-agent (there is no detached/foreground split, no ACK to key on).
          (isCodex || (t.tool_use_id != null && ids.has(t.tool_use_id))),
      )
      .sort((a, b) => a.task_id.localeCompare(b.task_id));
  }, [bgIds, tasks, isCodex]);

  // The open transcript is held by VALUE (not looked up in `rows`) so it stays open
  // even once the agent finishes and leaves the bar mid-read. Its id appears in the
  // immediate tool_result ack → drillable during the run.
  const openedResult = useToolResult(session, opened?.tool_use_id ?? "");
  const openedAgentId = opened ? resolveAgentId(opened, openedResult?.content) : null;

  if (rows.length === 0 && !opened) return null;

  return (
    <div className="cv-bgagents">
      {rows.map((t) => {
        // No effort here: it is per-agent-definition, not inherited from the parent —
        // see the matching note on the inline sub-agent card. `model` IS per sub-agent
        // (it rides the wire), so it stays.
        const meta = [t.subagent_type, t.model ? shortModel(t.model) : null]
          .filter(Boolean)
          .join(" · ");
        // Defensive / forward-compatible: the wire's usage roll-up (tokens / tool-calls
        // / duration) only arrives on `task_notification` (terminal), and this bar lists
        // RUNNING agents only — so in practice these are empty here today. Rendered
        // conditionally (zero clutter) so they appear automatically IF a future CLI ever
        // reports mid-run usage. Effort (above) is the meaningful live addition.
        const stats = [
          t.tokens != null ? `${fmtTokens(t.tokens)} tk` : null,
          t.tool_uses != null ? `${t.tool_uses} tools` : null,
          t.duration_ms != null ? fmtDuration(t.duration_ms) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        // Codex sub-agent: display-only row (no routed thread → no transcript, no per-agent
        // stop). Claude detached agent: drillable + stoppable, as before.
        if (isCodex) {
          return (
            <div key={t.task_id} className="cv-bashrow">
              <div className="cv-bgagent static">
                <RunDots />
                <span className="cv-bgagent-label">{t.label ?? "Sub-agent"}</span>
                {meta ? <span className="cv-bgagent-meta wf-mono">{meta}</span> : null}
                {stats ? <span className="cv-bgagent-stats wf-mono">{stats}</span> : null}
              </div>
            </div>
          );
        }
        return (
          <div key={t.task_id} className="cv-bashrow">
            <button
              type="button"
              className="cv-bgagent"
              onClick={() => setOpened(t)}
              title="Open sub-agent transcript"
            >
              <RunDots />
              <span className="cv-bgagent-label">{t.label ?? "Sub-agent"}</span>
              {meta ? <span className="cv-bgagent-meta wf-mono">{meta}</span> : null}
              {stats ? <span className="cv-bgagent-stats wf-mono">{stats}</span> : null}
              <Ico name="arrow" className="sm cv-bgagent-go" />
            </button>
            <button
              type="button"
              className="cv-bgstop"
              title="Stop sub-agent"
              aria-label="Stop sub-agent"
              onClick={() => stopTask.mutate(t.task_id)}
            >
              <Ico name="stopc" className="sm" />
            </button>
          </div>
        );
      })}

      <TranscriptPopover
        open={!!opened}
        sessionId={claudeSessionId}
        agentId={openedAgentId}
        liveSession={session}
        toolUseId={opened?.tool_use_id ?? null}
        running={opened?.status === "running"}
        label={opened?.label ?? "Sub-agent"}
        subtitle={
          opened
            ? [opened.subagent_type, opened.model ? shortModel(opened.model) : null]
                .filter(Boolean)
                .join(" · ") || undefined
            : undefined
        }
        onClose={() => setOpened(null)}
      />
    </div>
  );
}
