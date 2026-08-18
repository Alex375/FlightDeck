// App-control policy — may agents pilot the app itself? Persisted to localStorage
// (same lightweight pattern as permissions.ts / notifications.ts): it's a user
// policy, not domain data, so it doesn't belong in the SQLite metadata store.
//
// This store holds ONLY the policy for the IN-PROCESS server (the "flightdeck"
// SDK MCP server each Claude session can advertise). The voice bridge — the
// loopback HTTP server for an external voice agent — is configured through the
// Rust core instead (`voice_bridge_status` / `set_voice_bridge`), because its
// listener must be able to start with the app, before the webview settles.
import { create } from "zustand";

const STORAGE_KEY = "tosse:appcontrol";

export interface AppControlPrefs {
  /** Expose the in-process "flightdeck" MCP server to NEW Claude sessions.
   *
   *  On: a conversation spawned from now on advertises the app-piloting tools
   *  (open files in the editor, switch views, create/read/message the other
   *  conversations, notify the user…). Off: sessions spawn with the exact
   *  pre-MCP wire — the agent doesn't even see the server.
   *
   *  Like the bypass unlock, this is decided AT SPAWN (the `initialize`
   *  handshake advertises it once): flipping it changes new sessions only, a
   *  live conversation keeps what it started with until restarted.
   *
   *  ON by default: piloting the app is the point of the feature, and every
   *  exposed tool is non-destructive by design (no permission-mode changes, no
   *  deletes, no rewind — see the Rust-side catalogue). */
  agentServer: boolean;
}

const DEFAULTS: AppControlPrefs = {
  agentServer: true,
};

function load(): AppControlPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    // Merge over defaults so a newly-added pref defaults sanely for existing users.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppControlPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: AppControlPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* quota / disabled storage — best-effort, ignore */
  }
}

interface AppControlState extends AppControlPrefs {
  /** Patch one or more prefs and persist. */
  set: (patch: Partial<AppControlPrefs>) => void;
}

export const useAppControlPrefs = create<AppControlState>((set) => ({
  ...load(),
  set: (patch) =>
    set((s) => {
      const next: AppControlPrefs = {
        agentServer: patch.agentServer ?? s.agentServer,
      };
      save(next);
      return next;
    }),
}));

/** Read the current policy outside React (spawn path). */
export function agentServerEnabled(): boolean {
  return useAppControlPrefs.getState().agentServer;
}
