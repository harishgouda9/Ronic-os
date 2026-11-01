use crate::capabilities;
use crate::db;
use crate::error::Result;
use crate::models::Skill;
use rusqlite::{params, Connection};

pub fn system_for(conn: &Connection, home: &std::path::Path, profile_id: &str, soul: &str, user_prompt: &str, memory: &str) -> Result<String> {
    let view = capabilities::view(conn, home, profile_id)?;
    let delta = capabilities::take_delta(conn, profile_id)?;
    let playbook = slash_body(user_prompt, &view.skills, profile_id, &view.plugins);
    let (project, computer, browser, code, cap) = profile_context(conn, profile_id)?;
    let index = view_index(&view.skills, profile_id, &view.plugins);
    let mut tiers = vec![
        soul.trim().to_string(),
        format!("Project: {project}\nComputer use: {computer}. Browser use: {browser}. Code execution: {code}. Daily wallet cap: ${cap}."),
        format!("Skill index:\n{}", if index.is_empty() { "none".into() } else { index }),
    ];
    let mut turn = String::new();
    if !delta.trim().is_empty() {
        turn.push_str(delta.trim());
        turn.push('\n');
    }
    if let Some(body) = playbook {
        if !turn.is_empty() {
            turn.push('\n');
        }
        turn.push_str("Skill playbook for this turn:\n");
        turn.push_str(&body);
    }
    if !turn.is_empty() {
        tiers.push(turn);
    }
    tiers.push(format!("Relevant memory:\n{memory}"));
    // Co-worker pre-flight: recovery lessons + workspace git state, gathered
    // silently. Nothing here asks the user a question or blocks the turn.
    let project_root = crate::db::settings_of(conn).map(|s| s.project_root).unwrap_or_default();
    let pre = crate::coworker::pre_flight(home, profile_id, &project_root);
    if !pre.is_empty() {
        tiers.push(pre);
    }
    let approval_mode: String = conn
        .query_row(
            "SELECT COALESCE(approval_mode, 'auto') FROM bot_profiles WHERE id = ?1",
            params![profile_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| "auto".into());

    let mode_instruction = match approval_mode.as_str() {
        "auto" => "APPROVAL MODE (Auto Approve): For engineering, coding, research, or system execution tasks, act autonomously and decisively. Build and execute without asking clarifying questions unless you face critical irreversible operations (e.g. data loss) or require missing private credentials.",
        "ask" => "APPROVAL MODE (Ask): Ask clarifying questions and confirm with the user before performing significant file mutations, external network actions, or wallet spend.",
        _ => "APPROVAL MODE (Manual): Require explicit step-by-step confirmation from the user for each individual action.",
    };

    let conversational_guidance = "CONVERSATIONAL AGILITY & NATURAL INTERACTION:\n- When the user sends a greeting, small talk, pleasantry, or simple direct question (e.g., \"hey\", \"hello\", \"what's up\", \"how are you\", \"what is X?\"), respond naturally, warmly, and directly as a helpful assistant. Do NOT run tools, do NOT invent definitions of done, and do NOT force artificial tables or proof cards for casual greetings.\n- When the user gives an actionable task (e.g., coding, building, terminal operations, file edits, automation), engage the required tools and execute diligently.";

    let format_guidance = "RESPONSE FORMAT:\n- For technical analysis, implementation plans, code, and structured data: Use clean, well-formatted Markdown with section headers (### Section), bullet points, and tables where appropriate.\n- For conversational replies or simple answers: Keep your response direct, friendly, and natural without unnecessary headings or tables.";

    let tool_instruction = "You are running inside Ronic OS with access to tools when tasks require them. You have direct access to the terminal: call terminal_command or sandbox_command to run git, npm, pnpm, cargo, python, bun, and test commands in the project folder with live terminal streaming. Report only what a tool returned. Do not claim you moved money, edited a file, ran a command, opened a page, or checked a service unless a tool card says so.\nFiles the user attaches are read for you and inlined into the request. To open any file on this computer — an attachment, a Desktop file, or any path the user named — call read_file with the full absolute path (or a project-relative path). Never claim you cannot open an attached or referenced file: read_file opens it.\nSkills, Plugins & MCP: You can download and install any skill or playbook directly (from a GitHub repository URL, raw file link, web URL, or catalog slug) using install_skill, install any plugin from GitHub or repo using install_plugin, and connect/trust any MCP server using connect_mcp. Call these immediately on your own whenever the user asks to add, install, or download skills, plugins, or MCP servers.\nWorkspace Webapps & Desktop apps: You HAVE FULL ACCESS and auto-control over both:\n1) In-workspace web apps (ChatGPT, Claude, Gemini, Perplexity, custom apps) running right beside you in the workspace stage via workspace_webapp (and inspect_page/read_page with target 'workspace' or app name). You can open them, inspect and read page contents, fill in credentials, submit prompts, and click buttons in the user's workspace session.\n2) Desktop applications (VS Code, Cursor, Claude Code, Obsidian, Ollama, etc.) via desktop_app. You can launch them and inspect/click/type their UI controls.\nNEVER tell the user you are isolated from their desktop or unable to see or control the webapps or desktop apps beside you.\nAction-First Principle: When the user asks you to check, test, access, open, or control an app, skill, plugin, or server (e.g. 'can you access desktop webapp', 'check if you can reach ChatGPT', 'open chatgpt', 'are you working'), DO NOT merely answer 'Yes I can, let me check...' or output thinking tags and stop. You MUST IMMEDIATELY invoke the appropriate tool (e.g. workspace_webapp, desktop_app, inspect_page, etc.) in the very first turn so real actions and results happen automatically.\nIf your API cannot call tools and a tool is required, reply with only a markdown fence tagged ronic-tool. The fence body is one JSON object with a tool field.";

    tiers.push(crate::coworker::PROTOCOL.to_string());
    tiers.push(conversational_guidance.into());
    tiers.push(mode_instruction.into());
    tiers.push(format_guidance.into());
    tiers.push(tool_instruction.into());
    tiers.push(mcp_lines(&view.mcp_servers, profile_id));
    Ok(tiers.join("\n\n"))
}

fn mcp_lines(servers: &[crate::models::McpServer], profile_id: &str) -> String {
    if servers.is_empty() {
        return "MCP servers: none saved. Do not say a server is connected.".into();
    }
    let mut lines = vec!["MCP servers on this profile. A missing switch row means Active, not off:".to_string()];
    for server in servers {
        let off = server.enables.iter().any(|flag| flag.profile_id == profile_id && !flag.enabled);
        let switch = if off { "Off" } else { "Active" };
        let trust = if server.trust == "trusted" { "trusted" } else { "not trusted" };
        lines.push(format!("- {} — switch {switch}, {trust}. Say the switch is off only when this line says Off.", server.name));
    }
    lines.join("\n")
}

pub fn in_index(skill: &Skill, profile_id: &str, plugin_on: bool) -> bool {
    if !skill.hidden_reason.is_empty() {
        return false;
    }
    let enabled = skill.enables.iter().any(|flag| flag.profile_id == profile_id && flag.enabled);
    if !enabled {
        return false;
    }
    if skill.origin == "plugin" && !plugin_on {
        return false;
    }
    true
}

fn view_index(skills: &[Skill], profile_id: &str, plugins: &[crate::models::PluginPackage]) -> String {
    skills
        .iter()
        .filter(|skill| in_index(skill, profile_id, capabilities::plugin_agent_on(plugins, &skill.plugin_id, profile_id)))
        .map(|skill| skill.index_line.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

fn slash_body(prompt: &str, skills: &[Skill], profile_id: &str, plugins: &[crate::models::PluginPackage]) -> Option<String> {
    let token = prompt.split_whitespace().next()?;
    if !token.starts_with('/') || token.len() < 2 {
        return None;
    }
    skills.iter().find(|skill| {
        in_index(skill, profile_id, capabilities::plugin_agent_on(plugins, &skill.plugin_id, profile_id))
            && (skill.slash_command == token || skill.slash_command.trim_start_matches('/') == token.trim_start_matches('/') || format!("/{}", skill.slug) == token)
    }).map(|skill| skill.body.clone())
}

fn profile_context(conn: &Connection, profile_id: &str) -> Result<(String, &'static str, &'static str, &'static str, String)> {
    let settings = db::settings_of(conn)?;
    let project = if settings.project_root.trim().is_empty() { "none".into() } else { settings.project_root };
    let row: Option<(i64, i64, i64, f64)> = conn
        .query_row(
            "SELECT allow_computer_use, allow_browser_use, allow_code_exec, daily_wallet_limit_usd FROM bot_profiles WHERE id = ?1",
            rusqlite::params![profile_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok();
    let (computer, browser, code, cap) = match row {
        Some((computer, browser, code, cap)) => (on_off(computer), on_off(browser), on_off(code), format!("{cap:.0}")),
        None => ("off", "off", "off", "0".into()),
    };
    Ok((project, computer, browser, code, cap))
}

fn on_off(flag: i64) -> &'static str {
    if flag == 0 { "off" } else { "on" }
}
