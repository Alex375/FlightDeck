// Who a task is assigned to, as a CONTROL — the CRM's `AssigneeAvatarSelect`, ported: click the
// avatar, pick a person. Same marks as everywhere else (AssigneeAvatar), same three choices.

import { Ico, Menu, MenuItem } from "../../ui/kit";
import { AssigneeAvatar, splitMcpActor } from "./AssigneeAvatar";
import { TASK_ASSIGNEES } from "./tosseModel";
import s from "./TosseView.module.css";

export function AssigneePicker({
  value,
  onChange,
  disabled,
  compact,
}: {
  /** The current assignee (possibly « MCP de X »), or null when nobody is. */
  value: string | null;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** The bare disc, for a board row: no name, no chevron — and an empty ring when nobody is
   *  assigned, so an unassigned task still has something to click. The full chip (avatar +
   *  name) is for the panels, which have the room to say who. */
  compact?: boolean;
}) {
  const person = value ? splitMcpActor(value).person : null;
  const title = person ? `Assigned to ${person} — change` : "Assign this task";
  const label = person ? `Assigned to ${person}, change the assignee` : "Assign this task";
  return (
    <Menu
      portal
      align="right"
      trigger={
        compact ? (
          <button
            type="button"
            className={s.whoDisc}
            disabled={disabled}
            title={title}
            aria-label={label}
          >
            {value ? <AssigneeAvatar name={value} untitled /> : <span className={s.whoEmpty} />}
          </button>
        ) : (
          <button
            type="button"
            className={`${s.whoChip} ${s.whoPick}`}
            disabled={disabled}
            title={title}
            aria-label={label}
          >
            {value ? <AssigneeAvatar name={value} untitled /> : <Ico name="users" className="sm" />}
            {person ?? "Assign"}
            <Ico name="chevron" className="sm" />
          </button>
        )
      }
    >
      {TASK_ASSIGNEES.map((name) => (
        <MenuItem key={name} on={person === name} onClick={() => onChange(name)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <AssigneeAvatar name={name} />
            {name}
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}
