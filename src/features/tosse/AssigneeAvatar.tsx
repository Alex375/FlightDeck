// Who a task is assigned to — the CRM's `PersonAvatar`, ported.
//
// The colours and the initials are NOT derived: the CRM hard-codes them per person
// (Alexandre is blue "JO", Armand is purple "C8", "Les deux" is grey "2"), and a task
// assigned to Armand has to wear the same mark in both apps or the whole point of matching
// the CRM is lost.
//
// It also carries the CRM's "MCP de <name>" case: an action taken through the MCP server
// shows a robot as the main mark with the person who triggered it as a small badge — which
// is exactly how tasks Claude files on Alexandre's behalf appear in the CRM.

import { Ico } from "../../ui/kit";
import s from "./TosseView.module.css";

/** Per-person colours, verbatim from the CRM's `PersonAvatar`. */
const COLORS: Record<string, string> = {
  Alexandre: "#3b82f6", // blue-500
  Armand: "#a855f7", // purple-500
  "Les deux": "#6b7280", // gray-500
};

/** Initials, verbatim from the CRM — deliberately NOT the first letters of the name. */
export function assigneeInitials(name: string): string {
  if (name === "Les deux") return "2";
  if (name === "Armand") return "C8";
  if (name === "Alexandre") return "JO";
  return name.slice(0, 2).toUpperCase();
}

/** `MCP de X` → `X`, plus a flag. The CRM attributes MCP-server actions this way. */
export function splitMcpActor(name: string): { person: string; viaMcp: boolean } {
  const m = /^MCP de (.+)$/.exec(name);
  return m ? { person: m[1], viaMcp: true } : { person: name, viaMcp: false };
}

export function AssigneeAvatar({ name }: { name: string }) {
  const { person, viaMcp } = splitMcpActor(name);
  const colour = COLORS[person] ?? "#6b7280";

  if (viaMcp) {
    return (
      <span className={s.whoMcp} title={`${person} · via MCP`}>
        <span className={s.whoMcpMain}>
          <Ico name="bot" className="sm" />
        </span>
        <span className={s.whoMcpBadge} style={{ background: colour }}>
          {assigneeInitials(person)}
        </span>
      </span>
    );
  }

  return (
    <span className={s.who} style={{ background: colour }} title={person}>
      {assigneeInitials(person)}
    </span>
  );
}
