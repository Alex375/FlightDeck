// Title-bar controls for the voice agent, mirroring SoundToggle's `wf-icon-btn`
// pattern. TWO buttons, matching the two-layer model:
// - VoiceModeToggle (headset): arm/disarm the "session vocale". Armed = fleet
//   events are announced aloud and the mic opens for replies.
// - VoiceMicToggle (mic): open/close the microphone — only rendered while the
//   mode is armed (its keyboard twin, the customizable push-to-talk key, also
//   arms first when pressed from cold).
// Both hidden entirely while no OpenAI key is configured — the feature is
// strictly optional and must not dangle dead buttons. Visibility reads the
// SHARED voiceStore mirror of the Rust status (seeded by VoiceHost, updated
// live by the Settings card) — no cache to go stale.
import { Ico } from "../ui/kit";
import { toggleMic, toggleVoiceMode } from "./realtime";
import { describePtt } from "./pttShortcut";
import { useVoicePrefs } from "./voicePrefs";
import { useVoiceStore } from "./voiceStore";

export function VoiceModeToggle() {
  const phase = useVoiceStore((s) => s.phase);
  const mode = useVoiceStore((s) => s.mode);
  const error = useVoiceStore((s) => s.error);
  const configured = useVoiceStore((s) => s.configured);
  if (configured !== true) return null;

  const title =
    phase === "error" && error
      ? `Voice session error — click to retry — ${error}`
      : phase === "connecting"
        ? "Voice session connecting…"
        : mode
          ? "Voice session armed — fleet events are spoken; click to disarm"
          : "Arm the voice session (announce fleet events, talk to the fleet)";
  return (
    <button
      type="button"
      className={"wf-icon-btn" + (mode ? " on" : "")}
      data-on={mode ? "" : undefined}
      onClick={() => void toggleVoiceMode()}
      title={title}
      aria-label="Toggle the voice session"
      aria-pressed={mode}
    >
      <Ico name="headset" className="sm" />
    </button>
  );
}

export function VoiceMicToggle() {
  const phase = useVoiceStore((s) => s.phase);
  const mode = useVoiceStore((s) => s.mode);
  const micOpen = useVoiceStore((s) => s.micOpen);
  const configured = useVoiceStore((s) => s.configured);
  const shortcut = useVoicePrefs((s) => s.pttShortcut);
  if (configured !== true || !mode) return null;

  const key = describePtt(shortcut);
  const title = micOpen
    ? `Microphone open${phase === "speaking" ? " (agent speaking)" : ""} — click to close (${key})`
    : `Microphone closed — click to talk (${key})`;
  return (
    <button
      type="button"
      className={"wf-icon-btn" + (micOpen ? " on" : "")}
      data-on={micOpen ? "" : undefined}
      onClick={() => void toggleMic()}
      title={title}
      aria-label="Open or close the microphone"
      aria-pressed={micOpen}
    >
      <Ico name="mic" className="sm" />
    </button>
  );
}
