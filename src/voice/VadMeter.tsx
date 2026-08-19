// Discord-style live microphone meter — the live input level and the threshold
// handle share ONE bar so you read your voice directly against the threshold.
//
// It opens its OWN short-lived mic (separate from the voice session's capture)
// only while "Test" is on, reads the input level with a Web Audio AnalyserNode,
// and paints a filling bar. A draggable vertical handle (an overlaid range
// input) IS the threshold — on the SAME 0..1 scale as the fill, so the handle
// and the live level align. You drop the handle just above your noise floor and
// below your speaking level, exactly like Discord's input-sensitivity bar.
//
// ⚠️ Honest caveat: our RMS level is an APPROXIMATION of OpenAI's internal VAD
// energy metric — the scales won't match to the decimal. The bar is a tuning
// aid ("does my voice clearly cross the handle, does noise stay under it?"),
// not a calibrated readout. The number the agent uses is still the threshold.
import { useEffect, useRef, useState } from "react";
import { clampVadThreshold } from "./vad";
import styles from "./VadMeter.module.css";

interface Props {
  /** Current threshold (0..1) — the handle position, on the fill's own scale. */
  threshold: number;
  /** Called with the new threshold as the handle is dragged (already 0..1). */
  onThresholdChange: (v: number) => void;
  /** Classes so the value + button match the surrounding settings styling. */
  valueClassName?: string;
  buttonClassName?: string;
  disabled?: boolean;
}

export function VadMeter({
  threshold,
  onThresholdChange,
  valueClassName,
  buttonClassName,
  disabled,
}: Props) {
  const [active, setActive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  // The tick reads the LIVE threshold from a ref so dragging the handle never
  // restarts the mic (the effect must not depend on `threshold`).
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;

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
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (stopped) return stopStream();
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          const level = Math.min(1, rms * 3.2); // speech RMS is low; add headroom
          smoothed = smoothed * 0.7 + level * 0.3; // attack/decay smoothing
          const el = fillRef.current;
          if (el) {
            el.style.width = `${Math.round(smoothed * 100)}%`;
            el.dataset.hot = smoothed >= thresholdRef.current ? "1" : "0";
          }
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
      if (el) {
        el.style.width = "0%";
        el.dataset.hot = "0";
      }
    };
  }, [active]);

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        <div className={styles.track}>
          <div ref={fillRef} className={styles.fill} data-hot="0" />
          {/* The threshold handle: a native range spanning the whole track on a
              0..1 scale (same as the fill), so the handle sits exactly over the
              live level. Out-of-band values snap back via clampVadThreshold. */}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            className={styles.slider}
            onChange={(e) => onThresholdChange(clampVadThreshold(Number(e.target.value)))}
            disabled={disabled}
            aria-label="Voice detection threshold"
          />
        </div>
        <span className={valueClassName}>{threshold.toFixed(2)}</span>
        <button
          type="button"
          className={buttonClassName}
          onClick={() => {
            setErr(null);
            setActive((a) => !a);
          }}
          disabled={disabled}
        >
          {active ? "Stop" : "Test mic"}
        </button>
      </div>
      <div className={styles.hint}>
        {active
          ? "Speak normally, then stay quiet: drop the handle just above the noise floor and below your speaking level."
          : "Test your mic to see your live level; drag the handle to set the threshold on the same bar."}
        {err ? ` — ${err}` : ""}
      </div>
    </div>
  );
}
