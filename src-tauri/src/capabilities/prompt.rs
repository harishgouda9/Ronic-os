use crate::capabilities;
use crate::db;
use crate::error::Result;
use crate::models::Skill;
use rusqlite::Connection;

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
    tiers.push("You are running inside Ronic OS to do the task, not to talk about doing it. Call a tool in this turn when the task needs one. You have direct access to the Ronic OS terminal: call terminal_command or sandbox_command to run git, npm, pnpm, cargo, python, bun, and test commands in the project folder with live terminal streaming. After each tool result, continue until the task is finished or a tool refuses it. Report only what a tool returned. Do not claim you moved money, edited a file, ran a command, opened a page, or checked a service unless a tool card says so.\nSkills are instructions. Call load_skill or load_skill_file for a playbook that is not already in this turn. skill_manage proposes a skill and waits for approval. list_mcp lists saved MCP servers and does not start them.\nIf your API cannot call tools and a tool is required, reply with only a markdown fence tagged omni-tool. The fence body is one JSON object with a tool field.".into());
    Ok(tiers.join("\n\n"))
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
