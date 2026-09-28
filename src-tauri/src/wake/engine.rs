//! The on-device wake-word inference pipeline — 100% local, no network.
//!
//! Two stacked models, both bundled into the binary (`include_bytes!`), so the
//! feature works offline on first launch:
//!
//!  1. **openWakeWord**, a three-stage pipeline on 16 kHz mono audio:
//!       audio → melspectrogram (32-bin) → shared speech embedding (96-dim) →
//!       per-phrase classifier → probability in [0, 1].
//!     The melspectrogram + embedding models are SHARED across every phrase; only
//!     the final tiny classifier is per-phrase, which is why bundling a second
//!     wake word ("hey jarvis" beside "alexa") costs only a few hundred KB.
//!
//!  2. **Silero VAD**, on every 32 ms of audio. It does not detect the phrase: it
//!     VETOES a fire whose trailing ~1.3 s held no speech (`VAD_VETO_MIN`) and,
//!     through that veto, drives the silence gate below. A VAD failure fails OPEN
//!     (reported as certain speech) rather than killing the feature.
//!
//! Streaming shape (openWakeWord's design): a detection step every `CHUNK` (1280
//! samples / 80 ms). A step computes the melspectrogram over its trailing
//! 12 800-sample window and embeds the newest 76 frames; the last 16 embeddings
//! form the classifier's window, and once 16 are collected the classifier scores
//! them.
//!
//! ⚠️ The melspectrogram is recomputed over the WHOLE window on purpose, not
//! incrementally over the new audio the way openWakeWord's own streaming code
//! does. The model floors every value at 80 dB below the loudest value of its
//! input (a top_db clamp over the whole call), so a quiet frame's value depends
//! on everything computed with it — digital silence next to speech comes out
//! different. An incremental version feeds the classifier features this pipeline
//! was never tuned on, for a saving of ~13 µs a step (the model's cost is almost
//! all fixed per-call overhead: 97 µs for the full window, 84 µs for 8 frames).
//! `the_melspectrogram_depends_on_its_whole_window` pins the reason.
//!
//! ## The silence gate — the battery guard
//!
//! The embedding model is ~3/4 of a step's cost, and in a quiet room nearly all of
//! it is wasted: a fire requires Silero to have heard speech somewhere in the last
//! 16 scored steps, so while none of them did the classifier CANNOT fire, whatever
//! it would have scored. The gate skips the melspectrogram, the embedding and the
//! classifier for those steps — without losing what they would have seen. Each
//! skipped step still gets its slot (where its window ends) and its trace entry
//! (Silero's probability, the level), and the raw audio behind the skipped
//! windows is kept (~2.2 s). The moment speech enters the window, the gate
//! BACKFILLS: it computes the skipped embeddings of the classifier's 16-step
//! window, and recomputes any skipped score patience still depends on. The classifier
//! therefore scores exactly the inputs it would have scored ungated, and every
//! decision — patience, the veto, the cooldown — comes out identical.
//! `the_silence_gate_changes_no_decision_*` replays speech, silence, noise and
//! broken input through this engine and through the pre-gate one
//! (`engine/reference.rs`) and requires the same fires, candidates and scores.
//!
//! What the gate cannot skip exactly, it does not skip. Silero runs on every
//! frame: it is recurrent, so dropping audio would shift every later probability,
//! and those probabilities decide the veto. And debug capture runs ungated: the
//! candidates it records as blocked by `no_speech` are precisely the steps the
//! gate would skip, and they are the evidence that capture exists to collect.

use std::collections::VecDeque;

use ort::session::Session;
use ort::value::Tensor;

/// Working sample rate of the whole pipeline. `capture.rs` resamples the device
/// input down to this before anything here runs.
pub const SAMPLE_RATE: u32 = 16_000;

/// One detection step per 80 ms of new audio (openWakeWord's step). `capture.rs`
/// batches the microphone into whole steps, so the worker thread wakes once per
/// step instead of once per audio callback.
pub const CHUNK: usize = 1280;
/// Mel frames per embedding window.
const EMB_FRAMES: usize = 76;
/// Number of consecutive embeddings the classifier scores.
const CLASSIFIER_EMBEDDINGS: usize = 16;
/// Width of one embedding (the classifier's per-step feature).
const EMBEDDING_DIM: usize = 96;
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
/// ⚠️ Read together with `threshold_for`: patience and the threshold were tuned as
/// ONE pair, against 10 recorded real utterances and a confirmed false positive.
/// Changing either alone undoes the other.
///
/// Why 2 and not more: the FIRST step of a real detection is a ramp-in — the
/// classifier window is only part-way into the phrase, so it scores modestly
/// (0.66-0.82 across the recordings) before pinning at ~1.00. Demanding three
/// consecutive steps over a HIGH bar therefore fails on the ramp, not on the
/// phrase: at threshold 0.90, patience 3 lost 4 of 10 genuine utterances while
/// patience 2 lost none. Two steps over a high bar beats three over a low one.
const PATIENCE_STEPS: u32 = 2;
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
///
/// This same window is what the silence gate reads: below this peak, a step
/// cannot fire, so the gate may leave it unscored.
const VAD_VETO_MIN: f32 = 0.5;
/// Detection steps of score history kept for diagnostics (~3.2 s). Dumped with
/// every fire so a false positive shows its whole approach, not just the peak.
const TRACE_STEPS: usize = 40;
/// Raw audio retained for a debug dump (4 s at 16 kHz) — comfortably more than
/// the ~2 s the classifier looks at, so the clip holds the sound that fired it
/// AND its lead-in. Only ever filled when debug capture is on.
const DEBUG_AUDIO_SAMPLES: usize = SAMPLE_RATE as usize * 4;
/// Embedding slots kept — how far back the silence gate can backfill. The
/// classifier's window is the newest 16; patience may also need the scores of the
/// `PATIENCE_STEPS − 1` steps before it, each over a window one step older; the
/// two spares cover a step whose classifier call failed (it keeps its embedding
/// but gets no score, so the previous SCORED step sits one slot further back).
const SLOT_HISTORY: usize = CLASSIFIER_EMBEDDINGS + PATIENCE_STEPS as usize - 1 + 2;
// Recomputing a skipped score for patience walks the trace back
// `PATIENCE_STEPS − 1` entries: they have to still be in it.
const _: () = assert!((PATIENCE_STEPS as usize) < TRACE_STEPS);
/// Largest sample magnitude whose melspectrogram is guaranteed finite, so the
/// gate can skip a step over such audio and still know it would NOT have been
/// dropped (a step with a non-finite melspectrogram is dropped, which changes
/// which steps get scored — the gate must reproduce that exactly).
///
/// The bound is loose on purpose. At the model's int16 scale a sample this big is
/// ≤ 3.3e8; a 512-point spectrum of such samples is ≤ 1.7e11 in magnitude, its
/// power ≤ 2.9e22, and a mel band sums at most 257 of those — ~1e25, thirteen
/// orders of magnitude under f32's 3.4e38 — and the model's clamps (a −100 dB
/// floor before its log, then 80 dB under the window's peak) keep a finite value
/// finite. Microphone audio lives in ±1. A window holding anything past the bound,
/// or a NaN/infinity, is embedded eagerly, gate or no gate, exactly as it always
/// was. `mel_of_extreme_finite_audio_stays_finite` pins it.
const MEL_SAFE_ABS: f32 = 1.0e4;
/// Raw audio kept past what the pipeline still needs before the buffer is
/// compacted — so it is shifted about twice a second, not on every step.
const AUDIO_TRIM_SLACK: usize = CHUNK * 6;

/// One detection step's diagnostics — the numbers that explain a fire.
#[derive(Debug, Clone, Copy)]
pub struct StepTrace {
    /// The classifier's probability for this step. `None` when the silence gate
    /// skipped it and nothing later needed it — never under debug capture, which
    /// runs ungated, so a dumped trace is always complete.
    pub score: Option<f32>,
    /// Silero's PEAK speech probability over the audio that fed this step — what
    /// the fire-time veto (and so the silence gate) reads over the trailing window.
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
    /// The last `TRACE_STEPS` scored steps, oldest first, ending with the firing
    /// step. Complete under debug capture (see `StepTrace::score`).
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
/// threshold. Default 0.5 → 0.90.
///
/// The band used to be 0.30-0.90 with 0.60 in the middle, which measurement showed
/// was aimed at the wrong place entirely. Scores from this pipeline are bimodal —
/// near 0 or near 1 — so nothing interesting happens below ~0.8, and the slider
/// spent its whole upper half in a range no setting should ever use: a confirmed
/// false positive peaked at 0.92, while non-speech spikes reached 0.98. Worse, the
/// old band could not even REACH a threshold above 0.90, so the one region that
/// separates real from false was unreachable by design.
///
/// 0.82-0.98 is that region. Every one of 10 recorded real utterances clears 0.90
/// for at least two consecutive steps; the confirmed false positive touches 0.92
/// exactly once.
///
/// ⚠️ Tuned on ONE confirmed false positive against ten real utterances, which
/// places a boundary inside a 0.01 gap. It holds on that evidence and no more —
/// the durable fix is retraining the classifier, which has never seen background
/// noise or a real human voice.
fn threshold_for(sensitivity: f32) -> f32 {
    let s = sensitivity.clamp(0.0, 1.0);
    0.98 - 0.16 * s
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
        // A background listener has no business grabbing every core. One intra-op
        // thread also means inference runs ON the worker thread, so the worker's
        // QoS class (see `run_worker`) is what schedules it.
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
    /// is what lets it ride in the trace and veto a fire. On any model error the
    /// VAD latches off and reports certain speech (fail-open — never silence the
    /// feature over a VAD glitch; it also keeps the silence gate open, so a dead
    /// VAD costs battery, never a detection).
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

/// One embedded step: where its window ends, and its embedding once computed.
/// The silence gate leaves `embedding` empty until a score needs it.
struct Slot {
    /// Monotonic id, so a trace entry can find its step's slot again.
    id: u64,
    /// Absolute sample at which the step's trailing window ends.
    end: u64,
    embedding: Option<Vec<f32>>,
}

/// One scored step — a step the classifier WOULD have scored, whether or not the
/// silence gate actually computed its score.
struct TraceEntry {
    trace: StepTrace,
    /// The step's slot: where a skipped score is recomputed from.
    slot: u64,
    /// The patience counter right after this step, saturated at `PATIENCE_STEPS`;
    /// `None` while the gate has skipped the step's score.
    consecutive: Option<u32>,
    /// The step number, for the tests' score log.
    #[cfg(test)]
    step: u64,
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
    /// Rolling 16 kHz audio; `audio[0]` is absolute sample `audio_start`. Holds the
    /// next step's window, the window of every slot whose embedding the gate
    /// deferred, and whatever has arrived past the last step.
    audio: Vec<f32>,
    audio_start: u64,
    /// Detection steps taken so far; step `n` ends at absolute sample `n·CHUNK`.
    steps: u64,
    /// The newest absolute sample that was NaN, infinite or past `MEL_SAFE_ABS` —
    /// a step whose window holds it is embedded eagerly, gate or no gate.
    last_suspicious: Option<u64>,
    /// The embedded steps since the last fire, newest last, at most `SLOT_HISTORY`.
    /// The classifier's window is the newest 16.
    slots: VecDeque<Slot>,
    next_slot: u64,
    /// Steps remaining in the post-detection cooldown.
    cooldown: u32,
    /// Consecutive steps scored at or above the threshold (the patience counter),
    /// saturated at `PATIENCE_STEPS` — every comparison stops there. `None` while
    /// the gate has skipped the newest scored step's score.
    consecutive: Option<u32>,
    /// Peak Silero probability observed since the last step.
    vad_peak: f32,
    /// Previous per-step VAD state, to log speech rising edges (diagnostics).
    was_speech: bool,
    /// Rolling per-step history, capped at `TRACE_STEPS`: the veto window, the
    /// patience history, and the trace a detection carries.
    trace: VecDeque<TraceEntry>,
    /// Whether to retain raw audio for a debug dump. OFF keeps `debug_audio`
    /// permanently empty — a user who did not opt in never has mic audio buffered.
    debug: bool,
    debug_audio: VecDeque<f32>,
    /// Latches after the first non-finite feature frame, so a dead input logs once
    /// instead of every 80 ms.
    warned_non_finite: bool,
    /// Whether the silence gate may skip work. Off under debug capture, and latched
    /// off for good if a deferred computation ever fails (see `abandon_gate`).
    gate: bool,
    /// Every score computed, as `(step, score)` — what the equivalence tests read.
    #[cfg(test)]
    score_log: Vec<(u64, f32)>,
    /// Skipped scores recomputed for patience — proof a test exercised that path.
    #[cfg(test)]
    resolved: usize,
    /// Embeddings computed — the gate must never compute MORE than ungated.
    #[cfg(test)]
    embeds: usize,
}

impl Engine {
    /// Build the engine for one phrase + sensitivity. Loads all four models
    /// (VAD + the three openWakeWord stages) — a few tens of ms, done once when
    /// the detector arms. `debug` turns on raw-audio retention for fire dumps (and
    /// with it runs the pipeline ungated — see the module docs).
    pub fn new(phrase: &str, sensitivity: f32, debug: bool) -> Result<Self, String> {
        Ok(Self {
            mel: build_session(MEL_MODEL)?,
            embedding: build_session(EMBEDDING_MODEL)?,
            classifier: build_session(classifier_bytes(phrase))?,
            vad: Vad::new()?,
            phrase: phrase.to_string(),
            threshold: threshold_for(sensitivity),
            audio: Vec::with_capacity(MEL_WINDOW_SAMPLES * 3 + AUDIO_TRIM_SLACK),
            audio_start: 0,
            steps: 0,
            last_suspicious: None,
            slots: VecDeque::with_capacity(SLOT_HISTORY + 1),
            next_slot: 0,
            cooldown: 0,
            consecutive: Some(0),
            vad_peak: 0.0,
            was_speech: false,
            trace: VecDeque::with_capacity(TRACE_STEPS),
            debug,
            debug_audio: VecDeque::with_capacity(if debug { DEBUG_AUDIO_SAMPLES } else { 0 }),
            warned_non_finite: false,
            // Debug capture records the candidates the veto blocks, and those are
            // exactly the steps the gate would skip.
            gate: !debug,
            #[cfg(test)]
            score_log: Vec::new(),
            #[cfg(test)]
            resolved: 0,
            #[cfg(test)]
            embeds: 0,
        })
    }

    /// The phrase this engine detects (for the emitted event).
    pub fn phrase(&self) -> &str {
        &self.phrase
    }

    /// Feed freshly-captured 16 kHz mono audio. Returns `Some(detection)` the
    /// moment the configured phrase is detected (at most once per spoken phrase,
    /// thanks to the cooldown). `None` otherwise.
    pub fn feed(&mut self, samples: &[f32]) -> Option<Detection> {
        // Silero hears EVERY sample, gate or no gate. It is recurrent, so skipping
        // audio would change every probability after the gap — and the fire-time
        // veto reads those probabilities over the TRAILING window (never the firing
        // step's own 80 ms: the classifier scores ~2 s of context, so it typically
        // fires one or two steps AFTER the phrase ends, on audio that is already
        // silent — measured on a `say "Alexa"` clip, the step scoring 1.000 carries
        // vad=0.01 while the steps holding the phrase read ~1.0).
        self.vad_peak = self.vad_peak.max(self.vad.speech_prob(samples));

        // Anything the melspectrogram might not survive (NaN, ±inf, absurd values)
        // pins its step's window to the eager path — see `MEL_SAFE_ABS`.
        if let Some(i) = samples.iter().rposition(|s| !(s.abs() <= MEL_SAFE_ABS)) {
            self.last_suspicious = Some(self.audio_start + (self.audio.len() + i) as u64);
        }
        self.audio.extend_from_slice(samples);
        if self.debug {
            for &s in samples {
                if self.debug_audio.len() == DEBUG_AUDIO_SAMPLES {
                    self.debug_audio.pop_front();
                }
                self.debug_audio.push_back(s);
            }
        }

        let received = self.audio_start + self.audio.len() as u64;
        let mut hit: Option<Detection> = None;
        // One step per whole CHUNK received, step `n` ending at absolute sample
        // `n·CHUNK`: a callback carrying several chunks yields several steps over
        // DIFFERENT audio. (Slicing the buffer's tail instead — what this once did —
        // handed every step of such a callback the SAME audio, stuffing the rolling
        // window with duplicate embeddings and corrupting the very temporal pattern
        // the classifier is trained on.)
        while (self.steps + 1) * CHUNK as u64 <= received {
            self.steps += 1;
            if let Some(detection) = self.step(self.steps * CHUNK as u64) {
                hit = Some(detection);
            }
        }
        self.trim();
        hit
    }

    /// One 80 ms detection step over the audio ENDING at absolute sample `end`:
    /// add the step's embedding to a CONTINUOUS rolling window of the last 16 and,
    /// once the window is full, classify — or, while the trailing window holds no
    /// speech, leave both for later (the silence gate; see the module docs). The
    /// window is never cleared on silence: the classifier would lose the context
    /// it was trained on. Only a fire clears it.
    fn step(&mut self, end: u64) -> Option<Detection> {
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
        if end < MEL_WINDOW_SAMPLES as u64 {
            return None; // buffer not primed yet
        }
        let rms = self.window_rms(end);
        let slot = self.push_slot(end);
        let newest = self.slots.len() - 1;
        // Embed now when ungated — and whenever the window holds audio the
        // melspectrogram might not survive: whether such a step is DROPPED (never
        // scored) can only be known by computing it, and the gate must drop exactly
        // the steps the ungated pipeline drops. (Only the NEWEST suspicious sample is
        // tracked, so "at or after the window's start" is the safe test: it may
        // embed a clean step early — harmless — but never lets a poisoned one by.)
        let suspicious =
            self.last_suspicious.is_some_and(|at| at >= end - MEL_WINDOW_SAMPLES as u64);
        if (!self.gate || suspicious) && !self.embed(newest) {
            self.slots.pop_back(); // a step whose features are unusable is dropped whole
            return None;
        }
        if self.slots.len() < CLASSIFIER_EMBEDDINGS {
            return None; // the classifier's window is not full yet
        }

        if self.gate && self.recent_vad_peak(vad) < VAD_VETO_MIN {
            // SILENCE GATE. No speech anywhere in the window the veto reads, so this
            // step cannot fire: skip its embedding and its score. Its slot and trace
            // entry stay, so the window keeps its exact shape — a later step
            // backfills the embedding, and recomputes the score if patience asks.
            self.push_trace(None, vad, rms, slot);
            self.consecutive = None;
            return None;
        }
        if self.gate {
            if !self.embed(newest) {
                self.slots.pop_back();
                return None;
            }
            if !self.embed_window(newest) {
                self.abandon_gate("a skipped step's embedding could not be backfilled");
                return None;
            }
        }
        let score = self.classify_at(newest)?;
        #[cfg(test)]
        self.score_log.push((self.steps, score));
        self.push_trace(Some(score), vad, rms, slot);
        // Only log a score worth noticing — ambient/silence sits near 0 (no spam), a
        // near-miss or a hit is visible. `vad` and `rms` ride along: they are what
        // tells a real utterance apart from a fire on room tone, straight from the
        // console. (A step the silence gate skipped is not scored, so not logged.)
        if score > 0.3 {
            eprintln!(
                "[wake] score={score:.3} (threshold {:.3}) vad={vad:.2} rms={rms:.4}",
                self.threshold
            );
        }
        if score < self.threshold {
            self.settle_consecutive(0);
            return None;
        }
        let consecutive = (self.consecutive_before_newest() + 1).min(PATIENCE_STEPS);

        // Two gates, both measured against the recorded false positives. Together
        // they suppressed all 25 while leaving a real utterance (12-18 steps above
        // threshold, VAD peak 0.62-1.00) a wide margin.
        let suppressed_by = if consecutive < PATIENCE_STEPS {
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
            self.settle_consecutive(consecutive);
            return None;
        }
        if suppressed_by.is_none() {
            self.cooldown = REFIRE_COOLDOWN_STEPS;
            self.settle_consecutive(0);
            self.slots.clear();
        } else {
            self.settle_consecutive(consecutive);
        }
        Some(Detection {
            suppressed_by,
            score,
            threshold: self.threshold,
            trace: self.trace.iter().map(|e| e.trace).collect(),
            audio: self.debug.then(|| self.debug_audio.iter().copied().collect()),
        })
    }

    /// Peak Silero probability across the trailing window the classifier scored.
    fn vad_window_peak(&self) -> f32 {
        self.trace
            .iter()
            .rev()
            .take(VAD_VETO_STEPS)
            .map(|e| e.trace.vad)
            .fold(0.0f32, f32::max)
    }

    /// `vad_window_peak` as it WILL read once this step's entry (carrying `vad`) is
    /// in the trace — the gate decides before pushing it.
    fn recent_vad_peak(&self, vad: f32) -> f32 {
        self.trace
            .iter()
            .rev()
            .take(VAD_VETO_STEPS - 1)
            .map(|e| e.trace.vad)
            .fold(vad, f32::max)
    }

    /// The patience counter right after the PREVIOUS scored step (saturated).
    /// Known unless the gate skipped that step's score; then the skipped scores are
    /// recomputed, newest first, only as far as patience can look back.
    fn consecutive_before_newest(&mut self) -> u32 {
        if let Some(known) = self.consecutive {
            return known;
        }
        // Patience only asks whether the last `PATIENCE_STEPS − 1` scored steps all
        // cleared the bar (the step being decided makes up the rest), so walk back
        // no further than that.
        let enough = PATIENCE_STEPS - 1;
        let mut run = 0u32;
        // The newest entry is the step being decided; walk the ones before it.
        for idx in (0..self.trace.len().saturating_sub(1)).rev() {
            if run >= enough {
                break;
            }
            if let Some(known) = self.trace[idx].consecutive {
                return (known + run).min(PATIENCE_STEPS);
            }
            let score = match self.trace[idx].trace.score {
                Some(score) => score,
                None => match self.resolve_score(idx) {
                    Some(score) => score,
                    None => {
                        self.abandon_gate("a skipped score could not be recomputed");
                        return 0;
                    }
                },
            };
            if score < self.threshold {
                return run;
            }
            run += 1;
        }
        run
    }

    /// Recompute the score the gate skipped for trace entry `idx`, over that step's
    /// own 16-slot window — exactly what the classifier would have seen then.
    fn resolve_score(&mut self, idx: usize) -> Option<f32> {
        let id = self.trace[idx].slot;
        let pos = self.slots.iter().rposition(|s| s.id == id)?;
        if pos + 1 < CLASSIFIER_EMBEDDINGS || !self.embed_window(pos) {
            return None;
        }
        let score = self.classify_at(pos)?;
        #[cfg(test)]
        {
            self.score_log.push((self.trace[idx].step, score));
            self.resolved += 1;
        }
        self.trace[idx].trace.score = Some(score);
        Some(score)
    }

    /// Stop gating, for good, after a deferred computation failed where the
    /// ungated pipeline would not have been asked to do it. Only reachable if the
    /// embedding or classifier model errors, or returns a non-finite value, on a
    /// finite input — which a bounded network does not do (pinned by the test
    /// `embedding_and_classifier_stay_finite_on_extreme_input`). Were it to happen,
    /// the one decision it touches is replayed conservatively: the scoring window
    /// restarts (like after a fire, minus the cooldown) and the engine runs ungated
    /// from then on, so it can never be wrong the same way twice.
    fn abandon_gate(&mut self, why: &str) {
        eprintln!(
            "[wake] silence gate switched OFF: {why}. Running the full pipeline on every \
             step from now on; the scoring window restarts."
        );
        self.gate = false;
        self.slots.clear();
        self.consecutive = Some(0);
    }

    /// Record the patience counter after the newest scored step.
    fn settle_consecutive(&mut self, consecutive: u32) {
        self.consecutive = Some(consecutive);
        if let Some(entry) = self.trace.back_mut() {
            entry.consecutive = Some(consecutive);
        }
    }

    fn push_trace(&mut self, score: Option<f32>, vad: f32, rms: f32, slot: u64) {
        if self.trace.len() == TRACE_STEPS {
            self.trace.pop_front();
        }
        self.trace.push_back(TraceEntry {
            trace: StepTrace { score, vad, rms },
            slot,
            consecutive: None,
            #[cfg(test)]
            step: self.steps,
        });
    }

    fn push_slot(&mut self, end: u64) -> u64 {
        let id = self.next_slot;
        self.next_slot += 1;
        if self.slots.len() == SLOT_HISTORY {
            self.slots.pop_front();
        }
        self.slots.push_back(Slot { id, end, embedding: None });
        id
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
        self.warn_non_finite(stage);
        false
    }

    fn warn_non_finite(&mut self, stage: &str) {
        if !self.warned_non_finite {
            self.warned_non_finite = true;
            eprintln!(
                "[wake] {stage} produced non-finite values — those steps are dropped. \
                 The input device is most likely muted or dead; detection resumes on \
                 its own once real audio comes back."
            );
        }
    }

    /// The absolute samples `[from, to)` — always still buffered (see `trim`).
    fn samples(&self, from: u64, to: u64) -> &[f32] {
        &self.audio[(from - self.audio_start) as usize..(to - self.audio_start) as usize]
    }

    /// RMS of the trailing window the step ending at `end` scores — the cheap,
    /// honest answer to "did this step fire on silence?".
    fn window_rms(&self, end: u64) -> f32 {
        let raw = self.samples(end - MEL_WINDOW_SAMPLES as u64, end);
        (raw.iter().map(|s| s * s).sum::<f32>() / raw.len() as f32).sqrt()
    }

    /// Make sure the slot at `pos` has its embedding: the melspectrogram of its
    /// trailing window, newest 76 frames, through the embedding model. False when
    /// the step's features are unusable (non-finite, or a model error — logged), in
    /// which case the step must be dropped.
    fn embed(&mut self, pos: usize) -> bool {
        if self.slots[pos].embedding.is_some() {
            return true;
        }
        #[cfg(test)]
        {
            self.embeds += 1;
        }
        let end = self.slots[pos].end;
        let raw = self.samples(end - MEL_WINDOW_SAMPLES as u64, end);
        // openWakeWord's melspectrogram model was trained on int16-SCALE audio
        // (raw sample values, ~±32768), NOT normalized [-1,1]. The rest of the
        // pipeline (and Silero VAD) works in [-1,1], so scale up only here.
        let window: Vec<f32> = raw.iter().map(|&s| s * 32768.0).collect();
        let (_, mut mel) = match run_single(&mut self.mel, vec![1, window.len() as i64], window) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[wake] melspectrogram inference failed: {e}");
                return false;
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
            return false;
        }
        // Newest 76 frames → embedding input [1, 76, 32, 1].
        let start = (frames - EMB_FRAMES) * MEL_BINS;
        let win = mel[start..start + EMB_FRAMES * MEL_BINS].to_vec();
        if !self.check_finite(&win, "melspectrogram") {
            return false;
        }
        match run_single(&mut self.embedding, vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1], win) {
            Ok((_, emb)) if self.check_finite(&emb, "embedding") => {
                self.slots[pos].embedding = Some(emb);
                true
            }
            Ok(_) => false,
            Err(e) => {
                eprintln!("[wake] embedding inference failed: {e}");
                false
            }
        }
    }

    /// Embed every slot of the classifier window ending at `pos`.
    fn embed_window(&mut self, pos: usize) -> bool {
        for i in pos + 1 - CLASSIFIER_EMBEDDINGS..=pos {
            if !self.embed(i) {
                return false;
            }
        }
        true
    }

    /// Run the per-phrase classifier over the 16 embeddings ending at slot `pos`.
    fn classify_at(&mut self, pos: usize) -> Option<f32> {
        let mut flat = Vec::with_capacity(CLASSIFIER_EMBEDDINGS * EMBEDDING_DIM);
        for slot in self.slots.range(pos + 1 - CLASSIFIER_EMBEDDINGS..=pos) {
            flat.extend_from_slice(slot.embedding.as_deref()?);
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

    /// Release the raw audio no future step can read: behind both the next step's
    /// window and the window of every slot whose embedding the gate deferred.
    fn trim(&mut self) {
        let end = self.steps * CHUNK as u64;
        let oldest_needed = self
            .slots
            .iter()
            .find(|s| s.embedding.is_none())
            .map_or(end, |s| s.end.min(end));
        let keep_from = oldest_needed.saturating_sub(MEL_WINDOW_SAMPLES as u64);
        let excess = keep_from.saturating_sub(self.audio_start) as usize;
        if excess >= AUDIO_TRIM_SLACK {
            self.audio.drain(..excess);
            self.audio_start += excess as u64;
        }
    }
}

/// The engine as it shipped before the incremental melspectrogram and the silence
/// gate — the oracle the equivalence tests hold this one to.
#[cfg(test)]
mod reference;

#[cfg(test)]
mod tests {
    use super::reference::ReferenceEngine;
    use super::*;

    impl Engine {
        /// Test-only view of the rolling score history, so a test can compare the
        /// trajectories of two engines fed the SAME audio in different callback sizes.
        fn trace_scores(&self) -> Vec<Option<f32>> {
            self.trace.iter().map(|e| e.trace.score).collect()
        }

        /// The same engine with the silence gate off (debug capture aside).
        fn ungated(mut self) -> Self {
            self.gate = false;
            self
        }
    }

    #[test]
    fn threshold_maps_sensitivity_monotonically() {
        // Louder sensitivity → lower (looser) threshold, clamped to [0,1] input.
        assert!(threshold_for(0.0) > threshold_for(1.0));
        assert!((threshold_for(0.5) - 0.90).abs() < 1e-5);
        assert_eq!(threshold_for(-1.0), threshold_for(0.0)); // clamp
        assert_eq!(threshold_for(2.0), threshold_for(1.0)); // clamp
    }

    /// The whole slider must stay in the band where this pipeline's scores
    /// actually separate. A confirmed false positive peaked at 0.92 and non-speech
    /// spikes reached 0.98, so a reachable setting below ~0.8 is not a "loose"
    /// option — it is one that cannot work, offered as though it could.
    #[test]
    fn the_sensitivity_band_stays_where_scores_separate() {
        assert!(threshold_for(1.0) >= 0.80, "the loosest setting is still usable");
        assert!(threshold_for(0.0) <= 0.99, "the strictest setting is still reachable");
        assert!(threshold_for(0.0) > 0.92, "the strictest beats the confirmed false positive");
    }

    #[test]
    fn phrase_catalogue_has_the_default() {
        assert!(PHRASES.iter().any(|(k, _)| *k == DEFAULT_PHRASE));
    }

    /// Push a synthetic tone through mel → embedding → classifier directly,
    /// asserting every ONNX run succeeds and the shapes line up end-to-end. The
    /// streaming path logs-and-swallows inference errors, so a shape bug could
    /// hide until a live mic — this catches it headlessly. Detection ACCURACY
    /// still needs a real mic.
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
        let mut seq: Vec<f32> = Vec::with_capacity(CLASSIFIER_EMBEDDINGS * EMBEDDING_DIM);
        for e in 0..CLASSIFIER_EMBEDDINGS {
            let start = e * 8 * MEL_BINS;
            let win = mel_out[start..start + EMB_FRAMES * MEL_BINS].to_vec();
            let (_, emb) =
                run_single(&mut embedding, vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1], win)
                    .expect("embedding runs");
            assert_eq!(emb.len(), EMBEDDING_DIM, "embedding is 96-dim");
            seq.extend_from_slice(&emb);
        }
        let (_, out) = run_single(
            &mut classifier,
            vec![1, CLASSIFIER_EMBEDDINGS as i64, EMBEDDING_DIM as i64],
            seq,
        )
        .expect("classifier runs");
        let score = out.first().copied().expect("a score");
        assert!((0.0..=1.0).contains(&score), "score in [0,1], got {score}");
    }

    /// Why the melspectrogram is recomputed over the whole trailing window every
    /// step instead of incrementally over the new audio (openWakeWord's own
    /// streaming — and the "obvious" optimisation): the model floors every value at
    /// 80 dB below the loudest value of ITS INPUT, so a quiet frame computed next to
    /// speech is not the frame computed next to silence. Pinned so the change is not
    /// made by accident: it would feed the classifier features the pipeline was
    /// never tuned on (the equivalence tests below measured scores moving by 5e-3).
    #[test]
    fn the_melspectrogram_depends_on_its_whole_window() {
        let mut mel = build_session(MEL_MODEL).unwrap();
        // Digital silence, then speech: far more than 80 dB inside one window.
        let mut audio = vec![0.0f32; 1760];
        audio.extend(parse_wav_i16(SPEECH_WAV));
        audio.resize(MEL_WINDOW_SAMPLES, 0.0);
        let scaled: Vec<f32> = audio.iter().map(|s| s * 32768.0).collect();
        let (_, full) =
            run_single(&mut mel, vec![1, MEL_WINDOW_SAMPLES as i64], scaled.clone()).unwrap();
        // The same first 8 frames (all silence), computed on their own.
        let (_, alone) = run_single(&mut mel, vec![1, 1632], scaled[..1632].to_vec()).unwrap();
        let floor = full.iter().copied().fold(f32::NEG_INFINITY, f32::max) - 80.0;
        assert!(full.iter().all(|&v| v >= floor), "nothing sits below the window's floor");
        assert!(full.iter().any(|&v| v == floor), "the silence was lifted exactly TO it");
        assert_ne!(alone[..], full[..alone.len()], "the same frames computed alone differ");
    }

    /// `MEL_SAFE_ABS` claims any frame over audio within ±1e4 comes out finite —
    /// the gate defers such frames and must know, without computing them, that no
    /// step over them will be dropped. The worst cases: full-scale square waves at
    /// the bound, at ±1 (a clipping microphone), and digital silence (the clamp).
    #[test]
    fn mel_of_extreme_finite_audio_stays_finite() {
        let mut mel = build_session(MEL_MODEL).unwrap();
        let square = |amp: f32| -> Vec<f32> {
            (0..4096).map(|i| if (i / 7) % 2 == 0 { amp } else { -amp }).collect()
        };
        for (label, audio) in [
            ("square at the bound", square(MEL_SAFE_ABS)),
            ("full-scale square", square(1.0)),
            ("DC at the bound", vec![MEL_SAFE_ABS; 4096]),
            ("digital silence", vec![0.0; 4096]),
        ] {
            let scaled: Vec<f32> = audio.iter().map(|s| s * 32768.0).collect();
            let (_, out) = run_single(&mut mel, vec![1, scaled.len() as i64], scaled).unwrap();
            assert!(out.iter().all(|v| v.is_finite()), "{label}: the melspectrogram went non-finite");
        }
    }

    /// The gate's one assumption about the two later models: a finite input gives
    /// a finite output (otherwise a step it skipped could have been one the ungated
    /// pipeline dropped). Pushed to the edges of the normalized mel range.
    #[test]
    fn embedding_and_classifier_stay_finite_on_extreme_input() {
        let mut embedding = build_session(EMBEDDING_MODEL).unwrap();
        let normalized_floor = -100.0f32 / 10.0 + 2.0; // the mel clamp, normalized
        for (label, value) in [("floor", normalized_floor), ("huge", 1.0e3), ("negative huge", -1.0e3)] {
            let (_, emb) = run_single(
                &mut embedding,
                vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1],
                vec![value; EMB_FRAMES * MEL_BINS],
            )
            .unwrap();
            assert!(emb.iter().all(|v| v.is_finite()), "embedding of a {label} window");
            for (key, _) in PHRASES {
                let mut classifier = build_session(classifier_bytes(key)).unwrap();
                let (_, out) = run_single(
                    &mut classifier,
                    vec![1, CLASSIFIER_EMBEDDINGS as i64, EMBEDDING_DIM as i64],
                    emb.iter().copied().cycle().take(CLASSIFIER_EMBEDDINGS * EMBEDDING_DIM).collect(),
                )
                .unwrap();
                assert!(out.iter().all(|v| v.is_finite()), "{key} over a {label} window");
            }
        }
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
    /// complaint this pins down. Run ungated too: the gate would otherwise answer
    /// for the classifier here, and the point is the classifier + veto.
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
                for gated in [true, false] {
                    let engine = Engine::new(key, 0.5, false).expect("engine builds");
                    let mut engine = if gated { engine } else { engine.ungated() };
                    for chunk in audio.chunks(CHUNK) {
                        if let Some(d) = engine.feed(chunk) {
                            failures.push(format!("{key} fired on {label} (score {:.3})", d.score));
                            break;
                        }
                    }
                }
            }
        }
        assert!(failures.is_empty(), "non-speech must never wake the app: {failures:?}");
    }

    /// The engine used to slice the buffer's TAIL for every step, so a callback
    /// carrying several 80 ms chunks fed the rolling window the SAME embedding
    /// repeated — a different (and wrong) trajectory than the identical audio
    /// arriving in small callbacks. Both must now agree exactly. (Ungated, so
    /// every step carries a score to compare.)
    #[test]
    fn callback_size_does_not_change_the_score_trajectory() {
        let audio = pseudo_noise(SAMPLE_RATE as usize * 3, 0.05);
        let mut small = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds").ungated();
        for chunk in audio.chunks(160) {
            small.feed(chunk); // ~10 ms callbacks, the CoreAudio-sized case
        }
        let mut big = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds").ungated();
        for chunk in audio.chunks(CHUNK * 4) {
            big.feed(chunk); // 320 ms callbacks, several steps drained at once
        }
        let small_scores = small.trace_scores();
        assert!(!small_scores.is_empty(), "the run must produce scored steps");
        assert!(small_scores.iter().all(Option::is_some), "ungated, every step is scored");
        assert_eq!(
            small_scores,
            big.trace_scores(),
            "callback size must not change what the classifier sees"
        );
    }

    /// A muted or dead input device can deliver values the mel stage turns
    /// non-finite. Those steps must be DROPPED, never scored: a NaN through the
    /// classifier can come back as a confident hit. (Measured: this melspectrogram
    /// model actually maps NaN audio to finite values — its clamps swallow the NaN —
    /// so what reaches the classifier is scored like silence. Either way, nothing
    /// fires.)
    #[test]
    fn non_finite_audio_is_dropped_never_scored() {
        for gated in [true, false] {
            let engine = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds");
            let mut engine = if gated { engine } else { engine.ungated() };
            let bad = vec![f32::NAN; CHUNK];
            for _ in 0..40 {
                assert!(engine.feed(&bad).is_none(), "NaN audio must never wake the app");
            }
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

    /// Debug capture records the candidates the veto BLOCKS — exactly the steps the
    /// silence gate would skip — so it must run ungated, or the evidence it exists
    /// to collect would silently stop being written.
    #[test]
    fn debug_capture_runs_ungated() {
        assert!(!Engine::new(DEFAULT_PHRASE, 0.5, true).unwrap().gate);
        assert!(Engine::new(DEFAULT_PHRASE, 0.5, false).unwrap().gate);
    }

    /// The gate has to actually SAVE the work, not just be harmless: over a long
    /// quiet stretch no embedding or score is computed, the buffers stay bounded
    /// (a gated step keeps history, it must not keep EVERYTHING), and the phrase
    /// after it is still scored — from backfilled, not missing, embeddings.
    #[test]
    fn the_gate_skips_silence_and_stays_bounded() {
        let mut engine = Engine::new(DEFAULT_PHRASE, 0.5, false).expect("engine builds");
        for chunk in pseudo_noise(SAMPLE_RATE as usize * 30, 0.002).chunks(CHUNK) {
            engine.feed(chunk);
        }
        assert!(engine.score_log.is_empty(), "30 s of room tone: nothing scored");
        assert!(engine.slots.iter().all(|s| s.embedding.is_none()), "nothing embedded");
        assert!(
            engine.audio.len()
                <= MEL_WINDOW_SAMPLES + (SLOT_HISTORY + 1) * CHUNK + AUDIO_TRIM_SLACK + CHUNK,
            "raw audio stays bounded while gated ({} samples)",
            engine.audio.len()
        );
        assert!(engine.slots.len() <= SLOT_HISTORY && engine.trace.len() <= TRACE_STEPS);
        for chunk in parse_wav_i16(SPEECH_WAV).chunks(CHUNK) {
            engine.feed(chunk);
        }
        for chunk in pseudo_noise(SAMPLE_RATE as usize, 0.002).chunks(CHUNK) {
            engine.feed(chunk);
        }
        assert!(!engine.score_log.is_empty(), "speech opens the gate and gets scored");
    }

    // ── Equivalence with the pre-gate engine ─────────────────────────────────

    /// What one engine did with a stream: every candidate it reported (by feed
    /// index, with its trace) and every score it computed (by step).
    #[derive(Default)]
    struct Outcome {
        candidates: Vec<(usize, Option<&'static str>, f32, Vec<(Option<f32>, f32, f32)>)>,
        scores: Vec<(u64, f32)>,
        /// Skipped scores the gate had to recompute for patience.
        resolved: usize,
        /// Embeddings computed.
        embeds: usize,
    }

    /// `threshold`: override the sensitivity-derived one — a low bar turns steps in
    /// silence and at speech onsets into patience candidates, which is what drives
    /// the gate through its hardest path (recomputing a skipped score).
    fn run_engine(audio: &[f32], phrase: &str, debug: bool, chunk: usize, threshold: Option<f32>) -> Outcome {
        let mut engine = Engine::new(phrase, 0.5, debug).expect("engine builds");
        if let Some(t) = threshold {
            engine.threshold = t;
        }
        let mut out = Outcome::default();
        for (i, c) in audio.chunks(chunk).enumerate() {
            if let Some(d) = engine.feed(c) {
                let trace = d.trace.iter().map(|t| (t.score, t.vad, t.rms)).collect();
                out.candidates.push((i, d.suppressed_by, d.score, trace));
            }
        }
        out.scores = std::mem::take(&mut engine.score_log);
        out.resolved = engine.resolved;
        out.embeds = engine.embeds;
        out
    }

    fn run_reference(audio: &[f32], phrase: &str, debug: bool, chunk: usize, threshold: Option<f32>) -> Outcome {
        let mut engine = ReferenceEngine::new(phrase, 0.5, debug);
        if let Some(t) = threshold {
            engine.threshold = t;
        }
        let mut out = Outcome::default();
        for (i, c) in audio.chunks(chunk).enumerate() {
            if let Some(d) = engine.feed(c) {
                let trace = d.trace.iter().map(|&(s, v, r)| (Some(s), v, r)).collect();
                out.candidates.push((i, d.suppressed_by, d.score, trace));
            }
        }
        out.scores = std::mem::take(&mut engine.score_log);
        out
    }

    /// Scores may differ by float noise at most. (Measured: they do not differ at
    /// all — every input the classifier sees is bit-identical — but the contract is
    /// the DECISIONS, and this is the slack a score is allowed.)
    const SCORE_TOLERANCE: f32 = 1e-6;

    /// Require identical decisions and scores; return the largest score gap seen.
    /// `complete`: the engine ran ungated, so it must have scored every step the
    /// reference did (and its candidate traces must carry every score).
    fn assert_same(label: &str, reference: &Outcome, engine: &Outcome, complete: bool) -> f32 {
        let mut worst = 0.0f32;
        let ref_decisions: Vec<_> = reference.candidates.iter().map(|c| (c.0, c.1)).collect();
        let decisions: Vec<_> = engine.candidates.iter().map(|c| (c.0, c.1)).collect();
        assert_eq!(decisions, ref_decisions, "{label}: fires / candidates differ");
        for (r, e) in reference.candidates.iter().zip(&engine.candidates) {
            worst = worst.max((r.2 - e.2).abs());
            assert_eq!(r.3.len(), e.3.len(), "{label}: trace length differs at feed {}", r.0);
            for (rt, et) in r.3.iter().zip(&e.3) {
                // Bitwise: a window holding NaN has a NaN RMS in both, and NaN != NaN.
                assert_eq!(rt.1.to_bits(), et.1.to_bits(), "{label}: trace vad differs");
                assert_eq!(rt.2.to_bits(), et.2.to_bits(), "{label}: trace rms differs");
                match et.0 {
                    Some(s) => worst = worst.max((s - rt.0.unwrap()).abs()),
                    None => assert!(!complete, "{label}: an ungated trace is missing a score"),
                }
            }
        }
        let by_step: std::collections::HashMap<u64, f32> = reference.scores.iter().copied().collect();
        for (step, score) in &engine.scores {
            let expected = by_step
                .get(step)
                .unwrap_or_else(|| panic!("{label}: scored step {step}, which the reference never scored"));
            worst = worst.max((score - expected).abs());
        }
        if complete {
            assert_eq!(engine.scores.len(), reference.scores.len(), "{label}: scored steps differ");
        }
        assert!(worst <= SCORE_TOLERANCE, "{label}: scores drifted by {worst:e}");
        worst
    }

    fn concat(parts: &[&[f32]]) -> Vec<f32> {
        parts.iter().flat_map(|p| p.iter().copied()).collect()
    }

    /// Audio that walks the engine through every state the gate touches, built
    /// from the committed fixture plus deterministic noise: the `detect_wav` layout,
    /// the phrase repeated inside and outside the cooldown, the phrase over noise,
    /// a long gated stretch followed by a clipped phrase (backfill after slot and
    /// frame eviction), NaN and absurd-value bursts (the eager mel path), and a
    /// phrase too quiet for Silero.
    fn scenarios() -> Vec<(&'static str, Vec<f32>)> {
        let alexa = parse_wav_i16(SPEECH_WAV);
        let secs = |s: f32| (SAMPLE_RATE as f32 * s) as usize;
        let zeros = |s: f32| vec![0.0f32; secs(s)];
        let tone = |s: f32| pseudo_noise(secs(s), 0.002);
        let scaled = |k: f32| alexa.iter().map(|x| (x * k).clamp(-1.0, 1.0)).collect::<Vec<_>>();
        let mut over_noise = pseudo_noise(secs(7.0), 0.03);
        for at in [secs(2.0), secs(4.5)] {
            for (i, x) in alexa.iter().enumerate() {
                over_noise[at + i] += 0.8 * x;
            }
        }
        vec![
            ("detect_wav layout", concat(&[&zeros(1.0), &alexa, &zeros(0.5)])),
            (
                "repeated phrase in room tone",
                concat(&[&tone(3.0), &alexa, &tone(0.3), &alexa, &tone(2.0), &alexa, &tone(3.0)]),
            ),
            ("phrase over broadband noise", over_noise),
            ("clipped phrase after 20 s of silence", concat(&[&zeros(20.0), &scaled(4.0), &zeros(2.0)])),
            (
                "NaN and absurd-value bursts around speech",
                concat(&[
                    &tone(2.0),
                    &alexa,
                    &[f32::NAN; 200],
                    &alexa,
                    &tone(1.5),
                    &[1.0e6; 300],
                    &tone(2.0),
                    &alexa,
                    &tone(2.0),
                ]),
            ),
            ("quiet phrase", concat(&[&tone(2.0), &scaled(0.1), &tone(2.0)])),
        ]
    }

    /// The contract of the silence gate: fed the same audio, this engine makes
    /// EXACTLY the decisions the pre-gate engine made — same fires, same suppressed
    /// candidates (debug), same scores wherever it scores — gated (normal) and
    /// ungated (debug capture), across callback sizes. Then again with the bar
    /// lowered, so patience candidates land in silence and at speech onsets and the
    /// gate must recompute scores it skipped.
    fn assert_no_decision_changes(phrase: &str, chunks: &[usize]) {
        let mut worst = 0.0f32;
        let (mut fires, mut stress_fires, mut resolved) = (0usize, 0usize, 0usize);
        let (mut gated_embeds, mut ungated_embeds) = (0usize, 0usize);
        let mut runs: Vec<(usize, Option<f32>)> = chunks.iter().map(|&c| (c, None)).collect();
        // 0.0: every scored step is a candidate, so every gate opening has to
        // recompute the step it skipped just before — the hardest path, every time.
        runs.extend([(CHUNK, Some(0.0)), (CHUNK, Some(0.3)), (CHUNK, Some(0.6))]);
        for (label, audio) in scenarios() {
            for &(chunk, threshold) in &runs {
                let mut embeds = [0usize; 2]; // [gated, ungated (debug)]
                for debug in [false, true] {
                    let reference = run_reference(&audio, phrase, debug, chunk, threshold);
                    let engine = run_engine(&audio, phrase, debug, chunk, threshold);
                    let tag = format!(
                        "{phrase} / {label} / chunk {chunk} / debug {debug} / threshold {threshold:?}"
                    );
                    worst = worst.max(assert_same(&tag, &reference, &engine, debug));
                    let fired = reference.candidates.iter().filter(|c| c.1.is_none()).count();
                    if threshold.is_none() {
                        fires += fired;
                    } else {
                        stress_fires += fired;
                    }
                    resolved += engine.resolved;
                    embeds[debug as usize] = engine.embeds;
                }
                // Backfilling is catching up, never extra work.
                assert!(
                    embeds[0] <= embeds[1],
                    "{phrase} / {label}: the gate computed {} embeddings, ungated {}",
                    embeds[0],
                    embeds[1]
                );
                gated_embeds += embeds[0];
                ungated_embeds += embeds[1];
            }
        }
        eprintln!(
            "[equivalence] {phrase}: {fires} fires matched ({stress_fires} more at lowered \
             thresholds), {resolved} skipped scores recomputed, worst score gap {worst:e}; \
             embeddings {gated_embeds} gated vs {ungated_embeds} ungated"
        );
        if phrase == DEFAULT_PHRASE {
            assert!(fires > 0, "the fixture must fire somewhere, or this proves nothing");
        }
        assert!(stress_fires > 0, "the lowered bars must produce fires to compare");
        assert!(resolved > 0, "the stress runs must reach the recompute-a-skipped-score path");
    }

    #[test]
    fn the_silence_gate_changes_no_decision_alexa() {
        // 171 ≈ one 48 kHz CoreAudio callback resampled; 1280 = what the capture now
        // sends; 4000 = several steps per call.
        assert_no_decision_changes("alexa", &[171, CHUNK, 4000]);
    }

    #[test]
    fn the_silence_gate_changes_no_decision_hey_jarvis() {
        assert_no_decision_changes("hey_jarvis", &[CHUNK]);
    }

    #[test]
    fn the_silence_gate_changes_no_decision_ground_control() {
        assert_no_decision_changes("ground_control", &[CHUNK]);
    }

    /// The same contract over a directory of 16 kHz mono WAVs (ignored — point it
    /// at the debug captures or any corpus):
    ///   WAKE_CORPUS=/path/to/wavs cargo test --lib wake::engine::tests::equivalence_corpus -- --ignored --nocapture
    #[test]
    #[ignore]
    fn equivalence_corpus() {
        let dir = std::env::var("WAKE_CORPUS").expect("set WAKE_CORPUS=/path/to/wavs");
        let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .expect("read corpus dir")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "wav").unwrap_or(false))
            .collect();
        paths.sort();
        let mut worst = 0.0f32;
        for path in &paths {
            let samples = parse_wav_i16(&std::fs::read(path).unwrap());
            let audio = concat(&[&pseudo_noise(SAMPLE_RATE as usize * 3, 0.002), &samples, &vec![0.0f32; 8000]]);
            for (phrase, _) in PHRASES {
                for debug in [false, true] {
                    let reference = run_reference(&audio, phrase, debug, CHUNK, None);
                    let engine = run_engine(&audio, phrase, debug, CHUNK, None);
                    let tag = format!("{} / {phrase} / debug {debug}", path.display());
                    worst = worst.max(assert_same(&tag, &reference, &engine, debug));
                    let fired = engine.candidates.iter().filter(|c| c.1.is_none()).count();
                    let blocked = engine.candidates.len() - fired;
                    eprintln!(
                        "[corpus] {:<40} {phrase:<15} debug={debug:<5} fires={fired} blocked={blocked} \
                         scored {}/{} steps",
                        path.file_name().unwrap().to_string_lossy(),
                        engine.scores.len(),
                        reference.scores.len()
                    );
                }
            }
        }
        eprintln!("[corpus] {} files identical, worst score gap {worst:e}", paths.len());
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

    // ── Benchmarks (ignored) ─────────────────────────────────────────────────

    /// CPU time consumed by the CALLING thread, in seconds. Every session is built
    /// with one intra-op thread and the default sequential executor, so the ONNX
    /// work runs on the thread that calls `run` — this is the engine's real cost,
    /// without the noise of whatever else the test binary is doing.
    fn thread_cpu_secs() -> f64 {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: `ts` is a valid, writable timespec for the duration of the call.
        unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
        ts.tv_sec as f64 + ts.tv_nsec as f64 * 1e-9
    }

    /// Diagnostic (ignored) micro-benchmark: CPU per second of audio, before (the
    /// reference engine, at the old ~94/s callback cadence and at one step per
    /// call) and after (this engine, gated and ungated), in silence, in continuous
    /// speech (the fixture looped), with someone saying something else every 5 s
    /// (the "Alexa" clip through the `hey_jarvis` classifier: speech, no fires), and
    /// with the wake word itself every 5 s (fires — after a fire the veto window
    /// still holds the phrase, so the gate rightly stays open through the refill).
    ///   cargo test --release --lib wake::engine::tests::bench_engine_cpu -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_engine_cpu() {
        let seconds = 30usize;
        let n = SAMPLE_RATE as usize * seconds;
        let clip = parse_wav_i16(SPEECH_WAV);
        let speech: Vec<f32> = clip.iter().copied().cycle().take(n).collect();
        let mut mixed = pseudo_noise(n, 0.002);
        for at in (SAMPLE_RATE as usize..n - clip.len()).step_by(SAMPLE_RATE as usize * 5) {
            mixed[at..at + clip.len()].copy_from_slice(&clip);
        }
        let cases: [(&str, &str, Vec<f32>); 4] = [
            ("silence (room tone)", DEFAULT_PHRASE, pseudo_noise(n, 0.002)),
            ("speech (fixture looped)", DEFAULT_PHRASE, speech),
            ("other speech every 5 s", "hey_jarvis", mixed.clone()),
            ("wake word every 5 s", DEFAULT_PHRASE, mixed),
        ];
        // WAKE_BENCH_QOS=utility measures on the QoS class the worker really runs at
        // (efficiency cores): slower per op, and the max-per-call figure then says
        // whether the worst step (a gate backfill) still fits the 80 ms budget.
        #[cfg(target_os = "macos")]
        if std::env::var("WAKE_BENCH_QOS").as_deref() == Ok("utility") {
            super::super::lower_thread_qos();
            eprintln!("[bench] running at UTILITY QoS");
        }
        let warmup = pseudo_noise(SAMPLE_RATE as usize * 3, 0.002);
        let measure = |label: &str, feed: &mut dyn FnMut(&[f32]), audio: &[f32], chunk: usize| {
            for c in warmup.chunks(chunk) {
                feed(c); // prime the buffers and the sessions, not measured
            }
            let t0 = thread_cpu_secs();
            let mut worst = std::time::Duration::ZERO;
            for c in audio.chunks(chunk) {
                let w0 = std::time::Instant::now();
                feed(c);
                worst = worst.max(w0.elapsed());
            }
            let cpu = thread_cpu_secs() - t0;
            eprintln!(
                "[bench] {label:<44} {:>6.2} ms CPU per audio second ({:.2}% of one core), \
                 slowest call {:.1} ms",
                cpu * 1000.0 / seconds as f64,
                cpu * 100.0 / seconds as f64,
                worst.as_secs_f64() * 1000.0,
            );
        };
        for (label, phrase, audio) in &cases {
            for chunk in [171usize, CHUNK] {
                let mut r = ReferenceEngine::new(phrase, 0.5, false);
                measure(&format!("{label} | before, chunk {chunk}"), &mut |c| drop(r.feed(c)), audio, chunk);
            }
            let mut e = Engine::new(phrase, 0.5, false).unwrap().ungated();
            measure(&format!("{label} | after, ungated"), &mut |c| drop(e.feed(c)), audio, CHUNK);
            let mut g = Engine::new(phrase, 0.5, false).unwrap();
            measure(&format!("{label} | after, gated"), &mut |c| drop(g.feed(c)), audio, CHUNK);
            // Includes the warm-up. Run-to-run noise on this machine is ~±0.5 ms/s.
            eprintln!("[bench]   embeddings computed: ungated {}, gated {}", e.embeds, g.embeds);
        }
    }

    /// Diagnostic (ignored): the cost of each stage on its own, per call and per
    /// second of audio at the rate the engine calls it. Tells where the time goes.
    ///   cargo test --release --lib wake::engine::tests::bench_stage_costs -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_stage_costs() {
        let reps = 300usize;
        let audio = pseudo_noise(MEL_WINDOW_SAMPLES, 0.05);
        let scaled: Vec<f32> = audio.iter().map(|s| s * 32768.0).collect();
        let mut mel = build_session(MEL_MODEL).unwrap();
        let mut embedding = build_session(EMBEDDING_MODEL).unwrap();
        let mut classifier = build_session(classifier_bytes(DEFAULT_PHRASE)).unwrap();
        let mut vad = Vad::new().unwrap();
        let steps_per_s = SAMPLE_RATE as f64 / CHUNK as f64;
        let vad_per_s = SAMPLE_RATE as f64 / VAD_FRAME as f64;
        let time = |label: &str, per_s: f64, f: &mut dyn FnMut()| {
            f(); // warm-up
            let t0 = thread_cpu_secs();
            for _ in 0..reps {
                f();
            }
            let per_call = (thread_cpu_secs() - t0) / reps as f64;
            eprintln!(
                "[stage] {label:<34} {:>8.1} µs/call × {per_s:>5.2}/s = {:>6.2} ms per audio second",
                per_call * 1e6,
                per_call * per_s * 1000.0
            );
        };
        for len in [MEL_WINDOW_SAMPLES, 1632] {
            let win = scaled[scaled.len() - len..].to_vec();
            time(&format!("mel over {len} samples"), steps_per_s, &mut || {
                run_single(&mut mel, vec![1, win.len() as i64], win.clone()).unwrap();
            });
        }
        let emb_in = vec![1.0f32; EMB_FRAMES * MEL_BINS];
        time("embedding (76 frames)", steps_per_s, &mut || {
            run_single(&mut embedding, vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1], emb_in.clone())
                .unwrap();
        });
        let cls_in = vec![0.1f32; CLASSIFIER_EMBEDDINGS * EMBEDDING_DIM];
        time("classifier (16 embeddings)", steps_per_s, &mut || {
            run_single(
                &mut classifier,
                vec![1, CLASSIFIER_EMBEDDINGS as i64, EMBEDDING_DIM as i64],
                cls_in.clone(),
            )
            .unwrap();
        });
        let frame = vec![0.01f32; VAD_FRAME + VAD_CONTEXT];
        time("silero VAD (576 samples)", vad_per_s, &mut || {
            vad.run_frame(&frame).unwrap();
        });
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
