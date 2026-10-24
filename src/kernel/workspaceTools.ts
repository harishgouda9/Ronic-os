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

const TOOLS = new Set(["list_memory", "search_memory", "save_memory", "list_skills", "list_providers", "list_threads", "list_mcp", "list_plugins", "load_skill", "load_skill_file", "skill_manage"]);
const DESKTOP_TOOLS = new Set(["read_file", "list_files", "propose_diff", "sandbox_command", "inspect_page"]);

export function workspaceSystem(bag: ToolBag, userPrompt = "") {
  const memory = bag.memories.slice(0, 12).map((item) => `### ${item.title}\n${item.content.slice(0, 600)}`).join("\n\n") || "None saved.";
  const index = bag.skills.filter((item) => item.inIndex).map((item) => item.indexLine).join("\n") || "none";
  const providers = bag.providers.map((item) => `${item.name}: ${item.health}`).join("\n") || "none";
  const threads = bag.threads.slice(0, 8).map((item) => item.title).join(", ") || "none";
  const token = userPrompt.trim().split(/\s+/)[0] ?? "";
  const playbook = token.startsWith("/") ? bag.skills.find((item) => item.inIndex && (item.slash === token || `/${item.slug}` === token)) : undefined;
  const lines = [
    "You are running inside Ronic OS to do the task, not to talk about doing it. Call a tool in this turn when the task needs one. After each tool result, continue until the task is finished or a tool refuses it. Report only what a tool returned. Do not claim you moved money, edited a file, ran a command, opened a page, or checked a service unless a tool card says so.",
    "When the user asks you to remember a fact, call save_memory. That writes the Memory screen.",
    "Skills are instructions. Call load_skill or load_skill_file for a playbook that is not already in this turn. skill_manage proposes a skill and waits for approval. list_mcp lists saved MCP servers and does not start them. list_plugins lists plugins for this bot.",
    "If your API cannot call tools and a tool is required, reply with only a markdown fence tagged omni-tool. The fence body is one JSON object with a tool field.",
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
  if (DESKTOP_TOOLS.has(name)) return "This preview cannot run that tool. Open the desktop app.";
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
  if (name === "list_mcp") return "This preview does not start MCP servers. Open the desktop app to list the servers saved in this workspace.";
  if (name === "list_plugins") return "This preview does not list plugin switches. Open the desktop app.";
  return `Unknown tool ${name}.`;
}

export function parseToolFence(text: string) {
  const fenced = text.match(/```omni-tool\s*([\s\S]*?)```/);
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
