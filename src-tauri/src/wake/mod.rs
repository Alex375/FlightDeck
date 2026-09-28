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
//! off nothing captures the microphone and this module costs nothing. It also
//! stays off without an OpenAI key (`require_voice_key`): the wake word only ever
//! opens the voice agent, so without one every detection would be thrown away. The
//! status is HONEST — `running`/`error` are the real post-apply state of the
//! detector, not a switch that lies (mirroring the voice-bridge honest-toggle rule).
//!
//! Cost while on: the worker wakes once per 80 ms step (the capture batches), runs
//! at UTILITY QoS (efficiency cores), sleeps when no audio comes, and the engine's
//! silence gate skips the expensive stages while nobody is talking (`engine.rs`).

mod capture;
mod debug;
mod engine;

use std::path::PathBuf;
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
    /// Write a WAV + score trajectory for every fire (see `debug`). OFF by
    /// default: it records microphone audio to disk, so it only ever runs on an
    /// explicit opt-in, and it exists to make false positives reproducible.
    pub debug_capture: bool,
    /// Where those captures go. Supplied by the IPC layer (which owns the app
    /// data dir) so this module stays free of Tauri types, exactly like
    /// `on_detect`. `None` while debug capture is off.
    pub debug_dir: Option<PathBuf>,
    /// Why the detector must stay OFF even though the user enabled it — today only
    /// "no OpenAI key" (see `require_voice_key`). The choice itself is kept: the
    /// status reads enabled-but-not-running with this as the reason, and the
    /// detector comes back by itself once the reason is gone.
    pub paused: Option<String>,
}

impl Default for WakeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            phrase: DEFAULT_PHRASE.to_string(),
            sensitivity: 0.5,
            debug_capture: false,
            debug_dir: None,
            paused: None,
        }
    }
}

/// The reason a detector enabled without an OpenAI key stays off.
pub const PAUSED_NO_VOICE_KEY: &str =
    "paused — no OpenAI key. The wake word only opens the voice agent, so the microphone \
     stays off until a key is added.";

/// Hold an enabled detector off while no OpenAI key is stored. The wake word only
/// ever opens the voice agent, and without a key the front drops every detection
/// (`shouldFireWake`) — so an always-on microphone would buy nothing but battery
/// drain and a lit mic indicator. `key_configured` comes from the caller (reading
/// the Keychain spawns `/usr/bin/security`; this module stays free of it).
pub fn require_voice_key(mut config: WakeConfig, key_configured: bool) -> WakeConfig {
    if config.enabled && !key_configured {
        config.paused = Some(PAUSED_NO_VOICE_KEY.to_string());
    }
    config
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
    /// Debug capture is on (every fire writes a WAV + score trajectory).
    pub debug_capture: bool,
    /// Where captures are written, so Settings can show and reveal the folder.
    pub debug_dir: Option<String>,
    /// Why the LAST capture did not get written. Separate from `error`, which is
    /// about the detector itself: a failed dump must not read as a dead detector,
    /// but it must not vanish either — the user is reproducing false positives
    /// expecting evidence, and silence would let them do it for nothing.
    pub debug_error: Option<String>,
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
    debug_capture: bool,
    debug_dir: Option<PathBuf>,
    running: bool,
    error: Option<String>,
    /// Shared with the worker thread, which is where captures are actually
    /// written — `status()` reads whatever the last attempt left here.
    debug_error: Arc<Mutex<Option<String>>>,
    /// Why a detector that started has since died (the microphone went away) —
    /// written by the worker, read by `status()`, so the status stops claiming a
    /// dead detector runs.
    fault: Arc<Mutex<Option<String>>>,
    /// The controller's line to the worker: a `Stop` here ends it.
    stop: Option<mpsc::Sender<WorkerMsg>>,
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
                debug_capture: false,
                debug_dir: None,
                running: false,
                error: None,
                debug_error: Arc::new(Mutex::new(None)),
                fault: Arc::new(Mutex::new(None)),
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
        // Prove the capture directory is usable NOW rather than at the first fire.
        // A switch that reads "on" but cannot write is exactly the silent failure
        // this feature exists to eliminate: the user would go on reproducing false
        // positives, waiting for evidence that was never being written. Creating it
        // eagerly also means Settings can always reveal the folder, empty or not.
        let (debug_capture, debug_reason) =
            match (config.debug_capture, config.debug_dir.as_deref()) {
                (false, _) => (false, None),
                (true, None) => (
                    false,
                    Some("no capture directory is available — captures cannot be written".into()),
                ),
                (true, Some(dir)) => match std::fs::create_dir_all(dir) {
                    Ok(()) => (true, None),
                    Err(e) => (false, Some(format!("could not create {}: {e}", dir.display()))),
                },
            };
        let debug_error = Arc::new(Mutex::new(debug_reason));
        let fault = Arc::new(Mutex::new(None));
        {
            let mut inner = self.inner.lock().unwrap();
            inner.phrase = phrase.clone();
            inner.sensitivity = sensitivity;
            inner.enabled = config.enabled;
            inner.debug_capture = debug_capture;
            inner.debug_dir = config.debug_dir.clone();
            // Paused = enabled, deliberately not running, and saying why.
            inner.error = config.paused.clone().filter(|_| config.enabled);
            inner.debug_error = debug_error.clone();
            inner.fault = fault.clone();
            inner.running = false;
        }
        if !config.enabled || config.paused.is_some() {
            return self.status();
        }

        let on_detect = self.on_detect.lock().unwrap().clone();
        // ONE channel carries the audio (from the capture), a fault (from the
        // capture) and the stop request (from here), so the worker can simply
        // block on it — see `run_worker`.
        let (tx, inbox) = mpsc::channel::<WorkerMsg>();
        let (report_tx, report_rx) = mpsc::channel::<Result<(), String>>();
        let link = WorkerLink { capture_tx: tx.clone(), inbox, fault, report: report_tx };
        let phrase_worker = phrase.clone();
        let debug = DebugSink {
            enabled: debug_capture,
            dir: config.debug_dir.clone(),
            last_error: debug_error,
        };
        let handle = std::thread::Builder::new()
            .name("wake-detector".into())
            .spawn(move || run_worker(phrase_worker, sensitivity, on_detect, debug, link))
            .ok();

        {
            let mut inner = self.inner.lock().unwrap();
            inner.stop = Some(tx);
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
            // A worker that already exited (failed start, dead mic) has dropped its
            // end; nothing to tell it then.
            let _ = stop.send(WorkerMsg::Stop);
        }
        if let Some(handle) = handle {
            let _ = handle.join();
        }
        self.inner.lock().unwrap().running = false;
    }

    pub fn status(&self) -> WakeStatus {
        let inner = self.inner.lock().unwrap();
        // Read the shared errors into locals FIRST: their guards are temporaries
        // that would otherwise outlive `inner` at the end of the block.
        let debug_error = inner.debug_error.lock().unwrap().clone();
        let fault = inner.fault.lock().unwrap().clone();
        WakeStatus {
            enabled: inner.enabled,
            phrase: inner.phrase.clone(),
            sensitivity: inner.sensitivity,
            // A detector whose microphone went away is not running, whatever it
            // was when it started.
            running: inner.running && fault.is_none(),
            error: fault.or_else(|| inner.error.clone()),
            phrases: phrase_catalogue(),
            debug_capture: inner.debug_capture,
            debug_dir: inner.debug_dir.as_ref().map(|p| p.display().to_string()),
            debug_error,
        }
    }
}

/// Everything the worker needs to dump a fire, kept together so `run_worker`'s
/// signature stays readable.
struct DebugSink {
    enabled: bool,
    dir: Option<PathBuf>,
    /// Where a failed capture is recorded for `status()` to surface.
    last_error: Arc<Mutex<Option<String>>>,
}

impl DebugSink {
    /// Dump one detection, recording success or failure for Settings to read.
    /// Never propagates: a capture problem must not take the detector down.
    fn record(&self, phrase: &str, sensitivity: f32, detection: &engine::Detection) {
        if !self.enabled {
            return;
        }
        let Some(dir) = self.dir.as_deref() else { return };
        match debug::write_capture(dir, phrase, sensitivity, detection) {
            Ok(path) => {
                eprintln!("[wake] debug capture written: {}", path.display());
                *self.last_error.lock().unwrap() = None;
            }
            Err(e) => {
                eprintln!("[wake] debug capture FAILED: {e}");
                *self.last_error.lock().unwrap() = Some(e);
            }
        }
    }
}

/// What reaches the worker thread, all on one channel so the worker can BLOCK on
/// it: it wakes for audio (once per detection step), a dead stream or a stop
/// request, and otherwise sleeps — no timeout, no polling, even when the
/// microphone goes quiet.
enum WorkerMsg {
    /// A batch of 16 kHz mono audio — about one detection step (`capture.rs`).
    Audio(Vec<f32>),
    /// The capture died (the device went away): stop, and record why.
    Fault(String),
    /// The controller wants the worker gone (disable, reconfigure, quit).
    Stop,
}

/// The worker's end of the plumbing, kept together so `run_worker`'s signature
/// stays readable.
struct WorkerLink {
    /// Handed to the capture, which sends audio and faults on it.
    capture_tx: mpsc::Sender<WorkerMsg>,
    inbox: mpsc::Receiver<WorkerMsg>,
    /// Where a mid-run failure is recorded for `status()`.
    fault: Arc<Mutex<Option<String>>>,
    /// The start-up outcome, which `apply` waits on.
    report: mpsc::Sender<Result<(), String>>,
}

/// Move the calling thread to the UTILITY QoS class, which macOS schedules on the
/// efficiency cores. Every ONNX session runs one intra-op thread, so the inference
/// happens ON this thread and inherits the class. A step's work takes a few ms even
/// there, against an 80 ms budget.
#[cfg(target_os = "macos")]
fn lower_thread_qos() {
    // SAFETY: only changes the calling thread's own QoS class; no pointers.
    let rc = unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0)
    };
    if rc != 0 {
        eprintln!("[wake] could not lower the detector's QoS class (error {rc}) — it runs at the default class");
    }
}

/// The detector worker: build the engine + open the mic, report the outcome, then
/// pump audio through the engine until asked to stop. Owns the `!Send` capture
/// stream and the `&mut`-driven ONNX sessions, so neither ever crosses a thread.
fn run_worker(
    phrase: String,
    sensitivity: f32,
    on_detect: Option<Arc<DetectFn>>,
    debug: DebugSink,
    link: WorkerLink,
) {
    #[cfg(target_os = "macos")]
    lower_thread_qos();

    let WorkerLink { capture_tx, inbox, fault, report } = link;
    let setup = (|| {
        let engine = Engine::new(&phrase, sensitivity, debug.enabled)?;
        let capture = Capture::start(capture_tx)?;
        Ok::<_, String>((engine, capture))
    })();
    let (mut engine, _capture) = match setup {
        Ok(v) => {
            eprintln!("[wake] detector RUNNING (phrase={phrase}, sensitivity={sensitivity})");
            let _ = report.send(Ok(()));
            v
        }
        Err(e) => {
            eprintln!("[wake] detector FAILED to start: {e}");
            let _ = report.send(Err(e));
            return;
        }
    };

    loop {
        // Blocks until something arrives: audio (~12×/s), a fault, or a stop.
        let chunk = match inbox.recv() {
            Ok(WorkerMsg::Audio(chunk)) => chunk,
            Ok(WorkerMsg::Fault(reason)) => {
                eprintln!("[wake] detector STOPPED: {reason}");
                *fault.lock().unwrap() = Some(reason);
                break;
            }
            // `Err` = the controller's sender is gone too: nobody left to serve.
            Ok(WorkerMsg::Stop) | Err(_) => break,
        };
        let Some(detection) = engine.feed(&chunk) else { continue };
        match detection.suppressed_by {
            None => eprintln!(
                "[wake] DETECTED phrase={} score={:.3} → firing event",
                engine.phrase(),
                detection.score
            ),
            // Only reachable while debug capture is on, and only ever dumped — a
            // suppressed candidate must never reach the app.
            Some(gate) => eprintln!(
                "[wake] suppressed phrase={} score={:.3} by {gate}",
                engine.phrase(),
                detection.score
            ),
        }
        // Dump BEFORE firing: the callback hops into the webview and opens a
        // microphone, and the evidence for a false positive is worth more than a
        // few ms of trigger latency.
        debug.record(engine.phrase(), sensitivity, &detection);
        if detection.fired() {
            if let Some(cb) = &on_detect {
                cb(engine.phrase(), detection.score);
            }
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

    /// Without an OpenAI key the wake word is useless (the front drops every
    /// detection), so an enabled detector must not hold the microphone — but it
    /// must not forget the user's choice either, and must say why it is off.
    #[test]
    fn an_enabled_detector_without_a_voice_key_is_paused_not_started() {
        let enabled = WakeConfig { enabled: true, ..WakeConfig::default() };
        assert!(require_voice_key(enabled.clone(), true).paused.is_none(), "a key: runs");
        let disabled = WakeConfig::default();
        assert!(require_voice_key(disabled, false).paused.is_none(), "off stays plain off");

        let ctrl = WakeController::new();
        let st = ctrl.apply(require_voice_key(enabled, false));
        assert!(st.enabled, "the user's choice is kept");
        assert!(!st.running, "no worker, no microphone");
        assert_eq!(st.error.as_deref(), Some(PAUSED_NO_VOICE_KEY), "and the reason is legible");
        assert!(ctrl.inner.lock().unwrap().handle.is_none(), "no thread was spawned");
    }

    /// A detector that started and then lost its microphone must stop claiming to
    /// run — the fault the worker records wins over the start-up state.
    #[test]
    fn a_fault_after_start_reads_as_not_running_with_the_reason() {
        let ctrl = WakeController::new();
        {
            let mut inner = ctrl.inner.lock().unwrap();
            inner.enabled = true;
            inner.running = true;
            *inner.fault.lock().unwrap() = Some("the microphone went away".into());
        }
        let st = ctrl.status();
        assert!(!st.running);
        assert_eq!(st.error.as_deref(), Some("the microphone went away"));
    }

    #[test]
    fn disabled_apply_reports_not_running_without_error() {
        let ctrl = WakeController::new();
        let st = ctrl.apply(WakeConfig {
            enabled: false,
            phrase: "alexa".into(),
            sensitivity: 0.5,
            ..WakeConfig::default()
        });
        assert!(!st.enabled);
        assert!(!st.running);
        assert!(st.error.is_none());
        assert_eq!(st.phrase, "alexa");
        assert!(st.phrases.iter().any(|p| p.key == "alexa"));
    }

    /// Asking for captures with nowhere to put them must SAY so. Reporting
    /// `debug_capture: true` there would be a switch that lies: the user would
    /// keep reproducing false positives waiting for files that never appear.
    #[test]
    fn debug_capture_without_a_directory_is_refused_and_explained() {
        let ctrl = WakeController::new();
        let st = ctrl.apply(WakeConfig {
            enabled: false,
            debug_capture: true,
            debug_dir: None,
            ..WakeConfig::default()
        });
        assert!(!st.debug_capture, "it is not on — there is nowhere to write");
        assert!(
            st.debug_error.as_deref().unwrap_or_default().contains("directory"),
            "and the reason is legible: {:?}",
            st.debug_error
        );
    }

    /// With a directory, the opt-in takes effect and the folder is reported back
    /// so Settings can show (and reveal) where the captures land.
    #[test]
    fn debug_capture_with_a_directory_is_accepted_and_reported() {
        let ctrl = WakeController::new();
        let dir = std::env::temp_dir().join("wake-debug-accepted");
        let st = ctrl.apply(WakeConfig {
            enabled: false,
            debug_capture: true,
            debug_dir: Some(dir.clone()),
            ..WakeConfig::default()
        });
        assert!(st.debug_capture);
        assert_eq!(st.debug_dir.as_deref(), Some(dir.display().to_string().as_str()));
        assert!(st.debug_error.is_none());
        assert!(dir.is_dir(), "the folder exists up front, so Settings can reveal it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A capture directory that cannot be created must turn the opt-in back OFF and
    /// say why — never report `debug_capture: true` over a folder it cannot write.
    #[test]
    fn an_unusable_capture_directory_turns_the_opt_in_back_off() {
        let blocker = std::env::temp_dir().join("wake-debug-blocker-file");
        std::fs::write(&blocker, b"not a directory").unwrap();
        let ctrl = WakeController::new();
        let st = ctrl.apply(WakeConfig {
            enabled: false,
            debug_capture: true,
            debug_dir: Some(blocker.join("nested")), // a file cannot hold a folder
            ..WakeConfig::default()
        });
        assert!(!st.debug_capture);
        assert!(st.debug_error.is_some(), "the failure is reported, not swallowed");
        let _ = std::fs::remove_file(&blocker);
    }
}
