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
}: {
  /** The current assignee (possibly « MCP de X »), or null when nobody is. */
  value: string | null;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const person = value ? splitMcpActor(value).person : null;
  return (
    <Menu
      portal
      align="right"
      trigger={
        <button
          type="button"
          className={`${s.whoChip} ${s.whoPick}`}
          disabled={disabled}
          title={person ? `Assigned to ${person} — change` : "Assign this task"}
          aria-label={person ? `Assigned to ${person}, change the assignee` : "Assign this task"}
        >
          {value ? <AssigneeAvatar name={value} /> : <Ico name="users" className="sm" />}
          {person ?? "Assign"}
          <Ico name="chevron" className="sm" />
        </button>
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
