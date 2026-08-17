// Agent notification dispatcher. Fires when a session finishes a turn ("done")
// or starts waiting on the user ("attention"), routed from the global session
// event listener (see ipc/useGlobalSessionEvents.ts).
//
// Three independently-toggleable channels (Settings → Notifications): an OS
// banner, a synthesized sound, and a Dock bounce. Each respects its pref and
// fails loudly to the console (never silently) but never throws into the caller.
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { commands } from "../ipc/client";
import { useNotifications } from "../store/notifications";
import { useFlightdeckModal } from "../features/flightdeck/flightdeckModalStore";
import { playChime, type ChimeKind } from "./sound";

/** The plugins/commands only exist inside the Tauri webview; no-op elsewhere. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Cached OS permission grant, primed once at startup by `initNotifications`.
let osGranted = false;

// Conversations the user just interrupted. Interrupting ends the current turn,
// which the core reports as busy→false — indistinguishable from a normal
// completion at the state level. We record the interrupt here and swallow the
// single "done" that follows, so stopping an agent doesn't ping the user about
// work they halted themselves. Timestamped so a flag that's never consumed (no
// result followed) goes stale instead of muting a genuine later completion.
const interruptedAt = new Map<string, number>();
const INTERRUPT_WINDOW_MS = 15_000;

/** Record that the user interrupted `convId`'s current turn. */
export function noteInterrupt(convId: string): void {
  interruptedAt.set(convId, Date.now());
}

/** Whether `convId` was interrupted within the window; consumes the flag. */
function consumeInterrupt(convId: string): boolean {
  const ts = interruptedAt.get(convId);
  if (ts === undefined) return false;
  interruptedAt.delete(convId);
  return Date.now() - ts < INTERRUPT_WINDOW_MS;
}

/**
 * Same check WITHOUT consuming — the app-control event journal peeks before
 * publishing a `turn_completed` (an interrupted turn is a non-completion the
 * voice agent must not hear either), while `dispatchAgentNotification` still
 * consumes the flag to swallow the human ping. Peek-then-consume is safe: both
 * run synchronously in the same `fireAgentNotification` call.
 */
export function peekInterrupt(convId: string): boolean {
  const ts = interruptedAt.get(convId);
  return ts !== undefined && Date.now() - ts < INTERRUPT_WINDOW_MS;
}

// Notifications armed but not yet delivered, at most one per conversation: a state
// edge arms one, and the conversation has a short window to prove the edge meant what
// it looked like before it reaches the user (see `SETTLE_MS` in transition.ts). The
// caller owns the policy — this only holds the timers, so nothing here needs the
// conversation stores.
const armedNotifications = new Map<
  string,
  { kind: ChimeKind; timer: ReturnType<typeof setTimeout> }
>();

/**
 * Arm `fire` for `convId` after `delayMs`, replacing anything already armed for it —
 * the newest edge is always the one that describes the conversation. `fire` runs with
 * the entry already dropped, so it is free to arm again.
 */
export function armAgentNotification(
  convId: string,
  kind: ChimeKind,
  delayMs: number,
  fire: () => void,
): void {
  cancelAgentNotification(convId);
  const timer = setTimeout(() => {
    armedNotifications.delete(convId);
    fire();
  }, delayMs);
  armedNotifications.set(convId, { kind, timer });
}

/** What is armed for `convId` right now, or null — so the caller can re-check it. */
export function armedAgentNotificationKind(convId: string): ChimeKind | null {
  return armedNotifications.get(convId)?.kind ?? null;
}

/** Drop `convId`'s armed notification, if any. Idempotent. */
export function cancelAgentNotification(convId: string): void {
  const armed = armedNotifications.get(convId);
  if (!armed) return;
  clearTimeout(armed.timer);
  armedNotifications.delete(convId);
}

/**
 * Ask the OS for notification permission once at launch, so the first real
 * notification doesn't race a permission prompt. Best-effort: a denial just
 * means the system channel stays silent (sound/dock still work).
 */
export async function initNotifications(): Promise<void> {
  if (!inTauri()) return;
  try {
    osGranted = await isPermissionGranted();
    if (!osGranted) osGranted = (await requestPermission()) === "granted";
  } catch (e) {
    console.error("notification permission init failed:", e);
  }
}

export interface AgentNotification {
  kind: ChimeKind; // "done" | "attention"
  /** Stable conversation id, to compare against the active selection. */
  convId: string;
  /** Conversation name, shown in the banner. */
  title: string;
  /** Repo basename, appended for context (null if unknown). */
  repoName: string | null;
  /** The currently-selected conversation id (for the focus-suppression check). */
  activeId: string | null;
}

/**
 * Fire the enabled notification channels for an agent event.
 *
 * The SOUND plays regardless of focus: the user wants to HEAR that the agent
 * finished / needs attention even while looking at that very conversation. The
 * OS banner and Dock bounce, on the other hand, are redundant when the user is
 * already watching this exact conversation (window focused AND it's the active
 * one) — those two are suppressed in that case, the chime is not.
 */
export function dispatchAgentNotification(ev: AgentNotification): void {
  // A user-initiated interrupt ends the turn just like a normal completion;
  // consume the flag and skip the whole event (chime included) so a self-halted
  // agent stays fully quiet.
  if (ev.kind === "done" && consumeInterrupt(ev.convId)) return;

  const prefs = useNotifications.getState();

  // Sound is decoupled from focus (see doc-comment): play it whenever enabled.
  if (prefs.sound) {
    try {
      playChime(ev.kind);
    } catch (e) {
      console.error("notification sound failed:", e);
    }
  }

  // Banner + Dock only when the user isn't already watching this conversation —
  // no point stacking an OS banner over the window they're staring at. "Watching"
  // has TWO surfaces now: the active selection (full conversation view) AND the
  // Flight Deck reply modal, which opens a conversation by id WITHOUT changing the
  // active selection — so we also treat its open conversation as watched (it's only
  // ever set while the modal is visible on the deck).
  const modalConvId = useFlightdeckModal.getState().convId;
  const watching =
    typeof document !== "undefined" &&
    document.hasFocus() &&
    (ev.convId === ev.activeId || ev.convId === modalConvId);
  if (watching) return;

  if (prefs.systemNotification) sendOsNotification(ev);

  if (prefs.dockBounce && inTauri()) {
    // Critical (bounces until focused) when input is needed; informational
    // (one bounce) when a turn merely finished.
    void commands
      .requestUserAttention(ev.kind === "attention")
      .then((r) => {
        if (r.status !== "ok") console.error("dock bounce failed:", r.error);
      })
      .catch((e) => console.error("dock bounce threw:", e));
  }
}

/**
 * A free-form notification requested BY an agent (the app-control `notify_user`
 * tool) — distinct from the state-transition notifications above: the agent
 * explicitly asked for it, so it skips the focus gate and the arming/settling
 * machinery. It does NOT skip the user's channel toggles: Settings →
 * Notifications governs WHICH channels may fire, agent-requested or not — an
 * agent must never be louder than the user allowed. Returns which channels
 * actually fired so the tool can tell the agent when everything was off.
 */
export function notifyFromAgent(
  message: string,
  critical: boolean,
): { banner: boolean; dock: boolean; sound: boolean } {
  const prefs = useNotifications.getState();
  if (prefs.sound) {
    try {
      playChime(critical ? "attention" : "done");
    } catch (e) {
      console.error("notification sound failed:", e);
    }
  }
  if (prefs.systemNotification) fireOsNotification("Flight Deck agent", message);
  const dock = prefs.dockBounce && inTauri();
  if (dock) {
    void commands
      .requestUserAttention(critical)
      .then((r) => {
        if (r.status !== "ok") console.error("dock bounce failed:", r.error);
      })
      .catch((e) => console.error("dock bounce threw:", e));
  }
  return {
    banner: prefs.systemNotification && inTauri(),
    dock,
    sound: prefs.sound,
  };
}

/** Send one OS notification (permission-aware). Shared by the transition path
 *  and the agent-requested path. */
function fireOsNotification(title: string, body: string): void {
  if (!inTauri()) return;
  const fire = () => {
    try {
      sendNotification({ title, body });
    } catch (e) {
      console.error("notification send failed:", e);
    }
  };
  if (osGranted) {
    fire();
    return;
  }
  // Not granted yet (init denied/raced): try once more, then send if allowed.
  void (async () => {
    try {
      osGranted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
      if (osGranted) fire();
    } catch (e) {
      console.error("notification permission re-check failed:", e);
    }
  })();
}

function sendOsNotification(ev: AgentNotification): void {
  const where = ev.repoName ? ` · ${ev.repoName}` : "";
  const title = ev.kind === "attention" ? "Action required" : "Agent finished";
  const body =
    ev.kind === "attention"
      ? `${ev.title}${where} needs your attention.`
      : `${ev.title}${where} finished.`;
  fireOsNotification(title, body);
}

/** Play just the chime — used by the Settings "Test sound" button. */
export function testSound(kind: ChimeKind = "done"): void {
  try {
    playChime(kind);
  } catch (e) {
    console.error("notification sound failed:", e);
  }
}
