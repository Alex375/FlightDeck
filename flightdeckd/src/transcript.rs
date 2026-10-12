//! Read claude's on-disk transcripts (`~/.claude/projects/*/<session_id>.jsonl`)
//! and digest them into the phone protocol's `turns: [{role, text}]` — the same
//! plain-text serialization the Mac app produces (tosse-code
//! `src/agent/appControl.ts` serializeEntry): tool calls collapse to
//! `[tool: Name]` lines, thinking is dropped, images become `[image]`, each
//! turn is clipped to 4000 chars, sidechains and meta lines are excluded.

use serde_json::Value;
use std::path::{Path, PathBuf};

const TURN_CLIP: usize = 4000;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Turn {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct Transcript {
    pub turns: Vec<Turn>,
    pub title: Option<String>,
}

/// `$CLAUDE_CONFIG_DIR` else `~/.claude` (same resolution as the CLI + Mac app).
pub fn claude_config_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude")
}

/// Longest session id accepted (claude's are 36-char UUIDs).
const SESSION_ID_MAX: usize = 128;

/// Whether `id` can be a claude session id: `[A-Za-z0-9_-]`, bounded. Anything
/// else — a path separator, a dot, a NUL — is refused before it can become
/// part of a filesystem path.
pub fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= SESSION_ID_MAX
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Locate `<config>/projects/*/<session_id>.jsonl`. The cwd→slug encoding is
/// lossy, so scan every project dir (same approach as tosse-code history.rs).
pub fn find_transcript(session_id: &str) -> Option<PathBuf> {
    find_transcript_in(&claude_config_dir().join("projects"), session_id)
}

fn find_transcript_in(projects: &Path, session_id: &str) -> Option<PathBuf> {
    if !is_valid_session_id(session_id) {
        return None;
    }
    let entries = std::fs::read_dir(projects).ok()?;
    let file = format!("{session_id}.jsonl");
    for e in entries.flatten() {
        let candidate = e.path().join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn load(session_id: &str) -> Transcript {
    match find_transcript(session_id) {
        Some(p) => parse_file(&p),
        None => Transcript::default(),
    }
}

pub fn parse_file(path: &Path) -> Transcript {
    match std::fs::read_to_string(path) {
        Ok(raw) => parse_str(&raw),
        Err(_) => Transcript::default(),
    }
}

pub fn parse_str(raw: &str) -> Transcript {
    let mut out = Transcript::default();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                    out.title = Some(t.to_string());
                }
            }
            Some("user") => {
                if v.get("isMeta").and_then(Value::as_bool).unwrap_or(false)
                    || v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false)
                {
                    continue;
                }
                if let Some(text) = user_text(v.get("message")) {
                    push_turn(&mut out.turns, "user", text);
                }
            }
            Some("assistant") => {
                if v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                if let Some(text) = assistant_text(v.get("message")) {
                    push_turn(&mut out.turns, "assistant", text);
                }
            }
            _ => {}
        }
    }
    out
}

fn push_turn(turns: &mut Vec<Turn>, role: &str, text: String) {
    if text.trim().is_empty() {
        return;
    }
    turns.push(Turn { role: role.into(), text: clip(&text) });
}

fn clip(s: &str) -> String {
    if s.chars().count() <= TURN_CLIP {
        s.to_string()
    } else {
        let clipped: String = s.chars().take(TURN_CLIP).collect();
        format!("{clipped}…")
    }
}

/// A user entry's visible text. Entries whose content is only tool_result
/// blocks are plumbing, not a user turn.
fn user_text(message: Option<&Value>) -> Option<String> {
    let content = message?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let blocks = content.as_array()?;
    let mut parts: Vec<String> = Vec::new();
    for b in blocks {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    parts.push(t.to_string());
                }
            }
            Some("image") => parts.push("[image]".into()),
            _ => {}
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn assistant_text(message: Option<&Value>) -> Option<String> {
    let blocks = message?.get("content")?.as_array()?;
    let mut parts: Vec<String> = Vec::new();
    for b in blocks {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    if !t.trim().is_empty() {
                        parts.push(t.to_string());
                    }
                }
            }
            Some("tool_use") => {
                let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                parts.push(format!("[tool: {name}]"));
            }
            _ => {} // thinking dropped
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = concat!(
        r#"{"type":"ai-title","aiTitle":"Hostname check","sessionId":"s1"}"#, "\n",
        r#"{"type":"queue-operation","operation":"enqueue"}"#, "\n",
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Run hostname"}]}}"#, "\n",
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"tool_use","name":"Bash","input":{}}]}}"#, "\n",
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"flightdeck-m0"}]}}"#, "\n",
        r#"{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"injected"}]}}"#, "\n",
        r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"side"}]}}"#, "\n",
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"It is flightdeck-m0."}]}}"#, "\n",
        r#"{"type":"last-prompt","lastPrompt":"Run hostname"}"#, "\n",
    );

    #[test]
    fn parses_turns_like_the_mac_app() {
        let t = parse_str(SAMPLE);
        assert_eq!(t.title.as_deref(), Some("Hostname check"));
        let turns: Vec<(&str, &str)> = t.turns.iter().map(|x| (x.role.as_str(), x.text.as_str())).collect();
        assert_eq!(
            turns,
            vec![
                ("user", "Run hostname"),
                ("assistant", "[tool: Bash]"),
                ("assistant", "It is flightdeck-m0."),
            ]
        );
    }

    #[test]
    fn session_ids_are_checked_before_touching_the_filesystem() {
        for ok in ["9b2c1e9e-3f7a-4c39-b0b3-6f1d0a2d4e11", "sid-e2e", "s_1", &"a".repeat(SESSION_ID_MAX)] {
            assert!(is_valid_session_id(ok), "{ok}");
        }
        for bad in [
            "", ".", "..", "../x", "a/b", "/etc/passwd", "a\\b", "a.b", "a b", "a\0b", "é", &"a".repeat(SESSION_ID_MAX + 1),
        ] {
            assert!(!is_valid_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn find_transcript_never_leaves_the_project_dirs() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        std::fs::create_dir_all(projects.join("-work")).unwrap();
        std::fs::write(projects.join("-work/sid-1.jsonl"), SAMPLE).unwrap();
        // A transcript-shaped file OUTSIDE the project dirs, one level up.
        std::fs::write(root.path().join("secret.jsonl"), SAMPLE).unwrap();
        assert_eq!(find_transcript_in(&projects, "sid-1"), Some(projects.join("-work/sid-1.jsonl")));
        assert_eq!(find_transcript_in(&projects, "../../secret"), None);
        assert_eq!(find_transcript_in(&projects, "../secret"), None);
        assert_eq!(find_transcript_in(&projects, "missing"), None);
    }

    #[test]
    fn string_content_and_clip() {
        let raw = format!(
            "{}\n",
            serde_json::json!({"type":"user","message":{"role":"user","content":"x".repeat(5000)}})
        );
        let t = parse_str(&raw);
        assert_eq!(t.turns.len(), 1);
        assert!(t.turns[0].text.chars().count() <= TURN_CLIP + 1);
        assert!(t.turns[0].text.ends_with('…'));
    }
}
