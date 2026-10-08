// Where a TOSSE task runs, as the tasks view shows it: which MACHINE, then which folder.
//
// A project can live on this Mac AND on a paired server — the same repository, matched to
// the CRM by its `origin` on both. The two folders used to render identically (a folder
// glyph and a name), so choosing between them meant reading paths. Here the machine leads,
// in the glyphs the rest of the app already uses for it: the laptop of the side panel's
// "This Mac" row, the transmitting mast of `RemoteRepoMark`.
//
// Non-interactive on purpose: these sit INSIDE buttons (a place row, a conversation row, a
// menu item). `RemoteRepoMark` turns into a button of its own when its server is down, and
// a button inside a button is not something a browser keeps in one piece.

import { Ico } from "../../ui/kit";
import { repoName, useMachines, type Machine } from "../../store/conversationsStore";
import { isUnreachable, useMachineHealth } from "../../store/machineHealth";
import { remoteMarkFor } from "../machines/RemoteRepoMark";
import s from "./PlaceMark.module.css";

/** How a place's machine is named and drawn. Derived once so the glyph, the name and the
 *  tone never disagree. Pure; exported for the unit test. */
export interface PlaceMachine {
  kind: "local" | "remote" | "unknown";
  /** "This Mac", the server's label, or "Unknown server". */
  name: string;
  /** The ssh target, for a paired server — what a tooltip adds to the name. */
  target: string | null;
}

export function placeMachine(machineId: string | null | undefined, machines: Machine[]): PlaceMachine {
  const mark = remoteMarkFor(machineId, machines);
  if (mark.kind === "local") return { kind: "local", name: "This Mac", target: null };
  // ⚠️ Never "This Mac" for an id we cannot place — the folder is still on a server
  // (same rule as `RemoteRepoMark`).
  if (mark.kind === "unknown") return { kind: "unknown", name: "Unknown server", target: null };
  return { kind: "remote", name: mark.label, target: mark.target };
}

/** The machine as drawn: its name, its glyph, and whether the health sweep found it down. */
function useMachineView(machineId: string | null | undefined) {
  const machines = useMachines();
  const health = useMachineHealth(machineId);
  const view = placeMachine(machineId, machines);
  const down = view.kind !== "local" && isUnreachable(health);
  const icon = view.kind === "local" ? "ide" : down ? "serverOff" : "server";
  const tone = down ? s.err : view.kind === "unknown" ? s.att : "";
  return { ...view, down, icon, tone };
}

/**
 * A place on two lines: the machine, then the folder. The full path rides in the caller's
 * tooltip — a choice between machines is made on the machine's name, not on a path.
 */
export function PlaceLabel({
  machineId,
  path,
  large,
}: {
  machineId: string | null;
  path: string;
  /** The dialog's size — one place shown on its own, rather than one row of a list. */
  large?: boolean;
}) {
  const m = useMachineView(machineId);
  return (
    <>
      <span className={`${s.ico} ${m.tone}`}>
        <Ico name={m.icon} className={large ? "" : "sm"} />
      </span>
      <span className={`${s.body} ${large ? s.large : ""}`}>
        <span className={s.machineLine}>
          <span className={s.machine}>{m.name}</span>
          {/* Beside the NAME, never truncated: it is a fact about the machine, and the one
              thing on the row that changes whether choosing it can work. */}
          {m.down ? <span className={`${s.state} ${s.err}`}>unreachable</span> : null}
        </span>
        <span className={s.folder}>{repoName(path)}</span>
      </span>
    </>
  );
}

/** A machine as a heading — its glyph and name, THIS MAC INCLUDED: for a list grouped by
 *  machine, where the local group needs a title like any other. */
export function MachineHeading({ machineId, className }: { machineId: string | null; className?: string }) {
  const m = useMachineView(machineId);
  return (
    <span className={`${s.heading} ${m.tone} ${className ?? ""}`} title={m.target ?? undefined}>
      <Ico name={m.icon} className="sm" />
      {m.name}
      {m.down ? " · unreachable" : null}
    </span>
  );
}

/**
 * The machine as an inline tag — the mast and the server's name — for a surface that
 * already names the folder (the Start button, a conversation row, the folder chip).
 * Nothing at all for this Mac: local is the unmarked default everywhere in the app, and a
 * tag on every row would drown the one that says "this runs elsewhere".
 *
 * `glyphOnly` drops the name where there is no room for it; the name moves to `title`.
 */
export function MachineTag({
  machineId,
  glyphOnly,
  inherit,
}: {
  machineId: string | null | undefined;
  glyphOnly?: boolean;
  /** Take the surrounding text colour (dimmed) instead of the quiet grey — for a tag
   *  inside a coloured button. A health tone still wins. */
  inherit?: boolean;
}) {
  if (!machineId) return null;
  return <RemoteTag machineId={machineId} glyphOnly={glyphOnly} inherit={inherit} />;
}

function RemoteTag({
  machineId,
  glyphOnly,
  inherit,
}: {
  machineId: string;
  glyphOnly?: boolean;
  inherit?: boolean;
}) {
  const m = useMachineView(machineId);
  const title = m.down ? `${m.name} — unreachable` : m.target ? `${m.name} (${m.target})` : m.name;
  return (
    <span className={`${s.tag} ${inherit ? s.tagInherit : ""} ${m.tone}`} title={title}>
      <Ico name={m.icon} className="sm" />
      {glyphOnly ? null : <span className={s.tagName}>{m.name}</span>}
    </span>
  );
}

/**
 * The project's DEFAULT place — the one a plain "Start" runs in — and the way to change it,
 * drawn the same wherever a place is chosen (the Start drop-down, the Start dialog).
 *
 * One glyph carries the whole idea, with no sentence to read: a FILLED pin + "Default" on
 * the place that is it; an OUTLINED pin + "Make default" on any other, in the same slot. So
 * the state and the way to change it are visibly the same control.
 *
 *  - `default`: this place IS the default. Static — there is nothing to do here.
 *  - `off` / `on`: a toggle. In a list the outline only shows on the hovered row
 *    (`className` reveals it), so the one filled pin stands out at rest.
 */
export function DefaultPin({
  state,
  onClick,
  disabled,
  className,
}: {
  state: "default" | "on" | "off";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  if (state === "default") {
    return (
      <span className={`${s.pin} ${s.pinOn} ${className ?? ""}`}>
        <Ico name="pin" className="sm" />
        Default
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`${s.pin} ${s.pinBtn} ${state === "on" ? s.pinOn : ""} ${className ?? ""}`}
      aria-pressed={state === "on"}
      disabled={disabled}
      onClick={(e) => {
        // Every place this sits on is itself clickable (a place row selects, a menu
        // closes on any click inside it) — pinning must do only that.
        e.stopPropagation();
        onClick?.();
      }}
    >
      <Ico name="pin" className="sm" />
      {state === "on" ? "Default" : "Make default"}
    </button>
  );
}

/** The machine's name alone, for a label ("Start on Base"). */
export function useMachineName(machineId: string | null | undefined): string {
  return placeMachine(machineId, useMachines()).name;
}
