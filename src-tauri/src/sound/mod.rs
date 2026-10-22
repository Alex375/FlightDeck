//! The single service that knows the alert sounds already on this Mac and plays them.
//!
//! A notification sound is one of two things. Flight Deck's own chimes are synthesized in
//! the webview (`src/notifications/sound.ts`) and never reach this module. Everything else
//! is a sound FILE that ships with macOS or that the user dropped in `~/Library/Sounds` —
//! the same folders the system's own alert-sound pickers read. This module lists them and
//! plays one by id.
//!
//! Playback shells out to `/usr/bin/afplay` (same shell-out encapsulation as `power/` →
//! `caffeinate`): CoreAudio decodes every format the system pickers offer (aiff, caf, m4r,
//! m4a, mp3, wav) and no byte crosses the IPC. It also sidesteps the webview's audio unit
//! entirely, so a file sound never inherits the "running but silent" AudioContext failure
//! the synthesized chimes have to guard against. Absolute path: a Finder-launched bundle
//! has a minimal `PATH`.
//!
//! Only LISTED files can be played: `play` resolves the id against a fresh listing, so the
//! front names a sound, never a path.

use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicUsize, Ordering};

/// The macOS file player, present on every install (nothing to bundle).
#[cfg(target_os = "macos")]
const AFPLAY_BIN: &str = "/usr/bin/afplay";

/// The classic macOS alert sounds (Basso, Glass, Ping…) — public, stable location.
const SYSTEM_SOUNDS_DIR: &str = "/System/Library/Sounds";

/// The tone library behind the newer alert/text tones (Chord, Complete, Rebound…). A PRIVATE
/// framework: its layout is not a contract, so every subfolder is read best-effort and a
/// missing one simply lists nothing.
const TONES_DIR: &str = "/System/Library/PrivateFrameworks/ToneLibrary.framework/Versions/A/Resources/AlertTones";

/// Suffix the "Encore" tone set appends to every file name; dropped from the label.
const ENCORE_SUFFIX: &str = "-EncoreInfinitum";

/// Extensions CoreAudio plays that are worth offering as an alert sound.
const SOUND_EXTENSIONS: &[&str] = &["aiff", "aif", "caf", "m4r", "m4a", "mp3", "wav", "aac"];

/// `afplay`'s 1.0 plays the file at full scale, noticeably louder than the soft synthesized
/// chimes (measured: the loudest 300 ms of the system sounds averages ~2.4× the chimes' RMS).
/// Scaling files by this keeps both families at a similar level, so switching sound doesn't
/// jump the loudness.
const FILE_GAIN: f64 = 0.45;

/// At most this many file sounds play at once. A fleet finishing together would otherwise
/// stack a cacophony of players; past the cap a play is skipped (the synthesized chimes cap
/// the same way, see `MAX_LIVE` in sound.ts).
#[cfg(target_os = "macos")]
const MAX_PLAYING: usize = 4;

#[cfg(target_os = "macos")]
static PLAYING: AtomicUsize = AtomicUsize::new(0);

/// One playable sound file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct AlertSound {
    /// `<group>:<path relative to the group's folder>` — what the front stores and plays.
    pub id: String,
    /// The file name without its extension (and without the Encore suffix).
    pub label: String,
}

/// The sounds of one source folder, as one section of the picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct AlertSoundGroup {
    pub id: String,
    pub label: String,
    pub sounds: Vec<AlertSound>,
}

/// Every alert sound this Mac offers, grouped by where it lives.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AlertSoundLibrary {
    /// Non-empty groups only, in display order.
    pub groups: Vec<AlertSoundGroup>,
    /// The folder the user drops their own sounds into (`~/Library/Sounds`), whether or not
    /// it exists yet. `None` where file sounds are unavailable.
    pub user_dir: Option<String>,
    /// Why this build cannot play sound files at all, or `None` where it can.
    pub unavailable: Option<String>,
}

/// One folder of a group; `sub` prefixes the ids of its files so two folders of the same
/// group can't collide.
struct Source {
    dir: PathBuf,
    sub: Option<&'static str>,
}

struct GroupSpec {
    id: &'static str,
    label: &'static str,
    sources: Vec<Source>,
}

fn user_sounds_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .map(|home| home.join("Library").join("Sounds"))
}

fn group_specs() -> Vec<GroupSpec> {
    let tones = Path::new(TONES_DIR);
    let mut specs = vec![
        GroupSpec {
            id: "system",
            label: "macOS alerts",
            sources: vec![Source { dir: PathBuf::from(SYSTEM_SOUNDS_DIR), sub: None }],
        },
        GroupSpec {
            id: "tones",
            label: "macOS tones",
            sources: vec![
                Source { dir: tones.join("Modern"), sub: Some("Modern") },
                Source { dir: tones.join("EncoreInfinitum"), sub: Some("EncoreInfinitum") },
            ],
        },
        GroupSpec {
            id: "classic",
            label: "macOS classic tones",
            sources: vec![Source { dir: tones.join("Classic"), sub: None }],
        },
    ];
    if let Some(dir) = user_sounds_dir() {
        specs.push(GroupSpec {
            id: "user",
            label: "Your sounds",
            sources: vec![Source { dir, sub: None }],
        });
    }
    specs
}

/// The picker label of a sound file: its stem, minus the Encore suffix. `None` for a file
/// that isn't a playable sound (wrong extension, hidden, no stem).
fn sound_label(file_name: &str) -> Option<String> {
    if file_name.starts_with('.') {
        return None;
    }
    let (stem, ext) = file_name.rsplit_once('.')?;
    if stem.is_empty() || !SOUND_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
        return None;
    }
    let label = stem.strip_suffix(ENCORE_SUFFIX).unwrap_or(stem);
    Some(label.to_string())
}

/// The sound files directly inside `source.dir` (not recursive), each paired with its path.
/// An unreadable or missing folder lists nothing — a source is optional by nature.
fn list_source(group_id: &str, source: &Source) -> Vec<(AlertSound, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(&source.dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let label = sound_label(&name)?;
            let rel = match source.sub {
                Some(sub) => format!("{sub}/{name}"),
                None => name,
            };
            Some((AlertSound { id: format!("{group_id}:{rel}"), label }, e.path()))
        })
        .collect()
}

/// Every group with its sounds sorted by label, paths kept for `play`. Empty groups dropped.
fn list_with_paths(specs: &[GroupSpec]) -> Vec<(AlertSoundGroup, Vec<PathBuf>)> {
    specs
        .iter()
        .filter_map(|spec| {
            let mut found: Vec<(AlertSound, PathBuf)> =
                spec.sources.iter().flat_map(|s| list_source(spec.id, s)).collect();
            if found.is_empty() {
                return None;
            }
            found.sort_by(|a, b| {
                a.0.label.to_lowercase().cmp(&b.0.label.to_lowercase()).then(a.0.id.cmp(&b.0.id))
            });
            let (sounds, paths): (Vec<_>, Vec<_>) = found.into_iter().unzip();
            Some((AlertSoundGroup { id: spec.id.into(), label: spec.label.into(), sounds }, paths))
        })
        .collect()
}

/// The listed file behind `id`, or `None` when no listed sound has it.
fn resolve_in(specs: &[GroupSpec], id: &str) -> Option<PathBuf> {
    list_with_paths(specs).into_iter().find_map(|(group, paths)| {
        group.sounds.iter().position(|s| s.id == id).map(|i| paths[i].clone())
    })
}

/// Why sound files can't play on this build, or `None` where they can.
const FILES_UNAVAILABLE: Option<&str> = if cfg!(target_os = "macos") {
    None
} else {
    Some("System sounds are only available on macOS. Flight Deck's own sounds work everywhere.")
};

/// Every alert sound on this Mac. Never errors: an unreadable folder lists nothing.
pub fn library() -> AlertSoundLibrary {
    if let Some(reason) = FILES_UNAVAILABLE {
        return AlertSoundLibrary { groups: Vec::new(), user_dir: None, unavailable: Some(reason.into()) };
    }
    AlertSoundLibrary {
        groups: list_with_paths(&group_specs()).into_iter().map(|(g, _)| g).collect(),
        user_dir: user_sounds_dir().map(|d| d.to_string_lossy().into_owned()),
        unavailable: None,
    }
}

/// The `afplay -v` level for a user volume (1.0 = the default level).
fn afplay_volume(volume: f64) -> f64 {
    let v = if volume.is_finite() { volume } else { 1.0 };
    (v.clamp(0.0, 2.0) * FILE_GAIN).clamp(0.0, 2.0)
}

/// Play the sound `id` at `volume` (1.0 = default level, up to 2.0), without waiting for it
/// to finish. `Ok(false)` when skipped because too many sounds are already playing; `Err`
/// when the id names no listed sound (a file deleted since it was picked) or the player
/// can't start — the front then falls back to its own chime, never to silence.
pub fn play(id: &str, volume: f64) -> Result<bool, String> {
    if let Some(reason) = FILES_UNAVAILABLE {
        return Err(reason.into());
    }
    let path = resolve_in(&group_specs(), id)
        .ok_or_else(|| format!("The sound \"{id}\" is no longer on this Mac."))?;
    spawn_player(&path, afplay_volume(volume))
}

#[cfg(target_os = "macos")]
fn spawn_player(path: &Path, level: f64) -> Result<bool, String> {
    use std::process::{Command, Stdio};
    if PLAYING.fetch_add(1, Ordering::SeqCst) >= MAX_PLAYING {
        PLAYING.fetch_sub(1, Ordering::SeqCst);
        return Ok(false);
    }
    let child = Command::new(AFPLAY_BIN)
        .arg("-v")
        .arg(format!("{level:.3}"))
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    let child = match child {
        Ok(c) => c,
        Err(e) => {
            PLAYING.fetch_sub(1, Ordering::SeqCst);
            return Err(format!("Could not start the sound player: {e}"));
        }
    };
    // Reap the player off-thread (no zombie) and free its slot when it ends. A decode
    // failure only shows up here, after we've returned — log it so it isn't invisible.
    let shown = path.display().to_string();
    std::thread::spawn(move || {
        match child.wait_with_output() {
            Ok(out) if !out.status.success() => eprintln!(
                "afplay failed for {shown}: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => eprintln!("afplay wait failed for {shown}: {e}"),
            Ok(_) => {}
        }
        PLAYING.fetch_sub(1, Ordering::SeqCst);
    });
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
fn spawn_player(_path: &Path, _level: f64) -> Result<bool, String> {
    Err(FILES_UNAVAILABLE.unwrap_or("Unavailable").into())
}

/// Open `~/Library/Sounds` in Finder, creating it first: it doesn't exist on a fresh Mac,
/// and it's where the user drops a sound to add it to the picker.
pub fn open_user_dir() -> Result<(), String> {
    if let Some(reason) = FILES_UNAVAILABLE {
        return Err(reason.into());
    }
    let dir = user_sounds_dir().ok_or("Your home folder could not be found.")?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flightdeck-sounds-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"x").unwrap();
    }

    #[test]
    fn labels_keep_sound_files_only() {
        assert_eq!(sound_label("Glass.aiff").as_deref(), Some("Glass"));
        assert_eq!(sound_label("Tri-Tone.M4R").as_deref(), Some("Tri-Tone"));
        assert_eq!(sound_label("Rebound-EncoreInfinitum.caf").as_deref(), Some("Rebound"));
        assert_eq!(sound_label("My ding.v2.mp3").as_deref(), Some("My ding.v2"));
        assert_eq!(sound_label("notes.txt"), None);
        assert_eq!(sound_label(".hidden.wav"), None);
        assert_eq!(sound_label("noext"), None);
        assert_eq!(sound_label(".wav"), None);
    }

    #[test]
    fn groups_list_sorted_ids_skip_empty_and_missing_folders() {
        let a = temp_dir("a");
        let b = temp_dir("b");
        touch(&a, "zeta.aiff");
        touch(&a, "Alpha.wav");
        touch(&a, "readme.md");
        std::fs::create_dir_all(a.join("nested.aiff")).unwrap(); // a folder, not a sound
        touch(&b, "Mid-EncoreInfinitum.caf");
        let empty = temp_dir("empty");
        let specs = vec![
            GroupSpec {
                id: "g",
                label: "G",
                sources: vec![
                    Source { dir: a.clone(), sub: None },
                    Source { dir: b.clone(), sub: Some("B") },
                    Source { dir: a.join("missing"), sub: None },
                ],
            },
            GroupSpec { id: "e", label: "E", sources: vec![Source { dir: empty.clone(), sub: None }] },
        ];
        let groups: Vec<AlertSoundGroup> = list_with_paths(&specs).into_iter().map(|(g, _)| g).collect();
        assert_eq!(groups.len(), 1, "the empty group is dropped");
        let ids: Vec<&str> = groups[0].sounds.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["g:Alpha.wav", "g:B/Mid-EncoreInfinitum.caf", "g:zeta.aiff"]);
        assert_eq!(groups[0].sounds[1].label, "Mid");
        for d in [a, b, empty] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn resolve_plays_listed_files_only() {
        let dir = temp_dir("resolve");
        touch(&dir, "Ping.aiff");
        let specs = vec![GroupSpec { id: "user", label: "U", sources: vec![Source { dir: dir.clone(), sub: None }] }];
        assert_eq!(resolve_in(&specs, "user:Ping.aiff"), Some(dir.join("Ping.aiff")));
        assert_eq!(resolve_in(&specs, "user:../Ping.aiff"), None);
        assert_eq!(resolve_in(&specs, "user:/etc/passwd"), None);
        assert_eq!(resolve_in(&specs, "system:Ping.aiff"), None, "the group is part of the id");
        std::fs::remove_file(dir.join("Ping.aiff")).unwrap();
        assert_eq!(resolve_in(&specs, "user:Ping.aiff"), None, "a deleted file no longer resolves");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn volume_is_scaled_and_bounded() {
        assert!((afplay_volume(1.0) - FILE_GAIN).abs() < 1e-9);
        assert_eq!(afplay_volume(-3.0), 0.0);
        assert!((afplay_volume(9.0) - 2.0 * FILE_GAIN).abs() < 1e-9);
        assert!((afplay_volume(f64::NAN) - FILE_GAIN).abs() < 1e-9);
    }

    /// The real folders of this Mac list something, and every listed id resolves back.
    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_lists_its_system_sounds() {
        let lib = library();
        let system = lib.groups.iter().find(|g| g.id == "system").expect("system sounds");
        assert!(system.sounds.iter().any(|s| s.label == "Glass"));
        let first = &system.sounds[0];
        assert!(resolve_in(&group_specs(), &first.id).is_some());
    }
}
