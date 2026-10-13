// What this build cannot offer on the OS it runs on (Linux, for now: keep-awake and "Open in
// terminal"), as reported once by the Rust core (`platform_limits`) — constants of the build.
// Every field is `null` on macOS, where everything exists.
//
// `limits` stays `null` until the read lands, and `null` reads as "nothing is limited", so on
// macOS the app behaves exactly as it did before this read existed. Kept in memory only: the
// answer is fixed for the build, there is nothing to persist.
import { create } from "zustand";
import { commands, type PlatformLimits } from "../ipc/client";
import { useAppErrors } from "./appErrors";

interface PlatformLimitsState {
  /** `null` until the boot read lands. */
  limits: PlatformLimits | null;
}

export const usePlatformLimits = create<PlatformLimitsState>(() => ({ limits: null }));

let requested = false;

/** Read the limits from the core, once per app run (called at boot). A failed read is
 *  surfaced, never swallowed: the app would otherwise offer features that cannot work. */
export function loadPlatformLimits(): void {
  if (requested) return;
  requested = true;
  commands.platformLimits().then(
    (limits) => usePlatformLimits.setState({ limits }),
    (e: unknown) =>
      useAppErrors
        .getState()
        .pushError("Couldn't read which features this platform supports.", String(e)),
  );
}

/** Test-only: forget the boot read, so each test starts from "not read yet". */
export function __resetPlatformLimitsForTests(): void {
  requested = false;
  usePlatformLimits.setState({ limits: null });
}

/** Why keep-awake (every Caffeinate mode) is unavailable here, or `null` when it works. */
export function useKeepAwakeUnavailable(): string | null {
  return usePlatformLimits((s) => s.limits?.keep_awake ?? null);
}

/** Why "Open in terminal" is unavailable here, or `null` when it works. */
export function useOpenInTerminalUnavailable(): string | null {
  return usePlatformLimits((s) => s.limits?.open_in_terminal ?? null);
}
