//! Which model each sub-agent will actually run on — assembled from what is on disk.
//!
//! ## The resolution order this models (verified on CLI 2.1.263)
//!
//! 1. a `model` passed at spawn (the Agent tool's parameter, a workflow's `opts.model`)
//! 2. `model:` in the agent definition's frontmatter
//! 3. `CLAUDE_CODE_SUBAGENT_MODEL`
//! 4. otherwise: the conversation's own model
//!
//! ⚠️ That order CHANGED in 2.1.251 (the env var used to come first and beat everything).
//! It is a moving contract, so this module reports what it BELIEVES will happen and the
//! spend dashboard checks that belief against what actually ran — see the drift canary.
//! Nothing here assumes the order will hold forever.
//!
//! Two more verified facts shape the payload:
//!   • `CLAUDE_CODE_SUBAGENT_MODEL` reaches neither `Explore` nor `Plan`; both keep
//!     inheriting the conversation. Those two therefore need a definition FILE to be
//!     steered, which is why [`AgentRouting::needs_file_to_steer`] exists.
//!   • `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` reaches them, but by overriding levels 1 and 2 —
//!     every per-agent choice at once. It is reported, never assumed.

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{AgentInfo, ExtScope, SubagentBaseline, BASELINE_BLIND_SPOTS};

/// Where a sub-agent's current model setting comes from — the "origin" column, in terms a
/// person can act on rather than file paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RoutingOrigin {
    /// A definition file in `~/.claude/agents/`.
    User,
    /// A definition file in the repository's `.claude/agents/`.
    Project,
    /// Bound to this repository but kept out of what it shares.
    Local,
    /// Provided by an installed plugin.
    Plugin,
    /// A built-in with no definition file: it follows the baseline, or the conversation.
    BuiltIn,
}

/// One row of the routing page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentRouting {
    /// The name the CLI dispatches on. For a built-in this is a contract with Anthropic
    /// that is nowhere documented — if it is ever renamed, an override silently stops
    /// applying, which is what the drift canary watches for.
    pub name: String,
    pub description: Option<String>,
    /// The model this agent will run on, as far as we can tell, or `None` for "whatever
    /// the conversation is using".
    pub effective_model: Option<String>,
    /// The effort pinned in the definition, when it has one.
    pub effort: Option<String>,
    pub origin: RoutingOrigin,
    /// Path of the definition file, when there is one.
    pub path: Option<String>,
    /// True when this agent is a CLI built-in (whether or not a file now shadows it).
    pub built_in: bool,
    /// True when a definition file shadows a built-in of the same name — the case where
    /// the file supplies the ENTIRE agent, system prompt included.
    pub shadows_built_in: bool,
    /// True for the built-ins the baseline env var cannot reach: steering them at all
    /// requires a definition file.
    pub needs_file_to_steer: bool,
    /// True when a forcing baseline is set, which overrides this row whatever it says.
    pub overridden_by_force: bool,
    /// When this setting last changed, in epoch milliseconds — the mtime of whatever file
    /// holds it (the agent's own definition, or `settings.json` for a baseline-driven row).
    ///
    /// Load-bearing for the drift canary, not decoration. Without it the canary compares
    /// today's setting against a week of transcripts that mostly PREDATE it, so it fires
    /// every time you change a model — the one moment you are most sure the app is broken.
    /// No new bookkeeping is needed: the file holding the setting already records when it
    /// was written.
    pub configured_at_ms: Option<i64>,
}

/// Everything the routing section needs, in one read.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SubagentRouting {
    pub agents: Vec<AgentRouting>,
    pub baseline: SubagentBaseline,
    /// `~/.claude/agents` — where a global definition would be written.
    pub user_agents_dir: String,
    /// `<repo>/.claude/agents` — where a project definition would be written.
    pub project_agents_dir: String,
    /// Whether git would ignore the project directory. `None` = could not check, which the
    /// UI must render as "unknown", never as "fine".
    pub project_dir_ignored: Option<bool>,
    /// Whether the repository we are looking at is itself a worktree — a project-scoped
    /// setting written here would not exist in the main checkout, or in the next worktree.
    pub repo_is_worktree: bool,
}

/// The built-in sub-agents this app knows how to talk about. Deliberately a SHORT list of
/// the ones a user would want to steer, not a mirror of everything the CLI ships: rows the
/// user cannot act on are noise. Any built-in missing here still shows up the moment a
/// definition file exists for it, and the live-name canary is what catches a rename.
const KNOWN_BUILT_INS: [(&str, &str); 3] = [
    (
        "Explore",
        "Sweeps the codebase to locate something. Read-only — it finds code, it does not review or change it.",
    ),
    (
        "Plan",
        "Designs how a change should be made before any code is written.",
    ),
    (
        "general-purpose",
        "The catch-all helper for multi-step work that has no more specific agent.",
    ),
];

/// Build the routing picture from the agent definitions found on disk plus the baseline.
///
/// Pure: every input is passed in, so the ordering and shadowing rules are unit-testable
/// without a filesystem, a repository, or a `~/.claude`.
pub fn resolve_routing(
    agents: &[AgentInfo],
    baseline: &SubagentBaseline,
    user_agents_dir: &str,
    project_agents_dir: &str,
    project_dir_ignored: Option<bool>,
    repo_is_worktree: bool,
    baseline_changed_at: Option<i64>,
) -> SubagentRouting {
    let forced = baseline.forced_model.is_some();
    let mut rows: Vec<AgentRouting> = Vec::new();

    // Definition files first — a file always wins over the built-in of the same name, so
    // this is also the shadow list.
    for agent in agents {
        let built_in = KNOWN_BUILT_INS.iter().any(|(n, _)| *n == agent.name);
        rows.push(AgentRouting {
            name: agent.name.clone(),
            description: agent.description.clone(),
            // Level 2 beats level 3: a definition's own `model:` stands, and only when it
            // has none does the baseline apply.
            effective_model: agent.model.clone().or_else(|| baseline.model.clone()),
            effort: agent.effort.clone(),
            origin: match agent.scope {
                ExtScope::User => RoutingOrigin::User,
                ExtScope::Project => RoutingOrigin::Project,
                ExtScope::Local => RoutingOrigin::Local,
                ExtScope::Plugin => RoutingOrigin::Plugin,
            },
            path: Some(agent.path.clone()),
            built_in,
            shadows_built_in: built_in,
            // It has a file already, so it is steerable whatever the env var cannot reach.
            needs_file_to_steer: false,
            overridden_by_force: forced,
            configured_at_ms: mtime_ms(Path::new(&agent.path)),
        });
    }

    // Then the built-ins nothing on disk has claimed yet.
    for (name, description) in KNOWN_BUILT_INS {
        if rows.iter().any(|r| r.name == name) {
            continue;
        }
        let blind = BASELINE_BLIND_SPOTS.contains(&name);
        rows.push(AgentRouting {
            name: name.to_string(),
            description: Some(description.to_string()),
            // The blind spots ignore the baseline entirely: reporting the baseline's model
            // for them would be the exact lie this page exists to prevent.
            effective_model: if blind { None } else { baseline.model.clone() },
            effort: None,
            origin: RoutingOrigin::BuiltIn,
            path: None,
            built_in: true,
            shadows_built_in: false,
            needs_file_to_steer: blind,
            overridden_by_force: forced,
            // A blind spot follows nothing, so nothing has been "configured" for it; the
            // rest follow the baseline, and settings.json records when that last moved.
            configured_at_ms: if blind { None } else { baseline_changed_at },
        });
    }

    // Built-ins first (they are what a user comes here to change), then everything else
    // alphabetically, so the list does not reshuffle between reads.
    rows.sort_by(|a, b| {
        let rank = |r: &AgentRouting| {
            KNOWN_BUILT_INS.iter().position(|(n, _)| *n == r.name).unwrap_or(usize::MAX)
        };
        rank(a).cmp(&rank(b)).then_with(|| a.name.cmp(&b.name))
    });

    SubagentRouting {
        agents: rows,
        baseline: baseline.clone(),
        user_agents_dir: user_agents_dir.to_string(),
        project_agents_dir: project_agents_dir.to_string(),
        project_dir_ignored,
        repo_is_worktree,
    }
}

/// Whether a path sits inside a git worktree created by this app's convention
/// (`.claude/worktrees/<name>`). A project-scoped agent written here would be invisible
/// from the main checkout and from every other worktree.
pub fn is_worktree_path(repo_path: &str) -> bool {
    repo_path.contains("/.claude/worktrees/")
}

/// Assemble the routing picture for a repository, reading everything it needs.
pub fn routing_for(repo_path: &str) -> SubagentRouting {
    let snapshot = super::list_extensions(repo_path);
    let baseline = super::subagent_baseline();
    let user_dir = super::home_dir()
        .map(|h| h.join(".claude/agents").to_string_lossy().into_owned())
        .unwrap_or_default();
    let project_dir =
        Path::new(repo_path).join(".claude/agents").to_string_lossy().into_owned();
    let ignored = crate::git::path_is_ignored(repo_path, ".claude/agents/");
    resolve_routing(
        &snapshot.agents,
        &baseline,
        &user_dir,
        &project_dir,
        ignored,
        is_worktree_path(repo_path),
        super::home_dir().and_then(|h| mtime_ms(&h.join(".claude/settings.json"))),
    )
}

/// A file's last-modified time in epoch milliseconds; `None` when it cannot be read.
fn mtime_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let stamp = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(stamp.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str, model: Option<&str>, scope: ExtScope) -> AgentInfo {
        AgentInfo {
            name: name.to_string(),
            description: Some("d".into()),
            model: model.map(str::to_string),
            effort: None,
            scope,
            source: None,
            path: format!("/agents/{name}.md"),
        }
    }

    fn baseline(model: Option<&str>, forced: Option<&str>) -> SubagentBaseline {
        SubagentBaseline {
            model: model.map(str::to_string),
            forced_model: forced.map(str::to_string),
            unreachable_builtins: BASELINE_BLIND_SPOTS.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn row<'a>(r: &'a SubagentRouting, name: &str) -> &'a AgentRouting {
        r.agents.iter().find(|a| a.name == name).expect("row present")
    }

    #[test]
    fn built_ins_are_listed_even_with_nothing_on_disk() {
        let r = resolve_routing(&[], &baseline(None, None), "/u", "/p", Some(false), false, None);
        assert_eq!(r.agents.len(), 3);
        assert_eq!(r.agents[0].name, "Explore", "the built-ins lead, in their own order");
        assert_eq!(r.agents[1].name, "Plan");
        assert_eq!(r.agents[2].name, "general-purpose");
        assert!(r.agents.iter().all(|a| a.origin == RoutingOrigin::BuiltIn));
    }

    #[test]
    fn the_baseline_reaches_general_purpose_but_not_explore_or_plan() {
        let r = resolve_routing(&[], &baseline(Some("haiku"), None), "/u", "/p", None, false, None);
        assert_eq!(row(&r, "general-purpose").effective_model.as_deref(), Some("haiku"));
        // The whole point: reporting "haiku" here would be the lie this page prevents.
        assert_eq!(row(&r, "Explore").effective_model, None);
        assert_eq!(row(&r, "Plan").effective_model, None);
        assert!(row(&r, "Explore").needs_file_to_steer);
        assert!(row(&r, "Plan").needs_file_to_steer);
        assert!(!row(&r, "general-purpose").needs_file_to_steer);
    }

    #[test]
    fn a_definition_file_shadows_the_built_in_and_wins_over_the_baseline() {
        let agents = [agent("Explore", Some("haiku"), ExtScope::User)];
        let r = resolve_routing(&agents, &baseline(Some("sonnet"), None), "/u", "/p", None, false, None);
        let explore = row(&r, "Explore");
        assert_eq!(explore.effective_model.as_deref(), Some("haiku"), "frontmatter beats env");
        assert_eq!(explore.origin, RoutingOrigin::User);
        assert!(explore.shadows_built_in, "a file named after a built-in replaces it whole");
        assert!(!explore.needs_file_to_steer, "it now has the file it needed");
        assert_eq!(r.agents.len(), 3, "the shadowed built-in is not listed twice");
    }

    #[test]
    fn a_definition_without_a_model_falls_through_to_the_baseline() {
        let agents = [agent("my-helper", None, ExtScope::Project)];
        let r = resolve_routing(&agents, &baseline(Some("haiku"), None), "/u", "/p", None, false, None);
        assert_eq!(row(&r, "my-helper").effective_model.as_deref(), Some("haiku"));
        assert_eq!(row(&r, "my-helper").origin, RoutingOrigin::Project);
    }

    #[test]
    fn a_custom_agent_is_listed_after_the_built_ins() {
        let agents = [agent("aaa-custom", Some("opus"), ExtScope::User)];
        let r = resolve_routing(&agents, &baseline(None, None), "/u", "/p", None, false, None);
        assert_eq!(r.agents.len(), 4);
        assert_eq!(
            r.agents.last().unwrap().name,
            "aaa-custom",
            "alphabetically first, but still below the built-ins"
        );
    }

    #[test]
    fn a_forcing_baseline_marks_every_row_as_overridden() {
        let agents = [agent("Explore", Some("haiku"), ExtScope::User)];
        let r = resolve_routing(
            &agents,
            &baseline(Some("haiku"), Some("haiku")),
            "/u",
            "/p",
            None,
            false,
            None,
        );
        assert!(r.agents.iter().all(|a| a.overridden_by_force));
        assert_eq!(r.baseline.forced_model.as_deref(), Some("haiku"));
    }

    #[test]
    fn plugin_agents_are_reported_as_plugin_owned() {
        let agents = [agent("tosse-manager", Some("opus"), ExtScope::Plugin)];
        let r = resolve_routing(&agents, &baseline(None, None), "/u", "/p", None, false, None);
        assert_eq!(row(&r, "tosse-manager").origin, RoutingOrigin::Plugin);
    }

    #[test]
    fn an_unknown_ignore_verdict_stays_unknown() {
        let r = resolve_routing(&[], &baseline(None, None), "/u", "/p", None, false, None);
        assert_eq!(r.project_dir_ignored, None, "\"could not check\" is not \"not ignored\"");
    }

    #[test]
    fn worktree_paths_are_recognised() {
        assert!(is_worktree_path("/r/tosse-code/.claude/worktrees/feat-x"));
        assert!(is_worktree_path("/r/tosse-code/.claude/worktrees/feat-x/src-tauri"));
        assert!(!is_worktree_path("/r/tosse-code"));
        assert!(!is_worktree_path("/r/worktrees/x"));
    }
}
