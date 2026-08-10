// Settings → Composer: arrange the composer's bottom bar.
//
// The preview IS the bar, not a drawing of it: the arrangement comes from the same table
// the live composer renders from (composerLayout.ts) and every chip is the same
// component, from the same file (composerChipFaces.tsx) — the Claude mark and the model
// name, the effort level, the permission mode in its own colour, the worktree tick box.
// Nothing about a control's look can differ between here and down there, because there
// is only one copy of it.
//
// The only deliberate difference is WHICH controls show: the preview lists them all so
// they can be arranged, including the ones that only appear under a condition (an
// artifact published, a goal set) and the ones belonging to the other backend.
//
// The slot budget is the load-bearing idea: there is no overflow menu, so the bar is
// capped at what fits the narrowest composer, and the count shown here is the WORST
// case (every conditional control on screen at once), never what happens to be visible.
import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ContextRing, Ico } from "../../ui/kit";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { PageHead, SettingsGroup, ToggleRow } from "./SettingsKit";
import {
  LEFT_CHIPS,
  RIGHT_CHIPS,
  SLOT_CAPACITY,
  appliesToBackend,
  chipById,
  leftGroups,
  canUnhide,
  nativeWorstCase,
  orderedRight,
  remainingSlots,
  reorderVisible,
  slotCost,
  type ChipDescriptor,
  type CustomButton,
} from "../conversation/composerLayout";
import { useComposerBar } from "../../store/composerBar";
import { useDisplay } from "../../store/display";
import {
  ArtifactsFace,
  CleanOutputFace,
  CodexOptionsFace,
  CodexSafetyFace,
  CodexSpeedFace,
  CustomFace,
  EffortFace,
  ExtensionsFace,
  GoalFace,
  ModelFace,
  PERMISSION_LABELS,
  PermissionFace,
  RemoteFace,
  WorktreeFace,
} from "../conversation/composerChipFaces";
import { DEFAULT_CODEX_PRESET } from "../conversation/codexControls";
import type { EffortLevel } from "../conversation/EffortGauge";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
} from "../../store/conversationsStore";
import { CustomButtonEditor, newButtonId } from "./CustomButtonEditor";
import { actionById, configSummary, parseConfigArg } from "../conversation/composerActions";
import styles from "./SettingsPanel.module.css";
import "./composer-section.css";

type PreviewBackend = "claude" | "codex";

export function ComposerSection() {
  return (
    <div>
      <PageHead
        title="Composer"
        subtitle="Arrange the bar under the message box: collapse controls to their icon, hide or reorder the right-hand ones, and add your own buttons."
      />
      <BarArrangement />
      <LeftControls />
      <CustomButtons />
      <ResetBar />
    </div>
  );
}

// ---- The editable preview -----------------------------------------------------------

function BarArrangement() {
  const [backend, setBackend] = useState<PreviewBackend>("claude");
  const hidden = useComposerBar((s) => s.hidden);
  const rightOrder = useComposerBar((s) => s.rightOrder);
  const customs = useComposerBar((s) => s.customs);
  const compactLeft = useComposerBar((s) => s.compactLeft);
  const setHidden = useComposerBar((s) => s.setHidden);
  const setRightOrder = useComposerBar((s) => s.setRightOrder);
  const setLeftCompact = useComposerBar((s) => s.setLeftCompact);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const [leftRun, leftRights] = leftGroups(backend);
  const visibleRight = useMemo(
    () =>
      orderedRight(rightOrder, hiddenSet, customs).filter((id) => {
        const chip = chipById(id);
        return !chip || appliesToBackend(chip, backend);
      }),
    [rightOrder, hiddenSet, customs, backend],
  );
  // Everything hideable that is currently hidden, so it can be brought back. Includes
  // controls of the OTHER backend on purpose — hiding is backend-agnostic, and a chip
  // you can't see on this preview is still one you may want to restore.
  const hiddenItems = useMemo(
    () => [
      ...RIGHT_CHIPS.filter((c) => hiddenSet.has(c.id)).map((c) => ({ id: c.id, icon: c.icon, label: c.label })),
      ...customs.filter((c) => hiddenSet.has(c.id)).map((c) => ({ id: c.id, icon: c.icon, label: c.label || "Button" })),
    ],
    [hiddenSet, customs],
  );

  const visibleCustomCount = customs.filter((c) => !hiddenSet.has(c.id)).length;
  const used = nativeWorstCase(hiddenSet) + visibleCustomCount;
  const left = remainingSlots(hiddenSet, visibleCustomCount);

  // A pointer drag is followed by a click; swallow that one click so dropping a chip
  // never also toggles it. Local (not the shared reorder guard) because this surface
  // has its own drag lifecycle.
  const justDragged = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = (e: DragEndEvent) => {
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = visibleRight.indexOf(String(active.id));
    const to = visibleRight.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    // Write the dragged item back into the slots the visible chips already occupy, so
    // hidden controls and the other backend's keep their stored positions instead of
    // being shoved to the end by a drag that never concerned them.
    const full = orderedRight(rightOrder, new Set(), customs);
    setRightOrder(reorderVisible(full, visibleRight, from, to));
  };

  const nameOf = (id: string): { icon: string; label: string } => {
    const chip = chipById(id);
    if (chip) return { icon: chip.icon, label: chip.label };
    const custom = customs.find((c) => c.id === id);
    return { icon: custom?.icon ?? "spark", label: custom?.label || "Button" };
  };

  return (
    <SettingsGroup title="The bar" icon="grid">
      <div className={styles.trow} style={{ display: "block" }}>
        <div className={styles.ttext} style={{ marginBottom: 10 }}>
          <div className={styles.ttitle}>Preview</div>
          <div className={styles.thint}>
            Click a left-hand control to collapse it to its icon. Drag the right-hand ones to
            reorder, click to hide. {used} of {SLOT_CAPACITY} slots used
            {left > 0 ? ` — ${left} free` : " — full"}. Every control is listed here,
            including those that only show under a condition.
          </div>
        </div>

        <div className="cvset-backend">
          {(["claude", "codex"] as const).map((b) => (
            <button
              key={b}
              type="button"
              className="cvset-backend-btn"
              data-on={backend === b ? "" : undefined}
              onClick={() => setBackend(b)}
            >
              {b === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>

        {/* Same classes as the live bar, so a chip here has the same footprint it will
            have down there. */}
        <div className="cvset-barwrap">
          <div className="cv-comp-foot">
            {leftRun.map((c) => (
              <PreviewLeftChip key={c.id} chip={c} compact={compactLeft[c.id] === true} onToggle={() => setLeftCompact(c.id, !compactLeft[c.id])} />
            ))}
            <span className="cv-foot-sep" />
            {leftRights.map((c) => (
              <PreviewLeftChip key={c.id} chip={c} compact={compactLeft[c.id] === true} onToggle={() => setLeftCompact(c.id, !compactLeft[c.id])} />
            ))}
            <span style={{ marginLeft: "auto" }} />
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToHorizontalAxis]}
              onDragEnd={onDragEnd}
            >
              <SortableContext items={visibleRight} strategy={horizontalListSortingStrategy}>
                {visibleRight.map((id) => {
                  const { icon, label } = nameOf(id);
                  return (
                    <SortableRightChip
                      key={id}
                      id={id}
                      icon={icon}
                      label={label}
                      onClick={() => {
                        if (justDragged.current) return;
                        setHidden(id, true);
                      }}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
            {/* The context ring is never hideable: it is the warning that you are about
                to be truncated. The REAL component with demo numbers — pointer-events
                off so the preview can't open its usage popover. */}
            <span className="cvset-ring" style={{ pointerEvents: "none" }}>
              <ContextRing
                ctx={{ pct: 42, used: "84k", max: "200k" }}
                plan={null}
                usage={null}
                usageLoading={false}
                usageError={null}
                usageUpdatedAt={null}
                usageBackend="claude"
              />
            </span>
          </div>
        </div>

        <div className={styles.thint} style={{ marginTop: 10 }}>
          Hidden
          {hiddenItems.length === 0 ? (
            <span className="cvset-none"> — nothing hidden</span>
          ) : null}
        </div>
        {hiddenItems.length > 0 ? (
          <div className="cvset-tray">
            {hiddenItems.map((it) => {
              // Restoring costs slots too. Without this check the cap could be walked
              // around: hide chips, spend the freed slots on buttons, then bring the
              // chips back.
              const room = canUnhide(it.id, hiddenSet, visibleCustomCount);
              return (
                <button
                  key={it.id}
                  type="button"
                  className="wf-chip cvset-ghost"
                  aria-disabled={room ? undefined : true}
                  title={
                    room
                      ? `Show "${it.label}" again`
                      : `No room for "${it.label}" — free ${slotCost(it.id)} slot${slotCost(it.id) > 1 ? "s" : ""} first`
                  }
                  onClick={room ? () => setHidden(it.id, false) : undefined}
                >
                  <Ico name={it.icon} className="sm" />
                  <span className="wf-chip-t">{it.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        {/* The refusal in VISIBLE text: an aria-disabled chip's tooltip is easy to miss,
            and a control that silently declines to come back is the worst of both. */}
        {hiddenItems.some((it) => !canUnhide(it.id, hiddenSet, visibleCustomCount)) ? (
          <div className={styles.thint} style={{ marginTop: 6 }}>
            The bar is full — hide something else or delete a button to bring these back.
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

function PreviewLeftChip({
  chip,
  compact,
  onToggle,
}: {
  chip: ChipDescriptor;
  compact: boolean;
  onToggle: () => void;
}) {
  return (
    <span className="cv-chipslot" data-compact={compact ? "" : undefined}>
      {chipFace(chip.id, {
        onClick: onToggle,
        title: `${chip.label} — click to show ${compact ? "its name too" : "the icon only"}`,
      })}
    </span>
  );
}

function SortableRightChip({
  id,
  icon,
  label,
  onClick,
}: {
  id: string;
  icon: string;
  label: string;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  // The chip's own face, wrapped so dnd-kit can drive it — the wrapper carries the drag
  // listeners and the transform, the face inside is byte-for-byte the live one.
  return (
    <span
      ref={setNodeRef}
      className="cvset-drag"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      title={`${label} — drag to reorder, click to hide`}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      {chipFace(id, { icon, tabIndex: -1 })}
    </span>
  );
}

/**
 * The face of one control, with demo values — the SAME component the live bar renders,
 * so the preview can't drift from it. Anything not in the table (a custom button) falls
 * back to the icon-only custom face.
 */
function chipFace(id: string, props: { icon?: string } & Record<string, unknown>) {
  const { icon, ...rest } = props;
  const cleanOutputDefault = useDisplay.getState().cleanOutput;
  switch (id) {
    case "model":
      return <ModelFace backend="claude" modelId={DEFAULT_MODEL} {...rest} />;
    case "effort":
      return <EffortFace level={DEFAULT_EFFORT as EffortLevel} lit {...rest} />;
    case "permission":
      return (
        <PermissionFace
          mode={DEFAULT_PERMISSION_MODE}
          label={PERMISSION_LABELS[DEFAULT_PERMISSION_MODE] ?? "Default"}
          {...rest}
        />
      );
    case "codexSafety":
      return <CodexSafetyFace preset={DEFAULT_CODEX_PRESET} {...rest} />;
    case "codexSpeed":
      return <CodexSpeedFace name="Speed" {...rest} />;
    case "codexOptions":
      return <CodexOptionsFace {...rest} />;
    case "artifacts":
      return <ArtifactsFace count={2} {...rest} />;
    case "extensions":
      return <ExtensionsFace {...rest} />;
    case "cleanOutput":
      // The actual global default, so the preview matches a fresh conversation.
      return <CleanOutputFace on={cleanOutputDefault} {...rest} />;
    case "remoteControl":
      return <RemoteFace {...rest} />;
    case "goal":
      return <GoalFace {...rest} />;
    case "worktree":
      return <WorktreeFace checked={false} {...rest} />;
    default:
      return <CustomFace icon={icon ?? "spark"} {...rest} />;
  }
}

// ---- Left-hand display modes ---------------------------------------------------------

function LeftControls() {
  const compactLeft = useComposerBar((s) => s.compactLeft);
  const setLeftCompact = useComposerBar((s) => s.setLeftCompact);
  return (
    <SettingsGroup title="Left-hand controls" icon="cog">
      {LEFT_CHIPS.map((c) => (
        <ToggleRow
          key={c.id}
          title={c.label}
          hint={
            <>
              {c.backend !== "both" ? <b>{c.backend === "codex" ? "Codex only" : "Claude only"}. </b> : null}
              {c.condition ? c.condition + ". " : null}
              Icon only — hide the name, keep the button.
            </>
          }
          checked={compactLeft[c.id] === true}
          onChange={(v) => setLeftCompact(c.id, v)}
          label={`${c.label} icon only`}
        />
      ))}
    </SettingsGroup>
  );
}

// ---- Custom buttons ------------------------------------------------------------------

function CustomButtons() {
  const customs = useComposerBar((s) => s.customs);
  const hidden = useComposerBar((s) => s.hidden);
  const addCustom = useComposerBar((s) => s.addCustom);
  const updateCustom = useComposerBar((s) => s.updateCustom);
  const removeCustom = useComposerBar((s) => s.removeCustom);
  const [editing, setEditing] = useState<CustomButton | null>(null);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleCustoms = customs.filter((c) => !hiddenSet.has(c.id)).length;
  const free = remainingSlots(hiddenSet, visibleCustoms);
  const full = free <= 0;

  const describe = (b: CustomButton): string => {
    const desc = actionById(b.action);
    if (!desc) return "Unknown action";
    if (desc.arg === "config") {
      const summary = configSummary(parseConfigArg(b.arg), (m) => PERMISSION_LABELS[m] ?? String(m));
      return summary ? `${desc.label} — ${summary}` : desc.label;
    }
    if (desc.arg === "command") return `${desc.label} — /${(b.arg ?? "").replace(/^\//, "")}`;
    if (desc.arg === "text") {
      const t = (b.arg ?? "").trim().replace(/\s+/g, " ");
      return `${desc.label} — "${t.length > 40 ? t.slice(0, 40) + "…" : t}"`;
    }
    return desc.label;
  };

  return (
    <>
      <SettingsGroup title="Your buttons" icon="wand">
        {customs.length === 0 ? (
          <div className={styles.trow}>
            <div className={styles.ttext}>
              <div className={styles.ttitle}>No buttons yet</div>
              <div className={styles.thint}>
                A button is an icon plus one action — send a prompt you type often, run one of
                this repository's commands, or switch to a saved model / effort / permission
                configuration in a single click.
              </div>
            </div>
          </div>
        ) : (
          customs.map((b) => (
            <ToggleRow
              key={b.id}
              title={b.label || "Untitled button"}
              hint={describe(b)}
              control={
                <span className="cvset-rowbtns">
                  <span className="cvset-rowico">
                    <Ico name={b.icon} className="sm" />
                  </span>
                  <button type="button" className="wf-btn sm" onClick={() => setEditing(b)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="wf-btn sm"
                    onClick={() => removeCustom(b.id)}
                    title={`Delete "${b.label || "this button"}"`}
                  >
                    <Ico name="trash" className="sm" />
                  </button>
                </span>
              }
            />
          ))
        )}
        <div className={styles.trow}>
          <div className={styles.ttext}>
            <div className={styles.ttitle}>Add a button</div>
            {/* The refusal has to be VISIBLE: the button below is inert when the bar is
                full, and a tooltip on a disabled control never renders. */}
            <div className={styles.thint}>
              {full
                ? `The bar is full (${SLOT_CAPACITY} slots). Hide a control above to make room.`
                : `${free} slot${free > 1 ? "s" : ""} free.`}
            </div>
          </div>
          <button
            type="button"
            className="wf-btn sm"
            aria-disabled={full || undefined}
            onClick={
              full
                ? undefined
                : () =>
                    setEditing({ id: newButtonId(), icon: "spark", label: "", action: "insert-text", arg: "" })
            }
          >
            New button
          </button>
        </div>
      </SettingsGroup>

      {editing ? (
        <CustomButtonEditor
          button={editing}
          existing={customs.some((c) => c.id === editing.id)}
          onCancel={() => setEditing(null)}
          onSave={(b) => {
            if (customs.some((c) => c.id === b.id)) updateCustom(b.id, b);
            else addCustom(b);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

// ---- Reset ---------------------------------------------------------------------------

function ResetBar() {
  const reset = useComposerBar((s) => s.reset);
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsGroup title="Reset" icon="restart">
      <ToggleRow
        title="Reset the bar"
        hint="Back to the shipped arrangement. Your custom buttons are deleted."
        control={
          <button type="button" className="wf-btn sm" onClick={() => setConfirming(true)}>
            Reset
          </button>
        }
      />
      <ConfirmDialog
        open={confirming}
        title="Reset the composer bar?"
        confirmLabel="Reset"
        danger
        onConfirm={() => {
          reset();
          setConfirming(false);
        }}
        onCancel={() => setConfirming(false)}
      >
        Every display mode, the arrangement and all your custom buttons go back to the
        defaults. This can't be undone.
      </ConfirmDialog>
    </SettingsGroup>
  );
}
