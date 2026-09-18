// Settings panel open state + which section it should land on. A tiny shared
// slice so the panel can be opened from anywhere — the sidebar "Settings" entry
// AND deep-links (e.g. the update banner → "updates") both flip the same flag
// (same pattern as worktreeUiStore).
import { create } from "zustand";

/** The settings sections, mirrored by the panel's left-rail tabs. */
export type SettingsSection =
  /** You and this machine: the accounts your agents sign in with, and the anti-sleep hold. */
  | "general"
  | "tosse"
  /** Everything about what the app SHOWS and how it reads: the app's look and motion, the
   *  thread (including Markdown), timings, the composer bar, the model picker, and the
   *  manual ordering of conversations/cards. Was a sub-tab of General plus three separate
   *  top-level tabs (conversation, reordering). */
  | "display"
  /** Claude-specific settings: the instructions file, how Claude behaves (output style,
   *  what it may do without asking), and sub-agent routing + spend.
   *  Backend-specific ON PURPOSE — its whole content is Claude model names, Claude file
   *  layout and Claude-only CLI flags, so it is shown only while a Claude account is
   *  connected, and a Codex twin would be its own tab rather than an abstraction over both.
   *  ⚠️ Consequence, accepted: with no Claude account signed in, "Output style" and
   *  "Allow Bypass permissions mode" are not reachable — neither does anything to Codex. */
  | "claudeCode"
  | "shortcuts"
  | "control"
  // "notifications" bundles the OS channels, the fleet readout and the background-task
  // alert behind its own sub-tabs (the last two moved out of the old General → Alerts).
  | "notifications"
  | "updates"
  | "data";

interface SettingsUiState {
  open: boolean;
  /** The section to show when (re)opened. Persists across opens. */
  section: SettingsSection;
  /**
   * The sub-tab within the current section (`null` = its first one). Sections
   * that carry a lot of unrelated cards (General, Conversation, Control,
   * Notifications) split them behind
   * a pill row instead of stacking them all; every other section ignores this.
   * Remembered PER SECTION so leaving a tab and coming back lands where you were.
   */
  subs: Partial<Record<SettingsSection, string>>;
  /**
   * A row title to flash and scroll to, set when the user picks a search result.
   * Matching is by the row's visible title (`ToggleRow`/`SettingsGroup` compare
   * their own), so nothing has to thread ids through every settings row. Cleared
   * by the row once it has flashed — and by any manual navigation, so a title
   * that no longer exists can never leave a highlight armed forever.
   */
  highlight: string | null;
  /**
   * Non-null while `ServerBootstrapWizard` is paused on a BLOCKING `needs_input`
   * (today: only the sudo-password prompt for `escalate_persistence`) — the app's
   * only case where the panel simply closing would silently abandon in-progress work
   * a backend command can't yet resume without (the paused session's id lives only
   * in that component's memory; there is no "list paused sessions" IPC to recover it
   * from). The panel's own close paths (✕, Escape, the scrim) read this and confirm
   * before closing instead of discarding it — see `SettingsPanel`'s `requestClose`.
   * The value is the human-readable reason shown in that confirm.
   */
  bootstrapGuard: string | null;
  /** Open the panel, optionally jumping straight to `section` (and one of its sub-tabs). */
  openSettings: (section?: SettingsSection, sub?: string) => void;
  closeSettings: () => void;
  /** Switch the active section while the panel is open. */
  setSection: (section: SettingsSection) => void;
  /** Switch the sub-tab of the section currently shown. */
  setSub: (section: SettingsSection, sub: string) => void;
  /** Jump to a setting found in search: its section, its sub-tab, and the row to flash. */
  revealSetting: (target: { section: SettingsSection; sub?: string; title: string }) => void;
  clearHighlight: () => void;
  setBootstrapGuard: (reason: string | null) => void;
}

/** How long a search highlight may wait for a row to claim it. A row that matches flashes
 *  and clears it itself; this only disarms a title no mounted row carries (a page heading,
 *  a tile, a row hidden by another setting) — otherwise that row would flash out of the
 *  blue the moment it appeared later. */
const HIGHLIGHT_ARM_MS = 2500;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettingsUi = create<SettingsUiState>((set, get) => ({
  open: false,
  section: "general",
  subs: {},
  highlight: null,
  bootstrapGuard: null,
  openSettings: (section, sub) =>
    set((s) =>
      section
        ? {
            open: true,
            section,
            subs: sub ? { ...s.subs, [section]: sub } : s.subs,
            highlight: null,
          }
        : { open: true },
    ),
  closeSettings: () => set({ open: false, highlight: null }),
  setSection: (section) => set({ section, highlight: null }),
  setSub: (section, sub) =>
    set((s) => ({ subs: { ...s.subs, [section]: sub }, highlight: null })),
  revealSetting: ({ section, sub, title }) => {
    set((s) => ({
      open: true,
      section,
      subs: sub ? { ...s.subs, [section]: sub } : s.subs,
      highlight: title,
    }));
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightTimer = null;
      if (get().highlight === title) set({ highlight: null });
    }, HIGHLIGHT_ARM_MS);
  },
  clearHighlight: () => set({ highlight: null }),
  setBootstrapGuard: (reason) => set({ bootstrapGuard: reason }),
}));
