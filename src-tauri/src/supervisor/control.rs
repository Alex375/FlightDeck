//! Control channel (subtask 2).
//!
//! The control channel multiplexes `control_request` / `control_response`
//! JSON-lines over the *same* stdio stream as the conversation (spec §4). It is
//! bidirectional:
//!   - **outbound** (we → CLI): `initialize`, `interrupt`, `set_permission_mode`,
//!     `set_model`, `apply_flag_settings` (effort + ultracode), `get_settings`.
//!   - **inbound** (CLI → we): `can_use_tool` (a permission prompt), plus other
//!     subtypes we do not support yet and answer with an error.
//!
//! This module owns the wire shapes and the (de)serialization. The correlation
//! tables and the decision policy live in [`super::session`].

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;

use super::model::{McpAuthResult, McpServerLive, RemoteControlState, SlashCommand};

/// Permission mode, switched at runtime via `set_permission_mode` (spec §4.5).
/// The wire tokens are exactly these camelCase strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    AcceptEdits,
    Auto,
    BypassPermissions,
    Default,
    DontAsk,
    Plan,
}

impl PermissionMode {
    /// The exact camelCase wire token (matches the serde rename). Infallible, so
    /// callers never fall back to an empty string on a serialisation hiccup.
    pub fn as_wire(self) -> &'static str {
        match self {
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Auto => "auto",
            PermissionMode::BypassPermissions => "bypassPermissions",
            PermissionMode::Default => "default",
            PermissionMode::DontAsk => "dontAsk",
            PermissionMode::Plan => "plan",
        }
    }
}

/// A UI decision for a `can_use_tool` prompt (the `answer_permission` command
/// input). Tagged on `behavior` to mirror the protocol's result shape.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "behavior", rename_all = "snake_case")]
pub enum PermissionDecision {
    /// Allow the tool. `updated_input` optionally rewrites the tool input;
    /// `None` echoes the original input unchanged.
    Allow { updated_input: Option<Value> },
    /// Deny the tool with a human-readable reason.
    Deny { message: String },
}

/// Typed inbound `control_request` bodies (the `request` object). Only the
/// subtypes we act on are modeled; everything else falls through to `Unknown`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum InboundControl {
    CanUseTool(CanUseToolReq),
    #[serde(other)]
    Unknown,
}

/// The `can_use_tool` permission request payload (spec §5.1, snake_case fields).
#[derive(Debug, Clone, Deserialize)]
pub struct CanUseToolReq {
    pub tool_name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub permission_suggestions: Value,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub tool_use_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub blocked_path: Option<String>,
    #[serde(default)]
    pub decision_reason: Value,
}

/// Parse an inbound `control_request` line (already deserialized to a [`Value`]
/// by the transport) into its `request_id` and the typed body.
///
/// Returns `None` only when there is no usable `request_id` (truly
/// unaddressable). The body is a `Result`: `Err` means the `request_id` was
/// fine but the `request` payload failed to type (e.g. a known subtype missing a
/// required field). The caller MUST still answer such a request with an error
/// `control_response` — otherwise the CLI hangs waiting on us. Note that
/// `#[serde(other)]` only catches unknown *subtype values*, never a typing error
/// inside a known variant, which is exactly why this distinction matters.
pub fn parse_inbound_control(v: &Value) -> Option<(String, Result<InboundControl, String>)> {
    let request_id = v.get("request_id")?.as_str()?.to_string();
    let request = v.get("request").cloned().unwrap_or(Value::Null);
    let body = serde_json::from_value::<InboundControl>(request).map_err(|e| e.to_string());
    Some((request_id, body))
}

/// Extract the slash-command list from a successful `initialize` control
/// response (spec §4.4). The list lives at `response.response.commands` and each
/// element is `{name, description, argumentHint}` (note the camelCase wire key).
/// Returns `None` for any non-`initialize`-shaped response so the caller can skip
/// it; missing per-command fields default to empty strings.
pub fn parse_initialize_commands(line: &Value) -> Option<Vec<SlashCommand>> {
    let arr = line
        .get("response")?
        .get("response")?
        .get("commands")?
        .as_array()?;
    Some(
        arr.iter()
            .filter_map(|c| {
                let name = c.get("name")?.as_str()?.to_string();
                let description = c
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let argument_hint = c
                    .get("argumentHint")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                Some(SlashCommand {
                    name,
                    description,
                    argument_hint,
                })
            })
            .collect(),
    )
}

/// A correlated outbound-request acknowledgement (`control_response`). `request_id`
/// echoes the request we sent; `ok` is true for `subtype:"success"`. On failure
/// `error` carries the CLI's message (a plain string, spec §4.1). We MUST read this
/// for our own requests (set_model / apply_flag_settings / set_permission_mode):
/// otherwise a rejection would be a silent failure.
pub struct ControlResponse {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Parse the outer envelope of any `control_response` into its correlation key and
/// success/error. Returns `None` when there is no nested `request_id` (so it can't
/// be matched to an outbound request).
pub fn parse_control_response(line: &Value) -> Option<ControlResponse> {
    let resp = line.get("response")?;
    let request_id = resp.get("request_id")?.as_str()?.to_string();
    let ok = resp.get("subtype").and_then(Value::as_str) == Some("success");
    let error = resp.get("error").and_then(Value::as_str).map(str::to_string);
    Some(ControlResponse { request_id, ok, error })
}

/// The live applied settings carried by a successful `get_settings` response
/// (`response.response.applied = {model, effort, ultracode}`). Each field is
/// optional — the CLI may omit one. This is the authoritative live read-back.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppliedSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub ultracode: Option<bool>,
}

/// Parse the `applied` block out of a `get_settings` control response. Returns
/// `None` when there is no `applied` object (e.g. a non-`get_settings` response).
pub fn parse_get_settings_applied(line: &Value) -> Option<AppliedSettings> {
    let applied = line.get("response")?.get("response")?.get("applied")?;
    Some(AppliedSettings {
        model: applied.get("model").and_then(Value::as_str).map(str::to_string),
        effort: applied.get("effort").and_then(Value::as_str).map(str::to_string),
        ultracode: applied.get("ultracode").and_then(Value::as_bool),
    })
}

/// The effective mode echoed by a successful `set_permission_mode` ack
/// (`response.response.mode`). The CLI confirms the mode it ACTUALLY applied, which
/// can differ from what we asked (e.g. `bypassPermissions` downgraded to `default`
/// without `--allow-dangerously-skip-permissions`). `None` if absent.
pub fn parse_set_permission_mode_ack(line: &Value) -> Option<String> {
    line.get("response")?
        .get("response")?
        .get("mode")?
        .as_str()
        .map(str::to_string)
}

/// Wrap a `request` body into a full `control_request` envelope (spec §4.1).
fn control_request(request_id: &str, request: Value) -> Value {
    json!({ "request_id": request_id, "type": "control_request", "request": request })
}

/// `initialize` — sent fire-and-forget at session start (spec §4.4). Minimal
/// body; we advertise no hooks / MCP servers / dialogs yet.
pub fn initialize_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "initialize" }))
}

/// `interrupt` — stop the current turn without killing the process (spec §2.4).
pub fn interrupt_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "interrupt" }))
}

/// `stop_task` — stop ONE background task (a `run_in_background` Bash / Monitor /
/// sub-agent) by its `task_id`, without touching the rest of the session. The task
/// then transitions to `stopped` via the normal `task_*` lifecycle (a
/// `task_updated`/`task_notification` we ingest as usual). Cross-checked against the
/// official VS Code extension SDK transport (`stopTask(id) → request({subtype:
/// "stop_task", task_id})`) — the wire subtype is `stop_task` (NOT `task_stop`),
/// verified verbatim in `extension.js` of the installed extension (2.1.179 & 2.1.181).
pub fn stop_task_request(request_id: &str, task_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "stop_task", "task_id": task_id }))
}

/// `set_permission_mode` — switch the permission mode mid-session (spec §4.5).
pub fn set_permission_mode_request(request_id: &str, mode: PermissionMode) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "set_permission_mode", "mode": mode }),
    )
}

/// `set_model` — switch the active model mid-session (spec §4.5, sibling of
/// `set_permission_mode`). `model` is a CLI model id/alias passed verbatim
/// (e.g. "opus", "sonnet", "haiku", "default"). Cross-checked against the
/// official extension SDK transport (`{subtype:"set_model", model}`).
pub fn set_model_request(request_id: &str, model: &str) -> Value {
    control_request(request_id, json!({ "subtype": "set_model", "model": model }))
}

/// The reasoning-effort levels the CLI's `apply_flag_settings{effortLevel}` runtime
/// control accepts. Verified against the binary (2.1.187, `gD =
/// ["low","medium","high","xhigh","max"]`) AND live: spawning Opus 4.8 / Sonnet 4.6,
/// sending `apply_flag_settings{effortLevel:"max"}`, then `get_settings`, reads back
/// `effort:"max"` — while a bogus value (`"banana"`) is silently swallowed. So a
/// `success` ack still does NOT prove a value was applied; this list is the coarse
/// "known wire value" guard and the read-back via [`get_settings_request`] is the
/// authority. HISTORY: up to 2.1.186 `"max"` was a `--effort` SPAWN-flag alias only
/// and the runtime control swallowed it; 2.1.187 promoted it to a real runtime level
/// (top tier, above `xhigh` — xhigh is "just below maximum"). WHICH levels a model
/// accepts is per-model (e.g. legacy Sonnet 4.6 took `max` but NOT `xhigh`); that gating is
/// the front-end gauge's job ([`effortLevelsForModel`] in `EffortGauge.tsx`), not
/// this list. `"ultracode"` is still a SEPARATE boolean flag (see
/// [`set_ultracode_request`]), never an effort value.
pub const VALID_EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Whether `level` is a valid runtime `effortLevel` (see [`VALID_EFFORT_LEVELS`]).
pub fn is_valid_effort_level(level: &str) -> bool {
    VALID_EFFORT_LEVELS.contains(&level)
}

/// `apply_flag_settings` — push a session flag/setting change. Used here to set the
/// reasoning effort level (one of [`VALID_EFFORT_LEVELS`]). Mirrors the extension
/// SDK (`{subtype:"apply_flag_settings", settings:{effortLevel}}`). Callers MUST
/// validate `level` first ([`is_valid_effort_level`]): the CLI swallows an invalid
/// value silently, so an unvalidated send would no-op without any error.
pub fn set_effort_level_request(request_id: &str, level: &str) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": level } }),
    )
}

/// `apply_flag_settings` toggling the **ultracode** flag (xhigh effort + standing
/// dynamic-workflow orchestration). The CLI models this as a SEPARATE boolean flag,
/// not an `effortLevel` value: enabling sends `{ultracode:true}` (the caller first
/// sets `effortLevel:"xhigh"`); disabling sends `{ultracode:null}` — `null` deletes
/// the key, which is exactly how the extension turns it off (NOT `false`). Requires
/// an xhigh-capable model with workflows enabled. Verified live against the binary.
pub fn set_ultracode_request(request_id: &str, on: bool) -> Value {
    let value = if on { Value::Bool(true) } else { Value::Null };
    control_request(
        request_id,
        json!({ "subtype": "apply_flag_settings", "settings": { "ultracode": value } }),
    )
}

/// `get_settings` — query the session's live applied settings. The response carries
/// `response.response.applied = {model, effort, ultracode}` — the ONLY reliable live
/// source of the effort level (it is absent from `system/init`) and the
/// authoritative read-back after any change, since the CLI silently coerces invalid
/// values. Verified live against the binary.
pub fn get_settings_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "get_settings" }))
}

/// A brevity instruction appended to the description we hand the binary. The
/// `generate_session_title` control request exposes NO length/format knob — it only
/// takes `description` + `persist`, and the binary's internal model tends to return
/// titles a touch too long for our sidebar. Since the binary titles by *summarizing*
/// `description`, the only lever is the description itself: we append a short
/// meta-instruction steering it shorter. We pin the language to the user's text so the
/// English hint can't flip a French conversation's title to English, and ask for the
/// title only so the hint isn't echoed verbatim. (Validated live against the real
/// binary — see `live_generate_session_title_returns_a_title`.)
const TITLE_BREVITY_HINT: &str = "\n\n[Title guidance: write a very short title — at \
    most 5 words — in the same language as the text above. Output only the title, no \
    quotes, no trailing punctuation.]";

/// `generate_session_title` — ask the binary to derive a short, human title for the
/// conversation from `description` (the user's accumulated messages so far — the
/// caller may regenerate from a growing description as the session evolves). The
/// title is produced by a model call INSIDE the `claude` binary (so it rides the Max
/// subscription, no separate API key). Mirrors the official VS Code extension's SDK
/// call (`{subtype:"generate_session_title", description, persist}`), with one
/// addition: we append [`TITLE_BREVITY_HINT`] to the description to nudge the binary
/// toward shorter titles (it has no native length knob). `persist:false` — Tosse
/// persists the name in its OWN store, so we never ask the binary to write an
/// `ai-title` entry into its transcript. The title comes back at
/// `response.response.title` (see [`parse_generate_session_title`]).
pub fn generate_session_title_request(request_id: &str, description: &str) -> Value {
    control_request(
        request_id,
        json!({
            "subtype": "generate_session_title",
            "description": format!("{description}{TITLE_BREVITY_HINT}"),
            "persist": false,
        }),
    )
}

/// A brevity instruction for the LAST-MESSAGE summary — the Flight Deck shows it as a
/// glance-able "what did I last ask this agent" line, so it must be even terser than a
/// title (≤ 6 words). Same lever as [`TITLE_BREVITY_HINT`]: the wire exposes no length
/// knob, so we steer via the description. We pin the output language to the message and
/// ask for the summary only, so the hint isn't echoed.
const SUMMARY_BREVITY_HINT: &str = "\n\n[Summarize the message above in at most 6 words, \
    in the same language as the text. Output only the summary — no quotes, no trailing \
    punctuation, no prefix.]";

/// Summarize the user's LAST message in a few words — a distinct routing over the SAME
/// `generate_session_title` wire (its internal model rides the Max subscription, no
/// separate API key). Unlike [`generate_session_title_request`], `text` is a SINGLE
/// message (not the accumulated intent), and we append [`SUMMARY_BREVITY_HINT`] for a
/// ≤6-word result. `persist:false` — the summary is Flight-Deck-only UI state, never
/// written to the transcript. The summary comes back at `response.response.title` (same
/// shape as the title — reuse [`parse_generate_session_title`]).
pub fn generate_summary_request(request_id: &str, text: &str) -> Value {
    control_request(
        request_id,
        json!({
            "subtype": "generate_session_title",
            "description": format!("{text}{SUMMARY_BREVITY_HINT}"),
            "persist": false,
        }),
    )
}

/// Parse the generated title out of a `generate_session_title` control response. The
/// title lives at `response.response.title` (the same doubly-nested shape as
/// `get_settings`/`initialize`). Returns `None` when absent or empty — the caller
/// then keeps the optimistic placeholder rather than blanking the conversation name.
pub fn parse_generate_session_title(line: &Value) -> Option<String> {
    let title = line
        .get("response")?
        .get("response")?
        .get("title")?
        .as_str()?
        .trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// `reload_plugins` — hot-reload this session's plugins after a `claude plugin …`
/// mutation (install / enable / disable / update), so a RUNNING conversation picks up
/// the change without a restart. Mirrors the official VS Code extension's
/// `sdk_reload_plugins` (`request({subtype:"reload_plugins"})`) — the one plugin
/// message on the control channel (all other plugin ops are CLI shell-outs). The CLI
/// otherwise prints "restart required"; this is the extension-blessed hot-apply.
/// Fire-and-correlate: the bare-success ack is a no-op (the freshened plugins arrive
/// via the stream / next turn); a rejection surfaces as a control error.
pub fn reload_plugins_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "reload_plugins" }))
}

/// `mcp_status` — query the LIVE connection status of every MCP server the
/// session knows. This is what the official extension's `Query.mcpServerStatus()`
/// sends; the response carries the real per-server status (connected / needs-auth
/// / failed / …), unlike the point-in-time `system/init.mcp_servers` snapshot.
/// (Subtype inferred from the minified extension bundle — verified live against
/// the binary before being relied upon.)
pub fn mcp_status_request(request_id: &str) -> Value {
    control_request(request_id, json!({ "subtype": "mcp_status" }))
}

/// Drop a URL's query string and fragment — they can carry an auth token. Mirrors
/// the on-disk scanner's redaction (`extensions::strip_url_query`); duplicated here
/// (2 lines) to keep `supervisor` independent of `extensions`.
fn strip_url_query(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).to_string()
}

/// Parse an `mcp_status` control response into the live server list. The array
/// lives at `response.response.mcpServers` (doubly nested, like initialize's
/// commands — verified live against the binary). Each entry carries `name`,
/// `status`, `scope`, a `config` object (transport/command/url), and a `tools`
/// array when connected. Secrets in `config` (args/env/headers) are NOT surfaced.
pub fn parse_mcp_status(line: &Value) -> Vec<McpServerLive> {
    let Some(arr) = line
        .get("response")
        .and_then(|r| r.get("response"))
        .and_then(|r| r.get("mcpServers"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|s| {
            let name = s.get("name").and_then(Value::as_str)?.to_string();
            let status = s
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let scope = s.get("scope").and_then(Value::as_str).map(str::to_string);
            let config = s.get("config");
            let field = |k: &str| {
                config
                    .and_then(|c| c.get(k))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            };
            let tools: Vec<String> = s
                .get("tools")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            Some(McpServerLive {
                name,
                status,
                scope,
                transport: field("type"),
                command: field("command"),
                // Strip the query/fragment — it can carry an auth token. Upholds the
                // same "no secret crosses the IPC boundary" invariant the on-disk
                // scanner enforces (extensions::mcp_info), on the LIVE path too.
                url: field("url").as_deref().map(strip_url_query),
                tool_count: tools.len() as u32,
                tools,
                // Claude's live MCP status has no structured startup-failure reason.
                failure_reason: None,
            })
        })
        .collect()
}

/// `mcp_toggle` — enable/disable ONE MCP server live in the session (the binary
/// connects/disconnects it). Cross-checked against the official extension SDK
/// transport (`toggleMcpServer(name,enabled) → {subtype:"mcp_toggle",serverName,
/// enabled}`). The visible effect arrives via the next `mcp_status` poll.
pub fn mcp_toggle_request(request_id: &str, server_name: &str, enabled: bool) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "mcp_toggle", "serverName": server_name, "enabled": enabled }),
    )
}

/// `mcp_reconnect` — ask the session to reconnect ONE MCP server (after a failure,
/// or once auth has been granted). Extension SDK: `reconnectMcpServer(name) →
/// {subtype:"mcp_reconnect",serverName}`.
pub fn mcp_reconnect_request(request_id: &str, server_name: &str) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "mcp_reconnect", "serverName": server_name }),
    )
}

/// `mcp_authenticate` — start the OAuth flow for an http/sse server. We omit
/// `redirectUri` (the extension's UI path calls it with the server name only), so
/// the CLI uses its own loopback redirect and completes the callback itself in the
/// common case. The reply carries `authUrl` (open it in the browser) and
/// `requiresUserAction`. Extension SDK: `{subtype:"mcp_authenticate",serverName,
/// redirectUri?}` → `.response`.
pub fn mcp_authenticate_request(request_id: &str, server_name: &str) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "mcp_authenticate", "serverName": server_name }),
    )
}

/// `mcp_clear_auth` — forget the stored OAuth credentials for ONE server (so the
/// next connect re-authenticates). Extension SDK: `mcpClearAuth(name) →
/// {subtype:"mcp_clear_auth",serverName}`.
pub fn mcp_clear_auth_request(request_id: &str, server_name: &str) -> Value {
    control_request(
        request_id,
        json!({ "subtype": "mcp_clear_auth", "serverName": server_name }),
    )
}

/// Parse an `mcp_authenticate` control response into [`McpAuthResult`]. The payload
/// is doubly nested (`response.response`, like `mcp_status`); the binary returns
/// `{authUrl?, requiresUserAction?}`. `err` is the routed control-response error (a
/// rejection — auth unsupported / unknown server) surfaced to the UI, not as a
/// fatal session error.
pub fn parse_mcp_authenticate(line: &Value, err: Option<&str>) -> McpAuthResult {
    let payload = line.get("response").and_then(|r| r.get("response"));
    McpAuthResult {
        auth_url: payload
            .and_then(|p| p.get("authUrl"))
            .and_then(Value::as_str)
            .map(str::to_string),
        requires_user_action: payload
            .and_then(|p| p.get("requiresUserAction"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error: err.map(str::to_string),
    }
}

/// Build a `remote_control` control request — enable/disable this session's Remote
/// Control bridge (the native `/remote-control`), mirroring the official VS Code
/// extension SDK transport (`enableRemoteControl(enabled, name?) → request({subtype:
/// "remote_control", enabled, name?})`). The optional `name` labels the session on
/// claude.ai/code. On success the binary answers with a `session_url` (parsed by
/// [`parse_remote_control`]); disabling returns no URL.
pub fn remote_control_request(request_id: &str, enabled: bool, name: Option<&str>) -> Value {
    let mut request = json!({ "subtype": "remote_control", "enabled": enabled });
    if let Some(n) = name {
        request["name"] = json!(n);
    }
    control_request(request_id, request)
}

/// Parse a `remote_control` control response into a [`RemoteControlState`]. Like
/// `mcp_status`/`mcp_authenticate`, the payload is doubly nested (`response.response`)
/// and carries `{session_url, connect_url}` when enabling. `enabled` is the direction
/// we asked for; `err` is a routed control-response rejection (surfaced to the UI, not
/// a fatal session error). A wire success with no `session_url` is treated as an error
/// so the UI never shows "connected" without a link to actually control the session.
pub fn parse_remote_control(line: &Value, enabled: bool, err: Option<&str>) -> RemoteControlState {
    if let Some(e) = err {
        return RemoteControlState {
            status: "error".to_string(),
            error: Some(e.to_string()),
            ..RemoteControlState::default()
        };
    }
    if !enabled {
        return RemoteControlState {
            status: "disconnected".to_string(),
            ..RemoteControlState::default()
        };
    }
    let session_url = line
        .get("response")
        .and_then(|r| r.get("response"))
        .and_then(|p| p.get("session_url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    match session_url {
        Some(url) => RemoteControlState {
            status: "connected".to_string(),
            session_url: Some(url),
            ..RemoteControlState::default()
        },
        None => RemoteControlState {
            status: "error".to_string(),
            error: Some("The bridge did not return a session URL.".to_string()),
            ..RemoteControlState::default()
        },
    }
}

/// A successful `control_response` carrying a permission ALLOW result (spec §5.2).
/// Note the doubly-nested `response.response` and the camelCase result fields.
pub fn permission_allow_response(request_id: &str, tool_use_id: &str, updated_input: Value) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": "allow",
                "updatedInput": updated_input,
                "toolUseID": tool_use_id,
            }
        }
    })
}

/// A successful `control_response` carrying a permission DENY result (spec §5.2).
pub fn permission_deny_response(request_id: &str, tool_use_id: &str, message: &str) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": "deny",
                "message": message,
                "toolUseID": tool_use_id,
            }
        }
    })
}

/// An error `control_response` for an inbound request we cannot satisfy (spec
/// §4.1: `error` is a string). Used for unsupported inbound control subtypes so
/// the CLI does not hang waiting on us.
pub fn control_error_response(request_id: &str, error: &str) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mode_serializes_to_exact_wire_tokens() {
        assert_eq!(serde_json::to_value(PermissionMode::AcceptEdits).unwrap(), json!("acceptEdits"));
        assert_eq!(serde_json::to_value(PermissionMode::BypassPermissions).unwrap(), json!("bypassPermissions"));
        assert_eq!(serde_json::to_value(PermissionMode::DontAsk).unwrap(), json!("dontAsk"));
        assert_eq!(serde_json::to_value(PermissionMode::Plan).unwrap(), json!("plan"));
    }

    #[test]
    fn parses_inbound_can_use_tool() {
        let line = json!({
            "type": "control_request",
            "request_id": "req-1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "input": { "command": "echo hi" },
                "tool_use_id": "toolu_123",
                "permission_suggestions": []
            }
        });
        let (rid, body) = parse_inbound_control(&line).expect("should parse");
        assert_eq!(rid, "req-1");
        match body.expect("body should type") {
            InboundControl::CanUseTool(req) => {
                assert_eq!(req.tool_name, "Bash");
                assert_eq!(req.tool_use_id, "toolu_123");
                assert_eq!(req.input["command"], json!("echo hi"));
            }
            InboundControl::Unknown => panic!("expected can_use_tool"),
        }
    }

    #[test]
    fn unknown_inbound_control_does_not_error() {
        let line = json!({
            "type": "control_request",
            "request_id": "req-2",
            "request": { "subtype": "hook_callback", "callback_id": "hook_1" }
        });
        let (_, body) = parse_inbound_control(&line).expect("should parse");
        assert!(matches!(body.expect("unknown subtype types ok"), InboundControl::Unknown));
    }

    #[test]
    fn malformed_known_subtype_surfaces_an_error_with_its_request_id() {
        // A `can_use_tool` missing the required `tool_use_id`: `#[serde(other)]`
        // does NOT catch this, so the body must come back as `Err` (with the
        // request_id preserved) so the caller can still answer and not hang the CLI.
        let line = json!({
            "type": "control_request",
            "request_id": "req-3",
            "request": { "subtype": "can_use_tool", "tool_name": "Bash" }
        });
        let (rid, body) = parse_inbound_control(&line).expect("request_id is present");
        assert_eq!(rid, "req-3");
        assert!(body.is_err(), "a malformed known subtype must surface as Err, not Unknown");
    }

    #[test]
    fn allow_response_has_doubly_nested_camelcase_shape() {
        let r = permission_allow_response("req-1", "toolu_123", json!({"command":"echo hi"}));
        assert_eq!(r["type"], json!("control_response"));
        assert_eq!(r["response"]["subtype"], json!("success"));
        assert_eq!(r["response"]["request_id"], json!("req-1"));
        assert_eq!(r["response"]["response"]["behavior"], json!("allow"));
        assert_eq!(r["response"]["response"]["toolUseID"], json!("toolu_123"));
        assert_eq!(r["response"]["response"]["updatedInput"]["command"], json!("echo hi"));
    }

    #[test]
    fn deny_response_carries_message() {
        let r = permission_deny_response("req-9", "toolu_9", "not allowed in tests");
        assert_eq!(r["response"]["response"]["behavior"], json!("deny"));
        assert_eq!(r["response"]["response"]["message"], json!("not allowed in tests"));
        assert_eq!(r["response"]["response"]["toolUseID"], json!("toolu_9"));
    }

    #[test]
    fn remote_control_request_builds_enable_and_disable_wire() {
        // Mirrors the VS Code extension SDK: {subtype:"remote_control", enabled, name?}.
        let on = remote_control_request("req-1", true, Some("My Project"));
        assert_eq!(on["type"], json!("control_request"));
        assert_eq!(on["request"]["subtype"], json!("remote_control"));
        assert_eq!(on["request"]["enabled"], json!(true));
        assert_eq!(on["request"]["name"], json!("My Project"));
        // No name (the toggle path) → the field is omitted, not null.
        let off = remote_control_request("req-2", false, None);
        assert_eq!(off["request"]["enabled"], json!(false));
        assert!(off["request"].get("name").is_none());
    }

    #[test]
    fn parse_remote_control_enable_success_yields_connected_with_url() {
        // The URL is doubly nested (response.response), like mcp_status/authenticate.
        let line = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "req-1",
                "response": {
                    "session_url": "https://claude.ai/code?session=abc",
                    "connect_url": "https://x"
                }
            }
        });
        let s = parse_remote_control(&line, true, None);
        assert_eq!(s.status, "connected");
        assert_eq!(s.session_url.as_deref(), Some("https://claude.ai/code?session=abc"));
        assert!(s.error.is_none());
    }

    #[test]
    fn parse_remote_control_disable_yields_disconnected() {
        let line = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "r", "response": {} }
        });
        let s = parse_remote_control(&line, false, None);
        assert_eq!(s.status, "disconnected");
        assert!(s.session_url.is_none());
        assert!(s.error.is_none());
    }

    #[test]
    fn parse_remote_control_rejection_yields_error_message() {
        let line = json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": "r" }
        });
        let s = parse_remote_control(&line, true, Some("Remote Control disabled by org policy"));
        assert_eq!(s.status, "error");
        assert_eq!(s.error.as_deref(), Some("Remote Control disabled by org policy"));
        assert!(s.session_url.is_none());
    }

    #[test]
    fn parse_remote_control_enable_without_url_is_error_not_fake_connected() {
        // A wire "success" that omits session_url must NOT show as connected (there'd
        // be no link to actually control the session) — it surfaces as an error.
        let line = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "r", "response": {} }
        });
        let s = parse_remote_control(&line, true, None);
        assert_eq!(s.status, "error");
        assert!(s.session_url.is_none());
        assert!(s.error.is_some());
    }

    #[test]
    fn effort_level_validation_matches_the_cli_enum() {
        // The five the runtime control accepts in 2.1.187 (`gD`). `"max"` became a
        // real runtime level here — verified live (set it on Opus 4.8 / Sonnet 4.6,
        // read it back via get_settings); up to 2.1.186 it was swallowed.
        for ok in ["low", "medium", "high", "xhigh", "max"] {
            assert!(is_valid_effort_level(ok), "{ok} should be valid");
        }
        assert!(!is_valid_effort_level("ultracode"), "'ultracode' is a separate flag, not an effort");
        assert!(!is_valid_effort_level("banana"));
    }

    #[test]
    fn effort_request_carries_camelcase_key() {
        let r = set_effort_level_request("e-1", "high");
        assert_eq!(r["request"]["subtype"], json!("apply_flag_settings"));
        assert_eq!(r["request"]["settings"]["effortLevel"], json!("high"));
    }

    #[test]
    fn ultracode_on_is_true_off_is_null() {
        // Enabling sends `true`; disabling sends `null` (deletes the key) — NOT false.
        let on = set_ultracode_request("u-1", true);
        assert_eq!(on["request"]["settings"]["ultracode"], json!(true));
        let off = set_ultracode_request("u-2", false);
        assert_eq!(off["request"]["settings"]["ultracode"], Value::Null);
        // The key must be PRESENT-and-null, so the CLI deletes it (not absent).
        assert!(off["request"]["settings"].as_object().unwrap().contains_key("ultracode"));
    }

    #[test]
    fn get_settings_request_shape() {
        let r = get_settings_request("g-1");
        assert_eq!(r["type"], json!("control_request"));
        assert_eq!(r["request"]["subtype"], json!("get_settings"));
    }

    #[test]
    fn parses_get_settings_applied() {
        let line = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "g-1",
                "response": { "applied": { "model": "claude-sonnet-4-6", "effort": "high", "ultracode": false } }
            }
        });
        let applied = parse_get_settings_applied(&line).expect("applied present");
        assert_eq!(applied.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(applied.effort.as_deref(), Some("high"));
        assert_eq!(applied.ultracode, Some(false));
        // A response with no `applied` yields None (so the caller skips it).
        let bare = json!({ "response": { "subtype": "success", "request_id": "x", "response": {} } });
        assert!(parse_get_settings_applied(&bare).is_none());
    }

    #[test]
    fn generate_session_title_request_shape() {
        let r = generate_session_title_request("t-1", "Help me fix the login bug");
        assert_eq!(r["type"], json!("control_request"));
        assert_eq!(r["request_id"], json!("t-1"));
        assert_eq!(r["request"]["subtype"], json!("generate_session_title"));
        // The user's text is preserved VERBATIM (and first), with the brevity hint
        // appended after it — the binary summarizes the whole thing into a short title.
        let desc = r["request"]["description"].as_str().expect("description is a string");
        assert!(
            desc.starts_with("Help me fix the login bug"),
            "user text must lead the description, got: {desc:?}"
        );
        assert!(
            desc.contains("at most 5 words"),
            "the brevity hint must be appended, got: {desc:?}"
        );
        // persist:false — Tosse stores the name itself; the binary must NOT write an
        // ai-title into its transcript.
        assert_eq!(r["request"]["persist"], json!(false));
    }

    #[test]
    fn parses_generated_title_from_doubly_nested_response() {
        let line = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "t-1",
                "response": { "title": "  Fix du bug de login  " }
            }
        });
        // Trimmed to the inner text.
        assert_eq!(parse_generate_session_title(&line).as_deref(), Some("Fix du bug de login"));
        // A blank/missing title yields None (so the caller keeps the placeholder).
        let blank = json!({ "response": { "response": { "title": "   " } } });
        assert!(parse_generate_session_title(&blank).is_none());
        let missing = json!({ "response": { "response": {} } });
        assert!(parse_generate_session_title(&missing).is_none());
    }

    #[test]
    fn parses_control_response_success_and_error() {
        let ok = json!({ "response": { "subtype": "success", "request_id": "a-1" } });
        let r = parse_control_response(&ok).expect("parses");
        assert_eq!(r.request_id, "a-1");
        assert!(r.ok);
        assert!(r.error.is_none());

        let err = json!({ "response": { "subtype": "error", "request_id": "a-2", "error": "nope" } });
        let r = parse_control_response(&err).expect("parses");
        assert!(!r.ok);
        assert_eq!(r.error.as_deref(), Some("nope"));
    }

    #[test]
    fn parses_permission_mode_ack() {
        let line = json!({
            "response": { "subtype": "success", "request_id": "p-1", "response": { "mode": "plan" } }
        });
        assert_eq!(parse_set_permission_mode_ack(&line).as_deref(), Some("plan"));
    }

    #[test]
    fn stop_task_request_shape() {
        // The exact wire the official extension sends: subtype `stop_task` (NOT
        // `task_stop`) with the `task_id` inside the `request` envelope. Verified
        // verbatim against extension.js — must not drift.
        let r = stop_task_request("s-1", "tk_abc");
        assert_eq!(r["type"], json!("control_request"));
        assert_eq!(r["request_id"], json!("s-1"));
        assert_eq!(r["request"]["subtype"], json!("stop_task"));
        assert_eq!(r["request"]["task_id"], json!("tk_abc"));
    }

    #[test]
    fn parses_mcp_status_response() {
        // Shaped exactly like a real `mcp_status` control_response (verified live):
        // doubly-nested `response.response.mcpServers`, per-server config + tools.
        let line = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "tosse-7",
                "response": {
                    "mcpServers": [
                        {
                            "name": "playwright",
                            "status": "connected",
                            "scope": "user",
                            "config": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
                            "tools": [{ "name": "browser_close" }, { "name": "browser_click" }]
                        },
                        {
                            "name": "claude.ai Google Drive",
                            "status": "needs-auth",
                            "scope": "claudeai"
                        }
                    ]
                }
            }
        });
        let servers = parse_mcp_status(&line);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "playwright");
        assert_eq!(servers[0].status, "connected");
        assert_eq!(servers[0].scope.as_deref(), Some("user"));
        assert_eq!(servers[0].transport.as_deref(), Some("stdio"));
        assert_eq!(servers[0].command.as_deref(), Some("npx"));
        assert_eq!(servers[0].tool_count, 2);
        assert_eq!(servers[0].tools, vec!["browser_close", "browser_click"]);
        assert_eq!(servers[1].name, "claude.ai Google Drive");
        assert_eq!(servers[1].status, "needs-auth");
        assert_eq!(servers[1].scope.as_deref(), Some("claudeai"));
        assert_eq!(servers[1].tool_count, 0);
    }

    #[test]
    fn parse_mcp_status_tolerates_non_mcp_response() {
        // An unrelated control_response (e.g. an initialize ack) yields no servers.
        let line = json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "x", "response": { "commands": [] } } });
        assert!(parse_mcp_status(&line).is_empty());
    }

    #[test]
    fn parse_mcp_status_strips_url_query_token() {
        // A live http server whose config URL carries a token must NOT cross the IPC
        // boundary with the query intact (same invariant as the on-disk scanner).
        let line = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "x", "response": { "mcpServers": [
                { "name": "remote", "status": "connected", "scope": "user",
                  "config": { "type": "http", "url": "https://h/mcp?token=secret#frag" } }
            ] } }
        });
        let servers = parse_mcp_status(&line);
        assert_eq!(servers[0].url.as_deref(), Some("https://h/mcp"), "query + fragment stripped");
    }

    /// Live probe: confirm the `mcp_status` control request is answered by the real
    /// binary and DUMP the raw `control_response` so we can read the exact response
    /// shape (nesting + per-server fields) before building on it. Ignored by default
    /// (spawns claude: network + auth). Run with:
    ///   cargo test --lib --ignored live_mcp_status_probe -- --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary (network + auth); prints raw mcp_status responses"]
    async fn live_mcp_status_probe() {
        use crate::supervisor::protocol::CliMessage;
        use crate::supervisor::transport::{SpawnConfig, Transport};
        use std::time::Duration;

        let cwd = std::env::current_dir().unwrap();
        let (mut transport, mut rx) =
            Transport::spawn(SpawnConfig::new(cwd)).expect("claude should spawn");
        transport
            .send_line(initialize_request("probe-init"))
            .expect("send initialize");

        // MCP servers connect asynchronously after startup, so query a few times
        // with delays to watch the statuses settle (pending → connected/needs-auth).
        for round in 0..3 {
            tokio::time::sleep(Duration::from_secs(6)).await;
            let rid = format!("probe-mcp-{round}");
            transport
                .send_line(mcp_status_request(&rid))
                .expect("send mcp_status");
            let resp = tokio::time::timeout(Duration::from_secs(20), async {
                while let Some(msg) = rx.recv().await {
                    if let CliMessage::ControlResponse(v) = msg {
                        let echoed = v
                            .get("response")
                            .and_then(|r| r.get("request_id"))
                            .and_then(|x| x.as_str());
                        if echoed == Some(rid.as_str()) {
                            return Some(v);
                        }
                    }
                }
                None
            })
            .await
            .ok()
            .flatten();
            eprintln!("=== mcp_status round {round} ===");
            let servers = resp
                .as_ref()
                .and_then(|v| v.get("response"))
                .and_then(|r| r.get("response"))
                .and_then(|r| r.get("mcpServers"))
                .and_then(|s| s.as_array());
            match servers {
                Some(list) => {
                    for s in list {
                        let name = s.get("name").and_then(Value::as_str).unwrap_or("?");
                        let status = s.get("status").and_then(Value::as_str).unwrap_or("?");
                        let scope = s.get("scope").and_then(Value::as_str).unwrap_or("-");
                        let ntools = s.get("tools").and_then(Value::as_array).map_or(0, |t| t.len());
                        eprintln!("  {name:42} status={status:14} scope={scope:10} tools={ntools}");
                    }
                }
                None => eprintln!("  <no mcpServers in response>"),
            }
        }
        transport.shutdown().await;
    }

    /// Live capture: reproduce the "sub-agent woken via SendMessage" bug and DUMP the
    /// wire, so we can see how a re-activated background agent is correlated —
    /// specifically whether the wake emits a fresh `task_started`, its `task_type`, and
    /// whether its `tool_use_id` is the NEW `SendMessage` block, the ORIGINAL `Agent`
    /// block, or absent. The extension we have (2.1.181) predates this feature, so the
    /// only source of truth is the installed binary. Ignored by default (spawns claude:
    /// network + auth + a real sub-agent run). Run with:
    ///   cargo test --lib --ignored live_capture_subagent_wake -- --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary; captures the SendMessage-wake-a-background-agent wire"]
    async fn live_capture_subagent_wake() {
        use crate::supervisor::protocol::{CliMessage, SystemMsg};
        use crate::supervisor::transport::{self, SpawnConfig, Transport};
        use std::io::Write as _;
        use std::time::{Duration, Instant};

        // Log both to stderr (--nocapture) and to a file for later inspection.
        let log_path = std::env::var("TOSSE_WAKE_LOG")
            .unwrap_or_else(|_| "/tmp/wake_capture.log".to_string());
        let mut file = std::fs::File::create(&log_path).ok();
        macro_rules! logln { ($($a:tt)*) => {{
            let s = format!($($a)*);
            eprintln!("{s}");
            if let Some(f) = file.as_mut() { let _ = writeln!(f, "{s}"); }
        }}; }

        let cwd = std::env::current_dir().unwrap();
        let mut cfg = SpawnConfig::new(cwd);
        // Allowlist the tools the parent + sub-agent might touch so nothing blocks on a
        // permission prompt (we also auto-allow below, belt-and-suspenders).
        cfg.allowed_tools = [
            "Agent", "Task", "SendMessage", "Bash", "Read", "Grep", "Glob",
            "TaskOutput", "AgentOutput", "BashOutput", "TodoWrite", "Write", "Edit", "LS",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (mut transport, mut rx) = Transport::spawn(cfg).expect("claude should spawn");
        transport
            .send_line(initialize_request("cap-init"))
            .expect("send initialize");

        // Pull the tool_use blocks (id, name, input) out of an assistant `message` Value.
        fn tool_uses(msg: &Value) -> Vec<(String, String, Value)> {
            let mut out = Vec::new();
            if let Some(arr) = msg.get("content").and_then(Value::as_array) {
                for b in arr {
                    if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                        out.push((
                            b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                            b.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                            b.get("input").cloned().unwrap_or(Value::Null),
                        ));
                    }
                }
            }
            out
        }
        // Flatten a user `message` Value's tool_result blocks to (tool_use_id, text).
        fn tool_results(msg: &Value) -> Vec<(String, String)> {
            let mut out = Vec::new();
            if let Some(arr) = msg.get("content").and_then(Value::as_array) {
                for b in arr {
                    if b.get("type").and_then(Value::as_str) == Some("tool_result") {
                        let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string();
                        let text = match b.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Array(a)) => a
                                .iter()
                                .filter_map(|x| x.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join(" "),
                            _ => String::new(),
                        };
                        out.push((id, text));
                    }
                }
            }
            out
        }

        // Phase 1: launch ONE detached background sub-agent that stays BUSY for a few
        // seconds (a Bash `sleep`), so we can observe what a "running" sub-agent looks
        // like on the wire — the control for the wake below.
        let launch = "Use the Agent tool with run_in_background set to true to launch ONE detached \
            background sub-agent. Its prompt must instruct it to FIRST run the bash command \
            `sleep 6` and then reply with exactly the word BANANA. Use subagent_type \
            \"general-purpose\". After launching it, end your turn immediately without doing \
            anything else.";
        transport
            .send_line(transport::user_message(launch, &uuid::Uuid::new_v4().to_string()))
            .expect("send launch");

        let mut agent_id: Option<String> = None; // the resumable agentId (a...-...)
        let mut agent_tool_use_id: Option<String> = None; // the launching Agent tool_use id
        let mut sub_task_id: Option<String> = None; // the sub-agent's local_agent task_id
        let mut wake_sent = false;
        let mut wake_task_started_seen = false;
        // Set once a POST-wake event re-flips the sub-agent task to a non-terminal state
        // (a fresh `task_started`, or a `task_updated`/`task_progress` with a running-ish
        // status). This is the fix-critical signal: does a woken agent re-enter "running"?
        let mut wake_running_seen = false;
        let mut wake_time: Option<Instant> = None;

        let deadline = Instant::now() + Duration::from_secs(300);
        while Instant::now() < deadline {
            let msg = match tokio::time::timeout(Duration::from_secs(120), rx.recv()).await {
                Ok(Some(m)) => m,
                Ok(None) => { logln!("<stdout closed>"); break; }
                Err(_) => { logln!("<recv timeout>"); break; }
            };
            match msg {
                CliMessage::ControlRequest(v) => {
                    // Auto-allow any permission prompt; error any other inbound request so
                    // the CLI never hangs waiting on us.
                    if let Some((rid, body)) = parse_inbound_control(&v) {
                        match body {
                            Ok(InboundControl::CanUseTool(req)) => {
                                logln!("[perm] allow {} tool_use_id={}", req.tool_name, req.tool_use_id);
                                let _ = transport.send_line(permission_allow_response(
                                    &rid, &req.tool_use_id, req.input.clone(),
                                ));
                            }
                            _ => {
                                let _ = transport.send_line(control_error_response(&rid, "unsupported"));
                            }
                        }
                    }
                }
                CliMessage::Assistant(a) => {
                    let parent = a.parent_tool_use_id.as_deref();
                    for (id, name, input) in tool_uses(&a.message) {
                        logln!("[assistant tool_use] parent={:?} name={name} id={id} input={}",
                            parent, serde_json::to_string(&input).unwrap_or_default());
                        if (name == "Agent" || name == "Task") && agent_tool_use_id.is_none() {
                            agent_tool_use_id = Some(id.clone());
                        }
                        if name == "SendMessage" {
                            logln!("[wake] SendMessage tool_use id={id} input={}",
                                serde_json::to_string(&input).unwrap_or_default());
                        }
                    }
                }
                CliMessage::User(u) => {
                    for (id, text) in tool_results(&u.message) {
                        let head: String = text.chars().take(240).collect();
                        logln!("[tool_result] tool_use_id={id} text={:?}", head);
                        // Parse the resumable agentId out of the Agent launch ack.
                        if agent_id.is_none() {
                            if let Some(m) = text.split("agentId:").nth(1) {
                                let raw = m.trim();
                                let id: String = raw
                                    .chars()
                                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                                    .collect();
                                if !id.is_empty() {
                                    logln!("[agentId] resolved => {id}");
                                    agent_id = Some(id);
                                }
                            }
                        }
                    }
                }
                CliMessage::System(SystemMsg::TaskStarted(t)) => {
                    logln!("[task_started] task_id={} tool_use_id={:?} task_type={:?} subagent_type={:?} description={:?}",
                        t.task_id, t.tool_use_id, t.task_type, t.subagent_type, t.description);
                    if t.task_type.as_deref() == Some("local_agent") {
                        if !wake_sent {
                            sub_task_id = Some(t.task_id.clone());
                        } else {
                            wake_task_started_seen = true;
                            wake_running_seen = true;
                            logln!("[WAKE task_started] >>> task_id={} tool_use_id={:?} (original Agent tool_use_id was {:?}) task_type={:?}",
                                t.task_id, t.tool_use_id, agent_tool_use_id, t.task_type);
                        }
                    }
                }
                CliMessage::System(SystemMsg::TaskProgress(t)) => {
                    logln!("[task_progress] task_id={} tool_use_id={:?} description={:?}",
                        t.task_id, t.tool_use_id, t.description);
                    if wake_sent && sub_task_id.as_deref() == Some(t.task_id.as_str()) {
                        wake_running_seen = true;
                        logln!("[WAKE task_progress] >>> woken agent is active (task_id={})", t.task_id);
                    }
                }
                CliMessage::System(SystemMsg::TaskUpdated(t)) => {
                    let status = t.patch.as_ref().and_then(|p| p.status.clone());
                    logln!("[task_updated] task_id={} status={:?}", t.task_id, status);
                    let running_ish = matches!(
                        status.as_deref(),
                        Some("running") | Some("in_progress") | Some("queued") | Some("active") | Some("started")
                    );
                    if wake_sent && running_ish && sub_task_id.as_deref() == Some(t.task_id.as_str()) {
                        wake_running_seen = true;
                        logln!("[WAKE task_updated running] >>> task_id={} status={:?}", t.task_id, status);
                    }
                }
                CliMessage::System(SystemMsg::TaskNotification(t)) => {
                    logln!("[task_notification] task_id={} tool_use_id={:?} status={:?} output_file={:?}",
                        t.task_id, t.tool_use_id, t.status, t.output_file);
                    // The sub-agent finished → wake it via SendMessage (once).
                    let is_sub = sub_task_id.as_deref() == Some(t.task_id.as_str());
                    if is_sub && !wake_sent {
                        if let Some(aid) = agent_id.clone() {
                            logln!("=== SUB-AGENT FINISHED; sending SendMessage wake to {aid} ===");
                            let wake = format!(
                                "Use the SendMessage tool to resume the background sub-agent you \
                                 launched. Set `to` to exactly \"{aid}\", set `summary` to \"kiwi \
                                 after sleep\", and set `message` to \"First run the bash command \
                                 `sleep 8`, then reply with exactly the word KIWI.\". Do nothing else."
                            );
                            let _ = transport.send_line(
                                transport::user_message(wake, &uuid::Uuid::new_v4().to_string()),
                            );
                            wake_sent = true;
                            wake_time = Some(Instant::now());
                        } else {
                            logln!("!! sub-agent finished but no agentId parsed — cannot wake");
                        }
                    } else if wake_sent && is_sub {
                        // A terminal notification AFTER the wake: the woken agent settled.
                        // Only stop once we've observed whether it re-entered "running" (or
                        // enough time passed that we can conclude it never did).
                        logln!("=== post-wake task_notification (woken agent settled); wake_running_seen={wake_running_seen} ===");
                        if wake_running_seen
                            || wake_time.map_or(false, |w| w.elapsed() > Duration::from_secs(12))
                        {
                            break;
                        }
                    }
                }
                CliMessage::Result(_) => {
                    logln!("[result] (turn ended)");
                }
                _ => {}
            }
        }

        logln!("=== CAPTURE SUMMARY ===");
        logln!("agent_tool_use_id (launch) = {:?}", agent_tool_use_id);
        logln!("agent_id (resumable)       = {:?}", agent_id);
        logln!("sub_task_id (1st run)      = {:?}", sub_task_id);
        logln!("wake_sent                  = {wake_sent}");
        logln!("wake_task_started_seen     = {wake_task_started_seen}  (fresh task_started on wake?)");
        logln!("wake_running_seen          = {wake_running_seen}  (woken agent re-entered running?)");
        logln!("log written to {log_path}");
        transport.shutdown().await;
    }

    /// Live capture: does a MODEL-invoked skill's SKILL.md body leak as a user turn?
    /// The body arrives as an `isMeta:true` user line (dropped by `ingest_user` L805 +
    /// `history.rs::push_user`). But `--replay-user-messages` (unconditional) ALSO
    /// re-emits user lines on stdout — if the replay echo of the injected body drops
    /// `isMeta`, the L805 guard misses it and the body surfaces as a fake user bubble.
    /// This is LIVE-ONLY: a reload reads the on-disk `isMeta:true` line and drops it, so
    /// the bug vanishes on restart. This probe logs every `user` line's
    /// (uuid, isMeta, isReplay) so we can see the body's ORIGINAL vs REPLAY shape and
    /// pick the fix (drop-by-isMeta is not enough; likely track the meta uuid like
    /// `sent_user_uuids`). Ignored by default (spawns claude: network + auth). Run with:
    ///   cargo test --lib --ignored live_capture_skill_body_replay -- --nocapture
    #[tokio::test]
    #[ignore = "spawns the real claude binary; captures the skill-body isMeta/replay wire"]
    async fn live_capture_skill_body_replay() {
        use crate::supervisor::protocol::CliMessage;
        use crate::supervisor::transport::{self, SpawnConfig, Transport};
        use std::io::Write as _;
        use std::time::{Duration, Instant};

        let log_path = std::env::var("TOSSE_SKILL_LOG")
            .unwrap_or_else(|_| "/tmp/skill_body_capture.log".to_string());
        let mut file = std::fs::File::create(&log_path).ok();
        macro_rules! logln { ($($a:tt)*) => {{
            let s = format!($($a)*);
            eprintln!("{s}");
            if let Some(f) = file.as_mut() { let _ = writeln!(f, "{s}"); }
        }}; }

        // A throwaway project skill in a temp cwd → zero side effects, deterministic
        // availability. Claude discovers `.claude/skills/<name>/SKILL.md` walking up from cwd.
        let tmp = std::env::temp_dir().join(format!("tosse-skill-probe-{}", uuid::Uuid::new_v4()));
        let skill_dir = tmp.join(".claude/skills/probe");
        std::fs::create_dir_all(&skill_dir).expect("create skill dir");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: probe\ndescription: Trivial probe skill. Use when asked to run the probe skill.\n---\n\n# Probe skill\n\nReply with exactly the word PROBE_OK and end your turn. Do nothing else.\n",
        )
        .expect("write SKILL.md");

        let mut cfg = SpawnConfig::new(tmp.clone());
        cfg.allowed_tools = ["Skill"].iter().map(|s| s.to_string()).collect();
        let (mut transport, mut rx) = Transport::spawn(cfg).expect("claude should spawn");
        transport
            .send_line(initialize_request("cap-init"))
            .expect("send initialize");

        // Concatenate a user `message` Value's text blocks (or string content).
        fn user_text(msg: &Value) -> String {
            match msg.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            }
        }

        transport
            .send_line(transport::user_message(
                "Use the Skill tool to invoke the skill named \"probe\", then do exactly what it says.",
                &uuid::Uuid::new_v4().to_string(),
            ))
            .expect("send prompt");

        // Each time the skill-body text appears on a `user` line, record its shape.
        let mut body_sightings: Vec<(String, Option<bool>, Option<bool>)> = Vec::new();
        let mut skill_tool_use_id: Option<String> = None;
        let mut body_src_matches = false;
        let mut results_seen = 0;

        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            let msg = match tokio::time::timeout(Duration::from_secs(90), rx.recv()).await {
                Ok(Some(m)) => m,
                Ok(None) => { logln!("<stdout closed>"); break; }
                Err(_) => { logln!("<recv timeout>"); break; }
            };
            match msg {
                CliMessage::ControlRequest(v) => {
                    if let Some((rid, body)) = parse_inbound_control(&v) {
                        match body {
                            Ok(InboundControl::CanUseTool(req)) => {
                                logln!("[perm] allow {} tool_use_id={}", req.tool_name, req.tool_use_id);
                                let _ = transport.send_line(permission_allow_response(
                                    &rid, &req.tool_use_id, req.input.clone(),
                                ));
                            }
                            _ => { let _ = transport.send_line(control_error_response(&rid, "unsupported")); }
                        }
                    }
                }
                CliMessage::Assistant(a) => {
                    if let Some(arr) = a.message.get("content").and_then(Value::as_array) {
                        for b in arr {
                            if b.get("type").and_then(Value::as_str) == Some("tool_use")
                                && b.get("name").and_then(Value::as_str) == Some("Skill")
                            {
                                let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                                logln!("[assistant Skill tool_use] id={id} input={}",
                                    serde_json::to_string(&b.get("input").cloned().unwrap_or(Value::Null)).unwrap_or_default());
                                skill_tool_use_id = Some(id);
                            }
                        }
                    }
                }
                CliMessage::User(u) => {
                    let txt = user_text(&u.message);
                    let head: String = txt.chars().take(80).collect();
                    logln!("[user] uuid={:?} isMeta={:?} isReplay={:?} sourceToolUseID={:?} text={:?}",
                        u.uuid, u.is_meta, u.is_replay, u.source_tool_use_id, head);
                    if txt.contains("Base directory for this skill") {
                        let matches_skill = u.source_tool_use_id.is_some()
                            && u.source_tool_use_id == skill_tool_use_id;
                        logln!("   ^^^ SKILL BODY line: uuid={:?} isMeta={:?} isReplay={:?} sourceToolUseID={:?} (matches Skill tool_use = {matches_skill})",
                            u.uuid, u.is_meta, u.is_replay, u.source_tool_use_id);
                        body_sightings.push((u.uuid.clone().unwrap_or_default(), u.is_meta, u.is_replay));
                        body_src_matches = body_src_matches || matches_skill;
                    }
                }
                CliMessage::Result(_) => {
                    results_seen += 1;
                    logln!("[result] turn ended (#{results_seen})");
                    // The replay echo may trail the turn; stop once we've seen the body twice
                    // (original + replay) or a second result comes in.
                    if body_sightings.len() >= 2 || results_seen >= 2 { break; }
                }
                _ => {}
            }
        }

        logln!("=== CAPTURE SUMMARY ===");
        logln!("skill-body sightings = {}", body_sightings.len());
        for (i, (uuid, meta, replay)) in body_sightings.iter().enumerate() {
            logln!("  [{i}] uuid={uuid} isMeta={meta:?} isReplay={replay:?}");
        }
        let live_leak = body_sightings.iter().any(|(_, meta, _)| *meta != Some(true));
        logln!("LIVE-BODY-MISSING-ISMETA (leak reproduced) = {live_leak}");
        logln!("body line's sourceToolUseID matches the Skill tool_use = {body_src_matches}  (→ live-safe drop signal)");
        logln!("Skill tool_use id = {skill_tool_use_id:?}");
        logln!("log written to {log_path}");
        let _ = std::fs::remove_dir_all(&tmp);
        transport.shutdown().await;
    }
}
