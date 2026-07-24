// Conductor design-system primitives, ported to typed React from the design
// handoff's wirekit.jsx. Uses the global class-based stylesheet (conductor-wirekit.css).
import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const WF_PATHS: Record<string, string> = {
  chat: "M3 11.5a6.5 6 0 0 1 6.5-6h1A6.5 6 0 0 1 17 11.5 6.5 6 0 0 1 10.5 17H6l-2.5 2v-3.2A6.4 6.4 0 0 1 3 11.5Z",
  grid: "M4 4h6v6H4zM12 4h6v6h-6zM4 12h6v6H4zM12 12h6v6h-6z",
  layers: "M11 3 3 7l8 4 8-4-8-4ZM3 13l8 4 8-4M3 10l8 4 8-4",
  folder: "M3 6a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z",
  branch: "M7 4v9m0 0a2 2 0 1 0 0 .01M7 13a6 6 0 0 0 6-6m0 0a2 2 0 1 0 0-.01M16 7v0",
  play: "M7 5l9 6-9 6V5Z",
  pause: "M8 5v12M14 5v12",
  stop: "M6 6h10v10H6z",
  check: "M4 11l5 5 9-11",
  plus: "M11 4v14M4 11h14",
  search: "M9.5 4a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11ZM14 14l4 4",
  dots: "M5 11h.01M11 11h.01M17 11h.01",
  arrow: "M5 11h12m-5-6 6 6-6 6",
  // A "reply"/return arrow — marks the user's own last message on a Flight Deck card.
  reply: "M9 7 5 11l4 4M5 11h7a4 4 0 0 0 4-4V5",
  bell: "M6 9a5 5 0 0 1 10 0c0 4 2 5 2 5H4s2-1 2-5ZM9 18a2 2 0 0 0 4 0",
  clock: "M11 5a6 6 0 1 1 0 12 6 6 0 0 1 0-12ZM11 8v3l2 2",
  file: "M6 3h6l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM12 3v4h4",
  diff: "M11 4v6m-3-3h6M5 16h12",
  term: "M4 5h14v12H4zM7 9l3 2-3 2M12 13h3",
  send: "M4 11 18 4l-5 14-3-6-6-1Z",
  cog: "M11 8.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM11 3v2M11 17v2M3 11h2M17 11h2M5 5l1.5 1.5M16 16l-1.5-1.5M5 17l1.5-1.5M16 6l-1.5 1.5",
  list: "M7 5h11M7 11h11M7 17h11M3.5 5h.01M3.5 11h.01M3.5 17h.01",
  spark: "M11 3v4M11 15v4M3 11h4M15 11h4M6 6l2.5 2.5M16 16l-2.5-2.5M6 16l2.5-2.5M16 6l-2.5 2.5",
  key: "M13.5 4a4.5 4.5 0 1 0 3.2 7.7L19 14l-1.5 1.5L16 14l-1.5 1.5L13 14l1.3-1.3A4.5 4.5 0 0 0 13.5 4Zm-.5 3.5h.01",
  alert: "M11 4 3 17h16L11 4ZM11 9v4M11 16h.01",
  ask: "M8 8.5a3 3 0 1 1 4.2 2.7c-.8.4-1.2 1-1.2 1.9M11 16h.01",
  gauge: "M4 15a7 7 0 0 1 14 0M11 15l3.5-3.5",
  pulse: "M3 11h4l2-4 3 8 2-5 2 1h3",
  bolt: "M12 3 5 13h5l-1 8 7-10h-5l1-8Z",
  shield: "M11 3 4 6v5c0 4 3 6 7 8 4-2 7-4 7-8V6l-7-3Z",
  commit: "M3 11h5m6 0h5M11 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  pr: "M7 6v9M7 6a2 2 0 1 0-.01 0ZM7 15a2 2 0 1 0 .01 0ZM15 16a2 2 0 1 0 .01 0ZM15 14V9a2 2 0 0 0-2-2h-3l2.5-2.5M9.5 7 12 9.5",
  chev: "M6 9l5 5 5-5",
  refresh: "M4.5 11a6.5 6.5 0 0 1 11-4.7M15.5 3.5v3h-3M17.5 11a6.5 6.5 0 0 1-11 4.7M6.5 18.5v-3h3",
  restart: "M17 11a6 6 0 1 1-2.2-4.6M17 5.5V9.5H13",
  form: "M5 4h12v14H5zM8 8h6M8 11h6M8 14h3",
  diamond: "M11 3 18 11 11 19 4 11Z",
  stopc: "M6 6h10v10H6z",
  trash: "M4 6h14M9 6V4h4v2M6 6l1 12h8l1-12M9.5 9.5v6M12.5 9.5v6",
  x: "M6 6l10 10M16 6 6 16",
  code: "M8 7l-4 4 4 4M14 7l4 4-4 4",
  splith: "M4 5h14v12H4zM11 5v12",
  splitv: "M4 5h14v12H4zM4 11h14",
  sidebar: "M4 5h14v12H4zM9 5v12",
  globe: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM3 11h16M11 3c2.4 2.2 2.4 13.8 0 16M11 3c-2.4 2.2-2.4 13.8 0 16",
  // A magic wand + sparkle — a skill/command invocation.
  wand: "M4 18 13 9M15 3l.9 2.1L18 6l-2.1.9L15 9l-.9-2.1L12 6l2.1-.9z",
  // A document with a sparkle — a published `Artifact` (a generated, hosted deliverable).
  // Distinct from `file` (plain doc), `globe` (remote control) and `layers` (extensions).
  artifact: "M6 3h6l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM12 3v4h4M10 10l1 2 2 1-2 1-1 2-1-2-2-1 2-1z",
  // A plug — an MCP server tool call.
  plug: "M7 3v4M13 3v4M5 7h10v2a5 5 0 0 1-10 0V7ZM10 14v5",
  // File-explorer context-menu glyphs (rename / copy / cut / paste / copy-path / reveal).
  pencil: "M5 17l.7-3.3L14 5l3 3-8.3 8.3L5 17ZM12.5 6.5l3 3",
  copy: "M9 9h7v7H9zM6 13H5V5h8v1",
  scissors: "M7 7l8 8M7 15l8-8M6 5.4a1.7 1.7 0 1 0 0 3.3 1.7 1.7 0 0 0 0-3.3M6 13.3a1.7 1.7 0 1 0 0 3.3 1.7 1.7 0 0 0 0-3.3",
  clipboard: "M9 6H6v11h10V6h-3M9 5h4v2H9z",
  link: "M9 12a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M12 9a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1",
  external: "M8 5H5v12h12v-3M12 5h5v5M17 5l-7 7",
  // Notification-sound toggle: a speaker cone with two "sound" arcs (on) vs. an
  // X where the arcs were (muted).
  volume: "M4 8.5h3l4-3v11l-4-3H4zM14 8.5a4 4 0 0 1 0 5M16.5 6.5a7 7 0 0 1 0 9",
  mute: "M4 8.5h3l4-3v11l-4-3H4zM14.5 9l4 4M18.5 9l-4 4",
  // A steaming coffee mug — the "Caffeinate" (keep the Mac awake) toggle.
  coffee: "M5 9h8v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM13 11h1.5a2 2 0 0 1 0 4H13M8 4c1 1-1 2 0 3.2M11 4c1 1-1 2 0 3.2",
  // A bullseye / target — an active `/goal` (Claude working toward a completion condition).
  target: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M11 7.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4M11 11h.01",
  // Up/down arrows — manual reordering (drag to arrange). The "Reordering" settings tab.
  reorder: "M7 8l3-3 3 3M10 5v6M17 14l-3 3-3-3M14 17v-6",
  // A six-dot drag handle — the affordance shown inside the Flight Deck drag ghost.
  grip: "M8 6h.01M14 6h.01M8 11h.01M14 11h.01M8 16h.01M14 16h.01",
};

export function Ico({ name, className }: { name: string; className?: string }) {
  const d = WF_PATHS[name] || WF_PATHS.dots;
  return (
    <svg className={"wf-ico " + (className || "")} viewBox="0 0 22 22" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** The Claude sunburst mark (the official Anthropic/Claude logo), filled with
 *  `currentColor` so it inherits the surrounding text colour — used for the model
 *  picker chip and Claude's message avatars. Reuses the brand asset already shipped
 *  in the repo (public/file-icons/claude.svg), inlined here for crisp tinting. */
export function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg className={"wf-claude " + (className || "")} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="m14.375 6.48.49.28v.209l-.14.489-5.937 1.397-.558-1.387zm0 0" />
      <path d="m12.155 2.373.683.143.182.224.173.535-.072.342-3.983 5.447L7.81 7.737l3.673-4.82z" />
      <path d="m8.719 1.522.419-.28.349.14.349.49-.957 5.748-.65-.441-.279-.769.49-4.33z" />
      <path d="m4.239 1.614.43-.55L4.95 1l.558.081.275.216 2.004 4.442.724 2.11-.848.471-3.231-5.864z" />
      <path d="m2.154 4.665-.14-.56.42-.488.488.07h.14l2.933 2.165.908.698 1.257.978-.698 1.187-.629-.489-.419-.419-4.05-2.863z" />
      <path d="M1.316 8.296 1 7.946v-.31l.316-.108 3.562.21 3.491.279-.113.695-6.66-.346z" />
      <path d="M3.411 11.931h-.698l-.278-.32v-.382l1.186-.838 4.82-3.068.487.833z" />
      <path d="m4.738 13.883-.28.07-.418-.21.07-.35 4.12-5.446.558.768-3.072 4.05z" />
      <path d="m8.23 14.581-.21.28-.419.14-.349-.28-.21-.42L8.09 8.646l.629.07z" />
      <path d="M11.791 13.045v.558l-.07.21-.279.14-.489-.066-3.356-4.996 1.331-1.014 1.117 2.025.105.733z" />
      <path d="m13.398 12.207.07.349-.21.279-.21-.07-1.187-.838-1.815-1.606-1.397-.978.419-1.326.698.419.42.768z" />
      <path d="m12.49 8.645 1.746.14.419.28.279.418v.302l-.768.327-3.911-.978-1.606-.07.419-1.466 1.117.838z" />
    </svg>
  );
}

/** The OpenAI mark (the official monochrome logo), filled with `currentColor` so it
 *  inherits the surrounding text colour — the Codex-backend counterpart to
 *  {@link ClaudeMark}. Used by the composer's model-picker chip when a conversation
 *  runs on Codex. */
export function CodexMark({ className }: { className?: string }) {
  return (
    <svg
      className={"wf-codex " + (className || "")}
      viewBox="0 0 512 512"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      aria-hidden="true"
    >
      <path
        fillRule="nonzero"
        d="M474.123 209.81c11.525-34.577 7.569-72.423-10.838-103.904-27.696-48.168-83.433-72.94-137.794-61.414a127.14 127.14 0 00-95.475-42.49c-55.564 0-104.936 35.781-122.139 88.593-35.781 7.397-66.574 29.76-84.637 61.414-27.868 48.167-21.503 108.72 15.826 150.007-11.525 34.578-7.569 72.424 10.838 103.733 27.696 48.34 83.433 73.111 137.966 61.585 24.084 27.18 58.833 42.835 95.303 42.663 55.564 0 104.936-35.782 122.139-88.594 35.782-7.397 66.574-29.76 84.465-61.413 28.04-48.168 21.676-108.722-15.654-150.008v-.172zm-39.567-87.218c11.01 19.267 15.139 41.803 11.354 63.65-.688-.516-2.064-1.204-2.924-1.72l-101.152-58.49a16.965 16.965 0 00-16.687 0L206.621 194.5v-50.232l97.883-56.597c45.587-26.32 103.732-10.666 130.052 34.921zm-227.935 104.42l49.888-28.9 49.887 28.9v57.63l-49.887 28.9-49.888-28.9v-57.63zm23.223-191.81c22.364 0 43.867 7.742 61.07 22.02-.688.344-2.064 1.204-3.097 1.72L186.666 117.26c-5.161 2.925-8.258 8.43-8.258 14.45v136.934l-43.523-25.116V130.333c0-52.64 42.491-95.13 95.131-95.302l-.172.172zM52.14 168.697c11.182-19.268 28.557-34.062 49.544-41.803V247.14c0 6.02 3.097 11.354 8.258 14.45l118.354 68.295-43.695 25.288-97.711-56.425c-45.415-26.32-61.07-84.465-34.75-130.052zm26.665 220.71c-11.182-19.095-15.139-41.802-11.354-63.65.688.516 2.064 1.204 2.924 1.72l101.152 58.49a16.965 16.965 0 0016.687 0l118.354-68.467v50.232l-97.883 56.425c-45.587 26.148-103.732 10.665-130.052-34.75h.172zm204.54 87.39c-22.192 0-43.867-7.741-60.898-22.02a62.439 62.439 0 003.097-1.72l101.152-58.317c5.16-2.924 8.429-8.43 8.257-14.45V243.527l43.523 25.116v113.022c0 52.64-42.663 95.303-95.131 95.303v-.172zM461.22 343.303c-11.182 19.267-28.729 34.061-49.544 41.63V264.687c0-6.021-3.097-11.526-8.257-14.45L284.893 181.77l43.523-25.116 97.883 56.424c45.587 26.32 61.07 84.466 34.75 130.053l.172.172z"
      />
    </svg>
  );
}

/** A filled "person" glyph (`currentColor`) for the user's own message avatar —
 *  the human counterpart to {@link ClaudeMark}. */
export function UserMark({ className }: { className?: string }) {
  return (
    <svg className={"wf-user-mark " + (className || "")} viewBox="0 0 22 22" fill="currentColor" aria-hidden="true">
      <path d="M11 11.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z" />
      <path d="M4.9 17.8c0-2.8 2.7-4.6 6.1-4.6s6.1 1.8 6.1 4.6v.2H4.9Z" />
    </svg>
  );
}

export function Win({
  title,
  nav,
  right,
  banner,
  children,
}: {
  title?: ReactNode;
  nav?: ReactNode;
  right?: ReactNode;
  /** Full-width strip between the title bar and the body (e.g. update banner). */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="wf-win">
      <div className="wf-titlebar">
        {nav ? <div className="wf-tbnav">{nav}</div> : null}
        {title ? <span className="wf-title">{title}</span> : null}
        {right ? <div className="wf-tbright">{right}</div> : null}
      </div>
      {banner}
      <div className="wf-body">{children}</div>
    </div>
  );
}

export function NavBtn({
  icon,
  label,
  on,
  badge,
  title,
  onClick,
}: {
  icon?: string;
  label: string;
  on?: boolean;
  badge?: number | null;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button {...(on ? { "data-on": "" } : {})} title={title} onClick={onClick}>
      {icon ? <Ico name={icon} className="sm" /> : null}
      {label}
      {badge != null ? <span className="wf-badge att">{badge}</span> : null}
    </button>
  );
}

export type StreamState = "work" | "ask" | "err" | "review" | "done" | "arch" | "off" | "bg";

export const WF_STATUS: Record<StreamState, { label: string; pill: string; dot: string }> = {
  work: { label: "Running", pill: "run", dot: "run" },
  ask: { label: "Action required", pill: "att", dot: "att" },
  err: { label: "Action required", pill: "err", dot: "err" },
  review: { label: "To review", pill: "wait", dot: "wait" },
  done: { label: "Active", pill: "done", dot: "done" },
  arch: { label: "Archived", pill: "arch", dot: "arch" },
  off: { label: "Off", pill: "off", dot: "off" },
  bg: { label: "Background tasks", pill: "bg", dot: "bg" },
};
export const WF_ATTENTION: StreamState[] = ["ask", "err", "review"];

export function Dot({ s, pulse, ring }: { s: StreamState; pulse?: boolean; ring?: boolean }) {
  const st = WF_STATUS[s]?.dot || "done";
  const live = pulse && (s === "work" || s === "ask" || s === "err");
  // `ring` = a violet outer ring on top of the status colour, for a settled alert
  // (review / question / error) whose agent still has BACKGROUND work running — the
  // "finished, but work continues" accent. See conductor-wirekit .wf-dot.bgring.
  return <span className={"wf-dot " + st + (live ? " pulse" : "") + (ring ? " bgring" : "")} />;
}

/** A dedicated "this conversation is running" indicator with more presence than a
 *  plain pulsing dot: a steady green core emitting two staggered sonar rings (pure
 *  CSS, GPU-friendly transform/opacity; rings are `::before`/`::after` in the CSS,
 *  and honour `prefers-reduced-motion`). Used in the sidebar for a conversation whose
 *  turn is in flight — a more elaborate "running" indicator. */
export function RunPulse() {
  return (
    <span className="cv-run-ind" aria-hidden="true">
      <i />
    </span>
  );
}

/** The three bouncing "working" dots — the shared motif used by the main thread
 *  indicator and the pinned bars (AgentBar / BashBar), so a running agent or
 *  background command reads identically across the UI. */
export function RunDots() {
  return (
    <span className="cv-bgrun" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function Pill({
  s,
  children,
  icon,
}: {
  s: StreamState;
  children?: ReactNode;
  icon?: false;
}) {
  const st = WF_STATUS[s] || WF_STATUS.done;
  return (
    <span className={"wf-pill " + st.pill}>
      {icon === false ? null : (
        <span className={"wf-dot " + st.dot} style={{ boxShadow: "none", width: 6, height: 6 }} />
      )}
      {children || st.label}
    </span>
  );
}

export function Tag({ icon, children, title }: { icon?: string; children: ReactNode; title?: string }) {
  return (
    <span className="wf-tag" title={title}>
      {icon ? <Ico name={icon} className="sm" /> : null}
      {children}
    </span>
  );
}

export function Avatar({ children, ai, user, codex }: { children: ReactNode; ai?: boolean; user?: boolean; codex?: boolean }) {
  return <span className={"wf-avatar" + (ai ? " ai" : "") + (user ? " user" : "") + (codex ? " codex" : "")}>{children}</span>;
}

export function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    }
    function k(e: KeyboardEvent) {
      if (e.key === "Escape") onAway();
    }
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [onAway]);
  return ref;
}

/** Fixed-position placement for a portaled popover — every side is set explicitly
 *  ("auto" for the ones we don't anchor) so the stylesheet's absolute `top/left`
 *  never leaks through the inline `position:fixed`. */
interface MenuPortalPos {
  left: number | "auto";
  right: number | "auto";
  top: number | "auto";
  bottom: number | "auto";
  maxHeight: number;
}

/** Margin kept between a portaled popover and the viewport edges. */
const MENU_M = 8;

/** Compute a collision-aware fixed placement from the trigger's rect, honouring
 *  `align`/`up` as the PREFERRED sides and flipping when a side lacks room. Mirrors
 *  CardPopover's approach so portaled menus behave like the other card popovers.
 *  `pop` is the popover's own measured rect (once mounted) — used to keep the WHOLE
 *  popover on-screen for any width, so e.g. a right-aligned menu on a far-left card
 *  never runs off the left edge. */
export function menuPortalPlacement(r: DOMRect, align?: "right", up?: boolean, pop?: DOMRect | null): MenuPortalPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Enough to hold the tallest menu body (the usage card); used only for the flip test.
  const FLIP = 220;
  const above = r.top - MENU_M;
  const below = vh - r.bottom - MENU_M;
  // Keep the preferred vertical side unless it's clearly too small and the other is bigger.
  const useUp = up ? !(above < FLIP && below > above) : below < FLIP && above > below;
  const pos: MenuPortalPos = {
    left: "auto",
    right: "auto",
    top: "auto",
    bottom: "auto",
    maxHeight: (useUp ? above : below) - 6,
  };
  if (useUp) pos.bottom = vh - r.top + 6;
  else pos.top = r.bottom + 6;
  // Horizontal: anchor to the trigger's matching edge (align hint), then clamp so NEITHER edge
  // leaves the viewport. Positioned via `left` always. The popover is mounted (hidden) BEFORE this
  // runs, so `pop` carries its real measured width from the first placement pass; the `240` is only
  // a defensive default for a missing ref. `right`-aligned menus put the popover's right edge at the
  // trigger's right edge; the clamp then slides it back on-screen if that would overflow the left —
  // the fix for a far-left card whose menu used to open off-screen.
  const w = pop?.width || 240;
  const preferredLeft = align === "right" ? r.right - w : r.left;
  const maxLeft = Math.max(MENU_M, vw - w - MENU_M);
  pos.left = Math.min(Math.max(MENU_M, preferredLeft), maxLeft);
  return pos;
}

export function Menu({
  trigger,
  children,
  align,
  up,
  onOpen,
  portal,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trigger: ReactElement<any>;
  children: ReactNode;
  align?: "right";
  up?: boolean;
  /** Fired once each time the menu transitions closed → open (e.g. to refresh data). */
  onOpen?: () => void;
  /** Render the popover in a fixed-position PORTAL anchored to the trigger, so it
   *  escapes an ancestor's `overflow` clip (e.g. a FlightDeck card inside the swimlane,
   *  which has `overflow-y:hidden`). Placement stays collision-aware and honours
   *  `align`/`up` as the preferred side. Default off → every existing in-flow usage is
   *  untouched. */
  portal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The trigger span doubles as the click-away root AND the portal anchor rect.
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPortalPos | null>(null);

  // Click-away + Escape while open. Portaled or not, "inside" tests BOTH the trigger and
  // the popover — in portal mode the popover lives outside the trigger span, so a click
  // in it (e.g. dragging the effort slider) must NOT close the menu. In-flow, the popover
  // is inside the span already, so the extra check is a harmless no-op.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Consume Escape so it dismisses ONLY this menu, not an outer overlay also listening
        // on `window` (the Flight Deck reply modal, the Extensions manager) — the project's
        // "one Escape = one layer" contract, matching the drill-in popovers. The fullscreen
        // guard is capture-phase in App.tsx, so this bubble-phase stop never disturbs it.
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Compute (and keep fresh on scroll/resize) the portal placement from the trigger's
  // live rect. Recomputing on scroll keeps the popover glued while the swimlane scrolls.
  useLayoutEffect(() => {
    if (!open || !portal) {
      setPos(null);
      return;
    }
    const measure = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      // Feed the popover's OWN measured rect so the placement keeps its full width on-screen
      // (it is already mounted-but-hidden by the time this runs — see the render below).
      if (r) setPos(menuPortalPlacement(r, align, up, popRef.current?.getBoundingClientRect()));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, portal, align, up]);

  const clonedTrigger = cloneElement(trigger, {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!open) onOpen?.();
      setOpen((o) => !o);
    },
    "data-open": open ? "" : undefined,
  });

  if (!open) return <span className="wf-menu" ref={triggerRef}>{clonedTrigger}</span>;

  // In-flow popover: absolutely positioned relative to the .wf-menu span (unchanged).
  // Portaled popover: fixed-positioned at `pos`, mounted on document.body so no ancestor
  // `overflow` can clip it. `.up`/`.right` positioning classes are dropped in portal mode
  // (the inline `pos` owns every side); `.portaled` adds z-index + scroll clamp.
  // Portaled: mount the popover immediately (so its width can be measured) but keep it
  // hidden until the first placement lands — `useLayoutEffect` positions it before paint,
  // so there is no visible flash at the origin.
  const popStyle: CSSProperties | undefined = !portal
    ? undefined
    : pos
      ? {
          position: "fixed",
          left: pos.left,
          right: pos.right,
          top: pos.top,
          bottom: pos.bottom,
          maxHeight: pos.maxHeight,
        }
      : { position: "fixed", left: 0, top: 0, visibility: "hidden" };
  const popover = (
    <div
      ref={popRef}
      className={
        "wf-pop" +
        (portal ? " portaled" : (align === "right" ? " right" : "") + (up ? " up" : ""))
      }
      style={popStyle}
      onClick={() => setOpen(false)}
    >
      {children}
    </div>
  );

  return (
    <span className="wf-menu" ref={triggerRef}>
      {clonedTrigger}
      {portal ? createPortal(popover, document.body) : popover}
    </span>
  );
}

export function MenuItem({
  on,
  children,
  onClick,
  icon,
  hint,
  disabled,
}: {
  on?: boolean;
  children: ReactNode;
  onClick?: () => void;
  icon?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button className={"wf-mi" + (on ? " on" : "")} onClick={onClick} disabled={disabled}>
      <span className="wf-mi-ck">{on ? <Ico name="check" className="sm" /> : null}</span>
      {icon ? <Ico name={icon} className="sm" /> : null}
      <span className="wf-mi-t">{children}</span>
      {hint ? <span className="wf-mi-h wf-mono">{hint}</span> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="wf-mi-lbl">{children}</div>;
}

export function ChipBtn({
  icon,
  iconNode,
  children,
  className,
  ...rest
}: { icon?: string; iconNode?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  // A disabled chip opens no menu, so the dropdown chevron would be misleading.
  // `iconNode` lets a chip render a custom leading mark (e.g. the Claude logo)
  // instead of a named stroke icon. `className` is MERGED (not overridden) so a caller
  // can add a modifier class without losing `wf-chip` (which carries the transparent-bg
  // reset — dropping it falls back to the native button's light background).
  return (
    <button className={"wf-chip" + (className ? " " + className : "")} {...rest}>
      {iconNode ?? (icon ? <Ico name={icon} className="sm" /> : null)}
      {children ? <span className="wf-chip-t">{children}</span> : null}
      {rest.disabled ? null : <Ico name="chev" className="sm wf-chip-chev" />}
    </button>
  );
}

export interface Ctx {
  pct: number;
  used: string;
  max: string;
}

/** Subscription plan (rate-limit) snapshot, surfaced from `rate_limit_event`.
 *  The stream-json protocol only exposes the coarse status + reset time — NOT a
 *  usage percentage (that lives behind `/api/oauth/usage`). */
export interface PlanInfo {
  status: string | null;
  resetsAt: number | null;
  limitType: string | null;
  usingOverage: boolean;
}

/** Real usage fill of one rate-limit window (from `GET /api/oauth/usage`). Shape
 *  mirrors the core's `UsageWindow` so the generated type passes structurally.
 *  `resets_at` is a raw timestamp string (ISO 8601, or epoch-seconds digits). */
export interface PlanUsageWindow {
  used_percentage: number;
  resets_at: string | null;
}

/** Normalize a window's raw `resets_at` to Unix epoch SECONDS for `fmtReset`. Handles
 *  ISO 8601 (the live endpoint) via the native `Date` parser and a digits-only epoch
 *  (the alternate shape). `null` when absent/unparseable. */
function resetToEpochSeconds(s: string | null): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** A rate-limit window scoped to ONE model rather than the whole account (e.g. Fable's
 *  weekly allowance). Mirrors the core's `ScopedUsageWindow`; the `label` comes straight
 *  from the endpoint, so a renamed/added scoped model needs no frontend change. */
export interface PlanUsageScopedWindow {
  label: string;
  group: string | null;
  window: PlanUsageWindow;
}

/** Real plan-usage %, the precise figure the stream does NOT carry. Each window is
 *  null when the endpoint did not report it. Mirrors the core's `PlanUsage`. */
export interface PlanUsageInfo {
  five_hour: PlanUsageWindow | null;
  seven_day: PlanUsageWindow | null;
  /** Model-scoped caps, listed alongside the two account-wide windows. Optional because
   *  the core marks it `serde(default)` — an absent value reads as "none". */
  scoped?: PlanUsageScopedWindow[];
}

/** Why the real plan-usage fetch failed — mirrors the core's `UsageError` union so
 *  the generated type passes structurally and the popover can branch on `kind`. */
export type PlanUsageError =
  | { kind: "no_token" }
  | { kind: "keychain_denied"; detail: string }
  | { kind: "unauthorized"; status: number }
  | { kind: "rate_limited"; retry_after: number | null }
  | { kind: "http"; status: number; body: string }
  | { kind: "network"; detail: string }
  | { kind: "parse"; body: string };

/** Message + actionable next step + retry-applies + raw detail, per cause.
 *  Single source of the copy so it lives in one place. */
function usageErrorCopy(e: PlanUsageError): {
  msg: string;
  action: string;
  retry: boolean;
  detail: string | null;
} {
  switch (e.kind) {
    case "no_token":
      return {
        msg: "No Claude token found.",
        action:
          'Sign in via the CLI: run "claude" in a terminal, authenticate, then retry.',
        retry: true,
        detail: null,
      };
    case "keychain_denied":
      return {
        msg: "Keychain access denied.",
        action:
          'The app isn\'t signed: click "Always Allow" on the macOS Keychain prompt, then retry.',
        retry: true,
        detail: e.detail,
      };
    case "unauthorized":
      return {
        msg: `Token expired or revoked (HTTP ${e.status}).`,
        action: 'Start a "claude" session to refresh the token, then retry.',
        retry: true,
        detail: null,
      };
    case "rate_limited":
      return {
        msg: "Usage endpoint temporarily rate-limited.",
        action: e.retry_after
          ? `The /api/oauth/usage endpoint is itself rate-limited (the CLI queries it too). Retry in ~${e.retry_after}s.`
          : "The /api/oauth/usage endpoint is itself rate-limited (the CLI queries it too). Wait a few minutes before retrying.",
        retry: true,
        detail: null,
      };
    case "http":
      return {
        msg: `The usage service returned an error (HTTP ${e.status}).`,
        action: "Retry in a moment; if it persists, report it with the details.",
        retry: true,
        detail: e.body,
      };
    case "network":
      return {
        msg: "Couldn't connect to the usage service.",
        action: "Check your internet connection, then retry.",
        retry: true,
        detail: e.detail,
      };
    case "parse":
      return {
        msg: "Unreadable response from the usage service.",
        action: "Probably a bug — report it with the details below.",
        retry: false,
        detail: e.body,
      };
    default: {
      // Exhaustiveness guard: a new UsageError kind must be handled above (this line
      // fails to compile otherwise). At RUNTIME it also catches a foreign thrown value
      // (e.g. a raw transport Error that slipped past normalization) so the popover
      // degrades gracefully instead of crashing on `undefined.msg`.
      const _exhaustive: never = e;
      void _exhaustive;
      const detail =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      return {
        msg: "Unexpected error from the usage service.",
        action: "Retry; if it persists, report it with the details below.",
        retry: true,
        detail,
      };
    }
  }
}

/** Turns a failed usage fetch into a concrete next step. Two modes:
 *  - full (no data yet): message + action + optional "Retry" + "Details".
 *  - `stale` (data already shown above): a compact non-destructive warning so a failed
 *    refresh is NEVER silent — the bars stay, but the user is told they may be stale. */
function UsageErrorCard({
  error,
  loading,
  onRetry,
  stale,
}: {
  error: PlanUsageError;
  loading?: boolean;
  onRetry?: () => void;
  stale?: boolean;
}) {
  const c = usageErrorCopy(error);
  const retryBtn =
    c.retry && onRetry ? (
      <button
        className="wf-pop-err-retry"
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
        disabled={loading}
      >
        <Ico name="refresh" className={"sm" + (loading ? " wf-spin-fast" : "")} />
        Retry
      </button>
    ) : null;

  if (stale) {
    return (
      <div className="wf-pop-staleerr">
        <span className="wf-pop-staleerr-msg">
          <Ico name="alert" className="sm" />
          Refresh failed — figures may be stale.
        </span>
        <div className="wf-pop-err-foot">
          {retryBtn}
          <details className="wf-pop-err-det" onClick={(e) => e.stopPropagation()}>
            <summary>Details</summary>
            <pre className="wf-mono">{c.detail ? `${c.msg}\n${c.detail}` : c.msg}</pre>
          </details>
        </div>
      </div>
    );
  }
  return (
    <div className="wf-pop-err">
      <div className="wf-pop-err-msg">{c.msg}</div>
      <div className="wf-pop-err-act">{c.action}</div>
      {retryBtn || c.detail ? (
        <div className="wf-pop-err-foot">
          {retryBtn}
          {c.detail ? (
            <details className="wf-pop-err-det" onClick={(e) => e.stopPropagation()}>
              <summary>Details</summary>
              <pre className="wf-mono">{c.detail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One window's real-usage bar: label · % · reset, with a fill that warns past 80%. */
function UsageRow({
  label,
  w,
  fallbackReset,
}: {
  label: string;
  w: PlanUsageWindow;
  fallbackReset: number | null;
}) {
  const pct = Math.min(100, Math.max(0, Math.round(w.used_percentage)));
  const warn = pct >= 80;
  const reset = resetToEpochSeconds(w.resets_at) ?? fallbackReset;
  return (
    <div className="wf-pop-usage">
      <div className="wf-pop-usage-top">
        {/* Explicitly classed, NOT styled via a positional selector: a model-scoped cap's
            label is data-driven (it carries the model's name), so it is the one label that
            can be long enough to push the figure out of the popover, and it MUST keep its
            ellipsis. A `:first-child` rule would stop applying the day this markup gains a
            leading element — silently, the failure only showing up on a long model name. */}
        <span className="wf-pop-usage-label">{label}</span>
        <span className="wf-mono">
          {pct}%{reset ? ` · ${fmtReset(reset)}` : ""}
        </span>
      </div>
      <div className="wf-pop-bar">
        <i className={warn ? "warn" : ""} style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}

/** Map a rate-limit status to a label + colour token. */
function planStatus(status: string | null): { label: string; color: string } {
  switch (status) {
    case "allowed":
      return { label: "OK", color: "var(--wf-run)" };
    case "allowed_warning":
      return { label: "Near limit", color: "var(--wf-att)" };
    case "rejected":
      return { label: "Limited", color: "var(--wf-err)" };
    default:
      return { label: status ?? "—", color: "var(--wf-tx-lo)" };
  }
}

/** Label a model-scoped cap: its name plus the window it spans ("Fable · 7d"), so it reads in
 *  the same idiom as the "5h"/"7d" rows above it. The suffix is derived from the payload's
 *  `group`, and dropped when that is absent or unknown — a duration is never guessed. */
function scopedUsageLabel(s: PlanUsageScopedWindow): string {
  const win = s.group === "weekly" ? "7d" : s.group === "session" ? "5h" : null;
  return win ? `${s.label} · ${win}` : s.label;
}

/** Human label for a rate-limit window type. */
function planWindow(limitType: string | null): string {
  switch (limitType) {
    case "five_hour":
      return "5h";
    case "seven_day":
      return "7d";
    default:
      return limitType ?? "";
  }
}

/** "in 3d 4h" (≥24h) / "in 2h14" / "in 43min" / "imminent" — computed at render
 *  (popover re-opens). The 7-day window resets days away, so above 24h we show days + hours
 *  (hours-only was impractical: "in 73h"); below 24h we keep hours + minutes. */
function fmtReset(resetsAt: number | null): string {
  if (!resetsAt) return "—";
  const secs = resetsAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "imminent";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `in ${d}d ${rh}h` : `in ${d}d`;
  }
  return h > 0 ? `in ${h}h${m.toString().padStart(2, "0")}` : `in ${m}min`;
}

/** "just now" / "3 min ago" / "2 h ago" / "1 d ago" — how long ago the shown
 *  usage figures were last successfully fetched. `null`/0 (never fetched) → null so the
 *  caller hides the line. Computed at render (the popover re-opens fresh each time). */
function fmtAgo(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 30) return "just now";
  const m = Math.floor(secs / 60);
  if (m < 1) return "less than 1 min ago";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

/** The context-window + real-usage data feeding both the ring and the meter popovers.
 *  Shared so the ring (conversation composer) and the clickable card meter render the
 *  EXACT same popover body from one source. */
export interface ContextUsageData {
  ctx: Ctx;
  plan?: PlanInfo | null;
  onCompact?: () => void;
  /** Real usage % (5h + weekly), from `GET /api/oauth/usage`. Null/absent → the
   *  popover falls back to the coarse `plan` status. */
  usage?: PlanUsageInfo | null;
  usageLoading?: boolean;
  /** Which backend's subscription the "Plan" figures belong to — labels the section
   *  (Claude Max ≠ Codex/ChatGPT are two distinct plans, never merged) so the user always
   *  knows WHICH plan they're looking at. `undefined` → no label (single-backend setup). */
  usageBackend?: "claude" | "codex";
  /** Structured failure of the last usage fetch — drives a tailored guidance card. */
  usageError?: PlanUsageError | null;
  /** Timestamp (ms) of the last SUCCESSFUL usage fetch — the freshness of the shown
   *  figures. Stays put when a later refresh fails (e.g. the endpoint rate-limits us),
   *  so the "updated …" line tells the truth about how old the numbers are. */
  usageUpdatedAt?: number | null;
  /** Deliberate retry, wired only to the error card's "Retry" (recovery after a
   *  failure) — there is no general refresh button (opening the popover refetches). */
  onRefreshUsage?: () => void;
}

/** The popover BODY (context window + plan usage + "Compact context"),
 *  factored out so the ring and the card's clickable meter show an identical panel. */
function ContextUsageBody({
  ctx,
  plan,
  onCompact,
  usage,
  usageLoading,
  usageError,
  usageUpdatedAt,
  usageBackend,
  onRefreshUsage,
}: ContextUsageData) {
  const warn = ctx.pct >= 70;
  const st = plan ? planStatus(plan.status) : null;
  const hasForfait = !!(plan || usage || usageLoading || usageError);
  return (
    <div className="wf-pop-ctx" onClick={(e) => e.stopPropagation()}>
      <div className="wf-pop-h">Context window</div>
      <div className="wf-pop-ctx-line wf-mono">
        {ctx.used}/{ctx.max} tokens <span className={warn ? "warn" : "wf-pop-ctx-pct"}>({ctx.pct}%)</span>
      </div>
      <div className="wf-pop-bar">
        <i className={warn ? "warn" : ""} style={{ width: ctx.pct + "%" }} />
      </div>
      {hasForfait ? (
        <>
          <div className="wf-pop-sep" />
          <div className="wf-pop-h wf-pop-h-row">
            {/* Label the plan by backend so the user knows whether these are their Claude
                (Max) or Codex (ChatGPT) figures — the two are distinct plans, never merged.
                Coloured like the Extensions tabs (Claude coral, Codex green). */}
            <span>
              Plan
              {usageBackend ? (
                <>
                  {" · "}
                  <span style={{ color: usageBackend === "codex" ? "var(--wf-codex-accent)" : "var(--wf-accent)", fontWeight: 600 }}>
                    {usageBackend === "codex" ? "Codex" : "Claude"}
                  </span>
                </>
              ) : null}
            </span>
            {/* Freshness of the shown figures (replaces the manual refresh button —
                the popover already refetches on open). Reflects the last SUCCESS, so a
                rate-limited refresh doesn't fake-bump it. */}
            {fmtAgo(usageUpdatedAt) ? (
              <span className="wf-pop-updated">
                {usageLoading ? "refreshing…" : `updated ${fmtAgo(usageUpdatedAt)}`}
              </span>
            ) : null}
          </div>
          {/* Real usage bars (precise %), when the endpoint reported them. */}
          {usage?.five_hour ? (
            <UsageRow
              label="5h"
              w={usage.five_hour}
              fallbackReset={plan?.limitType === "five_hour" ? plan.resetsAt : null}
            />
          ) : null}
          {usage?.seven_day ? (
            <UsageRow
              label="7d"
              w={usage.seven_day}
              fallbackReset={plan?.limitType === "seven_day" ? plan.resetsAt : null}
            />
          ) : null}
          {/* Model-scoped caps (e.g. Fable's weekly allowance), listed after the two
              account-wide windows. Rendered straight off the payload — no fallback reset,
              since a scoped window that hasn't started reports none and the coarse `plan`
              reset belongs to a different (account-wide) cap. */}
          {(usage?.scoped ?? []).map((s) => (
            <UsageRow
              key={`${s.label}:${s.group ?? ""}`}
              label={scopedUsageLabel(s)}
              w={s.window}
              fallbackReset={null}
            />
          ))}
          {/* Coarse status pill (warning / rejected) — always informative. */}
          {st && plan ? (
            <div className="wf-pop-row">
              <span>Status{!usage && planWindow(plan.limitType) ? ` · ${planWindow(plan.limitType)}` : ""}</span>
              <span className="wf-pop-pill">
                <i style={{ background: st.color }} />
                {st.label}
              </span>
            </div>
          ) : null}
          {/* No precise %: keep the coarse reset line (from the stream). */}
          {!usage && plan ? (
            <div className="wf-pop-row">
              <span>Reset</span>
              <span className="wf-mono">{fmtReset(plan.resetsAt)}</span>
            </div>
          ) : null}
          {/* A real error: actionable guidance (full card if no data, or a compact
              non-destructive "stale" warning if bars are already shown above). Never
              silent — a failed refresh after a prior success still surfaces here. */}
          {usageError ? (
            <UsageErrorCard error={usageError} loading={usageLoading} onRetry={onRefreshUsage} stale={!!usage} />
          ) : null}
          {!usage && !usageError && usageLoading ? (
            <div className="wf-pop-sub">Loading usage…</div>
          ) : null}
          {plan?.usingOverage ? <div className="wf-pop-sub">Overage active</div> : null}
        </>
      ) : null}
      <div
        className="wf-pop-act"
        role="button"
        tabIndex={0}
        onClick={() => onCompact?.()}
        title="Send /compact to reduce context"
      >
        <Ico name="spark" className="sm" />
        Compact context
      </div>
    </div>
  );
}

export function ContextRing({
  label,
  disabled,
  onOpenUsage,
  ...usage
}: ContextUsageData & {
  label?: boolean;
  disabled?: boolean;
  /** Fired when the popover opens — caller throttles (e.g. only if data is stale).
   *  The popover refetches on open, so there's no manual refresh button. */
  onOpenUsage?: () => void;
}) {
  const { ctx } = usage;
  const sz = 16;
  const r = sz / 2 - 1.6;
  const c = 2 * Math.PI * r;
  const warn = ctx.pct >= 70;
  // No usage reported yet (fresh session, pre-first-turn) — quiet, non-interactive stub.
  if (disabled) {
    return (
      <button className="wf-ring" disabled title="Context — waiting for the first turn">
        <svg width={sz} height={sz} viewBox={"0 0 " + sz + " " + sz}>
          <circle cx={sz / 2} cy={sz / 2} r={r} className="wf-ring-bg" />
        </svg>
      </button>
    );
  }
  return (
    <Menu
      align="right"
      up
      onOpen={onOpenUsage}
      trigger={
        <button className={"wf-ring" + (warn ? " warn" : "")} title={"Context " + ctx.used + " / " + ctx.max}>
          <svg width={sz} height={sz} viewBox={"0 0 " + sz + " " + sz}>
            <circle cx={sz / 2} cy={sz / 2} r={r} className="wf-ring-bg" />
            <circle
              cx={sz / 2}
              cy={sz / 2}
              r={r}
              className="wf-ring-fg"
              style={{ strokeDasharray: c, strokeDashoffset: c * (1 - ctx.pct / 100) }}
              transform={"rotate(-90 " + sz / 2 + " " + sz / 2 + ")"}
            />
          </svg>
          {label ? <span className="wf-mono wf-chip-t">{ctx.pct}%</span> : null}
        </button>
      }
    >
      <ContextUsageBody {...usage} />
    </Menu>
  );
}

/** The gauge icon + fill bar + percentage — shared by the read-only {@link ContextMeter}
 *  and the clickable {@link ContextMeterMenu} trigger, so both read identically. */
function meterBody(ctx: Ctx) {
  return (
    <>
      <Ico name="gauge" className="sm" />
      <span className="wf-ctx">
        <i style={{ width: ctx.pct + "%" }} />
      </span>
      <span className="wf-mono" style={{ fontSize: 10.5 }}>
        {ctx.pct}%
      </span>
    </>
  );
}

/** Compact context-fill meter — a tiny bar + percentage (the card variant of the
 *  ContextRing). The exact "used / max" is in the hover title. */
export function ContextMeter({ ctx }: { ctx: Ctx }) {
  const warn = ctx.pct >= 70;
  return (
    <span className={"wf-ctxm" + (warn ? " warn" : "")} title={`Context ${ctx.used} / ${ctx.max}`}>
      {meterBody(ctx)}
    </span>
  );
}

/** The card's clickable context meter: the same tiny bar, now a button that opens the
 *  SAME context/usage popover as the composer's ContextRing (portaled so the swimlane's
 *  `overflow` can't clip it). */
export function ContextMeterMenu({
  onOpenUsage,
  ...usage
}: ContextUsageData & { onOpenUsage?: () => void }) {
  const { ctx } = usage;
  const warn = ctx.pct >= 70;
  return (
    // No `align="right"`: the meter sits at the card footer's LEFT, so the popover
    // anchors its left edge to it and opens rightward (staying within the card), and
    // `up` opens it above the footer.
    <Menu
      up
      portal
      onOpen={onOpenUsage}
      trigger={
        <button
          className={"wf-ctxm wf-ctxm-btn" + (warn ? " warn" : "")}
          title={`Context ${ctx.used} / ${ctx.max}`}
        >
          {meterBody(ctx)}
        </button>
      }
    >
      <ContextUsageBody {...usage} />
    </Menu>
  );
}

/** A todo segment's state for the {@link TodoPips} bar. */
export type TodoSeg = "todo" | "doing" | "done";

/** The to-do progress pips + ratio: one dash per task — grey (not started),
 *  amber (in progress), green (done) — followed by "done/total". */
export function TodoPips({ segs, done, total }: { segs: TodoSeg[]; done: number; total: number }) {
  return (
    <span
      className="wf-row"
      style={{ gap: 6, color: "var(--wf-tx-lo)", fontSize: 11 }}
      title="Task progress"
    >
      <span className="wf-todobar">
        {segs.map((s, i) => (
          <i key={i} className={"wf-todoseg " + s} />
        ))}
      </span>
      <span className="wf-mono">
        {done}/{total}
      </span>
    </span>
  );
}
