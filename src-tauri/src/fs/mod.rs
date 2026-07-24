// The single service that speaks the local filesystem for the lightweight editor
// panel: listing a directory, reading a file, writing a file, and watching a
// working tree for live changes. Same encapsulation pattern as `store/db.rs`
// (SQL) and `git/mod.rs` (the `git` binary): the rest of the core and the IPC
// layer go through here and never touch `std::fs` for editor concerns, so the
// implementation stays swappable.
//
// The watcher is deliberately lean (perf is a core requirement): a single active
// watch on the conversation's current working directory, recursive (cheap on
// macOS FSEvents), with noisy build/VCS directories filtered out and events
// coalesced over a short debounce window before they reach the UI as one
// `FsChangeEvent`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::ipc::events::{FsChangeEvent, FsWatchErrorEvent};

/// Files larger than this are not read into the editor (returned as `too_large`).
/// The cap is about COST, not binariness: `read_file` loads the whole file into
/// memory, `from_utf8_lossy` decodes a second copy, the IPC layer serialises a
/// third (JSON), the webview deserialises a fourth, and Monaco then builds a model
/// from it. Tens of MiB through that pipeline stalls the webview for seconds —
/// against the core "stay responsive" requirement. 16 MiB comfortably opens real
/// source, lockfiles and generated files while still refusing a pathological dump
/// (a multi-hundred-MB log) that would freeze the UI.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// How long the watcher batches incoming change events before emitting them as a
/// single coalesced `FsChangeEvent`. A burst (e.g. `git checkout`, a formatter)
/// thus produces one UI refresh instead of dozens.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Directory names whose contents are noise for an editor watcher: VCS internals
/// and build output. A change anywhere under one of these is dropped, so a busy
/// `node_modules` or `.git` never floods the UI.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
];

/// One immediate child of a listed directory. The tree expands lazily (a click
/// reads exactly one level), so a huge repo never reads more than what is shown.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// A file's contents plus the guards the editor needs: `too_large` (skipped, over
/// [`MAX_FILE_BYTES`]) and `binary` (a NUL byte was found — not shown as text).
/// In both guard cases `content` is empty.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub too_large: bool,
    pub binary: bool,
    pub size: u64,
    /// Last-modified time when these bytes were read — the editor's staleness
    /// stamp (see [`FileStat`]). `None` when the platform doesn't report one.
    pub mtime_ms: Option<u64>,
}

/// What a file looks like on disk WITHOUT reading it: its size and last-modified
/// time. One `stat` per path, no bytes — which is the whole point. The editor
/// stamps every loaded buffer with this and re-checks it to decide whether the
/// content actually needs re-reading, so a 15 MiB PDF that nobody touched costs a
/// syscall instead of a full base64 round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileStat {
    pub path: String,
    /// False when the path can't be stat'ed at all — gone, or unreadable. The
    /// caller must treat this as "re-read it" rather than "unchanged": the real
    /// reason then surfaces through the normal read path (which reports it to the
    /// user) instead of being swallowed here.
    pub exists: bool,
    pub size: u64,
    /// Milliseconds since the Unix epoch. `None` when the filesystem or platform
    /// doesn't report a modification time — callers then compare `size` alone.
    pub mtime_ms: Option<u64>,
}

/// Last-modified time of `meta` in ms since the Unix epoch, or `None` when the
/// platform/filesystem doesn't provide one (or reports a pre-epoch time).
fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Stat several paths in one call — the editor checks every open tab at once, and
/// one IPC round-trip for N paths beats N round-trips. A path that can't be
/// stat'ed comes back `exists: false` rather than failing the whole batch: one
/// deleted file must not blind the caller to the other tabs.
pub fn stat_files(paths: &[String]) -> Vec<FileStat> {
    paths
        .iter()
        .map(|p| match fs::metadata(p) {
            Ok(m) => FileStat {
                path: p.clone(),
                exists: true,
                size: m.len(),
                mtime_ms: mtime_ms(&m),
            },
            Err(_) => FileStat {
                path: p.clone(),
                exists: false,
                size: 0,
                mtime_ms: None,
            },
        })
        .collect()
}

/// List one directory level, directories first then files, case-insensitive
/// alphabetical. Symlinks resolve to their target's kind so a symlinked directory
/// still expands. Hidden entries are kept (the tree is honest); only the *watcher*
/// filters noise.
pub fn read_dir(path: &str) -> std::io::Result<Vec<FsEntry>> {
    let mut entries: Vec<FsEntry> = Vec::new();
    for dent in fs::read_dir(path)? {
        let dent = dent?;
        let ft = dent.file_type()?;
        let is_dir = if ft.is_symlink() {
            // Resolve the link so a symlinked dir is treated as a dir.
            fs::metadata(dent.path()).map(|m| m.is_dir()).unwrap_or(false)
        } else {
            ft.is_dir()
        };
        entries.push(FsEntry {
            name: dent.file_name().to_string_lossy().into_owned(),
            path: dent.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        // `true` sorts after `false`, so compare dir flags reversed to put dirs first.
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Read a file for the editor, guarding size and binariness. A file over
/// [`MAX_FILE_BYTES`] returns `too_large`; one with a NUL byte in its first 8 KiB
/// returns `binary`; otherwise its bytes are decoded UTF-8 (lossily, so an odd
/// byte never fails the read). `content` is empty in both guard cases.
///
/// The returned `mtime_ms` is sampled BEFORE the bytes, deliberately: a writer
/// racing us then yields an mtime OLDER than the content we hand back, so the
/// next staleness check re-reads (harmless, converges). Sampling it after would
/// pair a NEW mtime with OLD content — a buffer stuck stale with no way to notice.
pub fn read_file(path: &str) -> std::io::Result<FileContent> {
    let meta = fs::metadata(path)?;
    let (size, mtime_ms) = (meta.len(), mtime_ms(&meta));
    if size > MAX_FILE_BYTES {
        return Ok(FileContent {
            path: path.to_string(),
            content: String::new(),
            too_large: true,
            binary: false,
            size,
            mtime_ms,
        });
    }
    let bytes = fs::read(path)?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Ok(FileContent {
            path: path.to_string(),
            content: String::new(),
            too_large: false,
            binary: true,
            size,
            mtime_ms,
        });
    }
    Ok(FileContent {
        path: path.to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        too_large: false,
        binary: false,
        size,
        mtime_ms,
    })
}

/// An image file's bytes, base64-encoded for the webview to render as a `data:`
/// URL. Unlike [`read_file`], the binary content IS the payload here — images are
/// never decoded as text. `too_large` (over [`MAX_FILE_BYTES`]) leaves
/// `data_base64` empty; the front shows a guard instead of the image.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ImageContent {
    pub path: String,
    /// Base64 of the raw file bytes, NO `data:` prefix (the front prepends the
    /// `data:<mime>;base64,` header, choosing the MIME from the extension).
    pub data_base64: String,
    pub too_large: bool,
    pub size: u64,
    /// Last-modified time when these bytes were read — the editor's staleness
    /// stamp (see [`FileStat`]). `None` when the platform doesn't report one.
    pub mtime_ms: Option<u64>,
}

/// Read an image file for the viewer, base64-encoding its bytes. Same size guard
/// as [`read_file`] (a multi-hundred-MB file would bloat ~33% more as base64 and
/// stall the webview) — over [`MAX_FILE_BYTES`] returns `too_large` with empty
/// data. No binariness check: the caller already routed here BECAUSE the path is a
/// known image extension, and the bytes are meant to be binary.
///
/// `mtime_ms` is sampled before the bytes for the same reason as [`read_file`].
pub fn read_image(path: &str) -> std::io::Result<ImageContent> {
    use base64::Engine;
    let meta = fs::metadata(path)?;
    let (size, mtime_ms) = (meta.len(), mtime_ms(&meta));
    if size > MAX_FILE_BYTES {
        return Ok(ImageContent {
            path: path.to_string(),
            data_base64: String::new(),
            too_large: true,
            size,
            mtime_ms,
        });
    }
    let bytes = fs::read(path)?;
    Ok(ImageContent {
        path: path.to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        too_large: false,
        size,
        mtime_ms,
    })
}

/// Write the editor buffer back to disk (overwriting). The parent directory must
/// already exist (we never create files outside the tree the user is editing).
pub fn write_file(path: &str, content: &str) -> std::io::Result<()> {
    fs::write(path, content)
}

// ---- Mutating tree operations (the explorer's context menu) ----------------
//
// New file / new folder / rename / copy / delete, driven by right-click actions
// in the file tree. Every one that lands new content REFUSES to clobber an
// existing path (`create_new` / an explicit `exists()` guard): a typo or a name
// collision surfaces an error instead of silently destroying data — the caller
// (paste) is the one that resolves a fresh, non-colliding name. Delete is the
// lone exception and is deliberately the SAFE kind: it moves to the OS trash
// (recoverable), never an irreversible unlink.

/// The "already exists" error, shared by the create/rename/copy guards.
fn already_exists() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "an item with this name already exists",
    )
}

/// Create an empty file at `path`. Errors if anything already exists there (we
/// never silently overwrite — the action is "new file"). `create_new` makes the
/// existence check atomic, so two quick creates can't race into a clobber.
pub fn create_file(path: &str) -> std::io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
}

/// Create a new directory at `path` (a single level). Errors if it already exists.
pub fn create_dir(path: &str) -> std::io::Result<()> {
    if Path::new(path).exists() {
        return Err(already_exists());
    }
    fs::create_dir(path)
}

/// Rename / move `from` to `to`. Refuses to clobber a DIFFERENT existing entry: a
/// plain `fs::rename` on Unix would silently replace the destination, so we guard
/// first. The guard explicitly allows the case where `to` resolves to `from`
/// itself — on a case-insensitive volume (default APFS/HFS+) a case-only rename
/// (`Readme.md` → `readme.md`) has `to` "exist" as the same file; that's a
/// legitimate rename, not a clobber, so it must go through.
pub fn rename(from: &str, to: &str) -> std::io::Result<()> {
    let (from_p, to_p) = (Path::new(from), Path::new(to));
    if to_p.exists() && !same_entry(from_p, to_p) {
        return Err(already_exists());
    }
    fs::rename(from_p, to_p)
}

/// Whether two existing paths denote the SAME filesystem entry — so a case-only or
/// no-op rename isn't mistaken for a clobber. Compares canonical paths (which
/// resolve symlinks and the on-disk case). Returns false if either can't be
/// canonicalized (treated as distinct → the clobber guard stays in force).
fn same_entry(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Recursively copy `from` (a file or a whole directory tree) to `to`. Refuses an
/// existing `to`; the caller (paste) resolves a non-colliding destination name. On
/// failure mid-tree, the partially-written `to` is rolled back so a retry isn't
/// blocked by a half-copied destination (and `copy 2` / `copy 3` don't pile up).
pub fn copy_path(from: &str, to: &str) -> std::io::Result<()> {
    let to_p = Path::new(to);
    if to_p.exists() {
        return Err(already_exists());
    }
    let res = copy_recursive(Path::new(from), to_p);
    if res.is_err() {
        // Best-effort rollback of the destination WE just started creating.
        if to_p.is_dir() {
            let _ = fs::remove_dir_all(to_p);
        } else if to_p.exists() {
            let _ = fs::remove_file(to_p);
        }
    }
    res
}

/// Copy one tree node. A symlink is recreated as a symlink (its target is copied
/// verbatim, like VS Code — and it is NEVER followed into recursion, so a link to
/// a directory, e.g. a pnpm `node_modules` entry, copies cleanly and a cyclic link
/// can't loop). A directory is created then recursed; everything else is a byte
/// copy. `symlink_metadata` (not `metadata`) is what keeps a symlink off the
/// recursion path.
fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    let ft = fs::symlink_metadata(from)?.file_type();
    if ft.is_symlink() {
        copy_symlink(from, to)
    } else if ft.is_dir() {
        fs::create_dir(to)?;
        for dent in fs::read_dir(from)? {
            let dent = dent?;
            copy_recursive(&dent.path(), &to.join(dent.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// Recreate `from` (a symlink) at `to`, preserving the link target.
#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}

/// No portable symlink primitive on non-Unix: fall back to copying the link's
/// resolved bytes (best effort).
#[cfg(not(unix))]
fn copy_symlink(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::copy(from, to).map(|_| ())
}

/// Move `path` to the OS trash/recycle bin — the VS Code "Delete" default. This is
/// recoverable (restore from the Finder), unlike an irreversible `remove_file` /
/// `remove_dir_all`, so a misclick on the wrong node never destroys work. The
/// `trash` crate uses the native NSFileManager API on macOS (no Finder-automation
/// permission). Its error type isn't `io::Error`, so this returns a `String`.
pub fn delete_to_trash(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

/// Whether any path segment is an ignored build/VCS directory.
fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(os) => os
            .to_str()
            .map(|s| IGNORED_DIRS.contains(&s))
            .unwrap_or(false),
        _ => false,
    })
}

/// The app's single active filesystem watch. `watch` replaces whatever was being
/// watched (we only ever watch the conversation currently shown in the editor);
/// `unwatch` stops it. Held as Tauri managed state.
#[derive(Default)]
pub struct FsWatcher {
    inner: Mutex<Option<ActiveWatch>>,
}

struct ActiveWatch {
    // Dropped on replace/unwatch, which stops the OS watch and closes the channel,
    // letting the debounce thread exit.
    _watcher: RecommendedWatcher,
    stop: Arc<AtomicBool>,
}

impl FsWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start (or replace) the watch on `root`, emitting a coalesced `FsChangeEvent`
    /// to the webview whenever non-ignored paths under it change.
    pub fn watch(&self, app: tauri::AppHandle, root: PathBuf) -> notify::Result<()> {
        self.unwatch(); // at most one active watch
        let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
        // Clone for the error path so the watcher can tell the UI it went blind
        // (the original `app` is moved into the debounce thread below).
        let err_app = app.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            match res {
                Ok(event) => {
                    for p in event.paths {
                        if !is_ignored(&p) {
                            // The receiver is only gone once the watch is being torn
                            // down; ignore the send error in that race.
                            let _ = tx.send(p);
                        }
                    }
                }
                // A watcher backend error is rare but must not vanish silently: log it
                // AND tell the editor panel live updates may have stopped, so the tree
                // doesn't silently go stale.
                Err(e) => {
                    eprintln!("[fs watcher] event error: {e}");
                    let _ = (FsWatchErrorEvent { message: e.to_string() }).emit(&err_app);
                }
            }
        })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        std::thread::spawn(move || debounce_loop(rx, app, stop_thread));
        *self.inner.lock().unwrap() = Some(ActiveWatch {
            _watcher: watcher,
            stop,
        });
        Ok(())
    }

    /// Stop the active watch, if any.
    pub fn unwatch(&self) {
        if let Some(active) = self.inner.lock().unwrap().take() {
            active.stop.store(true, Ordering::SeqCst);
            // Dropping `active` drops the watcher → closes the channel → the
            // debounce thread sees `Disconnected` and exits.
        }
    }
}

/// Collect change paths and flush them as one `FsChangeEvent` per quiet window.
/// Exits when the channel closes (watch torn down) or the stop flag is set.
fn debounce_loop(rx: Receiver<PathBuf>, app: tauri::AppHandle, stop: Arc<AtomicBool>) {
    use std::collections::HashSet;
    loop {
        // Block until the first change of a new burst (or the channel closes).
        let first = match rx.recv() {
            Ok(p) => p,
            Err(_) => return,
        };
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let mut batch: HashSet<PathBuf> = HashSet::new();
        batch.insert(first);
        // Keep draining while changes keep arriving within the debounce window.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(p) => {
                    batch.insert(p);
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    emit_batch(&app, batch);
                    return;
                }
            }
        }
        if stop.load(Ordering::SeqCst) {
            return;
        }
        emit_batch(&app, batch);
    }
}

fn emit_batch(app: &tauri::AppHandle, batch: std::collections::HashSet<PathBuf>) {
    if batch.is_empty() {
        return;
    }
    let paths: Vec<String> = batch
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let _ = FsChangeEvent { paths }.emit(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A fresh, empty temp directory unique to this test run.
    fn fresh_dir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let mut d = std::env::temp_dir();
        d.push(format!("tosse-fs-test-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn read_dir_lists_dirs_first_then_alpha() {
        let d = fresh_dir();
        fs::create_dir(d.join("zsub")).unwrap();
        fs::write(d.join("B.txt"), "b").unwrap();
        fs::write(d.join("a.txt"), "a").unwrap();
        let entries = read_dir(d.to_str().unwrap()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zsub", "a.txt", "B.txt"]);
        assert!(entries[0].is_dir);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn read_file_roundtrips_text_and_flags_binary() {
        let d = fresh_dir();
        let f = d.join("hello.txt");
        write_file(f.to_str().unwrap(), "héllo").unwrap();
        let got = read_file(f.to_str().unwrap()).unwrap();
        assert_eq!(got.content, "héllo");
        assert!(!got.binary && !got.too_large);

        let bin = d.join("blob.bin");
        fs::write(&bin, [0u8, 1, 2, 3]).unwrap();
        let got = read_file(bin.to_str().unwrap()).unwrap();
        assert!(got.binary);
        assert!(got.content.is_empty());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn read_image_base64_encodes_bytes() {
        use base64::Engine;
        let d = fresh_dir();
        // A tiny "image" — read_image doesn't care about real format, just bytes.
        let img = d.join("pixel.png");
        let bytes = [0x89u8, b'P', b'N', b'G', 0, 1, 2, 3];
        fs::write(&img, bytes).unwrap();
        let got = read_image(img.to_str().unwrap()).unwrap();
        assert!(!got.too_large);
        assert_eq!(got.size, bytes.len() as u64);
        assert_eq!(
            got.data_base64,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn reads_stamp_the_modification_time() {
        let d = fresh_dir();
        let f = d.join("stamped.txt");
        write_file(f.to_str().unwrap(), "one").unwrap();
        let text = read_file(f.to_str().unwrap()).unwrap();
        let img = read_image(f.to_str().unwrap()).unwrap();
        // Both readers must stamp the buffer, or the editor has nothing to compare
        // a later stat against and would re-read every tab blindly (or never).
        assert!(text.mtime_ms.is_some());
        assert_eq!(text.mtime_ms, img.mtime_ms);
        assert_eq!(text.mtime_ms, stat_files(&[f.to_string_lossy().into_owned()])[0].mtime_ms);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn stat_files_reports_size_and_missing_paths_without_failing_the_batch() {
        let d = fresh_dir();
        let there = d.join("there.txt");
        write_file(there.to_str().unwrap(), "12345").unwrap();
        let gone = d.join("gone.txt");
        let stats = stat_files(&[
            there.to_string_lossy().into_owned(),
            gone.to_string_lossy().into_owned(),
        ]);
        assert_eq!(stats.len(), 2);
        assert!(stats[0].exists);
        assert_eq!(stats[0].size, 5);
        // A missing path must not fail the batch — the other tabs still get an answer.
        assert!(!stats[1].exists);
        assert_eq!(stats[1].mtime_ms, None);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn stat_files_sees_a_rewrite() {
        let d = fresh_dir();
        let f = d.join("rewritten.txt");
        write_file(f.to_str().unwrap(), "short").unwrap();
        let before = stat_files(&[f.to_string_lossy().into_owned()]).remove(0);
        write_file(f.to_str().unwrap(), "a much longer body").unwrap();
        let after = stat_files(&[f.to_string_lossy().into_owned()]).remove(0);
        // Size alone catches this one; mtime is the second signal for a same-size
        // rewrite (its resolution is filesystem-dependent, so it isn't asserted here).
        assert_ne!(before.size, after.size);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn ignored_dirs_are_filtered() {
        assert!(is_ignored(Path::new("/repo/node_modules/x/y.js")));
        assert!(is_ignored(Path::new("/repo/.git/HEAD")));
        assert!(!is_ignored(Path::new("/repo/src/main.rs")));
    }

    #[test]
    fn create_file_makes_an_empty_file_and_refuses_to_clobber() {
        let d = fresh_dir();
        let f = d.join("new.txt");
        create_file(f.to_str().unwrap()).unwrap();
        assert!(f.is_file());
        assert_eq!(fs::read_to_string(&f).unwrap(), "");
        // A second create on the same name must fail, not overwrite.
        assert!(create_file(f.to_str().unwrap()).is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn create_dir_makes_a_dir_and_refuses_to_clobber() {
        let d = fresh_dir();
        let sub = d.join("pkg");
        create_dir(sub.to_str().unwrap()).unwrap();
        assert!(sub.is_dir());
        assert!(create_dir(sub.to_str().unwrap()).is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rename_moves_and_refuses_to_clobber() {
        let d = fresh_dir();
        let a = d.join("a.txt");
        let b = d.join("b.txt");
        write_file(a.to_str().unwrap(), "x").unwrap();
        rename(a.to_str().unwrap(), b.to_str().unwrap()).unwrap();
        assert!(!a.exists() && b.is_file());
        // Renaming onto an existing name must fail (no silent replace).
        let c = d.join("c.txt");
        write_file(c.to_str().unwrap(), "y").unwrap();
        assert!(rename(c.to_str().unwrap(), b.to_str().unwrap()).is_err());
        assert_eq!(fs::read_to_string(&b).unwrap(), "x"); // b untouched
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn copy_path_copies_file_and_tree() {
        let d = fresh_dir();
        // File copy.
        let a = d.join("a.txt");
        write_file(a.to_str().unwrap(), "hello").unwrap();
        let a2 = d.join("a copy.txt");
        copy_path(a.to_str().unwrap(), a2.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&a2).unwrap(), "hello");
        assert!(a.is_file()); // source kept (copy, not move)

        // Recursive directory copy.
        let src = d.join("src");
        fs::create_dir(&src).unwrap();
        write_file(src.join("inner.txt").to_str().unwrap(), "deep").unwrap();
        fs::create_dir(src.join("nested")).unwrap();
        write_file(src.join("nested/leaf.txt").to_str().unwrap(), "leaf").unwrap();
        let dst = d.join("src copy");
        copy_path(src.to_str().unwrap(), dst.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(dst.join("inner.txt")).unwrap(), "deep");
        assert_eq!(fs::read_to_string(dst.join("nested/leaf.txt")).unwrap(), "leaf");

        // Refuses to clobber an existing destination.
        assert!(copy_path(a.to_str().unwrap(), a2.to_str().unwrap()).is_err());
        fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn copy_path_preserves_symlinks_without_following_them() {
        let d = fresh_dir();
        // A directory containing a symlink to ANOTHER directory — the case a naive
        // copy (follow + recurse) would error on or loop over.
        let target = d.join("target");
        fs::create_dir(&target).unwrap();
        write_file(target.join("t.txt").to_str().unwrap(), "t").unwrap();
        let src = d.join("src");
        fs::create_dir(&src).unwrap();
        std::os::unix::fs::symlink(&target, src.join("link")).unwrap();
        write_file(src.join("real.txt").to_str().unwrap(), "r").unwrap();

        let dst = d.join("src copy");
        copy_path(src.to_str().unwrap(), dst.to_str().unwrap()).unwrap();

        // Regular file copied; the link is recreated AS a link (not its contents).
        assert_eq!(fs::read_to_string(dst.join("real.txt")).unwrap(), "r");
        let link_meta = fs::symlink_metadata(dst.join("link")).unwrap();
        assert!(link_meta.file_type().is_symlink());
        assert_eq!(fs::read_link(dst.join("link")).unwrap(), target);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rename_allows_same_entry_but_still_blocks_a_real_clobber() {
        let d = fresh_dir();
        let a = d.join("a.txt");
        write_file(a.to_str().unwrap(), "x").unwrap();
        // Renaming a path onto itself (same entry) is allowed — this is the shape
        // of a case-only rename on a case-insensitive volume.
        rename(a.to_str().unwrap(), a.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "x");
        // A real clobber of a DIFFERENT existing file is still refused.
        let b = d.join("b.txt");
        write_file(b.to_str().unwrap(), "y").unwrap();
        assert!(rename(a.to_str().unwrap(), b.to_str().unwrap()).is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}
