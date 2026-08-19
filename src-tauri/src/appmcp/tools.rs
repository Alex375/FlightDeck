//! The tool catalogue both MCP surfaces serve — names, descriptions, JSON
//! schemas, and which surface sees which tool.
//!
//! Deliberately data-only: execution lives in the front executor
//! (`src/agent/appControl.ts`), keyed by these names, except `wait_for_events`
//! (served Rust-side from the event journal). Keep the two sides in step: a
//! tool listed here with no front case answers "unknown tool" at call time.
//!
//! Scope guard (deliberate omissions): nothing that DESTROYS data or raises
//! privilege is exposed — no `set_permission_mode`, no remote control, no
//! history delete/wipe, no rewind/fork, no terminal writes. Those stay
//! human-only (see the `forbidden_tools_are_absent` test).
//! `remove_conversation` is the one intentional exception, and it is NOT
//! destructive: it takes a conversation off the active list while the transcript
//! stays on disk (re-openable from History) and the removal is ⌘Z-undoable. It
//! is additionally gated by a user policy, enforced in the front executor.

use serde_json::{json, Value};

use super::Surface;

/// How a tool executes: bridged to the front executor, or served in Rust from
/// the event journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Front,
    WaitForEvents,
}

/// One catalogue entry.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub kind: ToolKind,
    pub schema: Value,
}

/// Shorthand for a JSON-schema object with required keys.
fn obj(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn conversation_id_prop(hint: &str) -> Value {
    json!({ "type": "string", "description": hint })
}

/// The catalogue for one surface. Rebuilt per call — `tools/list` is rare and
/// the specs are tiny, so a static cache would buy nothing.
pub fn for_surface(surface: Surface) -> Vec<ToolSpec> {
    let mut tools = vec![
        ToolSpec {
            name: "list_conversations",
            description: "List every conversation in the Flight Deck app: id, title, repository, \
                backend (claude/codex), live status (running / needs_input / needs_permission / \
                review / error / backgrounding / idle / off) and last activity. Use it to find a \
                conversation before reading or messaging it.",
            kind: ToolKind::Front,
            schema: obj(json!({}), &[]),
        },
        ToolSpec {
            name: "read_conversation",
            description: "Read the latest exchanges of a conversation as plain text: user \
                prompts, assistant replies, and a one-line summary per tool call. Returns the \
                most recent turns first-to-last.",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "conversation_id": conversation_id_prop("Target conversation id (from list_conversations)."),
                    "max_turns": { "type": "integer", "minimum": 1, "maximum": 40,
                        "description": "How many turns to include (default 10)." },
                }),
                &["conversation_id"],
            ),
        },
        ToolSpec {
            name: "send_message",
            description: "Send a prompt to a conversation's agent. Starts the agent if it is \
                not running; if a turn is already in flight the message is queued and injected \
                mid-turn. Returns immediately after delivery — read the reply later with \
                read_conversation (or wait_for_events on the voice bridge).",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "conversation_id": conversation_id_prop("Target conversation id."),
                    "text": { "type": "string", "description": "The prompt to send." },
                }),
                &["conversation_id", "text"],
            ),
        },
        ToolSpec {
            name: "create_conversation",
            description: "Create a new conversation in a repository folder (registering the \
                repository in the app if it is not listed yet) and optionally send its first \
                prompt. Returns the new conversation id.",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "repo_path": { "type": "string",
                        "description": "Absolute path of the repository/folder to work in." },
                    "first_message": { "type": "string",
                        "description": "Optional first prompt, sent right away (starts the agent)." },
                    "title": { "type": "string", "description": "Optional conversation title." },
                    "backend": { "type": "string", "enum": ["claude", "codex"],
                        "description": "Agent backend (default claude)." },
                }),
                &["repo_path"],
            ),
        },
        ToolSpec {
            name: "browse_folders",
            description: "Explore this Mac's folder layout to find where to work: a compact, \
                depth-limited tree of directories with git repositories marked (and not \
                descended into), plus the folders already registered in the app. Call it \
                WITHOUT a path first for an overview from the user's home folder; pass a path \
                to look deeper. Use it to locate a repository path for create_conversation or \
                add_repo instead of asking the user to dictate one.",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "path": { "type": "string",
                        "description": "Absolute folder to explore (default: the user's home folder)." },
                    "depth": { "type": "integer", "minimum": 1, "maximum": 3,
                        "description": "Tree depth (default 2)." },
                }),
                &[],
            ),
        },
        ToolSpec {
            name: "focus_conversation",
            description: "Bring a conversation on screen in the app (select it and switch to \
                the conversation view).",
            kind: ToolKind::Front,
            schema: obj(
                json!({ "conversation_id": conversation_id_prop("Conversation to show.") }),
                &["conversation_id"],
            ),
        },
        ToolSpec {
            name: "rename_conversation",
            description: "Rename a conversation. Without conversation_id it renames the calling \
                conversation (in-app callers only). The new name sticks: automatic titling stops \
                overwriting it.",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "name": { "type": "string", "description": "The new title." },
                    "conversation_id": conversation_id_prop("Target conversation (default: the calling one)."),
                }),
                &["name"],
            ),
        },
        ToolSpec {
            name: "acknowledge_conversation",
            description: "Mark a conversation as seen — clears its 'needs attention' highlight \
                (the same as the card's 'Seen' button), once the user has heard about it and \
                does not need it flagged anymore. Non-destructive: it only dismisses the alert; \
                the conversation, its live session and its history are untouched. Without \
                conversation_id it acknowledges the calling conversation (in-app callers only).",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "conversation_id": conversation_id_prop("Conversation to acknowledge (default: the calling one)."),
                }),
                &[],
            ),
        },
        ToolSpec {
            name: "remove_conversation",
            description: "Take a conversation OFF the active Flight Deck list — the tidy-up \
                action ('clear that one off my board', 'get rid of that conversation'). This is \
                NOT a delete: the full transcript stays on disk, the conversation reopens from \
                the History panel, and the user can undo it with ⌘Z. It does stop the \
                conversation's live session. Requires a conversation_id (a conversation cannot \
                remove itself). May be turned off by the user — the call then returns an error.",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "conversation_id": conversation_id_prop("Conversation to remove from the active list (required)."),
                }),
                &["conversation_id"],
            ),
        },
        ToolSpec {
            name: "search_past_conversations",
            description: "Search the on-disk history of PAST conversations (ones not on the \
                active list anymore, or never opened this session) — the History panel's index. \
                With a query it ranks by relevance; without one it returns the most recent. \
                Read-only: each result carries a session_id, title, repo, backend, last-activity \
                time, and an 'already_active' flag. Use it to find a conversation the user \
                refers to, then reopen_conversation to bring it back.",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "query": { "type": "string", "description": "Text to search for. Omit to list the most recent past conversations." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 40,
                        "description": "Max results (default 15)." },
                }),
                &[],
            ),
        },
        ToolSpec {
            name: "reopen_conversation",
            description: "Bring a PAST conversation back onto the active Flight Deck list, by the \
                session_id from search_past_conversations. Additive and non-destructive: it \
                re-creates the list entry from the on-disk transcript, lazily (no process starts \
                until the next message). If that conversation is already active, it just focuses \
                it instead of duplicating.",
            kind: ToolKind::Front,
            schema: obj(
                json!({
                    "session_id": { "type": "string", "description": "The session_id of the past conversation (from search_past_conversations)." },
                }),
                &["session_id"],
            ),
        },
    ];

    match surface {
        Surface::App => {
            tools.extend([
                ToolSpec {
                    name: "whoami",
                    description: "Identify the calling conversation: id, title, repository, \
                        working directory, backend and live status. Call it before acting on \
                        'this conversation'.",
                    kind: ToolKind::Front,
                    schema: obj(json!({}), &[]),
                },
                ToolSpec {
                    name: "add_repo",
                    description: "Register a repository/folder in the app's sidebar so \
                        conversations can be created in it. Idempotent by path.",
                    kind: ToolKind::Front,
                    schema: obj(
                        json!({ "path": { "type": "string", "description": "Absolute folder path." } }),
                        &["path"],
                    ),
                },
                ToolSpec {
                    name: "open_file",
                    description: "Open a file in the app's editor panel, optionally at a line \
                        and column — use it to show the user the code you are talking about. \
                        Focuses the target conversation (default: the calling one) and its \
                        editor. Relative paths resolve against that conversation's working \
                        directory.",
                    kind: ToolKind::Front,
                    schema: obj(
                        json!({
                            "path": { "type": "string", "description": "File path (absolute, or relative to the conversation's cwd)." },
                            "line": { "type": "integer", "minimum": 1, "description": "1-based line to reveal." },
                            "column": { "type": "integer", "minimum": 1, "description": "1-based column." },
                            "conversation_id": conversation_id_prop("Conversation whose editor opens the file (default: the calling one)."),
                        }),
                        &["path"],
                    ),
                },
                ToolSpec {
                    name: "open_view",
                    description: "Switch the app's main view: 'conversation' (the active \
                        thread), 'flightdeck' (the fleet overview) or 'tosse' (the CRM tasks \
                        board, only when signed in).",
                    kind: ToolKind::Front,
                    schema: obj(
                        json!({ "view": { "type": "string", "enum": ["conversation", "flightdeck", "tosse"] } }),
                        &["view"],
                    ),
                },
                ToolSpec {
                    name: "open_panel",
                    description: "Open (or close with 'none') a side panel of the conversation \
                        view: 'editor' (file tree + code), 'terminal', or 'git'. Editor and \
                        terminal can be open together (a split); git takes the side region over \
                        both. Targets a conversation (default: the calling one) and brings it \
                        on screen.",
                    kind: ToolKind::Front,
                    schema: obj(
                        json!({
                            "panel": { "type": "string", "enum": ["editor", "terminal", "git", "none"] },
                            "conversation_id": conversation_id_prop("Target conversation (default: the calling one)."),
                        }),
                        &["panel"],
                    ),
                },
                ToolSpec {
                    name: "notify_user",
                    description: "Notify the human with an OS notification (banner + optional \
                        Dock bounce when critical is true). Use sparingly, for things worth \
                        interrupting them for.",
                    kind: ToolKind::Front,
                    schema: obj(
                        json!({
                            "message": { "type": "string", "description": "Short notification text." },
                            "critical": { "type": "boolean", "description": "Also bounce the Dock icon (default false)." },
                        }),
                        &["message"],
                    ),
                },
            ]);
        }
        Surface::Voice => {
            tools.push(ToolSpec {
                name: "wait_for_events",
                description: "Long-poll for fleet events: 'turn_completed' (a conversation \
                    finished its turn — detail carries the outcome and the last assistant \
                    text) and 'needs_attention' (an agent is waiting on a permission or a \
                    question). First call it WITHOUT cursor to get a baseline cursor \
                    immediately; then call it again with that cursor — it answers as soon as \
                    something happens, or after timeout_seconds (default 25) with no events. \
                    Always pass the cursor returned by the previous call.",
                kind: ToolKind::WaitForEvents,
                schema: obj(
                    json!({
                        "cursor": { "type": "integer", "minimum": 0,
                            "description": "The cursor returned by the previous call. Omit on the first call." },
                        "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 55,
                            "description": "How long to wait for new events (default 25)." },
                    }),
                    &[],
                ),
            });
        }
    }
    tools
}

/// Find one tool by name on a surface (used by `tools/call`).
pub fn find(surface: Surface, name: &str) -> Option<ToolSpec> {
    for_surface(surface).into_iter().find(|t| t.name == name)
}

/// The MCP `tools/list` payload for a surface.
pub fn list_json(surface: Surface) -> Value {
    let tools: Vec<Value> = for_surface(surface)
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.schema,
            })
        })
        .collect();
    json!({ "tools": tools })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The voice surface is the conversation-centric subset + the long-poll; the
    /// UI-manipulation tools stay in-app only.
    #[test]
    fn surfaces_expose_the_right_subsets() {
        let app: Vec<_> = for_surface(Surface::App).iter().map(|t| t.name).collect();
        let voice: Vec<_> = for_surface(Surface::Voice).iter().map(|t| t.name).collect();
        for shared in ["list_conversations", "read_conversation", "send_message",
                       "create_conversation", "browse_folders", "focus_conversation",
                       "rename_conversation", "acknowledge_conversation", "remove_conversation",
                       "search_past_conversations", "reopen_conversation"] {
            assert!(app.contains(&shared), "app missing {shared}");
            assert!(voice.contains(&shared), "voice missing {shared}");
        }
        for app_only in ["whoami", "open_file", "open_view", "open_panel", "notify_user", "add_repo"] {
            assert!(app.contains(&app_only), "app missing {app_only}");
            assert!(!voice.contains(&app_only), "voice must not expose {app_only}");
        }
        assert!(voice.contains(&"wait_for_events"));
        assert!(!app.contains(&"wait_for_events"));
    }

    /// Every schema is a well-formed object schema whose required keys exist in
    /// properties — the CLI rejects malformed tool schemas silently otherwise.
    #[test]
    fn schemas_are_coherent() {
        for surface in [Surface::App, Surface::Voice] {
            for t in for_surface(surface) {
                assert_eq!(t.schema["type"], "object", "{}: not an object schema", t.name);
                let props = t.schema["properties"].as_object().expect("properties");
                for req in t.schema["required"].as_array().expect("required") {
                    let key = req.as_str().unwrap();
                    assert!(props.contains_key(key), "{}: required '{key}' not in properties", t.name);
                }
            }
        }
    }

    /// The blacklist stays a blacklist: no destructive / privilege-raising tool
    /// name may ever appear on either surface.
    #[test]
    fn forbidden_tools_are_absent() {
        for surface in [Surface::App, Surface::Voice] {
            for t in for_surface(surface) {
                for banned in ["permission", "remote_control", "delete", "wipe", "rewind", "fork"] {
                    assert!(!t.name.contains(banned), "{} exposes banned capability", t.name);
                }
            }
        }
    }
}
