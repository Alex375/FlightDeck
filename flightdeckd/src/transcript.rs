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

/// Cap on how deep the `subagents/` tree is searched for a sidecar: enough for
/// `subagents/workflows/wf_<id>/agent-<id>.meta.json` (depth 3) with margin,
/// never an unbounded walk (the Mac's `subagents.rs` uses the same bound).
const MAX_SUBAGENT_DEPTH: usize = 4;

/// An id that is safe to interpolate into a path: ASCII alphanumerics, `-` and
/// `_`, 1..=128 bytes. Ids come from claude's own output, but a reader that
/// turns them into paths stays the gatekeeper (`../x`, `a/b` are refused).
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The `tool_use` id of the `Agent` call that LAUNCHED sub-agent `agent_id`,
/// read from the sidecar claude writes beside its transcript:
/// `<config>/projects/<slug>/<session_id>/subagents/**/agent-<agent_id>.meta.json`
/// (`{"agentType","description","toolUseId",…}`). claude reads that same field
/// back when a `SendMessage` wakes the agent and streams the woken run under
/// it, so it is the key that ties a wake — even one seen by a LATER claude
/// process — to its launch. Every `session_ids` candidate is probed (the live
/// session, then the one it resumed from), across every project slug (a cwd
/// moved mid-run splits a session's artifacts across slugs).
///
/// `Ok(None)` = no sidecar, or one without an id (a workflow agent's carries
/// none). `Err` = a sidecar exists but cannot be read or parsed — a real
/// failure the caller logs, never silently equated with "absent".
pub fn launch_tool_use_id(
    config_dir: &Path,
    session_ids: &[&str],
    agent_id: &str,
) -> Result<Option<String>, String> {
    if !is_safe_id(agent_id) {
        return Err(format!("refusing unsafe agent id {agent_id:?}"));
    }
    let file_name = format!("agent-{agent_id}.meta.json");
    let projects = config_dir.join("projects");
    let Ok(slugs) = std::fs::read_dir(&projects) else { return Ok(None) };
    let slugs: Vec<PathBuf> = slugs.flatten().map(|e| e.path()).collect();
    for sid in session_ids.iter().filter(|s| is_safe_id(s)) {
        for slug in &slugs {
            let Some(path) = find_file(&slug.join(sid).join("subagents"), &file_name, MAX_SUBAGENT_DEPTH) else {
                continue;
            };
            let meta = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()))
                .map_err(|e| format!("cannot read sub-agent metadata {}: {e}", path.display()))?;
            return Ok(meta
                .get("toolUseId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(String::from));
        }
    }
    Ok(None)
}

/// Depth-bounded search for a regular file named `name` under `dir` (symlinked
/// directories are not followed).
fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let direct = dir.join(name);
    if std::fs::symlink_metadata(&direct).map(|m| m.is_file()).unwrap_or(false) {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(found) = find_file(&e.path(), name, depth - 1) {
                return Some(found);
            }
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
    fn the_launch_of_a_sub_agent_is_read_from_its_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path();
        let sub = config.join("projects/-work-demo/sid-old/subagents");
        std::fs::create_dir_all(sub.join("workflows/wf_1")).unwrap();
        std::fs::write(
            sub.join("agent-a68e.meta.json"),
            r#"{"agentType":"general-purpose","description":"d","toolUseId":"toolu_agent"}"#,
        )
        .unwrap();
        std::fs::write(sub.join("workflows/wf_1/agent-wfa.meta.json"), r#"{"agentType":"workflow-subagent"}"#).unwrap();
        std::fs::write(sub.join("agent-bad.meta.json"), "{not json").unwrap();
        // a later slug of the same session (cwd moved) without the file
        std::fs::create_dir_all(config.join("projects/-work-demo-wt/sid-new/subagents")).unwrap();

        // found under the session it resumed from
        assert_eq!(
            launch_tool_use_id(config, &["sid-new", "sid-old"], "a68e").unwrap().as_deref(),
            Some("toolu_agent")
        );
        // a workflow agent's sidecar carries no launch id
        assert_eq!(launch_tool_use_id(config, &["sid-old"], "wfa").unwrap(), None);
        // absent
        assert_eq!(launch_tool_use_id(config, &["sid-new"], "a68e").unwrap(), None);
        assert_eq!(launch_tool_use_id(&config.join("nowhere"), &["sid-old"], "a68e").unwrap(), None);
        // present but unreadable: an error, not "absent"
        assert!(launch_tool_use_id(config, &["sid-old"], "bad").unwrap_err().contains("cannot read sub-agent metadata"));
        // ids that could walk out of the tree are refused
        assert!(launch_tool_use_id(config, &["sid-old"], "../x").is_err());
        assert_eq!(launch_tool_use_id(config, &["../sid-old"], "a68e").unwrap(), None);
        for bad in ["", "a/b", "../x", &"x".repeat(129)] {
            assert!(!is_safe_id(bad), "{bad:?}");
        }
        assert!(is_safe_id("a68e26aa615c9f436") && is_safe_id("wf_1-x"));
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
