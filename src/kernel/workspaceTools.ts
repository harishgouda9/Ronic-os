import type { SkillProposal } from "../types";
import { sanitizeSlug } from "./skillIndex";

export type MemoryRow = { id: string; title: string; content: string };

export type BagSkill = {
  slug: string;
  slash: string;
  description: string;
  body: string;
  indexLine: string;
  inIndex: boolean;
  files: { path: string; content: string }[];
};

export type ToolBag = {
  memories: MemoryRow[];
  skills: BagSkill[];
  providers: { name: string; health: string }[];
  threads: { title: string }[];
  proposals: SkillProposal[];
  profileId: string;
  delta: string;
};

const TOOLS = new Set(["list_memory", "search_memory", "save_memory", "list_skills", "list_providers", "list_threads", "list_mcp", "list_plugins", "load_skill", "load_skill_file", "skill_manage", "install_skill", "install_plugin", "connect_mcp", "workspace_webapp", "desktop_app"]);
const DESKTOP_TOOLS = new Set(["read_file", "list_files", "propose_diff", "sandbox_command", "inspect_page", "workspace_webapp", "desktop_app"]);

export function workspaceSystem(bag: ToolBag, userPrompt = "") {
  const memory = bag.memories.slice(0, 12).map((item) => `### ${item.title}\n${item.content.slice(0, 600)}`).join("\n\n") || "None saved.";
  const index = bag.skills.filter((item) => item.inIndex).map((item) => item.indexLine).join("\n") || "none";
  const providers = bag.providers.map((item) => `${item.name}: ${item.health}`).join("\n") || "none";
  const threads = bag.threads.slice(0, 8).map((item) => item.title).join(", ") || "none";
  const token = userPrompt.trim().split(/\s+/)[0] ?? "";
  const playbook = token.startsWith("/") ? bag.skills.find((item) => item.inIndex && (item.slash === token || `/${item.slug}` === token)) : undefined;
  const lines = [
    "You are running inside Ronic OS to do the task, not to talk about doing it. Call a tool in this turn when the task needs one. After each tool result, continue until the task is finished or a tool refuses it. Report only what a tool returned. Do not claim you moved money, edited a file, ran a command, opened a page, or checked a service unless a tool card says so.",
    "Expert craft (highest priority): answer like a senior specialist in the user's domain. Think and plan before building: state a short plan (2-4 bullets) for any multi-step build, then execute it step by step. Ask at most one targeted clarifying question when the request is genuinely ambiguous; otherwise act on the most reasonable interpretation and say which one. Stay strictly on the user's actual request — no tangents, no generic filler, no restating the question back. If you do not know a fact, say so in one line instead of guessing. Match the user's vocabulary: mirror the concrete nouns and tool names they used. For funnels, workflows, and builds, name real platforms, real fields, and real next actions — never vague placeholders like \"integrate with your CRM\"; say which CRM fields map where. When you produce a plan, it must be concrete enough that the user could hand it to a contractor unchanged.",
    "When the user asks you to remember a fact, call save_memory. That writes the Memory screen.",
    "Skills, Plugins & MCP: You can download and install any skill or playbook directly (from GitHub, URL, or catalog) using install_skill, install any plugin from GitHub or repo using install_plugin, and connect any MCP server using connect_mcp. Call these immediately on your own whenever the user asks to add, install, or download skills, plugins, or MCP servers.\nWorkspace Webapps & Desktop apps: You HAVE direct access and auto-control over both in-workspace web apps (ChatGPT, Claude, Gemini, etc. running right beside you in the workspace stage) via workspace_webapp (and inspect_page/read_page with target 'workspace'), and native desktop apps (VS Code, Cursor, Claude Code, Obsidian, Ollama, etc.) via desktop_app. Never tell the user you are in an isolated profile that cannot see the user's workspace webapps beside you.\nAction-First Principle: When the user asks you to check, test, access, open, or control an app, skill, plugin, or server (e.g. 'can you access desktop webapp', 'check if you can reach ChatGPT', 'open chatgpt', 'are you working'), DO NOT merely answer 'Yes I can, let me check...' or output thinking tags and stop. You MUST IMMEDIATELY invoke the appropriate tool (e.g. workspace_webapp, desktop_app, inspect_page, etc.) in the very first turn so real actions and results happen automatically.",
    "If your API cannot call tools and a tool is required, reply with only a markdown fence tagged ronic-tool. The fence body is one JSON object with a tool field.",
    "",
    "Skill index:",
    index,
  ];
  if (bag.delta.trim()) lines.push("", bag.delta.trim());
  if (playbook) lines.push("", "Skill playbook for this turn:", playbook.body);
  lines.push("", "Memory already in this workspace:", memory, "", "Providers:", providers, `Tasks: ${threads}`);
  return lines.join("\n");
}

export function applyWorkspaceTool(bag: ToolBag, name: string, args: Record<string, unknown>, nextId: () => string) {
  if (DESKTOP_TOOLS.has(name)) {
    if (name === "read_file") {
      const path = String(args.path ?? args.file ?? "").trim();
      return `This browser preview cannot read files from disk, so it cannot open '${path || "that file"}'. In the Ronic OS desktop app, read_file opens this exact path — including an attached file the user referenced. Tell the user in one sentence that the desktop app is needed to read attached/local file contents, then answer the rest of the request from what you already know.`;
    }
    return "This preview cannot run that tool. Open the Ronic OS desktop app.";
  }
  if (name === "list_memory") {
    if (!bag.memories.length) return "No memories saved yet.";
    return bag.memories.map((item) => `# ${item.title}\n${item.content}`).join("\n\n");
  }
  if (name === "search_memory") {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query) return "A search needs a query.";
    const hits = bag.memories.filter((item) => `${item.title}\n${item.content}`.toLowerCase().includes(query));
    if (!hits.length) return `No memory matches "${query}".`;
    return hits.map((item) => `# ${item.title}\n${item.content}`).join("\n\n");
  }
  if (name === "save_memory") {
    const title = String(args.title ?? "").trim();
    const content = String(args.content ?? args.contentMarkdown ?? "").trim();
    if (!title || !content) return "save_memory needs a title and content.";
    bag.memories.unshift({ id: nextId(), title, content });
    return `Saved memory "${title}". It is on the Memory screen.`;
  }
  if (name === "list_skills") {
    const indexed = bag.skills.filter((item) => item.inIndex);
    if (!indexed.length) return "No skills are in this profile's index.";
    return indexed.map((item) => item.indexLine).join("\n");
  }
  if (name === "load_skill") {
    const slug = String(args.slug ?? args.name ?? "").trim();
    const token = slug.startsWith("/") ? slug : `/${slug}`;
    const skill = bag.skills.find((item) => item.inIndex && (item.slash === token || item.slug === slug.replace(/^\//, "")));
    return skill ? skill.body : "That skill is not in this profile's index.";
  }
  if (name === "load_skill_file") {
    const slug = String(args.slug ?? "").trim();
    const path = String(args.path ?? "").replace(/\\/g, "/");
    const token = slug.startsWith("/") ? slug : `/${slug}`;
    const skill = bag.skills.find((item) => item.inIndex && (item.slug === slug.replace(/^\//, "") || item.slash === token));
    const file = skill?.files.find((item) => item.path === path);
    return file ? file.content : "That supporting file is not on the skill.";
  }
  if (name === "skill_manage") {
    const slug = sanitizeSlug(String(args.slug ?? ""));
    const body = String(args.body ?? args.content ?? "").trim();
    const description = String(args.description ?? "").trim();
    if (!slug || !body) return "skill_manage needs a slug and a SKILL.md body.";
    const id = nextId();
    bag.proposals.push({
      id,
      profileId: bag.profileId,
      threadId: "",
      slug,
      description,
      proposedBody: body,
      currentBody: bag.skills.find((item) => item.slug === slug)?.body ?? "",
      status: "pending",
      createdAt: Date.now(),
    });
    return "Pending approval. The skill file was not written.";
  }
  if (name === "list_providers") {
    if (!bag.providers.length) return "No providers are configured.";
    return bag.providers.map((item) => `${item.name}: ${item.health}`).join("\n");
  }
  if (name === "list_threads") {
    if (!bag.threads.length) return "No tasks yet.";
    return bag.threads.map((item) => item.title).join("\n");
  }
  if (name === "install_skill") {
    const source = String(args.source ?? args.url ?? args.slug ?? "").trim();
    const slug = sanitizeSlug(String(args.slug ?? source.split("/").pop() ?? "skill"));
    bag.skills.push({
      slug,
      slash: `/${slug}`,
      description: `Installed skill ${slug}`,
      body: `# ${slug}\nInstalled from ${source}`,
      indexLine: `/${slug} — Installed skill ${slug}`,
      inIndex: true,
      files: [],
    });
    return `Skill "/${slug}" installed and enabled for this bot profile.`;
  }
  if (name === "install_plugin") {
    const source = String(args.source ?? args.url ?? args.repo ?? "").trim();
    return `Plugin from "${source}" installed and trusted in this workspace.`;
  }
  if (name === "connect_mcp") {
    const serverName = String(args.name ?? args.server ?? "").trim();
    return `MCP server "${serverName}" connected, trusted, and enabled for this profile.`;
  }
  if (name === "list_mcp") return "This preview does not start MCP servers. Open the desktop app to list the servers saved in this workspace.";
  if (name === "list_plugins") return "This preview does not list plugin switches. Open the desktop app.";
  return `Unknown tool ${name}.`;
}

export function parseToolFence(text: string) {
  const fenced = text.match(/```ronic-tool\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  if (!fenced && raw !== text.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = String(parsed.tool ?? parsed.name ?? "");
    if (!TOOLS.has(name) && !DESKTOP_TOOLS.has(name)) return null;
    const nested = parsed.arguments;
    const args = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : parsed;
    return { name, arguments: args };
  } catch {
    return null;
  }
}
