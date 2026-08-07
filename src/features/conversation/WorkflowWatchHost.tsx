// Mounts one live journal watch per RUNNING workflow, for the whole app (render-null).
//
// A workflow's inner agents exist only on disk while it runs (see `store/workflowJournal`).
// The watch has to be owned somewhere that is ALWAYS mounted, not by a display component:
// the readout must keep advancing while the detail modal is closed, while the Flight Deck
// shows another repo, and while the conversation isn't the active one. So this host — mounted
// once in <App>, beside <CaffeinateHost> — subscribes on behalf of every surface, and the
// Rust side ref-counts so several surfaces watching the same run share one watch.
//
// Ownership is the RUNNING task: a watch starts when a workflow task appears and stops when
// it settles. The store keeps that run's last snapshot afterwards, so a modal opened on a
// just-finished run still shows its final counts while the manifest lands.

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { commands } from "../../ipc/client";
import { runIdFromResult } from "../../agent/subagentMeta";
import { useAppErrors } from "../../store/appErrors";
import { useBackgroundTasksStore } from "../../store/backgroundTasksStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { useToolResult } from "../../store/conversationStore";
import { useWorkflowJournalStore } from "../../store/workflowJournal";

/** `convId|toolUseId` for every running workflow, flat. Encoded as STRINGS on purpose: the
 *  selector re-runs on every background-task tick (progress, tokens), and a fresh array of
 *  objects would fail `useShallow` every time and re-render the host for nothing. */
export function runningWorkflowKeys(
  sessions: Record<string, Record<string, { kind: string; status: string; tool_use_id: string | null }>>,
): string[] {
  const out: string[] = [];
  for (const [convId, tasks] of Object.entries(sessions)) {
    for (const t of Object.values(tasks)) {
      // No `tool_use_id` → no way to reach the tool_result that carries the run id, so there
      // is nothing to watch (rather than watching the wrong run).
      if (t.kind === "workflow" && t.status === "running" && t.tool_use_id) {
        out.push(`${convId}|${t.tool_use_id}`);
      }
    }
  }
  return out.sort();
}

export function WorkflowWatchHost() {
  const keys = useBackgroundTasksStore(useShallow((s) => runningWorkflowKeys(s.sessions)));
  return (
    <>
      {keys.map((k) => {
        const sep = k.indexOf("|");
        return <WorkflowWatch key={k} convId={k.slice(0, sep)} toolUseId={k.slice(sep + 1)} />;
      })}
    </>
  );
}

function WorkflowWatch({ convId, toolUseId }: { convId: string; toolUseId: string }) {
  // Claude's DURABLE session id keys the on-disk artifacts (the live handle does not).
  const sessionId = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === convId)?.sessionId ?? null,
  );
  // The run id lives in the Workflow tool_result ack — the same source every workflow surface
  // uses, so the watch and the views can never disagree about which run is which.
  const result = useToolResult(convId, toolUseId);
  const runId = runIdFromResult(result?.content);

  useEffect(() => {
    if (!sessionId || !runId) return;
    let cancelled = false;
    // A watch that never attaches would otherwise leave every surface stuck on "starting…"
    // with nothing anywhere saying why — the readout would simply never move. Surface it, and
    // flag the run so its surfaces stop implying they are following it.
    commands
      .watchWorkflowJournal(sessionId, runId)
      .then((res) => {
        if (cancelled || res.status !== "error") return;
        useAppErrors
          .getState()
          .pushError("Couldn't follow the workflow's progress", res.error);
        useWorkflowJournalStore.getState().markError(convId, runId, res.error);
      })
      .catch((e) => {
        if (!cancelled) console.error("watchWorkflowJournal threw:", e);
      });
    return () => {
      cancelled = true;
      // A failed unwatch only leaks a watcher thread — nothing the user can act on, but it
      // must not vanish either (it would show up as unexplained disk activity).
      commands.unwatchWorkflowJournal(sessionId, runId).then(
        (res) => {
          if (res.status === "error") {
            console.error("unwatchWorkflowJournal failed:", res.error);
          }
        },
        (e) => console.error("unwatchWorkflowJournal threw:", e),
      );
    };
  }, [convId, sessionId, runId]);

  return null;
}
