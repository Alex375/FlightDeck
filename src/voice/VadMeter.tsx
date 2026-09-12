// Microphone level meter for Settings — "is my mic alive, and is it hearing me?"
//
// ⚠️ It used to be more than that, and that was the problem. The threshold was a
// draggable handle overlaid on THIS bar, with copy telling you to drop it just
// above your noise floor — Discord's input-sensitivity model. That comparison
// cannot hold: OpenAI's `server_vad.threshold` is a CONFIDENCE from their own
// speech detector, not a loudness, so no level bar can be calibrated against it.
// The two numbers never shared a scale, and the arithmetic made it visible —
// speech (RMS ≈ 0.05) drew 16% of a bar whose handle sat at 60%, so the level
// could not reach the handle no matter how loud you spoke. Following the
// instruction drove the threshold to its minimum.
//
// So the meter now claims only what it can prove: how loud the input is, on a
// dBFS scale, through the SAME constraints the live session opens the mic with
// (`mic.ts`) — what you see here is what the agent hears. The threshold is its
// own control, with its own words, next to it.
import { useEffect, useRef, useState } from "react";
import { describeMicSettings, levelToBar, openVoiceMic, rms } from "./mic";
import styles from "./VadMeter.module.css";

interface Props {
  /** Classes so the button matches the surrounding settings styling. */
  buttonClassName?: string;
  disabled?: boolean;
}

export function VadMeter({ buttonClassName, disabled }: Props) {
  const [active, setActive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [micInfo, setMicInfo] = useState<string | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let smoothed = 0;

    const stopStream = () => stream?.getTracks().forEach((t) => t.stop());

    const start = async () => {
      try {
        stream = await openVoiceMic();
        if (stopped) return stopStream();
        setMicInfo(describeMicSettings(stream));
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          const level = levelToBar(rms(buf));
          smoothed = smoothed * 0.7 + level * 0.3; // attack/decay smoothing
          const el = fillRef.current;
          if (el) el.style.width = `${Math.round(smoothed * 100)}%`;
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setErr(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "microphone access denied — allow it in System Settings → Privacy & Security → Microphone"
            : `microphone unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        setActive(false);
      }
    };

    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stopStream();
      void ctx?.close().catch(() => {});
      const el = fillRef.current;
      if (el) el.style.width = "0%";
    };
  }, [active]);

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <div className={styles.track}>
          <div ref={fillRef} className={styles.fill} />
        </div>
        <button
          type="button"
          className={buttonClassName}
          onClick={() => {
            setErr(null);
            setMicInfo(null);
            setActive((a) => !a);
          }}
          disabled={disabled}
        >
          {active ? "Stop" : "Test mic"}
        </button>
      </div>
      <div className={styles.hint}>
        {active
          ? "Speak normally: the bar should move clearly when you talk and sit low when you stop. If it barely moves, the wrong input device is selected or the mic is muted."
          : "Check that the microphone the agent uses is picking you up."}
        {micInfo ? ` — ${micInfo}` : ""}
        {err ? ` — ${err}` : ""}
      </div>
    </div>
  );
}
