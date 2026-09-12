//! Debug capture — turning a false positive into evidence.
//!
//! The detector fires on things it should not (background noise, onomatopoeia,
//! even silence), and the only way to FIX that is to know what it actually heard.
//! With debug capture on, every fire writes a pair of files:
//!
//!   `<epoch_ms>-<phrase>-<score>.wav`  — ~4 s of 16 kHz mono audio around the
//!                                        fire: what the classifier scored, plus
//!                                        its lead-in.
//!   `<epoch_ms>-<phrase>-<score>.json` — the step-by-step score trajectory, each
//!                                        step carrying Silero's speech
//!                                        probability and the window RMS.
//!
//! That pair is the whole diagnosis. The trajectory says WHICH failure this is —
//! a lone spike that a "N consecutive steps" rule would have swallowed, a slow
//! climb that wants a higher threshold, or a fire at `rms≈0` / `vad≈0`, which no
//! threshold can fix because the model is scoring something that is not speech.
//! And the WAVs are exactly the corpus a retrain needs: they become hard
//! negatives, and they replay through the REAL engine via the `detect_wav`
//! test, so a fix can be proven on the sound that actually misfired.
//!
//! ⚠️ This writes MICROPHONE AUDIO to disk. It is OFF by default and only ever
//! runs on an explicit opt-in; the directory is capped at `MAX_CAPTURES` pairs
//! (oldest pruned first); nothing is ever sent anywhere. Same on-device promise
//! as the detector itself.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::engine::{Detection, SAMPLE_RATE};

/// How many capture pairs to keep before pruning the oldest. A false positive
/// hunt needs a handful of examples, not an unbounded recording of someone's
/// room: 40 pairs is ~11 MB at 4 s each.
const MAX_CAPTURES: usize = 40;

/// Write one fire's WAV + JSON into `dir`, then prune the directory back to
/// `MAX_CAPTURES` pairs. Returns the path of the WAV.
///
/// Every failure comes back as `Err` with a human message — the caller surfaces
/// it in Settings. A capture that silently did not happen is the one outcome
/// worth nothing at all: the user would keep reproducing false positives waiting
/// for evidence that was never written.
pub fn write_capture(
    dir: &Path,
    phrase: &str,
    sensitivity: f32,
    detection: &Detection,
) -> Result<PathBuf, String> {
    let audio = detection
        .audio
        .as_deref()
        .ok_or_else(|| "the detection carried no audio (debug capture was off)".to_string())?;

    std::fs::create_dir_all(dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let stem = format!(
        "{}-{}-{:03}",
        epoch_millis(),
        sanitize_stem(phrase),
        (detection.score.clamp(0.0, 1.0) * 1000.0).round() as u32
    );
    let wav_path = dir.join(format!("{stem}.wav"));
    let json_path = dir.join(format!("{stem}.json"));

    std::fs::write(&wav_path, encode_wav(audio))
        .map_err(|e| format!("could not write {}: {e}", wav_path.display()))?;

    let report = serde_json::json!({
        "phrase": phrase,
        "score": detection.score,
        "threshold": detection.threshold,
        "sensitivity": sensitivity,
        "recorded_at_ms": epoch_millis(),
        "sample_rate": SAMPLE_RATE,
        "audio_samples": audio.len(),
        "audio_file": wav_path.file_name().map(|n| n.to_string_lossy().to_string()),
        // Oldest step first, ending with the one that fired. `vad` is Silero's
        // speech probability (diagnostic only today — it gates nothing) and `rms`
        // the level of the window that step scored.
        "trace": detection
            .trace
            .iter()
            .map(|t| serde_json::json!({ "score": t.score, "vad": t.vad, "rms": t.rms }))
            .collect::<Vec<_>>(),
    });
    let body = serde_json::to_vec_pretty(&report)
        .map_err(|e| format!("could not encode the capture report: {e}"))?;
    if let Err(e) = std::fs::write(&json_path, body) {
        // The WAV alone is close to useless (no trajectory, no threshold): drop it
        // rather than leave a half-capture that reads like a complete one.
        let _ = std::fs::remove_file(&wav_path);
        return Err(format!("could not write {}: {e}", json_path.display()));
    }

    prune(dir, MAX_CAPTURES)?;
    Ok(wav_path)
}

/// Keep the `max` newest capture pairs, deleting older ones. Names start with
/// epoch millis, so lexicographic order IS chronological order — no `stat` per
/// file, and no dependence on a mtime the user may have touched.
fn prune(dir: &Path, max: usize) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("could not list {}: {e}", dir.display()))?;
    let mut stems: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix(".wav") {
            stems.push(stem.to_string());
        }
    }
    if stems.len() <= max {
        return Ok(());
    }
    stems.sort();
    for stem in &stems[..stems.len() - max] {
        let _ = std::fs::remove_file(dir.join(format!("{stem}.wav")));
        let _ = std::fs::remove_file(dir.join(format!("{stem}.json")));
    }
    Ok(())
}

/// Encode `[-1, 1]` mono samples as a 16-bit PCM WAV at `SAMPLE_RATE`. Hand-rolled
/// (44-byte header, no crate): the engine's `detect_wav` test reads exactly this
/// shape back, so a capture replays through the real pipeline unchanged.
fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // format: PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // channels: mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for &s in samples {
        // Clamp before scaling: a sample past ±1 would wrap to the opposite sign
        // and print as a click in the very clip we are trying to read.
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Keep a phrase key safe to paste into a filename. Phrase keys are ours and
/// already tame, but the file name is built from one — so it is constrained here
/// rather than trusted.
fn sanitize_stem(phrase: &str) -> String {
    let cleaned: String = phrase
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .take(32)
        .collect();
    if cleaned.is_empty() {
        "phrase".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wake::engine::StepTrace;

    fn detection(score: f32, samples: usize) -> Detection {
        Detection {
            score,
            threshold: 0.6,
            trace: vec![StepTrace { score, vad: 0.9, rms: 0.05 }],
            audio: Some(vec![0.25f32; samples]),
        }
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wake-debug-test-{tag}-{}", epoch_millis()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_a_wav_and_a_report_side_by_side() {
        let dir = tmp_dir("pair");
        let wav = write_capture(&dir, "alexa", 0.5, &detection(0.87, 1000)).expect("capture writes");
        assert!(wav.exists(), "the WAV is on disk");
        let json = wav.with_extension("json");
        assert!(json.exists(), "the report sits beside it");

        let body = std::fs::read_to_string(&json).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["phrase"], "alexa");
        assert_eq!(parsed["sample_rate"], SAMPLE_RATE);
        assert_eq!(parsed["audio_samples"], 1000);
        assert_eq!(parsed["trace"].as_array().unwrap().len(), 1);
        // The score rides in the NAME too, so a directory listing already ranks the
        // captures by how confident the misfire was.
        assert!(wav.file_name().unwrap().to_string_lossy().contains("-870"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_wav_round_trips_through_the_engines_reader() {
        // The capture is only useful if `detect_wav` can replay it: same header
        // shape, same 16-bit little-endian PCM, same rate.
        let bytes = encode_wav(&[0.0, 0.5, -0.5, 1.0, -1.0]);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(bytes.len(), 44 + 5 * 2, "44-byte header + one i16 per sample");
        let data_pos = bytes.windows(4).position(|w| w == b"data").expect("data chunk");
        let decoded: Vec<f32> = bytes[data_pos + 8..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();
        assert_eq!(decoded.len(), 5);
        assert!((decoded[1] - 0.5).abs() < 1e-3, "0.5 survives the round trip");
        assert!((decoded[4] + 1.0).abs() < 1e-3, "-1.0 clamps instead of wrapping positive");
    }

    #[test]
    fn prunes_to_the_newest_captures() {
        let dir = tmp_dir("prune");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("{i:013}-alexa-500.wav")), b"x").unwrap();
            std::fs::write(dir.join(format!("{i:013}-alexa-500.json")), b"{}").unwrap();
        }
        prune(&dir, 2).expect("prune runs");
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".wav"))
            .collect();
        assert_eq!(left.len(), 2, "only the newest pairs survive");
        assert!(left.iter().all(|n| n.starts_with("0000000000003") || n.starts_with("0000000000004")));
        // The JSON sidecar goes with its WAV — a lone report explains nothing.
        assert!(!dir.join("0000000000000-alexa-500.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_detection_without_audio_is_an_error_not_a_silent_no_op() {
        let dir = tmp_dir("noaudio");
        let mut d = detection(0.9, 10);
        d.audio = None;
        let err = write_capture(&dir, "alexa", 0.5, &d).expect_err("must not pretend to capture");
        assert!(err.contains("no audio"), "the reason is legible: {err}");
    }

    #[test]
    fn phrase_keys_cannot_escape_the_capture_directory() {
        assert_eq!(sanitize_stem("ground_control"), "ground_control");
        assert_eq!(sanitize_stem("../../etc/passwd"), "______etc_passwd");
        assert_eq!(sanitize_stem(""), "phrase");
    }
}
