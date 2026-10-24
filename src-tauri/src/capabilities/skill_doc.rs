use crate::models::{DeclaredTool, DesktopBit};

#[derive(Debug, Clone)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub slash_command: String,
    pub requires_tools: Vec<String>,
    pub platforms: Vec<String>,
}

pub fn host_platform() -> &'static str {
    std::env::consts::OS
}

pub fn normalize_platform(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "win" | "win32" | "windows" => "windows".into(),
        "mac" | "osx" | "darwin" | "macos" => "macos".into(),
        "linux" => "linux".into(),
        other => other.to_string(),
    }
}

pub fn platform_ok(platforms: &[String]) -> bool {
    if platforms.is_empty() {
        return true;
    }
    let host = host_platform();
    platforms.iter().any(|item| normalize_platform(item) == host)
}

pub fn hidden_reason(platforms: &[String], requires: &[String], known: &std::collections::HashSet<String>) -> String {
    if !platform_ok(platforms) {
        return format!("Requires {}", platforms.join(", "));
    }
    let missing: Vec<&str> = requires.iter().filter(|name| !known.contains(name.as_str())).map(|name| name.as_str()).collect();
    if missing.is_empty() {
        String::new()
    } else {
        format!("Missing tool {}", missing.join(", "))
    }
}

pub fn index_line(slash: &str, description: &str, tools: &[String]) -> String {
    let slash = if slash.starts_with('/') { slash.to_string() } else if slash.is_empty() { "/skill".into() } else { format!("/{slash}") };
    let description = if description.trim().is_empty() { "No description".into() } else { description.trim().to_string() };
    if tools.is_empty() {
        format!("{slash} — {description}")
    } else {
        format!("{slash} — {description}. Requires {}.", tools.join(", "))
    }
}

pub fn parse_skill(raw: &str, fallback_name: &str) -> ParsedSkill {
    let map = frontmatter(raw);
    let name = map.get("name").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| fallback_name.to_string());
    let description = map.get("description").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| first_line(raw));
    let slash = map.get("slash_command").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("/{fallback_name}"));
    let requires = map.get("requires_tools").map(|value| list_value(value)).unwrap_or_default();
    let platforms = map.get("platforms").map(|value| list_value(value)).unwrap_or_default();
    ParsedSkill { name, description, slash_command: slash, requires_tools: requires, platforms }
}

pub fn render_skill(name: &str, description: &str, slash: &str, tools: &[String], platforms: &[String], instructions: &str) -> String {
    let platforms = if platforms.is_empty() { vec!["windows".into(), "macos".into(), "linux".into()] } else { platforms.to_vec() };
    format!(
        "---\nname: {name}\ndescription: {description}\nslash_command: {slash}\nrequires_tools: [{}]\nplatforms: [{}]\n---\n\n{}",
        tools.join(", "),
        platforms.join(", "),
        instructions.trim()
    )
}

#[derive(Debug, Clone)]
pub struct ParsedPlugin {
    pub slug: String,
    pub name: String,
    pub version: String,
    pub has_agent: bool,
    pub has_desktop: bool,
    pub tools: Vec<DeclaredTool>,
    pub hooks: Vec<String>,
    pub skills: Vec<String>,
    pub desktop: Vec<DesktopBit>,
}

pub fn parse_plugin(raw: &str, fallback_slug: &str) -> ParsedPlugin {
    if raw.trim_start().starts_with('{') {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
            return plugin_from_json(&value, fallback_slug);
        }
    }
    let mut slug = String::new();
    let mut name = String::new();
    let mut version = String::new();
    let mut has_agent = false;
    let mut has_desktop = false;
    let mut tools = Vec::new();
    let mut hooks = Vec::new();
    let mut skills = Vec::new();
    let mut desktop = Vec::new();
    let mut list: &str = "";
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("- ") {
            match list {
                "tools" => {
                    let mut tool = DeclaredTool { name: String::new(), description: String::new() };
                    if let Some((key, value)) = split_kv(rest) {
                        assign_tool(&mut tool, key, value);
                    }
                    tools.push(tool);
                }
                "desktop" => {
                    let mut bit = DesktopBit { kind: String::new(), label: String::new(), target: String::new() };
                    if let Some((key, value)) = split_kv(rest) {
                        assign_desktop(&mut bit, key, value);
                    }
                    desktop.push(bit);
                }
                "hooks" => hooks.push(rest.trim().to_string()),
                "skills" => skills.push(rest.trim().to_string()),
                _ => {}
            }
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some((key, value)) = split_kv(trimmed) {
                if list == "tools" {
                    if let Some(tool) = tools.last_mut() {
                        assign_tool(tool, key, value);
                    }
                } else if list == "desktop" {
                    if let Some(bit) = desktop.last_mut() {
                        assign_desktop(bit, key, value);
                    }
                }
            }
            continue;
        }
        if let Some((key, value)) = split_kv(trimmed) {
            if value.is_empty() {
                list = match key {
                    "tools" => "tools",
                    "desktop" => "desktop",
                    "hooks" => "hooks",
                    "skills" => "skills",
                    _ => "",
                };
                continue;
            }
            list = "";
            match key {
                "id" | "slug" => slug = value.to_string(),
                "name" => name = value.to_string(),
                "version" => version = value.to_string(),
                "has_agent_part" | "has_agent" => has_agent = truthy(value),
                "has_desktop_part" | "has_desktop" => has_desktop = truthy(value),
                "hooks" => hooks = list_value(value),
                "skills" => skills = list_value(value),
                _ => {}
            }
        }
    }
    finish_plugin(slug, name, version, has_agent, has_desktop, tools, hooks, skills, desktop, fallback_slug)
}

pub fn render_plugin(doc: &ParsedPlugin) -> String {
    let mut out = format!(
        "id: {}\nname: {}\nversion: {}\nhas_agent_part: {}\nhas_desktop_part: {}\n",
        doc.slug, doc.name, doc.version, doc.has_agent, doc.has_desktop
    );
    out.push_str("tools:\n");
    for tool in &doc.tools {
        out.push_str(&format!("  - name: {}\n    description: {}\n", tool.name, tool.description));
    }
    out.push_str(&format!("hooks: [{}]\n", doc.hooks.join(", ")));
    out.push_str(&format!("skills: [{}]\n", doc.skills.join(", ")));
    out.push_str("desktop:\n");
    for bit in &doc.desktop {
        out.push_str(&format!("  - kind: {}\n    label: {}\n    target: {}\n", bit.kind, bit.label, bit.target));
    }
    out
}

fn plugin_from_json(value: &serde_json::Value, fallback_slug: &str) -> ParsedPlugin {
    let slug = value.get("id").and_then(|v| v.as_str()).unwrap_or(fallback_slug).to_string();
    let name = value.get("name").and_then(|v| v.as_str()).unwrap_or(&slug).to_string();
    let version = value.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0").to_string();
    let has_agent = value.get("has_agent_part").and_then(|v| v.as_bool()).unwrap_or(false);
    let has_desktop = value.get("has_desktop_part").and_then(|v| v.as_bool()).unwrap_or(false);
    let tools = array_of(value, "tools", |item| DeclaredTool {
        name: item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        description: item.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    });
    let hooks = string_array(value, "hooks");
    let skills = string_array(value, "skills");
    let desktop = array_of(value, "desktop", |item| DesktopBit {
        kind: item.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        label: item.get("label").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        target: item.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    });
    finish_plugin(slug, name, version, has_agent, has_desktop, tools, hooks, skills, desktop, fallback_slug)
}

fn finish_plugin(
    slug: String,
    name: String,
    version: String,
    has_agent: bool,
    has_desktop: bool,
    tools: Vec<DeclaredTool>,
    hooks: Vec<String>,
    skills: Vec<String>,
    desktop: Vec<DesktopBit>,
    fallback_slug: &str,
) -> ParsedPlugin {
    let slug = sanitize_slug(if slug.is_empty() { fallback_slug } else { &slug });
    let name = if name.is_empty() { slug.clone() } else { name };
    let version = if version.is_empty() { "1.0.0".into() } else { version };
    let tools: Vec<_> = tools.into_iter().filter(|tool| !tool.name.trim().is_empty()).collect();
    let hooks: Vec<_> = hooks.into_iter().map(|hook| hook.trim().to_string()).filter(|hook| is_hook(hook)).collect();
    let skills: Vec<_> = skills.into_iter().map(|skill| sanitize_slug(&skill)).filter(|skill| !skill.is_empty()).collect();
    let desktop: Vec<_> = desktop
        .into_iter()
        .filter(|bit| matches!(bit.kind.as_str(), "status" | "command" | "pane") && !bit.label.trim().is_empty())
        .collect();
    let has_desktop = has_desktop || !desktop.is_empty();
    let has_agent = has_agent || !tools.is_empty() || !hooks.is_empty() || !skills.is_empty();
    ParsedPlugin { slug, name, version, has_agent, has_desktop, tools, hooks, skills, desktop }
}

pub fn sanitize_slug(raw: &str) -> String {
    let slug: String = raw
        .trim()
        .trim_start_matches('/')
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch.to_ascii_lowercase() } else { '-' })
        .collect();
    slug.trim_matches('-').chars().take(80).collect()
}

pub fn is_hook(name: &str) -> bool {
    matches!(name, "session_start" | "before_model_call" | "before_tool_call" | "after_tool_call" | "session_end")
}

fn frontmatter(raw: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let text = raw.trim_start();
    let Some(rest) = text.strip_prefix("---") else { return map };
    let Some((head, _)) = rest.split_once("\n---") else { return map };
    let lines: Vec<&str> = head.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let raw_line = lines[index];
        if raw_line.trim().is_empty() || raw_line.trim_start().starts_with('#') || raw_line.starts_with(' ') || raw_line.starts_with('\t') {
            index += 1;
            continue;
        }
        let Some((key, value)) = split_kv(raw_line.trim()) else {
            index += 1;
            continue;
        };
        index += 1;
        let indicator = value.trim();
        if matches!(indicator, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
            let mut parts = Vec::new();
            while index < lines.len() {
                let next = lines[index];
                if next.trim().is_empty() {
                    index += 1;
                    continue;
                }
                if !(next.starts_with(' ') || next.starts_with('\t')) {
                    break;
                }
                parts.push(next.trim().to_string());
                index += 1;
            }
            let joined = if indicator.starts_with('>') { parts.join(" ") } else { parts.join("\n") };
            if !joined.is_empty() {
                map.insert(key.to_string(), joined);
            }
        } else if !indicator.is_empty() {
            map.insert(key.to_string(), indicator.trim_matches('"').trim_matches('\'').to_string());
        }
    }
    map
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim();
    if key.is_empty() || key.contains(' ') { return None; }
    Some((key, value.trim().trim_matches('"').trim_matches('\'')))
}

fn list_value(raw: &str) -> Vec<String> {
    let trimmed = raw.trim().trim_start_matches('[').trim_end_matches(']');
    trimmed
        .split(',')
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn truthy(value: &str) -> bool {
    matches!(value.trim(), "true" | "yes" | "1")
}

fn first_line(raw: &str) -> String {
    raw.lines().map(str::trim).find(|line| !line.is_empty() && *line != "---" && !line.starts_with("name:")).unwrap_or("").trim_start_matches('#').trim().to_string()
}

fn assign_tool(tool: &mut DeclaredTool, key: &str, value: &str) {
    match key {
        "name" => tool.name = value.to_string(),
        "description" => tool.description = value.to_string(),
        _ => {}
    }
}

fn assign_desktop(bit: &mut DesktopBit, key: &str, value: &str) {
    match key {
        "kind" => bit.kind = value.to_string(),
        "label" => bit.label = value.to_string(),
        "target" => bit.target = value.to_string(),
        _ => {}
    }
}

fn array_of<T>(value: &serde_json::Value, key: &str, map: impl Fn(&serde_json::Value) -> T) -> Vec<T> {
    value.get(key).and_then(|item| item.as_array()).map(|rows| rows.iter().map(map).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::parse_skill;

    #[test]
    fn folded_frontmatter_description_is_one_line() {
        let parsed = parse_skill("---\nname: computer-use\ndescription: >-\n  Drives the GUI\n  of a window.\n---\n\n# Body\n", "computer-use");
        assert_eq!(parsed.description, "Drives the GUI of a window.");
        assert_eq!(parsed.slash_command, "/computer-use");
    }
}

fn string_array(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|item| item.as_array())
        .map(|rows| rows.iter().filter_map(|item| item.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}
