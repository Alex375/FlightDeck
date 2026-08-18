// Settings → Models: which models the composer's picker offers, in which order, and
// what a new conversation starts on.
//
// Two lists, one drag context. The top list is the picker, in picker order; the bottom
// one is everything else the installed binaries know, greyed out. A model moves between
// them by its checkbox OR by being dragged across — the same gesture either way, because
// the two lists are one sortable space rather than a list and a menu.
//
// The catalogue is deliberately larger than what ships visible: every Claude model in
// the CLI's own registry (down to the ones with no reasoning-effort control at all) and
// every Codex model the binary reports. Old models are kept out of the way, not out of
// reach — see FACTORY_HIDDEN_MODELS.
import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Ico } from "../../ui/kit";
import { PageHead, SettingsGroup } from "./SettingsKit";
import {
  CLAUDE_MODELS,
  visibleModels,
  type ModelOption,
} from "../conversation/models";
import { useCodexModels } from "../conversation/codexModels";
import { useCodexAvailable } from "../../store/binaryAvailable";
import { effortLevelsForModel, type EffortLevel } from "../conversation/EffortGauge";
import { EFFORT_LABELS } from "../../agent/subagentMeta";
import { useModelPrefs } from "../../store/modelPrefs";
import type { BackendKind } from "../../store/conversationsStore";
import styles from "./SettingsPanel.module.css";
import "./models-section.css";

/** Where a row currently lives. Also the droppable ids, so an empty list still accepts a
 *  drop (dropping onto a row would be impossible when there are none). */
type LaneId = "shown" | "available";

export function ModelsSection() {
  return (
    <div>
      <PageHead
        title="Models"
        subtitle="Choose which models the picker offers and what a new conversation starts on."
      />
      <ModelLists />
      <Defaults />
    </div>
  );
}

// ---- The two lists -------------------------------------------------------------------

function ModelLists() {
  const codexAvailable = useCodexAvailable();
  const { models: codexModels } = useCodexModels(codexAvailable);
  const hidden = useModelPrefs((s) => s.hidden);
  const order = useModelPrefs((s) => s.order);
  const setHidden = useModelPrefs((s) => s.setHidden);
  const setOrder = useModelPrefs((s) => s.setOrder);
  const reset = useModelPrefs((s) => s.reset);
  const [dragging, setDragging] = useState<string | null>(null);

  // Codex rows only when the binary is there: offering models that can't be reached
  // would be the same lie as a picker section for a backend you haven't installed.
  const catalogue = useMemo(
    () => [...CLAUDE_MODELS, ...(codexAvailable ? codexModels : [])],
    [codexAvailable, codexModels],
  );
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const shown = useMemo(() => visibleModels(catalogue, hiddenSet, order), [catalogue, hiddenSet, order]);
  const available = useMemo(
    () => catalogue.filter((m) => hiddenSet.has(m.value)),
    [catalogue, hiddenSet],
  );

  // A pointer drag ends in a click; swallow that one so dropping a row never also
  // toggles the checkbox underneath it.
  const justDragged = useRef(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const laneOf = (id: string): LaneId => (hiddenSet.has(id) ? "available" : "shown");

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    const { active, over } = e;
    if (!over) return;
    const id = String(active.id);
    const overId = String(over.id);
    // Dropped on a lane header/empty area → that lane. Dropped on a row → the row's lane,
    // and the row is also the insertion point.
    const target: LaneId = overId === "shown" || overId === "available" ? overId : laneOf(overId);
    const from = laneOf(id);

    if (target === "available") {
      if (from === "shown") setHidden(id, true);
      return;
    }
    // Landing in the shown list: unhide first (if it came from below), then write the
    // order this list will have — the pref stores the ORDER OF ALL SHOWN MODELS, so it
    // has to be computed from the post-move list, not patched.
    const next = shown.map((m) => m.value).filter((v) => v !== id);
    const at = overId === "shown" ? next.length : next.indexOf(overId);
    next.splice(at < 0 ? next.length : at, 0, id);
    if (from === "available") setHidden(id, false);
    setOrder(next);
  };

  const toggle = (value: string, show: boolean) => {
    if (justDragged.current) return;
    setHidden(value, !show);
    // Showing a model from the bottom list puts it at the end of the picker rather than
    // wherever its catalogue rank falls — it lands where the user just saw it appear.
    if (show) setOrder([...shown.map((m) => m.value), value]);
  };

  const draggedModel = dragging ? catalogue.find((m) => m.value === dragging) : null;

  return (
    <SettingsGroup title="The picker" icon="chat">
      <div className={styles.trow} style={{ display: "block" }}>
        <div className={styles.ttext} style={{ marginBottom: 10 }}>
          <div className={styles.ttitle}>Shown and available</div>
          <div className={styles.thint}>
            The top list is the model picker, in its order. Tick a model off to send it down,
            or <strong>drag</strong> it between the lists. Older models are listed because the
            CLI still knows them — your plan may refuse the oldest ones.
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id))}
          onDragCancel={() => setDragging(null)}
          onDragEnd={onDragEnd}
        >
          <Lane
            id="shown"
            title="Shown in the picker"
            empty="No model shown — the picker would be empty. Bring at least one back."
            models={shown}
            onToggle={toggle}
          />
          <Lane
            id="available"
            title="Available"
            empty="Nothing hidden — every model the binaries know is in the picker."
            models={available}
            onToggle={toggle}
          />
          <DragOverlay>
            {draggedModel ? <Row model={draggedModel} shown lane="shown" overlay /> : null}
          </DragOverlay>
        </DndContext>

        <div className={styles.thint} style={{ marginTop: 10 }}>
          <button type="button" className="mdset-reset" onClick={() => reset()}>
            Reset to defaults
          </button>
        </div>
      </div>
    </SettingsGroup>
  );
}

function Lane({
  id,
  title,
  empty,
  models,
  onToggle,
}: {
  id: LaneId;
  title: string;
  empty: string;
  models: ModelOption[];
  onToggle: (value: string, show: boolean) => void;
}) {
  // The lane itself is a drop target so a row can be moved into an EMPTY list, and so
  // dropping below the last row still lands in the right lane.
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div className="mdset-lane" data-lane={id} data-over={isOver ? "" : undefined} ref={setNodeRef}>
      <div className="mdset-lane-head">
        {title}
        <span className="mdset-count">{models.length}</span>
      </div>
      <SortableContext items={models.map((m) => m.value)} strategy={verticalListSortingStrategy}>
        {models.length === 0 ? (
          <div className="mdset-empty">{empty}</div>
        ) : (
          models.map((m) => (
            <Row key={m.value} model={m} shown={id === "shown"} lane={id} onToggle={onToggle} />
          ))
        )}
      </SortableContext>
    </div>
  );
}

function Row({
  model,
  shown,
  lane,
  onToggle,
  overlay,
}: {
  model: ModelOption;
  shown: boolean;
  lane: LaneId;
  onToggle?: (value: string, show: boolean) => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: model.value,
    data: { lane },
    disabled: overlay,
  });
  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      className="mdset-row"
      data-off={shown ? undefined : ""}
      data-overlay={overlay ? "" : undefined}
      style={
        overlay
          ? undefined
          : { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
      }
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
    >
      {/* A span, not an <input>: the row is the drag surface, and a real checkbox would
          fight the pointer sensor for the gesture. Still a checkbox to assistive tech. */}
      <span
        className="mdset-check"
        role="checkbox"
        aria-checked={shown}
        aria-label={`${model.label} in the picker`}
        tabIndex={0}
        onClick={() => onToggle?.(model.value, !shown)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onToggle?.(model.value, !shown);
          }
        }}
      >
        {shown ? <Ico name="check" className="sm" /> : null}
      </span>
      <span className="mdset-name">{model.label}</span>
      <span className="mdset-prov">{model.provider ?? (model.backend === "codex" ? "OpenAI" : "Anthropic")}</span>
      <span className="mdset-id">{model.value}</span>
      <span className="mdset-eff">{effortSummary(model.value)}</span>
    </div>
  );
}

/** One-glance effort range: the surprising fact here is that the older models have NO
 *  reasoning-effort control, which is worth seeing before picking one as a default. */
function effortSummary(value: string): string {
  const levels = effortLevelsForModel(value);
  if (levels.length === 0) return "no effort";
  const first = EFFORT_LABELS[levels[0] as keyof typeof EFFORT_LABELS] ?? levels[0];
  const last = EFFORT_LABELS[levels[levels.length - 1] as keyof typeof EFFORT_LABELS] ?? levels[levels.length - 1];
  return `${first} → ${last}`;
}

// ---- Defaults ------------------------------------------------------------------------

/** Model + effort a NEW conversation starts on, per backend — the two can't be merged
 *  into one setting: a Claude alias is rejected by the Codex binary and vice versa, and
 *  the backend is chosen when the conversation is created, not by this screen. */
function Defaults() {
  const codexAvailable = useCodexAvailable();
  const { models: codexModels } = useCodexModels(codexAvailable);
  const hidden = useModelPrefs((s) => s.hidden);
  const order = useModelPrefs((s) => s.order);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  return (
    <SettingsGroup title="New conversations" icon="spark">
      <BackendDefault
        backend="claude"
        label="Claude"
        models={visibleModels(CLAUDE_MODELS, hiddenSet, order)}
      />
      {codexAvailable ? (
        <BackendDefault
          backend="codex"
          label="Codex"
          models={visibleModels(codexModels, hiddenSet, order)}
        />
      ) : null}
    </SettingsGroup>
  );
}

function BackendDefault({
  backend,
  label,
  models,
}: {
  backend: BackendKind;
  label: string;
  models: ModelOption[];
}) {
  const model = useModelPrefs((s) => (backend === "codex" ? s.codexModel : s.claudeModel));
  const effort = useModelPrefs((s) => (backend === "codex" ? s.codexEffort : s.claudeEffort));
  const setDefaultModel = useModelPrefs((s) => s.setDefaultModel);
  const setDefaultEffort = useModelPrefs((s) => s.setDefaultEffort);
  const efforts = effortLevelsForModel(model);
  return (
    <div className={styles.trow}>
      <div className={styles.ttext}>
        <div className={styles.ttitle}>{label}</div>
        <div className={styles.thint}>
          The model and thinking effort every new {label} conversation starts on. Each
          conversation can still change both from its composer.
        </div>
      </div>
      <div className="mdset-defaults">
        <select
          className="mdset-select"
          value={model}
          aria-label={`Default ${label} model`}
          onChange={(e) => setDefaultModel(backend, e.target.value)}
        >
          {/* A default hidden from the picker still has to show its own name here, or the
              select would silently display the first row instead of the truth. */}
          {models.some((m) => m.value === model) ? null : <option value={model}>{model}</option>}
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {efforts.length === 0 ? (
          <span className="mdset-noeffort">no effort control</span>
        ) : (
          <select
            className="mdset-select"
            value={effort}
            aria-label={`Default ${label} effort`}
            onChange={(e) => setDefaultEffort(backend, e.target.value as EffortLevel)}
          >
            {efforts.map((lv) => (
              <option key={lv} value={lv}>
                {EFFORT_LABELS[lv as keyof typeof EFFORT_LABELS] ?? lv}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
