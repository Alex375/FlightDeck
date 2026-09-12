// Settings panel open state + which section it should land on. A tiny shared
// slice so the panel can be opened from anywhere — the sidebar "Settings" entry
// AND deep-links (e.g. the update banner → "updates") both flip the same flag
// (same pattern as worktreeUiStore).
import { create } from "zustand";

/** The settings sections, mirrored by the panel's left-rail tabs. */
export type SettingsSection =
  | "general"
  | "accounts"
  | "tosse"
  // "conversation" now bundles the Markdown mode, the model picker and the composer bar
  // behind its own sub-tabs (was three separate top-level tabs: conversation/models/composer).
  | "conversation"
  | "behavior"
  /** Claude-specific settings: sub-agent routing, spend, and the instructions file.
   *  Backend-specific ON PURPOSE — its whole content is Claude model names and Claude
   *  file layout, so it is shown only while a Claude account is connected, and a Codex
   *  twin would be its own tab rather than an abstraction over both. */
  | "claudeCode"
  | "reordering"
  | "shortcuts"
  | "control"
  // "notifications" now bundles the OS channels, the fleet readout and the background-task
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
   * that carry a lot of unrelated cards (General, Conversation, MCP Control,
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
  /** Open the panel, optionally jumping straight to `section`. */
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  /** Switch the active section while the panel is open. */
  setSection: (section: SettingsSection) => void;
  /** Switch the sub-tab of the section currently shown. */
  setSub: (section: SettingsSection, sub: string) => void;
  /** Jump to a setting found in search: its section, its sub-tab, and the row to flash. */
  revealSetting: (target: { section: SettingsSection; sub?: string; title: string }) => void;
  clearHighlight: () => void;
}

export const useSettingsUi = create<SettingsUiState>((set) => ({
  open: false,
  section: "general",
  subs: {},
  highlight: null,
  openSettings: (section) =>
    set(section ? { open: true, section, highlight: null } : { open: true }),
  closeSettings: () => set({ open: false, highlight: null }),
  setSection: (section) => set({ section, highlight: null }),
  setSub: (section, sub) =>
    set((s) => ({ subs: { ...s.subs, [section]: sub }, highlight: null })),
  revealSetting: ({ section, sub, title }) =>
    set((s) => ({
      open: true,
      section,
      subs: sub ? { ...s.subs, [section]: sub } : s.subs,
      highlight: title,
    })),
  clearHighlight: () => set({ highlight: null }),
}));
