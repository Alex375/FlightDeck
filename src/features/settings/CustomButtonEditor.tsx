// Create or edit one custom composer button: pick an icon, name it, choose the action,
// fill in that action's argument.
//
// The form is driven by the action catalogue: each action declares the KIND of argument
// it takes, and the right editor appears on its own. Adding an action later therefore
// costs nothing here.
import { useMemo, useState } from "react";
import { ICON_NAMES, Ico } from "../../ui/kit";
import {
  COMPOSER_ACTIONS,
  CARET_MARK,
  actionById,
  parseConfigArg,
  serializeConfigArg,
  type ComposerActionDescriptor,
  type ConfigArg,
} from "../conversation/composerActions";
import { CLAUDE_MODELS, CODEX_MODELS } from "../conversation/models";
import { effortLevelsForModel } from "../conversation/EffortGauge";
import { EFFORT_LABELS } from "../../agent/subagentMeta";
import { DEFAULT_MODEL } from "../../store/conversationsStore";
import type { CustomButton } from "../conversation/composerLayout";
import styles from "./SettingsPanel.module.css";

/** Ids are only ever compared to each other, so any unique string does. Date-free
 *  (a counter + a random suffix) so nothing depends on the clock. */
let seq = 0;
export function newButtonId(): string {
  seq += 1;
  return `btn-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const PERMISSIONS: Array<[string, string]> = [
  ["", "Leave unchanged"],
  ["default", "Default"],
  ["acceptEdits", "Auto-accept edits"],
  ["plan", "Plan mode"],
  ["auto", "Auto mode"],
  ["bypassPermissions", "Bypass permissions"],
];

export function CustomButtonEditor({
  button,
  existing,
  onSave,
  onCancel,
}: {
  button: CustomButton;
  existing: boolean;
  onSave: (b: CustomButton) => void;
  onCancel: () => void;
}) {
  const [icon, setIcon] = useState(button.icon);
  const [label, setLabel] = useState(button.label);
  const [action, setAction] = useState(button.action);
  const [arg, setArg] = useState(button.arg ?? "");
  const [cfg, setCfg] = useState<ConfigArg>(() => parseConfigArg(button.arg));

  const desc = actionById(action);
  const groups = useMemo(() => {
    const by = new Map<string, ComposerActionDescriptor[]>();
    for (const a of COMPOSER_ACTIONS) {
      const list = by.get(a.group) ?? [];
      list.push(a);
      by.set(a.group, list);
    }
    return [...by.entries()];
  }, []);

  const effortsForConfig = effortLevelsForModel(cfg.model ?? DEFAULT_MODEL);

  // A button with no tooltip would be a mystery glyph: the icon is all the bar shows.
  const canSave = label.trim().length > 0 && !!desc &&
    (desc.arg === "none" ||
      (desc.arg === "config"
        ? !!(cfg.model || cfg.effort || cfg.permission)
        : arg.trim().length > 0));

  const save = () => {
    if (!canSave || !desc) return;
    onSave({
      ...button,
      icon,
      label: label.trim(),
      action,
      arg: desc.arg === "none" ? undefined : desc.arg === "config" ? serializeConfigArg(cfg) : arg.trim(),
    });
  };

  return (
    <div className="cvset-editor-scrim" onClick={onCancel}>
      <div className="cvset-editor" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="cvset-editor-head">
          <span className="cvset-editor-title">{existing ? "Edit button" : "New button"}</span>
          <button type="button" className="cvset-editor-x" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cvset-editor-body">
          <div className={styles.ttitle}>Icon</div>
          <div className="cvset-icongrid">
            {ICON_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                className="cvset-iconcell"
                data-on={icon === name ? "" : undefined}
                title={name}
                aria-label={name}
                onClick={() => setIcon(name)}
              >
                <Ico name={name} className="sm" />
              </button>
            ))}
          </div>

          <div className={styles.ttitle}>Name</div>
          <div className={styles.thint}>
            Shown when you hover the button — the bar itself only shows the icon.
          </div>
          <input
            className="cvset-input"
            value={label}
            placeholder="Ship it"
            onChange={(e) => setLabel(e.target.value)}
          />

          <div className={styles.ttitle}>Action</div>
          <select className="cvset-input" value={action} onChange={(e) => setAction(e.target.value)}>
            {groups.map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {desc ? <div className={styles.thint}>{desc.hint}</div> : null}

          {desc?.arg === "text" ? (
            <>
              <div className={styles.ttitle}>Text</div>
              <div className={styles.thint}>
                Write {CARET_MARK} where the caret should land after inserting.
              </div>
              <textarea
                className="cvset-input cvset-textarea"
                rows={3}
                value={arg}
                placeholder={`Review ${CARET_MARK} and list the risks`}
                onChange={(e) => setArg(e.target.value)}
              />
            </>
          ) : null}

          {desc?.arg === "command" ? (
            <>
              <div className={styles.ttitle}>Command</div>
              <div className={styles.thint}>
                Without the slash. The button greys out in repositories that don't offer it,
                rather than sending text the agent would read as prose.
              </div>
              <input
                className="cvset-input"
                value={arg}
                placeholder="done"
                onChange={(e) => setArg(e.target.value)}
              />
            </>
          ) : null}

          {desc?.arg === "config" ? (
            <>
              <div className={styles.ttitle}>Configuration</div>
              <div className={styles.thint}>
                Leave a field unchanged to keep whatever the conversation is already using.
              </div>
              <select
                className="cvset-input"
                value={cfg.model ?? ""}
                onChange={(e) => setCfg({ ...cfg, model: e.target.value || undefined })}
              >
                <option value="">Model — leave unchanged</option>
                <optgroup label="Claude">
                  {CLAUDE_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Codex">
                  {CODEX_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              </select>
              <select
                className="cvset-input"
                value={cfg.effort ?? ""}
                onChange={(e) => setCfg({ ...cfg, effort: e.target.value || undefined })}
              >
                <option value="">Thinking effort — leave unchanged</option>
                {effortsForConfig.map((lvl) => (
                  // Labels, not raw ids: "Extra" is what the chip says, `xhigh` is an
                  // internal value. EFFORT_LABELS is the one table both read.
                  <option key={lvl} value={lvl}>
                    {EFFORT_LABELS[lvl] ?? lvl}
                  </option>
                ))}
              </select>
              <select
                className="cvset-input"
                value={cfg.permission ?? ""}
                onChange={(e) =>
                  setCfg({ ...cfg, permission: (e.target.value || undefined) as ConfigArg["permission"] })
                }
              >
                {PERMISSIONS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {value === "" ? "Permission mode — leave unchanged" : text}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>

        <div className="cvset-editor-foot">
          {/* Why saving is refused, in VISIBLE text — the confirm button is inert until
              the form is complete, and a tooltip on it would never render. */}
          {!canSave ? (
            <span className={styles.thint}>
              {label.trim() ? "Fill in what this button should do." : "Give the button a name."}
            </span>
          ) : null}
          <span style={{ marginLeft: "auto" }} />
          <button type="button" className="wf-btn sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="wf-btn sm cvset-save"
            aria-disabled={!canSave || undefined}
            onClick={canSave ? save : undefined}
          >
            {existing ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
