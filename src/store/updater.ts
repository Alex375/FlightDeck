// Auto-update state machine. Thin wrapper around the official, signature-verified
// Tauri updater (`@tauri-apps/plugin-updater`): we never download/replace the
// binary ourselves — the plugin verifies the cryptographic signature (pubkey in
// tauri.conf.json) before installing, then `@tauri-apps/plugin-process` relaunches.
//
// Checks run on launch and every 2h while the app is open (see startUpdaterAutoCheck),
// plus on demand from the Settings "Check for updates" button.
import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterStatus =
  | "idle" // nothing checked yet
  | "checking" // querying the release manifest
  | "available" // a newer signed version exists, not installed yet
  | "downloading" // fetching the artifact
  | "installing" // verified + applying, about to relaunch
  | "uptodate" // checked, already on the latest
  | "error";

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  notes?: string;
}

/** Whether the app's own update banner is showing. Pure, so it can be unit-tested AND read by
 *  the OTHER banner (the piloted `claude` binary's) to stand down: two stacked accent strips at
 *  the top of the window is noise, and updating the APP is the more consequential of the two
 *  (it restarts and kills live sessions), so it takes the slot. The CLI offer is not lost — it
 *  stays in Settings → Updates and the banner returns on its own once this one clears. */
export function isUpdateBannerVisible(
  status: UpdaterStatus,
  update: AvailableUpdate | null,
): boolean {
  return (
    !!update &&
    // `checking` counts ONLY because `update` is still in hand: a periodic re-check flips the
    // status for a moment without retracting the offer, and dropping the banner there made it
    // blink — taking the CLI banner in and out of the freed slot with it. A check that finds
    // nothing clears `update`, so the banner still goes away when it should.
    (status === "available" ||
      status === "checking" ||
      status === "downloading" ||
      status === "installing")
  );
}

/** Separator in a release body: everything AFTER it is GitHub-page-only (the
 *  self-signed / Gatekeeper install instructions, useful for a manual .dmg download
 *  but pointless for the in-app auto-updater). See `.github/workflows/release.yml`. */
export const GH_ONLY_MARKER = "<!-- gh-only -->";

// Legacy releases (before the CHANGELOG-driven body) shipped ONLY the Gatekeeper /
// install boilerplate as their body, with no marker. Recognise it so those notes
// don't leak into the app as if they were the "what's new".
const LEGACY_INSTALL_BOILERPLATE =
  /non notaris|clic droit\s*→\s*ouvrir|build automatique depuis|not notariz|right-click\s*→\s*open|automatic build from/i;

/**
 * The user-facing "what's new" to show IN-APP, extracted from a raw release body.
 * Keeps only the part before {@link GH_ONLY_MARKER} (the changelog); drops the
 * GitHub-only install note. Returns null when there is nothing meaningful to show —
 * empty, or a legacy install-only body — so the UI can fall back to a neutral line.
 */
export function inAppReleaseNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const idx = notes.indexOf(GH_ONLY_MARKER);
  const text = (idx >= 0 ? notes.slice(0, idx) : notes).trim();
  // No marker + looks like the legacy install-only body → nothing worth surfacing.
  if (idx < 0 && LEGACY_INSTALL_BOILERPLATE.test(text)) return null;
  return text.length > 0 ? text : null;
}

interface UpdaterState {
  status: UpdaterStatus;
  update: AvailableUpdate | null;
  /** Download progress, bytes. `total` is null until the server reports a length. */
  progress: { downloaded: number; total: number | null } | null;
  /** Loud, actionable error (a manual check or an install that failed). */
  error: string | null;
  /** Last check failure, recorded even for silent auto-checks so a broken release
   *  endpoint stays discoverable in Settings (never a fully silent failure). */
  lastCheckError: string | null;
  lastCheckedAt: number | null;
  /** Query the manifest. `silent` (auto checks) never flips to the error status,
   *  but still records the failure in `lastCheckError`. */
  check: (opts?: { silent?: boolean }) => Promise<void>;
  /** Download + verify + install the pending update, then relaunch onto it. */
  install: () => Promise<void>;
}

// The Update handle (a Rust-side Resource with download/install methods) is not
// React state — it isn't serialisable and we only ever act on the latest one.
let pending: Update | null = null;

// Release the previous Update handle: each positive check allocates a Resource
// (rid) on the Rust side; replacing `pending` (every 2h auto-check) or finishing
// an install without closing the old one leaks resources over a long session.
function discardPending(): void {
  const p = pending;
  pending = null;
  if (p) void p.close().catch(() => {});
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// The updater only exists inside the Tauri webview; in a plain browser (or the
// mock IPC dev server) we no-op rather than throw.
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  update: null,
  progress: null,
  error: null,
  lastCheckError: null,
  lastCheckedAt: null,

  check: async (opts) => {
    const silent = opts?.silent ?? false;
    const busy = get().status;
    if (busy === "checking" || busy === "downloading" || busy === "installing") return;
    if (!inTauri()) return;

    set({ status: "checking", ...(silent ? {} : { error: null }) });
    try {
      const found = await check();
      discardPending(); // close the previous handle before replacing it
      if (found) {
        pending = found;
        set({
          status: "available",
          error: null,
          lastCheckError: null,
          lastCheckedAt: Date.now(),
          update: {
            version: found.version,
            currentVersion: found.currentVersion,
            date: found.date ?? undefined,
            notes: found.body ?? undefined,
          },
        });
      } else {
        set({
          status: "uptodate",
          update: null,
          error: null,
          lastCheckError: null,
          lastCheckedAt: Date.now(),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("update check failed:", msg);
      // Record the failure ALWAYS (even silent) so a broken release endpoint is
      // discoverable in Settings. A manual check additionally flips to `error`.
      if (!silent) {
        set({ status: "error", error: msg, lastCheckError: msg, lastCheckedAt: Date.now() });
      } else {
        set({
          status: get().update ? "available" : "idle",
          lastCheckError: msg,
          lastCheckedAt: Date.now(),
        });
      }
    }
  },

  install: async () => {
    if (!pending) return;
    const busy = get().status;
    if (busy === "downloading" || busy === "installing") return;
    set({ status: "downloading", progress: { downloaded: 0, total: null }, error: null });
    try {
      let downloaded = 0;
      let total: number | null = null;
      await pending.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            set({ progress: { downloaded: 0, total } });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            set({ progress: { downloaded, total } });
            break;
          case "Finished":
            set({ status: "installing" });
            break;
        }
      });
      // Verified, installed — restart onto the new version. The plugin has already
      // rejected anything with a bad/absent signature before reaching here.
      discardPending();
      await relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("update install failed:", msg);
      // Keep the detected update visible (pending is still valid) so the user can
      // retry; surface the error rather than hiding the update behind a recheck.
      set({ status: "available", error: msg, progress: null });
    }
  },
}));

// Kick the periodic check loop: once now, then every 2h. Idempotent — safe to
// call from a React effect that may run twice (StrictMode).
let autoStarted = false;
export function startUpdaterAutoCheck(): void {
  if (autoStarted || !inTauri()) return;
  autoStarted = true;
  const run = () => void useUpdater.getState().check({ silent: true });
  run();
  setInterval(run, TWO_HOURS_MS);
}
