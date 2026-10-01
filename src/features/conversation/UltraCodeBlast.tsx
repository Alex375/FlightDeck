import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useUltraBlast } from "../../store/ultraBlast";
import "../../ui/ultra-blast.css";

/** Vivid spread used by both particles and the wordmark gradient. */
const COLORS = [
  "#b483e0", "#ff3d7f", "#ff8a3d", "#ffd23d",
  "#3dff7a", "#3dd2ff", "#7a3dff", "#ff3df0",
];
// Kept lean on purpose: every particle is its own compositor layer, so the count
// is the dominant cost of the blast. 60 reads as a dense burst while staying
// smooth — 90 screen-blended layers was the main source of mid-animation stutter.
const PARTICLE_COUNT = 60;
/** Total overlay lifetime — must outlast the longest CSS animation (1.9s). */
const BLAST_MS = 2000;
/** Body shake is a short, punchy hit at the very start. */
const SHAKE_MS = 600;

interface Particle {
  tx: string;
  ty: string;
  size: number;
  color: string;
  delay: number;
  rot: number;
  shape: string;
}

/** Explode N particles radially from screen centre with jittered angle/dist. */
function buildParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 26 + Math.random() * 46; // vmin
    return {
      tx: `${(Math.cos(angle) * dist).toFixed(2)}vmin`,
      ty: `${(Math.sin(angle) * dist).toFixed(2)}vmin`,
      size: 5 + Math.random() * 16,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      delay: Math.random() * 0.12,
      rot: (Math.random() - 0.5) * 720,
      shape: Math.random() > 0.5 ? "50%" : "2px",
    };
  });
}

/**
 * Global, mount-once overlay that replays a full-screen activation blast every
 * time Ultracode is switched ON (driven by the `ultraBlast` token). Renders
 * nothing between blasts; self-unmounts after the animation and removes the
 * transient <body> shake class. Steady-state UI is never touched.
 */
export function UltraCodeBlast() {
  const token = useUltraBlast((s) => s.token);
  const [playing, setPlaying] = useState(false);

  // Fresh particle field per blast — `token` reseeds the layout.
  const particles = useMemo(() => (playing ? buildParticles() : []), [playing, token]);

  useEffect(() => {
    if (token === 0) return; // never auto-play on first mount
    setPlaying(true);

    // Start the viewport shake on the frame the overlay actually paints — NOT
    // synchronously here. The overlay is heavy to rasterise; adding the shake now
    // would jolt the screen a frame or two BEFORE the colour explosion appears
    // (the "shake with no colours" the animation used to have). A double-rAF hop
    // lets React commit + the browser paint the overlay first, so the shake and
    // the blast begin as one coherent hit.
    let cancelled = false;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (!cancelled) document.body.classList.add("ultra-blast-shake");
      });
    });
    const shakeTimer = window.setTimeout(
      () => document.body.classList.remove("ultra-blast-shake"),
      SHAKE_MS,
    );
    const endTimer = window.setTimeout(() => setPlaying(false), BLAST_MS);

    return () => {
      cancelled = true;
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(shakeTimer);
      window.clearTimeout(endTimer);
      document.body.classList.remove("ultra-blast-shake");
    };
  }, [token]);

  if (!playing) return null;

  // Portal to <body> so the fixed overlay escapes .wf-win's positioning context
  // and `overflow: hidden` clip — otherwise the "full-screen" blast is confined to
  // the window frame. body already carries the shake class, so this keeps the whole
  // moment (shake + explosion) on one element tree.
  //
  // key={token} is load-bearing: on a rapid re-fire `playing` is already true, so
  // without a changing key React reuses the SAME node — and the `forwards` CSS
  // animations stay parked at their end state (opacity 0), replaying nothing. You'd
  // then see only the <body> shake (restarted in JS) with no colour explosion. A new
  // key remounts the overlay, so every blast restarts its animations from frame 0.
  return createPortal(
    <div key={token} className="ultra-blast" aria-hidden="true">
      <div className="ultra-blast-flash" />
      <div className="ultra-blast-rays" />
      <div className="ultra-blast-ring" />
      <div className="ultra-blast-ring" />
      <div className="ultra-blast-ring" />
      <div className="ultra-blast-particles">
        {particles.map((p, i) => (
          <span
            key={i}
            className="ultra-blast-particle"
            style={
              {
                "--tx": p.tx,
                "--ty": p.ty,
                "--sz": `${p.size}px`,
                "--c": p.color,
                "--d": `${p.delay}s`,
                "--rot": `${p.rot}deg`,
                "--shape": p.shape,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      <div className="ultra-blast-title" data-text="⚡ ULTRACODE ⚡">
        ⚡ ULTRACODE ⚡
      </div>
    </div>,
    document.body,
  );
}
