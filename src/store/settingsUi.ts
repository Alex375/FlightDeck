// Settings panel open state + which section it should land on. A tiny shared
// slice so the panel can be opened from anywhere — the sidebar "Settings" entry
// AND deep-links (e.g. the update banner → "updates") both flip the same flag
// (same pattern as worktreeUiStore).
import { create } from "zustand";

/** The settings sections, mirrored by the panel's left-rail tabs. */
export type SettingsSection =
  | "general"
  | "accounts"
  | "conversation"
  | "reordering"
  | "shortcuts"
  | "notifications"
  | "updates"
  | "data";

interface SettingsUiState {
  open: boolean;
  /** The section to show when (re)opened. Persists across opens. */
  section: SettingsSection;
  /** Open the panel, optionally jumping straight to `section`. */
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  /** Switch the active section while the panel is open. */
  setSection: (section: SettingsSection) => void;
}

export const useSettingsUi = create<SettingsUiState>((set) => ({
  open: false,
  section: "general",
  openSettings: (section) => set(section ? { open: true, section } : { open: true }),
  closeSettings: () => set({ open: false }),
  setSection: (section) => set({ section }),
}));
