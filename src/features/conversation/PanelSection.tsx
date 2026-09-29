// One section of the conversation side panel — the island every widget sits in: a header (icon,
// title, a reading in a capsule, an action) over a body that FOLDS when the user clicks the
// header (the `collapsible` layout switch, on by default).
//
// Folding is a height animation on a grid row (0fr ↔ 1fr), which follows the content's real
// height without measuring it. The body stays mounted only for the length of the fold, then goes:
// a folded section costs nothing but its header — the reason a widget can afford to keep its
// reading in the header (a todo count, a percentage) and still be folded all day.

import { useEffect, useState, type ReactNode } from "react";
import { Ico } from "../../ui/kit";
import { motionAllowed } from "../../ui/motion";
import { useDisplay } from "../../store/display";
import { useSidePanelLayout } from "../../store/sidePanelWidgetsStore";
import { isCollapsed, type WidgetId } from "./sidePanelWidgets";
import s from "./ConversationSidePanel.module.css";

/** The fold's length — ⚠️ the CSS transition on `.fold` (ConversationSidePanel.module.css) must
 *  match: the failsafe below lands the fold this long after it starts, whatever the browser did. */
const FOLD_MS = 220;

/** Where a fold is. `opening` / `closing` last one transition, during which the body is mounted
 *  AND clipped — clipping at rest would cut the focus rings and shadows drawn by the rows inside. */
type FoldPhase = "open" | "closing" | "closed" | "opening";

export function PanelSection({
  id,
  icon,
  title,
  meta,
  foldedMeta,
  action,
  children,
  className,
}: {
  id: WidgetId;
  /** The header's leading mark (usually `<Ico className="sm" />`). */
  icon: ReactNode;
  title: ReactNode;
  /** A reading at the end of the header — kept visible when the section is folded. */
  meta?: ReactNode;
  /** A reading shown in the header ONLY while the section is folded — for what the body already
   *  shows when open (the task's status chip), so it is never on screen twice. */
  foldedMeta?: ReactNode;
  /** The header's action (« Open », « Clear »…). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const collapsible = useSidePanelLayout((st) => st.layout.collapsible);
  const collapsed = useSidePanelLayout((st) => isCollapsed(st.layout, id));
  const setCollapsed = useSidePanelLayout((st) => st.setCollapsed);
  const motion = motionAllowed(useDisplay((d) => d.panelAnimations));

  // The body leaves the DOM once folded — but only once the fold has PLAYED, or it would vanish
  // before it could shrink. The phase moves on the edge DURING render (the "adjust state while
  // rendering" pattern: no effect, no frame where the old phase paints), and lands when the
  // height transition ends — or, failing that, after its length: a transition that never runs
  // (a body of zero height, the window hidden mid-fold) must not leave a folded body mounted.
  const [phase, setPhase] = useState<FoldPhase>(collapsed ? "closed" : "open");
  const [seen, setSeen] = useState(collapsed);
  if (seen !== collapsed) {
    setSeen(collapsed);
    setPhase(collapsed ? (motion ? "closing" : "closed") : motion ? "opening" : "open");
  }
  const moving = phase === "closing" || phase === "opening";
  const land = () => setPhase((p) => (p === "closing" ? "closed" : p === "opening" ? "open" : p));
  useEffect(() => {
    if (!moving) return;
    const failsafe = setTimeout(land, FOLD_MS + 120);
    return () => clearTimeout(failsafe);
  }, [moving, phase]);
  const mounted = phase !== "closed";

  const toggle = () => setCollapsed(id, !collapsed);
  const head = (
    <>
      <span className={s.labelIco}>{icon}</span>
      <span className={s.labelTitle}>{title}</span>
    </>
  );

  return (
    <section
      className={`${s.section} ${className ?? ""}`}
      data-collapsed={collapsed || undefined}
      data-motion={motion || undefined}
      data-widget={id}
    >
      <div className={s.label}>
        {collapsible ? (
          <button
            type="button"
            className={s.labelToggle}
            onClick={toggle}
            aria-expanded={!collapsed}
            title={collapsed ? "Show this section" : "Fold this section"}
          >
            {head}
          </button>
        ) : (
          <span className={s.labelStatic}>{head}</span>
        )}
        {meta}
        {collapsed ? foldedMeta : null}
        {action}
        {collapsible ? (
          // A second, smaller target for the same fold — the chevron is where the eye looks for
          // it. Out of the tab order: the title button above is the accessible control.
          <button type="button" className={s.foldBtn} onClick={toggle} aria-hidden="true" tabIndex={-1}>
            <Ico name="chev" className="sm" />
          </button>
        ) : null}
      </div>
      <div
        className={s.fold}
        data-open={!collapsed || undefined}
        data-clip={phase !== "open" || undefined}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && e.propertyName === "grid-template-rows") land();
        }}
      >
        <div className={s.foldInner}>
          {mounted ? <div className={s.foldBody}>{children}</div> : null}
        </div>
      </div>
    </section>
  );
}
