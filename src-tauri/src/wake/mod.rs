//! Wake word — a hands-free "Alexa" / "Hey Jarvis" trigger that opens the voice
//! agent's microphone, the spoken equivalent of the push-to-talk key.
//!
//! This module is the SOLE owner of the always-on wake-word capture (same
//! encapsulation rule as `terminal/`, `power/`, `voice/`): a background worker
//! thread runs `capture` (the mic) → `engine` (Silero VAD + openWakeWord), and on
//! a detection invokes the `on_detect` callback the app wires to a `WakeWordEvent`.
//! Everything is on-device — no network, no cloud, the audio never leaves the Mac.
//!
//! Optional and OFF by default (like the voice agent it serves): with the toggle
//! off nothing captures the microphone and this module costs nothing. The status
//! is HONEST — `running`/`error` are the real post-apply state of the detector,
//! not a switch that lies (mirroring the voice-bridge honest-toggle rule).

mod capture;
mod engine;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use capture::Capture;
use engine::Engine;
pub use engine::{DEFAULT_PHRASE, PHRASES, SAMPLE_RATE};

/// The callback the detector fires on a hit: `(phrase_key, score)`. The app sets
/// it to emit a `WakeWordEvent`; kept as a plain `Fn` so this module stays free of
/// Tauri types and is unit-testable.
pub type DetectFn = dyn Fn(&str, f32) + Send + Sync + 'static;

/// Persisted wake-word settings (stored in the SQLite `meta` table by the IPC
/// layer, loaded at startup so the detector can arm with the app).
#[derive(Debug, Clone)]
pub struct WakeConfig {
    pub enabled: bool,
    pub phrase: String,
    pub sensitivity: f32,
}

impl Default for WakeConfig {
    fn default() -> Self {
        Self { enabled: false, phrase: DEFAULT_PHRASE.to_string(), sensitivity: 0.5 }
    }
}

/// One selectable wake phrase for the Settings picker.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WakePhrase {
    pub key: String,
    pub label: String,
}

/// The Settings read-back: the config PLUS whether the detector is actually up,
/// with the reason when it is not (no mic, model load failure…). Honest by design.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WakeStatus {
    pub enabled: bool,
    pub phrase: String,
    pub sensitivity: f32,
    /// The capture + inference worker is live right now.
    pub running: bool,
    /// Why the detector is not running while `enabled` — surfaced in Settings.
    pub error: Option<String>,
    /// The phrases the user can choose from (bundled classifiers).
    pub phrases: Vec<WakePhrase>,
}

fn phrase_catalogue() -> Vec<WakePhrase> {
    PHRASES
        .iter()
        .map(|(key, label)| WakePhrase { key: key.to_string(), label: label.to_string() })
        .collect()
}

/// Normalize a requested phrase to a known key (falls back to the default), and
/// clamp sensitivity to [0, 1].
pub fn sanitize(phrase: &str, sensitivity: f32) -> (String, f32) {
    let key = PHRASES
        .iter()
        .find(|(k, _)| *k == phrase)
        .map(|(k, _)| k.to_string())
        .unwrap_or_else(|| DEFAULT_PHRASE.to_string());
    (key, sensitivity.clamp(0.0, 1.0))
}

struct Inner {
    phrase: String,
    sensitivity: f32,
    enabled: bool,
    running: bool,
    error: Option<String>,
    stop: Option<Arc<AtomicBool>>,
    handle: Option<JoinHandle<()>>,
}

/// The managed wake-word service (one per app, held as Tauri state). Starts and
/// stops the background detector to match the config, and reports honest status.
pub struct WakeController {
    inner: Mutex<Inner>,
    on_detect: Mutex<Option<Arc<DetectFn>>>,
}

impl Default for WakeController {
    fn default() -> Self {
        Self::new()
    }
}

impl WakeController {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                phrase: DEFAULT_PHRASE.to_string(),
                sensitivity: 0.5,
                enabled: false,
                running: false,
                error: None,
                stop: None,
                handle: None,
            }),
            on_detect: Mutex::new(None),
        }
    }

    /// Wire the detection sink (the app sets this once at startup to emit the
    /// `WakeWordEvent`). Set before any `apply` that enables the detector.
    pub fn set_on_detect(&self, cb: Arc<DetectFn>) {
        *self.on_detect.lock().unwrap() = Some(cb);
    }

    /// Apply a config: (re)start the detector when enabled, stop it when not. The
    /// returned status is the HONEST post-apply state — a mic/model failure comes
    /// back as `running:false` + `error`, never a lying switch.
    pub fn apply(&self, config: WakeConfig) -> WakeStatus {
        // Always tear down the current worker first (config change or disable).
        self.stop_worker();

        let (phrase, sensitivity) = sanitize(&config.phrase, config.sensitivity);
        {
            let mut inner = self.inner.lock().unwrap();
            inner.phrase = phrase.clone();
            inner.sensitivity = sensitivity;
            inner.enabled = config.enabled;
            inner.error = None;
            inner.running = false;
        }
        if !config.enabled {
            return self.status();
        }

        let on_detect = self.on_detect.lock().unwrap().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (report_tx, report_rx) = mpsc::channel::<Result<(), String>>();
        let stop_worker = stop.clone();
        let phrase_worker = phrase.clone();
        let handle = std::thread::Builder::new()
            .name("wake-detector".into())
            .spawn(move || run_worker(phrase_worker, sensitivity, on_detect, stop_worker, report_tx))
            .ok();

        {
            let mut inner = self.inner.lock().unwrap();
            inner.stop = Some(stop);
            inner.handle = handle;
        }

        // Wait (bounded) for the worker to report that capture + models came up,
        // so the status we return reflects reality.
        match report_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => {
                self.inner.lock().unwrap().running = true;
            }
            Ok(Err(e)) => {
                let mut inner = self.inner.lock().unwrap();
                inner.running = false;
                inner.error = Some(e);
            }
            Err(_) => {
                let mut inner = self.inner.lock().unwrap();
                inner.running = false;
                inner.error = Some("the wake-word detector did not start in time".to_string());
            }
        }
        self.status()
    }

    /// Signal the worker to stop and join it (mic released). Join happens OUTSIDE
    /// the lock so a slow teardown never blocks a status read.
    fn stop_worker(&self) {
        let (stop, handle) = {
            let mut inner = self.inner.lock().unwrap();
            (inner.stop.take(), inner.handle.take())
        };
        if let Some(stop) = stop {
            stop.store(true, Ordering::SeqCst);
        }
        if let Some(handle) = handle {
            let _ = handle.join();
        }
        self.inner.lock().unwrap().running = false;
    }

    pub fn status(&self) -> WakeStatus {
        let inner = self.inner.lock().unwrap();
        WakeStatus {
            enabled: inner.enabled,
            phrase: inner.phrase.clone(),
            sensitivity: inner.sensitivity,
            running: inner.running,
            error: inner.error.clone(),
            phrases: phrase_catalogue(),
        }
    }
}

/// The detector worker: build the engine + open the mic, report the outcome, then
/// pump audio through the engine until asked to stop. Owns the `!Send` capture
/// stream and the `&mut`-driven ONNX sessions, so neither ever crosses a thread.
fn run_worker(
    phrase: String,
    sensitivity: f32,
    on_detect: Option<Arc<DetectFn>>,
    stop: Arc<AtomicBool>,
    report: mpsc::Sender<Result<(), String>>,
) {
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let setup = (|| {
        let engine = Engine::new(&phrase, sensitivity)?;
        let capture = Capture::start(tx)?;
        Ok::<_, String>((engine, capture))
    })();
    let (mut engine, _capture) = match setup {
        Ok(v) => {
            let _ = report.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = report.send(Err(e));
            return;
        }
    };

    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(chunk) => {
                if let Some(score) = engine.feed(&chunk) {
                    if let Some(cb) = &on_detect {
                        cb(engine.phrase(), score);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // capture died
        }
    }
    // `_capture` drops here → mic released (orange indicator off).
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_clamps_and_falls_back() {
        let (p, s) = sanitize("nope", 5.0);
        assert_eq!(p, DEFAULT_PHRASE);
        assert_eq!(s, 1.0);
        let (p, s) = sanitize("hey_jarvis", -3.0);
        assert_eq!(p, "hey_jarvis");
        assert_eq!(s, 0.0);
    }

    #[test]
    fn disabled_apply_reports_not_running_without_error() {
        let ctrl = WakeController::new();
        let st = ctrl.apply(WakeConfig { enabled: false, phrase: "alexa".into(), sensitivity: 0.5 });
        assert!(!st.enabled);
        assert!(!st.running);
        assert!(st.error.is_none());
        assert_eq!(st.phrase, "alexa");
        assert!(st.phrases.iter().any(|p| p.key == "alexa"));
    }
}
