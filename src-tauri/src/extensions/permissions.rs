//! Per-tool permission rules for MCP tools — Claude Code's own `permissions.allow` /
//! `ask` / `deny` lists, read across every settings file that can hold one and written in
//! the user's `~/.claude/settings.json`.
//!
//! ## What a rule does (verified against the docs and binary 2.1.280)
//! - `deny` on a bare tool name (`mcp__claude_ai_Gmail__send_message` IS a bare name — an
//!   `mcp__` rule never takes parentheses) removes the tool from Claude's context, in every
//!   permission mode, `bypassPermissions` included.
//! - `ask` prompts on every call, even in `auto` and `bypassPermissions` (`dontAsk` denies).
//! - `allow` runs the tool without a prompt, and skips the auto-mode classifier.
//! - No rule: the conversation's permission mode decides.
//! - deny > ask > allow, whatever the rule's specificity or the file it sits in.
//! - The CLI watches its settings files: an edit applies from the next tool call of a
//!   RUNNING session, no restart.
//!
//! ## What the app writes
//! Only exact MCP tool names, only in the USER file — the one file that is the user's own
//! and applies everywhere (terminal and VS Code included). Rules from the other files are
//! read so the UI can tell when one of them overrides a choice made here; they are never
//! edited from the app.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{home_dir, write_settings_file};

/// Which of Claude Code's three rule lists a rule sits in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ToolRuleKind {
    Allow,
    Ask,
    Deny,
}

impl ToolRuleKind {
    const ALL: [ToolRuleKind; 3] = [ToolRuleKind::Allow, ToolRuleKind::Ask, ToolRuleKind::Deny];

    fn key(self) -> &'static str {
        match self {
            ToolRuleKind::Allow => "allow",
            ToolRuleKind::Ask => "ask",
            ToolRuleKind::Deny => "deny",
        }
    }
}

/// The settings file a rule was read from. Only `User` is ever written by the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RuleSource {
    /// Organization policy (`/Library/Application Support/ClaudeCode/managed-settings.json`).
    Managed,
    /// `<repo>/.claude/settings.local.json` — this project, this machine.
    Local,
    /// `<repo>/.claude/settings.json` — shared with everyone on the repository.
    Project,
    /// `~/.claude/settings.json` — the user's own, every project.
    User,
}

/// One permission rule that can concern an MCP tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PermissionRule {
    /// The rule verbatim (`mcp__claude_ai_Gmail__send_message`, `mcp__claude_ai_Gmail`,
    /// `mcp__claude_ai_Gmail__*`, `mcp__*`, `*`…).
    pub rule: String,
    pub kind: ToolRuleKind,
    pub source: RuleSource,
    /// The file it was read from, for the UI to name.
    pub path: String,
}

/// Every MCP-relevant permission rule visible to a repository.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct PermissionRulesView {
    pub rules: Vec<PermissionRule>,
    /// Files that exist but could not be read or parsed. Their rules are UNKNOWN, so the
    /// view is incomplete — the UI says so rather than presenting a partial picture as whole.
    pub warnings: Vec<String>,
    /// Set when the USER file itself is unreadable: the app must not offer to write a file
    /// it could not read (a rewrite would drop whatever it failed to parse).
    pub user_error: Option<String>,
    /// Same for the repository's local file (the Repository scope's target).
    pub local_error: Option<String>,
    /// Every `enabledPlugins` entry, per file.
    pub plugins: Vec<PluginOverride>,
    /// The project root the local/project files were read from (a worktree's own root).
    pub repo_root: Option<String>,
}

/// One change to the user's rules: set `tool`'s rule to `kind`, or remove it (`None`,
/// i.e. back to "no rule of mine").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct McpToolPermissionChange {
    /// The full MCP tool name (`mcp__<server>__<tool>`).
    pub tool: String,
    pub kind: Option<ToolRuleKind>,
}

/// One file's say on one plugin: `enabledPlugins[id]` in that settings file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PluginOverride {
    pub plugin_id: String,
    pub enabled: bool,
    pub source: RuleSource,
    pub path: String,
}

/// Which file a change is written to. Global = the user's `~/.claude/settings.json`;
/// Repository = the project's `.claude/settings.local.json` — this repository, on this
/// machine, never committed (the app makes git ignore it before writing it). The shared
/// `.claude/settings.json` is never written: it would change the team's setup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SettingsTarget {
    Global,
    Repository,
}

/// macOS location of the organization policy file.
const MANAGED_SETTINGS: &str = "/Library/Application Support/ClaudeCode/managed-settings.json";
/// Where a repository's machine-local settings live, relative to its root.
const REPO_LOCAL_SETTINGS: &str = ".claude/settings.local.json";

/// The root whose `.claude/` a session in `path` reads: the working tree's root (a
/// worktree's own), or `path` itself outside a repository.
pub fn project_root(path: &str) -> String {
    crate::git::toplevel(path).unwrap_or_else(|| path.to_string())
}

/// Read every MCP-relevant rule, and every plugin on/off, from the managed, local, project
/// and user settings files (`repo_path` = the project they are evaluated for; `None` reads
/// only the files that don't depend on one).
pub fn read_mcp_permission_rules(repo_path: Option<&str>) -> PermissionRulesView {
    let mut files: Vec<(RuleSource, PathBuf)> = vec![(RuleSource::Managed, PathBuf::from(MANAGED_SETTINGS))];
    let mut view = PermissionRulesView::default();
    if let Some(repo) = repo_path.filter(|r| !r.is_empty()) {
        let root = project_root(repo);
        let dir = Path::new(&root).join(".claude");
        files.push((RuleSource::Local, dir.join("settings.local.json")));
        files.push((RuleSource::Project, dir.join("settings.json")));
        view.repo_root = Some(root);
    }
    match home_dir() {
        Some(home) => files.push((RuleSource::User, home.join(".claude/settings.json"))),
        None => view.user_error = Some("home directory ($HOME) not found".to_string()),
    }
    for (source, path) in files {
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                note_unreadable(&mut view, source, format!("{} unreadable: {e}", path.display()));
                continue;
            }
        };
        let shown = path.display().to_string();
        match rules_in_document(&text).and_then(|r| Ok((r, plugins_in_document(&text)?))) {
            Ok((rules, plugins)) => {
                view.rules.extend(rules.into_iter().map(|(rule, kind)| PermissionRule {
                    rule,
                    kind,
                    source,
                    path: shown.clone(),
                }));
                view.plugins.extend(plugins.into_iter().map(|(plugin_id, enabled)| PluginOverride {
                    plugin_id,
                    enabled,
                    source,
                    path: shown.clone(),
                }));
            }
            Err(e) => note_unreadable(&mut view, source, format!("{shown}: {e}")),
        }
    }
    view
}

fn note_unreadable(view: &mut PermissionRulesView, source: RuleSource, msg: String) {
    if source == RuleSource::User {
        view.user_error = Some(msg.clone());
    }
    if source == RuleSource::Local {
        view.local_error = Some(msg.clone());
    }
    view.warnings.push(msg);
}

/// Pure: the `enabledPlugins` entries of one settings document.
fn plugins_in_document(text: &str) -> Result<Vec<(String, bool)>, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("corrupt: {e}"))?;
    Ok(root
        .get("enabledPlugins")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b))).collect())
        .unwrap_or_default())
}

/// The file a change is written to, created (with its directory) if needed. For the
/// repository file, git is first told to ignore it — in the clone's own `info/exclude`,
/// never a tracked `.gitignore` — so a machine-local setting can't be committed.
fn target_file(target: SettingsTarget, repo_path: Option<&str>) -> Result<PathBuf, String> {
    match target {
        SettingsTarget::Global => {
            Ok(home_dir().ok_or("home directory ($HOME) not found")?.join(".claude/settings.json"))
        }
        SettingsTarget::Repository => {
            let repo = repo_path.filter(|r| !r.is_empty()).ok_or("no repository to write to")?;
            let root = project_root(repo);
            crate::git::ignore_locally(&root, REPO_LOCAL_SETTINGS)
                .map_err(|e| format!("could not make git ignore {REPO_LOCAL_SETTINGS}: {e}"))?;
            Ok(Path::new(&root).join(REPO_LOCAL_SETTINGS))
        }
    }
}

/// Turn a plugin on or off in one file — or remove that file's say (`None`), so the
/// plugin follows the files below it again. Read back and verified.
pub fn set_plugin_override(
    plugin_id: &str,
    enabled: Option<bool>,
    target: SettingsTarget,
    repo_path: Option<&str>,
) -> Result<(), String> {
    if !crate::supervisor::model::is_plugin_id(plugin_id) {
        return Err(format!("not a plugin id: {plugin_id:?}"));
    }
    let path = target_file(target, repo_path)?;
    write_settings_file(&path, |text| apply_plugin_override(text, plugin_id, enabled))?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("re-reading {}: {e}", path.display()))?;
    let now = plugins_in_document(&text)?.into_iter().find(|(id, _)| id == plugin_id).map(|(_, b)| b);
    if now != enabled {
        return Err(format!(
            "{} does not hold the plugin setting just written — another program may have changed it",
            path.display()
        ));
    }
    Ok(())
}

/// Pure transform: set or remove `enabledPlugins[plugin_id]`, dropping an emptied map.
fn apply_plugin_override(text: &str, plugin_id: &str, enabled: Option<bool>) -> Result<String, String> {
    let mut root: Value = serde_json::from_str(text).map_err(|e| format!("settings unreadable: {e}"))?;
    let obj = root.as_object_mut().ok_or("settings file is not a JSON object")?;
    if obj.get("enabledPlugins").is_some_and(|v| !v.is_object()) {
        return Err("`enabledPlugins` is not an object".to_string());
    }
    let map = obj
        .entry("enabledPlugins")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .expect("checked above");
    match enabled {
        Some(b) => {
            map.insert(plugin_id.to_string(), Value::Bool(b));
        }
        None => {
            map.remove(plugin_id);
        }
    }
    if map.is_empty() {
        obj.remove("enabledPlugins");
    }
    serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialization: {e}"))
}

/// Pure: the MCP-relevant `(rule, kind)` pairs of one settings document. A rule is kept when
/// it can match an MCP tool: it names one (`mcp__…`) or is a tool-name glob (`*`, `m*`…).
/// Rules with parentheses are skipped — the CLI ignores an `mcp__` rule that has them, and
/// every other parenthesized rule scopes a built-in tool.
fn rules_in_document(text: &str) -> Result<Vec<(String, ToolRuleKind)>, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("corrupt: {e}"))?;
    let Some(perms) = root.get("permissions") else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for kind in ToolRuleKind::ALL {
        let Some(list) = perms.get(kind.key()).and_then(Value::as_array) else {
            continue;
        };
        for rule in list.iter().filter_map(Value::as_str) {
            let rule = rule.trim();
            if rule.contains('(') {
                continue;
            }
            if rule.starts_with("mcp__") || rule.contains('*') {
                out.push((rule.to_string(), kind));
            }
        }
    }
    Ok(out)
}

/// Apply `changes` to the target file (global or this repository's local one), then read
/// the file back and check every change landed ("written" is not "in effect" — a
/// concurrent writer, or a file the CLI rewrote, would otherwise go unnoticed).
pub fn set_mcp_tool_permissions(
    changes: &[McpToolPermissionChange],
    target: SettingsTarget,
    repo_path: Option<&str>,
) -> Result<(), String> {
    for c in changes {
        validate_tool_name(&c.tool)?;
    }
    if changes.is_empty() {
        return Ok(());
    }
    let path = target_file(target, repo_path)?;
    write_settings_file(&path, |text| apply_mcp_tool_permissions(text, changes))?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("re-reading {}: {e}", path.display()))?;
    let now = rules_in_document(&text)?;
    for c in changes {
        let have: Vec<ToolRuleKind> =
            now.iter().filter(|(r, _)| r == &c.tool).map(|(_, k)| *k).collect();
        let want: Vec<ToolRuleKind> = c.kind.into_iter().collect();
        if have != want {
            return Err(format!(
                "settings.json does not hold the rule just written for {} — another program may have changed it",
                c.tool
            ));
        }
    }
    Ok(())
}

/// Only an MCP rule may be written: one tool (`mcp__<server>__<tool>`) or one whole server
/// (`mcp__<server>`, how a server is turned off), no glob, no parentheses, no whitespace.
/// The app manages MCP rules and nothing else — this keeps a caller from slipping a broad
/// rule (`*`, `Bash`) into a settings file.
fn validate_tool_name(tool: &str) -> Result<(), String> {
    if crate::supervisor::model::is_mcp_rule_name(tool) {
        Ok(())
    } else {
        Err(format!("not an MCP rule: {tool:?}"))
    }
}

/// Pure transform: for each change, remove the tool's exact rule from all three lists, then
/// add it to the chosen one. Every other rule, key and its order is preserved; a list (or
/// the whole `permissions` object) left empty by the edit is dropped, since absent == empty.
/// A `permissions` value of the wrong type is an error, never overwritten.
fn apply_mcp_tool_permissions(
    text: &str,
    changes: &[McpToolPermissionChange],
) -> Result<String, String> {
    let mut root: Value =
        serde_json::from_str(text).map_err(|e| format!("settings.json unreadable: {e}"))?;
    let obj = root.as_object_mut().ok_or("settings.json is not a JSON object")?;
    let perms = obj
        .entry("permissions")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("settings.json `permissions` is not an object")?;
    for kind in ToolRuleKind::ALL {
        if perms.get(kind.key()).is_some_and(|v| !v.is_array()) {
            return Err(format!("settings.json `permissions.{}` is not a list", kind.key()));
        }
    }
    for c in changes {
        for kind in ToolRuleKind::ALL {
            if let Some(list) = perms.get_mut(kind.key()).and_then(Value::as_array_mut) {
                list.retain(|v| v.as_str().map(str::trim) != Some(c.tool.as_str()));
            }
        }
        if let Some(kind) = c.kind {
            perms
                .entry(kind.key())
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("checked above")
                .push(Value::String(c.tool.clone()));
        }
    }
    for kind in ToolRuleKind::ALL {
        if perms.get(kind.key()).and_then(Value::as_array).is_some_and(Vec::is_empty) {
            perms.remove(kind.key());
        }
    }
    if perms.is_empty() {
        obj.remove("permissions");
    }
    serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialization: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GMAIL_SEND: &str = "mcp__claude_ai_Gmail__send_message";

    fn change(tool: &str, kind: Option<ToolRuleKind>) -> McpToolPermissionChange {
        McpToolPermissionChange { tool: tool.to_string(), kind }
    }

    #[test]
    fn a_rule_moves_between_lists_and_nothing_else_changes() {
        let text = r#"{"model":"opus","permissions":{"allow":["Bash(ls *)","mcp__claude_ai_Gmail__send_message"],"defaultMode":"auto"}}"#;
        let out = apply_mcp_tool_permissions(text, &[change(GMAIL_SEND, Some(ToolRuleKind::Ask))]).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["permissions"]["allow"], serde_json::json!(["Bash(ls *)"]));
        assert_eq!(v["permissions"]["ask"], serde_json::json!([GMAIL_SEND]));
        assert_eq!(v["permissions"]["defaultMode"], "auto");
        assert_eq!(v["model"], "opus");
        // Key order kept: `model` still first, `defaultMode` still after `allow`.
        assert!(out.find("\"model\"").unwrap() < out.find("\"permissions\"").unwrap());
        assert!(out.find("\"allow\"").unwrap() < out.find("\"defaultMode\"").unwrap());
    }

    #[test]
    fn clearing_the_last_rule_leaves_no_empty_husk() {
        let text = r#"{"permissions":{"deny":["mcp__claude_ai_Gmail__send_message"]}}"#;
        let out = apply_mcp_tool_permissions(text, &[change(GMAIL_SEND, None)]).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn setting_twice_never_duplicates() {
        let once = apply_mcp_tool_permissions("{}", &[change(GMAIL_SEND, Some(ToolRuleKind::Deny))]).unwrap();
        let twice = apply_mcp_tool_permissions(&once, &[change(GMAIL_SEND, Some(ToolRuleKind::Deny))]).unwrap();
        let v: Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(v["permissions"]["deny"], serde_json::json!([GMAIL_SEND]));
    }

    #[test]
    fn a_malformed_permissions_value_is_an_error_not_overwritten() {
        assert!(apply_mcp_tool_permissions(r#"{"permissions":"yes"}"#, &[change(GMAIL_SEND, None)]).is_err());
        assert!(
            apply_mcp_tool_permissions(r#"{"permissions":{"ask":"x"}}"#, &[change(GMAIL_SEND, None)]).is_err()
        );
    }

    #[test]
    fn only_mcp_tool_or_server_rules_may_be_written() {
        assert!(validate_tool_name(GMAIL_SEND).is_ok());
        assert!(validate_tool_name("mcp__claude_ai_Gmail").is_ok(), "a whole server (turning it off)");
        for bad in ["*", "Bash", "mcp__", "mcp__claude_ai_Gmail__*", "mcp__x__y(z)", "mcp__x__a b", "mcp____y", "mcp__x__"] {
            assert!(validate_tool_name(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_plugin_override_is_set_then_removed_cleanly() {
        let text = r#"{"model":"opus","enabledPlugins":{"a@m":true}}"#;
        let on = apply_plugin_override(text, "b@m", Some(false)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&on).unwrap()["enabledPlugins"], serde_json::json!({"a@m":true,"b@m":false}));
        let back = apply_plugin_override(&on, "b@m", None).unwrap();
        let back = apply_plugin_override(&back, "a@m", None).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&back).unwrap(), serde_json::json!({"model":"opus"}));
        assert_eq!(plugins_in_document(&on).unwrap(), vec![("a@m".to_string(), true), ("b@m".to_string(), false)]);
    }

    /// The Repository scope writes `.claude/settings.local.json` — and makes git ignore it
    /// first, in the clone's own `info/exclude`, so it can never be committed.
    #[test]
    fn repository_writes_land_in_an_ignored_local_file() {
        let dir = std::env::temp_dir().join(format!("tosse-perm-repo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_str().unwrap();
        let git = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(repo).args(args).output().unwrap();
        git(&["init", "-q"]);
        set_mcp_tool_permissions(&[change(GMAIL_SEND, Some(ToolRuleKind::Deny))], SettingsTarget::Repository, Some(repo)).unwrap();
        let written = std::fs::read_to_string(dir.join(REPO_LOCAL_SETTINGS)).unwrap();
        assert!(written.contains(GMAIL_SEND));
        assert_eq!(crate::git::path_is_ignored(repo, REPO_LOCAL_SETTINGS), Some(true));
        let view = read_mcp_permission_rules(Some(repo));
        assert!(view.rules.iter().any(|r| r.rule == GMAIL_SEND && r.source == RuleSource::Local));
        // A second write doesn't pile up exclude lines (zero when the machine's own global
        // gitignore already covers the file — then nothing is added at all).
        set_plugin_override("x@m", Some(false), SettingsTarget::Repository, Some(repo)).unwrap();
        let exclude = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap_or_default();
        assert!(exclude.matches("settings.local.json").count() <= 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_only_the_rules_that_can_reach_an_mcp_tool() {
        let text = r#"{"permissions":{
            "allow":["Bash(npm test)","Read","mcp__Railway__list-projects"],
            "ask":["mcp__claude_ai_Slack__*"],
            "deny":["*","mcp__x__y(z)","WebFetch"]}}"#;
        let rules = rules_in_document(text).unwrap();
        assert_eq!(
            rules,
            vec![
                ("mcp__Railway__list-projects".to_string(), ToolRuleKind::Allow),
                ("mcp__claude_ai_Slack__*".to_string(), ToolRuleKind::Ask),
                ("*".to_string(), ToolRuleKind::Deny),
            ]
        );
        assert!(rules_in_document("{").is_err(), "a broken file is not an empty one");
        assert_eq!(rules_in_document(r#"{"model":"x"}"#).unwrap(), vec![]);
    }
}
