import { Ico, Menu, MenuItem, MenuLabel } from "./kit";
import { useCaffeinate, type CaffeinateMode } from "../store/caffeinate";
import { useNotifications } from "../store/notifications";
import { toggleMic, toggleVoiceMode } from "../voice/realtime";
import { describePtt } from "../voice/pttShortcut";
import { useVoicePrefs } from "../voice/voicePrefs";
import { useVoiceStore } from "../voice/voiceStore";

const CAFFEINATE_MODE_LABEL: Record<CaffeinateMode, string> = {
  light: "Light — follow the agents",
  hard: "Hard — always awake",
};

/**
 * Title-bar tray for the app-wide switches: the voice session and its microphone, the
 * notification sound, and Caffeinate (keep the Mac awake). One pill of bare glyphs, each a
 * ONE-click toggle that lights up while on; Caffeinate adds a small chevron to pick its mode.
 *
 * Every button drives the SAME store/action as Settings, so both stay in sync, and the ⌘⇧M
 * chord (App.tsx) and the push-to-talk key (VoiceHost) keep working untouched. The voice
 * buttons only exist while an OpenAI key is configured, and the mic only while the voice
 * session is armed: the feature is strictly optional and must never dangle dead controls.
 * Caffeinate only ARMS here; whether the Mac is actually held awake depends on its mode
 * (Light follows fleet activity, Hard is permanent) — CaffeinateHost turns "armed + mode +
 * activity" into the real assertion.
 */
export function SystemTray() {
  const voiceConfigured = useVoiceStore((s) => s.configured) === true;
  const voicePhase = useVoiceStore((s) => s.phase);
  const voiceMode = useVoiceStore((s) => s.mode);
  const voiceError = useVoiceStore((s) => s.error);
  const micOpen = useVoiceStore((s) => s.micOpen);
  const pttShortcut = useVoicePrefs((s) => s.pttShortcut);
  const sound = useNotifications((s) => s.sound);
  const toggleSound = useNotifications((s) => s.toggleSound);
  const caffeinate = useCaffeinate((s) => s.enabled);
  const caffeinateMode = useCaffeinate((s) => s.mode);
  const setCaffeinate = useCaffeinate((s) => s.set);
  const toggleCaffeinate = useCaffeinate((s) => s.toggleEnabled);

  const voiceFailed = voicePhase === "error" && !!voiceError;
  const pttKey = describePtt(pttShortcut);
  const modeName = caffeinateMode === "hard" ? "Hard" : "Light";

  return (
    <div className="wf-tray" role="group" aria-label="System switches">
      {voiceConfigured ? (
        <TrayButton
          icon="headset"
          on={voiceMode}
          err={voiceFailed}
          label="Toggle the voice session"
          title={
            voiceFailed
              ? `Voice session error — click to retry — ${voiceError}`
              : voicePhase === "connecting"
                ? "Voice session connecting…"
                : voiceMode
                  ? "Voice session armed — fleet events are spoken; click to disarm"
                  : "Arm the voice session (announce fleet events, talk to the fleet)"
          }
          onClick={() => void toggleVoiceMode()}
        />
      ) : null}
      {voiceConfigured && voiceMode ? (
        <TrayButton
          icon="mic"
          on={micOpen}
          label="Open or close the microphone"
          title={
            micOpen
              ? `Microphone open${voicePhase === "speaking" ? " (agent speaking)" : ""} — click to close (${pttKey})`
              : `Microphone closed — click to talk (${pttKey})`
          }
          onClick={() => void toggleMic()}
        />
      ) : null}
      <TrayButton
        icon={sound ? "volume" : "mute"}
        on={sound}
        label="Toggle notification sound"
        title={sound ? "Notification sound on — mute (⌘⇧M)" : "Notification sound off — turn on (⌘⇧M)"}
        onClick={toggleSound}
      />
      <TrayButton
        icon="coffee"
        on={caffeinate}
        label="Toggle Caffeinate (keep the Mac awake)"
        title={
          caffeinate
            ? caffeinateMode === "hard"
              ? "Keeping the Mac awake (Hard) — click to let it sleep"
              : "Keeping the Mac awake while agents work (Light) — click to let it sleep"
            : `Let the Mac sleep — click to keep it awake (${modeName})`
        }
        onClick={toggleCaffeinate}
      />
      <Menu
        align="right"
        portal
        trigger={
          <button
            type="button"
            className="wf-tray-more"
            title={`Caffeinate mode: ${modeName}`}
            aria-label="Choose the Caffeinate mode"
          >
            <Ico name="chev" className="sm" />
          </button>
        }
      >
        <MenuLabel>Caffeinate mode</MenuLabel>
        {(["light", "hard"] as const).map((m) => (
          <MenuItem key={m} on={caffeinateMode === m} onClick={() => setCaffeinate({ mode: m })}>
            {CAFFEINATE_MODE_LABEL[m]}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}

/** One switch in the pill: a bare glyph that lights up while on (red if it failed). */
function TrayButton({
  icon,
  on,
  err,
  label,
  title,
  onClick,
}: {
  icon: string;
  on: boolean;
  err?: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="wf-tray-b"
      data-on={on ? "" : undefined}
      data-err={err ? "" : undefined}
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-pressed={on}
    >
      <Ico name={icon} className="sm" />
    </button>
  );
}
