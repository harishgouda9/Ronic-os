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

pub fn assemble(plugins: &[PluginPackage], servers: &[McpServer]) -> Vec<RegistryTool> {
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
        for tool in &server.declared_tools {
            tools.push(RegistryTool {
                name: tool.name.clone(),
                description: tool.description.clone(),
                source: format!("mcp:{}", server.id),
                available: false,
                reason: "MCP sessions are not open in this version.".into(),
            });
        }
    }
    tools
}
