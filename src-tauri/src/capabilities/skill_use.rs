use crate::models::{McpServer, PluginPackage, Skill};

/// Playbook text for this turn.
/// A visible skill loads when the request names it or repeats its title or
/// description. That includes this bot's folder, the shared catalog, and plugin
/// skills. Another bot's folder stays out. A greeting loads nothing.
pub fn playbook(prompt: &str, skills: &[&Skill], plugins: &[PluginPackage], profile_id: &str) -> Option<String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return None;
    }
    let picked = choose(prompt, skills, plugins, profile_id);
    if picked.skills.is_empty() && picked.notes.is_empty() {
        return None;
    }
    let mut body = String::new();
    for skill in picked.skills.into_iter().take(2) {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        let title = if skill.title.trim().is_empty() { skill.slug.as_str() } else { skill.title.trim() };
        body.push_str(&format!("# {title}\n{}", clip(&skill.body, 3500)));
        if body.chars().count() >= 7000 {
            break;
        }
    }
    for note in picked.notes {
        if body.chars().count() >= 7000 {
            break;
        }
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(&note);
    }
    Some(body)
}

/// Tools the loaded skills say this job needs. Empty when no skill loaded. Capped at 4.
pub fn required_tools(prompt: &str, skills: &[&Skill], plugins: &[PluginPackage], profile_id: &str) -> Vec<String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Vec::new();
    }
    let picked = choose(prompt, skills, plugins, profile_id);
    let mut out = Vec::new();
    for skill in picked.skills.into_iter().take(2) {
        for tool in &skill.requires_tools {
            let tool = tool.trim();
            if tool.is_empty() || out.iter().any(|have: &String| have == tool) {
                continue;
            }
            out.push(tool.to_string());
            if out.len() == 4 {
                return out;
            }
        }
    }
    out
}

struct Picked<'a> {
    skills: Vec<&'a Skill>,
    notes: Vec<String>,
}

fn choose<'a>(prompt: &str, skills: &[&'a Skill], plugins: &[PluginPackage], profile_id: &str) -> Picked<'a> {
    let words = words(prompt);
    let mut chosen: Vec<&Skill> = Vec::new();
    for skill in skills {
        if usable(skill, skills, profile_id) && named(skill, &words) {
            push_unique(&mut chosen, skill);
        }
    }
    let mut matched: Vec<&PluginPackage> = Vec::new();
    for plugin in plugins {
        if !plugin_needed(plugin, &words, prompt) {
            continue;
        }
        matched.push(plugin);
        if let Some(skill) = skills.iter().copied().find(|skill| skill.plugin_id == plugin.id && usable(skill, skills, profile_id)) {
            push_unique(&mut chosen, skill);
        }
    }
    for skill in skills {
        if usable(skill, skills, profile_id) && phrase_needed(skill, prompt) {
            push_unique(&mut chosen, skill);
        }
    }
    let mut notes = Vec::new();
    if chosen.len() < 2 {
        for plugin in matched {
            if chosen.iter().any(|skill| skill.plugin_id == plugin.id) || !plugin_live(plugin, profile_id) {
                continue;
            }
            notes.push(plugin_line(plugin));
            if chosen.len() + notes.len() >= 2 {
                break;
            }
        }
    }
    Picked { skills: chosen, notes }
}

/// Active trusted MCP servers whose name or tools the request actually names.
/// A greeting and an Off or untrusted server produce nothing.
pub fn mcp_turn(prompt: &str, servers: &[McpServer], profile_id: &str) -> Option<String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return None;
    }
    let words = words(prompt);
    let text = prompt.to_lowercase();
    let mut lines = Vec::new();
    for server in servers {
        if !server_live(server, profile_id) || !server_needed(server, &words, &text) {
            continue;
        }
        let tools = server
            .declared_tools
            .iter()
            .take(4)
            .map(|tool| {
                if tool.description.trim().is_empty() {
                    tool.name.clone()
                } else {
                    format!("{} ({})", tool.name, clip(tool.description.trim(), 120))
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let tools = if tools.is_empty() { "no tools declared".to_string() } else { tools };
        lines.push(format!("- {} tools: {tools}", server.name));
        if lines.len() == 2 {
            break;
        }
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!("MCP for this turn. Use these servers:\n{}", lines.join("\n")))
}

fn push_unique<'a>(chosen: &mut Vec<&'a Skill>, skill: &'a Skill) {
    if !chosen.iter().any(|item| item.id == skill.id || item.slug == skill.slug) {
        chosen.push(skill);
    }
}

fn usable(skill: &Skill, skills: &[&Skill], profile_id: &str) -> bool {
    if !owned_here(skill, profile_id) {
        return false;
    }
    if skill.origin == "catalog" {
        return !skills.iter().any(|other| other.slug == skill.slug && other.origin == "profile" && other.owner_profile_id == profile_id);
    }
    true
}

fn owned_here(skill: &Skill, profile_id: &str) -> bool {
    skill.origin != "profile" || skill.owner_profile_id.is_empty() || skill.owner_profile_id == profile_id
}

fn named(skill: &Skill, words: &[String]) -> bool {
    let leaf = skill.slug.rsplit(':').next().unwrap_or(skill.slug.as_str());
    for name in [skill.slug.as_str(), skill.title.as_str(), skill.slash_command.trim_start_matches('/'), leaf] {
        let name = name.trim().to_lowercase();
        if name.len() >= 3 && words.iter().any(|word| word == &name) {
            return true;
        }
    }
    false
}

fn plugin_named(plugin: &PluginPackage, words: &[String]) -> bool {
    for name in [plugin.slug.as_str(), plugin.name.as_str()] {
        let name = name.trim().to_lowercase();
        if name.len() >= 4 && words.iter().any(|word| word == &name) {
            return true;
        }
    }
    false
}

fn plugin_needed(plugin: &PluginPackage, words: &[String], prompt: &str) -> bool {
    if plugin_named(plugin, words) {
        return true;
    }
    let text = prompt.to_lowercase();
    for tool in &plugin.tools {
        let name = tool.name.trim().to_lowercase();
        if name.len() >= 6 && words.iter().any(|word| word == &name) {
            return true;
        }
        let description = tool.description.trim().to_lowercase();
        if description.len() >= 12 && text.contains(&description) {
            return true;
        }
    }
    false
}

fn plugin_live(plugin: &PluginPackage, profile_id: &str) -> bool {
    plugin.has_agent && plugin.trust == "trusted" && plugin.agent_enables.iter().any(|flag| flag.profile_id == profile_id && flag.enabled)
}

fn plugin_line(plugin: &PluginPackage) -> String {
    let tools = plugin
        .tools
        .iter()
        .take(4)
        .map(|tool| {
            if tool.description.trim().is_empty() {
                tool.name.clone()
            } else {
                format!("{} ({})", tool.name, clip(tool.description.trim(), 80))
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    if tools.is_empty() {
        format!("Plugin {} applies this turn.", plugin.name)
    } else {
        format!("Plugin {} applies this turn. Tools: {tools}.", plugin.name)
    }
}

fn phrase_needed(skill: &Skill, prompt: &str) -> bool {
    // shortcut: verbatim text, or two shared words of length 4 or more, upgrade when a real paraphrase should match
    let text = prompt.to_lowercase();
    let title = skill.title.trim().to_lowercase();
    if title.len() >= 8 && text.contains(&title) {
        return true;
    }
    let description = skill.description.trim().to_lowercase();
    if description.len() >= 12 && text.contains(&description) {
        return true;
    }
    let prompt_words = words(prompt);
    (!title.is_empty() && word_overlap(&title, &prompt_words)) || (!description.is_empty() && word_overlap(&description, &prompt_words))
}

fn word_overlap(hay: &str, prompt_words: &[String]) -> bool {
    let hay_words = words(hay);
    let left = significant(&hay_words);
    let right = significant(prompt_words);
    let mut hits = 0;
    for word in &left {
        if right.iter().any(|other| other == word) {
            hits += 1;
            if hits >= 2 {
                return true;
            }
        }
    }
    false
}

fn significant(words: &[String]) -> Vec<&str> {
    const STOP: &[&str] = &[
        "this", "that", "with", "from", "your", "have", "please", "skill", "plugin", "file", "code", "help", "make", "need", "want", "user", "turn", "tool", "about", "into", "them", "they", "what", "when", "where", "which", "would", "could", "should", "just", "like", "some", "than", "then", "also", "only", "over", "such", "very", "been", "were", "will", "each", "more", "most", "other", "these", "those", "there", "their",
    ];
    words.iter().filter(|word| word.len() >= 4 && !STOP.contains(&word.as_str())).map(|word| word.as_str()).collect()
}

fn server_live(server: &McpServer, profile_id: &str) -> bool {
    server.trust == "trusted" && !server.enables.iter().any(|flag| flag.profile_id == profile_id && !flag.enabled)
}

fn server_needed(server: &McpServer, words: &[String], text: &str) -> bool {
    let name = server.name.trim().to_lowercase();
    if name.len() >= 4 && (words.iter().any(|word| word == &name) || (name.len() >= 8 && text.contains(&name))) {
        return true;
    }
    for tool in &server.declared_tools {
        let tool_name = tool.name.trim().to_lowercase();
        if tool_name.len() >= 6 && words.iter().any(|word| word == &tool_name) {
            return true;
        }
        let description = tool.description.trim().to_lowercase();
        if description.len() >= 12 && text.contains(&description) {
            return true;
        }
    }
    false
}

fn words(prompt: &str) -> Vec<String> {
    prompt
        .to_lowercase()
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':'))
        .filter(|word| !word.is_empty())
        .map(|word| word.to_string())
        .collect()
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        text.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DeclaredTool, DesktopBit, ProfileFlag, SkillFile};

    fn skill(id: &str, slug: &str, origin: &str, owner: &str, plugin: &str, title: &str, description: &str, body: &str) -> Skill {
        Skill {
            id: id.into(),
            slug: slug.into(),
            origin: origin.into(),
            owner_profile_id: owner.into(),
            plugin_id: plugin.into(),
            title: title.into(),
            description: description.into(),
            slash_command: format!("/{slug}"),
            requires_tools: Vec::new(),
            platforms: Vec::new(),
            body: body.into(),
            files: Vec::<SkillFile>::new(),
            enables: vec![ProfileFlag { profile_id: owner.into(), enabled: true }],
            hidden_reason: String::new(),
            index_line: description.into(),
            version: "1".into(),
            updated_at: 0,
        }
    }

    fn plugin(id: &str, slug: &str, name: &str) -> PluginPackage {
        PluginPackage {
            id: id.into(),
            slug: slug.into(),
            name: name.into(),
            version: "1".into(),
            source: "builtin".into(),
            source_path: String::new(),
            trust: "trusted".into(),
            has_agent: true,
            has_desktop: false,
            tools: Vec::new(),
            hooks: Vec::new(),
            bundled_skills: Vec::new(),
            desktop: Vec::<DesktopBit>::new(),
            agent_enables: vec![ProfileFlag { profile_id: "bot_a".into(), enabled: true }],
            desktop_enabled: false,
        }
    }

    fn banner() -> PluginPackage {
        let mut item = plugin("plug-banner", "bannerpack", "Banner Pack");
        item.tools.push(DeclaredTool { name: "make_banner".into(), description: "format a social banner".into() });
        item
    }

    fn server(name: &str, trust: &str, enabled: bool) -> McpServer {
        McpServer {
            id: format!("mcp-{name}"),
            name: name.into(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: Vec::new(),
            url: String::new(),
            trust: trust.into(),
            declared_tools: vec![DeclaredTool { name: "scan_ledger".into(), description: "Zedvault ledger scan phrase".into() }],
            enables: vec![ProfileFlag { profile_id: "bot_a".into(), enabled }],
            last_error: String::new(),
        }
    }

    #[test]
    fn a_greeting_loads_nothing_and_a_name_or_matching_job_loads_the_playbook() {
        let own = skill("sk-ship", "ship-pr", "profile", "bot_a", "", "ship-pr", "Ship the pull request", "STAGE2-BODY");
        let other = skill("sk-other", "ship-pr", "profile", "bot_b", "", "ship-pr", "Ship the pull request", "OTHER-BODY");
        let catalog = skill("sk-cat", "ship-pr", "catalog", "", "", "ship-pr", "Ship the pull request", "CATALOG-BODY");
        let plug_skill = skill("sk-pony", "prebuilt-skills:ponytail", "plugin", "", "plug-pony", "Ponytail", "Lazy senior mode", "PONY-BODY");
        let pony = plugin("plug-pony", "ponytail", "Ponytail");
        let skills = [&own, &other, &plug_skill];
        let plugins = [pony];
        assert!(playbook("hello", &skills, &plugins, "bot_a").is_none());
        let named = playbook("please use ship-pr on this branch", &skills, &plugins, "bot_a").unwrap();
        assert!(named.contains("STAGE2-BODY"), "{named}");
        assert!(!named.contains("OTHER-BODY"), "{named}");
        let needed = playbook("Ship the pull request for the branch", &skills, &plugins, "bot_a").unwrap();
        assert!(needed.contains("STAGE2-BODY"), "{needed}");
        assert!(playbook("Ship the pull request", &[&other], &[], "bot_a").is_none());
        let plugin_hit = playbook("use the ponytail plugin", &skills, &plugins, "bot_a").unwrap();
        assert!(plugin_hit.contains("PONY-BODY"), "{plugin_hit}");
        let global = playbook("write this in Lazy senior mode please", &skills, &plugins, "bot_a").unwrap();
        assert!(global.contains("PONY-BODY"), "{global}");
        assert!(!global.contains("STAGE2-BODY"), "{global}");
        let shared = playbook("Ship the pull request for the branch", &[&catalog], &[], "bot_a").unwrap();
        assert!(shared.contains("CATALOG-BODY"), "{shared}");
        let shadowed = playbook("Ship the pull request for the branch", &[&own, &catalog], &[], "bot_a").unwrap();
        assert!(shadowed.contains("STAGE2-BODY"), "{shadowed}");
        assert!(!shadowed.contains("CATALOG-BODY"), "{shadowed}");
        let pack = banner();
        let noted = playbook("please format a social banner for launch", &[], &[pack], "bot_a").unwrap();
        assert!(noted.contains("Banner Pack"), "{noted}");
        assert!(playbook("hello", &[], &[banner()], "bot_a").is_none());
        let mut off = banner();
        off.agent_enables.clear();
        assert!(playbook("please format a social banner for launch", &[], &[off], "bot_a").is_none());
        let live = server("Zedvault", "trusted", true);
        assert!(mcp_turn("hello", &[live.clone()], "bot_a").is_none());
        assert!(mcp_turn("please do a Zedvault ledger scan phrase now", &[server("Zedvault", "untrusted", true)], "bot_a").is_none());
        assert!(mcp_turn("please do a Zedvault ledger scan phrase now", &[server("Zedvault", "trusted", false)], "bot_a").is_none());
        let note = mcp_turn("please do a Zedvault ledger scan phrase now", &[live], "bot_a").unwrap();
        assert!(note.contains("MCP for this turn"), "{note}");
        assert!(note.contains("scan_ledger"), "{note}");
        let review = playbook("review this pull request", &skills, &plugins, "bot_a").unwrap();
        assert!(review.contains("STAGE2-BODY"), "{review}");
        assert!(playbook("hello", &skills, &plugins, "bot_a").is_none());
        assert!(playbook("please", &skills, &plugins, "bot_a").is_none());
        let mut needing = own.clone();
        needing.requires_tools = vec!["scan_ledger".into(), "scan_ledger".into(), "propose_diff".into()];
        let tools = required_tools("Ship the pull request for the branch", &[&needing], &[], "bot_a");
        assert_eq!(tools, vec!["scan_ledger".to_string(), "propose_diff".to_string()]);
    }
}
