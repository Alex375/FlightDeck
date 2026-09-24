// The inline card for ONE write to the TOSSE CRM, rendered in the thread where the agent made
// it (its own segment — see `tosse` in toolGroup). It answers, without opening anything, the
// three questions the generic "claude ai TOSSE · 3 tools" header cannot: WHICH tool ran, on
// WHICH task, and — for a status move — where the task came FROM and where it went.
//
// Shaped like <ArtifactCard>: a mark, a headline, an eyebrow, a state glyph. A task card also
// wears the CRM's own furniture — its status pills and its assignee mark — so a task reads the
// same here as it does in the TOSSE view and in the CRM itself.
//
// Clicking a task card opens it in the conversation's RIGHT SIDE PANEL (`openTosseTask`, which
// holds that region open on its own); with no CRM session to read the task from, it opens the
// task in the browser instead, and when neither is possible the card is simply not clickable
// (never a dead link).
//
// ⚠️ Zero silent error. A refused or failed call comes back `is_error` and is rendered as a
// failure with its reason — a write the CRM rejected must never look like one that landed, so
// a failed card shows NO status pills at all rather than pills for a move that did not happen.
// A call still in flight shows a pending state rather than an empty card.
//
// `TosseToolView` takes plain data so the live thread and the settled disk transcript (history
// preview, sub-agent drill-in) render identically; `TosseToolCard` is the live wrapper that
// reads the result, the task's previous status and the click routing from the store.

import { openUrl } from "@tauri-apps/plugin-opener";
import type { JsonValue } from "../../ipc/client";
import { resultText } from "../../agent/subagentMeta";
import { useConversationStore, useSessionState, useToolResult } from "../../store/conversationStore";
import { useDisplay } from "../../store/display";
import { useTosseAvailable, useTosseWebUrl } from "../../ipc/useTosse";
import { useEditorStore } from "../editor/editorStore";
import { AssigneeAvatar } from "../tosse/AssigneeAvatar";
import { taskStatusTone } from "../tosse/tosseModel";
import ts from "../tosse/TosseView.module.css";
import { Dot, Ico } from "../../ui/kit";
import { useHostInert } from "./FileMention";
import { priorTaskStatus, tosseCardView } from "./tosseTool";

/**
 * Whether TOSSE calls get their dedicated rendering at all: the preference AND a CRM session.
 *
 * Gated on the session deliberately. The preference lives in Settings → TOSSE, a tab that does
 * not exist while signed out — so leaving the rendering on there would hand someone cards with
 * no switch to turn them off. Signed out, every TOSSE call renders as the plain MCP step it
 * always was.
 *
 * ONE definition, used by every surface that asks (the card segments, the step rows, the run
 * headers), so they can never disagree mid-thread about whether a call is a CRM action.
 */
export function useTosseToolCards(): boolean {
  const pref = useDisplay((s) => s.tosseToolCards);
  const available = useTosseAvailable();
  return pref && available;
}

/** The task's status as the CRM paints it — the board's own pill, read-only here (the card is
 *  a record of what happened, not a control; the side panel and the TOSSE view are where a
 *  status is changed). */
function StatusPill({ status, faded }: { status: string; faded?: boolean }) {
  return (
    <span
      className={`${ts.state} ${ts[`state_${taskStatusTone(status)}`]}`}
      data-was={faded ? "1" : undefined}
      title={status}
    >
      {status}
    </span>
  );
}

/** Where the task went, and — when the conversation had seen it before — where it came from.
 *  The arrow is the whole point of the card for a status move: "En cours" alone does not say
 *  what changed. With no earlier sighting we show the landing status alone rather than invent
 *  an origin. */
function StatusMove({ from, to, pending }: { from: string | null; to: string; pending: boolean }) {
  return (
    <span className="cv-tosseact-move" data-pending={pending ? "1" : undefined}>
      {from && from !== to ? (
        <>
          <StatusPill status={from} faded />
          <Ico name="arrow" className="sm cv-tosseact-arrow" />
        </>
      ) : null}
      <StatusPill status={to} />
    </span>
  );
}

export function TosseToolView({
  name,
  input,
  result,
  running = false,
  /** The status this task was last seen in BEFORE this call — null when unknown, which is not
   *  the same as "unchanged" and must never be rendered as an origin. */
  previousStatus = null,
  /** How a click on a task card is honoured; omitted → the card is not clickable. */
  onOpenTask,
  openHint,
}: {
  name: string;
  input: JsonValue;
  result: { content: JsonValue; isError: boolean } | undefined;
  /** The call belongs to the live, busy turn — only then may a resultless card read "Saving…".
   *  A resultless call in a past turn (a session torn down mid-call, a truncated transcript)
   *  would otherwise spin forever. */
  running?: boolean;
  previousStatus?: string | null;
  onOpenTask?: (taskId: string) => void;
  openHint?: string;
}) {
  const errored = !!result?.isError;
  // The view is built from the input ALONE when the call failed: a refused write's "result" is
  // an error message, and parsing it for a task would dress the failure up as a success.
  const view = tosseCardView(name, input, errored ? undefined : result?.content);
  // ⚠️ `verb` is PAST tense by contract ("created", "moved") — it cannot follow "refused to".
  // The fallback fires exactly when the CRM sent no text with its refusal, i.e. on the one
  // card that has to be clearest, where it read "refused to created this task".
  const reason = errored
    ? resultText(result?.content).trim() ||
      `The CRM refused this ${view.action.entity}${view.tool ? ` (${view.tool})` : ""}`
    : null;
  const pending = !result;
  const task = view.task;
  const clickable = !errored && !!view.taskId && !!onOpenTask;
  const open = clickable ? () => onOpenTask!(view.taskId!) : undefined;

  // "TOSSE task · update_task_status · Tosse Code" — the eyebrow names the exact tool, because
  // the CRM exposes about sixty of them and "moved" alone does not identify the call.
  const kind = `TOSSE ${view.action.entity}`;
  // ⚠️ "Saving…" only while the call really is in flight. A resultless call in a SETTLED turn
  // (session torn down mid-call, truncated transcript, a tool_result that never came) is not
  // saving anything — it read "Saving…" for ever, in the past tense of a thread nobody is
  // going to finish. The `running` prop exists for exactly this, and the dot already honoured
  // it; the text did not. Saying what happened beats an animation that never ends.
  const detail = errored
    ? reason
    : pending
      ? running
        ? "Saving…"
        : "No result recorded"
      : view.detail;

  return (
    <div
      className="cv-tosseact"
      data-open={clickable || undefined}
      data-state={errored ? "error" : undefined}
      onClick={open}
      role={clickable ? "button" : undefined}
      title={errored ? (reason ?? undefined) : clickable ? openHint : undefined}
    >
      <span className="cv-tosseact-tile" aria-hidden="true">
        <Ico name="tosse" />
      </span>
      <span className="cv-tosseact-body">
        <span className="cv-tosseact-title">{view.headline}</span>
        <span className="cv-tosseact-sub">
          <span className="cv-tosseact-kind">{errored ? `${kind} · failed` : kind}</span>
          {view.tool ? <span className="cv-tosseact-tool wf-mono">{view.tool}</span> : null}
          {detail ? <span className="cv-tosseact-detail">{detail}</span> : null}
        </span>
      </span>
      {/* The CRM's own marks, and only for what the payload actually carried — a missing
          assignee is left out rather than filled with a placeholder, and a FAILED call shows
          no status at all (it moved nothing). */}
      {/* The arrow is only drawn for a call that CARRIED a status change (`movedStatus`) —
          otherwise the landing pill stands alone. The CRM echoes the whole task back after
          any write, so a title edit arrives with a status that may well differ from the last
          one this thread sighted, and the arrow would credit this call with a move made
          somewhere else entirely (Flight Deck's own TOSSE view, or a sub-agent). */}
      {!errored && view.statusTo ? (
        <StatusMove
          from={view.movedStatus ? previousStatus : null}
          to={view.statusTo}
          pending={pending}
        />
      ) : null}
      {!errored && task?.assignedTo ? (
        <span className="cv-tosseact-who">
          <AssigneeAvatar name={task.assignedTo} />
        </span>
      ) : null}
      <span className="cv-tosseact-go">
        {errored ? (
          <Ico name="alert" className="sm" />
        ) : pending ? (
          running ? (
            <Dot s="work" pulse />
          ) : (
            <Dot s="off" />
          )
        ) : clickable ? (
          <Ico name="external" className="sm" />
        ) : (
          <Ico name="check" className="sm cv-step-okico" />
        )}
      </span>
    </div>
  );
}

/** The live thread's wrapper: resolves the result, the task's previous status and the click
 *  wiring from the store. `active` marks a call of the actively streaming turn (same gate as
 *  `LiveToolStep`). */
export function TosseToolCard({
  session,
  name,
  toolUseId,
  input,
  active = false,
}: {
  session: string;
  name: string;
  toolUseId: string;
  input: JsonValue;
  active?: boolean;
}) {
  const result = useToolResult(session, toolUseId);
  const busy = useSessionState(session)?.busy ?? false;
  const taskId = tosseCardView(name, input, result?.isError ? undefined : result?.content).taskId;
  // A PRIMITIVE selector on purpose: the derivation walks the thread, and returning a string
  // means an unrelated store write (a streamed token, another tool's result) compares equal and
  // re-renders nothing. See priorTaskStatus.
  const previousStatus = useConversationStore((s) =>
    priorTaskStatus(s.sessions[session], toolUseId, taskId),
  );
  // In the app: only when the CRM is signed in (the side panel has nothing to read otherwise)
  // AND this host has a side region — the Flight Deck reply modal has none, so a click there
  // would do nothing at all. Same routing decision as ArtifactCard.
  const available = useTosseAvailable();
  const inert = useHostInert();
  const inApp = available && !inert;
  // The browser fallback. `null` while the origin is unknown (the OAuth metadata failed): a
  // link that cannot be built is not offered, rather than built wrong.
  const { data: origin } = useTosseWebUrl(!inApp);
  const openTosseTask = useEditorStore((st) => st.openTosseTask);

  const onOpenTask = inApp
    ? (id: string) => openTosseTask({ convId: session, taskId: id })
    : origin
      ? (id: string) => void openUrl(`${origin}/tasks/${id}`)
      : undefined;

  return (
    <TosseToolView
      name={name}
      input={input}
      result={result}
      running={active && !result && busy}
      previousStatus={previousStatus}
      onOpenTask={onOpenTask}
      openHint={inApp ? "Open this task in the side panel" : "Open this task in TOSSE"}
    />
  );
}
