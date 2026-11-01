import type { McpServer, PluginPackage, Skill, SkillProposal, Snapshot } from "../types";
import { rememberSecret } from "./liveChat";
import { INCLUDED } from "./includedCatalog";
import { hiddenReason, indexLine, knownToolNames, parseFront, rebuildRegistry, sanitizeSlug } from "./skillIndex";

type Draft = {
  id?: string;
  profileId?: string;
  slug?: string;
  title?: string;
  description?: string;
  slashCommand?: string;
  requiresTools?: string[];
  platforms?: string[];
  body?: string;
  files?: { path: string; content: string }[];
};

function nid(prefix: string) {
  return `${prefix}_${Date.now().toString(16)}${Math.floor(Math.random() * 9999).toString(16)}`;
}

function redecorate(state: Snapshot) {
  state.registry = rebuildRegistry(state.plugins, state.mcpServers, state.activeProfileId);
  const known = knownToolNames(state.registry);
  state.skills = state.skills.map((skill) => ({
    ...skill,
    hiddenReason: hiddenReason(skill.platforms, skill.requiresTools, known),
    indexLine: indexLine(skill.slashCommand, skill.description, skill.requiresTools),
  }));
}

function setEnable(skill: Skill, profileId: string, enabled: boolean) {
  const row = skill.enables.find((flag) => flag.profileId === profileId);
  if (row) row.enabled = enabled;
  else skill.enables.push({ profileId, enabled });
}

function note(state: Snapshot, profileId: string, line: string) {
  if (!profileId || profileId !== state.activeProfileId) return;
  state.skillIndexDelta = state.skillIndexDelta ? `${state.skillIndexDelta}\n${line}` : line;
}

export function saveSkill(state: Snapshot, draft: Draft) {
  const body = String(draft.body ?? "");
  const front = parseFront(body);
  const slug = sanitizeSlug(String(draft.slug || front?.name || ""));
  if (!slug) return "Skill needs a name.";
  const profileId = String(draft.profileId || state.activeProfileId || "");
  const createdId = `sk-${profileId}-${slug}`;
  const existing = state.skills.find((skill) => skill.id === (draft.id || createdId));
  if (!existing && !state.profiles.some((profile) => profile.id === profileId)) return "Pick a bot profile before saving a skill.";
  const skill: Skill = existing ?? {
    id: createdId,
    slug,
    origin: "profile",
    ownerProfileId: profileId,
    pluginId: "",
    title: slug,
    description: slug,
    slashCommand: `/${slug}`,
    requiresTools: [],
    platforms: ["windows", "macos", "linux"],
    body: "",
    files: [],
    enables: [{ profileId, enabled: true }],
    hiddenReason: "",
    indexLine: "",
    version: "1.0.0",
    updatedAt: Date.now(),
  };
  skill.slug = skill.origin === "plugin" ? skill.slug : slug;
  skill.title = front?.name || String(draft.title || slug);
  skill.description = front?.description || String(draft.description || skill.title);
  skill.slashCommand = front?.slash || String(draft.slashCommand || `/${slug}`);
  skill.requiresTools = front?.tools ?? draft.requiresTools ?? [];
  skill.platforms = front?.platforms ?? draft.platforms ?? skill.platforms;
  skill.body = body;
  if (draft.files) {
    for (const file of draft.files) {
      const path = String(file.path || "").replace(/\\/g, "/");
      if (path.includes("..") || !(path.startsWith("references/") || path.startsWith("scripts/"))) continue;
      const prior = skill.files.find((item) => item.path === path);
      const kind = path.startsWith("scripts/") ? "script" : "reference";
      if (prior) prior.content = file.content;
      else skill.files.push({ path, kind, content: file.content });
    }
  }
  skill.updatedAt = Date.now();
  if (!existing) state.skills.unshift(skill);
  redecorate(state);
  note(state, skill.ownerProfileId || profileId, `Skill index changed: ${skill.slashCommand} was saved.`);
  return "Skill saved. The index updates on the next turn.";
}

export function toggleSkill(state: Snapshot, id: string, profileId: string, enabled: boolean) {
  redecorate(state);
  const skill = state.skills.find((item) => item.id === id);
  if (!skill) return "Skill not found.";
  if (enabled && skill.hiddenReason) return skill.hiddenReason;
  setEnable(skill, profileId, enabled);
  note(state, profileId, `Skill index changed: ${skill.slashCommand} is ${enabled ? "on" : "off"}.`);
  return null;
}

export function removeSkill(state: Snapshot, id: string) {
  const skill = state.skills.find((item) => item.id === id);
  if (!skill) return "Skill not found.";
  if (skill.origin === "plugin") return "Remove the plugin to remove a bundled skill.";
  state.skills = state.skills.filter((item) => item.id !== id);
  note(state, skill.ownerProfileId, `Skill index changed: /${skill.slug} was removed.`);
  return "Skill removed.";
}

export function proposeSkill(state: Snapshot, profileId: string, threadId: string, slug: string, description: string, body: string) {
  const name = sanitizeSlug(slug);
  if (!name || !body.trim()) return "A proposal needs a name and a SKILL.md body.";
  if (!state.profiles.some((profile) => profile.id === profileId)) return "Profile not found.";
  const current = state.skills.find((skill) => skill.origin === "profile" && skill.ownerProfileId === profileId && skill.slug === name);
  const proposal: SkillProposal = {
    id: nid("proposal"),
    profileId,
    threadId,
    slug: name,
    description,
    proposedBody: body,
    currentBody: current?.body ?? "",
    status: "pending",
    createdAt: Date.now(),
  };
  state.skillProposals.unshift(proposal);
  return "Pending approval. The skill file was not written.";
}

export function resolveProposal(state: Snapshot, id: string, approve: boolean) {
  const proposal = state.skillProposals.find((item) => item.id === id);
  if (!proposal || proposal.status !== "pending") return "That proposal is already resolved.";
  proposal.status = approve ? "approved" : "rejected";
  state.skillProposals = state.skillProposals.filter((item) => item.status === "pending");
  if (!approve) return "Proposal rejected.";
  saveSkill(state, { profileId: proposal.profileId, slug: proposal.slug, description: proposal.description, body: proposal.proposedBody });
  return `Wrote /${proposal.slug} for this profile.`;
}

export function savePlugin(state: Snapshot, draft: Partial<PluginPackage> & { skills?: string[] }) {
  const slug = sanitizeSlug(String(draft.slug || draft.name || ""));
  if (!slug) return "Plugin needs a name.";
  const existing = state.plugins.find((plugin) => plugin.id === draft.id);
  const plugin: PluginPackage = existing ?? {
    id: String(draft.id || "").trim() || `plug-${slug}`,
    slug,
    name: slug,
    version: "1.0.0",
    source: "folder",
    sourcePath: `plugins/${slug}`,
    trust: "untrusted",
    hasAgent: false,
    hasDesktop: false,
    tools: [],
    hooks: [],
    bundledSkills: [],
    desktop: [],
    agentEnables: [],
    desktopEnabled: false,
  };
  plugin.slug = slug;
  plugin.name = String(draft.name || slug);
  plugin.version = String(draft.version || plugin.version || "1.0.0");
  const agentBits = Boolean((draft.tools && draft.tools.length) || (draft.hooks && draft.hooks.length) || (draft.bundledSkills && draft.bundledSkills.length) || (draft.skills && draft.skills.length));
  const desktopBits = Boolean(draft.desktop && draft.desktop.length);
  plugin.hasAgent = typeof draft.hasAgent === "boolean" ? draft.hasAgent : agentBits || plugin.hasAgent;
  plugin.hasDesktop = typeof draft.hasDesktop === "boolean" ? draft.hasDesktop : desktopBits || plugin.hasDesktop;
  plugin.tools = draft.tools ?? plugin.tools;
  plugin.hooks = (draft.hooks ?? plugin.hooks).filter((hook) => ["session_start", "before_model_call", "before_tool_call", "after_tool_call", "session_end"].includes(hook));
  plugin.bundledSkills = (draft.bundledSkills ?? draft.skills ?? plugin.bundledSkills).map((skill) => sanitizeSlug(skill)).filter(Boolean);
  plugin.desktop = (draft.desktop ?? plugin.desktop).filter((bit) => bit.kind === "status" || bit.kind === "command" || bit.kind === "pane");
  if (!existing) state.plugins.unshift(plugin);
  for (const name of plugin.bundledSkills) {
    const qualified = `${plugin.slug}:${name}`;
    if (state.skills.some((skill) => skill.slug === qualified)) continue;
    state.skills.push({
      id: `sk-${plugin.id}-${name}`,
      slug: qualified,
      origin: "plugin",
      ownerProfileId: "",
      pluginId: plugin.id,
      title: qualified,
      description: `Bundled by ${plugin.slug}`,
      slashCommand: `/${name}`,
      requiresTools: [],
      platforms: ["windows", "macos", "linux"],
      body: `# ${name}\n\nBundled playbook for ${plugin.slug}.\n`,
      files: [],
      enables: state.profiles.map((profile) => ({ profileId: profile.id, enabled: true })),
      hiddenReason: "",
      indexLine: "",
      version: "1.0.0",
      updatedAt: Date.now(),
    });
  }
  redecorate(state);
  return "Plugin manifest saved. Switches stay off until you enable them.";
}

export function togglePluginAgent(state: Snapshot, id: string, profileId: string, enabled: boolean) {
  const plugin = state.plugins.find((item) => item.id === id);
  if (!plugin) return "Plugin not found.";
  if (enabled && plugin.trust !== "trusted") return "Trust this plugin before enabling it.";
  if (enabled && !plugin.hasAgent) return "This plugin has no agent part.";
  const row = plugin.agentEnables.find((flag) => flag.profileId === profileId);
  if (row) row.enabled = enabled;
  else plugin.agentEnables.push({ profileId, enabled });
  return null;
}

export function togglePluginDesktop(state: Snapshot, id: string, enabled: boolean) {
  const plugin = state.plugins.find((item) => item.id === id);
  if (!plugin) return "Plugin not found.";
  if (enabled && plugin.trust !== "trusted") return "Trust this plugin before enabling it.";
  if (enabled && !plugin.hasDesktop) return "This plugin has no desktop part.";
  plugin.desktopEnabled = enabled;
  return "Desktop switch updated.";
}

export function trustPlugin(state: Snapshot, id: string) {
  const plugin = state.plugins.find((item) => item.id === id);
  if (!plugin) return "Plugin not found.";
  plugin.trust = "trusted";
  return "Plugin trusted. Enable the agent or desktop switch separately.";
}

export function removePlugin(state: Snapshot, id: string) {
  const plugin = state.plugins.find((item) => item.id === id);
  if (!plugin) return "Plugin not found.";
  if (plugin.source === "builtin") return "Prebuilt skills ship with Ronic OS. Turn a skill off instead of removing the set.";
  if (plugin.source === "project") {
    plugin.trust = "untrusted";
    plugin.desktopEnabled = false;
    plugin.agentEnables = plugin.agentEnables.map((flag) => ({ ...flag, enabled: false }));
    return "Project plugin stays on disk. Switches are off until you trust it again.";
  }
  state.plugins = state.plugins.filter((item) => item.id !== id);
  state.skills = state.skills.filter((skill) => skill.pluginId !== id);
  redecorate(state);
  return "Plugin removed from the app index.";
}

export function saveMcp(state: Snapshot, draft: Partial<McpServer> & { tools?: McpServer["declaredTools"]; secret?: string }) {
  const name = String(draft.name || "").trim();
  const slug = sanitizeSlug(name);
  if (!slug) return "MCP server needs a name.";
  const secret = String(draft.secret ?? "").trim();
  const existing = state.mcpServers.find((server) => server.id === draft.id);
  const given = String(draft.id ?? "").trim();
  const server: McpServer = existing ?? {
    id: given || `mcp-${slug}`,
    name,
    transport: "stdio",
    command: "",
    args: [],
    url: "",
    trust: "untrusted",
    declaredTools: [],
    enables: [],
    lastError: "",
  };
  server.name = name;
  server.transport = draft.transport === "sse" ? "sse" : "stdio";
  server.command = String(draft.command ?? server.command);
  server.args = draft.args ?? server.args;
  server.url = String(draft.url ?? server.url);
  server.declaredTools = draft.declaredTools ?? draft.tools ?? server.declaredTools;
  if (!existing) state.mcpServers.unshift(server);
  enableMcpDefaults(state, server);
  if (secret) rememberSecret(`mcp:${server.id}`, secret);
  redecorate(state);
  return secret
    ? "MCP server saved. The key stays in this session. Profile switches default to Active. Turn one off on Capabilities if you want."
    : "MCP server saved. It is not connected until a credential check succeeds. Profile switches default to Active.";
}

function enableMcpDefaults(state: Snapshot, server: McpServer) {
  for (const profile of state.profiles) {
    if (!server.enables.some((flag) => flag.profileId === profile.id)) {
      server.enables.push({ profileId: profile.id, enabled: true });
    }
  }
}

export function toggleMcp(state: Snapshot, id: string, profileId: string, enabled: boolean) {
  const server = state.mcpServers.find((item) => item.id === id);
  if (!server) return "MCP server not found.";
  if (enabled && server.trust !== "trusted") return "Trust this MCP server before enabling it.";
  const row = server.enables.find((flag) => flag.profileId === profileId);
  if (row) row.enabled = enabled;
  else server.enables.push({ profileId, enabled });
  return null;
}

export function trustMcp(state: Snapshot, id: string) {
  const server = state.mcpServers.find((item) => item.id === id);
  if (!server) return "MCP server not found.";
  server.trust = "trusted";
  enableMcpDefaults(state, server);
  redecorate(state);
  return "MCP server trusted. Profile switches default to Active. Turn one off on Capabilities if you want.";
}

export function removeMcp(state: Snapshot, id: string) {
  if (!state.mcpServers.some((server) => server.id === id)) return "MCP server not found.";
  state.mcpServers = state.mcpServers.filter((server) => server.id !== id);
  redecorate(state);
  return "MCP server removed.";
}

export function installCatalog(state: Snapshot, slug: string) {
  const item = state.marketplace.find((entry) => entry.slug === slug);
  if (!item) return "No pack with that name is on this machine.";
  const name = sanitizeSlug(item.slug);
  const body = `---\nname: ${name}\ndescription: ${item.title}\nslash_command: /${name}\nrequires_tools: []\nplatforms: [windows, macos, linux]\n---\n\n# ${item.title}\n\n${item.blurb}\n`;
  const profileId = state.activeProfileId || state.profiles[0]?.id || "";
  if (!state.skills.some((skill) => skill.origin === "catalog" && skill.slug === name)) {
    state.skills.push({
      id: `sk-catalog-${name}`,
      slug: name,
      origin: "catalog",
      ownerProfileId: "",
      pluginId: "",
      title: item.title,
      description: item.title,
      slashCommand: `/${name}`,
      requiresTools: [],
      platforms: ["windows", "macos", "linux"],
      body,
      files: [],
      enables: [],
      hiddenReason: "",
      indexLine: "",
      version: "1.0.0",
      updatedAt: Date.now(),
    });
  }
  item.installed = true;
  if (!profileId) {
    redecorate(state);
    return "Catalog skill saved. Create a bot profile to enable it.";
  }
  saveSkill(state, { profileId, slug: name, body });
  return "Installed into the selected profile.";
}

export async function installSkillFromUrl(state: Snapshot, url: string) {
  try {
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return "Skill URLs must be https, or localhost http.";
    }
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.username || parsed.password || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local))) {
      return "Skill URLs must be https, or localhost http.";
    }
    const response = await fetch(parsed.toString());
    if (!response.ok) return `Failed to fetch skill from ${url}: ${response.statusText}`;
    const content = await response.text();
    if (content.length > 200_000) return "That skill file is too large.";
    const front = parseFront(content);
    const slug = sanitizeSlug(front?.name || "imported-skill");
    const profileId = state.activeProfileId || state.profiles[0]?.id || "";
    if (!profileId) return "Create a bot profile before installing a skill.";
    
    const result = saveSkill(state, { profileId, slug, body: content });
    redecorate(state);
    return result || `Skill "${slug}" installed from URL.`;
  } catch (error) {
    return `Error installing skill from URL: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function installSkillFromMarket(state: Snapshot, slug: string) {
  const item = state.marketplace.find((entry) => entry.slug === slug);
  if (!item) return "No skill with that slug in the marketplace.";
  return installCatalog(state, slug);
}

export function installPlugin(state: Snapshot, source: string) {
  // For now, install from included catalog or marketplace
  const item = [...state.marketplace].find((entry) => entry.slug === source || entry.title === source);
  if (item) {
    // If it's a plugin pack, install it
    const profileId = state.activeProfileId || state.profiles[0]?.id || "";
    if (!profileId) return "Create a bot profile before installing a plugin.";
    return installCatalog(state, item.slug);
  }
  return `Plugin "${source}" not found in marketplace. Use the Marketplace screen to install plugins.`;
}

export function installMcp(state: Snapshot, name: string) {
  // Check if it's in the included catalog
  const item = INCLUDED.find((entry) => entry.name.toLowerCase() === name.toLowerCase() || entry.id === name);
  if (item && item.kind === "mcp") {
    const result = saveMcp(state, {
      id: item.id,
      name: item.name,
      transport: item.transport,
      command: item.command,
      args: item.args,
      url: item.url,
    });
    return result;
  }
  return `MCP server "${name}" not found in included catalog. Use the Marketplace screen to add MCP servers.`;
}

export function connectMcp(state: Snapshot, name: string, secret = "") {
  const server = state.mcpServers.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.id === name);
  if (!server) return `MCP server "${name}" not found. Install it first with /install mcp <name>.`;
  const endpoint = server.url.trim();
  const remote = endpoint.startsWith("http://") || endpoint.startsWith("https://") || server.transport === "sse";
  if (remote && !secret.trim()) {
    return "An empty form is not a connection. Add a credential and run the provider check.";
  }
  server.trust = "trusted";
  enableMcpDefaults(state, server);
  if (secret.trim()) rememberSecret(`mcp:${server.id}`, secret.trim());
  redecorate(state);
  return secret.trim()
    ? `MCP server "${server.name}" is trusted. Profile switches default to Active. The credential stays in this session. The browser preview did not call the provider.`
    : `MCP server "${server.name}" is trusted. Profile switches default to Active. No credential was stored.`;
}
