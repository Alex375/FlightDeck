// The composer bar as DATA — the single description of which controls exist, which side
// they live on, when they apply, and how much room they take.
//
// Why a table instead of the JSX it replaces: the bar is user-arrangeable (hide/reorder
// the right-hand side, force icon-only per chip on the left, add custom buttons), and the
// Settings tab renders THE SAME bar as its editable preview. Two renderers reading one
// table can't drift; a mock-up drawn beside the real thing would.
//
// Everything here is PURE (no React, no store, no DOM) so the budget maths is testable
// and the Settings preview and the live composer agree by construction.

// ---- Identity ---------------------------------------------------------------------

/** Left-hand controls: what the turn will be run WITH. Never hidden, never reordered —
 *  only their display mode (full / icon-only) is user-settable. */
export type LeftChipId =
  | "model"
  | "effort"
  | "permission"
  | "codexSafety"
  | "codexSpeed"
  | "codexOptions";

/** Right-hand controls: tools for the conversation. Hideable and reorderable. */
export type RightChipId =
  | "artifacts"
  | "extensions"
  | "cleanOutput"
  | "remoteControl"
  | "goal"
  | "worktree";

export type NativeChipId = LeftChipId | RightChipId;

/** Which backend a control exists on. `both` renders on Claude and Codex alike. */
export type ChipBackend = "claude" | "codex" | "both";

export interface ChipDescriptor {
  id: NativeChipId;
  side: "left" | "right";
  /** Name shown in the Settings list (the bar itself is icon-first). */
  label: string;
  /** Kit glyph (WF_PATHS) used by the Settings list and by icon-only rendering. */
  icon: string;
  backend: ChipBackend;
  /** Plain-language note of when this control appears AT ALL, shown in Settings.
   *  ⚠️ Load-bearing: several of these render conditionally, so without the note a user
   *  hides something they never see and concludes the setting is broken. */
  condition?: string;
  /** Cannot be hidden (the context ring: it is the warning that you are about to be
   *  truncated — see MIN_COMPOSER_PX budget, it is always counted). */
  essential?: boolean;
  /**
   * Slots this control eats. 1 unless MEASURED otherwise: the worktree control keeps its
   * tick box next to the icon even when collapsed, so it is 52px wide against a plain
   * chip's 25px. Counting it as one would quietly promise a slot that doesn't exist.
   */
  slots?: number;
}

/** Left side, in render order. Order is FIXED: model → effort → permissions is a
 *  progression (what, how hard, with which rights), and freezing it keeps the muscle
 *  memory that the whole feature exists to protect. */
export const LEFT_CHIPS: readonly ChipDescriptor[] = [
  { id: "model", side: "left", label: "Model", icon: "spark", backend: "both" },
  { id: "effort", side: "left", label: "Thinking effort", icon: "bolt", backend: "both",
    condition: "Hidden on models with no effort setting (e.g. Haiku)" },
  { id: "permission", side: "left", label: "Permission mode", icon: "shield", backend: "claude" },
  { id: "codexSafety", side: "left", label: "Codex safety", icon: "shield", backend: "codex" },
  { id: "codexSpeed", side: "left", label: "Codex speed", icon: "bolt", backend: "codex",
    condition: "Only when the model offers more than one service tier" },
  { id: "codexOptions", side: "left", label: "Codex options", icon: "cog", backend: "codex" },
] as const;

/** Right side, in DEFAULT order (the user's arrangement overrides it). */
export const RIGHT_CHIPS: readonly ChipDescriptor[] = [
  { id: "artifacts", side: "right", label: "Artifacts", icon: "artifact", backend: "claude",
    condition: "Only once this conversation has published an artifact" },
  { id: "extensions", side: "right", label: "Extensions", icon: "layers", backend: "both" },
  { id: "cleanOutput", side: "right", label: "Clean output", icon: "list", backend: "both" },
  { id: "remoteControl", side: "right", label: "Remote control", icon: "globe", backend: "both" },
  { id: "goal", side: "right", label: "Goal", icon: "target", backend: "claude",
    condition: "Only while a /goal is active" },
  // 2 slots: measured at 52px — it keeps its tick box beside the icon when collapsed.
  { id: "worktree", side: "right", label: "Worktree", icon: "branch", backend: "both",
    condition: "Only before the first message is sent", slots: 2 },
] as const;

export const ALL_CHIPS: readonly ChipDescriptor[] = [...LEFT_CHIPS, ...RIGHT_CHIPS];

/** The left side renders as two groups with a hairline between them: what the turn runs
 *  ON (model, effort) and what it is allowed to DO (permissions / Codex safety). Split
 *  here so the composer and the Settings preview draw the same separator. */
export function leftGroups(backend: "claude" | "codex"): [ChipDescriptor[], ChipDescriptor[]] {
  const applicable = LEFT_CHIPS.filter((c) => appliesToBackend(c, backend));
  return [
    applicable.filter((c) => c.id === "model" || c.id === "effort"),
    applicable.filter((c) => c.id !== "model" && c.id !== "effort"),
  ];
}

const BY_ID = new Map<string, ChipDescriptor>(ALL_CHIPS.map((c) => [c.id, c]));

export function chipById(id: string): ChipDescriptor | null {
  return BY_ID.get(id) ?? null;
}

/** Whether a control can appear on a given backend. */
export function appliesToBackend(chip: ChipDescriptor, backend: "claude" | "codex"): boolean {
  return chip.backend === "both" || chip.backend === backend;
}

// ---- Width budget -----------------------------------------------------------------
//
// The bar must never overflow, and we refuse an overflow menu (a control you can't see
// is a control you don't have). So the number of buttons is CAPPED, and the cap is
// derived from the narrowest composer the app will ever render.
//
// Measured from the stylesheet, not guessed:
//   .cv-composer      padding 6px 8px      → 16px horizontal
//   .cv-comp-foot     padding 5px 6px 2px  → 12px horizontal, gap 3px
//   .wf-chip compact  padding 5px + 13px icon + 2×1px border = 25px
//   .cv-foot-sep      1px + 2×3px margin (compact) = 7px
//   ContextRing       .wf-ctx bar 38px + 6px gap + the percentage text ≈ 72px
//
// ⚠️ The floor and the auto-compact threshold are deliberately THE SAME number: at its
// narrowest, the composer is exactly at the point where `@container composer
// (max-width:500px)` has already put every chip in icon-only mode. One number in the
// system instead of two that must be kept consistent.
export const MIN_COMPOSER_PX = 500;
/** The conversation pane's floor: the composer's floor plus the 52px its card leaves on
 *  either side (`.cv-composer { width: calc(100% - 52px) }`). The side-panel splitter
 *  stops here, and the window's own minimum is derived from it. */
export const MIN_CONVERSATION_PANE_PX = MIN_COMPOSER_PX + 52;
export const COMPACT_CHIP_PX = 25;
export const CHIP_GAP_PX = 3;
export const SEPARATOR_PX = 7;
export const CONTEXT_RING_PX = 72;
const COMPOSER_PADDING_PX = 16;
const FOOT_PADDING_PX = 12;

/** How many chip slots fit at {@link MIN_COMPOSER_PX}. The separator and the context
 *  ring are always present, so they are charged against the budget up front rather than
 *  counted as slots. */
export function slotCapacity(minComposerPx: number = MIN_COMPOSER_PX): number {
  const available = minComposerPx - COMPOSER_PADDING_PX - FOOT_PADDING_PX;
  // The two non-chip items plus the two gaps they introduce.
  const fixed = SEPARATOR_PX + CONTEXT_RING_PX + CHIP_GAP_PX * 2;
  return Math.max(0, Math.floor((available - fixed) / (COMPACT_CHIP_PX + CHIP_GAP_PX)));
}

/** The total number of slots available to native chips + custom buttons. */
export const SLOT_CAPACITY = slotCapacity();

/**
 * How many native chips are on screen in the WORST case — the point of the whole
 * budget.
 *
 * ⚠️ It must never count "what is showing right now": artifacts, goal, worktree and the
 * Codex chips come and go, so a user could fill the bar on a quiet conversation and
 * overflow the day a goal and an artifact both appear.
 *
 * The two backends are DISJOINT (Claude never shows the three Codex chips; Codex has
 * neither goal nor artifacts), so the worst case is the max of the two rather than the
 * sum — which is what makes the budget liveable.
 */
export function nativeWorstCase(hidden: ReadonlySet<string>): number {
  const countFor = (backend: "claude" | "codex") =>
    ALL_CHIPS.filter(
      (c) => appliesToBackend(c, backend) && (c.side === "left" || !hidden.has(c.id)),
    ).reduce((n, c) => n + (c.slots ?? 1), 0);
  return Math.max(countFor("claude"), countFor("codex"));
}

/** Slots consumed by the current arrangement (native worst case + custom buttons). */
export function usedSlots(hidden: ReadonlySet<string>, customCount: number): number {
  return nativeWorstCase(hidden) + customCount;
}

/** Slots still free. Never negative — a saturated bar reports 0, and the Settings page
 *  refuses to add rather than letting the bar overflow. */
export function remainingSlots(hidden: ReadonlySet<string>, customCount: number): number {
  return Math.max(0, SLOT_CAPACITY - usedSlots(hidden, customCount));
}

/** What showing `id` again would cost. A native chip carries its measured weight; a
 *  custom button is always one. */
export function slotCost(id: string): number {
  return chipById(id)?.slots ?? 1;
}

/**
 * Whether a hidden control can be shown again without busting the cap.
 *
 * ⚠️ The budget was enforced when ADDING a button but not when un-hiding, so the bar
 * could be pushed past capacity by hiding chips, filling the freed slots with buttons,
 * then restoring the chips — exactly the overflow the whole cap exists to prevent.
 */
export function canUnhide(
  id: string,
  hidden: ReadonlySet<string>,
  visibleCustomCount: number,
): boolean {
  return remainingSlots(hidden, visibleCustomCount) >= slotCost(id);
}

// ---- Custom buttons ---------------------------------------------------------------

/** A user-made button: an icon from the kit set plus one action. Icon-only by design —
 *  a label would cost several slots out of a budget this tight. */
export interface CustomButton {
  /** Stable id (also the drag/sortable key and the arrangement key). */
  id: string;
  /** Kit glyph name (WF_PATHS). */
  icon: string;
  /** Tooltip — the only place the button says what it is, so it is required. */
  label: string;
  /** Which action to run (see composerActions.ts). */
  action: string;
  /** The action's argument: message text, command name, or a JSON config blob. */
  arg?: string;
  /**
   * Reserved: restrict this button to one repository. NOT exposed in v1 (one global bar
   * keeps positions stable, which is the point), but stored so enabling it later needs
   * no migration of everyone's saved bar.
   */
  repoId?: string | null;
}

/**
 * Move one visible item within the FULL arrangement, leaving everything else where it
 * was.
 *
 * ⚠️ The naive version — `[...movedVisible, ...theRest]` — silently rewrites positions
 * the user never touched: the Settings preview only ever shows one backend's applicable,
 * non-hidden controls, so dragging in the Codex preview would shove every Claude-only
 * chip (and every hidden one) to the end of the stored order. Here the visible items are
 * written back into the SLOTS they already occupied, so a drag moves exactly what was
 * dragged.
 */
export function reorderVisible(
  full: readonly string[],
  visible: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  if (fromIndex === toIndex) return [...full];
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= visible.length || toIndex >= visible.length)
    return [...full];
  const moved = [...visible];
  moved.splice(toIndex, 0, ...moved.splice(fromIndex, 1));
  const slots: number[] = [];
  for (let i = 0; i < full.length; i++) if (visible.includes(full[i])) slots.push(i);
  const out = [...full];
  slots.forEach((slot, k) => {
    out[slot] = moved[k];
  });
  return out;
}

/** Arrangement of the right-hand side: native chip ids and custom button ids, in the
 *  order they render. Ids absent from the list fall back to the default order (so a new
 *  native chip shipped in a later version appears instead of silently vanishing). */
export function orderedRight(
  order: readonly string[],
  hidden: ReadonlySet<string>,
  customs: readonly CustomButton[],
): string[] {
  const known = new Set<string>([...RIGHT_CHIPS.map((c) => c.id), ...customs.map((c) => c.id)]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (known.has(id) && !seen.has(id) && !hidden.has(id)) out.push(id);
    // Marked seen even when hidden or unknown: an id the arrangement already mentions
    // must not be re-appended by the fallback pass below.
    seen.add(id);
  }
  // Anything the stored order doesn't mention keeps its natural position at the end:
  // native chips first (in table order), then custom buttons (in creation order).
  for (const c of RIGHT_CHIPS) if (!seen.has(c.id) && !hidden.has(c.id)) out.push(c.id);
  for (const c of customs) if (!seen.has(c.id) && !hidden.has(c.id)) out.push(c.id);
  return out;
}
