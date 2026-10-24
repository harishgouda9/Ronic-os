import type { McpServer, PluginPackage, ProfileFlag, RegistryTool, Skill } from "../types";

export const BUILTIN_TOOLS: RegistryTool[] = [
  ["list_memory", "List workspace memories."],
  ["search_memory", "Search memory titles and body text."],
  ["save_memory", "Save a memory onto the Memory screen."],
  ["list_skills", "List the skill index for this profile."],
  ["list_providers", "List providers and their status."],
  ["list_threads", "List chat tasks."],
  ["load_skill", "Load one SKILL.md playbook for this turn."],
  ["load_skill_file", "Load one supporting reference or script as text."],
  ["skill_manage", "Propose a new or updated SKILL.md. A person approves the write."],
].map(([name, description]) => ({ name, description, source: "builtin", available: true, reason: "" }));

export function hostPlatform(): string {
  if (typeof navigator === "undefined") return "linux";
  const raw = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (raw.includes("win")) return "windows";
  if (raw.includes("mac")) return "macos";
  return "linux";
}

export function normalizePlatform(raw: string) {
  const value = raw.trim().toLowerCase();
  if (value === "win" || value === "win32" || value === "windows") return "windows";
  if (value === "mac" || value === "osx" || value === "darwin" || value === "macos") return "macos";
  if (value === "linux") return "linux";
  return value;
}

export function sanitizeSlug(raw: string) {
  return raw.trim().replace(/^\//, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function hiddenReason(platforms: string[], tools: string[], known: Set<string>) {
  if (platforms.length > 0 && !platforms.some((item) => normalizePlatform(item) === hostPlatform())) {
    return `Requires ${platforms.join(", ")}`;
  }
  const missing = tools.filter((name) => !known.has(name));
  return missing.length ? `Missing tool ${missing.join(", ")}` : "";
}

export function indexLine(slash: string, description: string, tools: string[]) {
  const command = slash.startsWith("/") ? slash : slash ? `/${slash}` : "/skill";
  const text = description.trim() || "No description";
  return tools.length ? `${command} — ${text}. Requires ${tools.join(", ")}.` : `${command} — ${text}`;
}

export function enabledFor(flags: ProfileFlag[], profileId: string) {
  return flags.some((flag) => flag.profileId === profileId && flag.enabled);
}

export function pluginAgentOn(plugins: PluginPackage[], pluginId: string, profileId: string) {
  return plugins.some((plugin) => plugin.id === pluginId && plugin.trust === "trusted" && enabledFor(plugin.agentEnables, profileId));
}

export function inIndex(skill: Skill, plugins: PluginPackage[], profileId: string) {
  if (skill.hiddenReason) return false;
  if (!enabledFor(skill.enables, profileId)) return false;
  if (skill.origin === "plugin" && !pluginAgentOn(plugins, skill.pluginId, profileId)) return false;
  return true;
}

export function rebuildRegistry(plugins: PluginPackage[], servers: McpServer[]): RegistryTool[] {
  return [
    ...BUILTIN_TOOLS,
    ...plugins.flatMap((plugin) => plugin.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      source: `plugin:${plugin.slug}`,
      available: false,
      reason: "No agent worker is running. The tool is declared only.",
    }))),
    ...servers.flatMap((server) => server.declaredTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      source: `mcp:${server.id}`,
      available: false,
      reason: "MCP sessions are not open in this version.",
    }))),
  ];
}

export function knownToolNames(registry: RegistryTool[]) {
  return new Set(registry.map((tool) => tool.name));
}

export function estimateTokens(text: string) {
  return Math.floor(text.length / 4);
}

export function proposedDiff(current: string, next: string) {
  const have = new Set(current.split("\n"));
  return next.split("\n").map((line) => (have.has(line) ? `  ${line}` : `+ ${line}`)).join("\n");
}

export function parseFront(body: string) {
  const text = body.trimStart();
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const map = new Map<string, string>();
  for (const line of text.slice(3, end).split("\n")) {
    const split = line.indexOf(":");
    if (split <= 0) continue;
    map.set(line.slice(0, split).trim(), line.slice(split + 1).trim());
  }
  const list = (key: string) => (map.get(key) ?? "").replace(/^\[/, "").replace(/\]$/, "").split(",").map((item) => item.trim()).filter(Boolean);
  return {
    name: map.get("name") ?? "",
    description: map.get("description") ?? "",
    slash: map.get("slash_command") ?? "",
    tools: list("requires_tools"),
    platforms: list("platforms"),
  };
}

export function skillTemplate(slug: string) {
  return `---\nname: ${slug}\ndescription: ${slug}\nslash_command: /${slug}\nrequires_tools: []\nplatforms: [windows, macos, linux]\n---\n\n# ${slug}\n\n1. Describe the steps the agent should follow.\n`;
}
