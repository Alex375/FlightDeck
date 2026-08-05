//! Claude Code extension config — the ONE place in the core that reads Claude's
//! on-disk configuration (MCP servers, plugins, skills, sub-agents) across scopes.
//!
//! Same encapsulation contract as [`crate::store::db`] (SQL) and [`crate::git`]
//! (the `git` CLI): everything outside this module deals only in the domain types
//! below ([`ExtensionsSnapshot`] and friends). Nothing else parses `~/.claude*`
//! files. Swapping where/how the config is read means rewriting this file alone.
//!
//! ## What it reads, and where
//! This is the *configured* picture — it works without any live `claude` process
//! (the lazy-spawn model means a conversation often has none). The *live* picture
//! (real connection status per session) comes from `system/init` and is merged in
//! by the UI. The two are complementary; see the protocol parser.
//!
//! | Scope    | MCP servers                                   | Plugins / skills / agents |
//! |----------|-----------------------------------------------|---------------------------|
//! | User     | `~/.claude.json` → `mcpServers`               | `~/.claude/{skills,agents}/`, plugins enabled in `~/.claude/settings.json` |
//! | Project  | `<repo>/.mcp.json`, `~/.claude.json` → `projects[repo].mcpServers` | `<repo>/.claude/{skills,agents}/` |
//! | Plugin   | each enabled plugin's `.mcp.json`             | each enabled plugin's `skills/` + `agents/` |
//!
//! Plugin install metadata lives in `~/.claude/plugins/installed_plugins.json`
//! (registry, with per-install scope) and the per-plugin cache dir it points to.
//!
//! ## Secrets
//! MCP `env`, `args` and `headers` can carry tokens, so they are NEVER read into
//! the domain types — only `command`, `transport` and a query-stripped `url` are
//! surfaced. The redaction happens here, at the boundary, so no secret can reach
//! the IPC layer or the UI.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

/// Where a configuration entry originates. Drives the "by scope" grouping in the
/// UI. Serialized snake_case so the TS union is `"user" | "project" | …`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExtScope {
    /// Configured globally for the user (`~/.claude*`).
    User,
    /// Shared by the repository (committed `.mcp.json` / `.claude/`), or the
    /// project section of `~/.claude.json`.
    Project,
    /// Bound to this project but kept local (not shared) — `settings.local.json`
    /// or a `local`-scoped plugin install.
    Local,
    /// Provided by an installed plugin.
    Plugin,
}

/// One MCP server visible to a repository, with its resolved enabled state. The
/// live connection status (connected / needs-auth / …) is NOT here — it comes
/// from the running session's `system/init` and is merged by the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct McpServerInfo {
    pub name: String,
    pub scope: ExtScope,
    /// `"stdio"` | `"http"` | `"sse"` when declared (stdio is the implicit default).
    pub transport: Option<String>,
    /// Launch command for a stdio server (e.g. `npx`, `railway`). Args omitted
    /// (may carry secrets).
    pub command: Option<String>,
    /// Endpoint for an http/sse server, with any query string stripped.
    pub url: Option<String>,
    /// Plugin id (`<plugin>@<marketplace>`) when `scope == Plugin`.
    pub source: Option<String>,
    /// Resolved on-disk enabled state for this repo (project toggles applied).
    pub enabled: bool,
}

/// One installed plugin relevant to a repository (user-global, or project/local
/// scoped to this repo).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PluginInfo {
    /// `<plugin>@<marketplace>` — the key used in `enabledPlugins`.
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub enabled: bool,
    pub scope: ExtScope,
    /// Whether the plugin's installed pin differs from its marketplace's currently
    /// downloaded pin (compared on-disk — see [`compute_update`]). Only as fresh as
    /// the last `claude plugin marketplace update`; the UI's "Check" button runs
    /// that refresh then re-reads. Never a false positive: unknown pins → `false`.
    pub update_available: bool,
    /// The marketplace's human version when it is KNOWN and DIFFERS from the installed
    /// one (for a "vX → vY" badge). `None` for sha-only updates (a new commit with the
    /// same semver) — the UI falls back to a generic "Update available" then.
    pub latest_version: Option<String>,
    /// What the plugin provides (scanned from its cache dir), regardless of
    /// enabled state — so the UI can show "5 skills" even when toggled off.
    pub skill_count: u32,
    pub agent_count: u32,
    pub command_count: u32,
    pub mcp_count: u32,
}

/// One marketplace registered with Claude Code (`~/.claude/plugins/known_marketplaces.json`),
/// with its resolved auto-update state. Auto-update is a PER-MARKETPLACE flag (the only
/// granularity the CLI exposes — there is no per-plugin auto-update). The count of
/// plugins with an update available is derived on the UI side by grouping [`PluginInfo`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct MarketplaceInfo {
    /// Registry key (`tosse-plugins`, `claude-plugins-official`, …) — matches the
    /// `<marketplace>` half of a plugin id.
    pub name: String,
    /// Short human source (a `owner/repo`, a URL, or the source kind) for display.
    pub source: String,
    /// Resolved auto-update: `settings.json` `extraKnownMarketplaces[name].autoUpdate`
    /// (what we write, and what the CLI reads) takes precedence over the mirrored
    /// `known_marketplaces.json` flag. Absent in both = off.
    pub auto_update: bool,
}

/// One skill available to a repository (file-based or plugin-provided).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SkillInfo {
    pub name: String,
    pub description: Option<String>,
    pub scope: ExtScope,
    /// Plugin id when plugin-provided; `None` for a user/project file skill.
    pub source: Option<String>,
    /// Absolute path to the skill's `SKILL.md` — the UI reads it to render a clean
    /// markdown view of the skill.
    pub path: String,
    /// Per-skill toggle state. Claude has no per-skill toggle (always `true` there);
    /// Codex resolves it from its `[[skills.config]]` entries (Extensions v2).
    pub enabled: bool,
}

/// One sub-agent available to a repository (file-based or plugin-provided).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentInfo {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub scope: ExtScope,
    pub source: Option<String>,
    /// Absolute path to the agent's `.md` definition — the UI reads it to render a
    /// clean markdown view of the sub-agent.
    pub path: String,
}

/// The full configured picture for one repository, across all scopes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ExtensionsSnapshot {
    pub mcp_servers: Vec<McpServerInfo>,
    pub plugins: Vec<PluginInfo>,
    pub skills: Vec<SkillInfo>,
    pub agents: Vec<AgentInfo>,
    /// Config files that exist but could NOT be read/parsed (corrupt JSON, IO error).
    /// The scan still degrades to a usable snapshot, but these are surfaced so a
    /// broken config is never indiscernible from "nothing configured" — without them
    /// a corrupt `~/.claude.json` reads as an empty inventory, and a corrupt
    /// `settings.json` would (wrongly) show every plugin as enabled. Empty = clean.
    pub warnings: Vec<String>,
}

/// Everything ONE plugin provides — for the per-plugin explorer (click a plugin →
/// browse its skills / sub-agents / MCP servers, like Claude.ai's Customize panel).
///
/// Scanned straight from the plugin's install dir REGARDLESS of its enabled state:
/// a disabled plugin must still be browsable. This is why it is a separate read
/// from [`list_extensions`], which only folds an *enabled* plugin's contributions
/// into the active snapshot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct PluginContents {
    pub skills: Vec<SkillInfo>,
    pub agents: Vec<AgentInfo>,
    pub mcp_servers: Vec<McpServerInfo>,
}

// ---- on-disk wire shapes (private; only what we read) ---------------------

/// Subset of `~/.claude.json` we care about. The file is large (megabytes of
/// caches/telemetry) but serde only keeps these keys.
#[derive(Debug, Default, Deserialize)]
struct ClaudeJson {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
    #[serde(default)]
    projects: BTreeMap<String, ProjectEntry>,
}

/// One `projects[<abs-path>]` entry — only the MCP-toggle fields.
#[derive(Debug, Default, Deserialize)]
struct ProjectEntry {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
    /// Named (user/plugin) servers disabled for this project.
    #[serde(default, rename = "disabledMcpServers")]
    disabled_mcp: Vec<String>,
    /// `.mcp.json` servers explicitly approved for this project.
    #[serde(default, rename = "enabledMcpjsonServers")]
    enabled_mcpjson: Vec<String>,
    /// `.mcp.json` servers explicitly rejected for this project.
    #[serde(default, rename = "disabledMcpjsonServers")]
    disabled_mcpjson: Vec<String>,
}

/// One MCP server definition. `args`/`env`/`headers` are deliberately absent so
/// secrets can never be deserialized in the first place.
#[derive(Debug, Default, Deserialize)]
struct McpRaw {
    #[serde(default, rename = "type")]
    transport: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// A `{ "mcpServers": { … } }` file (`<repo>/.mcp.json`, a plugin's `.mcp.json`).
#[derive(Debug, Default, Deserialize)]
struct McpJsonFile {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
}

/// A `settings.json` (user `~/.claude/settings.json`, project `.claude/settings.json`,
/// or local `.claude/settings.local.json`): the plugin enable map AND `mcpServers`
/// — the schema allows declaring MCP servers directly in settings, a file-based
/// location distinct from `~/.claude.json` / `.mcp.json` that must be scanned too.
#[derive(Debug, Default, Deserialize)]
struct SettingsJson {
    #[serde(default, rename = "enabledPlugins")]
    enabled_plugins: BTreeMap<String, bool>,
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, McpRaw>,
    /// User-declared marketplaces. The authoritative source of the per-marketplace
    /// `autoUpdate` flag (mirrored into `known_marketplaces.json` by the CLI).
    #[serde(default, rename = "extraKnownMarketplaces")]
    extra_known_marketplaces: BTreeMap<String, ExtraMarketplace>,
}

/// One `extraKnownMarketplaces[name]` entry — only the fields we read.
#[derive(Debug, Default, Deserialize)]
struct ExtraMarketplace {
    #[serde(default, rename = "autoUpdate")]
    auto_update: Option<bool>,
}

/// `~/.claude/plugins/known_marketplaces.json` — the CLI's registry of every known
/// marketplace (flat map keyed by name). We read the source (for display), the
/// install location (to locate its `marketplace.json`), and the mirrored autoUpdate.
#[derive(Debug, Default, Clone, Deserialize)]
struct KnownMarketplace {
    #[serde(default)]
    source: Option<serde_json::Value>,
    #[serde(default, rename = "installLocation")]
    install_location: Option<String>,
    #[serde(default, rename = "autoUpdate")]
    auto_update: Option<bool>,
}

/// A `<marketplace>/.claude-plugin/marketplace.json` — the upstream catalogue that
/// pins each plugin's latest version/commit. Only the `plugins` array is read; each
/// entry is kept as a raw value ([`extract_pin`] plucks the pin out) because the
/// `source` field is polymorphic (an object for git/url sources, a bare string for a
/// relative path source).
#[derive(Debug, Default, Deserialize)]
struct MarketplaceManifest {
    #[serde(default)]
    plugins: Vec<serde_json::Value>,
}

/// A plugin's pin in a marketplace catalogue: the git commit `sha` (git-pinned
/// sources) and/or a human `version` (path/version sources). Either can be absent —
/// `tosse-workflow`'s bare-`url` source, for instance, carries neither, so its update
/// status is simply "unknown" (never a false positive).
#[derive(Debug, Default, Clone, PartialEq)]
struct MarketplacePin {
    sha: Option<String>,
    version: Option<String>,
}

/// `~/.claude/plugins/installed_plugins.json` (version 2).
#[derive(Debug, Default, Deserialize)]
struct InstalledPlugins {
    #[serde(default)]
    plugins: BTreeMap<String, Vec<PluginInstall>>,
}

/// One installation record of a plugin (a plugin can be installed at several
/// scopes — user, or project/local pinned to a `projectPath`).
#[derive(Debug, Default, Deserialize)]
struct PluginInstall {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default, rename = "projectPath")]
    project_path: Option<String>,
    #[serde(default, rename = "installPath")]
    install_path: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// The full git commit the plugin was installed at (git-sourced plugins). The
    /// reliable pin for update detection — compared against the marketplace's
    /// `source.sha`. Absent for path-sourced plugins (compared by `version` instead).
    #[serde(default, rename = "gitCommitSha")]
    git_commit_sha: Option<String>,
}

/// `<plugin>/.claude-plugin/plugin.json` — only name/description/version.
#[derive(Debug, Default, Deserialize)]
struct PluginManifest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// Where the plugin keeps its skills, relative to the install dir. The CLI
    /// accepts a single path OR a list, and `"."` (the plugin root) is explicitly
    /// supported. Absent → the `skills/` default.
    #[serde(default)]
    skills: Option<ManifestPaths>,
    #[serde(default)]
    agents: Option<ManifestPaths>,
    #[serde(default)]
    commands: Option<ManifestPaths>,
}

/// A manifest contribution path: either `"skills"` or `["skills", "extra/skills"]`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ManifestPaths {
    One(String),
    Many(Vec<String>),
}

impl ManifestPaths {
    fn as_slice(&self) -> Vec<&str> {
        match self {
            ManifestPaths::One(s) => vec![s.as_str()],
            ManifestPaths::Many(v) => v.iter().map(String::as_str).collect(),
        }
    }
}

/// Resolve a plugin's contribution directories: the manifest's declared paths when
/// present, else the conventional `<default>` subdirectory.
///
/// Hardcoding `<install>/skills` under-reported every plugin that declares its own
/// layout — the CLI loads those skills fine while the Extensions manager showed 0.
/// Paths are resolved relative to the install dir, and `"."` (the documented
/// single-skill-at-root layout) resolves to the dir itself.
fn contribution_dirs(dir: &Path, declared: Option<&ManifestPaths>, default: &str) -> Vec<PathBuf> {
    match declared {
        Some(paths) => paths
            .as_slice()
            .iter()
            .map(|p| {
                let p = p.trim_start_matches("./").trim_end_matches('/');
                if p.is_empty() || p == "." {
                    dir.to_path_buf()
                } else {
                    dir.join(p)
                }
            })
            .collect(),
        None => vec![dir.join(default)],
    }
}

// ---- public entry point ----------------------------------------------------

/// Read the configured extensions visible to the repository (or worktree) at
/// `repo_path`, across user / project / plugin scopes.
///
/// Best-effort and infallible: a missing or malformed file yields empties rather
/// than an error — an explorer must degrade gracefully, never fail to open. File
/// IO is synchronous; the IPC command runs it off the async runtime.
pub fn list_extensions(repo_path: &str) -> ExtensionsSnapshot {
    let home = match home_dir() {
        Some(h) => h,
        None => return ExtensionsSnapshot::default(),
    };
    let repo = Path::new(repo_path);

    let mut snap = ExtensionsSnapshot::default();

    // Main config files go through read_or_warn: a present-but-corrupt one records a
    // warning (surfaced in the UI) instead of silently reading as "empty" — a corrupt
    // ~/.claude.json must not look like "no MCP", and a corrupt settings.json must not
    // make every plugin look enabled (the `.unwrap_or(true)` below).
    let claude_json: ClaudeJson = read_or_warn(&home.join(".claude.json"), &mut snap.warnings);
    let settings: SettingsJson =
        read_or_warn(&home.join(".claude/settings.json"), &mut snap.warnings);
    let project = claude_json.projects.get(repo_path);

    // --- MCP: user scope (named servers; disabled per-project via disabledMcpServers)
    for (name, raw) in &claude_json.mcp_servers {
        let disabled = project.is_some_and(|p| p.disabled_mcp.iter().any(|n| n == name));
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::User, None, !disabled));
    }
    // --- MCP declared in settings.json files (schema-allowed, file-based). User-global
    // from ~/.claude/settings.json; project (committed) + local from the repo. Same
    // per-project disable rule for the user ones as the ~/.claude.json named servers.
    for (name, raw) in &settings.mcp_servers {
        let disabled = project.is_some_and(|p| p.disabled_mcp.iter().any(|n| n == name));
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::User, None, !disabled));
    }
    let project_settings: SettingsJson =
        read_or_warn(&repo.join(".claude/settings.json"), &mut snap.warnings);
    for (name, raw) in &project_settings.mcp_servers {
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::Project, None, true));
    }
    let local_settings: SettingsJson =
        read_or_warn(&repo.join(".claude/settings.local.json"), &mut snap.warnings);
    for (name, raw) in &local_settings.mcp_servers {
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::Local, None, true));
    }

    // --- MCP: PROJECT scope = the COMMITTED <repo>/.mcp.json (shared with the team).
    // A `.mcp.json` server is active when explicitly approved (`enabledMcpjsonServers`)
    // or simply not rejected (`disabledMcpjsonServers`).
    let project_mcp: McpJsonFile = read_or_warn(&repo.join(".mcp.json"), &mut snap.warnings);
    for (name, raw) in &project_mcp.mcp_servers {
        let enabled = project.map_or(true, |p| {
            p.enabled_mcpjson.iter().any(|n| n == name)
                || !p.disabled_mcpjson.iter().any(|n| n == name)
        });
        snap.mcp_servers
            .push(mcp_info(name, raw, ExtScope::Project, None, enabled));
    }

    // --- MCP: LOCAL scope = ~/.claude.json `projects[<repo>].mcpServers` — PRIVATE to
    // you for THIS repo (the `claude mcp add` default scope). Distinct from project
    // (committed/shared) and coexists with a `.mcp.json` — it is NOT a fallback.
    if let Some(p) = project {
        for (name, raw) in &p.mcp_servers {
            snap.mcp_servers
                .push(mcp_info(name, raw, ExtScope::Local, None, true));
        }
    }

    // --- Plugins (+ their skills/agents/mcp). Only installs relevant to this repo.
    let installed: InstalledPlugins =
        read_or_warn(&home.join(".claude/plugins/installed_plugins.json"), &mut snap.warnings);
    // Marketplace registry — locates each marketplace's catalogue for update detection.
    // Best-effort: an absent/broken registry just means "no update info" (never a warning
    // — a missing registry is normal, and update status degrading to unknown is safe).
    let known: BTreeMap<String, KnownMarketplace> =
        read_json(&home.join(".claude/plugins/known_marketplaces.json")).unwrap_or_default();
    // Each marketplace.json is read at most once per scan (many plugins share one).
    let mut pin_cache: BTreeMap<String, BTreeMap<String, MarketplacePin>> = BTreeMap::new();
    for (id, installs) in &installed.plugins {
        let Some(install) = relevant_install(installs, repo_path) else {
            continue;
        };
        let scope = install_scope(install);
        let enabled = settings.enabled_plugins.get(id).copied().unwrap_or(true);
        let marketplace = id.split_once('@').map(|(_, m)| m).unwrap_or("").to_string();
        // The plugin's key in its marketplace catalogue = the id half before '@'.
        let plugin_key = id.split_once('@').map(|(n, _)| n).unwrap_or(id);
        let dir = install.install_path.as_deref().map(PathBuf::from);

        let manifest: PluginManifest = dir
            .as_ref()
            .and_then(|d| read_json(&d.join(".claude-plugin/plugin.json")))
            .unwrap_or_default();

        // Update detection: installed pin (gitCommitSha / version) vs this plugin's pin
        // in the marketplace catalogue (read lazily, once per marketplace).
        let pins = pin_cache
            .entry(marketplace.clone())
            .or_insert_with(|| read_marketplace_pins(&home, &marketplace, known.get(&marketplace)));
        let installed_ver = manifest.version.as_deref().or(install.version.as_deref());
        let (update_available, latest_version) = compute_update(
            install.git_commit_sha.as_deref(),
            installed_ver,
            pins.get(plugin_key),
        );

        // Scan what the plugin provides (counts always; entries only when enabled).
        // The manifest may redirect any of the three, so honour it before falling back
        // to the conventional subdirectory.
        let skills = dir
            .as_ref()
            .map(|d| {
                contribution_dirs(d, manifest.skills.as_ref(), "skills")
                    .iter()
                    .flat_map(|p| scan_skills(p, ExtScope::Plugin, Some(id)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let agents = dir
            .as_ref()
            .map(|d| {
                contribution_dirs(d, manifest.agents.as_ref(), "agents")
                    .iter()
                    .flat_map(|p| scan_agents(p, ExtScope::Plugin, Some(id)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let command_count = dir
            .as_ref()
            .map(|d| {
                contribution_dirs(d, manifest.commands.as_ref(), "commands")
                    .iter()
                    .map(|p| count_markdown(p))
                    .sum()
            })
            .unwrap_or(0);
        let plugin_mcp: McpJsonFile = dir
            .as_ref()
            .and_then(|d| read_json(&d.join(".mcp.json")))
            .unwrap_or_default();

        snap.plugins.push(PluginInfo {
            id: id.clone(),
            name: manifest
                .name
                .unwrap_or_else(|| id.split_once('@').map(|(n, _)| n).unwrap_or(id).to_string()),
            marketplace,
            version: manifest.version.or_else(|| install.version.clone()),
            description: manifest.description,
            enabled,
            scope,
            update_available,
            latest_version,
            skill_count: skills.len() as u32,
            agent_count: agents.len() as u32,
            command_count,
            mcp_count: plugin_mcp.mcp_servers.len() as u32,
        });

        // An enabled plugin contributes its skills/agents/mcp to what Claude sees.
        if enabled {
            snap.skills.extend(skills);
            snap.agents.extend(agents);
            for (name, raw) in &plugin_mcp.mcp_servers {
                snap.mcp_servers
                    .push(mcp_info(name, raw, ExtScope::Plugin, Some(id), true));
            }
        }
    }

    // --- File-based skills/agents: user scope then project scope.
    snap.skills
        .extend(scan_skills(&home.join(".claude/skills"), ExtScope::User, None));
    snap.agents
        .extend(scan_agents(&home.join(".claude/agents"), ExtScope::User, None));
    snap.skills
        .extend(scan_skills(&repo.join(".claude/skills"), ExtScope::Project, None));
    snap.agents
        .extend(scan_agents(&repo.join(".claude/agents"), ExtScope::Project, None));

    snap
}

/// Scan everything a single installed plugin provides (skills / sub-agents / MCP),
/// independent of whether the plugin is enabled. `repo_path` selects the install
/// record relevant to the repo (a plugin can be installed at user/project/local
/// scopes). Best-effort and infallible — an unknown plugin or missing dir yields
/// empties so the explorer always opens.
pub fn list_plugin_contents(repo_path: &str, plugin_id: &str) -> PluginContents {
    let Some(home) = home_dir() else {
        return PluginContents::default();
    };
    let installed: InstalledPlugins =
        read_json(&home.join(".claude/plugins/installed_plugins.json")).unwrap_or_default();
    let Some(install) = installed
        .plugins
        .get(plugin_id)
        .and_then(|installs| relevant_install(installs, repo_path))
    else {
        return PluginContents::default();
    };
    let Some(dir) = install.install_path.as_deref().map(PathBuf::from) else {
        return PluginContents::default();
    };

    let plugin_mcp: McpJsonFile = read_json(&dir.join(".mcp.json")).unwrap_or_default();
    // Mirror the inventory scan: the manifest decides where skills/agents live.
    let manifest: PluginManifest =
        read_json(&dir.join(".claude-plugin/plugin.json")).unwrap_or_default();
    PluginContents {
        skills: contribution_dirs(&dir, manifest.skills.as_ref(), "skills")
            .iter()
            .flat_map(|p| scan_skills(p, ExtScope::Plugin, Some(plugin_id)))
            .collect(),
        agents: contribution_dirs(&dir, manifest.agents.as_ref(), "agents")
            .iter()
            .flat_map(|p| scan_agents(p, ExtScope::Plugin, Some(plugin_id)))
            .collect(),
        mcp_servers: plugin_mcp
            .mcp_servers
            .iter()
            .map(|(name, raw)| mcp_info(name, raw, ExtScope::Plugin, Some(plugin_id), true))
            .collect(),
    }
}

/// List every marketplace registered with Claude Code, with its resolved auto-update
/// state (see [`MarketplaceInfo`]). User-global (not repo-scoped): reads
/// `~/.claude/plugins/known_marketplaces.json` for the registry and
/// `~/.claude/settings.json` for the authoritative `autoUpdate` (settings wins over
/// the mirrored registry flag). Best-effort and infallible — absent files yield an
/// empty list, so the UI degrades to "no marketplaces" rather than failing to open.
pub fn list_marketplaces() -> Vec<MarketplaceInfo> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let known: BTreeMap<String, KnownMarketplace> =
        read_json(&home.join(".claude/plugins/known_marketplaces.json")).unwrap_or_default();
    let settings: SettingsJson =
        read_json(&home.join(".claude/settings.json")).unwrap_or_default();
    let mut out: Vec<MarketplaceInfo> = known
        .iter()
        .map(|(name, k)| MarketplaceInfo {
            name: name.clone(),
            source: display_source(k.source.as_ref()),
            // settings.json is what we write AND what the CLI reads, so it wins over
            // the (possibly stale) mirrored flag in known_marketplaces.json.
            auto_update: settings
                .extra_known_marketplaces
                .get(name)
                .and_then(|e| e.auto_update)
                .or(k.auto_update)
                .unwrap_or(false),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

// ---- actions ---------------------------------------------------------------

/// Enable or disable a plugin (by id `<plugin>@<marketplace>`) in the user's
/// `~/.claude/settings.json` `enabledPlugins` map — the same place Claude's own
/// `/plugin` toggle writes.
///
/// Safety: this edits the user's live config, so it
///   - reads the file FRESH right before writing (minimizes the read-modify-write
///     window against a concurrent editor),
///   - changes ONLY the one `enabledPlugins[id]` value, preserving every other key
///     and its order (serde_json `preserve_order`),
///   - writes atomically (temp file + rename) so a crash mid-write can never leave
///     a truncated settings.json.
///
/// Note: `enabledPlugins` is USER-GLOBAL (not per-repo) — this is how Claude stores
/// it. A running session reads it at spawn, so the change takes effect on the next
/// (re)start of a conversation.
pub fn set_plugin_enabled(plugin_id: &str, enabled: bool) -> Result<(), String> {
    // A fresh install has no settings.json yet (the CLI writes it only on first
    // setting change) — `write_settings` treats absent as an empty object so the very
    // first toggle CREATES the file; a present-but-unreadable file is still a real error.
    let home = home_dir().ok_or("home directory ($HOME) not found")?;
    write_settings(&home, |text| apply_plugin_enabled(text, plugin_id, enabled))
}

/// Turn a marketplace's auto-update on/off, writing
/// `~/.claude/settings.json` `extraKnownMarketplaces[name].autoUpdate` — the
/// authoritative flag the CLI reads (and mirrors into `known_marketplaces.json`).
/// Per-marketplace is the ONLY granularity Claude Code exposes (there is no per-plugin
/// auto-update). Same safety as [`set_plugin_enabled`]: fresh read, single-key change,
/// atomic write. If the marketplace has no `extraKnownMarketplaces` entry yet, one is
/// created carrying its `source` (copied from `known_marketplaces.json`) so the entry
/// stays valid for the CLI.
pub fn set_marketplace_auto_update(name: &str, enabled: bool) -> Result<(), String> {
    let home = home_dir().ok_or("home directory ($HOME) not found")?;
    let source = marketplace_source(&home, name);
    write_settings(&home, |text| {
        apply_marketplace_auto_update(text, name, enabled, source.clone())
    })
}

/// Turn auto-update on/off for EVERY registered marketplace at once (the global master
/// toggle) — one atomic settings.json write. Ensures each known marketplace has an
/// `extraKnownMarketplaces` entry (with its `source`) carrying the new flag.
pub fn set_all_marketplaces_auto_update(enabled: bool) -> Result<(), String> {
    let home = home_dir().ok_or("home directory ($HOME) not found")?;
    let known: BTreeMap<String, KnownMarketplace> =
        read_json(&home.join(".claude/plugins/known_marketplaces.json")).unwrap_or_default();
    let entries: Vec<(String, Option<serde_json::Value>)> = known
        .iter()
        .map(|(name, k)| (name.clone(), k.source.clone()))
        .collect();
    write_settings(&home, |text| {
        apply_all_marketplaces_auto_update(text, &entries, enabled)
    })
}

/// The `source` object of a marketplace, from `known_marketplaces.json` — used to seed
/// a fresh `extraKnownMarketplaces` entry so it stays valid for the CLI. `None` when
/// the registry is absent or the marketplace is unknown.
fn marketplace_source(home: &Path, name: &str) -> Option<serde_json::Value> {
    let known: BTreeMap<String, KnownMarketplace> =
        read_json(&home.join(".claude/plugins/known_marketplaces.json")).unwrap_or_default();
    known.get(name).and_then(|k| k.source.clone())
}

/// Serializes every `settings.json` writer (plugin / marketplace / CLI-auto-update toggles) so
/// two concurrent read-modify-write cycles can't lose one another's change (a lost update on
/// distinct keys). `write_atomic` prevents a torn FILE; this lock prevents a torn EDIT. Mirrors
/// the Codex `CONFIG_WRITE_LOCK` discipline, now that a fourth writer (CLI auto-update) shares
/// this spine.
static SETTINGS_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Read `~/.claude/settings.json` fresh, apply `transform`, and write the result back
/// atomically — the shared read-modify-write spine of [`set_plugin_enabled`] and the
/// auto-update setters. Absent file → an empty object (the first write creates it).
fn write_settings(
    home: &Path,
    transform: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(), String> {
    // Hold across the WHOLE read→transform→write so concurrent toggles serialize.
    let _guard = SETTINGS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = home.join(".claude/settings.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".to_string(),
        Err(e) => return Err(format!("unable to read settings.json: {e}")),
    };
    let updated = transform(&text)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("unable to create config directory: {e}"))?;
    }
    write_atomic(&path, updated.as_bytes())
}

/// Pure transform: set `extraKnownMarketplaces[name].autoUpdate = enabled` in a
/// settings.json document, creating the entry (with `source`) if absent, preserving
/// every other key and its order. Split out so it is unit-testable without the FS.
fn apply_marketplace_auto_update(
    text: &str,
    name: &str,
    enabled: bool,
    source: Option<serde_json::Value>,
) -> Result<String, String> {
    let mut root: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("settings.json unreadable: {e}"))?;
    let obj = root
        .as_object_mut()
        .ok_or("settings.json is not a JSON object")?;
    set_marketplace_flag(obj, name, enabled, source);
    serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialization: {e}"))
}

/// Pure transform for the global master toggle: set `autoUpdate = enabled` on EVERY
/// listed marketplace in one document. Order-preserving; testable without the FS.
fn apply_all_marketplaces_auto_update(
    text: &str,
    marketplaces: &[(String, Option<serde_json::Value>)],
    enabled: bool,
) -> Result<String, String> {
    let mut root: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("settings.json unreadable: {e}"))?;
    let obj = root
        .as_object_mut()
        .ok_or("settings.json is not a JSON object")?;
    for (name, source) in marketplaces {
        set_marketplace_flag(obj, name, enabled, source.clone());
    }
    serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialization: {e}"))
}

/// Set `extraKnownMarketplaces[name].autoUpdate = enabled` on a settings root object,
/// creating the `extraKnownMarketplaces` map and/or the marketplace entry (seeded with
/// `source`) as needed. Shared by both auto-update transforms.
fn set_marketplace_flag(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    name: &str,
    enabled: bool,
    source: Option<serde_json::Value>,
) {
    if !obj.get("extraKnownMarketplaces").map(|v| v.is_object()).unwrap_or(false) {
        obj.insert("extraKnownMarketplaces".to_string(), serde_json::json!({}));
    }
    let Some(mkts) = obj
        .get_mut("extraKnownMarketplaces")
        .and_then(|v| v.as_object_mut())
    else {
        return;
    };
    let entry = mkts
        .entry(name.to_string())
        .or_insert_with(|| serde_json::json!({}));
    // A pre-existing entry that isn't an object (hand-mangled settings.json) would make
    // `as_object_mut` return None and the flag silently vanish while we report success —
    // replace it with a fresh object so the write always lands.
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    if let Some(map) = entry.as_object_mut() {
        // Seed `source` only when creating/replacing (never clobber an existing one).
        if !map.contains_key("source") {
            if let Some(src) = source {
                map.insert("source".to_string(), src);
            }
        }
        map.insert("autoUpdate".to_string(), serde_json::Value::Bool(enabled));
    }
}

/// Pure transform: set `enabledPlugins[plugin_id] = enabled` in a settings.json
/// document, returning the re-serialized (2-space, key-order-preserving) text.
/// Splitting this out keeps it unit-testable without touching the filesystem.
fn apply_plugin_enabled(text: &str, plugin_id: &str, enabled: bool) -> Result<String, String> {
    let mut root: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("settings.json unreadable: {e}"))?;
    let obj = root
        .as_object_mut()
        .ok_or("settings.json is not a JSON object")?;
    if !obj.get("enabledPlugins").map(|v| v.is_object()).unwrap_or(false) {
        obj.insert("enabledPlugins".to_string(), serde_json::json!({}));
    }
    obj.get_mut("enabledPlugins")
        .and_then(|v| v.as_object_mut())
        .ok_or("enabledPlugins is not an object")?
        .insert(plugin_id.to_string(), serde_json::Value::Bool(enabled));
    serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialization: {e}"))
}

/// Pure transform: set/clear `env.DISABLE_AUTOUPDATER` to reflect the Claude CLI's
/// background auto-updater state. `enabled == true` (auto-update ON) REMOVES the key and
/// prunes an emptied `env`; `enabled == false` sets it to `"1"`. Order-preserving; testable
/// without the filesystem.
fn apply_claude_auto_update(text: &str, enabled: bool) -> Result<String, String> {
    let mut root: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("settings.json unreadable: {e}"))?;
    let obj = root
        .as_object_mut()
        .ok_or("settings.json is not a JSON object")?;
    if enabled {
        if let Some(env) = obj.get_mut("env").and_then(|v| v.as_object_mut()) {
            env.remove("DISABLE_AUTOUPDATER");
            if env.is_empty() {
                obj.remove("env");
            }
        }
    } else {
        if !obj.get("env").map(|v| v.is_object()).unwrap_or(false) {
            obj.insert("env".to_string(), serde_json::json!({}));
        }
        if let Some(env) = obj.get_mut("env").and_then(|v| v.as_object_mut()) {
            env.insert(
                "DISABLE_AUTOUPDATER".to_string(),
                serde_json::Value::String("1".to_string()),
            );
        }
    }
    serde_json::to_string_pretty(&root).map_err(|e| format!("JSON serialization: {e}"))
}

/// Flip the Claude CLI's background auto-updater by writing `env.DISABLE_AUTOUPDATER` in
/// `~/.claude/settings.json` (atomic, order-preserving — the shared [`write_settings`] spine,
/// so the same anti-race discipline as the plugin/marketplace toggles). `enabled == true`
/// means "auto-update ON". This is the ONE writer of that key; the read side lives in
/// [`crate::cli_update`].
///
/// ⚠️ This key is only ONE of the two gates the CLI honours. The other, `autoUpdates:false`
/// in `~/.claude.json`, is deliberately NOT written here — that file belongs to the CLI and
/// writing it races the binary. The asymmetry that follows: `enabled == false` always bites
/// (this key alone is enough to disable), but `enabled == true` only re-enables when the other
/// gate is already open. The read side reports the closed case as
/// [`crate::cli_update::ClaudeCliStatus::auto_update_locked`] and the panel disables the switch,
/// rather than letting it silently spring back.
pub fn set_claude_auto_update(enabled: bool) -> Result<(), String> {
    let home = home_dir().ok_or("could not resolve home directory")?;
    write_settings(&home, |text| apply_claude_auto_update(text, enabled))
}

/// Replace `path` atomically: write a sibling temp file, then rename over the
/// target so a crash mid-write can never leave a truncated file. The temp name is
/// unique per call (pid + a monotonic counter) so two concurrent writes to the same
/// target don't share — and clobber — one another's temp file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.tosse-tmp.{}.{n}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("writing temporary file: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // don't leave the temp behind on failure
        format!("atomic replacement of settings.json: {e}")
    })
}

// ---- helpers ---------------------------------------------------------------

/// The user's home directory (`$HOME`). macOS/Linux; this app is macOS-first.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Read and deserialize a JSON file; `None` on any failure (absent, unreadable,
/// malformed) so callers can `.unwrap_or_default()`. Use this only where corruption
/// is acceptable to swallow (per-plugin manifests); the MAIN config files go through
/// [`read_or_warn`] so a broken one is surfaced, not silently treated as empty.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Read+parse a JSON config file, distinguishing **absent** (`Ok(None)` — a normal
/// degradation) from **present-but-broken** (`Err` with a human message). This is
/// what lets the scan surface a corrupt config instead of mistaking it for "nothing
/// configured" (the silent-error trap).
fn read_json_checked<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} unreadable: {e}", path.display())),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{} corrupt: {e}", path.display()))
}

/// Read a main config file, degrading to `T::default()` but recording a warning when
/// it exists yet can't be read/parsed (so the failure is never silent).
fn read_or_warn<T: Default + serde::de::DeserializeOwned>(
    path: &Path,
    warnings: &mut Vec<String>,
) -> T {
    match read_json_checked(path) {
        Ok(opt) => opt.unwrap_or_default(),
        Err(msg) => {
            warnings.push(msg);
            T::default()
        }
    }
}

/// Build an [`McpServerInfo`] from a raw server, stripping any URL query string.
fn mcp_info(
    name: &str,
    raw: &McpRaw,
    scope: ExtScope,
    source: Option<&str>,
    enabled: bool,
) -> McpServerInfo {
    McpServerInfo {
        name: name.to_string(),
        scope,
        transport: raw.transport.clone(),
        command: raw.command.clone(),
        url: raw.url.as_deref().map(strip_url_query),
        source: source.map(str::to_string),
        enabled,
    }
}

/// Drop a URL's query string (and fragment) — it can carry an auth token. Keeps
/// scheme/host/path, which is all the UI needs to identify the endpoint.
fn strip_url_query(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).to_string()
}

/// Pick the installation record relevant to `repo_path`: a `user`-scoped install
/// (global), else one whose `projectPath` is this repo. `None` when the plugin is
/// only installed for *other* projects.
fn relevant_install<'a>(installs: &'a [PluginInstall], repo_path: &str) -> Option<&'a PluginInstall> {
    installs
        .iter()
        .find(|i| i.scope.as_deref() == Some("user"))
        .or_else(|| installs.iter().find(|i| i.project_path.as_deref() == Some(repo_path)))
}

/// Read a marketplace's catalogue and index each plugin's pin by plugin name. The
/// catalogue lives at `<installLocation>/.claude-plugin/marketplace.json`, falling
/// back to the conventional `~/.claude/plugins/marketplaces/<name>/…` path when the
/// registry doesn't say. Missing/unparseable → empty map (update status degrades to
/// "unknown", never an error).
fn read_marketplace_pins(
    home: &Path,
    marketplace: &str,
    known: Option<&KnownMarketplace>,
) -> BTreeMap<String, MarketplacePin> {
    let dir = known
        .and_then(|k| k.install_location.clone())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude/plugins/marketplaces").join(marketplace));
    let manifest: MarketplaceManifest =
        read_json(&dir.join(".claude-plugin/marketplace.json")).unwrap_or_default();
    let mut out = BTreeMap::new();
    for entry in &manifest.plugins {
        if let Some(name) = entry.get("name").and_then(|v| v.as_str()) {
            out.insert(name.to_string(), extract_pin(entry));
        }
    }
    out
}

/// Pluck the pin (git `sha` + human `version`) out of one marketplace `plugins[]`
/// entry. The `sha` lives at `source.sha` (git-pinned sources); the `version` is the
/// entry's top-level `version`, else `source.version`. Both optional — an entry can
/// carry neither (a bare-`url` source), which reads back as "unknown".
fn extract_pin(entry: &serde_json::Value) -> MarketplacePin {
    let sha = entry
        .get("source")
        .and_then(|s| s.get("sha"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let version = entry
        .get("version")
        .and_then(|v| v.as_str())
        .or_else(|| {
            entry
                .get("source")
                .and_then(|s| s.get("version"))
                .and_then(|v| v.as_str())
        })
        .map(str::to_string);
    MarketplacePin { sha, version }
}

/// Decide whether a plugin has an update and, when meaningful, the target human
/// version. Pure and total, so it is unit-tested against every pin combination.
///
/// Priority: a git `sha` mismatch is authoritative (a new commit) — the human version
/// may be unchanged, so a "vX → vY" label is offered only when the versions DO differ.
/// Falls back to a pure `version` comparison for path/version sources. Anything unknown
/// (missing installed OR marketplace pin) is "no update": we never flag one we can't
/// prove, so a plugin never nags without cause.
fn compute_update(
    installed_sha: Option<&str>,
    installed_ver: Option<&str>,
    pin: Option<&MarketplacePin>,
) -> (bool, Option<String>) {
    let Some(pin) = pin else {
        return (false, None);
    };
    // Git-pinned: the commit sha is the truth (tolerating abbreviation — see sha_eq).
    if let (Some(a), Some(b)) = (installed_sha, pin.sha.as_deref()) {
        if sha_eq(a, b) {
            return (false, None);
        }
        let target = match (installed_ver, pin.version.as_deref()) {
            (Some(iv), Some(pv)) if iv != pv => Some(pv.to_string()),
            _ => None,
        };
        return (true, target);
    }
    // Version-pinned (path sources) or a plugin.json version bump.
    if let (Some(a), Some(b)) = (installed_ver, pin.version.as_deref()) {
        if a != b {
            return (true, Some(b.to_string()));
        }
    }
    (false, None)
}

/// Whether two git shas denote the same commit, tolerating abbreviation: equal when
/// they match exactly, or when the shorter is a ≥7-char prefix of the longer.
/// `installed_plugins.json` stores the FULL 40-char sha, but a marketplace catalogue
/// may pin an ABBREVIATED one — exact string equality would then flag a permanent
/// phantom "update available" that `claude plugin update` could never clear. The
/// 7-char floor is git's default abbreviation length, guarding against a pathologically
/// short prefix causing a false negative.
fn sha_eq(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    short.len() >= 7 && long.starts_with(short)
}

/// A short, human source string for a marketplace `source` object: an `owner/repo`
/// (github), else a `url`, else the `source` kind, else a bare-string source. Empty
/// when unknown. Display-only.
fn display_source(source: Option<&serde_json::Value>) -> String {
    let Some(s) = source else {
        return String::new();
    };
    if let Some(repo) = s.get("repo").and_then(|v| v.as_str()) {
        return repo.to_string();
    }
    if let Some(url) = s.get("url").and_then(|v| v.as_str()) {
        return url.to_string();
    }
    if let Some(kind) = s.get("source").and_then(|v| v.as_str()) {
        return kind.to_string();
    }
    s.as_str().unwrap_or("").to_string()
}

/// Map an install's `scope` string to our [`ExtScope`].
fn install_scope(install: &PluginInstall) -> ExtScope {
    match install.scope.as_deref() {
        Some("project") => ExtScope::Project,
        Some("local") => ExtScope::Local,
        _ => ExtScope::User,
    }
}

/// Scan a `skills/` directory: one subdirectory per skill, each holding a
/// `SKILL.md` whose frontmatter carries `name`/`description`. Missing dir → empty.
fn scan_skills(dir: &Path, scope: ExtScope, source: Option<&str>) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    // A manifest may name the SKILL.md file itself rather than a directory.
    if dir.is_file() {
        if let Some(info) = skill_from_md(dir, dir.parent().unwrap_or(dir), scope, source) {
            out.push(info);
        }
        return out;
    }
    // A `SKILL.md` sitting directly in the scanned directory IS a skill — that is the
    // single-skill layout the CLI suggests when a manifest points at the plugin root
    // (`"skills": "."`). Requiring a subdirectory missed it entirely.
    if let Some(info) = skill_from_md(&dir.join("SKILL.md"), dir, scope, source) {
        out.push(info);
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(info) = skill_from_md(&path.join("SKILL.md"), &path, scope, source) {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// One `SKILL.md` → [`SkillInfo`], named after its frontmatter or `owner` (the
/// directory the skill belongs to). `None` when the file is absent.
fn skill_from_md(
    skill_md: &Path,
    owner: &Path,
    scope: ExtScope,
    source: Option<&str>,
) -> Option<SkillInfo> {
    if !skill_md.is_file() {
        return None;
    }
    let front = std::fs::read_to_string(skill_md)
        .ok()
        .map(|c| parse_frontmatter(&c))
        .unwrap_or_default();
    Some(SkillInfo {
        name: front.name.unwrap_or_else(|| dir_name(owner)),
        description: front.description,
        scope,
        source: source.map(str::to_string),
        path: skill_md.to_string_lossy().into_owned(),
        // Claude exposes no per-skill toggle — a discovered skill is active.
        enabled: true,
    })
}

/// Scan an `agents/` directory: one `*.md` per sub-agent, frontmatter carries
/// `name`/`description`/`model`. Missing dir → empty.
fn scan_agents(dir: &Path, scope: ExtScope, source: Option<&str>) -> Vec<AgentInfo> {
    let mut out = Vec::new();
    // A manifest may name individual FILES rather than a directory
    // (`"agents": ["./agents/a.md", "./agents/b.md"]` is real, and common) — treat a
    // path that IS a markdown file as a single contribution.
    if dir.is_file() {
        if let Some(info) = agent_from_md(dir, scope, source) {
            out.push(info);
        }
        return out;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        if let Some(info) = agent_from_md(&entry.path(), scope, source) {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// One `*.md` sub-agent definition → [`AgentInfo`]. `None` for a non-markdown path.
fn agent_from_md(path: &Path, scope: ExtScope, source: Option<&str>) -> Option<AgentInfo> {
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }
    let front = std::fs::read_to_string(path)
        .ok()
        .map(|c| parse_frontmatter(&c))
        .unwrap_or_default();
    let name = front
        .name
        .unwrap_or_else(|| path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string());
    Some(AgentInfo {
        name,
        description: front.description,
        model: front.model,
        scope,
        source: source.map(str::to_string),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Count `*.md` files directly in `dir` (for a plugin's `commands/`). 0 if absent.
fn count_markdown(dir: &Path) -> u32 {
    // Same as scan_agents: a manifest may list individual command files.
    if dir.is_file() {
        return u32::from(dir.extension().and_then(|x| x.to_str()) == Some("md"));
    }
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                .count() as u32
        })
        .unwrap_or(0)
}

/// Last path component as a `String` (a directory's own name).
fn dir_name(path: &Path) -> String {
    path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

/// The handful of YAML frontmatter fields we read from a SKILL.md / agent .md.
#[derive(Debug, Default, PartialEq)]
struct FrontMatter {
    name: Option<String>,
    description: Option<String>,
    model: Option<String>,
}

/// Minimal YAML-frontmatter extractor for skill/agent markdown — enough for the
/// flat `key: value` and block-scalar (`key: |` / `key: >`) forms these files
/// use, without pulling in a YAML dependency. Reads only the leading
/// `---`…`---` block; ignores everything else. Pure, so it is unit-tested.
fn parse_frontmatter(content: &str) -> FrontMatter {
    let mut fm = FrontMatter::default();
    // Strip a leading UTF-8 BOM first: `str::trim` does NOT remove U+FEFF (it isn't
    // Rust whitespace), so a BOM-prefixed SKILL.md/agent .md (Windows editors) would
    // otherwise have its whole frontmatter ignored (name/description/model lost).
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines();
    // Frontmatter must be the very first thing (allowing a leading BOM/blank).
    if lines.next().map(str::trim) != Some("---") {
        return fm;
    }
    let block: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();

    let mut i = 0;
    while i < block.len() {
        let line = block[i];
        i += 1;
        let Some((key, rest)) = top_level_key(line) else {
            continue;
        };
        let value = if rest == "|" || rest == ">" || rest == "|-" || rest == ">-" {
            // Block scalar: gather the following indented/blank lines.
            let mut parts = Vec::new();
            while i < block.len() {
                let next = block[i];
                if next.trim().is_empty() {
                    i += 1;
                    continue;
                }
                if !next.starts_with(' ') && !next.starts_with('\t') {
                    break; // a new top-level key ends the block
                }
                parts.push(next.trim());
                i += 1;
            }
            parts.join(" ")
        } else {
            unquote(rest).to_string()
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        match key {
            "name" => fm.name = Some(value),
            "description" => fm.description = Some(value),
            "model" => fm.model = Some(value),
            _ => {}
        }
    }
    fm
}

/// Split a line into `(key, rest)` when it is a top-level `key: value` (no
/// leading whitespace, key is `[A-Za-z0-9_-]+`). `rest` is trimmed.
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

/// Strip a single pair of surrounding single/double quotes from a scalar value.
fn unquote(s: &str) -> &str {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() >= 2
        && (bytes[0] == b'"' || bytes[0] == b'\'')
        && bytes[bytes.len() - 1] == bytes[0]
    {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_reads_flat_keys() {
        let md = "---\nname: pickup\nmodel: sonnet\n---\n# body\nname: not-this\n";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("pickup"));
        assert_eq!(fm.model.as_deref(), Some("sonnet"));
        // A `key:` line in the body (after the closing ---) is ignored.
        assert_eq!(fm.description, None);
    }

    #[test]
    fn frontmatter_reads_block_scalar_description() {
        let md = "---\nname: tosse-manager\ndescription: |\n  Agent for CRM ops.\n  Use it when X.\nmodel: sonnet\n---\nbody";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("tosse-manager"));
        assert_eq!(
            fm.description.as_deref(),
            Some("Agent for CRM ops. Use it when X."),
            "block-scalar lines join with a space; `model:` ends the block"
        );
        assert_eq!(fm.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn frontmatter_unquotes_values() {
        let md = "---\nname: \"quoted name\"\ndescription: 'single'\n---";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("quoted name"));
        assert_eq!(fm.description.as_deref(), Some("single"));
    }

    #[test]
    fn frontmatter_absent_yields_empty() {
        assert_eq!(parse_frontmatter("# just markdown\nname: x"), FrontMatter::default());
        assert_eq!(parse_frontmatter(""), FrontMatter::default());
    }

    #[test]
    fn read_json_checked_distinguishes_absent_from_corrupt() {
        use std::io::Write;
        // Absent → Ok(None) (a normal degradation, no warning).
        let missing = std::env::temp_dir().join("tosse-read-json-absent-xyz.json");
        let _ = std::fs::remove_file(&missing);
        let r: Result<Option<serde_json::Value>, String> = read_json_checked(&missing);
        assert!(matches!(r, Ok(None)), "absent must be Ok(None)");
        // Present but corrupt → Err (a surfaced failure, NOT silently None).
        let bad = std::env::temp_dir().join("tosse-read-json-corrupt-xyz.json");
        std::fs::File::create(&bad).unwrap().write_all(b"{ not json ]").unwrap();
        let r: Result<Option<serde_json::Value>, String> = read_json_checked(&bad);
        assert!(r.is_err(), "corrupt JSON must be Err, not None");
        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn frontmatter_tolerates_utf8_bom() {
        // A SKILL.md saved with a leading UTF-8 BOM (Windows editors) must still
        // have its frontmatter read — `str::trim` does NOT strip U+FEFF.
        let md = "\u{feff}---\nname: pickup\ndescription: do it\n---\n# body";
        let fm = parse_frontmatter(md);
        assert_eq!(fm.name.as_deref(), Some("pickup"));
        assert_eq!(fm.description.as_deref(), Some("do it"));
    }

    #[test]
    fn strip_url_query_drops_token() {
        assert_eq!(strip_url_query("https://x.com/mcp?token=secret"), "https://x.com/mcp");
        assert_eq!(strip_url_query("https://x.com/mcp#frag"), "https://x.com/mcp");
        assert_eq!(strip_url_query("https://x.com/mcp"), "https://x.com/mcp");
    }

    #[test]
    fn relevant_install_prefers_user_then_matching_project() {
        let installs = vec![
            PluginInstall {
                scope: Some("project".into()),
                project_path: Some("/repo/a".into()),
                ..Default::default()
            },
            PluginInstall {
                scope: Some("local".into()),
                project_path: Some("/repo/b".into()),
                ..Default::default()
            },
        ];
        // No user install: only the matching projectPath is relevant.
        assert_eq!(
            relevant_install(&installs, "/repo/b").map(install_scope),
            Some(ExtScope::Local)
        );
        // A repo with no matching install gets nothing.
        assert!(relevant_install(&installs, "/repo/c").is_none());

        let with_user = vec![PluginInstall {
            scope: Some("user".into()),
            ..Default::default()
        }];
        // A user install is global — relevant to any repo.
        assert_eq!(
            relevant_install(&with_user, "/anything").map(install_scope),
            Some(ExtScope::User)
        );
    }

    #[test]
    fn apply_plugin_enabled_flips_one_key_preserving_the_rest_and_order() {
        // A settings.json with keys in a deliberate (non-alphabetical) order and an
        // existing plugin map. Toggling one plugin must keep every other key, value
        // and ORDER intact, and only flip the targeted entry.
        let before = r#"{
  "language": "french",
  "enabledPlugins": {
    "a@m": true,
    "b@m": false
  },
  "voice": { "enabled": true }
}"#;
        let after = apply_plugin_enabled(before, "b@m", true).unwrap();
        // Key order preserved: language before enabledPlugins before voice.
        let lang = after.find("\"language\"").unwrap();
        let plugins = after.find("\"enabledPlugins\"").unwrap();
        let voice = after.find("\"voice\"").unwrap();
        assert!(lang < plugins && plugins < voice, "top-level key order preserved");
        // Other values untouched, targeted plugin flipped, sibling plugin intact.
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["language"], "french");
        assert_eq!(v["voice"]["enabled"], true);
        assert_eq!(v["enabledPlugins"]["a@m"], true);
        assert_eq!(v["enabledPlugins"]["b@m"], true, "targeted plugin was enabled");
    }

    #[test]
    fn apply_plugin_enabled_creates_the_map_when_absent() {
        let after = apply_plugin_enabled(r#"{"language":"french"}"#, "x@y", false).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["enabledPlugins"]["x@y"], false);
        assert_eq!(v["language"], "french", "existing keys are kept");
    }

    #[test]
    fn extract_pin_reads_git_subdir_sha_and_version() {
        // A git-subdir entry pins a sha; no top-level version.
        let git = serde_json::json!({
            "name": "railway",
            "source": { "source": "git-subdir", "url": "x", "ref": "main", "sha": "aa1e055b" }
        });
        assert_eq!(
            extract_pin(&git),
            MarketplacePin { sha: Some("aa1e055b".into()), version: None }
        );
        // A path source carries a top-level version, no sha.
        let path = serde_json::json!({ "name": "swift-lsp", "version": "1.0.0", "source": "./plugins/swift-lsp" });
        assert_eq!(
            extract_pin(&path),
            MarketplacePin { sha: None, version: Some("1.0.0".into()) }
        );
        // A bare-url source with neither → unknown (never a false positive downstream).
        let bare = serde_json::json!({ "name": "tosse-workflow", "source": { "source": "url", "url": "x" } });
        assert_eq!(extract_pin(&bare), MarketplacePin::default());
    }

    #[test]
    fn compute_update_sha_is_authoritative_and_version_labels_only_when_differ() {
        // Same sha → no update, regardless of version.
        let pin = MarketplacePin { sha: Some("abc".into()), version: Some("1.1.0".into()) };
        assert_eq!(compute_update(Some("abc"), Some("1.0.0"), Some(&pin)), (false, None));
        // Different sha, same version → update, but no "vX → vY" label (sha-only bump).
        let pin = MarketplacePin { sha: Some("def".into()), version: Some("1.0.0".into()) };
        assert_eq!(compute_update(Some("abc"), Some("1.0.0"), Some(&pin)), (true, None));
        // Different sha AND version → update with the target version to display.
        let pin = MarketplacePin { sha: Some("def".into()), version: Some("1.1.0".into()) };
        assert_eq!(
            compute_update(Some("abc"), Some("1.0.0"), Some(&pin)),
            (true, Some("1.1.0".into()))
        );
    }

    #[test]
    fn compute_update_tolerates_abbreviated_marketplace_sha() {
        // Installed is the full 40-char sha; the marketplace pins an abbreviated one for
        // the SAME commit → no phantom update (exact `==` would wrongly flag it forever).
        let full = "aa1e055b0f18d13787232b164cfb7416b553bd03";
        let pin = MarketplacePin { sha: Some("aa1e055b".into()), version: None };
        assert_eq!(compute_update(Some(full), None, Some(&pin)), (false, None));
        // A DIFFERENT abbreviated sha is still an update.
        let other = MarketplacePin { sha: Some("bbbbbbb".into()), version: None };
        assert_eq!(compute_update(Some(full), None, Some(&other)), (true, None));
        // Guard: a too-short (<7) prefix is NOT treated as equal (avoids coincidences).
        assert!(!sha_eq(full, "aa1e0"));
        assert!(sha_eq(full, "aa1e055b"));
        assert!(sha_eq("aa1e055b", full));
    }

    #[test]
    fn compute_update_version_only_and_unknown_pins() {
        // No installed sha (path source): compare versions.
        let pin = MarketplacePin { sha: None, version: Some("2.0.0".into()) };
        assert_eq!(
            compute_update(None, Some("1.0.0"), Some(&pin)),
            (true, Some("2.0.0".into()))
        );
        assert_eq!(compute_update(None, Some("2.0.0"), Some(&pin)), (false, None));
        // No marketplace pin at all, or no overlapping fields → never an update.
        assert_eq!(compute_update(Some("abc"), Some("1.0.0"), None), (false, None));
        let empty = MarketplacePin::default();
        assert_eq!(compute_update(Some("abc"), Some("1.0.0"), Some(&empty)), (false, None));
        // Installed has only a sha, marketplace has only a version → can't compare → none.
        let ver_only = MarketplacePin { sha: None, version: Some("1.1.0".into()) };
        assert_eq!(compute_update(Some("abc"), None, Some(&ver_only)), (false, None));
    }

    #[test]
    fn apply_marketplace_auto_update_sets_flag_seeding_source_and_preserving_order() {
        // Existing entry (no source seeding, no clobber) — order + siblings intact.
        let before = r#"{
  "language": "french",
  "extraKnownMarketplaces": {
    "mkt-a": { "source": { "source": "github", "repo": "o/a" } }
  },
  "voice": { "enabled": true }
}"#;
        let after = apply_marketplace_auto_update(before, "mkt-a", true, None).unwrap();
        let lang = after.find("\"language\"").unwrap();
        let mkts = after.find("\"extraKnownMarketplaces\"").unwrap();
        let voice = after.find("\"voice\"").unwrap();
        assert!(lang < mkts && mkts < voice, "top-level key order preserved");
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["extraKnownMarketplaces"]["mkt-a"]["autoUpdate"], true);
        assert_eq!(v["extraKnownMarketplaces"]["mkt-a"]["source"]["repo"], "o/a", "source untouched");
        assert_eq!(v["voice"]["enabled"], true);
    }

    #[test]
    fn apply_marketplace_auto_update_creates_entry_with_seeded_source() {
        // Absent marketplace → entry created carrying the passed source.
        let src = serde_json::json!({ "source": "github", "repo": "o/new" });
        let after = apply_marketplace_auto_update("{}", "mkt-new", false, Some(src)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["extraKnownMarketplaces"]["mkt-new"]["autoUpdate"], false);
        assert_eq!(v["extraKnownMarketplaces"]["mkt-new"]["source"]["repo"], "o/new");
    }

    #[test]
    fn apply_all_marketplaces_auto_update_sets_every_listed_marketplace() {
        let before = r#"{"extraKnownMarketplaces":{"a":{"source":{"repo":"o/a"},"autoUpdate":false}}}"#;
        let mkts = vec![
            ("a".to_string(), Some(serde_json::json!({ "repo": "o/a" }))),
            ("b".to_string(), Some(serde_json::json!({ "repo": "o/b" }))),
        ];
        let after = apply_all_marketplaces_auto_update(before, &mkts, true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["extraKnownMarketplaces"]["a"]["autoUpdate"], true, "existing flipped");
        assert_eq!(v["extraKnownMarketplaces"]["b"]["autoUpdate"], true, "new added");
        assert_eq!(v["extraKnownMarketplaces"]["b"]["source"]["repo"], "o/b", "new carries source");
    }

    #[test]
    fn apply_claude_auto_update_sets_and_clears_the_disable_flag() {
        // OFF → env.DISABLE_AUTOUPDATER = "1", sibling keys preserved.
        let after = apply_claude_auto_update(r#"{"theme":"auto"}"#, false).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["env"]["DISABLE_AUTOUPDATER"], "1");
        assert_eq!(v["theme"], "auto", "unrelated key preserved");

        // ON → key removed AND the now-empty env pruned.
        let after2 = apply_claude_auto_update(&after, true).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&after2).unwrap();
        assert!(v2.get("env").is_none(), "emptied env is pruned");
        assert_eq!(v2["theme"], "auto");
    }

    #[test]
    fn apply_claude_auto_update_keeps_other_env_keys_when_enabling() {
        // Enabling removes only DISABLE_AUTOUPDATER, never a sibling env var, and keeps env.
        let before = r#"{"env":{"FOO":"bar","DISABLE_AUTOUPDATER":"1"}}"#;
        let after = apply_claude_auto_update(before, true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert!(v["env"].get("DISABLE_AUTOUPDATER").is_none());
        assert_eq!(v["env"]["FOO"], "bar", "unrelated env var kept → env not pruned");
    }

    #[test]
    fn display_source_prefers_repo_then_url_then_kind() {
        assert_eq!(
            display_source(Some(&serde_json::json!({ "source": "github", "repo": "o/r" }))),
            "o/r"
        );
        assert_eq!(
            display_source(Some(&serde_json::json!({ "source": "url", "url": "https://x/y.git" }))),
            "https://x/y.git"
        );
        assert_eq!(display_source(Some(&serde_json::json!({ "source": "local" }))), "local");
        assert_eq!(display_source(None), "");
    }

    #[test]
    fn mcp_info_redacts_url_and_omits_args() {
        let raw = McpRaw {
            transport: Some("http".into()),
            command: None,
            url: Some("https://h/mcp?k=secret".into()),
        };
        let info = mcp_info("srv", &raw, ExtScope::Plugin, Some("p@m"), true);
        assert_eq!(info.url.as_deref(), Some("https://h/mcp"));
        assert_eq!(info.source.as_deref(), Some("p@m"));
        assert!(info.enabled);
    }

    /// REGRESSION: a plugin manifest may redirect where its skills/agents/commands
    /// live, including to the plugin ROOT (`"skills": "."`). Hardcoding
    /// `<install>/skills` reported 0 skills for such a plugin while the CLI loaded
    /// them fine.
    #[test]
    fn contribution_dirs_honour_the_manifest_and_default_without_one() {
        let root = Path::new("/p");

        // No declaration → the conventional subdirectory.
        assert_eq!(contribution_dirs(root, None, "skills"), vec![root.join("skills")]);

        // A single declared path, relative to the install dir.
        let one = ManifestPaths::One("lib/skills".into());
        assert_eq!(
            contribution_dirs(root, Some(&one), "skills"),
            vec![root.join("lib/skills")]
        );

        // "." (and "./") mean the plugin root itself, NOT a "." subdirectory.
        for spelling in [".", "./", "./."] {
            let at_root = ManifestPaths::One(spelling.into());
            assert_eq!(
                contribution_dirs(root, Some(&at_root), "skills"),
                vec![root.to_path_buf()],
                "{spelling} should resolve to the plugin root"
            );
        }

        // A list contributes every entry.
        let many = ManifestPaths::Many(vec!["skills".into(), "extra/skills".into()]);
        assert_eq!(
            contribution_dirs(root, Some(&many), "skills"),
            vec![root.join("skills"), root.join("extra/skills")]
        );
    }

    /// REGRESSION: a `SKILL.md` directly inside the scanned directory IS a skill —
    /// the single-skill layout a root-pointing manifest produces. Requiring a
    /// subdirectory skipped it silently.
    #[test]
    fn scan_skills_accepts_a_skill_md_at_the_scanned_root() {
        let dir = std::env::temp_dir().join(format!("tosse-skills-{}", std::process::id()));
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: at-root\n---\nbody").unwrap();
        std::fs::write(nested.join("SKILL.md"), "---\nname: nested-one\n---\nbody").unwrap();

        let found = scan_skills(&dir, ExtScope::Plugin, Some("p@m"));
        let names: Vec<_> = found.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"at-root"), "root SKILL.md must be found: {names:?}");
        assert!(names.contains(&"nested-one"), "nested skills still found: {names:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// REGRESSION: a manifest may list individual FILES, not a directory — real
    /// plugins on this machine do (`"agents": ["./agents/a.md", "./agents/b.md"]`,
    /// `"commands": [...]`). Honouring the manifest naively (scanning each entry as a
    /// directory) would report 0 agents for exactly those plugins, which is WORSE
    /// than the hardcoded path it replaced.
    #[test]
    fn scanners_accept_a_manifest_path_that_names_a_file() {
        let dir = std::env::temp_dir().join(format!("tosse-files-{}", std::process::id()));
        let agents = dir.join("agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join("one.md"), "---\nname: solo-agent\n---\nbody").unwrap();
        std::fs::write(agents.join("two.md"), "---\nname: other-agent\n---\nbody").unwrap();
        std::fs::write(agents.join("notes.txt"), "not an agent").unwrap();

        // A file-valued entry contributes exactly that agent.
        let one = scan_agents(&agents.join("one.md"), ExtScope::Plugin, Some("p@m"));
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].name, "solo-agent");

        // A non-markdown path contributes nothing rather than erroring.
        assert!(scan_agents(&agents.join("notes.txt"), ExtScope::Plugin, None).is_empty());

        // A directory-valued entry still scans the whole directory.
        assert_eq!(scan_agents(&agents, ExtScope::Plugin, None).len(), 2);

        // Command counting follows the same rule.
        assert_eq!(count_markdown(&agents.join("one.md")), 1);
        assert_eq!(count_markdown(&agents.join("notes.txt")), 0);
        assert_eq!(count_markdown(&agents), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Smoke test against the real `~/.claude` of the machine running it. Ignored
    /// by default (touches the home dir) — run with `--ignored`. Mirrors the
    /// live/FS test policy of the git & supervisor modules.
    #[test]
    #[ignore]
    fn list_extensions_reads_real_config() {
        let snap = list_extensions(&std::env::var("HOME").unwrap());
        eprintln!(
            "mcp={} plugins={} skills={} agents={}",
            snap.mcp_servers.len(),
            snap.plugins.len(),
            snap.skills.len(),
            snap.agents.len()
        );
    }
}
