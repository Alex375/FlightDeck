// The Machine row of the side panel's footer: WHERE this conversation runs — this Mac, or the
// paired server its folder lives on — and, for a server, the one fact about it that matters right
// now (see `features/machines/machineWidget.ts`, which decides every word of it).
//
// Zero cost by construction:
//  - LOCAL RETURNS EARLY. The overwhelming majority of conversations run on this Mac; their row
//    reads the Mac's name (one IPC per app run, cached forever) and never subscribes to machine
//    health, the paired list or the session's link.
//  - NO PROBE OF ITS OWN. `MachineHealthHost` stays the only ambient prober; this row reads its
//    store. The only dials it can cause are the user's own clicks ("Check now", "Reconnect").
//  - ONE RENDER CLOCK, and only while an age is on screen ("checked 2 min ago"), paused while the
//    window is hidden.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { Ico } from "../../../ui/kit";
import { Tooltip } from "../../../ui/Tooltip";
import { motionAllowed } from "../../../ui/motion";
import { commands } from "../../../ipc/client";
import { useDisplay } from "../../../store/display";
import { useConversationStore } from "../../../store/conversationStore";
import {
  useConversationsStore,
  useMachines,
  type Conversation,
} from "../../../store/conversationsStore";
import {
  probeMachine,
  useMachineHealth,
  useMachineHealthStore,
  useMachineProbing,
} from "../../../store/machineHealth";
import { useSettingsUi } from "../../../store/settingsUi";
import {
  LOCAL_MACHINE_NAME_KEY,
  localMachineText,
  machineActions,
  machineIdOf,
  machineLinkKey,
  machineLinkOf,
  machineShowsAge,
  machineSubLine,
  machineTipLines,
  machineWidgetState,
  type MachineTone,
} from "../../machines/machineWidget";
import s from "../ConversationSidePanel.module.css";
import m from "./MachineRow.module.css";

/** How often an on-screen age is re-rendered. The coarsest unit shown is the minute. */
const AGE_TICK_MS = 30_000;

const TONE_CLASS: Record<MachineTone, string> = { lo: "", att: m.att, err: m.err };

/**
 * The footer row saying where `conv` runs. Renders nothing only when the conversation's repo is
 * not in the store — no repo, no answer, and "This Mac" would be a guess.
 */
export function MachineRow({ conv }: { conv: Conversation }) {
  // A primitive (`null` local / id remote / `undefined` no repo): re-renders only when the
  // ANSWER changes, not on every repo edit.
  const machineId = useConversationsStore((st) => machineIdOf(st.repos, conv.repoId));
  if (machineId === undefined) return null;
  if (machineId === null) return <LocalMachineRow />;
  return <RemoteMachineRow conv={conv} machineId={machineId} />;
}

/** This Mac: its Computer Name, read once per app run. No actions — there is nothing to check. */
function LocalMachineRow() {
  const { data: name } = useQuery({
    queryKey: LOCAL_MACHINE_NAME_KEY,
    queryFn: () => commands.localMachineName(),
    // The backend reads it once per run (a Mac is not renamed under a running app often enough
    // to poll); the cache follows suit, and survives every row unmounting.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  const { title, sub } = localMachineText(name);
  return (
    <div className={`${s.row} ${m.machine}`} title={name ? title : undefined}>
      <span className={s.rowIco}>
        <Ico name="ide" className="sm" />
      </span>
      <span className={s.rowMain}>
        <span className={s.rowTitle}>{title}</span>
        <span className={s.rowSub}>{sub}</span>
      </span>
    </div>
  );
}

/** A paired server (or one no longer paired): its name, the most important fact, and the
 *  explicit gestures — check it now, retry a dropped link now, open the server panel. */
function RemoteMachineRow({ conv, machineId }: { conv: Conversation; machineId: string }) {
  const machines = useMachines();
  const health = useMachineHealth(machineId);
  const probing = useMachineProbing(machineId);
  const link = useConversationStore(
    useShallow((st) => machineLinkOf(conv.handle, st.sessions[conv.id]?.state, conv.kind)),
  );
  const openSettings = useSettingsUi((st) => st.openSettings);
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));

  const view = machineWidgetState({ machineId, machines, health, link });
  useAgeClock(machineShowsAge(view));
  const nowMs = Date.now();

  // A failed reconnect is the answer to the user's own click, so it is shown — but only until
  // the link moves on (a new attempt, attached, off), or it would outlive what it was about.
  const [reconnectPending, setReconnectPending] = useState(false);
  const [reconnectFail, setReconnectFail] = useState<{ error: string; linkKey: string } | null>(null);
  const linkKey = machineLinkKey(link);
  // ⚠️ The failure is stamped with the link state current when it LANDS, read through a ref: a
  // key captured at click time would drop the error in silence whenever the link moved while
  // the command was out (a new attempt ticking over during the round trip).
  const linkKeyRef = useRef(linkKey);
  useEffect(() => {
    linkKeyRef.current = linkKey;
  }, [linkKey]);
  const reconnectError = reconnectFail && reconnectFail.linkKey === linkKey ? reconnectFail.error : null;
  // The guard against a double fire lives in a ref, not in `disabled`: the button stays
  // focusable while pending (see the buttons below), so a second Enter must be refused here.
  const reconnectPendingRef = useRef(false);

  const reconnect = useCallback(() => {
    if (reconnectPendingRef.current) return;
    reconnectPendingRef.current = true;
    setReconnectPending(true);
    setReconnectFail(null);
    const fail = (error: string) => setReconnectFail({ error, linkKey: linkKeyRef.current });
    commands
      .reconnectRemoteSessions()
      .then((res) => {
        if (res.status === "error") fail(res.error);
      })
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        reconnectPendingRef.current = false;
        setReconnectPending(false);
      });
  }, []);

  // Same reasoning for "Check now": `probeMachine` already dedupes a probe in flight, so a click
  // while `probing` is a harmless no-op — refused here only so it reads as one.
  const checkNow = useCallback(() => {
    if (useMachineHealthStore.getState().probing[machineId]) return;
    void probeMachine(machineId, true);
  }, [machineId]);

  const sub = machineSubLine(view, { nowMs, probing, reconnectError });
  const tip = machineTipLines(view, nowMs);
  if (reconnectError) tip.push(`Reconnect failed: ${reconnectError}`);
  const acts = machineActions(view);

  const unknown = view.kind === "unknown";
  const down = view.kind === "remote" && view.reach.kind === "unreachable";
  const title = view.kind === "remote" ? view.label : "Unknown server";
  // The glyph carries HEALTH, like the remote mark: crossed out and red only on a checked
  // "unreachable", amber for a server we cannot name, quiet otherwise.
  const icoTone = down ? m.err : unknown ? m.att : "";

  return (
    <div className={`${s.row} ${m.machine}`} data-motion={motion || undefined}>
      <span className={`${s.rowIco} ${icoTone}`}>
        <Ico name={down ? "serverOff" : "server"} className="sm" />
      </span>
      <Tooltip
        className={s.rowMain}
        label={tip.join(" — ")}
        content={
          <>
            {tip[0]}
            {tip.slice(1).map((line, i) => (
              <span key={i} className="wf-tip-sub">
                {line}
              </span>
            ))}
          </>
        }
      >
        <span className={`${s.rowTitle} ${unknown ? m.att : ""}`}>{title}</span>
        <span className={`${s.rowSub} ${TONE_CLASS[sub.tone]}`}>{sub.text}</span>
      </Tooltip>
      <span className={s.rowActs}>
        {acts.check ? (
          // ⚠️ `aria-disabled`, never `disabled`, while a check is out (the app's convention for
          // a refused-but-hoverable control): a `disabled` button drops keyboard focus the
          // moment Enter pressed it, and never shows its `title` — the "Checking…" hint would
          // be unreachable exactly while it is true. `checkNow` refuses the click instead.
          <button
            type="button"
            className={s.rowBtn}
            aria-disabled={probing || undefined}
            aria-busy={probing || undefined}
            onClick={checkNow}
            title={probing ? "Checking…" : "Check now"}
            aria-label={probing ? "Checking the server" : "Check the server now"}
          >
            <Ico name="refresh" className={`sm ${probing ? m.spinning : ""}`} />
          </button>
        ) : null}
        {acts.reconnect ? (
          // The app's own tooltip, not `title`: what this button reaches (EVERY remote
          // conversation whose link dropped, not only this one) is the thing to know before
          // clicking, and a native title would arrive a second too late. The tooltip is
          // pointer-only, so the button's own label says it too — a keyboard user must not
          // learn the scope only after pressing it.
          <Tooltip
            className={m.tipWrap}
            label="Reconnect now — retries every remote conversation whose connection dropped, not only this one"
            content={
              <>
                Reconnect now
                <span className="wf-tip-sub">Retries every remote conversation whose connection dropped</span>
              </>
            }
          >
            <button
              type="button"
              className={s.rowBtn}
              aria-disabled={reconnectPending || undefined}
              aria-busy={reconnectPending || undefined}
              onClick={reconnect}
              aria-label="Reconnect now — retries every remote conversation whose connection dropped"
            >
              <Ico name="plug" className="sm" />
            </button>
          </Tooltip>
        ) : null}
        {acts.server ? (
          <button
            type="button"
            className={s.smallBtn}
            onClick={() => openSettings("control", "remote")}
            title="Open the server panel (Settings → Control → Remote)"
          >
            Server
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Re-render every {@link AGE_TICK_MS} while `active`, so an on-screen age ("checked 2 min ago")
 * keeps up with the clock between two store updates. The caller reads `Date.now()` itself — the
 * tick only asks for the render — so a verdict filed between ticks is never aged by a stale clock.
 *
 * Paused while the window is hidden (nobody is reading it), with one catch-up render on return.
 * Stopped entirely when nothing aged is shown — an attached or unchecked server costs nothing.
 */
function useAgeClock(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const bump = () => setTick((n) => n + 1);
    const start = () => {
      if (timer === null) timer = setInterval(bump, AGE_TICK_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        bump();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
}
