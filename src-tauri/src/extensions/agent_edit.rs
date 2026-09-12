//! Editing a sub-agent definition (`agents/*.md`) WITHOUT touching its system prompt.
//!
//! An agent file is `---` frontmatter followed by a body, and that body IS the agent's
//! system prompt — usually hand-written. So the contract here is narrow and absolute:
//!
//! > rewrite only the frontmatter keys we own (`model`, `effort`), preserve every other
//! > key, its order, its formatting, and **every byte after the closing `---`**.
//!
//! That is what makes an "overwrite" safe: changing a dropdown can never eat prose. The
//! dangerous operation is CREATING a file that shadows a built-in agent (which replaces
//! the whole agent, prompt included) — that lives behind [`create_agent_file`], which
//! demands the body from the caller rather than inventing one.
//!
//! Line endings, a leading BOM, and unknown keys all survive a round trip; the tests
//! below pin each of those, because "preserved to the byte" is the sort of promise that
//! rots silently.

use std::path::Path;

/// A frontmatter edit: set a key to a value, or remove it when `None`.
pub type Edit<'a> = (&'a str, Option<String>);

/// Rewrite the leading frontmatter block of `content`, applying `edits`.
///
/// Errors — never a partial or guessed write — when the document has no frontmatter, or
/// has an opening `---` with no closing one. A file we cannot parse confidently is a file
/// we refuse to touch.
pub fn edit_frontmatter(content: &str, edits: &[Edit]) -> Result<String, String> {
    let (bom, rest) = match content.strip_prefix('\u{feff}') {
        Some(r) => ("\u{feff}", r),
        None => ("", content),
    };

    let lines = split_keeping_terminators(rest);
    let first = lines.first().ok_or("this file is empty")?;
    if first.text.trim() != "---" {
        return Err("this file has no frontmatter block".to_string());
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, l)| l.text.trim() == "---")
        .map(|(i, _)| i)
        .ok_or("this file's frontmatter block is never closed")?;

    // The dominant line ending inside the block — so an inserted key matches the file it
    // lands in rather than mixing CRLF and LF.
    let eol = if lines[..=close].iter().any(|l| l.terminator == "\r\n") { "\r\n" } else { "\n" };

    let mut body: Vec<String> = Vec::new();
    let mut handled: Vec<&str> = Vec::new();
    let mut i = 1;
    while i < close {
        let line = &lines[i];
        match top_level_key(line.text) {
            Some((key, rest_of_line)) if edits.iter().any(|(k, _)| *k == key) => {
                let (_, value) = edits.iter().find(|(k, _)| *k == key).expect("just matched");
                handled.push(key);
                // A block scalar owns the indented lines that follow it; replacing the key
                // without dropping them would strand orphan text at the top level.
                let block_scalar = matches!(rest_of_line, "|" | ">" | "|-" | ">-");
                i += 1;
                if block_scalar {
                    while i < close {
                        let next = lines[i].text;
                        if !next.trim().is_empty()
                            && !next.starts_with(' ')
                            && !next.starts_with('\t')
                        {
                            break;
                        }
                        i += 1;
                    }
                }
                if let Some(v) = value {
                    body.push(format!("{key}: {}", quote_if_needed(v)));
                }
            }
            _ => {
                body.push(line.text.to_string());
                i += 1;
            }
        }
    }

    // Keys the file did not have yet go at the end of the block, in the order asked for.
    for (key, value) in edits {
        if handled.contains(key) {
            continue;
        }
        if let Some(v) = value {
            body.push(format!("{key}: {}", quote_if_needed(v)));
        }
    }

    // The tail — the closing `---`, its terminator, and the entire system prompt — is
    // copied verbatim from the original bytes. Nothing here reformats it.
    let tail_start = lines[close].start;
    let mut out = String::with_capacity(content.len() + 64);
    out.push_str(bom);
    out.push_str(first.text);
    out.push_str(eol);
    for line in &body {
        out.push_str(line);
        out.push_str(eol);
    }
    out.push_str(&rest[tail_start..]);
    Ok(out)
}

/// Apply frontmatter edits to a file on disk, atomically. Returns the bytes written.
pub fn write_agent_frontmatter(path: &Path, edits: &[Edit]) -> Result<(), String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("unable to read {}: {e}", path.display()))?;
    let updated = edit_frontmatter(&content, edits)?;
    write_atomic(path, updated.as_bytes())
}

/// Create a NEW agent definition. `body` is the agent's system prompt and is required:
/// naming a file after a built-in replaces that agent ENTIRELY, so this refuses to invent
/// the instructions the replacement will run on.
///
/// Refuses to clobber an existing file — replacing a definition goes through
/// [`write_agent_frontmatter`], which keeps the body.
pub fn create_agent_file(
    path: &Path,
    name: &str,
    description: &str,
    model: Option<&str>,
    effort: Option<&str>,
    body: &str,
) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("an agent definition needs instructions — its body is its system prompt".into());
    }
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("unable to create {}: {e}", parent.display()))?;
    }
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", quote_if_needed(name)));
    if !description.trim().is_empty() {
        out.push_str(&format!("description: {}\n", quote_if_needed(description)));
    }
    if let Some(m) = model {
        out.push_str(&format!("model: {}\n", quote_if_needed(m)));
    }
    if let Some(e) = effort {
        out.push_str(&format!("effort: {}\n", quote_if_needed(e)));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_end());
    out.push('\n');
    write_atomic(path, out.as_bytes())
}

/// Atomic replace for a markdown file. Sibling of `extensions::write_atomic`, which names
/// its temp `.json` and reports "settings.json" in its error — wrong on both counts here.
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

/// One source line plus the terminator that followed it, and its byte offset.
struct Line<'a> {
    text: &'a str,
    terminator: &'a str,
    start: usize,
}

/// Split into lines while remembering each terminator and offset, so the untouched tail
/// can be copied by byte range instead of re-joined (which would normalise line endings
/// and a missing final newline).
fn split_keeping_terminators(s: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let (text_end, term) =
                if i > start && bytes[i - 1] == b'\r' { (i - 1, "\r\n") } else { (i, "\n") };
            out.push(Line { text: &s[start..text_end], terminator: term, start });
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < s.len() {
        out.push(Line { text: &s[start..], terminator: "", start });
    }
    out
}

/// `key: value` at the top level (no indent, key is `[A-Za-z0-9_-]+`). Mirrors the reader's
/// `top_level_key` so writes and reads agree on what a key is.
fn top_level_key(line: &str) -> Option<(&str, &str)> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let (key, rest) = line.split_once(':')?;
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some((key, rest.trim()))
}

/// Quote a scalar only when YAML would otherwise misread it. Model names and effort levels
/// (`haiku`, `claude-opus-4-8`, `low`) never need it, so the common case stays readable.
fn quote_if_needed(value: &str) -> String {
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ' '))
        && !value.starts_with(' ')
        && !value.ends_with(' ');
    if plain {
        value.to_string()
    } else {
        format!("{:?}", value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: Explore\ndescription: Read-only search agent.\nmodel: haiku\neffort: low\ntools: Bash, Read, Glob\n---\n\nYou are a read-only search agent.\n\n## How to work\n\n- Sweep broadly first.\n";

    #[test]
    fn replaces_a_key_and_leaves_the_body_byte_identical() {
        let out = edit_frontmatter(SAMPLE, &[("model", Some("claude-opus-4-8".into()))]).unwrap();
        assert!(out.contains("model: claude-opus-4-8"));
        assert!(!out.contains("model: haiku"));
        // Everything from the closing marker on is untouched.
        let body = "---\n\nYou are a read-only search agent.\n\n## How to work\n\n- Sweep broadly first.\n";
        assert!(out.ends_with(body), "the system prompt must survive to the byte");
        // Unrelated keys keep their text and their order.
        let keys: Vec<&str> = out.lines().skip(1).take_while(|l| *l != "---").collect();
        assert_eq!(
            keys,
            vec![
                "name: Explore",
                "description: Read-only search agent.",
                "model: claude-opus-4-8",
                "effort: low",
                "tools: Bash, Read, Glob",
            ],
            "every other key keeps its text and its position"
        );
    }

    #[test]
    fn adds_a_key_that_was_absent() {
        let src = "---\nname: Helper\n---\nbody\n";
        let out = edit_frontmatter(src, &[("effort", Some("high".into()))]).unwrap();
        assert_eq!(out, "---\nname: Helper\neffort: high\n---\nbody\n");
    }

    #[test]
    fn removes_a_key_when_the_value_is_none() {
        let out = edit_frontmatter(SAMPLE, &[("effort", None)]).unwrap();
        assert!(!out.contains("effort:"));
        assert!(out.contains("model: haiku"), "other keys are untouched");
    }

    #[test]
    fn preserves_crlf_line_endings() {
        let src = "---\r\nname: Helper\r\nmodel: opus\r\n---\r\nbody line\r\n";
        let out = edit_frontmatter(src, &[("model", Some("haiku".into()))]).unwrap();
        assert_eq!(out, "---\r\nname: Helper\r\nmodel: haiku\r\n---\r\nbody line\r\n");
    }

    #[test]
    fn preserves_a_leading_bom() {
        let src = "\u{feff}---\nname: Helper\nmodel: opus\n---\nbody\n";
        let out = edit_frontmatter(src, &[("model", Some("haiku".into()))]).unwrap();
        assert!(out.starts_with('\u{feff}'));
        assert!(out.contains("model: haiku"));
    }

    #[test]
    fn preserves_a_body_with_no_trailing_newline() {
        let src = "---\nmodel: opus\n---\nno trailing newline";
        let out = edit_frontmatter(src, &[("model", Some("haiku".into()))]).unwrap();
        assert!(out.ends_with("---\nno trailing newline"));
    }

    #[test]
    fn preserves_a_body_that_contains_a_horizontal_rule() {
        // A `---` in the PROSE must not be mistaken for the frontmatter's closing marker;
        // the closing one is the first after the opener, and the rest is tail.
        let src = "---\nmodel: opus\n---\nintro\n\n---\n\nmore prose\n";
        let out = edit_frontmatter(src, &[("model", Some("haiku".into()))]).unwrap();
        assert_eq!(out, "---\nmodel: haiku\n---\nintro\n\n---\n\nmore prose\n");
    }

    #[test]
    fn replacing_a_block_scalar_key_drops_its_continuation_lines() {
        let src = "---\ndescription: |\n  line one\n  line two\nmodel: opus\n---\nbody\n";
        let out = edit_frontmatter(src, &[("description", Some("short".into()))]).unwrap();
        assert_eq!(out, "---\ndescription: short\nmodel: opus\n---\nbody\n");
    }

    #[test]
    fn refuses_a_file_without_frontmatter() {
        let err = edit_frontmatter("# just markdown\n", &[("model", Some("haiku".into()))]);
        assert!(err.unwrap_err().contains("no frontmatter"));
    }

    #[test]
    fn refuses_an_unclosed_frontmatter_block() {
        let err = edit_frontmatter("---\nname: X\nbody with no close\n", &[("model", None)]);
        assert!(err.unwrap_err().contains("never closed"));
    }

    #[test]
    fn quotes_only_what_yaml_would_misread() {
        assert_eq!(quote_if_needed("haiku"), "haiku");
        assert_eq!(quote_if_needed("claude-opus-4-8"), "claude-opus-4-8");
        assert_eq!(quote_if_needed("a: b"), "\"a: b\"");
        assert_eq!(quote_if_needed(""), "\"\"");
    }

    #[test]
    fn round_trip_with_no_matching_edit_is_the_identity() {
        let out = edit_frontmatter(SAMPLE, &[("nosuchkey", None)]).unwrap();
        assert_eq!(out, SAMPLE, "a no-op edit must not reformat the file");
    }

    #[test]
    fn create_refuses_an_empty_body() {
        let dir = std::env::temp_dir().join(format!("tosse-agent-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("Empty.md");
        let err = create_agent_file(&path, "Empty", "d", Some("haiku"), None, "   ");
        assert!(err.unwrap_err().contains("system prompt"));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_writes_a_readable_definition_and_refuses_to_clobber() {
        let dir = std::env::temp_dir().join(format!("tosse-agent-mk-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("Planner.md");
        create_agent_file(&path, "Plan", "Designs a plan.", Some("haiku"), Some("low"), "Do the thing.")
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "---\nname: Plan\ndescription: Designs a plan.\nmodel: haiku\neffort: low\n---\n\nDo the thing.\n"
        );
        // A second create must not overwrite the prompt someone may have since edited.
        let again = create_agent_file(&path, "Plan", "d", None, None, "other");
        assert!(again.unwrap_err().contains("already exists"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Round-trip every real agent definition on this machine, on a COPY, and assert the
    /// system prompt comes back byte-identical. Ignored by default (machine-dependent);
    /// run with `cargo test --lib -- --ignored --nocapture`. This is the test that would
    /// catch a writer that reformats someone's hand-written prompt.
    #[test]
    #[ignore]
    fn live_round_trip_preserves_every_real_agent_body() {
        let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return };
        let dir = home.join(".claude/agents");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            println!("no {} — nothing to check", dir.display());
            return;
        };
        let mut checked = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let original = std::fs::read_to_string(&path).unwrap();
            let body_of = |s: &str| -> String {
                // Everything from the closing marker on.
                let after_open = s.find("---").map(|i| i + 3).unwrap_or(0);
                let close = s[after_open..].find("\n---").map(|i| after_open + i).unwrap_or(0);
                s[close..].to_string()
            };
            let edited =
                edit_frontmatter(&original, &[("model", Some("sonnet".into()))]).unwrap();
            assert_eq!(
                body_of(&original),
                body_of(&edited),
                "{} — the system prompt must survive to the byte",
                path.display()
            );
            assert!(edited.contains("model: sonnet"));
            // And back again: only the one key differs from where we started.
            let restored = edit_frontmatter(
                &edited,
                &[("model", Some(parse_model(&original).unwrap_or_else(|| "haiku".into())))],
            )
            .unwrap();
            assert_eq!(restored, original, "{} — round trip is not the identity", path.display());
            println!("round-tripped {} ({} bytes)", path.display(), original.len());
            checked += 1;
        }
        println!("{checked} agent definition(s) round-tripped intact");
    }

    /// Pull `model:` out of a document, for the round-trip assertion above.
    fn parse_model(content: &str) -> Option<String> {
        content
            .lines()
            .skip(1)
            .take_while(|l| l.trim() != "---")
            .find_map(|l| top_level_key(l).filter(|(k, _)| *k == "model").map(|(_, v)| v.to_string()))
    }

    #[test]
    fn write_agent_frontmatter_edits_a_real_file_in_place() {
        let dir = std::env::temp_dir().join(format!("tosse-agent-rt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("Explore.md");
        std::fs::write(&path, SAMPLE).unwrap();
        write_agent_frontmatter(&path, &[("model", Some("sonnet".into())), ("effort", None)])
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("model: sonnet"));
        assert!(!text.contains("effort:"));
        assert!(text.ends_with("- Sweep broadly first.\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
