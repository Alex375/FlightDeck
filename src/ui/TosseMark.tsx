import { useId } from "react";

// The Flight Deck brand mark — a cyan aircraft climbing with a coral engine-thrust
// plume trailing along its flight axis (mirrors public/tosse.svg / the app icon).
// Inlined so it renders crisp at small sizes with no asset fetch. Sized via CSS
// (className), defaults to 1em. Component name kept (TosseMark) — internal identifier.
//
// Gradient ids are per instance: the mark now repeats down a thread (one per Flight Deck
// tool step), and a shared `id` resolves to the FIRST definition in the document — which
// paints nothing once that copy sits in a collapsed/hidden subtree.
export function TosseMark({
  className,
  tight = false,
}: {
  className?: string;
  /** Crop the viewBox to the artwork (the full box keeps the app icon's padding) — for
   *  glyph-sized uses, where padding would shrink the aircraft to a speck. */
  tight?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const coral = `fd-mark-coral-${uid}`;
  const core = `fd-mark-core-${uid}`;
  const cyan = `fd-mark-cyan-${uid}`;
  return (
    <svg
      className={className}
      viewBox={tight ? "68 68 376 376" : "0 0 512 512"}
      role="img"
      aria-label="Flight Deck"
    >
      <defs>
        <linearGradient id={coral} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#cd6640" stopOpacity="0" />
          <stop offset="0.5" stopColor="#d9744f" />
          <stop offset="1" stopColor="#e8906f" />
        </linearGradient>
        <linearGradient id={core} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f0a988" stopOpacity="0" />
          <stop offset="1" stopColor="#f6c1a6" />
        </linearGradient>
        <linearGradient id={cyan} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#54d8ff" />
          <stop offset="1" stopColor="#2bc6f0" />
        </linearGradient>
      </defs>
      <g transform="translate(256 256) rotate(-40) scale(14) translate(-5.5 -12)">
        <path d="M2 7 L-12 12 L2 17 Z" fill={`url(#${coral})`} />
        <path d="M2 9.5 L-5.5 12 L2 14.5 Z" fill={`url(#${core})`} />
        <path d="M2 21 L23 12 L2 3 L2 10 L17 12 L2 14 Z" fill={`url(#${cyan})`} />
      </g>
    </svg>
  );
}
