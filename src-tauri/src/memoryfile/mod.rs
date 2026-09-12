//! The user's global instructions file (`~/.claude/CLAUDE.md`) — read whole, written only
//! between our own markers.
//!
//! This file is the user's, and most of it is hand-written prose that Claude reads on every
//! session. So the app claims exactly one region of it, fenced by HTML comments (invisible
//! when the Markdown is rendered, inert to Claude beyond their content):
//!
//! ```text
//! <!-- flightdeck:managed:start -->
//! …whatever the app was asked to write…
//! <!-- flightdeck:managed:end -->
//! ```
//!
//! Everything outside those two lines is copied byte for byte. A file whose markers are
//! damaged (an opener with no closer, a closer before its opener) is REFUSED rather than
//! repaired — guessing where a managed region ends is how you eat someone's prose.
//!
//! The app deliberately does not own the block's CONTENT: the front end composes it from
//! the instruction library it shows the user, and hands the finished text here. This module
//! only knows how to splice.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

pub const MANAGED_START: &str = "<!-- flightdeck:managed:start -->";
pub const MANAGED_END: &str = "<!-- flightdeck:managed:end -->";

/// What the instructions file looks like right now.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ManagedMemory {
    /// Absolute path, shown in the UI so "where does this go" is never a mystery.
    pub path: String,
    pub exists: bool,
    /// The text currently inside the managed markers; `None` when the app has never
    /// written to this file.
    pub managed_text: Option<String>,
    /// The whole file, so the panel can show a read-only preview without a second read.
    pub full_text: Option<String>,
    /// Set when the markers are present but malformed — the UI must then offer a manual
    /// fix, never a write.
    pub marker_error: Option<String>,
}

/// Read `~/.claude/CLAUDE.md`.
pub fn read_managed() -> Result<ManagedMemory, String> {
    let path = memory_path().ok_or("could not resolve the home directory")?;
    read_managed_at(&path)
}

/// Testable core of [`read_managed`].
pub fn read_managed_at(path: &Path) -> Result<ManagedMemory, String> {
    let mut out = ManagedMemory { path: path.to_string_lossy().into_owned(), ..Default::default() };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("unable to read {}: {e}", path.display())),
    };
    out.exists = true;
    match managed_region(&text) {
        Ok(Some((start, end))) => out.managed_text = Some(text[start..end].to_string()),
        Ok(None) => {}
        Err(e) => out.marker_error = Some(e),
    }
    out.full_text = Some(text);
    Ok(out)
}

/// Write `text` into the managed region, creating the file and the region as needed.
/// `None` removes the region entirely.
pub fn write_managed(text: Option<&str>) -> Result<(), String> {
    let path = memory_path().ok_or("could not resolve the home directory")?;
    write_managed_at(&path, text)
}

/// Testable core of [`write_managed`].
pub fn write_managed_at(path: &Path, text: Option<&str>) -> Result<(), String> {
    let current = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("unable to read {}: {e}", path.display())),
    };
    let updated = splice_managed(&current, text)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("unable to create {}: {e}", parent.display()))?;
    }
    write_atomic(path, updated.as_bytes())
}

/// Byte range of the managed region's CONTENT (between the marker lines), or `None` when
/// the file has no managed region. `Err` when the markers are present but unusable.
fn managed_region(text: &str) -> Result<Option<(usize, usize)>, String> {
    let start = text.find(MANAGED_START);
    let end = text.find(MANAGED_END);
    match (start, end) {
        (None, None) => Ok(None),
        (Some(_), None) => Err(format!(
            "found `{MANAGED_START}` with no matching `{MANAGED_END}` — refusing to guess where the managed block ends"
        )),
        (None, Some(_)) => Err(format!(
            "found `{MANAGED_END}` with no matching `{MANAGED_START}` — refusing to guess where the managed block begins"
        )),
        (Some(s), Some(e)) if e < s => Err(
            "the managed block's end marker comes before its start marker — refusing to write"
                .to_string(),
        ),
        (Some(s), Some(e)) => {
            // Content runs from just after the opener's line break to the start of the
            // closer's line.
            let after_open = s + MANAGED_START.len();
            let content_start = match text[after_open..].find('\n') {
                Some(i) => after_open + i + 1,
                None => after_open,
            };
            Ok(Some((content_start.min(e), e)))
        }
    }
}

/// Replace (or create, or remove) the managed region. Pure — the whole point is that this
/// can be tested exhaustively without touching anyone's real instructions file.
pub fn splice_managed(current: &str, text: Option<&str>) -> Result<String, String> {
    let region = managed_region(current)?;
    match (region, text) {
        // Update in place: everything outside the two markers is copied verbatim.
        (Some((content_start, content_end)), Some(new_text)) => {
            let mut out = String::with_capacity(current.len() + new_text.len());
            out.push_str(&current[..content_start]);
            out.push_str(new_text.trim_end());
            out.push('\n');
            out.push_str(&current[content_end..]);
            Ok(out)
        }
        // Remove: take the marker lines with the content, then heal the seam.
        (Some((_, content_end)), None) => {
            let start = current.find(MANAGED_START).expect("region matched");
            let end_line_end = match current[content_end..].find('\n') {
                Some(i) => content_end + i + 1,
                None => current.len(),
            };
            let mut head = &current[..start];
            let tail = &current[end_line_end..];
            // Undo exactly the separator the create path adds: a block that sat at the end
            // of the file was preceded by one blank line that only existed to hold it.
            // Trimming it here is what makes add-then-remove a true round trip; anywhere
            // else in the file the seam is left alone.
            if tail.trim().is_empty() && head.ends_with("\n\n") {
                head = &head[..head.len() - 1];
            }
            let mut out = String::with_capacity(current.len());
            out.push_str(head);
            out.push_str(tail);
            Ok(collapse_blank_run(&out))
        }
        // Create: append at the end, after a blank line, leaving the existing text alone.
        (None, Some(new_text)) => {
            let mut out = String::with_capacity(current.len() + new_text.len() + 128);
            out.push_str(current);
            if !current.is_empty() {
                if !current.ends_with('\n') {
                    out.push('\n');
                }
                if !current.ends_with("\n\n") {
                    out.push('\n');
                }
            }
            out.push_str(MANAGED_START);
            out.push('\n');
            out.push_str(new_text.trim_end());
            out.push('\n');
            out.push_str(MANAGED_END);
            out.push('\n');
            Ok(out)
        }
        // Nothing to remove: leave the file exactly as it is.
        (None, None) => Ok(current.to_string()),
    }
}

/// Squeeze a run of three or more newlines down to two, so removing the block does not
/// leave a growing hole where it used to be.
fn collapse_blank_run(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut newlines = 0;
    for ch in s.chars() {
        if ch == '\n' {
            newlines += 1;
            if newlines > 2 {
                continue;
            }
        } else {
            newlines = 0;
        }
        out.push(ch);
    }
    out
}

fn memory_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .map(|home| home.join(".claude/CLAUDE.md"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("md.tosse-tmp.{}.{n}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("writing temporary file: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("atomic replacement of {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HAND: &str = "# My instructions\n\nAlways write tests.\n";

    #[test]
    fn creating_the_block_appends_and_leaves_the_prose_untouched() {
        let out = splice_managed(HAND, Some("## Routing\n\nCheap work goes cheap.")).unwrap();
        assert!(out.starts_with(HAND), "hand-written text stays at the top, byte for byte");
        assert!(out.contains(MANAGED_START) && out.contains(MANAGED_END));
        assert!(out.contains("Cheap work goes cheap."));
    }

    #[test]
    fn updating_the_block_touches_only_what_is_between_the_markers() {
        let first = splice_managed(HAND, Some("one")).unwrap();
        let second = splice_managed(&first, Some("two")).unwrap();
        assert!(second.starts_with(HAND));
        assert!(second.contains("two"));
        assert!(!second.contains("one"));
        // Exactly one managed region, still.
        assert_eq!(second.matches(MANAGED_START).count(), 1);
        assert_eq!(second.matches(MANAGED_END).count(), 1);
    }

    #[test]
    fn prose_after_the_block_survives_an_update() {
        let src = format!("{HAND}\n{MANAGED_START}\nold\n{MANAGED_END}\n\n## Notes\n\nkeep me\n");
        let out = splice_managed(&src, Some("new")).unwrap();
        assert!(out.contains("new"));
        assert!(!out.contains("old"));
        assert!(out.ends_with("## Notes\n\nkeep me\n"), "prose below the block is preserved");
        assert!(out.starts_with(HAND));
    }

    #[test]
    fn removing_the_block_takes_its_markers_and_heals_the_gap() {
        let src = format!("{HAND}\n{MANAGED_START}\nold\n{MANAGED_END}\n\n## Notes\n");
        let out = splice_managed(&src, None).unwrap();
        assert!(!out.contains(MANAGED_START));
        assert!(!out.contains(MANAGED_END));
        assert!(!out.contains("old"));
        assert!(out.contains("Always write tests."));
        assert!(out.contains("## Notes"));
        assert!(!out.contains("\n\n\n"), "no growing hole where the block used to be");
    }

    #[test]
    fn removing_when_there_is_nothing_to_remove_is_the_identity() {
        assert_eq!(splice_managed(HAND, None).unwrap(), HAND);
    }

    #[test]
    fn add_then_remove_is_a_true_round_trip() {
        for original in [HAND, "", "a\n\n\n", "# t\n\ntext\n"] {
            let with = splice_managed(original, Some("policy")).unwrap();
            let without = splice_managed(&with, None).unwrap();
            assert_eq!(
                without,
                collapse_blank_run(original),
                "add-then-remove must leave no trace (input {original:?})"
            );
        }
    }

    #[test]
    fn the_one_thing_a_round_trip_changes_is_a_missing_final_newline() {
        // Documented exception: writing the block terminates the last line of a file that
        // had none, and removing it does not take that newline back. Adding a trailing
        // newline to a text file is a repair, not a loss — but it IS a difference, so it
        // is pinned here rather than left to be discovered.
        let with = splice_managed("no newline", Some("policy")).unwrap();
        assert_eq!(splice_managed(&with, None).unwrap(), "no newline\n");
    }

    #[test]
    fn an_unclosed_marker_is_refused_not_repaired() {
        let src = format!("{HAND}\n{MANAGED_START}\nhalf a block\n");
        let err = splice_managed(&src, Some("x")).unwrap_err();
        assert!(err.contains("no matching"));
    }

    #[test]
    fn an_orphan_end_marker_is_refused() {
        let src = format!("{HAND}\n{MANAGED_END}\n");
        assert!(splice_managed(&src, Some("x")).unwrap_err().contains("no matching"));
    }

    #[test]
    fn markers_in_the_wrong_order_are_refused() {
        let src = format!("{MANAGED_END}\nstuff\n{MANAGED_START}\n");
        assert!(splice_managed(&src, Some("x")).unwrap_err().contains("before its start"));
    }

    #[test]
    fn creating_in_an_empty_file_does_not_start_with_blank_lines() {
        let out = splice_managed("", Some("hello")).unwrap();
        assert_eq!(out, format!("{MANAGED_START}\nhello\n{MANAGED_END}\n"));
    }

    #[test]
    fn a_file_with_no_trailing_newline_still_gets_a_clean_block() {
        let out = splice_managed("no newline", Some("hi")).unwrap();
        assert_eq!(out, format!("no newline\n\n{MANAGED_START}\nhi\n{MANAGED_END}\n"));
    }

    #[test]
    fn reading_reports_the_managed_text_and_the_whole_file() {
        let dir = std::env::temp_dir().join(format!("tosse-mem-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("CLAUDE.md");
        std::fs::write(&path, splice_managed(HAND, Some("policy here")).unwrap()).unwrap();
        let read = read_managed_at(&path).unwrap();
        assert!(read.exists);
        assert_eq!(read.managed_text.as_deref(), Some("policy here\n"));
        assert!(read.full_text.unwrap().contains("Always write tests."));
        assert_eq!(read.marker_error, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_an_absent_file_is_not_an_error() {
        let read = read_managed_at(Path::new("/nonexistent/CLAUDE.md")).unwrap();
        assert!(!read.exists);
        assert_eq!(read.managed_text, None);
    }

    #[test]
    fn reading_surfaces_a_marker_error_instead_of_pretending_there_is_no_block() {
        let dir = std::env::temp_dir().join(format!("tosse-mem-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("CLAUDE.md");
        std::fs::write(&path, format!("{HAND}\n{MANAGED_START}\ndangling\n")).unwrap();
        let read = read_managed_at(&path).unwrap();
        assert!(read.marker_error.is_some());
        assert_eq!(read.managed_text, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_then_remove_returns_the_file_to_its_original_bytes() {
        let dir = std::env::temp_dir().join(format!("tosse-mem-rt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("CLAUDE.md");
        std::fs::write(&path, HAND).unwrap();
        write_managed_at(&path, Some("## Routing\n\nsomething")).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("## Routing"));
        write_managed_at(&path, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            HAND,
            "adding then removing must leave no trace"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
