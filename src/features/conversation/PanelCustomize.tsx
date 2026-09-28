// The side panel's CUSTOMIZE view — where the user chooses what the panel shows, in what order,
// and whether its sections fold. It replaces the panel's body while it is open (the header's
// « Customize » / « Done »), so the choice is made at the panel's real width, next to the
// conversation it will sit beside.
//
// Everything applies AS YOU GO — there is no draft to save or lose: a switch flipped here is the
// layout. « Done » only closes the view.
//
// One card per widget: its mark, its name, what it shows, a switch. The WHOLE card is the drag
// surface (the app's reorder convention: no grip), and a plain click on it flips the switch —
// the card is a big target and the switch a precise one. Sections and bottom rows are two lists:
// a widget never changes zone (a footer row and a section are drawn differently).

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { createPortal } from "react-dom";
import { Ico } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";
import { motionAllowed } from "../../ui/motion";
import { useDisplay } from "../../store/display";
import { armReorderGuard, disarmReorderGuardSoon, guardReorderClick } from "../../ui/orderDnd";
import { useSidePanelLayout } from "../../store/sidePanelWidgetsStore";
import {
  matchingPreset,
  PANEL_PRESETS,
  widgetDef,
  type LayoutEntry,
  type WidgetId,
} from "./sidePanelWidgets";
import c from "./PanelCustomize.module.css";

export function PanelCustomize() {
  const layout = useSidePanelLayout((st) => st.layout);
  const applyPreset = useSidePanelLayout((st) => st.applyPreset);
  const setCollapsible = useSidePanelLayout((st) => st.setCollapsible);
  const reset = useSidePanelLayout((st) => st.reset);
  const active = matchingPreset(layout);
  const shown = [...layout.main, ...layout.foot].filter((e) => e.on).length;
  const total = layout.main.length + layout.foot.length;
  // The panel's own animation switch (Settings → Motion) — and the OS "reduce motion" — decide
  // whether anything here moves; the stylesheet keys every movement off this attribute.
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));

  return (
    <div className={c.root} data-motion={motion || undefined}>
      <p className={c.intro}>
        Choose what this panel shows. Drag a card to reorder it — changes apply right away.
      </p>

      <div className={c.presets} role="radiogroup" aria-label="Presets">
        {/* One highlight that SLIDES to the preset the layout matches (and fades when it
            matches none): the movement says "this is where you are now". */}
        <span
          className={c.presetThumb}
          aria-hidden="true"
          data-shown={active ? true : undefined}
          style={{ ["--i" as string]: Math.max(0, PANEL_PRESETS.findIndex((p) => p.id === active?.id)) }}
        />
        {PANEL_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={active?.id === p.id}
            className={c.preset}
            data-active={active?.id === p.id || undefined}
            onClick={() => applyPreset(p)}
            title={p.blurb}
          >
            {p.label}
          </button>
        ))}
      </div>

      <WidgetList
        zone="main"
        title="Sections"
        hint={`${layout.main.filter((e) => e.on).length} of ${layout.main.length} shown`}
        entries={layout.main}
      />
      <WidgetList
        zone="foot"
        title="Pinned at the bottom"
        hint={`${layout.foot.filter((e) => e.on).length} of ${layout.foot.length} shown`}
        entries={layout.foot}
      />

      <div className={c.options}>
        <div className={c.option}>
          <span className={c.optionText}>
            <span className={c.optionTitle}>Collapsible sections</span>
            <span className={c.optionHint}>Click a section's header to fold it to one line.</span>
          </span>
          <Toggle
            checked={layout.collapsible}
            onChange={setCollapsible}
            label="Collapsible sections"
          />
        </div>
      </div>

      <div className={c.foot}>
        <span className={`${c.count} wf-mono`}>
          {shown}/{total} widgets
        </span>
        <button type="button" className={c.reset} onClick={reset} title="Default widgets, order and folds">
          <Ico name="restart" className="sm" />
          Reset
        </button>
      </div>
    </div>
  );
}

function WidgetList({
  zone,
  title,
  hint,
  entries,
}: {
  zone: "main" | "foot";
  title: string;
  hint: string;
  entries: LayoutEntry[];
}) {
  const move = useSidePanelLayout((st) => st.move);
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  const sensors = useSensors(
    // Same threshold as the sidebar and the Flight Deck: a click stays a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // ⚠️ The click guard must be armed HERE: a drop ends with a click on the card, and a click
  // on the card flips its switch — without the latch every reorder would also hide or show the
  // widget it moved.
  const onStart = (e: DragStartEvent) => {
    armReorderGuard();
    setDragging(e.active.id as WidgetId);
  };
  const onEnd = (e: DragEndEvent) => {
    setDragging(null);
    disarmReorderGuardSoon();
    if (e.over && e.active.id !== e.over.id) move(e.active.id as WidgetId, e.over.id as WidgetId);
  };
  const onCancel = () => {
    setDragging(null);
    disarmReorderGuardSoon();
  };
  const activeEntry = dragging ? entries.find((e) => e.id === dragging) : undefined;

  return (
    <section className={c.group} data-zone={zone}>
      <div className={c.groupHead}>
        <span className={c.groupTitle}>{title}</span>
        <span className={c.groupHint}>{hint}</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragStart={onStart}
        onDragEnd={onEnd}
        onDragCancel={onCancel}
      >
        <SortableContext items={entries.map((e) => e.id)} strategy={verticalListSortingStrategy}>
          <div className={c.list}>
            {entries.map((e) => (
              <SortableCard key={e.id} entry={e} />
            ))}
          </div>
        </SortableContext>
        {/* The lifted copy follows the pointer above everything (portalled: the panel clips). */}
        {createPortal(
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }}>
            {activeEntry ? <CardFace entry={activeEntry} lifted /> : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </section>
  );
}

function SortableCard({ entry }: { entry: LayoutEntry }) {
  const setOn = useSidePanelLayout((st) => st.setOn);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
  });
  return (
    <div
      ref={setNodeRef}
      className={c.slot}
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      aria-roledescription="sortable widget"
      onClickCapture={guardReorderClick}
      onClick={(e) => {
        // The switch flips itself; a click anywhere else on the card flips it too.
        if ((e.target as HTMLElement).closest("[role='switch']")) return;
        setOn(entry.id, !entry.on);
      }}
    >
      <CardFace entry={entry} onToggle={(on) => setOn(entry.id, on)} />
    </div>
  );
}

function CardFace({
  entry,
  onToggle,
  lifted,
}: {
  entry: LayoutEntry;
  onToggle?: (on: boolean) => void;
  lifted?: boolean;
}) {
  const def = widgetDef(entry.id);
  return (
    <div className={c.card} data-on={entry.on || undefined} data-lifted={lifted || undefined} data-widget={def.id}>
      <span className={c.tile} aria-hidden="true">
        <Ico name={def.icon} className="sm" />
      </span>
      <span className={c.main}>
        <span className={c.title}>{def.title}</span>
        <span className={c.blurb}>{def.blurb}</span>
      </span>
      <Toggle
        checked={entry.on}
        onChange={(on) => onToggle?.(on)}
        label={`Show ${def.title}`}
      />
    </div>
  );
}
