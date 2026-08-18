// Title-bar toggle for the voice agent (push-to-talk). Mirrors SoundToggle
// (`wf-icon-btn`), lit while a session is live, phase in the tooltip. Hidden
// entirely while no OpenAI key is configured — the feature is strictly
// optional and must not dangle a dead button (the Settings card explains how
// to enable it). Visibility reads the SHARED voiceStore mirror of the Rust
// status (seeded by VoiceHost, updated live by the Settings card), so saving a
// key makes the chip appear immediately — no cache to go stale. ⌘⇧V (in
// appActions) dispatches the same toggle.
import { Ico } from "../ui/kit";
import { toggleVoiceSession } from "./realtime";
import { useVoiceStore } from "./voiceStore";

const PHASE_LABEL: Record<string, string> = {
  off: "Voice agent — start talking (⌘⇧V)",
  connecting: "Voice agent connecting…",
  listening: "Voice agent listening — click to hang up (⌘⇧V)",
  speaking: "Voice agent speaking — click to hang up (⌘⇧V)",
  saying: "Voice agent announcing — click to talk (⌘⇧V)",
  error: "Voice agent error — click to retry (⌘⇧V)",
};

export function VoiceToggle() {
  const phase = useVoiceStore((s) => s.phase);
  const error = useVoiceStore((s) => s.error);
  const configured = useVoiceStore((s) => s.configured);
  if (configured !== true) return null;

  const live = phase !== "off" && phase !== "error";
  const title = phase === "error" && error ? `${PHASE_LABEL.error} — ${error}` : PHASE_LABEL[phase];
  return (
    <button
      type="button"
      className={"wf-icon-btn" + (live ? " on" : "")}
      data-on={live ? "" : undefined}
      onClick={() => void toggleVoiceSession()}
      title={title}
      aria-label="Toggle the voice agent"
      aria-pressed={live}
    >
      <Ico name="mic" className="sm" />
    </button>
  );
}
