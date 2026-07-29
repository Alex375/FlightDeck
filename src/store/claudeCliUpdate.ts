// Manage updates of the piloted `claude` binary (the CLI Flight Deck drives) — DISTINCT
// from the app's own updater (`store/updater.ts`, which updates Flight Deck itself). Reads
// the installed vs latest-published version from the Rust `cli_update` service, runs
// `claude update` on demand, and reflects/flips the CLI's own background auto-updater. A
// dismissable banner offers the update; dismissal is PER-VERSION (localStorage) so a later
// release re-offers on its own without any explicit re-enable.
import { create } from "zustand";
import { commands } from "../ipc/client";
import type { ClaudeCliStatus } from "../ipc/bindings";

const STORAGE_KEY = "tosse:claudeCliUpdate";

/** The one persisted bit: which `latest_version` the user dismissed. A newer version differs
 *  from it → the banner shows again on its own (no explicit re-enable). */
function loadDismissed(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as { dismissedVersion?: string | null }).dismissedVersion ?? null;
  } catch {
    return null;
  }
}
function saveDismissed(dismissedVersion: string | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dismissedVersion }));
  } catch {
    /* quota / disabled storage — best-effort */
  }
}

interface ClaudeCliUpdateState {
  status: ClaudeCliStatus | null;
  /** A status refresh is in flight. */
  loading: boolean;
  /** `claude update` is running. */
  updating: boolean;
  /** The last `claude update` result line, shown in Settings. */
  updateMessage: string | null;
  /** A loud, actionable error from a manual update / toggle. */
  error: string | null;
  dismissedVersion: string | null;
  /** Re-read installed/latest version + auto-update config. Best-effort — never throws. */
  refresh: () => Promise<void>;
  /** Run `claude update`, then refresh. Non-destructive to the app (only swaps the binary
   *  used at the next session spawn). */
  runUpdate: () => Promise<void>;
  /** Flip the CLI's background auto-updater (optimistic, reverts on failure). */
  setAutoUpdate: (enabled: boolean) => Promise<void>;
  /** Dismiss the banner for the current `latest_version`. */
  dismiss: () => void;
}

export const useClaudeCliUpdate = create<ClaudeCliUpdateState>((set, get) => ({
  status: null,
  loading: false,
  updating: false,
  updateMessage: null,
  error: null,
  dismissedVersion: loadDismissed(),

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const status = await commands.claudeCliStatus();
      set({ status, loading: false });
    } catch (e) {
      // Status is best-effort; don't surface a loud error, just stop loading.
      console.error("claude CLI status failed:", e);
      set({ loading: false });
    }
  },

  runUpdate: async () => {
    if (get().updating) return;
    set({ updating: true, error: null, updateMessage: null });
    try {
      const res = await commands.claudeCliUpdate();
      if (res.status === "ok") set({ updateMessage: res.data.message });
      else set({ error: res.error });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ updating: false });
      await get().refresh();
    }
  },

  setAutoUpdate: async (enabled) => {
    const prev = get().status;
    // Optimistic: reflect the toggle immediately, revert on failure.
    if (prev) set({ status: { ...prev, auto_update_enabled: enabled } });
    try {
      const res = await commands.setClaudeCliAutoUpdate(enabled);
      if (res.status === "error") set({ error: res.error, status: prev });
      else set({ error: null });
    } catch (e) {
      // A thrown IPC rejection must revert the optimistic toggle and surface — never vanish.
      set({ error: e instanceof Error ? e.message : String(e), status: prev });
    }
  },

  dismiss: () => {
    const v = get().status?.latest_version ?? null;
    saveDismissed(v);
    set({ dismissedVersion: v });
  },
}));

/** Whether the update banner should show: an update is available AND the user hasn't
 *  dismissed THIS version. Pure, so it can be unit-tested and shared by the banner. */
export function shouldShowClaudeCliBanner(
  status: ClaudeCliStatus | null,
  dismissedVersion: string | null,
): boolean {
  return (
    !!status &&
    status.update_available &&
    status.latest_version != null &&
    status.latest_version !== dismissedVersion
  );
}

// Boot + periodic re-check. The CLI auto-updates on its own, so a 6h cadence is plenty to
// surface a newly published version. Idempotent — safe under React StrictMode double-invoke.
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
let autoStarted = false;
export function startClaudeCliAutoCheck(): void {
  if (autoStarted) return;
  autoStarted = true;
  const run = () => void useClaudeCliUpdate.getState().refresh();
  run();
  setInterval(run, SIX_HOURS_MS);
}
