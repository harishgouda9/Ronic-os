use crate::models::{McpServer, PluginPackage, RegistryTool};

pub const BUILTINS: &[(&str, &str)] = &[
    ("list_memory", "List workspace memories."),
    ("search_memory", "Search memory titles and body text."),
    ("save_memory", "Save a memory onto the Memory screen."),
    ("list_skills", "List the skill index for this profile."),
    ("list_providers", "List providers and their status."),
    ("list_threads", "List chat tasks."),
    ("load_skill", "Load one SKILL.md playbook for this turn."),
    ("load_skill_file", "Load one supporting reference or script as text."),
    ("skill_manage", "Propose a new or updated SKILL.md. A person approves the write."),
];

pub fn builtin_names() -> std::collections::HashSet<String> {
    BUILTINS.iter().map(|(name, _)| (*name).to_string()).collect()
}

pub fn known_names(plugins: &[PluginPackage], servers: &[McpServer]) -> std::collections::HashSet<String> {
    let mut names = builtin_names();
    for plugin in plugins {
        for tool in &plugin.tools {
            names.insert(tool.name.clone());
        }
    }
    for server in servers {
        for tool in &server.declared_tools {
            names.insert(tool.name.clone());
        }
    }
    names
}

pub fn assemble(plugins: &[PluginPackage], servers: &[McpServer], profile_id: &str) -> Vec<RegistryTool> {
    let mut tools = Vec::new();
    for (name, description) in BUILTINS {
        tools.push(RegistryTool {
            name: (*name).into(),
            description: (*description).into(),
            source: "builtin".into(),
            available: true,
            reason: String::new(),
        });
    }
    for plugin in plugins {
        for tool in &plugin.tools {
            tools.push(RegistryTool {
                name: tool.name.clone(),
                description: tool.description.clone(),
                source: format!("plugin:{}", plugin.slug),
                available: false,
                reason: "No agent worker is running. The tool is declared only.".into(),
            });
        }
    }
    for server in servers {
        let switch_off = !profile_id.is_empty() && server.enables.iter().any(|flag| flag.profile_id == profile_id && !flag.enabled);
        let (available, reason) = if switch_off {
            (false, "Profile switch is Off.")
        } else if server.trust != "trusted" {
            (false, "Profile switch is Active. Trust the server before a bot can call it.")
        } else if server.url.starts_with("http") || !server.command.trim().is_empty() {
            (true, "Profile switch is Active. A call uses the stored credential when one is saved.")
        } else {
            (false, "Profile switch is Active. This server has no URL or command.")
        };
        for tool in &server.declared_tools {
            tools.push(RegistryTool {
                name: tool.name.clone(),
                description: tool.description.clone(),
                source: format!("mcp:{}", server.id),
                available,
                reason: reason.into(),
            });
        }
    }
    tools
}
