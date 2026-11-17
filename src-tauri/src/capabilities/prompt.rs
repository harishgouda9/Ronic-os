use crate::capabilities;
use crate::db;
use crate::error::Result;
use crate::models::Skill;
use rusqlite::{params, Connection};

pub fn system_for(conn: &Connection, home: &std::path::Path, profile_id: &str, soul: &str, user_prompt: &str, memory: &str) -> Result<String> {
    let view = capabilities::view(conn, home, profile_id)?;
    let delta = capabilities::take_delta(conn, profile_id)?;
    let visible: Vec<&Skill> = view
        .skills
        .iter()
        .filter(|skill| in_index(skill, profile_id, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, profile_id)))
        .collect();
    let playbook = crate::capabilities::skill_use::playbook(user_prompt, &visible, &view.plugins, profile_id);
    let mcp = crate::capabilities::skill_use::mcp_turn(user_prompt, &view.mcp_servers, profile_id);
    let (project, computer, browser, code, cap) = profile_context(conn, profile_id)?;
    let index = view_index(&view.skills, profile_id, &view.plugins);
    if crate::coworker::is_greeting(&user_prompt.trim().to_ascii_lowercase()) {
        return Ok(vec![
            soul.trim().to_string(),
            format!("Project: {project}"),
            format!(
                "Skill index:\n{}\nUse a matching skill from this bot's directory, the shared catalog, or an enabled plugin. Naming a skill, plugin, or MCP server loads it for this turn. If a skill is only listed here, call load_skill with its slug before you answer.",
                if index.is_empty() { "none".into() } else { index }
            ),
            format!("Relevant memory:\n{memory}"),
        ]
        .join("\n\n"));
    }
    let injection = crate::workspace_bridge::format_injection_brief(&project, home);
    let mut tiers = vec![
        soul.trim().to_string(),
        format!("Project: {project}\nComputer use: {computer}. Browser use: {browser}. Code execution: {code}. Daily wallet cap: ${cap}."),
        injection,
        format!(
            "Skill index:\n{}\nUse a matching skill from this bot's directory, the shared catalog, or an enabled plugin. Naming a skill, plugin, or MCP server loads it for this turn. If a skill is only listed here, call load_skill with its slug before you answer.",
            if index.is_empty() { "none".into() } else { index }
        ),
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
        turn.push_str("Skill playbook for this turn. Follow it:\n");
        turn.push_str(&body);
    }
    if let Some(note) = mcp {
        if !turn.is_empty() {
            turn.push('\n');
        }
        turn.push_str(&note);
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

    let tool_instruction = "You are running inside Ronic OS with access to tools when tasks require them.\nAUTONOMOUS RESEARCH: For research, news, trends, comparisons, current facts, or fact-checking, call web_search FIRST. It independently discovers and reads multiple sources without an API key, external answer engine, pasted prompt, browser, or site login. Treat its output only as evidence: YOU are the researcher and writer. Analyze it, merge duplicate stories, rank relevant/recent findings, explain why each matters, and finish with concise, dated Markdown source links that answer the exact request. Never paste or paraphrase a third-party AI answer as your research; do not say 'search results say' when you can directly synthesize the evidence. web_search automatically reads multiple articles; use web_fetch only for missing details or a specific source. If discovery is thin, refine the query once; use inspect_page only for interactive or signed-in evidence. Do not give up because one site, especially X/Twitter, requires login. Distinguish broad current coverage from verified platform-specific trends; never invent engagement, dates, sources, or consensus.\nThe terminal (terminal_command, sandbox_command) runs inside this bot's own workspace folder. It cannot open the project folder. Use it for allowlisted commands whose inputs are already in that workspace. Read and list the project folder with read_file and list_files. Report only what a tool returned. Do not claim you moved money, edited a file, ran a command, opened a page, or checked a service unless a tool card says so.\nFiles the user attaches are read for you and inlined into the request. read_file and list_files open the project folder named in Context injection. An empty list_files path is that folder. A project-relative path stays inside it. An absolute path is opened only when it is a file the user attached in this chat. Do not ask the user to attach the project folder when Context injection names it. A browser login is the page session listed in Context injection. Use inspect_page and read_page on that session. Do not ask the user to sign in again. Context injection is on every tool result, not only Slack. Do not paste the workspace pack into a team message or an email.\nSkills, Plugins & MCP: You can download and install any skill or playbook directly (from a GitHub repository URL, raw file link, web URL, or catalog slug) using install_skill, install any plugin from GitHub or repo using install_plugin, and connect/trust any MCP server using connect_mcp. Call these immediately on your own whenever the user asks to add, install, or download skills, plugins, or MCP servers.\nWorkspace Webapps & Desktop apps: You HAVE FULL ACCESS and auto-control over both:\n1) In-workspace web apps (ChatGPT, Claude, Gemini, Perplexity, custom apps) running right beside you in the workspace stage via workspace_webapp (and inspect_page/read_page with target 'workspace' or app name). You can open them, inspect and read page contents, fill in credentials, submit prompts, and click buttons in the user's workspace session.\n2) Desktop applications (VS Code, Cursor, Claude Code, Obsidian, Ollama, etc.) via desktop_app. You can launch them and inspect/click/type their UI controls.\nNEVER tell the user you are isolated from their desktop or unable to see or control the webapps or desktop apps beside you.\nAction-First Principle: When the user asks you to check, test, access, open, or control an app, skill, plugin, or server (e.g. 'can you access desktop webapp', 'check if you can reach ChatGPT', 'open chatgpt', 'are you working'), DO NOT merely answer 'Yes I can, let me check...' or output thinking tags and stop. You MUST IMMEDIATELY invoke the appropriate tool (e.g. workspace_webapp, desktop_app, inspect_page, etc.) in the very first turn so real actions and results happen automatically.\nWhen the user says they logged in in your browser, read Context injection. If that site is listed, use the open page. If the project folder is named, list_files it. Do not answer that the terminal workspace is empty and stop.\nIf your API cannot call tools and a tool is required, reply with only a markdown fence tagged ronic-tool. The fence body is one JSON object with a tool field.";

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
    let enabled = match skill.enables.iter().find(|flag| flag.profile_id == profile_id) {
        Some(flag) => flag.enabled,
        None => skill.origin == "catalog",
    };
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
