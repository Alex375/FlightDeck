// The side panel's Stats widget: one line of four readings — the average turn, the files the
// agent changed, its tool calls, and the tokens the WHOLE session used (main thread, sub-agents,
// workflow agents). The header keeps the token total, so the section can stay folded and still
// answer « how much has this conversation burnt ».
//
// Zero cost by construction:
//  - NO TIMER, NO POLL, NO DISK READ. Every figure is event-driven: the session total rides the
//    state the core pushes at each turn end (seeded once from disk by the history loader), the
//    counts come from the telemetry derivation the store already memoises, the workflow roll-ups
//    from the background-task registry.
//  - The header reads three cheap store readings: the session total — kept by reference while
//    its value holds (the store compares it by value, see `sameSessionUsage`), so the
//    per-model-call state pushes do not re-render it — its source, and whether a thread exists.
//    Everything else lives in the body, which a folded section unmounts. (StatsWidget.test.ts
//    pins both: no commit on a same-value push, no tile while folded.)
//  - Every word is decided by the pure `stats.ts` (tested); this file only draws it.

import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Ico } from "../../../ui/kit";
import { Tooltip } from "../../../ui/Tooltip";
import { motionAllowed } from "../../../ui/motion";
import { useDisplay } from "../../../store/display";
import { useConversationStore } from "../../../store/conversationStore";
import { runningCountFor, useBackgroundTasksStore } from "../../../store/backgroundTasksStore";
import type { Conversation } from "../../../store/conversationsStore";
import type { SessionUsage } from "../../../ipc/client";
import { PanelSection } from "../PanelSection";
import { memoizedTelemetry } from "../telemetry";
import {
  statsMeta,
  statsMetaTip,
  statsView,
  tileLabel,
  workflowCalls,
  type StatsTelemetry,
  type StatTile,
} from "./stats";
import s from "../ConversationSidePanel.module.css";
import w from "./StatsWidget.module.css";

type Kind = "claude" | "codex";

/**
 * The Stats section for `conv`, or nothing while the conversation has nothing to count — no
 * message yet and no session total on record (a brand-new conversation).
 */
export function StatsWidget({ conv }: { conv: Conversation }) {
  const convId = conv.id;
  const kind: Kind = conv.kind === "codex" ? "codex" : "claude";
  // Reference-stable while the value holds (see the file header): cheap enough for a header.
  const usage = useConversationStore((st) => st.sessions[convId]?.state?.session_usage ?? null);
  const source = useConversationStore((st) => st.sessions[convId]?.sessionUsageSource ?? null);
  const hasThread = useConversationStore((st) => (st.sessions[convId]?.timeline.length ?? 0) > 0);
  if (!usage && !hasThread) return null;
  const figure = statsMeta(usage);
  const tip = statsMetaTip(kind, usage, source);
  return (
    <PanelSection
      id="stats"
      icon={<Ico name="pulse" className="sm" />}
      title="Stats"
      meta={
        // The trigger IS the capsule, so it stays the header's flex item (pushed right).
        <Tooltip content={tip} label={`${figure} — ${tip}`} className={`${s.meta} wf-mono`}>
          {figure}
        </Tooltip>
      }
    >
      <StatsBody convId={convId} kind={kind} usage={usage} />
    </PanelSection>
  );
}

/** The four tiles. Mounted only while the section is open. */
function StatsBody({ convId, kind, usage }: { convId: string; kind: Kind; usage: SessionUsage | null }) {
  // The counts it shows, shallow-compared: the memoised telemetry object also moves with the
  // live feed and the in-flight board, which must not re-render these tiles.
  const t: StatsTelemetry = useConversationStore(
    useShallow((st) => {
      const tel = memoizedTelemetry(convId, st.sessions[convId]);
      return {
        turns: tel.turns,
        timedTurns: tel.timedTurns,
        meanTurnMs: tel.meanTurnMs,
        totalCalls: tel.totalCalls,
        subCalls: tel.subCalls,
        replayedCalls: tel.replayedCalls,
        filesTouched: tel.filesTouched,
      };
    }),
  );
  const source = useConversationStore((st) => st.sessions[convId]?.sessionUsageSource ?? null);
  const workflows = useBackgroundTasksStore(useShallow((st) => workflowCalls(st.sessions[convId])));
  const backgroundRunning = useBackgroundTasksStore((st) => runningCountFor(st.sessions, convId) > 0);
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));
  const view = statsView({ kind, t, usage, source, workflows, backgroundRunning });
  return (
    <div className={w.grid} data-motion={motion || undefined}>
      {view.tiles.map((tile) => (
        <Tile key={tile.key} tile={tile} />
      ))}
    </div>
  );
}

function Tile({ tile }: { tile: StatTile }) {
  return (
    <Tooltip
      content={
        <>
          <span className={w.tipHead}>{tile.tip[0]}</span>
          {tile.tip.slice(1).map((line) => (
            <span key={line} className={w.tipLine}>
              {line}
            </span>
          ))}
        </>
      }
      label={tileLabel(tile)}
      className={w.tile}
    >
      <Rolling text={tile.value} known={tile.known} />
      <span className={w.label}>{tile.label}</span>
      {tile.hint ? (
        // Keyed by its text: a WebKit ellipsis box whose text alone changes keeps painting the
        // old glyphs under the new ones — a fresh node gets a clean paint region.
        <span key={tile.hint} className={w.hint} data-caveat={tile.caveat || undefined}>
          {tile.hint}
        </span>
      ) : null}
    </Tooltip>
  );
}

/**
 * A value that ROLLS IN when it changes — the one motion the widget makes, and only to show that
 * a figure just moved. Keyed by its text, so each new value is a new node (which is also what
 * spares WebKit's ellipsis repaint bug); the first value it mounted with does not roll, or opening
 * the panel would animate every tile at once.
 */
function Rolling({ text, known }: { text: string; known: boolean }) {
  const [first] = useState(text);
  const [moved, setMoved] = useState(false);
  // "Adjust state while rendering": flag the first change without an effect or an extra frame.
  if (!moved && text !== first) setMoved(true);
  return (
    <span
      key={text}
      className={w.value}
      data-roll={moved || undefined}
      data-unknown={!known || undefined}
    >
      {text}
    </span>
  );
}
