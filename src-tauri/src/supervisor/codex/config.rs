//! Read-only reader of Codex's on-disk extension config — the Codex sibling of
//! `crate::extensions` (which reads `~/.claude*`). This is the SINGLE place that parses
//! `~/.codex/config.toml`, and it emits the SAME [`ExtensionsSnapshot`] domain shape as
//! the Claude side so the front renders a Codex segment with the shared row/section
//! primitives — no Codex-specific viewer.
//!
//! ## Secret redaction (invariant — mirrors `crate::extensions`)
//! An MCP server's `[mcp_servers.<name>.env]` table, its `args`, and any remote server's
//! `headers`/URL query can carry tokens. They are NEVER deserialized: [`McpRaw`] declares
//! ONLY `command` and `url`, so serde silently drops every other field — a secret can't
//! enter the domain types in the first place. A remote server's `url` is additionally
//! query-stripped. And `~/.codex/auth.json` (the ChatGPT OAuth tokens) is NEVER read.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::codex_home;
use crate::extensions::{ExtScope, ExtensionsSnapshot, McpServerInfo, PluginInfo, SkillInfo};

/// The subset of `~/.codex/config.toml` we read. Only `mcp_servers` + `plugins` +
/// `skills.config` are declared; every other table (`model`, `marketplaces`,
/// `features`, `projects`, …) is ignored (serde drops unknown fields — no
/// `deny_unknown_fields`).
#[derive(Debug, Default, Deserialize)]
struct CodexConfigRaw {
    #[serde(default)]
    mcp_servers: BTreeMap<String, McpRaw>,
    #[serde(default)]
    plugins: BTreeMap<String, PluginRaw>,
    #[serde(default)]
    skills: SkillsRaw,
}

/// One `[mcp_servers.<name>]` table — WHITELIST. `args`, `startup_timeout_sec`, the
/// nested `[…​.env]` table and any `headers` are deliberately ABSENT, so secrets are
/// never deserialized (the redaction invariant). `url` is query-stripped downstream.
#[derive(Debug, Default, Deserialize)]
struct McpRaw {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    url: Option<String>,
    /// Per-server toggle (`enabled = false` written by `config/value/write`). Absent
    /// (the common case) = enabled.
    #[serde(default)]
    enabled: Option<bool>,
}

/// One `[plugins."name@marketplace"]` table.
#[derive(Debug, Default, Deserialize)]
struct PluginRaw {
    #[serde(default)]
    enabled: bool,
}

/// The `[skills]` table — only its `config` array of per-skill toggles (what
/// `skills/config/write` maintains). Path + enabled: no secret can live here.
#[derive(Debug, Default, Deserialize)]
struct SkillsRaw {
    #[serde(default)]
    config: Vec<SkillCfgRaw>,
}

/// One `[[skills.config]]` entry: the skill DIR path and its toggle.
#[derive(Debug, Deserialize)]
struct SkillCfgRaw {
    path: PathBuf,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

/// The stderr-only detail for a TOML parse failure: the error's own message plus its
/// byte span, WITHOUT the offending source line that `toml::de::Error`'s Display
/// renders (it can carry a half-typed secret). Split out so the leak test asserts on
/// the exact text that reaches the log.
fn toml_error_log_detail(e: &toml::de::Error) -> String {
    match e.span() {
        Some(span) => format!("{} (bytes {}..{})", e.message(), span.start, span.end),
        None => e.message().to_string(),
    }
}

/// Strip a URL's query/fragment — it can carry an auth token. Same guard the Claude
/// on-disk scanner applies (`extensions::strip_url_query`).
fn strip_url_query(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).to_string()
}

/// Split a plugin id `name@marketplace` into its two halves (`rsplit` so a name that
/// itself contains `@` keeps the LAST `@` as the separator). No `@` → empty marketplace.
fn split_plugin_id(id: &str) -> (String, String) {
    match id.rsplit_once('@') {
        Some((name, marketplace)) => (name.to_string(), marketplace.to_string()),
        None => (id.to_string(), String::new()),
    }
}

/// Whether `name` is a user-defined `[mcp_servers.<name>]` in `~/.codex/config.toml`.
/// The Codex runtime ALSO injects servers at runtime (codex_apps, computer-use) that
/// have NO config entry — those appear in the live `mcpServerStatus/list` but cannot be
/// toggled by writing `mcp_servers.<name>.enabled` (it would produce an entry with no
/// transport, which the app-server rejects). Only a configured server is toggleable.
pub(crate) fn mcp_server_in_config(name: &str) -> bool {
    let Some(home) = codex_home() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(home.join("config.toml")) else {
        return false;
    };
    config_declares_mcp_server(&text, name)
}

/// Pure core of [`mcp_server_in_config`]: does the config TEXT declare `[mcp_servers.<name>]`?
/// A malformed config answers `false` (better to refuse a toggle than to write against a
/// config we couldn't parse).
fn config_declares_mcp_server(text: &str, name: &str) -> bool {
    toml::from_str::<CodexConfigRaw>(text)
        .map(|cfg| cfg.mcp_servers.contains_key(name))
        .unwrap_or(false)
}

/// The configured Codex extension inventory (declared MCP servers + installed plugins +
/// on-disk skills), as an [`ExtensionsSnapshot`]. Read-only; an absent config or skills
/// dir degrades to an empty snapshot, a corrupt config to a warning (never a hard error).
/// `cwd` additionally scans the repository's own `<cwd>/.codex/skills` (scope Project),
/// mirroring what the binary's `skills/list` discovers for that directory.
pub fn list_extensions(cwd: Option<&Path>) -> ExtensionsSnapshot {
    let mut snap = ExtensionsSnapshot::default();
    let Some(home) = codex_home() else {
        return snap;
    };
    let toggles = read_config(&home.join("config.toml"), &mut snap);
    scan_skills(&home.join("skills"), ExtScope::User, &mut snap);
    if let Some(cwd) = cwd {
        scan_skills(&cwd.join(".codex/skills"), ExtScope::Project, &mut snap);
    }
    apply_skill_toggles(&toggles, &mut snap);
    snap
}

/// Fold the `[[skills.config]]` toggles onto the scanned skills: an entry whose path
/// is the skill's DIR (the parent of its `SKILL.md`) carries that skill's state.
/// Untoggled skills stay enabled (the Codex default).
fn apply_skill_toggles(toggles: &[(PathBuf, bool)], snap: &mut ExtensionsSnapshot) {
    if toggles.is_empty() {
        return;
    }
    for skill in &mut snap.skills {
        let dir = Path::new(&skill.path).parent();
        if let Some(dir) = dir {
            if let Some((_, enabled)) = toggles.iter().find(|(p, _)| p == dir) {
                skill.enabled = *enabled;
            }
        }
    }
}

/// Parse `config.toml` into the snapshot's MCP + plugin lists. An absent file → the
/// common "nothing configured" case (silent); a present-but-unparseable file → a warning
/// so a broken config is never indiscernible from an empty inventory. Returns the
/// `[[skills.config]]` toggles (dir path → enabled) for [`apply_skill_toggles`].
fn read_config(path: &Path, snap: &mut ExtensionsSnapshot) -> Vec<(PathBuf, bool)> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            snap.warnings.push(format!("~/.codex/config.toml unreadable: {e}"));
            return Vec::new();
        }
    };
    let cfg: CodexConfigRaw = match toml::from_str(&text) {
        Ok(c) => c,
        Err(e) => {
            // ⚠️ SECRET-LEAK GUARD: `toml::de::Error`'s Display embeds the OFFENDING SOURCE
            // LINE (e.g. a half-typed `SECRET_TOKEN = "sk-…`), so the FULL error must never
            // be printed ANYWHERE — stderr included (terminal scrollback, unified log).
            // Only the bounded message + byte span go to the log; the UI gets a
            // generic-but-non-silent "malformed" notice so the user still knows.
            eprintln!(
                "[codex-config] ~/.codex/config.toml parse error: {}",
                toml_error_log_detail(&e)
            );
            snap.warnings
                .push("~/.codex/config.toml is malformed (syntax error).".to_string());
            return Vec::new();
        }
    };
    for (name, m) in cfg.mcp_servers {
        let transport = Some(if m.url.is_some() { "http" } else { "stdio" }.to_string());
        snap.mcp_servers.push(McpServerInfo {
            name,
            scope: ExtScope::User,
            transport,
            command: m.command,
            url: m.url.as_deref().map(strip_url_query),
            source: None,
            // Per-server toggle written by `config/value/write`; absent = enabled.
            enabled: m.enabled.unwrap_or(true),
        });
    }
    for (id, p) in cfg.plugins {
        let (name, marketplace) = split_plugin_id(&id);
        snap.plugins.push(PluginInfo {
            id: id.clone(),
            name,
            marketplace,
            version: None,
            description: None,
            enabled: p.enabled,
            scope: ExtScope::User,
            update_available: false,
            // Codex has no marketplace pin to compare against, so nothing is unproven.
            update_unproven: false,
            latest_version: None,
            skill_count: 0,
            agent_count: 0,
            command_count: 0,
            mcp_count: 0,
        });
    }
    cfg.skills
        .config
        .into_iter()
        .map(|c| (c.path, c.enabled))
        .collect()
}

/// Scan `~/.codex/skills` for `<skill>/SKILL.md` files (one level, plus one level inside a
/// group dir such as `.system` — the bundled skills live under `skills/.system/<name>/`).
/// Best-effort: an unreadable dir is skipped, not an error.
fn scan_skills(skills_dir: &Path, scope: ExtScope, snap: &mut ExtensionsSnapshot) {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // A skill dir (`<name>/SKILL.md`) or a GROUP dir (`.system/`) holding skill dirs.
        if path.join("SKILL.md").is_file() {
            push_skill(&path, scope, snap);
        } else {
            let Ok(inner) = std::fs::read_dir(&path) else {
                continue;
            };
            for child in inner.flatten() {
                let cpath = child.path();
                if cpath.is_dir() && cpath.join("SKILL.md").is_file() {
                    push_skill(&cpath, scope, snap);
                }
            }
        }
    }
}

/// Push one skill (its dir name + optional frontmatter description) onto the snapshot.
fn push_skill(dir: &Path, scope: ExtScope, snap: &mut ExtensionsSnapshot) {
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let skill_md = dir.join("SKILL.md");
    let description = std::fs::read_to_string(&skill_md)
        .ok()
        .and_then(|body| frontmatter_description(&body));
    snap.skills.push(SkillInfo {
        name: name.to_string(),
        description,
        scope,
        source: None,
        path: skill_md.to_string_lossy().to_string(),
        // The `[[skills.config]]` toggles are folded on afterwards (`apply_skill_toggles`).
        enabled: true,
    });
}

/// Pull the `description:` value from a `SKILL.md` YAML frontmatter block (between the
/// leading `---` fences). `None` when there is no frontmatter or no description line.
fn frontmatter_description(body: &str) -> Option<String> {
    let trimmed = body.trim_start();
    let rest = trimmed.strip_prefix("---")?;
    // The frontmatter is everything up to the next `---` line.
    let end = rest.find("\n---")?;
    for line in rest[..end].lines() {
        if let Some(v) = line.trim().strip_prefix("description:") {
            let v = v.trim().trim_matches(['"', '\'']).trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mcp_and_plugins_and_redacts_secrets() {
        // A realistic config: an stdio MCP with a SECRET env table + args, a remote MCP
        // with a token in the URL query, and two plugins.
        let toml = r#"
model = "gpt-5.5"

[mcp_servers.node_repl]
command = "/opt/node_repl"
args = ["--foo"]
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
SECRET_TOKEN = "sk-super-secret"
CODEX_HOME = "/Users/x/.codex"

[mcp_servers.remote]
url = "https://mcp.example.com/sse?token=abc123"

[plugins."browser@openai-bundled"]
enabled = true

[plugins."pdf@openai-primary-runtime"]
enabled = false
"#;
        let mut snap = ExtensionsSnapshot::default();
        // Drive read_config directly with a temp file.
        let dir = std::env::temp_dir().join(format!("fd-codex-cfg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, toml).unwrap();
        read_config(&path, &mut snap);
        let _ = std::fs::remove_dir_all(&dir);

        // MCP servers surfaced, NO secret anywhere.
        let node = snap.mcp_servers.iter().find(|m| m.name == "node_repl").expect("node_repl");
        assert_eq!(node.command.as_deref(), Some("/opt/node_repl"));
        assert_eq!(node.transport.as_deref(), Some("stdio"));
        assert!(node.enabled, "a declared server is active");
        let remote = snap.mcp_servers.iter().find(|m| m.name == "remote").expect("remote");
        assert_eq!(remote.transport.as_deref(), Some("http"));
        // The URL query (carrying the token) is stripped.
        assert_eq!(remote.url.as_deref(), Some("https://mcp.example.com/sse"));
        // No secret from `[….env]` leaks into ANY surfaced field.
        let blob = format!("{snap:?}");
        assert!(!blob.contains("sk-super-secret"), "env secret must never be surfaced");
        assert!(!blob.contains("token=abc123"), "url token must never be surfaced");
        assert!(!blob.contains("--foo"), "args must never be surfaced");

        // Plugins split into name@marketplace with their enabled flag.
        let browser = snap.plugins.iter().find(|p| p.id == "browser@openai-bundled").expect("browser");
        assert_eq!(browser.name, "browser");
        assert_eq!(browser.marketplace, "openai-bundled");
        assert!(browser.enabled);
        let pdf = snap.plugins.iter().find(|p| p.id == "pdf@openai-primary-runtime").expect("pdf");
        assert!(!pdf.enabled);
    }

    #[test]
    fn mcp_enabled_flag_and_skill_toggles_are_resolved() {
        // Extensions v2: a server toggled off via `config/value/write` carries
        // `enabled = false`; `[[skills.config]]` entries fold onto scanned skills by DIR.
        let dir = std::env::temp_dir().join(format!("fd-codex-v2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("skills/on-skill")).unwrap();
        std::fs::create_dir_all(dir.join("skills/off-skill")).unwrap();
        std::fs::write(dir.join("skills/on-skill/SKILL.md"), "---\ndescription: a\n---\n").unwrap();
        std::fs::write(dir.join("skills/off-skill/SKILL.md"), "---\ndescription: b\n---\n").unwrap();
        let off_dir = dir.join("skills/off-skill");
        let toml = format!(
            "[mcp_servers.off_server]\ncommand = \"/bin/x\"\nenabled = false\n\n\
             [[skills.config]]\npath = \"{}\"\nenabled = false\n",
            off_dir.display()
        );
        let path = dir.join("config.toml");
        std::fs::write(&path, toml).unwrap();

        let mut snap = ExtensionsSnapshot::default();
        let toggles = read_config(&path, &mut snap);
        scan_skills(&dir.join("skills"), ExtScope::User, &mut snap);
        apply_skill_toggles(&toggles, &mut snap);
        let _ = std::fs::remove_dir_all(&dir);

        let server = snap.mcp_servers.iter().find(|m| m.name == "off_server").expect("server");
        assert!(!server.enabled, "enabled = false must surface as disabled");
        let on = snap.skills.iter().find(|s| s.name == "on-skill").expect("on-skill");
        assert!(on.enabled, "an untoggled skill stays enabled (the Codex default)");
        let off = snap.skills.iter().find(|s| s.name == "off-skill").expect("off-skill");
        assert!(!off.enabled, "the [[skills.config]] toggle must fold onto the row");
    }

    #[test]
    fn only_configured_mcp_servers_are_reported_as_toggleable() {
        // node_repl is user-declared → toggleable; codex_apps is a runtime-injected
        // server absent from config.toml → NOT toggleable (writing its enabled key
        // would create a transport-less entry the app-server rejects).
        let toml = "[mcp_servers.node_repl]\ncommand = \"/bin/x\"\n";
        assert!(config_declares_mcp_server(toml, "node_repl"));
        assert!(!config_declares_mcp_server(toml, "codex_apps"));
        assert!(!config_declares_mcp_server(toml, "computer-use"));
        // A malformed config refuses the toggle rather than writing blind.
        assert!(!config_declares_mcp_server("this = not [[[ valid", "node_repl"));
    }

    #[test]
    fn corrupt_config_surfaces_a_warning_not_a_panic() {
        let mut snap = ExtensionsSnapshot::default();
        let dir = std::env::temp_dir().join(format!("fd-codex-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, "this is = not valid toml [[[").unwrap();
        read_config(&path, &mut snap);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!snap.warnings.is_empty(), "a malformed config must surface a warning");
        assert!(snap.mcp_servers.is_empty());
    }

    #[test]
    fn a_syntax_error_near_a_secret_does_not_leak_it_into_the_warning() {
        // A malformed config with an unterminated secret string: the toml error's Display
        // embeds that source line, so the user-facing warning must NOT contain the secret.
        let mut snap = ExtensionsSnapshot::default();
        let dir = std::env::temp_dir().join(format!("fd-codex-leak-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        let source = "[mcp_servers.node_repl.env]\nSECRET_TOKEN = \"sk-super-secret-LEAKED\n";
        std::fs::write(&path, source).unwrap();
        read_config(&path, &mut snap);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!snap.warnings.is_empty(), "a malformed config must still surface a warning");
        let blob = snap.warnings.join(" ");
        assert!(!blob.contains("sk-super-secret-LEAKED"), "the secret must never reach the warning");
        assert!(!blob.contains("SECRET_TOKEN"), "not even the secret's field name leaks");

        // The stderr log is bounded the same way: message + span only, never the line.
        let err = toml::from_str::<CodexConfigRaw>(source).expect_err("source is malformed");
        let log = toml_error_log_detail(&err);
        assert!(!log.contains("sk-super-secret-LEAKED"), "the secret must never reach the log");
        assert!(!log.contains("SECRET_TOKEN"), "not even the secret's field name is logged");
        assert!(!log.is_empty(), "the log detail still says WHAT failed");
    }

    #[test]
    fn absent_config_is_silent_and_empty() {
        let mut snap = ExtensionsSnapshot::default();
        read_config(Path::new("/definitely/not/here/config.toml"), &mut snap);
        assert!(snap.warnings.is_empty(), "an absent config is the common case, not a warning");
        assert!(snap.mcp_servers.is_empty() && snap.plugins.is_empty());
    }

    #[test]
    fn scans_skills_at_top_level_and_inside_a_group_dir() {
        let dir = std::env::temp_dir().join(format!("fd-codex-skills-{}", uuid::Uuid::new_v4()));
        // A top-level user skill with frontmatter, and a bundled one under `.system/`.
        std::fs::create_dir_all(dir.join("my-skill")).unwrap();
        std::fs::write(
            dir.join("my-skill/SKILL.md"),
            "---\nname: my-skill\ndescription: Does a thing\n---\nbody",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join(".system/imagegen")).unwrap();
        std::fs::write(dir.join(".system/imagegen/SKILL.md"), "no frontmatter here").unwrap();
        let mut snap = ExtensionsSnapshot::default();
        scan_skills(&dir, ExtScope::User, &mut snap);
        let _ = std::fs::remove_dir_all(&dir);

        let mine = snap.skills.iter().find(|s| s.name == "my-skill").expect("top-level skill");
        assert_eq!(mine.description.as_deref(), Some("Does a thing"));
        assert!(snap.skills.iter().any(|s| s.name == "imagegen"), "bundled skill under .system found");
    }

    #[test]
    fn frontmatter_description_handles_quotes_and_absence() {
        assert_eq!(
            frontmatter_description("---\ndescription: \"quoted value\"\n---\nx").as_deref(),
            Some("quoted value")
        );
        assert!(frontmatter_description("no frontmatter").is_none());
        assert!(frontmatter_description("---\nname: x\n---\n").is_none());
    }
}
