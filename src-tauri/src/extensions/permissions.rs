//! Claude Code's own MCP permission rules and plugin on/off, READ from every settings file
//! that can hold them — the baseline Flight Deck's own cascade (Global → repository →
//! conversation, resolved front-side and delivered per session) starts from. Nothing here
//! writes: Flight Deck never edits Claude Code's files for these.
//!
//! ## What a Claude Code rule does (verified against the docs and binary 2.1.280)
//! - `deny` on a bare tool name (`mcp__claude_ai_Gmail__send_message` IS a bare name — an
//!   `mcp__` rule never takes parentheses) removes the tool from Claude's context, in every
//!   permission mode — nothing can override that.
//! - `ask` prompts on every call, even in `auto` and `bypassPermissions` — Flight Deck
//!   answers that prompt when its own setting says Allow (the session's auto-allow).
//! - `allow` runs the tool without a prompt.
//! - deny > ask > allow, whatever the rule's specificity or the file it sits in.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::home_dir;

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

/// The settings file a rule was read from.
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

/// One Claude Code permission rule that can concern an MCP tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PermissionRule {
    /// The rule verbatim (`mcp__claude_ai_Gmail__send_message`, `mcp__claude_ai_Gmail`,
    /// `mcp__claude_ai_Gmail__*`, `mcp__*`, `*`…).
    pub rule: String,
    pub kind: ToolRuleKind,
    pub source: RuleSource,
    /// The file it was read from.
    pub path: String,
}

/// One file's say on one plugin: `enabledPlugins[id]` in that settings file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PluginOverride {
    pub plugin_id: String,
    pub enabled: bool,
    pub source: RuleSource,
    pub path: String,
}

/// Claude Code's MCP rules and plugin on/off visible to a repository.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct PermissionRulesView {
    pub rules: Vec<PermissionRule>,
    /// Every `enabledPlugins` entry, per file.
    pub plugins: Vec<PluginOverride>,
    /// Files that exist but could not be read or parsed (their say is unknown).
    pub warnings: Vec<String>,
    /// The project root the local/project files were read from (a worktree's own root).
    pub repo_root: Option<String>,
}

/// macOS location of the organization policy file.
const MANAGED_SETTINGS: &str = "/Library/Application Support/ClaudeCode/managed-settings.json";

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
        None => view.warnings.push("home directory ($HOME) not found".to_string()),
    }
    for (source, path) in files {
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                view.warnings.push(format!("{} unreadable: {e}", path.display()));
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
            Err(e) => view.warnings.push(format!("{shown}: {e}")),
        }
    }
    view
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_plugin_say_of_a_file() {
        let text = r#"{"model":"opus","enabledPlugins":{"a@m":true,"b@m":false,"junk":"x"}}"#;
        assert_eq!(
            plugins_in_document(text).unwrap(),
            vec![("a@m".to_string(), true), ("b@m".to_string(), false)]
        );
        assert!(plugins_in_document(r#"{}"#).unwrap().is_empty());
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
