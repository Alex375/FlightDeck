// Shared building blocks for the Settings panel — the page heading, the titled
// "group card", and a toggle row inside it. Every tab composes these so the whole
// panel stays visually consistent (see SettingsPanel.module.css). All three import
// the SAME CSS module as SettingsPanel.tsx, so the hashed class names line up.
import { useEffect, useRef, type ReactNode } from "react";
import { Ico } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";
import { useSettingsUi } from "../../store/settingsUi";
import styles from "./SettingsPanel.module.css";

/** The heading at the top of a settings tab: a bold title + a muted one-liner. */
export function PageHead({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className={styles.pageHead}>
      <div className={styles.pageTitle}>{title}</div>
      {subtitle ? <div className={styles.pageSub}>{subtitle}</div> : null}
    </div>
  );
}

/**
 * A pill row that splits ONE settings tab into sub-pages. Tabs that grew a long
 * stack of unrelated cards (MCP Control: in-app agents, the voice agent, remote
 * access, the bridge…) show one group at a time behind this instead of asking the
 * user to scroll past everything else.
 *
 * The active sub-tab lives in the shared settings store (per section), so a
 * search result can land straight on the right sub-page.
 */
export function SubTabs<T extends string>({
  tabs,
  active,
  onSelect,
  ariaLabel,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; icon?: string }>;
  active: T;
  onSelect: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className={styles.subTabs} role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={styles.subTab}
          data-on={active === t.id ? "" : undefined}
          onClick={() => onSelect(t.id)}
        >
          {t.icon ? <Ico name={t.icon} className="sm" /> : null}
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Scroll to and flash the element when the settings search asked for THIS title.
 * The match is on the visible title, deliberately: it keeps every existing row
 * untouched (no ids to thread) at the cost of a rename silently un-matching —
 * which degrades to "the search still lands you on the right tab", never to a
 * wrong jump. The highlight is cleared once it has flashed so it can't re-fire.
 */
function useSearchHighlight<T extends HTMLElement>(title: string) {
  const ref = useRef<T | null>(null);
  const hit = useSettingsUi(
    (s) => s.highlight !== null && s.highlight.toLowerCase() === title.toLowerCase(),
  );
  useEffect(() => {
    if (!hit) return;
    ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(() => useSettingsUi.getState().clearHighlight(), 1600);
    return () => clearTimeout(timer);
  }, [hit]);
  return { ref, hit };
}

/** A titled card grouping related settings. `icon` is a kit glyph name shown in coral
 *  next to the (uppercase) group title; the children are the rows inside the card. */
export function SettingsGroup({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: string;
  children: ReactNode;
}) {
  const { ref, hit } = useSearchHighlight<HTMLElement>(title);
  return (
    <section className={styles.group} ref={ref} data-hit={hit ? "" : undefined}>
      <div className={styles.groupHead}>
        {icon ? (
          <span className={styles.groupIco}>
            <Ico name={icon} className="sm" />
          </span>
        ) : null}
        <span className={styles.groupTitle}>{title}</span>
      </div>
      <div className={styles.card}>{children}</div>
    </section>
  );
}

/** A single row inside a {@link SettingsGroup} card: a title + optional hint on the
 *  left, and a control on the right — a {@link Toggle} by default, or `control` for a
 *  custom right-hand element. `action` places an extra element just left of the toggle
 *  (e.g. a "Tester" button). `disabled` greys out the default toggle for a setting the app
 *  genuinely cannot change right now.
 *
 *  ⚠️ The reason MUST go in the visible `hint`, never in a tooltip: a disabled control takes no
 *  pointer events, so its `title` never shows — an explanation put there would be invisible
 *  exactly when it is needed. A disabled row that doesn't say why is just a refusal. */
export function ToggleRow({
  title,
  hint,
  checked,
  onChange,
  label,
  action,
  control,
  disabled,
}: {
  title: string;
  hint?: ReactNode;
  checked?: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  action?: ReactNode;
  control?: ReactNode;
  disabled?: boolean;
}) {
  const { ref, hit } = useSearchHighlight<HTMLDivElement>(title);
  return (
    <div className={styles.trow} ref={ref} data-hit={hit ? "" : undefined}>
      <div className={styles.ttext}>
        <div className={styles.ttitle}>{title}</div>
        {hint ? <div className={styles.thint}>{hint}</div> : null}
      </div>
      {action}
      {/* Render the default Toggle only when the row actually IS a toggle (it
          passes `checked`/`onChange`). A purely informational row — no control,
          no toggle props — renders nothing on the right, instead of a dead
          OFF toggle that swallows clicks and looks like a broken setting. */}
      {control ??
        (checked !== undefined || onChange !== undefined ? (
          <Toggle
            checked={!!checked}
            onChange={onChange ?? (() => {})}
            label={label ?? title}
            disabled={disabled}
          />
        ) : null)}
    </div>
  );
}

/** The version line shown by BOTH updaters (the app and the piloted `claude` binary), so the
 *  two cards read as one system: the installed version as a mono pill, an arrow to the new one
 *  when an update is waiting, a state dot + label, and an optional muted detail (install method,
 *  channel…). `state` drives the dot's colour: `current` green, `available` accent, `unknown`
 *  muted (version couldn't be read — never dressed up as "up to date"). */
export function VersionStatus({
  installed,
  latest,
  state,
  detail,
}: {
  installed: string | null;
  latest?: string | null;
  state: "current" | "available" | "unknown";
  detail?: ReactNode;
}) {
  const label =
    state === "available" ? "Update available" : state === "current" ? "Up to date" : "Unknown";
  return (
    <span className={styles.verLine}>
      {installed ? (
        <span className={styles.verPill}>v{installed}</span>
      ) : (
        <span className={styles.verPill}>—</span>
      )}
      {state === "available" && latest ? (
        <>
          <Ico name="arrow" className="sm" />
          <span className={`${styles.verPill} ${styles.verPillNew}`}>v{latest}</span>
        </>
      ) : null}
      <span className={styles.verState}>
        <span className={styles.verDot} data-state={state} />
        {label}
      </span>
      {detail ? <span className={styles.verDetail}>· {detail}</span> : null}
    </span>
  );
}

/** A "pick one" rail of selectable option cards — each shows a label, a description, and a
 *  check when selected. Shared by the settings tabs that offer a small enumerated choice
 *  (Markdown rendering mode, Caffeinate mode…) so the pattern lives in ONE place. Pass
 *  `className` to override the rail layout (e.g. a fixed-width sticky column). */
export function OptionCardRail<T extends string>({
  options,
  selected,
  onSelect,
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<{ id: T; label: string; desc: string }>;
  selected: T;
  onSelect: (id: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={styles.modeRail + (className ? " " + className : "")}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={styles.opt}
          aria-pressed={selected === o.id}
          data-on={selected === o.id ? "" : undefined}
          onClick={() => onSelect(o.id)}
        >
          <span className={styles.optTop}>
            <span className={styles.optName}>{o.label}</span>
            {selected === o.id ? <Ico name="check" className={"sm " + styles.optCheck} /> : null}
          </span>
          <span className={styles.optDesc}>{o.desc}</span>
        </button>
      ))}
    </div>
  );
}
