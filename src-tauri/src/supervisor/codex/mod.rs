//! The **Codex backend** — piloting OpenAI's `codex` CLI via its `app-server`
//! (JSON-RPC newline-delimited over stdio), the sibling of the Claude backend that
//! lives directly under `supervisor/`. Everything Codex-specific (binary
//! resolution, the app-server transport, the protocol wire types, the
//! per-conversation session) lives here, so the shared session contract
//! (`SessionHandle` / `SessionCommand` / `SessionEvent`) stays backend-neutral and
//! the front consumes ONE normalized event model regardless of backend.
//!
//! This is the socle: it establishes the module and the binary detection the
//! backend selector gates on. The transport, protocol types, and the session actor
//! that maps app-server messages to `SessionEvent`s land in the following subtasks.

pub mod accounts;
mod config;
pub mod extensions;
mod history;
pub mod protocol;
mod server;
mod session;
mod transport;

pub use accounts::{CodexAccountStatus, CodexLoginStart};
pub use config::list_extensions;
pub use extensions::{CodexHooksSnapshot, CodexPluginsLive};
pub use history::{
    build_codex_search_index, list_codex_disk_conversations, load_thread_history, load_thread_usage,
};
pub use protocol::{CodexControls, CodexForkResult, CodexModel, CodexServiceTier, CodexSkill};
pub use server::{CodexError, CodexServer};
pub use session::spawn_session;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// List the Codex models the installed binary offers (`model/list`), flattened for the
/// composer's picker. Runs against a transient app-server (no thread needed). Hidden
/// models are dropped. Empty vec if the server answers with none.
pub async fn list_models() -> Result<Vec<CodexModel>, CodexError> {
    let value = CodexServer::oneshot("model/list", json!({}), &std::env::temp_dir()).await?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(data.iter().filter_map(parse_model).collect())
}

fn parse_model(m: &Value) -> Option<CodexModel> {
    if m.get("hidden").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let id = m.get("id").and_then(Value::as_str)?.to_string();
    let display_name = m
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let efforts = m
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get("reasoningEffort").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    // Service tiers (`serviceTiers`): each `{id, name, description}`. A tier missing an id is
    // skipped rather than half-built; name/description default to empty (the front hides an
    // empty-labelled option). The deprecated `additionalSpeedTiers` (bare strings) is ignored.
    let service_tiers = m
        .get("serviceTiers")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some(CodexServiceTier {
                        id: t.get("id").and_then(Value::as_str)?.to_string(),
                        name: t.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                        description: t
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(CodexModel {
        id,
        display_name,
        efforts,
        default_effort: m
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string),
        service_tiers,
        default_service_tier: m
            .get("defaultServiceTier")
            .and_then(Value::as_str)
            .map(str::to_string),
        is_default: m.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// List the Codex skills for the given working directories (`skills/list`), flattened
/// and de-duplicated by name, for the composer's `/` menu. `cwds` empty → the server's
/// current working directory. Runs against a transient app-server.
pub async fn list_skills(cwds: Vec<String>) -> Result<Vec<CodexSkill>, CodexError> {
    let cwd = cwds
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let value = CodexServer::oneshot("skills/list", json!({ "cwds": cwds }), &cwd).await?;
    Ok(parse_skills(&value))
}

/// Flatten a `skills/list` response (`data[].skills[]` — one entry per cwd) into the
/// menu shape, de-duplicating by name (the same skill can be listed under several cwds).
fn parse_skills(value: &Value) -> Vec<CodexSkill> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in value.get("data").and_then(Value::as_array).into_iter().flatten() {
        let Some(skills) = entry.get("skills").and_then(Value::as_array) else {
            continue;
        };
        for s in skills {
            let Some(name) = s.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !seen.insert(name.to_string()) {
                continue;
            }
            out.push(CodexSkill {
                name: name.to_string(),
                description: s
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    out
}

/// Fork a Codex thread into a NEW thread (`thread/fork`), optionally cutting the branch at a
/// turn boundary via `last_turn_id`: the app-server forks THROUGH that turn, inclusive (turns
/// AFTER it are omitted), so a "fork here" / "rewind here" is a single call — no separate
/// rollback. `None` forks the whole thread. This replaces the count-based `thread/rollback`
/// path, DEPRECATED in codex-cli 0.144.1 ("will be removed soon"). Returns the new thread id +
/// resolved model for the front to materialize as a fresh Codex conversation (or to swap the
/// current conversation onto, for an in-place rewind). Non-destructive: the source thread is
/// untouched. Transient app-server, no live session needed. ⚠️ Like the Claude rewind, this
/// does NOT revert on-disk file changes the agent made — only the conversation history.
/// ⚠️ `last_turn_id` MUST reference a SETTLED turn (the wire rejects an in-progress one); the
/// front only offers the controls on non-busy turns.
pub async fn fork_thread(
    thread_id: &str,
    cwd: &Path,
    model: Option<&str>,
    last_turn_id: Option<&str>,
) -> Result<CodexForkResult, CodexError> {
    let value = CodexServer::oneshot(
        "thread/fork",
        json!({ "threadId": thread_id, "model": model, "lastTurnId": last_turn_id }),
        cwd,
    )
    .await?;
    let new_id = value
        .get("thread")
        .and_then(|t| t.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| CodexError::Rpc("thread/fork returned no thread id".into()))?
        .to_string();
    let model = value.get("model").and_then(Value::as_str).map(str::to_string);
    Ok(CodexForkResult { thread_id: new_id, model })
}

/// Archive a Codex thread (`thread/archive` — removes it from the active thread list
/// server-side). Used when a Codex conversation is discarded, the clean backend-native
/// counterpart to the Claude teardown leaving its transcript on disk. Transient app-server.
pub async fn archive_thread(thread_id: &str, cwd: &Path) -> Result<(), CodexError> {
    CodexServer::oneshot("thread/archive", json!({ "threadId": thread_id }), cwd)
        .await
        .map(|_| ())
}

/// Generate a short conversation title via a cheap one-shot Codex MODEL turn — Codex has no
/// free server-side title RPC (its `getConversationSummary.preview` is just the first user
/// message, not a summary), so we ask a small model directly on a `read-only` ephemeral
/// thread. Returns `None` on any failure (unavailable model / timeout / empty answer) so the
/// caller falls back to a truncation. `model` is a cheap id (e.g. `gpt-5.4-mini`); `None`
/// lets the server pick its default.
pub async fn generate_title(description: &str, model: Option<&str>, cwd: &Path) -> Option<String> {
    let prompt = format!(
        "Summarize the user's intent as a VERY short title (3 to 6 words), with no \
         trailing punctuation and no quotes. Reply ONLY with the title, nothing else.\n\n\
         {description}"
    );
    match CodexServer::run_ephemeral_turn(prompt, model, cwd).await {
        Ok(answer) => clean_model_title(&answer),
        Err(e) => {
            // Graceful degradation, NOT a silent error: the caller falls back to a truncation
            // so the conversation always gets a name. Logged for observability rather than
            // surfaced as a user-facing bubble (a title failure is not user-actionable).
            eprintln!("[codex-title] model title generation failed, falling back to truncation: {e}");
            None
        }
    }
}

/// Normalize a model-returned title: first non-empty line, strip wrapping quotes, then run it
/// through the truncation cleaner (drops a stray leading token, caps words/length, trims
/// trailing punctuation). `None` if nothing usable remains.
fn clean_model_title(raw: &str) -> Option<String> {
    let first = raw.lines().find(|l| !l.trim().is_empty())?.trim();
    let unquoted = first
        .trim_matches(|c| c == '"' || c == '\'' || c == '«' || c == '»' || c == '`')
        .trim();
    session::codex_title_from_description(unquoted)
}

/// A recognised image extension → its `media_type`, mirroring the front's `EXT_WIRE_MIME`
/// (`composerAttachments.ts`). Codex routed an item here BECAUSE it is an image, so an
/// unknown/absent extension still best-efforts to `image/png` rather than refusing to
/// render.
fn image_mime_from_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

/// Read an image the model viewed/produced and pack it into the
/// `{type:"image",source:{type:"base64",media_type,data}}` block the front's
/// `imageBlocksFromContent` (`ToolResultBody.tsx`) already renders — the SAME path a Claude
/// `Read` of a screenshot takes. Relative paths resolve against the session `cwd`. Reuses
/// the single fs service (`crate::fs::read_image`, 16 MiB guard). Returns the block on
/// success, or a human note on missing / too-large / unreadable — the caller decides
/// whether that becomes a text block or a plain-text result. Never panics, never a silent
/// blank.
pub(super) fn image_block(path: &str, cwd: Option<&str>) -> Result<Value, String> {
    let resolved: PathBuf = {
        let p = Path::new(path);
        match (p.is_absolute(), cwd) {
            (false, Some(base)) => Path::new(base).join(p),
            _ => p.to_path_buf(),
        }
    };
    let resolved = resolved.to_string_lossy();
    match crate::fs::read_image(&resolved) {
        Ok(img) if img.too_large => Err(format!("Image too large for preview ({} B)", img.size)),
        Ok(img) if img.data_base64.is_empty() => Err("Empty image".to_string()),
        Ok(img) => Ok(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image_mime_from_path(path),
                "data": img.data_base64,
            }
        })),
        Err(e) => Err(format!("Unreadable image ({e})")),
    }
}

/// The `content` of a synthesized `tool_result` for a viewed image: a one-block image
/// array on success, else a plain-text note (with the path). Shared by the live actor
/// (`session.rs`, `imageView`) and the cold rollout reader (`history.rs`, `view_image`).
pub(super) fn image_result_content(path: &str, cwd: Option<&str>) -> Value {
    match image_block(path, cwd) {
        Ok(block) => json!([block]),
        Err(note) => json!(format!("{note}: {path}")),
    }
}

/// Codex's home dir: `$CODEX_HOME` when set (a test build / non-default install), else
/// `~/.codex`; `None` when neither resolves. The SINGLE definition shared by the
/// rollout reader (`history.rs`) and the config snapshot (`config.rs`) so both always
/// describe the SAME Codex install — the never-read-`auth.json` invariant hangs off
/// this directory too.
pub(crate) fn codex_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME") {
        return Some(PathBuf::from(h));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex"))
}

/// The `codex` binary this app would spawn: `$TOSSE_CODEX_BIN` when set, else the
/// bare name `codex` (resolved on `PATH`). Kept deliberately parallel to the Claude
/// backend's `transport::default_claude_bin`, and to its `$TOSSE_*_BIN` override so
/// a test build can point at a specific binary without touching PATH.
pub fn default_codex_bin() -> PathBuf {
    std::env::var_os("TOSSE_CODEX_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("codex"))
}

/// A tiny `which`: does `bin` resolve to an existing file? A path with separators is
/// checked as-is; a bare program name is searched across `$PATH`.
fn resolves_on_path(bin: &Path) -> bool {
    if bin.components().count() > 1 {
        return bin.is_file();
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(bin).is_file())
}

/// Well-known install locations for the `codex` binary, in the SAME precedence a real
/// login-shell `PATH` would apply. Used ONLY as a fallback when a bare `codex` does not
/// resolve on `PATH` — e.g. a Finder-launched bundle whose login-shell PATH probe failed
/// (the same minimal-PATH trap the Claude backend guards against). `codex` ships via the
/// standalone installer (which drops it in `~/.local/bin`, refreshed by `codex update`)
/// or the npm package `@openai/codex` (symlinked into a homebrew/npm bin, often the
/// root-owned `/usr/local/bin`).
///
/// ⚠️ Order matters when TWO installs coexist (e.g. a stale npm-global `/usr/local/bin`
/// one alongside a freshly-updated `~/.local/bin` one): a real login PATH lists the
/// user-scoped dirs AHEAD of `/usr/local`, so this fallback must pick the SAME binary
/// PATH resolution would — user-home first, then homebrew, then `/usr/local` last.
/// Listing `/usr/local` first would silently prefer an OLDER shadowed install.
fn known_codex_locations() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        v.push(home.join(".local/bin/codex"));
        v.push(home.join(".volta/bin/codex"));
        v.push(home.join(".npm-global/bin/codex"));
    }
    v.push(PathBuf::from("/opt/homebrew/bin/codex"));
    v.push(PathBuf::from("/usr/local/bin/codex"));
    v
}

/// Resolve the `codex` binary path we would hand to `Command::new`: the configured
/// name if it resolves on `PATH`, else the first existing well-known location, else
/// the bare name unchanged (let the spawn surface the "not found" error). Mirrors the
/// Claude backend's `transport::resolve_bin`. Used by the app-server transport.
pub fn resolved_codex_bin() -> PathBuf {
    let bin = default_codex_bin();
    if resolves_on_path(&bin) {
        return bin;
    }
    if bin.as_os_str() == "codex" {
        if let Some(found) = known_codex_locations().into_iter().find(|p| p.is_file()) {
            return found;
        }
    }
    bin
}

/// Whether a usable `codex` binary is present on this machine. Gates the Codex
/// backend selector in the UI — there is no point offering "new Codex conversation"
/// when the CLI is not installed. Cheap: a `PATH` / well-known-location file check,
/// never a process spawn.
pub fn codex_available() -> bool {
    let bin = default_codex_bin();
    resolves_on_path(&bin)
        || (bin.as_os_str() == "codex" && known_codex_locations().iter().any(|p| p.is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_on_path_finds_real_binaries_and_rejects_fakes() {
        // `sh` exists on every unix PATH; a nonsense name must not resolve.
        assert!(resolves_on_path(Path::new("sh")), "sh should resolve on PATH");
        assert!(
            !resolves_on_path(Path::new("tosse-definitely-not-a-real-binary-xyz")),
            "a nonsense name must not resolve"
        );
    }

    #[test]
    fn resolves_on_path_checks_explicit_paths_as_files() {
        // A path WITH separators is taken literally (not searched on PATH).
        assert!(resolves_on_path(Path::new("/bin/sh")), "/bin/sh is a file");
        assert!(!resolves_on_path(Path::new("/nope/not/here")));
    }

    #[test]
    fn default_bin_is_codex_without_override() {
        // Without the env override the default is the bare name (resolved on PATH).
        // We don't assert the env var here (parallel tests share the process env);
        // the bare-name default is the branch that matters for detection.
        assert_eq!(default_codex_bin().as_os_str(), "codex");
    }

    #[test]
    fn parse_model_flattens_the_wire_shape_and_drops_hidden_models() {
        // Shape copied from a live `model/list` entry (the fields the picker consumes).
        let visible = json!({
            "id": "gpt-5.5",
            "displayName": "GPT-5.5",
            "hidden": false,
            "isDefault": true,
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [
                { "reasoningEffort": "low", "description": "fastest" },
                { "reasoningEffort": "medium", "description": "balanced" },
                { "reasoningEffort": "high", "description": "deeper" },
                { "reasoningEffort": "xhigh", "description": "deepest" }
            ],
            "defaultServiceTier": "default",
            "additionalSpeedTiers": ["priority"],
            "serviceTiers": [
                { "id": "default", "name": "Standard", "description": "" },
                { "id": "priority", "name": "Fast", "description": "1.5x speed, increased usage" }
            ]
        });
        let m = parse_model(&visible).expect("a visible model must parse");
        assert_eq!(m.id, "gpt-5.5");
        assert_eq!(m.display_name, "GPT-5.5");
        assert_eq!(m.efforts, vec!["low", "medium", "high", "xhigh"]);
        assert_eq!(m.default_effort.as_deref(), Some("medium"));
        assert!(m.is_default);
        // Service tiers flattened; default tier captured.
        assert_eq!(m.default_service_tier.as_deref(), Some("default"));
        assert_eq!(
            m.service_tiers.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["default", "priority"],
        );
        let fast = m.service_tiers.iter().find(|t| t.id == "priority").expect("priority tier");
        assert_eq!(fast.name, "Fast");
        assert_eq!(fast.description, "1.5x speed, increased usage");

        // A hidden model is dropped from the picker.
        assert!(parse_model(&json!({ "id": "gpt-internal", "hidden": true })).is_none());
        // No id → unusable → dropped (filter_map upstream).
        assert!(parse_model(&json!({ "displayName": "nameless" })).is_none());
        // Missing displayName falls back to the id; missing efforts/tiers → empty.
        let bare = parse_model(&json!({ "id": "gpt-5.4-mini" })).expect("bare model parses");
        assert_eq!(bare.display_name, "gpt-5.4-mini");
        assert!(bare.efforts.is_empty());
        assert!(bare.default_effort.is_none() && !bare.is_default);
        assert!(bare.service_tiers.is_empty() && bare.default_service_tier.is_none());
    }

    #[test]
    fn parse_skills_flattens_entries_and_dedups_by_name() {
        // Shape copied from a live `skills/list` response: one entry per cwd, each with
        // its own `skills` array; the same skill can appear under several cwds.
        let value = json!({ "data": [
            { "cwd": "/repo/a", "skills": [
                { "name": "review", "description": "Relit le diff" },
                { "name": "deploy" }
            ]},
            { "cwd": "/repo/b", "skills": [
                { "name": "review", "description": "duplicate — must be dropped" }
            ]},
            { "cwd": "/repo/c" }
        ]});
        let skills = parse_skills(&value);
        assert_eq!(
            skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["review", "deploy"],
        );
        assert_eq!(skills[0].description, "Relit le diff");
        assert_eq!(skills[1].description, "", "a missing description is empty, not dropped");
        // No data at all → empty catalogue, never an error.
        assert!(parse_skills(&json!({})).is_empty());
    }

    #[test]
    fn clean_model_title_strips_quotes_takes_first_line_and_caps() {
        // French guillemets + surrounding whitespace.
        assert_eq!(
            clean_model_title("« Export CSV des factures »").as_deref(),
            Some("Export CSV des factures")
        );
        // Plain quotes/backticks; the truncation cleaner trims the trailing period.
        assert_eq!(
            clean_model_title("\"Corrige le bug de login.\"").as_deref(),
            Some("Corrige le bug de login")
        );
        assert_eq!(clean_model_title("`titre`").as_deref(), Some("titre"));
        // A chatty multi-line answer: only the FIRST non-empty line is used.
        assert_eq!(
            clean_model_title("\n  \nRefonte de la sidebar\nExplication : blabla").as_deref(),
            Some("Refonte de la sidebar")
        );
        // Nothing usable → None (the caller falls back to a truncation).
        assert_eq!(clean_model_title(""), None);
        assert_eq!(clean_model_title("  \n \n"), None);
    }

    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth)"]
    async fn live_list_models_returns_a_default_model() {
        let models = list_models().await.expect("model/list should succeed");
        assert!(!models.is_empty(), "the binary should advertise at least one model");
        assert!(models.iter().any(|m| m.is_default), "exactly one model is the default");
        // Efforts are flattened from `supportedReasoningEfforts` (may be empty for some).
        eprintln!("codex models: {:?}", models.iter().map(|m| &m.id).collect::<Vec<_>>());
    }

    /// PROBE (not a regression test): does `remoteControl/status/read` (a safe, read-only
    /// method — it does NOT enable anything) answer with the CURRENT spawn (`codex
    /// app-server`, handshake `experimentalApi:true`)? If it returns a result → the whole
    /// `remoteControl/*` family is reachable with no extra CLI flag. If it returns a JSON-RPC
    /// "method not found" (-32601) → the server must be spawned with `--experimental`.
    /// Decides whether the Remote-control chantier needs a spawn change.
    /// Run: `cargo test --lib -- --ignored --nocapture live_probe_remote_control`.
    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth); probes remoteControl availability"]
    async fn live_probe_remote_control_availability() {
        let r = CodexServer::oneshot(
            "remoteControl/status/read",
            serde_json::Value::Null,
            &std::env::temp_dir(),
        )
        .await;
        match r {
            Ok(v) => eprintln!("REMOTE PROBE: status/read OK (available, NO --experimental needed) → {v}"),
            Err(e) => eprintln!("REMOTE PROBE: status/read FAILED → {e}"),
        }
    }

    /// PROBE (diagnostic, not a regression assertion): pokes the phase-4.3 native history ops
    /// against the real binary to confirm they're REACHABLE and to observe their preconditions.
    /// It starts a throwaway thread (no turns), then calls fork/archive on it. ⚠️ VERIFIED
    /// FINDING: a thread with no turns has NO on-disk ROLLOUT, and `thread/fork`/`rollback`
    /// load the thread FROM DISK by id → they answer `Rpc("no rollout found for thread id …")`.
    /// That is EXPECTED here and still proves the method is reachable (a "method not found"
    /// would be `-32601`). So this probe never asserts success — it prints each outcome and only
    /// flags a genuine "method not found". The real ops need a thread with persisted turns AND
    /// the (missing) thread-resume lifecycle; this is why the rewind/fork UI is gated off for
    /// Codex until that lands. Run: `cargo test --lib -- --ignored --nocapture live_probe_history_ops`.
    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth); diagnostic probe of the history-op wire"]
    async fn live_probe_history_ops() {
        let cwd = std::env::temp_dir();
        let started = CodexServer::oneshot(
            "thread/start",
            json!({ "cwd": cwd.to_string_lossy(), "sandbox": "workspace-write", "approvalPolicy": "on-request" }),
            &cwd,
        )
        .await;
        let thread_id = match &started {
            Ok(v) => v.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_string),
            Err(e) => {
                eprintln!("HISTORY PROBE: thread/start failed (auth/network?) → {e}");
                return;
            }
        };
        let Some(thread_id) = thread_id else {
            eprintln!("HISTORY PROBE: thread/start returned no thread id → {started:?}");
            return;
        };
        eprintln!("HISTORY PROBE: started thread {thread_id}");

        // "no rollout" / any Rpc error means the method DISPATCHED (reachable); only a JSON-RPC
        // -32601 would be a genuine "method not found". Generic over the ok type (fork vs archive).
        fn reaches<T>(r: &Result<T, CodexError>) -> String {
            match r {
                Ok(_) => "OK".to_string(),
                Err(CodexError::Rpc(m)) => {
                    assert!(
                        !m.contains("-32601") && !m.to_lowercase().contains("method not found"),
                        "method should be REACHABLE, got: {m}"
                    );
                    format!("reachable (Rpc: {m})")
                }
                Err(e) => format!("transport/other: {e}"),
            }
        }

        let fork = fork_thread(&thread_id, &cwd, None, None).await;
        eprintln!("HISTORY PROBE: thread/fork → {}", reaches(&fork));
        let archive = archive_thread(&thread_id, &cwd).await;
        eprintln!("HISTORY PROBE: thread/archive → {}", reaches(&archive));
        if let Ok(f) = fork {
            let _ = archive_thread(&f.thread_id, &cwd).await; // best-effort cleanup of any real fork
        }
    }

    /// PROBE: does the model-based auto-title work end to end against the real binary?
    /// Runs a cheap `read-only` ephemeral turn (gpt-5.4-mini) over a sample intent and prints
    /// the generated title. A `None` means the model call failed (the actor would then fall
    /// back to a truncation). Run: `cargo test --lib -- --ignored --nocapture live_generate_title`.
    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth + a tiny model turn)"]
    async fn live_generate_title() {
        let desc = "Ajoute un bouton d'export CSV sur la page des factures et écris les tests";
        let title = generate_title(desc, Some("gpt-5.4-mini"), &std::env::temp_dir()).await;
        eprintln!("TITLE PROBE → {title:?}");
        if let Some(t) = &title {
            assert!(!t.is_empty(), "a generated title must not be empty");
            assert!(t.chars().count() <= 48, "title should be capped: {t:?}");
        }
    }

    #[tokio::test]
    #[ignore = "spawns the real codex app-server (network + auth)"]
    async fn live_list_skills_flattens_and_dedups() {
        let skills = list_skills(vec!["/tmp".to_string()]).await.expect("skills/list should succeed");
        let names: Vec<_> = skills.iter().map(|s| s.name.clone()).collect();
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(names.len(), unique.len(), "names must be de-duplicated");
        eprintln!("codex skills: {names:?}");
    }
}
