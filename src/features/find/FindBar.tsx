// The find bar every surface shares (conversation thread, markdown preview, terminal, Flight
// Deck, TOSSE board). Purely presentational: the engine behind it (DOM text, xterm buffer) is
// the caller's. It renders INSIDE the zone it searches, pinned to that zone's top-right corner,
// and names the zone on its left ("Conversation", "Terminal"…) — so it is always obvious what
// a search covers. The zone itself is outlined while the bar is open (see find.css).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Ico } from "../../ui/kit";
import { countLabel, type FindOptions } from "./findQuery";
import "./find.css";
import styles from "./FindBar.module.css";

export interface FindScope {
  label: string;
  icon: string;
}

export function FindBar({
  scope,
  focusNonce,
  query,
  onQuery,
  options,
  onOptions,
  count,
  index,
  capped,
  error,
  onNext,
  onPrev,
  onClose,
  extra,
  hint,
}: {
  scope: FindScope;
  /** Bumped each time ⌘F targets this bar: refocus the input and select its text. */
  focusNonce: number;
  query: string;
  onQuery: (q: string) => void;
  options: FindOptions;
  onOptions: (patch: Partial<FindOptions>) => void;
  /** Hits found; -1 = unknown (the engine does not count, e.g. past the terminal's limit). */
  count: number;
  /** 0-based current hit, -1 = none. */
  index: number;
  capped: boolean;
  /** The query is not a valid pattern — shown, never swallowed. */
  error: string | null;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Surface-specific toggles after the three standard ones. */
  extra?: ReactNode;
  /** A line under the bar (e.g. "no visible match — search folded work?"). */
  hint?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fit = useZoneFit(wrapRef);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusNonce]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // One key = one layer: the bar closes, the panel or modal under it stays open.
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g")) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  const hasQuery = query !== "";
  const counter = error
    ? "Invalid"
    : !hasQuery
      ? ""
      : count < 0
        ? index >= 0
          ? `${index + 1} of many`
          : "…"
        : countLabel(index, count, capped);

  return (
    <div ref={wrapRef} className={styles.wrap} data-find-skip="" data-find-bar="" data-fit={fit}>
      <div
        className={styles.bar + (error ? " " + styles.barError : "")}
        role="search"
        // The conversation column turns any background click into "focus the composer"; a click
        // on the bar's own padding must not pull focus out of the find input.
        onClick={(e) => e.stopPropagation()}
      >
        <span className={styles.scope} title={`Searching in: ${scope.label}`}>
          <Ico name={scope.icon} className="sm" />
          <span className={styles.scopeLabel}>{scope.label}</span>
        </span>
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          placeholder="Find"
          spellCheck={false}
          autoComplete="off"
          aria-label={`Find in ${scope.label}`}
          aria-invalid={error ? true : undefined}
          title={error ?? undefined}
          data-find-input=""
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Toggle on={options.matchCase} title="Match case" onClick={() => onOptions({ matchCase: !options.matchCase })}>
          Aa
        </Toggle>
        <Toggle on={options.wholeWord} title="Match whole word" onClick={() => onOptions({ wholeWord: !options.wholeWord })}>
          <span className={styles.word}>ab</span>
        </Toggle>
        <Toggle on={options.isRegex} title="Use regular expression" onClick={() => onOptions({ isRegex: !options.isRegex })}>
          .*
        </Toggle>
        {extra}
        <span
          className={styles.count + (hasQuery && count === 0 && !error ? " " + styles.countNone : "")}
          aria-live="polite"
        >
          {counter}
        </span>
        <button
          type="button"
          className={styles.nav + " " + styles.navUp}
          title="Previous match (⇧↵)"
          aria-label="Previous match"
          disabled={!hasQuery || count === 0 || !!error}
          onClick={onPrev}
        >
          <Ico name="chev" className="sm" />
        </button>
        <button
          type="button"
          className={styles.nav}
          title="Next match (↵)"
          aria-label="Next match"
          disabled={!hasQuery || count === 0 || !!error}
          onClick={onNext}
        >
          <Ico name="chev" className="sm" />
        </button>
        <button type="button" className={styles.nav} title="Close (Esc)" aria-label="Close find" onClick={onClose}>
          <Ico name="x" className="sm" />
        </button>
      </div>
      {error ? <div className={styles.hint + " " + styles.hintError}>{error}</div> : hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}

/**
 * How much of the bar fits in its zone: "full", "compact" (the zone's name shrinks to its icon)
 * or "tiny" (the toggles go too — the zone is a narrow column, its find must still work).
 * Measured on the ZONE (the bar's positioned parent), live: panels are resized all the time.
 */
function useZoneFit(wrapRef: RefObject<HTMLDivElement | null>): "full" | "compact" | "tiny" {
  const [fit, setFit] = useState<"full" | "compact" | "tiny">("full");
  useEffect(() => {
    const zone = wrapRef.current?.parentElement;
    if (!zone) return;
    const measure = () => {
      const w = zone.clientWidth;
      setFit(w < 340 ? "tiny" : w < 480 ? "compact" : "full");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(zone);
    return () => ro.disconnect();
  }, [wrapRef]);
  return fit;
}

export function Toggle({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.toggle + (on ? " " + styles.toggleOn : "")}
      title={title}
      aria-label={title}
      aria-pressed={on}
      // Keep the caret in the input: a toggle is a modifier of what is being typed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
