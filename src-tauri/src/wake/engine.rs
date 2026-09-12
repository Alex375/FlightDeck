//! The on-device wake-word inference pipeline — 100% local, no network.
//!
//! Two stacked models, both bundled into the binary (`include_bytes!`), so the
//! feature works offline on first launch:
//!
//!  1. **Silero VAD** gates everything: the neural nets below run ONLY while it
//!     hears speech (the battery guard — silence costs ~one tiny VAD inference
//!     per 512 samples, not the full stack). VAD failures degrade to "always
//!     active" rather than killing the feature.
//!
//!  2. **openWakeWord** proper, a three-stage pipeline on 16 kHz mono audio:
//!       audio → melspectrogram (32-bin) → shared speech embedding (96-dim) →
//!       per-phrase classifier → probability in [0, 1].
//!     The melspectrogram + embedding models are SHARED across every phrase; only
//!     the final tiny classifier is per-phrase, which is why bundling a second
//!     wake word ("hey jarvis" beside "alexa") costs only a few hundred KB.
//!
//! Streaming shape (openWakeWord's design): a new detection step runs every
//! `CHUNK` (1280 samples / 80 ms). Each step recomputes the melspectrogram over a
//! short trailing window, takes the newest 76-frame window as one embedding, and
//! keeps a rolling buffer of the last 16 embeddings; once 16 are collected the
//! classifier scores them. This is a faithful streaming approximation — the exact
//! recall is tuned by the sensitivity threshold and validated with a real mic
//! (the /build-app spike), not asserted headlessly.

use ort::session::Session;
use ort::value::Tensor;

/// Working sample rate of the whole pipeline. `capture.rs` resamples the device
/// input down to this before anything here runs.
pub const SAMPLE_RATE: u32 = 16_000;

/// One detection step per 80 ms of new audio (openWakeWord's step).
const CHUNK: usize = 1280;
/// Mel frames per embedding window, and the embedding stride.
const EMB_FRAMES: usize = 76;
/// Number of consecutive embeddings the classifier scores.
const CLASSIFIER_EMBEDDINGS: usize = 16;
/// Mel bins produced by the melspectrogram model.
const MEL_BINS: usize = 32;
/// Mel hop (10 ms at 16 kHz), used only to size the trailing audio window.
const MEL_HOP: usize = 160;
/// Trailing raw-audio window fed to the mel model each step — enough for ≥76
/// frames of context (76 hops + a window's worth of slack), no more.
const MEL_WINDOW_SAMPLES: usize = EMB_FRAMES * MEL_HOP + 640;
/// Silero VAD hop at 16 kHz — the amount of NEW audio per inference.
const VAD_FRAME: usize = 512;
/// Samples of the PREVIOUS hop that Silero expects prepended to each frame, so the
/// tensor it actually scores is 576 long.
///
/// ⚠️ This is not optional padding: silero-vad 5.x does it inside its own wrapper,
/// and the exported graph's sequence dimension is DYNAMIC — so feeding a bare 512
/// is ACCEPTED by onnxruntime and then silently scores ~0 forever. Measured on 7 s
/// of loud, clear speech (RMS 0.12): peak probability 0.003 at 512 versus 1.000 at
/// 576. That is why the VAD never once reported speech.
const VAD_CONTEXT: usize = 64;
/// Suppress re-fires for this many steps after a detection (~1.2 s) and clear the
/// embedding buffer, so one spoken phrase triggers exactly once.
const REFIRE_COOLDOWN_STEPS: u32 = 15;
/// Consecutive steps that must score above the threshold before we wake the app —
/// openWakeWord's `patience`, which this engine was missing.
///
/// Sized from 25 recorded false positives against real utterances: a spoken phrase
/// holds the threshold for 12-18 steps (the ~2 s classifier window slides through
/// it slowly), while EVERY recorded false positive was a single 80 ms spike out of
/// nowhere — 24 of 25 jumped straight from below 0.5 to over 0.6 and back. 3 sits
/// in the middle of that gap and costs ~160 ms of extra latency.
const PATIENCE_STEPS: u32 = 3;
/// Trailing steps whose peak speech probability is required to be real (~1.3 s).
const VAD_VETO_STEPS: usize = 16;
/// Silero peak the trailing window must reach for a fire to count as speech.
///
/// ⚠️ Deliberately checked over the WINDOW, never on the firing step alone: the
/// classifier scores ~2 s of context, so it fires as the phrase ENDS, on new audio
/// that is already quiet. Measured, the firing step of a real utterance carries
/// vad≈0.01 while the steps holding the phrase read ~1.0 — a per-step veto would
/// reject every genuine detection. Across the 25 recorded false positives the
/// window peak was below 0.2 in 23 of them (median 0.007).
const VAD_VETO_MIN: f32 = 0.5;
/// Detection steps of score history kept for diagnostics (~3.2 s). Dumped with
/// every fire so a false positive shows its whole approach, not just the peak.
const TRACE_STEPS: usize = 40;
/// Raw audio retained for a debug dump (4 s at 16 kHz) — comfortably more than
/// the ~2 s the classifier looks at, so the clip holds the sound that fired it
/// AND its lead-in. Only ever filled when debug capture is on.
const DEBUG_AUDIO_SAMPLES: usize = SAMPLE_RATE as usize * 4;

/// One detection step's diagnostics — the numbers that explain a fire.
#[derive(Debug, Clone, Copy)]
pub struct StepTrace {
    /// The classifier's probability for this step.
    pub score: f32,
    /// Silero's PEAK speech probability over the audio that fed this step.
    /// DIAGNOSTIC ONLY — the VAD gates nothing today (see `feed`).
    pub vad: f32,
    /// RMS of the trailing mel window, in [0, 1]. Near zero means the step scored
    /// (near-)silence — which no spoken phrase can do, so a fire there points at
    /// the model rather than at the threshold.
    pub rms: f32,
}

/// A candidate wake, carrying everything needed to explain it after the fact.
/// `suppressed_by` is `None` for a real fire and names the gate otherwise —
/// suppressed candidates are only produced while debug capture is on, so the
/// normal path allocates nothing extra.
pub struct Detection {
    /// Which gate rejected this candidate, or `None` when it woke the app.
    pub suppressed_by: Option<&'static str>,
    /// The score that crossed the threshold.
    pub score: f32,
    /// The threshold in force (derived from the user's sensitivity).
    pub threshold: f32,
    /// The last `TRACE_STEPS` steps, oldest first, ending with the firing step.
    pub trace: Vec<StepTrace>,
    /// Raw 16 kHz mono audio around the fire — `Some` ONLY when debug capture is
    /// on. This is microphone audio: it is never retained without an opt-in.
    pub audio: Option<Vec<f32>>,
}

impl Detection {
    /// Did this candidate actually wake the app?
    pub fn fired(&self) -> bool {
        self.suppressed_by.is_none()
    }
}

/// The bundled models. `include_bytes!` embeds them in the binary — no resource
/// path to resolve across dev / prod / the updater, no external asset host.
const MEL_MODEL: &[u8] = include_bytes!("../../assets/wake/melspectrogram.onnx");
const EMBEDDING_MODEL: &[u8] = include_bytes!("../../assets/wake/embedding_model.onnx");
const VAD_MODEL: &[u8] = include_bytes!("../../assets/wake/silero_vad.onnx");
const ALEXA_MODEL: &[u8] = include_bytes!("../../assets/wake/alexa_v0.1.onnx");
const HEY_JARVIS_MODEL: &[u8] = include_bytes!("../../assets/wake/hey_jarvis_v0.1.onnx");
/// Custom phrase trained locally (macOS `say` voices + augmentation, same feature
/// pipeline as this engine) — the "Ground Control" cockpit call, Flight Deck's own.
const GROUND_CONTROL_MODEL: &[u8] = include_bytes!("../../assets/wake/ground_control.onnx");

/// The phrases we ship a classifier for. The `key` is what the config stores and
/// the front shows; `label` is the human name for Settings.
pub const PHRASES: &[(&str, &str)] = &[
    ("alexa", "Alexa"),
    ("hey_jarvis", "Hey Jarvis"),
    ("ground_control", "Ground Control"),
];

/// The default phrase — the most accent-robust of the pre-trained set (a proper
/// noun pronounced the same in French and English).
pub const DEFAULT_PHRASE: &str = "alexa";

fn classifier_bytes(phrase: &str) -> &'static [u8] {
    match phrase {
        "hey_jarvis" => HEY_JARVIS_MODEL,
        "ground_control" => GROUND_CONTROL_MODEL,
        _ => ALEXA_MODEL, // unknown / "alexa" → the default classifier
    }
}

/// Map the user's sensitivity slider (0 = strict, 1 = loose) to a probability
/// threshold. Default 0.5 → 0.6, a sane starting point for openWakeWord.
fn threshold_for(sensitivity: f32) -> f32 {
    let s = sensitivity.clamp(0.0, 1.0);
    0.9 - 0.6 * s
}

/// Run a single-input ONNX model and return `(output_shape, output_data)` of its
/// first output as a flat `f32` vec.
fn run_single(session: &mut Session, shape: Vec<i64>, data: Vec<f32>) -> Result<(Vec<i64>, Vec<f32>), String> {
    let tensor = Tensor::from_array((shape, data)).map_err(|e| e.to_string())?;
    let outputs = session.run(ort::inputs![tensor]).map_err(|e| e.to_string())?;
    let (shp, slice) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    Ok((shp.to_vec(), slice.to_vec()))
}

fn build_session(bytes: &[u8]) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| e.to_string())?
        // A background listener has no business grabbing every core.
        .with_intra_threads(1)
        .map_err(|e| e.to_string())?
        .commit_from_memory(bytes)
        .map_err(|e| e.to_string())
}

/// The Silero VAD, kept separate so its failures never take the wake pipeline
/// down: if the model errors even once, `disabled` latches and the caller treats
/// every frame as speech (higher CPU, still functional).
struct Vad {
    session: Session,
    state: Vec<f32>,
    buf: Vec<f32>,
    /// The last `VAD_CONTEXT` samples of the previous hop, prepended to the next
    /// frame. Zero-filled at the start, exactly as silero-vad's own wrapper does.
    context: Vec<f32>,
    disabled: bool,
}

impl Vad {
    fn new() -> Result<Self, String> {
        Ok(Self {
            session: build_session(VAD_MODEL)?,
            state: vec![0.0; 2 * 1 * 128],
            buf: Vec::with_capacity(VAD_FRAME * 2),
            context: vec![0.0; VAD_CONTEXT],
            disabled: false,
        })
    }

    /// Feed new audio; return the PEAK speech probability across the frames this
    /// call completed (0.0 when it completed none — callers accumulate with `max`,
    /// for which that is a no-op). Returning the probability rather than a boolean
    /// is what lets it ride in the trace and, later, veto a fire. On any model
    /// error the VAD latches off and reports certain speech (fail-open — never
    /// silence the feature over a VAD glitch).
    fn speech_prob(&mut self, samples: &[f32]) -> f32 {
        if self.disabled {
            return 1.0;
        }
        self.buf.extend_from_slice(samples);
        let mut peak = 0.0f32;
        while self.buf.len() >= VAD_FRAME {
            let hop: Vec<f32> = self.buf.drain(..VAD_FRAME).collect();
            // context ++ hop = the 576 samples Silero scores; then carry this hop's
            // tail forward. Skipping this is what made the VAD a constant ~0.
            let mut frame = std::mem::take(&mut self.context);
            frame.extend_from_slice(&hop);
            self.context = hop[hop.len() - VAD_CONTEXT..].to_vec();
            match self.run_frame(&frame) {
                Ok(p) => peak = peak.max(p),
                Err(e) => {
                    eprintln!("[wake] Silero VAD disabled after error: {e}");
                    self.disabled = true;
                    return 1.0;
                }
            }
        }
        peak
    }

    fn run_frame(&mut self, frame: &[f32]) -> Result<f32, String> {
        let input = Tensor::from_array((vec![1i64, frame.len() as i64], frame.to_vec()))
            .map_err(|e| e.to_string())?;
        let state = Tensor::from_array((vec![2i64, 1, 128], self.state.clone()))
            .map_err(|e| e.to_string())?;
        let sr = Tensor::from_array((vec![1i64], vec![SAMPLE_RATE as i64]))
            .map_err(|e| e.to_string())?;
        let outputs = self
            .session
            .run(ort::inputs![input, state, sr])
            .map_err(|e| e.to_string())?;
        let (_, prob) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        // Second output is the recurrent state to carry into the next frame.
        if let Ok((_, next_state)) = outputs[1].try_extract_tensor::<f32>() {
            if next_state.len() == self.state.len() {
                self.state.copy_from_slice(next_state);
            }
        }
        Ok(prob.first().copied().unwrap_or(0.0))
    }
}

/// The full wake-word engine. Owned and driven on a single worker thread (see
/// `capture.rs`), so the ONNX `Session`s (which need `&mut` to run) never cross a
/// thread boundary mid-inference.
pub struct Engine {
    mel: Session,
    embedding: Session,
    classifier: Session,
    vad: Vad,
    phrase: String,
    threshold: f32,
    /// Rolling 16 kHz audio. Holds the next step's mel window PLUS everything
    /// that has arrived past it: `feed` walks a per-step window end through this
    /// buffer, so several steps drained from one callback see DIFFERENT audio.
    audio: Vec<f32>,
    /// Samples accumulated past the last step's window end.
    pending: usize,
    /// The last `CLASSIFIER_EMBEDDINGS` embeddings (flattened, 96 each).
    embeddings: std::collections::VecDeque<Vec<f32>>,
    /// Steps remaining in the post-detection cooldown.
    cooldown: u32,
    /// Consecutive steps scored at or above the threshold (the patience counter).
    consecutive: u32,
    /// Peak Silero probability observed since the last step (diagnostics).
    vad_peak: f32,
    /// Previous per-step VAD state, to log speech rising edges (diagnostics).
    was_speech: bool,
    /// Rolling per-step diagnostics, capped at `TRACE_STEPS`.
    trace: std::collections::VecDeque<StepTrace>,
    /// Whether to retain raw audio for a debug dump. OFF keeps `debug_audio`
    /// permanently empty — a user who did not opt in never has mic audio buffered.
    debug: bool,
    debug_audio: std::collections::VecDeque<f32>,
    /// Latches after the first non-finite feature frame, so a dead input logs once
    /// instead of every 80 ms.
    warned_non_finite: bool,
}

impl Engine {
    /// Build the engine for one phrase + sensitivity. Loads all four models
    /// (VAD + the three openWakeWord stages) — a few tens of ms, done once when
    /// the detector arms. `debug` turns on raw-audio retention for fire dumps.
    pub fn new(phrase: &str, sensitivity: f32, debug: bool) -> Result<Self, String> {
        Ok(Self {
            mel: build_session(MEL_MODEL)?,
            embedding: build_session(EMBEDDING_MODEL)?,
            classifier: build_session(classifier_bytes(phrase))?,
            vad: Vad::new()?,
            phrase: phrase.to_string(),
            threshold: threshold_for(sensitivity),
            audio: Vec::with_capacity(MEL_WINDOW_SAMPLES + 2 * CHUNK),
            pending: 0,
            embeddings: std::collections::VecDeque::with_capacity(CLASSIFIER_EMBEDDINGS),
            cooldown: 0,
            consecutive: 0,
            vad_peak: 0.0,
            was_speech: false,
            trace: std::collections::VecDeque::with_capacity(TRACE_STEPS),
            debug,
            debug_audio: std::collections::VecDeque::with_capacity(if debug {
                DEBUG_AUDIO_SAMPLES
            } else {
                0
            }),
            warned_non_finite: false,
        })
    }

    /// The phrase this engine detects (for the emitted event).
    pub fn phrase(&self) -> &str {
        &self.phrase
    }

    /// Test-only view of the rolling score history, so a test can compare the
    /// trajectories of two engines fed the SAME audio in different callback sizes.
    #[cfg(test)]
    fn trace_scores(&self) -> Vec<f32> {
        self.trace.iter().map(|t| t.score).collect()
    }

    /// Feed freshly-captured 16 kHz mono audio. Returns `Some(detection)` the
    /// moment the configured phrase is detected (at most once per spoken phrase,
    /// thanks to the cooldown). `None` otherwise.
    pub fn feed(&mut self, samples: &[f32]) -> Option<Detection> {
        // VAD is computed for diagnostics only — it does NOT gate the pipeline.
        // openWakeWord needs a CONTINUOUS rolling window of embeddings (~2 s); a
        // hard VAD gate that ran the stack only during speech (and cleared the
        // embedding buffer on silence) mis-anchored that window and starved the
        // classifier of the 16 consecutive embeddings it needs — so a short
        // utterance never fired. Run the stack every step.
        //
        // Reading this probability as a FIRE-TIME VETO would not touch the rolling
        // window, and is the next move against false positives. ⚠️ When that lands,
        // veto on the peak across the TRAILING WINDOW, never on the firing step's
        // own 80 ms: the classifier scores ~2 s of context, so it typically fires
        // one or two steps AFTER the phrase ends, on new audio that is already
        // silent. Measured on a `say "Alexa"` clip: the step that scores 1.000
        // carries vad=0.01, while the steps holding the phrase itself read ~1.0.
        // A naive per-step veto would therefore reject every real detection.
        self.vad_peak = self.vad_peak.max(self.vad.speech_prob(samples));

        self.audio.extend_from_slice(samples);
        self.pending += samples.len();
        if self.debug {
            for &s in samples {
                if self.debug_audio.len() == DEBUG_AUDIO_SAMPLES {
                    self.debug_audio.pop_front();
                }
                self.debug_audio.push_back(s);
            }
        }

        let mut hit: Option<Detection> = None;
        while self.pending >= CHUNK {
            self.pending -= CHUNK;
            // Where THIS step's window ends. Each iteration advances it by exactly
            // CHUNK, so a callback carrying several chunks yields several DISTINCT
            // embeddings. Slicing the buffer's tail instead (what this used to do)
            // handed every step of such a callback the SAME audio, stuffing the
            // rolling window with duplicate embeddings and corrupting the very
            // temporal pattern the classifier is trained on.
            let end = self.audio.len() - self.pending;
            if let Some(detection) = self.step(end) {
                hit = Some(detection);
            }
        }

        // Trim to what the next step still needs: one mel window ending at the
        // last step's end, plus the unconsumed tail past it.
        let keep = MEL_WINDOW_SAMPLES + self.pending;
        if self.audio.len() > keep {
            let drop = self.audio.len() - keep;
            self.audio.drain(..drop);
        }
        hit
    }

    /// One 80 ms detection step over the window ENDING at `end`: append the newest
    /// embedding to a CONTINUOUS rolling window of the last 16, and (once the
    /// window is full) classify. Runs every step — the rolling window must never be
    /// gated/cleared on silence or the classifier loses the context it was trained
    /// on. The cooldown after a hit is the only thing that pauses it.
    fn step(&mut self, end: usize) -> Option<Detection> {
        // Take (and reset) this step's VAD peak whatever happens next, so a cooldown
        // or an unprimed buffer cannot leak one step's speech into the following one.
        let vad = std::mem::replace(&mut self.vad_peak, 0.0);
        let speech = vad >= 0.5;
        if speech && !self.was_speech {
            eprintln!("[wake] VAD: speech");
        }
        self.was_speech = speech;

        if self.cooldown > 0 {
            self.cooldown -= 1;
            return None;
        }
        let (embedding, rms) = self.newest_embedding(end)?; // None = buffer not primed
        if self.embeddings.len() == CLASSIFIER_EMBEDDINGS {
            self.embeddings.pop_front();
        }
        self.embeddings.push_back(embedding);
        if self.embeddings.len() < CLASSIFIER_EMBEDDINGS {
            return None;
        }

        let score = self.classify()?;
        if self.trace.len() == TRACE_STEPS {
            self.trace.pop_front();
        }
        self.trace.push_back(StepTrace { score, vad, rms });
        // The pipeline runs continuously now, so only log a score worth noticing —
        // ambient/silence sits near 0 (no spam), a near-miss or a hit is visible.
        // `vad` and `rms` ride along: they are what tells a real utterance apart
        // from a fire on room tone, straight from the console.
        if score > 0.3 {
            eprintln!(
                "[wake] score={score:.3} (threshold {:.3}) vad={vad:.2} rms={rms:.4}",
                self.threshold
            );
        }
        if score < self.threshold {
            self.consecutive = 0;
            return None;
        }
        self.consecutive += 1;

        // Two gates, both measured against the recorded false positives. Together
        // they suppressed all 25 while leaving a real utterance (12-18 steps above
        // threshold, VAD peak 0.62-1.00) a wide margin.
        let suppressed_by = if self.consecutive < PATIENCE_STEPS {
            Some("patience")
        } else if self.vad_window_peak() < VAD_VETO_MIN {
            Some("no_speech")
        } else {
            None
        };

        // A suppressed candidate is only WORTH reporting while debug capture is on —
        // it is then dumped like a fire, tagged with the gate that stopped it, which
        // is the only way to tell "the gates are working" from "the gates are eating
        // real detections". With capture off, the normal path allocates nothing.
        if suppressed_by.is_some() && !self.debug {
            return None;
        }
        if suppressed_by.is_none() {
            self.cooldown = REFIRE_COOLDOWN_STEPS;
            self.consecutive = 0;
            self.embeddings.clear();
        }
        Some(Detection {
            suppressed_by,
            score,
            threshold: self.threshold,
            trace: self.trace.iter().copied().collect(),
            audio: self.debug.then(|| self.debug_audio.iter().copied().collect()),
        })
    }

    /// Peak Silero probability across the trailing window the classifier scored.
    fn vad_window_peak(&self) -> f32 {
        self.trace
            .iter()
            .rev()
            .take(VAD_VETO_STEPS)
            .map(|t| t.vad)
            .fold(0.0f32, f32::max)
    }

    /// True when every value is finite, else logs ONCE (latched) and returns false.
    ///
    /// A muted or dead input device delivers EXACT zeros, and a log-mel of zeros can
    /// come back -inf/NaN. A non-finite feature does not merely make the classifier
    /// wrong — its output becomes meaningless and can read as a confident hit, which
    /// is one way "it fires on silence" happens. Drop the step instead of scoring
    /// garbage, and say so rather than failing quietly.
    fn check_finite(&mut self, values: &[f32], stage: &str) -> bool {
        if values.iter().all(|v| v.is_finite()) {
            return true;
        }
        if !self.warned_non_finite {
            self.warned_non_finite = true;
            eprintln!(
                "[wake] {stage} produced non-finite values — those steps are dropped. \
                 The input device is most likely muted or dead; detection resumes on \
                 its own once real audio comes back."
            );
        }
        false
    }

    /// Compute the melspectrogram over the window ENDING at `end` and turn its
    /// newest 76 frames into one 96-dim embedding. Also returns that window's RMS —
    /// the cheap, honest answer to "did this step fire on silence?".
    fn newest_embedding(&mut self, end: usize) -> Option<(Vec<f32>, f32)> {
        if end < MEL_WINDOW_SAMPLES || end > self.audio.len() {
            return None; // buffer not primed yet
        }
        let raw = &self.audio[end - MEL_WINDOW_SAMPLES..end];
        let rms = (raw.iter().map(|s| s * s).sum::<f32>() / raw.len() as f32).sqrt();
        // openWakeWord's melspectrogram model was trained on int16-SCALE audio
        // (raw sample values, ~±32768), NOT normalized [-1,1]. The rest of the
        // pipeline (and Silero VAD) works in [-1,1], so scale up only here.
        let window: Vec<f32> = raw.iter().map(|&s| s * 32768.0).collect();
        let mel_out = run_single(&mut self.mel, vec![1, window.len() as i64], window);
        let (_, mut mel) = match mel_out {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[wake] melspectrogram inference failed: {e}");
                return None;
            }
        };
        // openWakeWord's training normalization.
        for v in mel.iter_mut() {
            *v = *v / 10.0 + 2.0;
        }
        // The model returns [1, 1, frames, 32]; frame count is the third-from-last
        // dim (be tolerant of leading singleton dims).
        let frames = mel.len() / MEL_BINS;
        if frames < EMB_FRAMES {
            return None;
        }
        // Newest 76 frames → embedding input [1, 76, 32, 1].
        let start = (frames - EMB_FRAMES) * MEL_BINS;
        let win = mel[start..start + EMB_FRAMES * MEL_BINS].to_vec();
        if !self.check_finite(&win, "melspectrogram") {
            return None;
        }
        let emb_out = run_single(
            &mut self.embedding,
            vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1],
            win,
        );
        match emb_out {
            Ok((_, emb)) if self.check_finite(&emb, "embedding") => Some((emb, rms)),
            Ok(_) => None,
            Err(e) => {
                eprintln!("[wake] embedding inference failed: {e}");
                None
            }
        }
    }

    /// Run the per-phrase classifier over the last 16 embeddings → probability.
    fn classify(&mut self) -> Option<f32> {
        let mut flat = Vec::with_capacity(CLASSIFIER_EMBEDDINGS * 96);
        for e in &self.embeddings {
            flat.extend_from_slice(e);
        }
        let feat = flat.len() / CLASSIFIER_EMBEDDINGS;
        let out = run_single(
            &mut self.classifier,
            vec![1, CLASSIFIER_EMBEDDINGS as i64, feat as i64],
            flat,
        );
        match out {
            Ok((_, values)) => {
                let score = values.first().copied()?;
                self.check_finite(&[score], "classifier").then_some(score)
            }
            Err(e) => {
                eprintln!("[wake] classifier inference failed: {e}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_maps_sensitivity_monotonically() {
        // Louder sensitivity → lower (looser) threshold, clamped to [0,1] input.
        assert!(threshold_for(0.0) > threshold_for(1.0));
        assert!((threshold_for(0.5) - 0.6).abs() < 1e-5); // f32: 0.9 - 0.6*0.5
        assert_eq!(threshold_for(-1.0), threshold_for(0.0)); // clamp
        assert_eq!(threshold_for(2.0), threshold_for(1.0)); // clamp
    }

    #[test]
    fn phrase_catalogue_has_the_default() {
        assert!(PHRASES.iter().any(|(k, _)| *k == DEFAULT_PHRASE));
    }

    /// Push a synthetic tone through mel → embedding → classifier directly,
    /// asserting every ONNX run succeeds and the shapes line up end-to-end. The
    /// streaming path logs-and-swallows inference errors (and VAD gates the stack
    /// out of the silence test), so a shape bug could hide until a live mic — this
    /// catches it headlessly. Detection ACCURACY still needs a real mic.
    #[test]
    fn pipeline_shapes_line_up_end_to_end() {
        let mut mel = build_session(MEL_MODEL).unwrap();
        let mut embedding = build_session(EMBEDDING_MODEL).unwrap();
        let mut classifier = build_session(classifier_bytes(DEFAULT_PHRASE)).unwrap();

        // ~2 s of a deterministic tone at int16 scale (what the mel model expects).
        let n = SAMPLE_RATE as usize * 2;
        let audio: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE as f32;
                (2.0 * std::f32::consts::PI * 220.0 * t).sin() * 8000.0
            })
            .collect();

        let (_, mut mel_out) =
            run_single(&mut mel, vec![1, audio.len() as i64], audio).expect("mel runs");
        for v in mel_out.iter_mut() {
            *v = *v / 10.0 + 2.0;
        }
        let frames = mel_out.len() / MEL_BINS;
        let needed = EMB_FRAMES + (CLASSIFIER_EMBEDDINGS - 1) * 8;
        assert!(frames >= needed, "mel gave {frames} frames, need {needed}");

        // 16 embeddings stepping 8 frames → the classifier's [1, 16, 96] input.
        let mut seq: Vec<f32> = Vec::with_capacity(CLASSIFIER_EMBEDDINGS * 96);
        for e in 0..CLASSIFIER_EMBEDDINGS {
            let start = e * 8 * MEL_BINS;
            let win = mel_out[start..start + EMB_FRAMES * MEL_BINS].to_vec();
            let (_, emb) =
                run_single(&mut embedding, vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1], win)
                    .expect("embedding runs");
            assert_eq!(emb.len(), 96, "embedding is 96-dim");
            seq.extend_from_slice(&emb);
        }
        let (_, out) = run_single(&mut classifier, vec![1, CLASSIFIER_EMBEDDINGS as i64, 96], seq)
            .expect("classifier runs");
        let score = out.first().copied().expect("a score");
        assert!((0.0..=1.0).contains(&score), "score in [0,1], got {score}");
    }

    /// Loads every bundled model and pushes 2 s of silence through — proves the
    /// ONNX graphs parse, the tensor shapes line up end-to-end, and a quiet
    /// stretch never false-fires. (Real detection accuracy is a mic test.)
    #[test]
    fn engine_loads_and_survives_silence() {
        let mut engine =
            Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds from bundled models");
        let silence = vec![0.0f32; CHUNK];
        let mut fired = false;
        for _ in 0..25 {
            if engine.feed(&silence).is_some() {
                fired = true;
            }
        }
        assert!(!fired, "silence must never trigger the wake word");
    }

    /// ~0.6 s of 16 kHz mono speech ("Alexa", macOS `say`). Committed so the VAD
    /// contract is checked headlessly, on CI, without a microphone.
    const SPEECH_WAV: &[u8] = include_bytes!("fixtures/say_alexa_16k.wav");

    /// Silero must actually SAY "speech" when it hears speech.
    ///
    /// This is the regression guard for the frame-contract bug: the model's
    /// sequence dimension is dynamic, so a wrongly-sized frame is accepted and
    /// scores ~0 rather than erroring. The VAD then never crosses any threshold —
    /// it silently reports silence over clear speech, which is indistinguishable
    /// from "the VAD is disabled" and cannot be noticed from the outside.
    #[test]
    fn silero_separates_speech_from_silence() {
        let speech = parse_wav_i16(SPEECH_WAV);
        let mut on_speech = Vad::new().expect("VAD builds");
        let mut peak = 0.0f32;
        for chunk in speech.chunks(VAD_FRAME) {
            peak = peak.max(on_speech.speech_prob(chunk));
        }
        assert!(peak > 0.5, "speech must read as speech, got {peak:.4}");

        let mut on_silence = Vad::new().expect("VAD builds");
        let quiet = on_silence.speech_prob(&vec![0.0f32; VAD_FRAME * 8]);
        assert!(quiet < 0.5, "silence must not read as speech, got {quiet:.4}");
    }

    /// Deterministic pseudo-noise (xorshift), so the "must not fire" tests are
    /// reproducible and need no `rand` dependency.
    fn pseudo_noise(n: usize, amplitude: f32) -> Vec<f32> {
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        (0..n)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                ((state >> 40) as f32 / 8_388_608.0 - 1.0) * amplitude
            })
            .collect()
    }

    /// EVERY bundled phrase — not just the default — must stay silent on sounds
    /// that contain no speech at all. The old test covered `alexa` only, which is
    /// the one phrase trained on openWakeWord's full negative corpus; the custom
    /// `ground_control` classifier never saw room tone or broadband noise in
    /// training, and "it fires on background noise / on nothing" is exactly the
    /// complaint this pins down.
    #[test]
    fn no_bundled_phrase_fires_on_silence_or_noise() {
        let cases: [(&str, Vec<f32>); 3] = [
            ("digital silence", vec![0.0f32; SAMPLE_RATE as usize * 3]),
            ("room tone", pseudo_noise(SAMPLE_RATE as usize * 3, 0.002)),
            ("broadband noise", pseudo_noise(SAMPLE_RATE as usize * 3, 0.2)),
        ];
        let mut failures: Vec<String> = Vec::new();
        for (key, _) in PHRASES {
            for (label, audio) in &cases {
                let mut engine = Engine::new(key, 0.5, false).expect("engine builds");
                for chunk in audio.chunks(CHUNK) {
                    if let Some(d) = engine.feed(chunk) {
                        failures.push(format!("{key} fired on {label} (score {:.3})", d.score));
                        break;
                    }
                }
            }
        }
        assert!(failures.is_empty(), "non-speech must never wake the app: {failures:?}");
    }

    /// The engine used to slice the buffer's TAIL for every step, so a callback
    /// carrying several 80 ms chunks fed the rolling window the SAME embedding
    /// repeated — a different (and wrong) trajectory than the identical audio
    /// arriving in small callbacks. Both must now agree exactly.
    #[test]
    fn callback_size_does_not_change_the_score_trajectory() {
        let audio = pseudo_noise(SAMPLE_RATE as usize * 3, 0.05);
        let mut small = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds");
        for chunk in audio.chunks(160) {
            small.feed(chunk); // ~10 ms callbacks, the CoreAudio-sized case
        }
        let mut big = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds");
        for chunk in audio.chunks(CHUNK * 4) {
            big.feed(chunk); // 320 ms callbacks, several steps drained at once
        }
        let small_scores = small.trace_scores();
        assert!(!small_scores.is_empty(), "the run must produce scored steps");
        assert_eq!(
            small_scores,
            big.trace_scores(),
            "callback size must not change what the classifier sees"
        );
    }

    /// A muted or dead input device delivers values the mel stage turns non-finite.
    /// Those steps must be DROPPED, never scored: a NaN through the classifier can
    /// come back as a confident hit.
    #[test]
    fn non_finite_audio_is_dropped_never_scored() {
        let mut engine = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds");
        let bad = vec![f32::NAN; CHUNK];
        for _ in 0..40 {
            assert!(engine.feed(&bad).is_none(), "NaN audio must never wake the app");
        }
    }

    /// Debug capture is an OPT-IN that retains microphone audio: with it off a
    /// detection must carry no audio at all, and with it on the clip must be there
    /// for the dump to write.
    #[test]
    fn debug_capture_only_retains_audio_when_asked() {
        let off = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds");
        assert_eq!(off.debug_audio.len(), 0);
        let mut on = Engine::new(DEFAULT_PHRASE, 0.5, true).expect("engine builds");
        let mut off = off;
        let audio = pseudo_noise(SAMPLE_RATE as usize, 0.05);
        for chunk in audio.chunks(CHUNK) {
            on.feed(chunk);
            off.feed(chunk);
        }
        assert_eq!(on.debug_audio.len(), audio.len(), "every sample is retained");
        assert_eq!(off.debug_audio.len(), 0, "nothing is retained without the opt-in");
    }

    /// The debug ring buffer must stay bounded — an always-on listener cannot grow
    /// a buffer for as long as the app is up.
    #[test]
    fn debug_capture_ring_buffer_is_bounded() {
        let mut engine = Engine::new(DEFAULT_PHRASE, 0.5, true).expect("engine builds");
        let audio = pseudo_noise(DEBUG_AUDIO_SAMPLES + SAMPLE_RATE as usize * 2, 0.05);
        for chunk in audio.chunks(CHUNK) {
            engine.feed(chunk);
        }
        assert_eq!(engine.debug_audio.len(), DEBUG_AUDIO_SAMPLES);
    }

    /// Diagnostic (ignored): feed a 16 kHz mono WAV at $WAKE_WAV through the engine
    /// and print the score trajectory + any hits — validates real detection without
    /// a live mic. Run e.g.:
    ///   WAKE_WAV=target/alexa16.wav cargo test --lib wake::engine::tests::detect_wav -- --ignored --nocapture
    #[test]
    #[ignore]
    fn detect_wav() {
        let path = std::env::var("WAKE_WAV").expect("set WAKE_WAV=/path/to/16k-mono.wav");
        let phrase = std::env::var("WAKE_PHRASE").unwrap_or_else(|_| DEFAULT_PHRASE.to_string());
        let bytes = std::fs::read(&path).expect("read wav");
        let samples = parse_wav_i16(&bytes);
        eprintln!(
            "[test] {} samples ({:.2}s) from {path}",
            samples.len(),
            samples.len() as f32 / SAMPLE_RATE as f32
        );
        // 1 s leading silence primes the mel buffer; 0.5 s trailing lets the rolling
        // window slide the phrase fully through — the mic streams continuously in
        // real life, so priming context always exists there.
        let mut audio = vec![0.0f32; SAMPLE_RATE as usize];
        audio.extend_from_slice(&samples);
        audio.extend(std::iter::repeat(0.0f32).take(SAMPLE_RATE as usize / 2));
        let mut engine = Engine::new(&phrase, 0.5, false).expect("engine builds");
        let mut hits = 0;
        for chunk in audio.chunks(CHUNK) {
            if engine.feed(chunk).is_some() {
                hits += 1;
            }
        }
        eprintln!("[test] phrase={phrase} hits={hits} (see [wake] score= lines above for the trajectory)");
    }




    /// Diagnostic (ignored): replay a WHOLE DIRECTORY of 16 kHz WAVs through the
    /// engine and report how many fire. Point it at the debug-capture folder to
    /// check a gate against the false positives it was sized on, or at a folder of
    /// real utterances to prove the gate did not eat them:
    ///
    ///   WAKE_CORPUS=~/…/wake-debug WAKE_PHRASE=ground_control \
    ///     cargo test --lib wake::engine::tests::replay_corpus -- --ignored --nocapture
    #[test]
    #[ignore]
    fn replay_corpus() {
        let dir = std::env::var("WAKE_CORPUS").expect("set WAKE_CORPUS=/path/to/wavs");
        let phrase = std::env::var("WAKE_PHRASE").unwrap_or_else(|_| DEFAULT_PHRASE.to_string());
        let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .expect("read corpus dir")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "wav").unwrap_or(false))
            .collect();
        paths.sort();

        let mut fired = 0usize;
        let mut suppressed: std::collections::BTreeMap<&str, usize> = Default::default();
        for path in &paths {
            let samples = parse_wav_i16(&std::fs::read(path).unwrap());
            let mut audio = vec![0.0f32; SAMPLE_RATE as usize];
            audio.extend_from_slice(&samples);
            audio.extend(std::iter::repeat(0.0f32).take(SAMPLE_RATE as usize / 2));
            // debug=true so SUPPRESSED candidates are reported too — otherwise a
            // corpus that produces nothing cannot be told from one the gates caught.
            let mut engine = Engine::new(&phrase, 0.5, true).expect("engine builds");
            let mut outcome = String::from("no candidate");
            for chunk in audio.chunks(CHUNK) {
                if let Some(d) = engine.feed(chunk) {
                    match d.suppressed_by {
                        None => {
                            fired += 1;
                            outcome = format!("FIRED score={:.3}", d.score);
                            break;
                        }
                        Some(gate) => {
                            *suppressed.entry(gate).or_default() += 1;
                            outcome = format!("blocked by {gate} (score {:.3})", d.score);
                        }
                    }
                }
            }
            eprintln!("[corpus] {:<52} {outcome}", path.file_name().unwrap().to_string_lossy());
        }
        eprintln!();
        eprintln!("[corpus] {} files: {fired} FIRED, suppressed {suppressed:?}", paths.len());
    }

    /// Minimal PCM-16 WAV reader: locate the `data` subchunk, decode i16 LE → f32.
    fn parse_wav_i16(bytes: &[u8]) -> Vec<f32> {
        let pos = bytes
            .windows(4)
            .position(|w| w == b"data")
            .expect("no data chunk in WAV");
        bytes[pos + 8..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect()
    }
}
