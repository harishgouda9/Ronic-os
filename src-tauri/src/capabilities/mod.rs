mod prebuilt;
mod prompt;
mod registry;
mod skill_doc;

use crate::db;
use crate::error::{err, Result};
use crate::models::*;
use crate::util::{nid, now_ms, run_capture};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static RECONCILE_AFTER: AtomicU64 = AtomicU64::new(0);

pub use prompt::{in_index, system_for};

pub struct CapabilityView {
    pub skills: Vec<Skill>,
    pub plugins: Vec<PluginPackage>,
    pub mcp_servers: Vec<McpServer>,
    pub proposals: Vec<SkillProposal>,
    pub registry: Vec<RegistryTool>,
    pub skill_index_delta: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FileDraft {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SkillDraft {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub profile_id: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub slash_command: String,
    #[serde(default)]
    pub requires_tools: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub files: Vec<FileDraft>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginDraft {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub has_agent: bool,
    #[serde(default)]
    pub has_desktop: bool,
    #[serde(default)]
    pub tools: Vec<DeclaredTool>,
    #[serde(default)]
    pub hooks: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub desktop: Vec<DesktopBit>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpDraft {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub tools: Vec<DeclaredTool>,
    #[serde(default)]
    pub secret: String,
}

pub fn mcp_id(draft: &McpDraft) -> String {
    let given = draft.id.trim();
    if !given.is_empty() {
        return given.to_string();
    }
    format!("mcp-{}", skill_doc::sanitize_slug(&draft.name))
}

pub fn reconcile(conn: &Connection, home: &Path, project_root: &str) -> Result<()> {
    fs::create_dir_all(home.join("profiles"))?;
    fs::create_dir_all(home.join("catalog").join("skills"))?;
    fs::create_dir_all(home.join("plugins"))?;
    fs::create_dir_all(home.join("mcp"))?;
    prebuilt::install(home)?;
    migrate_legacy(conn, home)?;
    sync_plugins(conn, home, project_root)?;
    pin_prebuilt(conn)?;
    sync_mcp(conn, home)?;
    sync_skills(conn, home)?;
    let next = now_ms().max(0) as u64 + 20_000;
    RECONCILE_AFTER.store(next, Ordering::Relaxed);
    Ok(())
}

pub fn reconcile_if_due(conn: &Connection, home: &Path, project_root: &str) -> Result<()> {
    let now = now_ms().max(0) as u64;
    if now < RECONCILE_AFTER.load(Ordering::Relaxed) {
        return Ok(());
    }
    reconcile(conn, home, project_root)
}

pub fn view(conn: &Connection, home: &Path, profile_id: &str) -> Result<CapabilityView> {
    let plugins = read_plugins(conn)?;
    let mcp_servers = read_mcp(conn)?;
    let known = registry::known_names(&plugins, &mcp_servers);
    let skills = read_skills(conn, home, &known)?;
    let proposals = read_proposals(conn, &skills)?;
    Ok(CapabilityView {
        skills,
        registry: registry::assemble(&plugins, &mcp_servers, profile_id),
        plugins,
        mcp_servers,
        proposals,
        skill_index_delta: db::kv_get(conn, &format!("skill_delta:{profile_id}"))?.unwrap_or_default(),
    })
}

pub fn take_delta(conn: &Connection, profile_id: &str) -> Result<String> {
    let key = format!("skill_delta:{profile_id}");
    let value = db::kv_get(conn, &key)?.unwrap_or_default();
    if !value.is_empty() {
        db::kv_set(conn, &key, "")?;
    }
    Ok(value)
}

pub fn plugin_agent_on(plugins: &[PluginPackage], plugin_id: &str, profile_id: &str) -> bool {
    plugins.iter().any(|plugin| {
        plugin.id == plugin_id && plugin.trust == "trusted" && plugin.agent_enables.iter().any(|flag| flag.profile_id == profile_id && flag.enabled)
    })
}

pub fn save_skill(conn: &Connection, home: &Path, draft: SkillDraft) -> Result<()> {
    let existing = if draft.id.trim().is_empty() { None } else { skill_row(conn, draft.id.trim())? };
    let (id, origin, owner, plugin_id, path) = if let Some(row) = existing {
        (row.id, row.origin, row.owner, row.plugin_id, locate(home, &row.body_path))
    } else {
        let profile = draft.profile_id.trim();
        if !profile_exists(conn, profile)? {
            return Err(err("Pick a bot profile before saving a skill."));
        }
        let slug = skill_doc::sanitize_slug(&draft.slug);
        if slug.is_empty() {
            return Err(err("skill needs a name"));
        }
        let id = format!("sk-{profile}-{slug}");
        let path = home.join("profiles").join(profile).join("skills").join(&slug).join("SKILL.md");
        (id, "profile".into(), profile.to_string(), String::new(), path)
    };
    let text = skill_text(&draft);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, &text)?;
    write_support(path.parent().unwrap_or(Path::new(".")), &draft.files)?;
    let parsed = skill_doc::parse_skill(&text, &draft.slug);
    upsert_skill(conn, &id, &display_slug(&origin, &parsed.name, &draft.slug), &origin, &owner, &plugin_id, &parsed, &display_path(home, &path))?;
    if origin == "profile" {
        ensure_enable(conn, &id, &owner, true)?;
        note_delta(conn, &owner, &format!("Skill index changed: {} was saved.", parsed.slash_command))?;
    }
    Ok(())
}

pub fn toggle_skill(conn: &Connection, home: &Path, id: &str, profile_id: &str, enabled: bool) -> Result<()> {
    if !profile_exists(conn, profile_id)? {
        return Err(err("profile not found"));
    }
    let current = view(conn, home, profile_id)?;
    let skill = current.skills.iter().find(|skill| skill.id == id).ok_or_else(|| err("skill not found"))?;
    if enabled && !skill.hidden_reason.is_empty() {
        return Err(err(skill.hidden_reason.clone()));
    }
    conn.execute(
        "INSERT INTO skill_enables (skill_id, profile_id, enabled) VALUES (?1, ?2, ?3) ON CONFLICT(skill_id, profile_id) DO UPDATE SET enabled = excluded.enabled",
        params![id, profile_id, enabled as i64],
    )?;
    note_delta(conn, profile_id, &format!("Skill index changed: {} is {}.", skill.slash_command, if enabled { "on" } else { "off" }))?;
    Ok(())
}

pub fn remove_skill(conn: &Connection, home: &Path, id: &str) -> Result<()> {
    let row = skill_row(conn, id)?.ok_or_else(|| err("skill not found"))?;
    if row.origin == "plugin" {
        return Err(err("Remove the plugin to remove a bundled skill."));
    }
    let path = locate(home, &row.body_path);
    if let Some(dir) = path.parent() {
        if dir.starts_with(home) {
            let _ = fs::remove_dir_all(dir);
        }
    }
    conn.execute("DELETE FROM skill_enables WHERE skill_id = ?1", params![id])?;
    conn.execute("DELETE FROM skills WHERE id = ?1", params![id])?;
    if !row.owner.is_empty() {
        note_delta(conn, &row.owner, &format!("Skill index changed: /{} was removed.", row.slug))?;
    }
    Ok(())
}

pub fn propose_skill(conn: &Connection, profile_id: &str, thread_id: &str, slug: &str, description: &str, body: &str) -> Result<String> {
    if !profile_exists(conn, profile_id)? {
        return Err(err("profile not found"));
    }
    let slug = skill_doc::sanitize_slug(slug);
    if slug.is_empty() || body.trim().is_empty() {
        return Err(err("A proposal needs a name and a SKILL.md body."));
    }
    let id = nid("proposal");
    conn.execute(
        "INSERT INTO skill_proposals (id, profile_id, thread_id, slug, description, proposed_body, status, created_at) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7)",
        params![id, profile_id, thread_id, slug, description.trim(), body, now_ms()],
    )?;
    Ok("Pending approval. The skill file was not written.".into())
}

pub fn resolve_proposal(conn: &Connection, home: &Path, id: &str, approve: bool) -> Result<String> {
    let (profile_id, slug, description, body, status): (String, String, String, String, String) = conn
        .query_row(
            "SELECT profile_id, slug, description, proposed_body, status FROM skill_proposals WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|_| err("proposal not found"))?;
    if status != "pending" {
        return Err(err("That proposal is already resolved."));
    }
    if !approve {
        conn.execute("UPDATE skill_proposals SET status = 'rejected' WHERE id = ?1", params![id])?;
        return Ok("Proposal rejected.".into());
    }
    let draft = SkillDraft {
        id: String::new(),
        profile_id: profile_id.clone(),
        slug: slug.clone(),
        title: slug.clone(),
        description,
        slash_command: format!("/{slug}"),
        requires_tools: Vec::new(),
        platforms: vec!["windows".into(), "macos".into(), "linux".into()],
        body,
        files: Vec::new(),
    };
    save_skill(conn, home, draft)?;
    conn.execute("UPDATE skill_proposals SET status = 'approved' WHERE id = ?1", params![id])?;
    Ok(format!("Wrote /{slug} for this profile."))
}

pub fn load_skill_text(conn: &Connection, home: &Path, profile_id: &str, slug: &str) -> Result<String> {
    let current = view(conn, home, profile_id)?;
    let token = if slug.starts_with('/') { slug.to_string() } else { format!("/{slug}") };
    let skill = current.skills.iter().find(|skill| {
        prompt::in_index(skill, profile_id, plugin_agent_on(&current.plugins, &skill.plugin_id, profile_id))
            && (skill.slash_command == token || skill.slug == slug.trim_start_matches('/'))
    });
    match skill {
        Some(skill) => Ok(skill.body.clone()),
        None => Err(err("That skill is not in this profile's index.")),
    }
}

pub fn save_plugin(conn: &Connection, home: &Path, draft: PluginDraft) -> Result<()> {
    let slug = skill_doc::sanitize_slug(&draft.slug);
    if slug.is_empty() {
        return Err(err("plugin needs a name"));
    }
    let existing = if draft.id.trim().is_empty() { None } else { plugin_row(conn, draft.id.trim())? };
    let (id, dir, source) = if let Some(row) = existing {
        (row.id, PathBuf::from(&row.source_path), row.source)
    } else {
        (format!("plug-{slug}"), home.join("plugins").join(&slug), "folder".into())
    };
    let parsed = skill_doc::ParsedPlugin {
        slug: slug.clone(),
        name: if draft.name.trim().is_empty() { slug.clone() } else { draft.name.trim().to_string() },
        version: if draft.version.trim().is_empty() { "1.0.0".into() } else { draft.version.trim().to_string() },
        has_agent: draft.has_agent,
        has_desktop: draft.has_desktop,
        tools: draft.tools,
        hooks: draft.hooks.into_iter().filter(|hook| skill_doc::is_hook(hook)).collect(),
        skills: draft.skills.iter().map(|skill| skill_doc::sanitize_slug(skill)).filter(|skill| !skill.is_empty()).collect(),
        desktop: draft.desktop.into_iter().filter(|bit| matches!(bit.kind.as_str(), "status" | "command" | "pane")).collect(),
    };
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("plugin.yaml"), skill_doc::render_plugin(&parsed))?;
    for skill in &parsed.skills {
        let file = dir.join("skills").join(skill).join("SKILL.md");
        if !file.exists() {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(file, stub_skill(&slug, skill))?;
        }
    }
    let trust = plugin_row(conn, &id)?.map(|row| row.trust).unwrap_or_else(|| "trusted".into());
    let desktop_enabled = plugin_row(conn, &id)?.map(|row| row.desktop_enabled).unwrap_or(0);
    upsert_plugin(conn, &id, &parsed, &source, &dir, &trust, desktop_enabled)?;
    Ok(())
}

pub fn toggle_plugin_agent(conn: &Connection, id: &str, profile_id: &str, enabled: bool) -> Result<()> {
    let row = plugin_row(conn, id)?.ok_or_else(|| err("plugin not found"))?;
    if enabled && row.trust != "trusted" {
        return Err(err("Trust this plugin before enabling it."));
    }
    if enabled && row.has_agent == 0 {
        return Err(err("This plugin has no agent part."));
    }
    if !profile_exists(conn, profile_id)? {
        return Err(err("profile not found"));
    }
    conn.execute(
        "INSERT INTO plugin_agent_enables (plugin_id, profile_id, enabled) VALUES (?1, ?2, ?3) ON CONFLICT(plugin_id, profile_id) DO UPDATE SET enabled = excluded.enabled",
        params![id, profile_id, enabled as i64],
    )?;
    Ok(())
}

pub fn toggle_plugin_desktop(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
    let row = plugin_row(conn, id)?.ok_or_else(|| err("plugin not found"))?;
    if enabled && row.trust != "trusted" {
        return Err(err("Trust this plugin before enabling it."));
    }
    if enabled && row.has_desktop == 0 {
        return Err(err("This plugin has no desktop part."));
    }
    conn.execute("UPDATE plugins SET desktop_enabled = ?1 WHERE id = ?2", params![enabled as i64, id])?;
    Ok(())
}

pub fn trust_plugin(conn: &Connection, id: &str) -> Result<()> {
    let changed = conn.execute("UPDATE plugins SET trust = 'trusted' WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(err("plugin not found"));
    }
    Ok(())
}

pub fn remove_plugin(conn: &Connection, home: &Path, id: &str) -> Result<String> {
    let row = plugin_row(conn, id)?.ok_or_else(|| err("plugin not found"))?;
    if row.source == "builtin" || row.id == prebuilt::PLUGIN_ID {
        return Err(err("Prebuilt skills ship with Ronic OS. Turn a skill off instead of removing the set."));
    }
    if row.source == "project" {
        conn.execute("UPDATE plugins SET trust = 'untrusted', desktop_enabled = 0 WHERE id = ?1", params![id])?;
        conn.execute("UPDATE plugin_agent_enables SET enabled = 0 WHERE plugin_id = ?1", params![id])?;
        return Ok("Project plugin stays on disk. Switches are off until you trust it again.".into());
    }
    let dir = PathBuf::from(&row.source_path);
    if dir.starts_with(home.join("plugins")) {
        let _ = fs::remove_dir_all(&dir);
    }
    conn.execute("DELETE FROM plugin_agent_enables WHERE plugin_id = ?1", params![id])?;
    conn.execute("DELETE FROM skills WHERE plugin_id = ?1", params![id])?;
    conn.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
    Ok("Plugin removed from the app index.".into())
}

pub fn save_mcp(conn: &Connection, home: &Path, draft: McpDraft) -> Result<()> {
    let slug = skill_doc::sanitize_slug(&draft.name);
    if slug.is_empty() {
        return Err(err("MCP server needs a name"));
    }
    let transport = if draft.transport == "sse" { "sse" } else { "stdio" };
    let existing = if draft.id.trim().is_empty() { None } else { mcp_row(conn, draft.id.trim())? };
    let id = existing.as_ref().map(|row| row.id.clone()).unwrap_or_else(|| mcp_id(&draft));
    let trust = existing.as_ref().map(|row| row.trust.clone()).unwrap_or_else(|| "untrusted".into());
    let path = home.join("mcp").join(format!("{id}.json"));
    let body = json!({
        "id": id,
        "name": draft.name.trim(),
        "transport": transport,
        "command": draft.command,
        "args": draft.args,
        "url": draft.url,
        "tools": draft.tools,
    });
    fs::create_dir_all(home.join("mcp"))?;
    fs::write(&path, serde_json::to_string_pretty(&body)?)?;
    conn.execute(
        "INSERT INTO mcp_servers (id, name, transport, command, args_json, url, trust, tools_json, last_error, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, transport=excluded.transport, command=excluded.command, args_json=excluded.args_json, url=excluded.url, tools_json=excluded.tools_json, updated_at=excluded.updated_at",
        params![id, draft.name.trim(), transport, draft.command, serde_json::to_string(&draft.args)?, draft.url, trust, serde_json::to_string(&draft.tools)?, now_ms()],
    )?;
    enable_mcp_defaults(conn, &id)?;
    Ok(())
}

/// Missing profile rows default to Active. An explicit Off is left alone.
pub fn enable_mcp_defaults(conn: &Connection, id: &str) -> Result<()> {
    for profile in profile_ids(conn)? {
        conn.execute(
            "INSERT INTO mcp_enables (server_id, profile_id, enabled) VALUES (?1, ?2, 1) ON CONFLICT(server_id, profile_id) DO NOTHING",
            params![id, profile],
        )?;
    }
    Ok(())
}

pub fn server_id_for_name(name: &str) -> String {
    format!("mcp-{}", skill_doc::sanitize_slug(name))
}

pub fn toggle_mcp(conn: &Connection, id: &str, profile_id: &str, enabled: bool) -> Result<()> {
    let row = mcp_row(conn, id)?.ok_or_else(|| err("MCP server not found"))?;
    if enabled && row.trust != "trusted" {
        return Err(err("Trust this MCP server before enabling it."));
    }
    if !profile_exists(conn, profile_id)? {
        return Err(err("profile not found"));
    }
    conn.execute(
        "INSERT INTO mcp_enables (server_id, profile_id, enabled) VALUES (?1, ?2, ?3) ON CONFLICT(server_id, profile_id) DO UPDATE SET enabled = excluded.enabled",
        params![id, profile_id, enabled as i64],
    )?;
    Ok(())
}

pub fn trust_mcp(conn: &Connection, id: &str) -> Result<()> {
    let changed = conn.execute("UPDATE mcp_servers SET trust = 'trusted' WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(err("MCP server not found"));
    }
    enable_mcp_defaults(conn, id)?;
    Ok(())
}

pub fn remove_mcp(conn: &Connection, home: &Path, id: &str) -> Result<()> {
    let path = home.join("mcp").join(format!("{id}.json"));
    let _ = fs::remove_file(path);
    conn.execute("DELETE FROM mcp_enables WHERE server_id = ?1", params![id])?;
    let changed = conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(err("MCP server not found"));
    }
    Ok(())
}

// Marketplace items whose integration is an MCP server. Installing one of
// these slugs registers the real server entry (untrusted until the user
// reviews it) instead of only writing a documentation skill.
struct CatalogMcp {
    name: &'static str,
    transport: &'static str, // "sse" for remote URLs, "stdio" for local commands
    command: &'static str,
    args: &'static [&'static str],
    url: &'static str,
    note: &'static str,
}

fn catalog_mcp(slug: &str) -> Option<CatalogMcp> {
    let found: CatalogMcp = match slug {
        "notion-mcp" => CatalogMcp { name: "Notion", transport: "sse", command: "", args: &[], url: "https://mcp.notion.com/mcp", note: "Notion asks you to sign in the first time it connects." },
        "linear-mcp" => CatalogMcp { name: "Linear", transport: "sse", command: "", args: &[], url: "https://mcp.linear.app/sse", note: "Linear asks you to sign in the first time it connects." },
        "sentry-mcp" => CatalogMcp { name: "Sentry", transport: "sse", command: "", args: &[], url: "https://mcp.sentry.dev/mcp", note: "Sentry asks you to authorize the connection." },
        "slack-mcp" => CatalogMcp { name: "Slack", transport: "sse", command: "", args: &[], url: "https://slack.com/api/mcp", note: "Slack asks you to install the app into your workspace." },
        "composio-mcp" => CatalogMcp { name: "Composio MCP", transport: "sse", command: "", args: &[], url: "https://connect.composio.dev/mcp", note: "Composio asks you to connect apps from its dashboard." },
        "github-mcp" => CatalogMcp { name: "GitHub MCP", transport: "sse", command: "", args: &[], url: "https://api.githubcopilot.com/mcp/", note: "GitHub asks you to authorize with your account." },
        "supabase-mcp" => CatalogMcp { name: "Supabase", transport: "stdio", command: "npx", args: &["-y", "supabase-mcp@latest"], url: "", note: "Supabase needs a personal access token in the server command." },
        "filesystem-mcp" => CatalogMcp { name: "Filesystem MCP", transport: "stdio", command: "npx", args: &["-y", "@modelcontextprotocol/server-filesystem"], url: "", note: "The server opens the workspace folder on this computer." },
        "memory-mcp" => CatalogMcp { name: "Memory MCP", transport: "stdio", command: "npx", args: &["-y", "@modelcontextprotocol/server-memory"], url: "", note: "" },
        "playwright-cdp" => CatalogMcp { name: "Playwright MCP", transport: "stdio", command: "npx", args: &["-y", "@playwright/mcp@latest"], url: "", note: "" },
        "razorpay-upi" => CatalogMcp { name: "Razorpay MCP", transport: "stdio", command: "npx", args: &["-y", "razorpay-mcp"], url: "", note: "Razorpay needs your key id and secret in the server command." },
        _ => return None,
    };
    Some(found)
}

pub fn install_catalog(conn: &Connection, home: &Path, profile_id: &str, slug: &str, title: &str, blurb: &str) -> Result<String> {
    let slug = skill_doc::sanitize_slug(slug);
    if slug.is_empty() {
        return Err(err("unknown marketplace item"));
    }
    // The skill stays as the readable playbook; MCP-backed items also get the
    // real server registered so the integration exists, not just its docs.
    let mut installed_mcp = false;
    let mut mcp_note = String::new();
    if let Some(mcp) = catalog_mcp(&slug) {
        let mut args: Vec<String> = mcp.args.iter().map(|arg| arg.to_string()).collect();
        if slug == "filesystem-mcp" {
            // Point the official filesystem server at this workspace.
            args.push(home.display().to_string());
        }
        save_mcp(conn, home, McpDraft {
            id: String::new(),
            name: mcp.name.into(),
            transport: mcp.transport.into(),
            command: mcp.command.into(),
            args,
            url: mcp.url.into(),
            tools: Vec::new(),
            secret: String::new(),
        })?;
        installed_mcp = true;
        mcp_note = mcp.note.to_string();
    }
    let body = skill_doc::render_skill(&slug, title, &format!("/{slug}"), &[], &["windows".into(), "macos".into(), "linux".into()], &format!("# {title}\n\n{blurb}\n"));
    let catalog = home.join("catalog").join("skills").join(&slug).join("SKILL.md");
    if let Some(parent) = catalog.parent() {
        fs::create_dir_all(parent)?;
    }
    if !catalog.exists() {
        fs::write(&catalog, &body)?;
    }
    let parsed = skill_doc::parse_skill(&fs::read_to_string(&catalog)?, &slug);
    upsert_skill(conn, &format!("sk-catalog-{slug}"), &slug, "catalog", "", "", &parsed, &display_path(home, &catalog))?;
    let mcp_suffix = if installed_mcp {
        format!(" The MCP server entry is saved — review and trust it on the Skills screen before enabling it. {mcp_note}").trim_end().to_string()
    } else {
        String::new()
    };
    if profile_id.is_empty() || !profile_exists(conn, profile_id)? {
        return Ok(format!("Catalog skill saved. Create a bot profile to enable it.{mcp_suffix}"));
    }
    let copy = home.join("profiles").join(profile_id).join("skills").join(&slug).join("SKILL.md");
    if let Some(parent) = copy.parent() {
        fs::create_dir_all(parent)?;
    }
    if !copy.exists() {
        fs::write(&copy, fs::read_to_string(&catalog)?)?;
    }
    let id = format!("sk-{profile_id}-{slug}");
    upsert_skill(conn, &id, &slug, "profile", profile_id, "", &parsed, &display_path(home, &copy))?;
    ensure_enable(conn, &id, profile_id, true)?;
    note_delta(conn, profile_id, &format!("Skill index changed: /{slug} is on."))?;
    Ok(format!("Installed into the selected profile.{mcp_suffix}"))
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn resolve_profile(conn: &Connection, profile_id: &str) -> String {
    if !profile_id.trim().is_empty() {
        return profile_id.trim().to_string();
    }
    if let Ok(Some(id)) = crate::db::kv_get(conn, "active_profile") {
        if !id.trim().is_empty() {
            return id.trim().to_string();
        }
    }
    if let Ok(first_id) = conn.query_row("SELECT id FROM bot_profiles ORDER BY rowid ASC LIMIT 1", [], |row| row.get::<_, String>(0)) {
        return first_id;
    }
    "bot_default".to_string()
}

pub fn install_skill_from_source(
    conn: &Connection,
    home: &Path,
    profile_id: &str,
    source: &str,
    slug_opt: Option<&str>,
) -> Result<String> {
    let source = source.trim();
    if source.is_empty() {
        return Err(err("install_skill needs a source URL, GitHub link, or catalog slug"));
    }
    let profile = resolve_profile(conn, profile_id);
    if !profile_exists(conn, &profile)? {
        return Err(err(format!("Bot profile '{profile}' does not exist.")));
    }

    // 1. Is it a marketplace / catalog slug? (e.g. filesystem-mcp, brand, slides, etc.)
    if !source.contains("://") && !source.contains('/') && !source.contains('\n') {
        let slug = skill_doc::sanitize_slug(source);
        if let Ok(msg) = install_catalog(conn, home, &profile, &slug, &slug, &format!("Skill {slug} installed from catalog.")) {
            return Ok(format!("Installed catalog skill '/{slug}' for bot profile '{profile}'. {msg}"));
        }
    }

    // 2. Is it a URL?
    let content = if source.starts_with("http://") || source.starts_with("https://") {
        let mut fetch_url = source.to_string();
        // Transform GitHub web link to raw file if applicable
        if fetch_url.contains("github.com") && !fetch_url.contains("raw.githubusercontent.com") {
            if fetch_url.contains("/blob/") {
                fetch_url = fetch_url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");
            } else if !fetch_url.ends_with(".md") {
                // If it's a repo link like https://github.com/owner/repo, try main/SKILL.md or master/SKILL.md
                let trimmed = fetch_url.trim_end_matches('/').trim_end_matches(".git");
                let client = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .map_err(|e| err(e.to_string()))?;
                let main_try = format!("{trimmed}/raw/main/SKILL.md");
                let master_try = format!("{trimmed}/raw/master/SKILL.md");
                if let Ok(res) = client.get(&main_try).send() {
                    if res.status().is_success() {
                        fetch_url = main_try;
                    } else if let Ok(res_master) = client.get(&master_try).send() {
                        if res_master.status().is_success() {
                            fetch_url = master_try;
                        }
                    }
                }
            }
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| err(e.to_string()))?;
        let res = client.get(&fetch_url).send().map_err(|e| err(format!("Failed to download from {fetch_url}: {e}")))?;
        if !res.status().is_success() {
            return Err(err(format!("HTTP error {} downloading skill from {}", res.status(), fetch_url)));
        }
        res.text().map_err(|e| err(format!("Failed to read response text: {e}")))?
    } else {
        // Direct markdown text
        source.to_string()
    };

    let slug = if let Some(custom) = slug_opt.map(str::trim).filter(|s| !s.is_empty()) {
        skill_doc::sanitize_slug(custom)
    } else {
        let front = skill_doc::parse_skill(&content, "imported-skill");
        if !front.name.is_empty() {
            skill_doc::sanitize_slug(&front.name)
        } else {
            "imported-skill".into()
        }
    };

    if slug.is_empty() {
        return Err(err("Could not determine a valid slug for the skill."));
    }

    let parsed = skill_doc::parse_skill(&content, &slug);
    let path = home.join("profiles").join(&profile).join("skills").join(&slug).join("SKILL.md");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, &content)?;
    let id = format!("sk-{profile}-{slug}");
    upsert_skill(conn, &id, &slug, "profile", &profile, "", &parsed, &display_path(home, &path))?;
    ensure_enable(conn, &id, &profile, true)?;
    note_delta(conn, &profile, &format!("Skill index changed: /{slug} is on."))?;

    Ok(format!("Successfully downloaded and installed skill '/{slug}' for bot '{profile}'. It is enabled and in your skill index immediately."))
}

pub fn install_plugin_from_source(
    conn: &Connection,
    home: &Path,
    profile_id: &str,
    source: &str,
    slug_opt: Option<&str>,
) -> Result<String> {
    let source = source.trim();
    if source.is_empty() {
        return Err(err("install_plugin needs a source URL, GitHub link, or folder"));
    }
    let profile = resolve_profile(conn, profile_id);

    let slug = if let Some(custom) = slug_opt.map(str::trim).filter(|s| !s.is_empty()) {
        skill_doc::sanitize_slug(custom)
    } else if let Some(last_seg) = source.trim_end_matches('/').split('/').last() {
        skill_doc::sanitize_slug(last_seg.trim_end_matches(".git"))
    } else {
        "plugin".into()
    };
    if slug.is_empty() {
        return Err(err("Invalid plugin slug"));
    }

    let plugin_dir = home.join("plugins").join(&slug);

    if source.starts_with("http://") || source.starts_with("https://") || source.starts_with("git@") {
        if plugin_dir.exists() {
            let _ = fs::remove_dir_all(&plugin_dir);
        }
        fs::create_dir_all(home.join("plugins"))?;
        let (code, output) = run_capture("git", &["clone", "--depth", "1", source, &plugin_dir.display().to_string()], None, Duration::from_secs(120))?;
        if code != 0 {
            return Err(err(format!("git clone failed: {}", output.lines().last().unwrap_or("no output"))));
        }
    } else {
        let src_path = Path::new(source);
        if !src_path.exists() {
            return Err(err(format!("Source path '{source}' does not exist")));
        }
        if src_path != plugin_dir {
            copy_dir_all(src_path, &plugin_dir)?;
        }
    }

    let yaml_file = plugin_dir.join("plugin.yaml");
    if !yaml_file.exists() {
        let stub_yaml = format!("name: {slug}\nslug: {slug}\nversion: 1.0.0\nhas_agent: true\nhas_desktop: true\n");
        let _ = fs::write(&yaml_file, stub_yaml);
    }
    let imported = import_plugin(conn, home, &plugin_dir, "folder")?;
    let Some(plugin_id) = imported else {
        return Err(err(format!("Could not load plugin from {slug}")));
    };

    // Trust it and enable for this profile
    conn.execute("UPDATE plugins SET trust = 'trusted', desktop_enabled = 1 WHERE id = ?1", params![plugin_id])?;
    if !profile.is_empty() && profile_exists(conn, &profile)? {
        conn.execute(
            "INSERT INTO plugin_agent_enables (plugin_id, profile_id, enabled) VALUES (?1, ?2, 1) ON CONFLICT(plugin_id, profile_id) DO UPDATE SET enabled = 1",
            params![plugin_id, profile],
        )?;
        note_delta(conn, &profile, &format!("Plugin {slug} is now on."))?;
    }

    Ok(format!("Plugin '{slug}' was successfully downloaded, trusted, and enabled for bot profile '{profile}'."))
}

pub fn connect_mcp_server(
    conn: &Connection,
    home: &Path,
    profile_id: &str,
    name: &str,
    transport: Option<&str>,
    command: Option<&str>,
    args: &[String],
    url: Option<&str>,
    secret: Option<&str>,
) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(err("connect_mcp needs an MCP server name"));
    }
    let slug = skill_doc::sanitize_slug(name);
    let profile = resolve_profile(conn, profile_id);

    let mut trans = transport.unwrap_or("stdio").trim().to_lowercase();
    let mut cmd = command.unwrap_or("").trim().to_string();
    let mut server_args = args.to_vec();
    let mut endpoint_url = url.unwrap_or("").trim().to_string();

    // If command and url are empty, check if it matches a catalog MCP (e.g. filesystem-mcp, github-mcp)
    if cmd.is_empty() && endpoint_url.is_empty() {
        if let Some(cat) = catalog_mcp(&slug) {
            trans = cat.transport.to_string();
            cmd = cat.command.to_string();
            server_args = cat.args.iter().map(|s| s.to_string()).collect();
            endpoint_url = cat.url.to_string();
        }
    }

    if trans != "sse" && cmd.is_empty() {
        return Err(err(format!("MCP server '{name}' needs a command (e.g. 'npx -y @modelcontextprotocol/server-filesystem') or an SSE URL")));
    }
    let remote = endpoint_url.starts_with("http://") || endpoint_url.starts_with("https://") || trans == "sse";
    if remote && secret.unwrap_or("").trim().is_empty() {
        return Err(err(format!("MCP server '{name}' needs a credential before it can be saved. An empty form is not a connection.")));
    }

    let id = server_id_for_name(name);
    save_mcp(conn, home, McpDraft {
        id: id.clone(),
        name: name.to_string(),
        transport: trans.clone(),
        command: cmd,
        args: server_args,
        url: endpoint_url,
        tools: Vec::new(),
        secret: secret.unwrap_or("").to_string(),
    })?;

    conn.execute("UPDATE mcp_servers SET trust = 'trusted' WHERE id = ?1", params![id])?;
    enable_mcp_defaults(conn, &id)?;
    if !profile.is_empty() && profile_exists(conn, &profile)? {
        note_delta(conn, &profile, &format!("MCP server {name} is trusted. Profile switches default to Active."))?;
    }

    let credential = if secret.unwrap_or("").trim().is_empty() { "No credential was stored." } else { "The credential is in the vault." };
    Ok(format!("MCP server '{name}' is trusted. Profile switches default to Active. {credential}"))
}

struct SkillRow {
    id: String,
    slug: String,
    origin: String,
    owner: String,
    plugin_id: String,
    body_path: String,
}

struct PluginRow {
    id: String,
    source: String,
    source_path: String,
    trust: String,
    has_agent: i64,
    has_desktop: i64,
    desktop_enabled: i64,
}

struct McpRow {
    id: String,
    trust: String,
}

fn migrate_legacy(conn: &Connection, home: &Path) -> Result<()> {
    if db::kv_get(conn, "capabilities_migrated")?.as_deref() == Some("1") {
        return Ok(());
    }
    let profiles = profile_ids(conn)?;
    let mut stmt = conn.prepare("SELECT slug, item_type, manifest_markdown_or_json, is_enabled FROM skills_and_mcps")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))?;
    for row in rows {
        let (raw_slug, kind, manifest, enabled) = row?;
        let slug = skill_doc::sanitize_slug(&raw_slug);
        if slug.is_empty() {
            continue;
        }
        match kind.as_str() {
            "mcp_stdio" | "mcp_sse" => {
                let transport = if kind == "mcp_sse" { "sse" } else { "stdio" };
                let id = format!("mcp-{slug}");
                let url = if transport == "sse" { manifest.clone() } else { String::new() };
                let command = if transport == "stdio" { manifest.clone() } else { String::new() };
                save_mcp(conn, home, McpDraft { id: id.clone(), name: slug.clone(), transport: transport.into(), command, args: Vec::new(), url, tools: Vec::new(), secret: String::new() })?;
                conn.execute("UPDATE mcp_servers SET trust = 'trusted' WHERE id = ?1", params![id])?;
                for profile in &profiles {
                    let _ = conn.execute(
                        "INSERT INTO mcp_enables (server_id, profile_id, enabled) VALUES (?1, ?2, ?3) ON CONFLICT(server_id, profile_id) DO UPDATE SET enabled = excluded.enabled",
                        params![id, profile, enabled],
                    );
                }
            }
            "ui_extension" => {
                save_plugin(
                    conn,
                    home,
                    PluginDraft {
                        id: String::new(),
                        slug: slug.clone(),
                        name: slug.clone(),
                        version: "1.0.0".into(),
                        has_agent: false,
                        has_desktop: true,
                        tools: Vec::new(),
                        hooks: Vec::new(),
                        skills: Vec::new(),
                        desktop: vec![DesktopBit { kind: "pane".into(), label: slug.clone(), target: String::new() }],
                    },
                )?;
                conn.execute("UPDATE plugins SET desktop_enabled = 0 WHERE id = ?1", params![format!("plug-{slug}")])?;
            }
            _ => {
                let text = skill_doc::render_skill(&slug, &slug, &format!("/{slug}"), &[], &["windows".into(), "macos".into(), "linux".into()], &manifest);
                let targets: Vec<(String, String)> = if profiles.is_empty() {
                    vec![("catalog".into(), String::new())]
                } else {
                    profiles.iter().map(|profile| ("profile".into(), profile.clone())).collect()
                };
                for (origin, owner) in targets {
                    let path = if origin == "catalog" {
                        home.join("catalog").join("skills").join(&slug).join("SKILL.md")
                    } else {
                        home.join("profiles").join(&owner).join("skills").join(&slug).join("SKILL.md")
                    };
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    if !path.exists() {
                        fs::write(&path, &text)?;
                    }
                    let parsed = skill_doc::parse_skill(&text, &slug);
                    let id = if origin == "catalog" { format!("sk-catalog-{slug}") } else { format!("sk-{owner}-{slug}") };
                    upsert_skill(conn, &id, &slug, &origin, &owner, "", &parsed, &display_path(home, &path))?;
                    if origin == "profile" {
                        ensure_enable(conn, &id, &owner, enabled != 0)?;
                    }
                }
            }
        }
    }
    db::kv_set(conn, "capabilities_migrated", "1")?;
    Ok(())
}

fn sync_plugins(conn: &Connection, home: &Path, project_root: &str) -> Result<()> {
    let mut found = HashSet::new();
    for dir in child_dirs(&home.join("plugins")) {
        if let Some(id) = import_plugin(conn, home, &dir, "folder")? {
            found.insert(id);
        }
    }
    let project = PathBuf::from(project_root).join(".ronicos").join("plugins");
    if project.is_dir() {
        for dir in child_dirs(&project) {
            if let Some(id) = import_plugin(conn, home, &dir, "project")? {
                found.insert(id);
            }
        }
    }
    let mut stmt = conn.prepare("SELECT id, source_path FROM plugins")?;
    let stale: Vec<(String, String)> = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, path) in stale {
        if !found.contains(&id) && !Path::new(&path).join("plugin.yaml").exists() {
            conn.execute("DELETE FROM plugin_agent_enables WHERE plugin_id = ?1", params![id])?;
            conn.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
        }
    }
    Ok(())
}

fn import_plugin(conn: &Connection, home: &Path, dir: &Path, source: &str) -> Result<Option<String>> {
    let file = dir.join("plugin.yaml");
    if !file.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file).unwrap_or_default();
    let fallback = dir.file_name().and_then(|name| name.to_str()).unwrap_or("plugin");
    let parsed = skill_doc::parse_plugin(&raw, fallback);
    if parsed.slug.is_empty() {
        return Ok(None);
    }
    let id = if source == "project" { format!("plug-project-{}", parsed.slug) } else { format!("plug-{}", parsed.slug) };
    let previous = plugin_row(conn, &id)?;
    let trust = previous.as_ref().map(|row| row.trust.clone()).unwrap_or_else(|| "untrusted".into());
    let desktop_enabled = previous.as_ref().map(|row| row.desktop_enabled).unwrap_or(0);
    for skill in &parsed.skills {
        let skill_file = dir.join("skills").join(skill).join("SKILL.md");
        if !skill_file.exists() {
            if let Some(parent) = skill_file.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&skill_file, stub_skill(&parsed.slug, skill))?;
        }
    }
    upsert_plugin(conn, &id, &parsed, source, dir, &trust, desktop_enabled)?;
    let _ = home;
    Ok(Some(id))
}

fn sync_mcp(conn: &Connection, home: &Path) -> Result<()> {
    let mut found = HashSet::new();
    let dir = home.join("mcp");
    if dir.is_dir() {
        for entry in fs::read_dir(&dir)?.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&path).unwrap_or_default();
            let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            let fallback = path.file_stem().and_then(|name| name.to_str()).unwrap_or("mcp");
            let id = value.get("id").and_then(|item| item.as_str()).unwrap_or(fallback).to_string();
            let name = value.get("name").and_then(|item| item.as_str()).unwrap_or(&id).to_string();
            let transport = if value.get("transport").and_then(|item| item.as_str()) == Some("sse") { "sse" } else { "stdio" };
            let command = value.get("command").and_then(|item| item.as_str()).unwrap_or("").to_string();
            let url = value.get("url").and_then(|item| item.as_str()).unwrap_or("").to_string();
            let args: Vec<String> = value.get("args").and_then(|item| item.as_array()).map(|rows| rows.iter().filter_map(|item| item.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            let tools: Vec<DeclaredTool> = value.get("tools").and_then(|item| serde_json::from_value(item.clone()).ok()).unwrap_or_default();
            let trust = mcp_row(conn, &id)?.map(|row| row.trust).unwrap_or_else(|| "untrusted".into());
            conn.execute(
                "INSERT INTO mcp_servers (id, name, transport, command, args_json, url, trust, tools_json, last_error, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name, transport=excluded.transport, command=excluded.command, args_json=excluded.args_json, url=excluded.url, tools_json=excluded.tools_json, updated_at=excluded.updated_at",
                params![id, name, transport, command, serde_json::to_string(&args)?, url, trust, serde_json::to_string(&tools)?, now_ms()],
            )?;
            found.insert(id);
        }
    }
    let mut stmt = conn.prepare("SELECT id FROM mcp_servers")?;
    let ids: Vec<String> = stmt.query_map([], |row| row.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    for id in ids {
        if !found.contains(&id) {
            conn.execute("DELETE FROM mcp_enables WHERE server_id = ?1", params![id])?;
            conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
        } else {
            enable_mcp_defaults(conn, &id)?;
        }
    }
    Ok(())
}

fn sync_skills(conn: &Connection, home: &Path) -> Result<()> {
    let mut found = HashSet::new();
    for profile_dir in child_dirs(&home.join("profiles")) {
        let owner = profile_dir.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
        for skill_dir in child_dirs(&profile_dir.join("skills")) {
            let slug = skill_dir.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
            let file = skill_dir.join("SKILL.md");
            if file.exists() {
                let id = format!("sk-{owner}-{slug}");
                import_skill_file(conn, home, &file, &id, &slug, "profile", &owner, "")?;
                ensure_enable(conn, &id, &owner, true)?;
                found.insert(id);
            }
        }
    }
    for skill_dir in child_dirs(&home.join("catalog").join("skills")) {
        let slug = skill_dir.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
        let file = skill_dir.join("SKILL.md");
        if file.exists() {
            let id = format!("sk-catalog-{slug}");
            import_skill_file(conn, home, &file, &id, &slug, "catalog", "", "")?;
            found.insert(id);
        }
    }
    let plugins = read_plugins(conn)?;
    for plugin in plugins {
        let root = PathBuf::from(&plugin.source_path).join("skills");
        for skill_dir in child_dirs(&root) {
            let leaf = skill_dir.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
            let file = skill_dir.join("SKILL.md");
            if !file.exists() {
                continue;
            }
            let slug = format!("{}:{leaf}", plugin.slug);
            let id = format!("sk-{}-{leaf}", plugin.id);
            import_skill_file(conn, home, &file, &id, &slug, "plugin", "", &plugin.id)?;
            for profile in profile_ids(conn)? {
                ensure_enable(conn, &id, &profile, true)?;
            }
            found.insert(id);
        }
    }
    let mut stmt = conn.prepare("SELECT id FROM skills")?;
    let ids: Vec<String> = stmt.query_map([], |row| row.get(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    for id in ids {
        if !found.contains(&id) {
            conn.execute("DELETE FROM skill_enables WHERE skill_id = ?1", params![id])?;
            conn.execute("DELETE FROM skills WHERE id = ?1", params![id])?;
        }
    }
    Ok(())
}

fn import_skill_file(conn: &Connection, home: &Path, file: &Path, id: &str, slug: &str, origin: &str, owner: &str, plugin_id: &str) -> Result<()> {
    let raw = fs::read_to_string(file).unwrap_or_default();
    let leaf = slug.rsplit(':').next().unwrap_or(slug);
    let parsed = skill_doc::parse_skill(&raw, leaf);
    upsert_skill(conn, id, slug, origin, owner, plugin_id, &parsed, &display_path(home, file))
}

fn read_plugins(conn: &Connection) -> Result<Vec<PluginPackage>> {
    let enables = load_flags(conn, "plugin_agent_enables", "plugin_id")?;
    let mut stmt = conn.prepare("SELECT id, slug, name, version, source, source_path, trust, has_agent, has_desktop, manifest_json, desktop_enabled FROM plugins ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        let manifest: String = row.get(9)?;
        let parsed: serde_json::Value = serde_json::from_str(&manifest).unwrap_or(json!({}));
        Ok(PluginPackage {
            id: row.get(0)?,
            slug: row.get(1)?,
            name: row.get(2)?,
            version: row.get(3)?,
            source: row.get(4)?,
            source_path: row.get(5)?,
            trust: row.get(6)?,
            has_agent: flag(row.get(7)?),
            has_desktop: flag(row.get(8)?),
            tools: serde_json::from_value(parsed.get("tools").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            hooks: serde_json::from_value(parsed.get("hooks").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            bundled_skills: serde_json::from_value(parsed.get("skills").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            desktop: serde_json::from_value(parsed.get("desktop").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            agent_enables: Vec::new(),
            desktop_enabled: flag(row.get(10)?),
        })
    })?;
    let mut plugins = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    for plugin in &mut plugins {
        plugin.agent_enables = enables.get(&plugin.id).cloned().unwrap_or_default();
    }
    Ok(plugins)
}

fn read_mcp(conn: &Connection) -> Result<Vec<McpServer>> {
    let enables = load_flags(conn, "mcp_enables", "server_id")?;
    let mut stmt = conn.prepare("SELECT id, name, transport, command, args_json, url, trust, tools_json, last_error FROM mcp_servers ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        let args: String = row.get(4)?;
        let tools: String = row.get(7)?;
        Ok(McpServer {
            id: row.get(0)?,
            name: row.get(1)?,
            transport: row.get(2)?,
            command: row.get(3)?,
            args: serde_json::from_str(&args).unwrap_or_default(),
            url: row.get(5)?,
            trust: row.get(6)?,
            declared_tools: serde_json::from_str(&tools).unwrap_or_default(),
            enables: Vec::new(),
            last_error: row.get(8)?,
        })
    })?;
    let mut servers = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    for server in &mut servers {
        server.enables = enables.get(&server.id).cloned().unwrap_or_default();
    }
    Ok(servers)
}

fn read_skills(conn: &Connection, home: &Path, known: &HashSet<String>) -> Result<Vec<Skill>> {
    let enables = load_flags(conn, "skill_enables", "skill_id")?;
    let mut stmt = conn.prepare("SELECT id, slug, origin, owner_profile_id, plugin_id, title, description, slash_command, requires_tools_json, platforms_json, body_path, version, updated_at FROM skills ORDER BY slug")?;
    let rows = stmt.query_map([], |row| {
        let tools: String = row.get(8)?;
        let platforms: String = row.get(9)?;
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            serde_json::from_str::<Vec<String>>(&tools).unwrap_or_default(),
            serde_json::from_str::<Vec<String>>(&platforms).unwrap_or_default(),
            row.get::<_, String>(10)?,
            row.get::<_, String>(11)?,
            row.get::<_, i64>(12)?,
        ))
    })?;
    let mut skills = Vec::new();
    for row in rows {
        let (id, slug, origin, owner, plugin_id, title, description, slash, tools, platforms, body_path, version, updated_at) = row?;
        let path = locate(home, &body_path);
        let body = read_capped(&path).unwrap_or_default();
        let files = support_files(path.parent().unwrap_or(Path::new(".")));
        skills.push(Skill {
            id: id.clone(),
            slug,
            origin,
            owner_profile_id: owner,
            plugin_id,
            title,
            description: description.clone(),
            slash_command: slash.clone(),
            requires_tools: tools.clone(),
            platforms: platforms.clone(),
            body,
            files,
            enables: enables.get(&id).cloned().unwrap_or_default(),
            hidden_reason: skill_doc::hidden_reason(&platforms, &tools, known),
            index_line: skill_doc::index_line(&slash, &description, &tools),
            version,
            updated_at,
        });
    }
    Ok(skills)
}

fn read_proposals(conn: &Connection, skills: &[Skill]) -> Result<Vec<SkillProposal>> {
    let mut stmt = conn.prepare("SELECT id, profile_id, thread_id, slug, description, proposed_body, status, created_at FROM skill_proposals WHERE status = 'pending' ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok(SkillProposal {
            id: row.get(0)?,
            profile_id: row.get(1)?,
            thread_id: row.get(2)?,
            slug: row.get(3)?,
            description: row.get(4)?,
            proposed_body: row.get(5)?,
            current_body: String::new(),
            status: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    let mut proposals = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    for proposal in &mut proposals {
        proposal.current_body = skills
            .iter()
            .find(|skill| skill.origin == "profile" && skill.owner_profile_id == proposal.profile_id && (skill.slug == proposal.slug || skill.slash_command.trim_start_matches('/') == proposal.slug))
            .map(|skill| skill.body.clone())
            .unwrap_or_default();
    }
    Ok(proposals)
}

fn upsert_skill(conn: &Connection, id: &str, slug: &str, origin: &str, owner: &str, plugin_id: &str, parsed: &skill_doc::ParsedSkill, body_path: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO skills (id, slug, origin, owner_profile_id, plugin_id, title, description, slash_command, requires_tools_json, platforms_json, body_path, version, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'1.0.0',?12)
         ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, title=excluded.title, description=excluded.description, slash_command=excluded.slash_command, requires_tools_json=excluded.requires_tools_json, platforms_json=excluded.platforms_json, body_path=excluded.body_path, updated_at=excluded.updated_at",
        params![id, slug, origin, owner, plugin_id, parsed.name, parsed.description, parsed.slash_command, serde_json::to_string(&parsed.requires_tools)?, serde_json::to_string(&parsed.platforms)?, body_path, now_ms()],
    )?;
    Ok(())
}

fn upsert_plugin(conn: &Connection, id: &str, parsed: &skill_doc::ParsedPlugin, source: &str, dir: &Path, trust: &str, desktop_enabled: i64) -> Result<()> {
    let manifest = json!({
        "tools": parsed.tools,
        "hooks": parsed.hooks,
        "skills": parsed.skills,
        "desktop": parsed.desktop,
    });
    conn.execute(
        "INSERT INTO plugins (id, slug, name, version, source, source_path, trust, has_agent, has_desktop, manifest_json, desktop_enabled, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, name=excluded.name, version=excluded.version, source=excluded.source, source_path=excluded.source_path, has_agent=excluded.has_agent, has_desktop=excluded.has_desktop, manifest_json=excluded.manifest_json, updated_at=excluded.updated_at",
        params![id, parsed.slug, parsed.name, parsed.version, source, dir.display().to_string(), trust, parsed.has_agent as i64, parsed.has_desktop as i64, manifest.to_string(), desktop_enabled, now_ms()],
    )?;
    Ok(())
}

fn ensure_enable(conn: &Connection, skill_id: &str, profile_id: &str, enabled: bool) -> Result<()> {
    if profile_id.is_empty() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO skill_enables (skill_id, profile_id, enabled) VALUES (?1, ?2, ?3) ON CONFLICT(skill_id, profile_id) DO NOTHING",
        params![skill_id, profile_id, enabled as i64],
    )?;
    Ok(())
}

fn skill_text(draft: &SkillDraft) -> String {
    if draft.body.trim_start().starts_with("---") {
        draft.body.clone()
    } else {
        let slug = skill_doc::sanitize_slug(&draft.slug);
        let slash = if draft.slash_command.trim().is_empty() { format!("/{slug}") } else { draft.slash_command.trim().to_string() };
        skill_doc::render_skill(&draft.title, &draft.description, &slash, &draft.requires_tools, &draft.platforms, &draft.body)
    }
}

fn display_slug(origin: &str, parsed_name: &str, requested: &str) -> String {
    if origin == "plugin" {
        requested.to_string()
    } else {
        let slug = skill_doc::sanitize_slug(if requested.trim().is_empty() { parsed_name } else { requested });
        if slug.is_empty() { skill_doc::sanitize_slug(parsed_name) } else { slug }
    }
}

fn write_support(dir: &Path, files: &[FileDraft]) -> Result<()> {
    for file in files {
        let rel = file.path.replace('\\', "/");
        if !safe_support_rel(&rel) {
            return Err(err("support files stay inside the skill folder"));
        }
        let path = rel.split('/').fold(dir.to_path_buf(), |acc, part| acc.join(part));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &file.content)?;
    }
    Ok(())
}

fn support_files(dir: &Path) -> Vec<SkillFile> {
    let mut files = Vec::new();
    collect_support(dir, dir, &mut files);
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files
}

fn collect_support(root: &Path, dir: &Path, out: &mut Vec<SkillFile>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|item| item.to_str()).unwrap_or("");
        if name.starts_with('.') || name == "assets" || name == "node_modules" || name == "test-corpus" {
            continue;
        }
        if path.is_dir() {
            collect_support(root, &path, out);
            continue;
        }
        if name.eq_ignore_ascii_case("SKILL.md") || !is_text_support(&path) {
            continue;
        }
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let rel = rel.components().map(|part| part.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/");
        let kind = if rel.starts_with("scripts/") { "script" } else { "reference" };
        out.push(SkillFile { path: rel, kind: kind.into(), content: read_capped(&path).unwrap_or_default() });
    }
}

fn is_text_support(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()).as_deref(),
        Some("md" | "txt" | "py" | "sh" | "js" | "mjs" | "cjs" | "json" | "yml" | "yaml" | "html" | "css" | "ts" | "tsx")
    )
}

fn safe_support_rel(rel: &str) -> bool {
    if rel.is_empty() || rel.starts_with('/') || rel.eq_ignore_ascii_case("SKILL.md") {
        return false;
    }
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|part| !part.is_empty()).collect();
    !parts.is_empty() && parts.iter().all(|part| *part != "." && *part != ".." && !part.contains(':'))
}

fn pin_prebuilt(conn: &Connection) -> Result<()> {
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM plugins WHERE id = ?1", params![prebuilt::PLUGIN_ID], |row| row.get(0))?;
    if exists == 0 {
        return Ok(());
    }
    conn.execute("UPDATE plugins SET source = 'builtin', trust = 'trusted' WHERE id = ?1", params![prebuilt::PLUGIN_ID])?;
    for profile in profile_ids(conn)? {
        conn.execute(
            "INSERT INTO plugin_agent_enables (plugin_id, profile_id, enabled) VALUES (?1, ?2, 1) ON CONFLICT(plugin_id, profile_id) DO NOTHING",
            params![prebuilt::PLUGIN_ID, profile],
        )?;
    }
    Ok(())
}

fn stub_skill(plugin_slug: &str, name: &str) -> String {
    skill_doc::render_skill(
        &format!("{plugin_slug}:{name}"),
        &format!("Bundled by {plugin_slug}"),
        &format!("/{name}"),
        &[],
        &["windows".into(), "macos".into(), "linux".into()],
        &format!("# {name}\n\nBundled playbook for {plugin_slug}."),
    )
}

fn skill_row(conn: &Connection, id: &str) -> Result<Option<SkillRow>> {
    let row = conn.query_row(
        "SELECT id, slug, origin, owner_profile_id, plugin_id, body_path FROM skills WHERE id = ?1",
        params![id],
        |row| Ok(SkillRow { id: row.get(0)?, slug: row.get(1)?, origin: row.get(2)?, owner: row.get(3)?, plugin_id: row.get(4)?, body_path: row.get(5)? }),
    );
    match row {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn plugin_row(conn: &Connection, id: &str) -> Result<Option<PluginRow>> {
    let row = conn.query_row(
        "SELECT id, source, source_path, trust, has_agent, has_desktop, desktop_enabled FROM plugins WHERE id = ?1",
        params![id],
        |row| Ok(PluginRow { id: row.get(0)?, source: row.get(1)?, source_path: row.get(2)?, trust: row.get(3)?, has_agent: row.get(4)?, has_desktop: row.get(5)?, desktop_enabled: row.get(6)? }),
    );
    match row {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn mcp_row(conn: &Connection, id: &str) -> Result<Option<McpRow>> {
    let row = conn.query_row("SELECT id, trust FROM mcp_servers WHERE id = ?1", params![id], |row| Ok(McpRow { id: row.get(0)?, trust: row.get(1)? }));
    match row {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn load_flags(conn: &Connection, table: &str, id_col: &str) -> Result<HashMap<String, Vec<ProfileFlag>>> {
    let sql = format!("SELECT {id_col}, profile_id, enabled FROM {table}");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))?;
    let mut map: HashMap<String, Vec<ProfileFlag>> = HashMap::new();
    for row in rows {
        let (id, profile_id, enabled) = row?;
        map.entry(id).or_default().push(ProfileFlag { profile_id, enabled: enabled != 0 });
    }
    Ok(map)
}

fn profile_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM bot_profiles ORDER BY created_at")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn profile_exists(conn: &Connection, id: &str) -> Result<bool> {
    if id.is_empty() {
        return Ok(false);
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id = ?1", params![id], |row| row.get(0))?;
    Ok(count == 1)
}

fn note_delta(conn: &Connection, profile_id: &str, line: &str) -> Result<()> {
    if profile_id.is_empty() {
        return Ok(());
    }
    let key = format!("skill_delta:{profile_id}");
    let prev = db::kv_get(conn, &key)?.unwrap_or_default();
    let next = if prev.trim().is_empty() { line.to_string() } else { format!("{prev}\n{line}") };
    db::kv_set(conn, &key, &next)
}

fn child_dirs(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect()
}

fn locate(home: &Path, stored: &str) -> PathBuf {
    let path = PathBuf::from(stored);
    if path.is_absolute() { path } else { stored.split(['/', '\\']).filter(|part| !part.is_empty() && *part != "..").fold(home.to_path_buf(), |acc, part| acc.join(part)) }
}

fn display_path(home: &Path, path: &Path) -> String {
    path.strip_prefix(home)
        .map(|rel| rel.components().map(|part| part.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/"))
        .unwrap_or_else(|_| path.display().to_string())
}

fn read_capped(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let count = text.chars().count();
    if count > 64_000 {
        Some(format!("{}…", text.chars().take(64_000).collect::<String>()))
    } else {
        Some(text)
    }
}

fn flag(value: i64) -> bool {
    value != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (PathBuf, Connection, String) {
        let home = std::env::temp_dir().join(format!("ronic-caps-{}-{}-{}", std::process::id(), now_ms(), nid("t")));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let conn = crate::db::open(&home.join("state.db")).unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at) VALUES ('bot_a','@a','A','NW','Soul A','prov_ollama','prov_gemini','prov_openrouter',1,1,1,'',5,1,'Local',1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at) VALUES ('bot_b','@b','B','NW','Soul B','prov_ollama','prov_gemini','prov_openrouter',1,0,0,'',5,1,'Local',2)",
            [],
        ).unwrap();
        (home, conn, "bot_a".into())
    }

    fn draft(profile: &str, slug: &str, description: &str, platforms: &[&str], body: &str) -> SkillDraft {
        SkillDraft {
            id: String::new(),
            profile_id: profile.into(),
            slug: slug.into(),
            title: slug.into(),
            description: description.into(),
            slash_command: format!("/{slug}"),
            requires_tools: Vec::new(),
            platforms: platforms.iter().map(|item| (*item).to_string()).collect(),
            body: body.into(),
            files: Vec::new(),
        }
    }

    #[test]
    fn partial_drafts_keep_omitted_fields_empty() {
        let skill: SkillDraft = serde_json::from_str(r#"{"profileId":"bot_a","slug":"ship","body":"STAGE2"}"#).unwrap();
        assert_eq!(skill.profile_id, "bot_a");
        assert!(skill.id.is_empty());
        assert!(skill.files.is_empty());
        assert!(skill.requires_tools.is_empty());
        let plugin: PluginDraft = serde_json::from_str(r#"{"slug":"desk","name":"Desk","hasDesktop":true}"#).unwrap();
        assert!(plugin.id.is_empty());
        assert_eq!(plugin.version, "");
        assert!(plugin.has_desktop);
        assert!(!plugin.has_agent);
        let server: McpDraft = serde_json::from_str(r#"{"name":"files","transport":"stdio","command":"npx"}"#).unwrap();
        assert!(server.id.is_empty());
        assert!(server.args.is_empty());
        assert!(server.tools.is_empty());
    }

    #[test]
    fn skills_stay_out_of_the_standing_prompt_until_a_slash_or_approval() {
        let (home, conn, profile) = setup();
        save_skill(&conn, &home, draft(&profile, "ship-pr", "Ship the pull request", &["windows", "macos", "linux"], "STAGE2-BODY-MARKER\nDo the review.")).unwrap();
        save_skill(&conn, &home, draft(&profile, "mac-only", "MAC-ONLY-SKILL", &["macos"], "This body is mac only.")).unwrap();
        let standing = system_for(&conn, &home, &profile, "Soul A", "hello", "none").unwrap();
        assert!(standing.contains("Ship the pull request"), "{standing}");
        assert!(!standing.contains("STAGE2-BODY-MARKER"), "{standing}");
        assert!(!standing.contains("MAC-ONLY-SKILL"), "{standing}");
        let other = system_for(&conn, &home, "bot_b", "Soul B", "hello", "none").unwrap();
        assert!(!other.contains("Ship the pull request"), "{other}");
        let slashed = system_for(&conn, &home, &profile, "Soul A", "/ship-pr now", "none").unwrap();
        assert!(slashed.contains("STAGE2-BODY-MARKER"), "{slashed}");
        let before = home.join("profiles").join(&profile).join("skills").join("from-agent").join("SKILL.md");
        let note = propose_skill(&conn, &profile, "thread", "from-agent", "A learned checklist", "---\nname: from-agent\ndescription: Learned\nslash_command: /from-agent\nrequires_tools: []\nplatforms: [windows]\n---\n\nSTEP-FROM-AGENT\n").unwrap();
        assert!(note.contains("not written"));
        assert!(!before.exists());
        let id: String = conn.query_row("SELECT id FROM skill_proposals WHERE slug = 'from-agent'", [], |row| row.get(0)).unwrap();
        resolve_proposal(&conn, &home, &id, true).unwrap();
        assert!(before.exists());
        let old: i64 = conn.query_row("SELECT COUNT(*) FROM skills_and_mcps", [], |row| row.get(0)).unwrap();
        assert_eq!(old, 0);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn untrusted_project_plugins_cannot_be_enabled() {
        let (home, conn, profile) = setup();
        let dir = home.join("repo").join(".ronicos").join("plugins").join("local-tool");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.yaml"), "id: local-tool\nname: Local Tool\nversion: 1.0.0\nhas_agent_part: true\nhas_desktop_part: true\ntools:\n  - name: local_ping\n    description: Ping\nhooks: [session_start]\nskills: []\ndesktop:\n  - kind: status\n    label: LOCAL\n    target: \"\"\n").unwrap();
        reconcile(&conn, &home, &home.join("repo").display().to_string()).unwrap();
        let id = "plug-project-local-tool";
        let denied = toggle_plugin_agent(&conn, id, &profile, true);
        assert!(denied.is_err(), "{denied:?}");
        trust_plugin(&conn, id).unwrap();
        let still_off: i64 = conn.query_row("SELECT COUNT(*) FROM plugin_agent_enables WHERE plugin_id = ?1 AND enabled = 1", params![id], |row| row.get(0)).unwrap();
        assert_eq!(still_off, 0);
        toggle_plugin_agent(&conn, id, &profile, true).unwrap();
        toggle_plugin_desktop(&conn, id, true).unwrap();
        let desktop: i64 = conn.query_row("SELECT desktop_enabled FROM plugins WHERE id = ?1", params![id], |row| row.get(0)).unwrap();
        assert_eq!(desktop, 1);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn legacy_rows_migrate_once_and_are_not_rewritten() {
        let (home, conn, profile) = setup();
        conn.execute(
            "INSERT INTO skills_and_mcps (id, slug, item_type, manifest_markdown_or_json, script_path, permissions_json, scope, is_enabled, version) VALUES ('old','legacy-skill','skill_md','# Legacy\nKeep this.','','{}','global',1,'1.0.0')",
            [],
        ).unwrap();
        reconcile(&conn, &home, "").unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM skills WHERE slug = 'legacy-skill' AND owner_profile_id = ?1", params![profile], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        let old: i64 = conn.query_row("SELECT COUNT(*) FROM skills_and_mcps", [], |row| row.get(0)).unwrap();
        assert_eq!(old, 1);
        save_skill(&conn, &home, draft(&profile, "fresh", "Fresh skill", &["windows"], "Body")).unwrap();
        let old_after: i64 = conn.query_row("SELECT COUNT(*) FROM skills_and_mcps", [], |row| row.get(0)).unwrap();
        assert_eq!(old_after, 1);
        let hidden = view(&conn, &home, &profile).unwrap().skills.into_iter().find(|skill| skill.slug == "mac-only");
        assert!(hidden.is_none());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn prebuilt_skills_install_trusted_and_stay_out_of_the_standing_prompt() {
        let (home, conn, profile) = setup();
        reconcile(&conn, &home, "").unwrap();
        let slugs: Vec<String> = conn
            .prepare("SELECT slug FROM skills WHERE plugin_id = ?1 ORDER BY slug")
            .unwrap()
            .query_map(params![prebuilt::PLUGIN_ID], |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        for name in ["find-skills", "grill-me", "agent-browser", "improve-codebase-architecture", "computer-use", "code-review", "vercel-react-best-practices", "remotion-to-hyperframes", "hyperframes-cli", "composio"] {
            assert!(slugs.iter().any(|slug| slug == &format!("prebuilt-skills:{name}")), "{slugs:?}");
        }
        let trust: String = conn.query_row("SELECT trust FROM plugins WHERE id = ?1", params![prebuilt::PLUGIN_ID], |row| row.get(0)).unwrap();
        assert_eq!(trust, "trusted");
        let source: String = conn.query_row("SELECT source FROM plugins WHERE id = ?1", params![prebuilt::PLUGIN_ID], |row| row.get(0)).unwrap();
        assert_eq!(source, "builtin");
        let description: String = conn.query_row("SELECT description FROM skills WHERE slug = 'prebuilt-skills:computer-use'", [], |row| row.get(0)).unwrap();
        assert!(description.starts_with("Drives the GUI"), "{description}");
        let current = view(&conn, &home, &profile).unwrap();
        let react = current.skills.iter().find(|skill| skill.slug == "prebuilt-skills:vercel-react-best-practices").unwrap();
        assert!(react.files.iter().any(|file| file.path == "rules/async-parallel.md"));
        let cli = current.skills.iter().find(|skill| skill.slug == "prebuilt-skills:hyperframes-cli").unwrap();
        assert!(cli.files.iter().any(|file| file.path == "references/preview-render.md"));
        let standing = system_for(&conn, &home, &profile, "Soul A", "hello", "none").unwrap();
        assert!(standing.contains("/find-skills"), "{standing}");
        assert!(!standing.contains("npx skills find"), "{standing}");
        let slashed = system_for(&conn, &home, &profile, "Soul A", "/find-skills please", "none").unwrap();
        assert!(slashed.contains("npx skills find"), "{slashed}");
        toggle_plugin_agent(&conn, prebuilt::PLUGIN_ID, &profile, false).unwrap();
        reconcile(&conn, &home, "").unwrap();
        let enabled: i64 = conn
            .query_row("SELECT enabled FROM plugin_agent_enables WHERE plugin_id = ?1 AND profile_id = ?2", params![prebuilt::PLUGIN_ID, profile], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 0);
        let removed = remove_plugin(&conn, &home, prebuilt::PLUGIN_ID);
        assert!(removed.is_err(), "{removed:?}");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn prebuilt_skills_start_on_and_a_turned_off_skill_stays_off() {
        let (home, conn, profile) = setup();
        reconcile(&conn, &home, "").unwrap();
        let skill_id = "sk-plug-prebuilt-skills-find-skills";
        toggle_skill(&conn, &home, skill_id, &profile, false).unwrap();
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at) VALUES ('bot_c','@c','C','NW','Soul C','prov_ollama','prov_gemini','prov_openrouter',1,1,1,'',5,1,'Local',3)",
            [],
        ).unwrap();
        reconcile(&conn, &home, "").unwrap();
        let kept_off: i64 = conn.query_row("SELECT enabled FROM skill_enables WHERE skill_id = ?1 AND profile_id = ?2", params![skill_id, profile], |row| row.get(0)).unwrap();
        let new_skill: i64 = conn.query_row("SELECT enabled FROM skill_enables WHERE skill_id = ?1 AND profile_id = 'bot_c'", params![skill_id], |row| row.get(0)).unwrap();
        let new_agent: i64 = conn.query_row("SELECT enabled FROM plugin_agent_enables WHERE plugin_id = ?1 AND profile_id = 'bot_c'", params![prebuilt::PLUGIN_ID], |row| row.get(0)).unwrap();
        assert_eq!(kept_off, 0);
        assert_eq!(new_skill, 1);
        assert_eq!(new_agent, 1);
        let standing = system_for(&conn, &home, "bot_c", "Soul C", "hello", "none").unwrap();
        let turned = system_for(&conn, &home, &profile, "Soul A", "hello", "none").unwrap();
        let index_of = |prompt: &str| prompt.split("Skill index:\n").nth(1).unwrap_or("").split("\n\n").next().unwrap_or("").to_string();
        assert!(index_of(&standing).lines().any(|line| line.starts_with("/find-skills")), "{standing}");
        assert!(!index_of(&turned).lines().any(|line| line.starts_with("/find-skills")), "{turned}");
        let _ = fs::remove_dir_all(&home);
    }
}
