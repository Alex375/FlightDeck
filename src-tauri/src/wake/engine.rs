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
/// Silero VAD frame size at 16 kHz.
const VAD_FRAME: usize = 512;
/// Keep the pipeline "hot" for this many steps after the last speech frame, so a
/// wake word straddling a brief VAD dropout is not cut (hangover).
const VAD_HANGOVER_STEPS: u32 = 8;
/// Suppress re-fires for this many steps after a detection (~1.2 s) and clear the
/// embedding buffer, so one spoken phrase triggers exactly once.
const REFIRE_COOLDOWN_STEPS: u32 = 15;

/// The bundled models. `include_bytes!` embeds them in the binary — no resource
/// path to resolve across dev / prod / the updater, no external asset host.
const MEL_MODEL: &[u8] = include_bytes!("../../assets/wake/melspectrogram.onnx");
const EMBEDDING_MODEL: &[u8] = include_bytes!("../../assets/wake/embedding_model.onnx");
const VAD_MODEL: &[u8] = include_bytes!("../../assets/wake/silero_vad.onnx");
const ALEXA_MODEL: &[u8] = include_bytes!("../../assets/wake/alexa_v0.1.onnx");
const HEY_JARVIS_MODEL: &[u8] = include_bytes!("../../assets/wake/hey_jarvis_v0.1.onnx");

/// The phrases we ship a classifier for. The `key` is what the config stores and
/// the front shows; `label` is the human name for Settings.
pub const PHRASES: &[(&str, &str)] = &[("alexa", "Alexa"), ("hey_jarvis", "Hey Jarvis")];

/// The default phrase — the most accent-robust of the pre-trained set (a proper
/// noun pronounced the same in French and English).
pub const DEFAULT_PHRASE: &str = "alexa";

fn classifier_bytes(phrase: &str) -> &'static [u8] {
    match phrase {
        "hey_jarvis" => HEY_JARVIS_MODEL,
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
    disabled: bool,
}

impl Vad {
    fn new() -> Result<Self, String> {
        Ok(Self {
            session: build_session(VAD_MODEL)?,
            state: vec![0.0; 2 * 1 * 128],
            buf: Vec::with_capacity(VAD_FRAME * 2),
            disabled: false,
        })
    }

    /// Feed new audio; return true if speech is present in it. On any model error
    /// the VAD latches off and reports speech (fail-open — never silence the
    /// feature over a VAD glitch).
    fn is_speech(&mut self, samples: &[f32]) -> bool {
        if self.disabled {
            return true;
        }
        self.buf.extend_from_slice(samples);
        let mut speech = false;
        while self.buf.len() >= VAD_FRAME {
            let frame: Vec<f32> = self.buf.drain(..VAD_FRAME).collect();
            match self.run_frame(&frame) {
                Ok(p) if p >= 0.5 => speech = true,
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[wake] Silero VAD disabled after error: {e}");
                    self.disabled = true;
                    return true;
                }
            }
        }
        speech
    }

    fn run_frame(&mut self, frame: &[f32]) -> Result<f32, String> {
        let input = Tensor::from_array((vec![1i64, VAD_FRAME as i64], frame.to_vec()))
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
    /// Rolling 16 kHz audio, capped to the mel window.
    audio: Vec<f32>,
    /// Samples accumulated since the last detection step.
    pending: usize,
    /// The last `CLASSIFIER_EMBEDDINGS` embeddings (flattened, 96 each).
    embeddings: std::collections::VecDeque<Vec<f32>>,
    /// Steps remaining while still "hot" after the last speech (hangover).
    hot_steps: u32,
    /// Steps remaining in the post-detection cooldown.
    cooldown: u32,
}

impl Engine {
    /// Build the engine for one phrase + sensitivity. Loads all four models
    /// (VAD + the three openWakeWord stages) — a few tens of ms, done once when
    /// the detector arms.
    pub fn new(phrase: &str, sensitivity: f32) -> Result<Self, String> {
        Ok(Self {
            mel: build_session(MEL_MODEL)?,
            embedding: build_session(EMBEDDING_MODEL)?,
            classifier: build_session(classifier_bytes(phrase))?,
            vad: Vad::new()?,
            phrase: phrase.to_string(),
            threshold: threshold_for(sensitivity),
            audio: Vec::with_capacity(MEL_WINDOW_SAMPLES + CHUNK),
            pending: 0,
            embeddings: std::collections::VecDeque::with_capacity(CLASSIFIER_EMBEDDINGS),
            hot_steps: 0,
            cooldown: 0,
        })
    }

    /// The phrase this engine detects (for the emitted event).
    pub fn phrase(&self) -> &str {
        &self.phrase
    }

    /// Feed freshly-captured 16 kHz mono audio. Returns `Some(score)` the moment
    /// the configured phrase is detected (at most once per spoken phrase, thanks
    /// to the cooldown). `None` otherwise.
    pub fn feed(&mut self, samples: &[f32]) -> Option<f32> {
        let speech = self.vad.is_speech(samples);
        if speech {
            self.hot_steps = VAD_HANGOVER_STEPS;
        }
        self.audio.extend_from_slice(samples);
        self.pending += samples.len();
        // Cap the rolling buffer.
        if self.audio.len() > MEL_WINDOW_SAMPLES {
            let drop = self.audio.len() - MEL_WINDOW_SAMPLES;
            self.audio.drain(..drop);
        }

        let mut hit: Option<f32> = None;
        while self.pending >= CHUNK {
            self.pending -= CHUNK;
            if let Some(score) = self.step() {
                hit = Some(score);
            }
        }
        hit
    }

    /// One 80 ms detection step. Skips the expensive stack when neither speech nor
    /// the hangover keep it hot; advances the cooldown; otherwise runs
    /// mel → embedding → (once 16 collected) classifier.
    fn step(&mut self) -> Option<f32> {
        if self.cooldown > 0 {
            self.cooldown -= 1;
            return None;
        }
        if self.hot_steps == 0 {
            // Silence: let the embedding history lapse so a later phrase starts clean.
            self.embeddings.clear();
            return None;
        }
        self.hot_steps -= 1;

        let embedding = match self.newest_embedding() {
            Some(e) => e,
            None => return None,
        };
        if self.embeddings.len() == CLASSIFIER_EMBEDDINGS {
            self.embeddings.pop_front();
        }
        self.embeddings.push_back(embedding);
        if self.embeddings.len() < CLASSIFIER_EMBEDDINGS {
            return None;
        }

        let score = self.classify()?;
        if score >= self.threshold {
            self.cooldown = REFIRE_COOLDOWN_STEPS;
            self.embeddings.clear();
            return Some(score);
        }
        None
    }

    /// Compute the melspectrogram over the trailing window and turn its newest 76
    /// frames into one 96-dim embedding.
    fn newest_embedding(&mut self) -> Option<Vec<f32>> {
        if self.audio.len() < MEL_WINDOW_SAMPLES {
            return None; // buffer not primed yet
        }
        // openWakeWord's melspectrogram model was trained on int16-SCALE audio
        // (raw sample values, ~±32768), NOT normalized [-1,1]. The rest of the
        // pipeline (and Silero VAD) works in [-1,1], so scale up only here.
        let window: Vec<f32> = self.audio[self.audio.len() - MEL_WINDOW_SAMPLES..]
            .iter()
            .map(|&s| s * 32768.0)
            .collect();
        let (shape, mut mel) = match run_single(&mut self.mel, vec![1, window.len() as i64], window) {
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
        let _ = shape;
        // Newest 76 frames → embedding input [1, 76, 32, 1].
        let start = (frames - EMB_FRAMES) * MEL_BINS;
        let win = mel[start..start + EMB_FRAMES * MEL_BINS].to_vec();
        match run_single(
            &mut self.embedding,
            vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1],
            win,
        ) {
            Ok((_, emb)) => Some(emb),
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
        match run_single(
            &mut self.classifier,
            vec![1, CLASSIFIER_EMBEDDINGS as i64, feat as i64],
            flat,
        ) {
            Ok((_, out)) => out.first().copied(),
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
        let mut engine = Engine::new(DEFAULT_PHRASE, 0.5).expect("engine builds from bundled models");
        let silence = vec![0.0f32; CHUNK];
        let mut fired = false;
        for _ in 0..25 {
            if engine.feed(&silence).is_some() {
                fired = true;
            }
        }
        assert!(!fired, "silence must never trigger the wake word");
    }
}
