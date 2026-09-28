//! The wake-word engine exactly as it shipped before the melspectrogram went
//! incremental and the silence gate landed — TEST-ONLY, the oracle the
//! equivalence tests hold the real engine to.
//!
//! Every step here recomputes the melspectrogram over the full 12 800-sample
//! trailing window and embeds + scores it, silence or not. The decision logic
//! (cooldown, patience, the fire-time VAD veto, the debug-mode suppressed
//! candidates) is copied verbatim from that version; only the logging is gone
//! (it decides nothing) and a score log was added so a test can compare every
//! step, not just the fires. Do NOT "improve" this file: its whole value is that
//! it is the behaviour the owner tuned against.

use std::collections::VecDeque;

use ort::session::Session;

use super::{
    build_session, classifier_bytes, run_single, threshold_for, Vad, CHUNK, CLASSIFIER_EMBEDDINGS,
    EMBEDDING_MODEL, EMB_FRAMES, MEL_BINS, MEL_MODEL, MEL_WINDOW_SAMPLES, PATIENCE_STEPS,
    REFIRE_COOLDOWN_STEPS, TRACE_STEPS, VAD_VETO_MIN, VAD_VETO_STEPS,
};

/// One scored step of the reference trace: `(score, vad, rms)`.
pub(super) type RefStep = (f32, f32, f32);

/// A candidate wake from the reference engine.
pub(super) struct RefDetection {
    pub suppressed_by: Option<&'static str>,
    pub score: f32,
    pub trace: Vec<RefStep>,
}

pub(super) struct ReferenceEngine {
    mel: Session,
    embedding: Session,
    classifier: Session,
    vad: Vad,
    pub(super) threshold: f32,
    audio: Vec<f32>,
    pending: usize,
    embeddings: VecDeque<Vec<f32>>,
    cooldown: u32,
    consecutive: u32,
    vad_peak: f32,
    trace: VecDeque<RefStep>,
    debug: bool,
    /// Steps taken so far (the same numbering as the real engine's `steps`).
    steps: u64,
    /// Every score computed, as `(step, score)`.
    pub score_log: Vec<(u64, f32)>,
}

impl ReferenceEngine {
    pub fn new(phrase: &str, sensitivity: f32, debug: bool) -> Self {
        Self {
            mel: build_session(MEL_MODEL).unwrap(),
            embedding: build_session(EMBEDDING_MODEL).unwrap(),
            classifier: build_session(classifier_bytes(phrase)).unwrap(),
            vad: Vad::new().unwrap(),
            threshold: threshold_for(sensitivity),
            audio: Vec::with_capacity(MEL_WINDOW_SAMPLES + 2 * CHUNK),
            pending: 0,
            embeddings: VecDeque::with_capacity(CLASSIFIER_EMBEDDINGS),
            cooldown: 0,
            consecutive: 0,
            vad_peak: 0.0,
            trace: VecDeque::with_capacity(TRACE_STEPS),
            debug,
            steps: 0,
            score_log: Vec::new(),
        }
    }

    pub fn feed(&mut self, samples: &[f32]) -> Option<RefDetection> {
        self.vad_peak = self.vad_peak.max(self.vad.speech_prob(samples));
        self.audio.extend_from_slice(samples);
        self.pending += samples.len();
        let mut hit = None;
        while self.pending >= CHUNK {
            self.pending -= CHUNK;
            self.steps += 1;
            let end = self.audio.len() - self.pending;
            if let Some(detection) = self.step(end) {
                hit = Some(detection);
            }
        }
        let keep = MEL_WINDOW_SAMPLES + self.pending;
        if self.audio.len() > keep {
            let drop = self.audio.len() - keep;
            self.audio.drain(..drop);
        }
        hit
    }

    fn step(&mut self, end: usize) -> Option<RefDetection> {
        let vad = std::mem::replace(&mut self.vad_peak, 0.0);
        if self.cooldown > 0 {
            self.cooldown -= 1;
            return None;
        }
        let (embedding, rms) = self.newest_embedding(end)?;
        if self.embeddings.len() == CLASSIFIER_EMBEDDINGS {
            self.embeddings.pop_front();
        }
        self.embeddings.push_back(embedding);
        if self.embeddings.len() < CLASSIFIER_EMBEDDINGS {
            return None;
        }
        let score = self.classify()?;
        self.score_log.push((self.steps, score));
        if self.trace.len() == TRACE_STEPS {
            self.trace.pop_front();
        }
        self.trace.push_back((score, vad, rms));
        if score < self.threshold {
            self.consecutive = 0;
            return None;
        }
        self.consecutive += 1;
        let suppressed_by = if self.consecutive < PATIENCE_STEPS {
            Some("patience")
        } else if self.vad_window_peak() < VAD_VETO_MIN {
            Some("no_speech")
        } else {
            None
        };
        if suppressed_by.is_some() && !self.debug {
            return None;
        }
        if suppressed_by.is_none() {
            self.cooldown = REFIRE_COOLDOWN_STEPS;
            self.consecutive = 0;
            self.embeddings.clear();
        }
        Some(RefDetection { suppressed_by, score, trace: self.trace.iter().copied().collect() })
    }

    fn vad_window_peak(&self) -> f32 {
        self.trace.iter().rev().take(VAD_VETO_STEPS).map(|t| t.1).fold(0.0f32, f32::max)
    }

    fn newest_embedding(&mut self, end: usize) -> Option<(Vec<f32>, f32)> {
        if end < MEL_WINDOW_SAMPLES || end > self.audio.len() {
            return None;
        }
        let raw = &self.audio[end - MEL_WINDOW_SAMPLES..end];
        let rms = (raw.iter().map(|s| s * s).sum::<f32>() / raw.len() as f32).sqrt();
        let window: Vec<f32> = raw.iter().map(|&s| s * 32768.0).collect();
        let (_, mut mel) = run_single(&mut self.mel, vec![1, window.len() as i64], window).ok()?;
        for v in mel.iter_mut() {
            *v = *v / 10.0 + 2.0;
        }
        let frames = mel.len() / MEL_BINS;
        if frames < EMB_FRAMES {
            return None;
        }
        let start = (frames - EMB_FRAMES) * MEL_BINS;
        let win = mel[start..start + EMB_FRAMES * MEL_BINS].to_vec();
        if !win.iter().all(|v| v.is_finite()) {
            return None;
        }
        let (_, emb) = run_single(
            &mut self.embedding,
            vec![1, EMB_FRAMES as i64, MEL_BINS as i64, 1],
            win,
        )
        .ok()?;
        emb.iter().all(|v| v.is_finite()).then_some((emb, rms))
    }

    fn classify(&mut self) -> Option<f32> {
        let mut flat = Vec::with_capacity(CLASSIFIER_EMBEDDINGS * 96);
        for e in &self.embeddings {
            flat.extend_from_slice(e);
        }
        let feat = flat.len() / CLASSIFIER_EMBEDDINGS;
        let (_, values) = run_single(
            &mut self.classifier,
            vec![1, CLASSIFIER_EMBEDDINGS as i64, feat as i64],
            flat,
        )
        .ok()?;
        let score = values.first().copied()?;
        score.is_finite().then_some(score)
    }
}
