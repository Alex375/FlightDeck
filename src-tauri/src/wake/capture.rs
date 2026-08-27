//! Microphone capture for the wake-word detector — the ONLY place `cpal` is used.
//!
//! Opens the default input device, downmixes to mono, resamples to the engine's
//! 16 kHz, and streams the samples (as `[-1, 1]` f32) to the worker thread over an
//! mpsc channel. Inference NEVER runs in the audio callback (a real-time thread);
//! the callback only converts + forwards, the worker does the ONNX work.
//!
//! ⚠️ This is a SECOND consumer of the microphone, running alongside the voice
//! agent's WebRTC `getUserMedia`. Whether macOS + WKWebView allow both to hold the
//! input device at once is the open risk validated at the first `/build-app` — if
//! it does not, detection moves into the webview instead. The rest of the design
//! is independent of that outcome.

use std::sync::mpsc::Sender;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};

use super::engine::SAMPLE_RATE;

/// A running capture. Dropping it stops and releases the microphone (the macOS
/// orange indicator goes off). `cpal::Stream` is `!Send`, so this lives on the
/// worker thread that created it.
pub struct Capture {
    _stream: Stream,
}

impl Capture {
    /// Start capturing; every resampled mono chunk is sent on `tx`. Errors carry a
    /// human message (surfaced as the wake status `error`), e.g. no microphone.
    pub fn start(tx: Sender<Vec<f32>>) -> Result<Self, String> {
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

        let mut resampler = Resampler::new(src_rate);
        let err_fn = |e| eprintln!("[wake] audio stream error: {e}");

        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &config,
                move |data: &[f32], _: &_| {
                    let mono = downmix(data, channels, |s| s);
                    forward(&mut resampler, &mono, &tx);
                },
                err_fn,
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _: &_| {
                    let mono = downmix(data, channels, |s| s as f32 / 32768.0);
                    forward(&mut resampler, &mono, &tx);
                },
                err_fn,
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &config,
                move |data: &[u16], _: &_| {
                    let mono = downmix(data, channels, |s| (s as f32 - 32768.0) / 32768.0);
                    forward(&mut resampler, &mono, &tx);
                },
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

/// Resample `mono` to 16 kHz and send it — dropping the (rare) case where a
/// receiver has already gone away.
fn forward(resampler: &mut Resampler, mono: &[f32], tx: &Sender<Vec<f32>>) {
    let mut out = Vec::new();
    resampler.process(mono, &mut out);
    if !out.is_empty() {
        let _ = tx.send(out);
    }
}

/// Average interleaved channels into a mono `f32` frame, applying `conv` to each
/// raw sample first. `channels == 1` is the common (already-mono) fast path.
fn downmix<T: Copy>(data: &[T], channels: usize, conv: impl Fn(T) -> f32) -> Vec<f32> {
    let ch = channels.max(1);
    if ch == 1 {
        return data.iter().map(|&s| conv(s)).collect();
    }
    data.chunks(ch)
        .map(|frame| frame.iter().map(|&s| conv(s)).sum::<f32>() / ch as f32)
        .collect()
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
        assert_eq!(downmix(&stereo, 2, |s| s), vec![2.0, 3.0]);
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
