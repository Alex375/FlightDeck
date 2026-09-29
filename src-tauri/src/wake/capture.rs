//! Microphone capture for the wake-word detector — the ONLY place `cpal` is used.
//!
//! Opens the default input device, downmixes to mono, resamples to the engine's
//! 16 kHz, and hands the samples (as `[-1, 1]` f32) to the worker thread over an
//! mpsc channel — BATCHED into whole detection steps (80 ms), so the worker wakes
//! ~12 times a second instead of once per audio callback (~94 a second for a
//! 512-frame buffer at 48 kHz). Inference NEVER runs in the audio callback (a
//! real-time thread): the callback only converts, batches and forwards, reusing
//! its buffers — the one allocation left is the batch it hands off, once a step.
//!
//! ⚠️ This is a SECOND consumer of the microphone, running alongside the voice
//! agent's WebRTC `getUserMedia`. Whether macOS + WKWebView allow both to hold the
//! input device at once is the open risk validated at the first `/build-app` — if
//! it does not, detection moves into the webview instead. The rest of the design
//! is independent of that outcome. (That shared device is also why the device's
//! own buffer size is left at its default: batching here costs the other consumer
//! nothing, a bigger hardware buffer might.)

use std::sync::mpsc::Sender;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamError};

use super::engine::{CHUNK, SAMPLE_RATE};
use super::WorkerMsg;

/// A running capture. Dropping it stops and releases the microphone (the macOS
/// orange indicator goes off). `cpal::Stream` is `!Send`, so this lives on the
/// worker thread that created it.
pub struct Capture {
    _stream: Stream,
}

impl Capture {
    /// Start capturing; the audio goes out on `tx` one detection step at a time.
    /// A stream failure that ends the capture (the device went away) is sent on the
    /// same channel, so the worker stops — and says so — instead of waiting forever
    /// on a dead microphone. Errors carry a human message (surfaced as the wake
    /// status `error`), e.g. no microphone.
    pub fn start(tx: Sender<WorkerMsg>) -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "no microphone (input device) found".to_string())?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("could not read the microphone config: {e}"))?;
        let sample_format = supported.sample_format();
        let src_rate = supported.sample_rate().0;
        let channels = supported.config().channels as usize;
        let config: cpal::StreamConfig = supported.config();

        let mut pipe = Pipe::new(src_rate, channels, tx.clone());
        let err_fn = move |e: StreamError| {
            eprintln!("[wake] audio stream error: {e}");
            // A vanished device never delivers again, so the worker is told and
            // stops; the status then says why instead of claiming to listen. Other
            // (backend) errors leave the stream running: logged only.
            if matches!(e, StreamError::DeviceNotAvailable) {
                let _ = tx.send(WorkerMsg::Fault(format!(
                    "the microphone went away ({e}) — turn the wake word off and on to listen again"
                )));
            }
        };

        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _: &_| pipe.push(data, |s| s),
                err_fn,
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _: &_| pipe.push(data, |s| s as f32 / 32768.0),
                err_fn,
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &config,
                move |data: &[u16], _: &_| pipe.push(data, |s| (s as f32 - 32768.0) / 32768.0),
                err_fn,
                None,
            ),
            other => return Err(format!("unsupported microphone sample format: {other:?}")),
        }
        .map_err(|e| format!("could not open the microphone stream: {e}"))?;

        stream
            .play()
            .map_err(|e| format!("could not start the microphone: {e}"))?;
        eprintln!(
            "[wake] mic stream started: device_rate={src_rate} Hz, channels={channels}, format={sample_format:?}"
        );
        Ok(Self { _stream: stream })
    }
}

/// Everything the audio callback does, with its buffers kept across calls:
/// downmix → resample → batch into steps → send.
struct Pipe {
    channels: usize,
    resampler: Resampler,
    /// Downmix scratch, reused: it grows to the callback size once, then stays.
    mono: Vec<f32>,
    batch: StepBatcher,
    tx: Sender<WorkerMsg>,
}

impl Pipe {
    fn new(src_rate: u32, channels: usize, tx: Sender<WorkerMsg>) -> Self {
        Self {
            channels,
            resampler: Resampler::new(src_rate),
            mono: Vec::new(),
            batch: StepBatcher::new(),
            tx,
        }
    }

    fn push<T: Copy>(&mut self, data: &[T], conv: impl Fn(T) -> f32) {
        downmix_into(data, self.channels, conv, &mut self.mono);
        let before = self.batch.pending.len();
        self.resampler.process(&self.mono, &mut self.batch.pending);
        let added = self.batch.pending.len() - before;
        if let Some(batch) = self.batch.completed(added) {
            // A gone receiver means the worker is stopping; nothing to do.
            let _ = self.tx.send(WorkerMsg::Audio(batch));
        }
    }
}

/// Room for one step plus the callback that completes it, so the batch buffer
/// never grows mid-callback.
const BATCH_CAPACITY: usize = CHUNK * 2;

/// Holds resampled audio until it completes a detection step, then hands the
/// whole batch over. The engine counts steps from the first sample it receives —
/// the first sample batched here — so a batch goes out in the very callback that
/// completes a step: the worker wakes once per step, and no step is decided later
/// than when every callback was sent on its own.
struct StepBatcher {
    pending: Vec<f32>,
    /// Samples received since the last step boundary.
    into_step: usize,
}

impl StepBatcher {
    fn new() -> Self {
        Self { pending: Vec::with_capacity(BATCH_CAPACITY), into_step: 0 }
    }

    /// Account for `added` samples just appended to `pending`; returns the batch to
    /// send when they completed a step.
    fn completed(&mut self, added: usize) -> Option<Vec<f32>> {
        self.into_step += added;
        if self.into_step < CHUNK {
            return None;
        }
        self.into_step %= CHUNK;
        Some(std::mem::replace(&mut self.pending, Vec::with_capacity(BATCH_CAPACITY)))
    }
}

/// Average interleaved channels into mono `f32` samples in `out` (cleared first),
/// applying `conv` to each raw sample. `channels == 1` is the common (already-mono)
/// fast path.
fn downmix_into<T: Copy>(data: &[T], channels: usize, conv: impl Fn(T) -> f32, out: &mut Vec<f32>) {
    out.clear();
    let ch = channels.max(1);
    if ch == 1 {
        out.extend(data.iter().map(|&s| conv(s)));
        return;
    }
    out.extend(data.chunks(ch).map(|frame| frame.iter().map(|&s| conv(s)).sum::<f32>() / ch as f32));
}

/// A tiny streaming linear resampler (device rate → 16 kHz). Carries a fractional
/// read position and the unconsumed input tail across callbacks, so buffer
/// boundaries introduce no clicks. Linear interpolation is plenty for wake-word
/// features; a polyphase resampler is an available upgrade if recall needs it.
struct Resampler {
    /// Input samples consumed per output sample (`src / dst`).
    ratio: f64,
    /// Fractional read position within `buf`.
    pos: f64,
    /// Unconsumed input tail retained between callbacks.
    buf: Vec<f32>,
}

impl Resampler {
    fn new(src_rate: u32) -> Self {
        Self {
            ratio: src_rate as f64 / SAMPLE_RATE as f64,
            pos: 0.0,
            buf: Vec::new(),
        }
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        // Exact-rate fast path (a device already at 16 kHz).
        if (self.ratio - 1.0).abs() < f64::EPSILON && self.buf.is_empty() && self.pos == 0.0 {
            out.extend_from_slice(input);
            return;
        }
        self.buf.extend_from_slice(input);
        // Emit while a right neighbour exists to interpolate against.
        while (self.pos as usize) + 1 < self.buf.len() {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.buf[i] * (1.0 - frac) + self.buf[i + 1] * frac);
            self.pos += self.ratio;
        }
        // Drop everything we have fully passed, keeping the fractional offset.
        // `pos` can advance PAST the buffer end when the downsampling ratio is > 2
        // (e.g. 48 kHz → 16 kHz, ratio 3 — the common Mac mic rate): clamp so
        // `drain` never gets an out-of-range end. An out-of-bounds drain here
        // panicked ON CoreAudio's HAL I/O callback thread, and with the release
        // profile's `panic = "abort"` that aborted the WHOLE app (SIGABRT) the
        // moment the mic delivered its first buffer.
        let consumed = (self.pos as usize).min(self.buf.len());
        if consumed > 0 {
            self.buf.drain(..consumed);
            self.pos -= consumed as f64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_stereo() {
        let stereo = [1.0f32, 3.0, 2.0, 4.0]; // L,R,L,R
        let mut out = vec![9.0; 7]; // stale content from a previous callback
        downmix_into(&stereo, 2, |s| s, &mut out);
        assert_eq!(out, vec![2.0, 3.0]);
    }

    /// The worker must wake once per detection step, in the callback that
    /// completes it — and batching must never drop, duplicate or reorder a
    /// sample, whatever the callback sizes (including one bigger than a step).
    #[test]
    fn batches_go_out_once_per_step_and_lose_nothing() {
        let mut batcher = StepBatcher::new();
        let mut sent: Vec<Vec<f32>> = Vec::new();
        let mut total = 0usize;
        let mut completed_steps = 0usize;
        let sizes = [171usize, 170, 171, 512, 1365, 3000, 160, 171];
        for (i, &n) in sizes.iter().cycle().take(400).enumerate() {
            batcher.pending.extend((total..total + n).map(|v| v as f32));
            total += n;
            let batch = batcher.completed(n);
            // A batch goes out exactly when this callback completed a new step.
            assert_eq!(batch.is_some(), total / CHUNK > completed_steps, "callback {i}");
            completed_steps = total / CHUNK;
            sent.extend(batch);
        }
        let mut flat: Vec<f32> = sent.concat();
        flat.extend_from_slice(&batcher.pending);
        assert_eq!(flat.len(), total);
        assert!(flat.iter().enumerate().all(|(i, &v)| v == i as f32), "order and content kept");
    }

    /// At the common Mac cadence (512-frame callbacks at 48 kHz → ~171 samples at
    /// 16 kHz, ~94 callbacks a second) the worker wakes 12.5 times a second.
    #[test]
    fn the_worker_wakes_once_per_step_at_the_usual_mac_cadence() {
        let mut pipe_rate = Resampler::new(48_000);
        let mut batcher = StepBatcher::new();
        let mut wakeups = 0usize;
        let callbacks = 94 * 10; // ~10 s
        for _ in 0..callbacks {
            let before = batcher.pending.len();
            pipe_rate.process(&[0.0f32; 512], &mut batcher.pending);
            let added = batcher.pending.len() - before;
            wakeups += batcher.completed(added).is_some() as usize;
        }
        let seconds = callbacks as f64 * 512.0 / 48_000.0;
        let per_second = wakeups as f64 / seconds;
        assert!((12.0..=13.0).contains(&per_second), "{per_second:.2} wakeups/s");
    }

    #[test]
    fn resampler_halves_length_at_2x_rate() {
        // 32 kHz → 16 kHz ⇒ ratio 2 ⇒ ~half as many output samples.
        let mut r = Resampler::new(32_000);
        let input: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert!((48..=52).contains(&out.len()), "got {}", out.len());
    }

    #[test]
    fn resampler_downsamples_3x_without_panicking() {
        // 48 kHz → 16 kHz is ratio 3: `pos` overshoots the buffer end each call,
        // which used to panic in `drain` — fatal in the audio callback. Feed many
        // small buffers the way CoreAudio does and assert it just works.
        let mut r = Resampler::new(48_000);
        let mut total = 0usize;
        for _ in 0..50 {
            let input: Vec<f32> = (0..512).map(|i| (i as f32 * 0.01).sin()).collect();
            let mut out = Vec::new();
            r.process(&input, &mut out); // must never panic
            total += out.len();
        }
        // ~ 50 * 512 / 3 output samples — just a sanity band, no panic is the point.
        assert!((7000..=10000).contains(&total), "got {total}");
    }

    #[test]
    fn resampler_passthrough_at_native_rate() {
        let mut r = Resampler::new(SAMPLE_RATE);
        let input: Vec<f32> = vec![0.1, 0.2, 0.3, 0.4];
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert_eq!(out, input);
    }
}
