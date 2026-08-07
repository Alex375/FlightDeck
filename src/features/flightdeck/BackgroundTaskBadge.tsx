// Compact background-tasks indicator for a FlightDeck card. ONE chip "⚙︎ N" (N =
// running background tasks of ANY kind: sub-agents, Monitor, background Bash,
// workflows) so several parallel tasks never flood the card; the detail (grouped by
// kind) is a click-away popover.
//
// The popover is rendered in a PORTAL (fixed-positioned under the chip), NOT as an
// absolute child: a card lives inside the swimlane's `overflow:auto`, which would
// clip/hide an in-flow popover. A sub-agent row drills into its transcript via the
// shared <TranscriptPopover>; other kinds are display-only here.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dot, Ico } from "../../ui/kit";
import { useSessionTasks } from "../../store/backgroundTasksStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useWorkflowLive } from "../../store/workflowLive";
import { useWorkflowJournal } from "../../store/workflowJournal";
import { useToolResult } from "../../store/conversationStore";
import type { BackgroundTask, BackgroundTaskKind } from "../../ipc/client";
import { resolveAgentId, runIdFromResult, shortModel, taskStatusDot } from "../../agent/subagentMeta";
import { TranscriptPopover } from "../conversation/TranscriptPopover";
import { useIsCodex } from "../conversation/ConvMark";
import { WorkflowDetail } from "../conversation/WorkflowDetail";

const KIND_ICON: Record<BackgroundTaskKind, string> = {
  agent: "spark",
  workflow: "layers",
  bash: "term",
  monitor: "gauge",
  other: "cog",
};

const KIND_LABEL: Record<BackgroundTaskKind, string> = {
  agent: "Sub-agents",
  workflow: "Workflows",
  bash: "Bash (background)",
  monitor: "Monitors",
  other: "Tasks",
};

const ORDER: BackgroundTaskKind[] = ["agent", "workflow", "monitor", "bash", "other"];

export function BackgroundTaskBadge({ convId }: { convId: string }) {
  const tasks = useSessionTasks(convId);
  // Phase 4.5 (Bloc C): Codex sub-agents show here too (kind `agent`), but their threads
  // aren't routed to us — no transcript to drill into. Gate drill OFF on Codex so a row is
  // display-only (status + name), never a click into an empty transcript.
  const isCodex = useIsCodex(convId);
  const claudeSessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.sessionId ?? null,
  );
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const [openTask, setOpenTask] = useState<BackgroundTask | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const all = useMemo(() => Object.values(tasks), [tasks]);
  const running = all.filter((t) => t.status === "running").length;

  const openedResult = useToolResult(convId, openTask?.tool_use_id ?? "");
  const openedAgentId = openTask ? resolveAgentId(openTask, openedResult?.content) : null;
  // A workflow drills into the 3-panel detail (not a transcript); its run id lives in the
  // Workflow tool_result ack.
  const openedRunId =
    openTask?.kind === "workflow" ? runIdFromResult(openedResult?.content) : null;
  // Per-phase live activity for the opened workflow (else the detail's live overview shows
  // every phase as "upcoming"). The hook is unconditional, so an empty task_id is safe.
  const openedLiveActivity = useWorkflowLive(convId, openTask?.task_id ?? "");
  // Live per-agent progress of the opened run, pushed from its journal (unconditional hook —
  // a null run id resolves to the shared empty view).
  const openedJournal = useWorkflowJournal(convId, openedRunId);

  // Close the popover on Escape while it's open. This popover owns Escape while open, so
  // stopPropagation keeps an outer window-level modal (the Flight Deck reply modal) from
  // also closing on the same keypress. Fullscreen is protected by App.tsx's capture-phase
  // guard, which preventDefaults Escape globally.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Keep the card clean: the chip shows only while something is actually running. (We
  // still render when a transcript popover is open, so it survives the task finishing
  // mid-read.)
  if (running === 0 && !openTask) return null;

  // The popover lists ONLY running tasks — a finished one drops out (its result is
  // back in the conversation); reactivating spawns a new task that reappears.
  const groups = ORDER.map((kind) => ({
    kind,
    items: all.filter((t) => t.kind === kind && t.status === "running"),
  })).filter((g) => g.items.length > 0);

  function toggle() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const POP_W = 320;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Anchor the LEFT edge to the chip and open RIGHTWARD, clamped on-screen — the
      // chip sits near the window's left edge, so a right-anchored popover would spill
      // off the left side (where there's nothing). Open upward when there's no room below.
      const left = Math.min(Math.max(8, r.left), vw - POP_W - 8);
      const belowSpace = vh - r.bottom - 12;
      const aboveSpace = r.top - 12;
      if (belowSpace >= 220 || belowSpace >= aboveSpace) {
        setPos({ left, top: r.bottom + 6, maxHeight: belowSpace });
      } else {
        setPos({ left, bottom: vh - r.top + 6, maxHeight: aboveSpace });
      }
    }
    setOpen((o) => !o);
  }

  return (
    <>
      {running > 0 ? (
        <button
          ref={btnRef}
          className="ag-bgbadge"
          onClick={toggle}
          title={`${running} background task(s) running`}
        >
          <Ico name="cog" className="sm" />
          <span className="wf-mono">{running}</span>
        </button>
      ) : null}

      {running > 0 && open && pos
        ? createPortal(
            <div className="ag-bgpop-backdrop" onClick={() => setOpen(false)}>
              <div
                className="ag-bgpop"
                style={{
                  position: "fixed",
                  left: pos.left,
                  top: pos.top,
                  bottom: pos.bottom,
                  maxHeight: pos.maxHeight,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {groups.map((g) => (
                  <div key={g.kind} className="ag-bgpop-grp">
                    <div className="ag-bgpop-h">
                      <Ico name={KIND_ICON[g.kind]} className="sm" />
                      {KIND_LABEL[g.kind]}
                      <span className="wf-mono ag-bgpop-n">{g.items.length}</span>
                    </div>
                    {g.items.map((t) => {
                      const drill = !isCodex && (t.kind === "agent" || t.kind === "workflow");
                      const meta = [t.subagent_type, t.model ? shortModel(t.model) : null]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <button
                          key={t.task_id}
                          type="button"
                          className={"ag-bgpop-row" + (drill ? "" : " static")}
                          disabled={!drill}
                          onClick={() => {
                            setOpenTask(t);
                            setOpen(false);
                          }}
                          title={drill ? "Open transcript" : undefined}
                        >
                          <Dot s={taskStatusDot(t.status)} pulse={t.status === "running"} />
                          <span className="ag-bgpop-label">
                            {t.label ?? t.progress ?? KIND_LABEL[t.kind]}
                          </span>
                          {meta ? <span className="ag-bgpop-meta wf-mono">{meta}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}

      <TranscriptPopover
        open={!!openTask && openTask.kind !== "workflow"}
        sessionId={claudeSessionId}
        agentId={openedAgentId}
        liveSession={convId}
        toolUseId={openTask?.tool_use_id ?? null}
        running={openTask?.status === "running"}
        label={openTask?.label ?? "Sub-agent"}
        subtitle={
          openTask
            ? [openTask.subagent_type, openTask.model ? shortModel(openTask.model) : null]
                .filter(Boolean)
                .join(" · ") || undefined
            : undefined
        }
        onClose={() => setOpenTask(null)}
      />

      <WorkflowDetail
        open={!!openTask && openTask.kind === "workflow"}
        sessionId={claudeSessionId}
        runId={openedRunId}
        running={openTask?.status === "running"}
        workflowName={openTask?.label ?? null}
        currentProgress={openTask?.progress ?? null}
        liveActivity={openedLiveActivity}
        journal={openedJournal}
        onClose={() => setOpenTask(null)}
      />
    </>
  );
}
