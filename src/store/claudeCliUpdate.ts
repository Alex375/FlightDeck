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

/** Status reads are SERIALIZED on this chain rather than coalesced behind an `if (loading) return`
 *  guard. Awaiting `refresh()` must observe a read that STARTED after the caller's own write —
 *  a plain busy-guard would skip it outright and leave `setAutoUpdate`'s optimistic value
 *  standing, and sharing an already-in-flight read could answer with pre-write state. Reads are
 *  rare (mount / 20s boot / 6h / after a write), so serializing costs nothing. */
let readChain: Promise<void> = Promise.resolve();

/** Bumped on every accepted auto-update write. A status read that STARTED before the bump is
 *  answering about PRE-write state, so applying it would bounce the switch back to its old
 *  position for a full probe cycle before the post-write read corrects it. Such a read is
 *  dropped instead — the read queued right after the write carries the truth. */
let writeEpoch = 0;

interface ClaudeCliUpdateState {
  status: ClaudeCliStatus | null;
  /** A status refresh is in flight (drives the "Checking…" button state). */
  loading: boolean;
  /** `claude update` is running. */
  updating: boolean;
  /** The last `claude update` result line, shown in Settings. */
  updateMessage: string | null;
  /** A failed `claude update` — the ONLY error the banner may show, since its retry button
   *  runs an update. Kept separate from {@link toggleError} so a failed auto-update SWITCH
   *  never renders as "Update failed" next to a "Retry" that would run something else. */
  error: string | null;
  /** A failed auto-update toggle. Settings-only (that's where the switch lives). */
  toggleError: string | null;
  dismissedVersion: string | null;
  /** Re-read installed/latest version + auto-update config. Never throws; resolves `false` when
   *  the read itself failed, so a caller that DEPENDS on the re-read (`setAutoUpdate` confirming
   *  a write actually took) can say so instead of leaving stale state on screen unannounced. */
  refresh: () => Promise<boolean>;
  /** Run `claude update`, then refresh. Non-destructive to the app (only swaps the binary
   *  used at the next session spawn). */
  runUpdate: () => Promise<void>;
  /** Flip the CLI's background auto-updater, then re-read from disk. Optimistic, reverts on
   *  failure. */
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
  toggleError: null,
  dismissedVersion: loadDismissed(),

  refresh: () => {
    const run = async (): Promise<boolean> => {
      const epoch = writeEpoch;
      set({ loading: true });
      try {
        const status = await commands.claudeCliStatus();
        // A write landed while this read was out: its answer is already stale (see `writeEpoch`).
        // Drop it — not a failure, so the caller still sees success.
        if (epoch !== writeEpoch) {
          set({ loading: false });
          return true;
        }
        set({ status, loading: false });
        return true;
      } catch (e) {
        // Status is best-effort by design (the Rust side never errors — a missing binary and an
        // unreachable registry are both reported as `null` fields, which the panel renders as
        // "Unknown"). Only an IPC-level failure lands here: log it, stop loading, and report the
        // failure to the caller rather than pretending the state on screen is current.
        console.error("claude CLI status failed:", e);
        set({ loading: false });
        return false;
      }
    };
    // Queue behind any read already running (see `readChain`), never skip. The chain itself
    // carries no value — each caller gets its OWN read's outcome.
    const queued = readChain.then(run, run);
    readChain = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
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
    const prevEnabled = get().status?.auto_update_enabled;
    // Optimistic: reflect the toggle immediately, revert on failure. A fresh attempt starts from
    // a clean slate — otherwise a previous failure's message would sit next to a new success.
    const cur = get().status;
    set({ toggleError: null, ...(cur ? { status: { ...cur, auto_update_enabled: enabled } } : {}) });
    // Undo ONLY our optimistic field, against whatever the status is by then — restoring the
    // whole pre-write snapshot would throw away a refresh that landed while the write was in
    // flight (stale versions back on screen as a side effect of a failed switch).
    const revert = () => {
      const now = get().status;
      if (now && prevEnabled !== undefined) {
        set({ status: { ...now, auto_update_enabled: prevEnabled } });
      }
    };
    try {
      const res = await commands.setClaudeCliAutoUpdate(enabled);
      if (res.status === "error") {
        revert();
        set({ toggleError: res.error });
        return;
      }
      // Invalidate any read still in flight from before this write (see `writeEpoch`).
      writeEpoch++;
      // The write SUCCEEDED, which is not the same as the setting having taken: another gate
      // (`~/.claude.json`) or a concurrent writer can still hold it off. Re-read from disk so
      // the switch shows what the CLI will ACTUALLY do, instead of leaving the optimistic
      // value standing until the next mount. If that re-read itself fails, the switch is showing
      // an UNCONFIRMED value — say so rather than let it pass for settled state.
      if (!(await get().refresh())) {
        set({
          toggleError: "Saved, but the current setting could not be read back — reopen Settings.",
        });
      }
    } catch (e) {
      // A thrown IPC rejection must revert the optimistic toggle and surface — never vanish.
      revert();
      set({ toggleError: e instanceof Error ? e.message : String(e) });
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
/** The first check is DEFERRED, not skipped: it spawns `claude --version` (and, only if that
 *  finds a binary, one registry request), which has no business competing with app startup for
 *  a banner nobody is waiting on. Opening Settings → Updates refreshes on mount anyway, so the
 *  panel is never stale because of this delay. */
const FIRST_CHECK_DELAY_MS = 20_000;
let autoStarted = false;
export function startClaudeCliAutoCheck(): void {
  if (autoStarted) return;
  autoStarted = true;
  const run = () => void useClaudeCliUpdate.getState().refresh();
  setTimeout(run, FIRST_CHECK_DELAY_MS);
  setInterval(run, SIX_HOURS_MS);
}
