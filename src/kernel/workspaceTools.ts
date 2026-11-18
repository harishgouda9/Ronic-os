import type { SkillProposal } from "../types";
import { sanitizeSlug } from "./skillIndex";

export type MemoryRow = { id: string; title: string; content: string; relations?: { relation: string; target: string }[] };

export type CuratedEntry = { id: string; store: string; content: string };

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
  curated: CuratedEntry[];
  skills: BagSkill[];
  providers: { name: string; health: string }[];
  threads: { title: string }[];
  proposals: SkillProposal[];
  profileId: string;
  delta: string;
};

const TOOLS = new Set(["list_memory", "search_memory", "save_memory", "curate_memory", "update_memory_graph", "list_skills", "list_providers", "list_threads", "list_mcp", "list_plugins", "load_skill", "load_skill_file", "skill_manage", "install_skill", "install_plugin", "connect_mcp", "workspace_webapp", "desktop_app"]);
const DESKTOP_TOOLS = new Set(["read_file", "list_files", "propose_diff", "sandbox_command", "inspect_page", "workspace_webapp", "desktop_app"]);

function curatedLimit(store: string) {
  if (store === "user") return 1375;
  if (store === "memory") return 2200;
  if (store.startsWith("bot:")) return 1800;
  return 0;
}

function curatedBlock(entries: CuratedEntry[] | undefined, botId: string) {
  const rows = entries ?? [];
  const line = (store: string, label: string, limit: number) => {
    const mine = rows.filter((item) => item.store === store);
    const used = mine.reduce((sum, item) => sum + [...item.content].length, 0);
    const body = mine.length ? mine.map((item) => `- ${item.content}`).join("\n") : "(none)";
    return `${label} [${used}/${limit}]:\n${body}`;
  };
  return [
    "Always-on notes. curate_memory adds one short fact. A write over the cap is refused.",
    line("user", "User", 1375),
    line("memory", "Environment", 2200),
    line(botId ? `bot:${botId}` : "bot:", "This bot", 1800),
  ].join("\n");
}

export function applyCurate(
  entries: CuratedEntry[],
  target: string,
  action: string,
  oldText: string,
  content: string,
  botId: string,
  nextId: () => string,
): { ok: boolean; entries: CuratedEntry[]; message: string } {
  const verb = action.trim().toLowerCase();
  const act = verb === "patch" ? "replace" : verb;
  const key = target.trim().toLowerCase();
  const store = key === "user" || key === "memory" ? key : key === "bot" ? (botId.trim() ? `bot:${botId.trim()}` : "") : "";
  if (!store) return { ok: false, entries, message: "target is user, memory, or bot." };
  if (act !== "add" && act !== "replace" && act !== "remove") return { ok: false, entries, message: "action is add, replace, or remove." };
  const fact = content.trim();
  const needle = oldText.trim();
  if (fact.includes("\n") || fact.includes("\r") || needle.includes("\n") || needle.includes("\r")) {
    return { ok: false, entries, message: "Keep a curated fact on one line." };
  }
  const limit = curatedLimit(store);
  const mine = entries.filter((item) => item.store === store);
  const rest = entries.filter((item) => item.store !== store);
  const used = mine.reduce((sum, item) => sum + [...item.content].length, 0);
  const label = store === "user" ? "user" : store === "memory" ? "environment" : "bot";
  if (act === "add") {
    if (!fact) return { ok: false, entries, message: "curate_memory add needs content." };
    if ([...fact].length > limit) return { ok: false, entries, message: `That fact is over the ${limit} character cap. Shorten it.` };
    if (mine.some((item) => item.content === fact)) return { ok: false, entries, message: `Refused. That fact is already in ${label}.` };
    if (used + [...fact].length > limit) return { ok: false, entries, message: `Refused. ${label} would pass ${limit} characters. Shorten or remove a fact first.` };
    return { ok: true, entries: [...rest, ...mine, { id: nextId(), store, content: fact }], message: `Added one ${label} fact.` };
  }
  const hits = mine.map((item, index) => (needle && item.content.includes(needle) ? index : -1)).filter((index) => index >= 0);
  if (!needle || hits.length !== 1) return { ok: false, entries, message: `Refused. That text matched ${needle ? hits.length : 0} facts. Pass a longer unique piece.` };
  const idx = hits[0];
  if (act === "remove") {
    return { ok: true, entries: [...rest, ...mine.filter((_, index) => index !== idx)], message: `Removed one ${label} fact.` };
  }
  if (!fact) return { ok: false, entries, message: "replace needs the new content." };
  const nextBody = mine[idx].content.replace(needle, fact).trim();
  if (!nextBody) return { ok: false, entries, message: "replace would leave an empty fact. Use remove." };
  if (mine.some((item, index) => index !== idx && item.content === nextBody)) return { ok: false, entries, message: `Refused. That text is already in ${label}.` };
  const nextUsed = used - [...mine[idx].content].length + [...nextBody].length;
  if (nextUsed > limit) return { ok: false, entries, message: `Refused. ${label} would pass ${limit} characters. Shorten the fact first.` };
  const nextMine = mine.map((item, index) => (index === idx ? { ...item, content: nextBody } : item));
  return { ok: true, entries: [...rest, ...nextMine], message: `Updated one ${label} fact.` };
}

export function workspaceSystem(bag: ToolBag, userPrompt = "") {
  const memory = bag.memories.slice(0, 12).map((item) => `### ${item.title}\n${item.content.slice(0, 600)}`).join("\n\n") || "None saved.";
  const index = bag.skills.filter((item) => item.inIndex).map((item) => item.indexLine).join("\n") || "none";
  const providers = bag.providers.map((item) => `${item.name}: ${item.health}`).join("\n") || "none";
  const threads = bag.threads.slice(0, 8).map((item) => item.title).join(", ") || "none";
  const token = userPrompt.trim().split(/\s+/)[0] ?? "";
  const playbook = token.startsWith("/") ? bag.skills.find((item) => item.inIndex && (item.slash === token || `/${item.slug}` === token)) : undefined;
  const lines = [
    "You are running inside Ronic OS to do the task, not to talk about doing it. Call a tool in this turn when the task needs one. After each tool result, continue until the task is finished or a tool refuses it. Report only what a tool returned. Do not claim you moved money, edited a file, ran a command, opened a page, or checked a service unless a tool card says so.",
    "Context injection is on every tool, not only Slack: file tools, browser tools (inspect, read, click, type, scroll), and workspace webapps. The bot terminal is that bot's own workspace and cannot open the project folder. Read the project with list_files (empty path is the project folder) and read_file (a project-relative path such as supabase/schema.sql). A login on any site is a shared page session. Do not ask the user to attach the project folder, and do not paste the workspace pack into a team message or an email.",
    "Expert craft (highest priority): answer like a senior specialist in the user's domain. Think and plan before building: state a short plan (2-4 bullets) for any multi-step build, then execute it step by step. Ask at most one targeted clarifying question when the request is genuinely ambiguous; otherwise act on the most reasonable interpretation and say which one. Stay strictly on the user's actual request — no tangents, no generic filler, no restating the question back. If you do not know a fact, say so in one line instead of guessing. Match the user's vocabulary: mirror the concrete nouns and tool names they used. For funnels, workflows, and builds, name real platforms, real fields, and real next actions — never vague placeholders like \"integrate with your CRM\"; say which CRM fields map where. When you produce a plan, it must be concrete enough that the user could hand it to a contractor unchanged.",
    "When the user asks you to remember a fact, call save_memory for a vault note. The same title updates that note and keeps its vault, file, scope, and graph links. The save rewrites a structured markdown sheet. Edit with save_memory or curate_memory, not by rewriting the file. Call curate_memory for a short fact that must be in every turn. target is user, memory, or bot. A write over the cap is refused. Call update_memory_graph to add or remove one link without rewriting the note.",
    "Skills, Plugins & MCP: You can download and install any skill or playbook directly (from GitHub, URL, or catalog) using install_skill, install any plugin from GitHub or repo using install_plugin, and connect any MCP server using connect_mcp. Call these immediately on your own whenever the user asks to add, install, or download skills, plugins, or MCP servers.\nWorkspace Webapps & Desktop apps: You HAVE direct access and auto-control over both in-workspace web apps (ChatGPT, Claude, Gemini, etc. running right beside you in the workspace stage) via workspace_webapp (and inspect_page/read_page with target 'workspace'), and native desktop apps (VS Code, Cursor, Claude Code, Obsidian, Ollama, etc.) via desktop_app. Never tell the user you are in an isolated profile that cannot see the user's workspace webapps beside you.\nAction-First Principle: When the user asks you to check, test, access, open, or control an app, skill, plugin, or server (e.g. 'can you access desktop webapp', 'check if you can reach ChatGPT', 'open chatgpt', 'are you working'), DO NOT merely answer 'Yes I can, let me check...' or output thinking tags and stop. You MUST IMMEDIATELY invoke the appropriate tool (e.g. workspace_webapp, desktop_app, inspect_page, etc.) in the very first turn so real actions and results happen automatically.",
    "If your API cannot call tools and a tool is required, reply with only a markdown fence tagged ronic-tool. The fence body is one JSON object with a tool field.",
    "",
    "Skill index:",
    index,
  ];
  if (bag.delta.trim()) lines.push("", bag.delta.trim());
  if (playbook) lines.push("", "Skill playbook for this turn:", playbook.body);
  lines.push("", curatedBlock(bag.curated, bag.profileId), "", "Memory already in this workspace:", memory, "", "Providers:", providers, `Tasks: ${threads}`);
  return lines.join("\n");
}

function yamlValue(value: string): string {
  const flat = value.replace(/[\n\r]/g, " ");
  const plain = flat.length > 0 && !flat.startsWith(" ") && !flat.endsWith(" ") && !/[:#"']/.test(flat);
  return plain ? flat : `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sheetCard(item: MemoryRow): string {
  const chars = [...item.content];
  const body = (chars.length <= 180 ? item.content : `${chars.slice(0, 180).join("")}…`).trim();
  return `---\nid: ${yamlValue(item.id)}\ntitle: ${yamlValue(item.title)}\nscope: workspace\n---\n${body}`;
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
    return bag.memories.map((item) => sheetCard(item)).join("\n\n");
  }
  if (name === "search_memory") {
    const query = String(args.query ?? "").trim().toLowerCase();
    if (!query) return "A search needs a query.";
    const hits = bag.memories.filter((item) => `${item.title}\n${item.content}`.toLowerCase().includes(query));
    if (!hits.length) return `No memory matches "${query}".`;
    return hits.map((item) => sheetCard(item)).join("\n\n");
  }
  if (name === "save_memory") {
    const title = String(args.title ?? "").trim();
    const content = String(args.content ?? args.contentMarkdown ?? "").trim();
    const id = String(args.id ?? "").trim();
    if (!title || !content) return "save_memory needs a title and content.";
    const existing = id
      ? bag.memories.find((item) => item.id === id)
      : bag.memories.find((item) => item.title.toLowerCase() === title.toLowerCase());
    if (id && !existing) return "That memory was not found.";
    if (existing) {
      existing.title = title;
      existing.content = content;
      return `Updated memory "${title}". The vault, scope, and graph links were left in place.`;
    }
    bag.memories.unshift({ id: nextId(), title, content, relations: [] });
    return `Saved memory "${title}". It is on the Memory screen.`;
  }
  if (name === "curate_memory") {
    const result = applyCurate(
      bag.curated,
      String(args.target ?? args.store ?? ""),
      String(args.action ?? args.op ?? ""),
      String(args.oldText ?? args.old_text ?? ""),
      String(args.content ?? args.fact ?? ""),
      bag.profileId,
      nextId,
    );
    if (result.ok) bag.curated = result.entries;
    return result.message;
  }
  if (name === "update_memory_graph") {
    const title = String(args.title ?? "").trim();
    const id = String(args.id ?? "").trim();
    const target = String(args.target ?? "").trim();
    const relation = String(args.relation ?? "RELATES").trim() || "RELATES";
    const remove = args.remove === true || args.remove === "true" || args.remove === "1";
    if (!target || (!title && !id)) return "update_memory_graph needs a title or id, and a target.";
    const note = id
      ? bag.memories.find((item) => item.id === id)
      : bag.memories.find((item) => item.title.toLowerCase() === title.toLowerCase());
    if (!note) return "That memory was not found.";
    const relations = note.relations ?? [];
    const index = relations.findIndex((edge) => edge.target.toLowerCase() === target.toLowerCase());
    if (remove) {
      if (index < 0) return "That graph link was not found.";
      relations.splice(index, 1);
      note.relations = relations;
      return `Removed the link to "${target}". The note text was not changed.`;
    }
    if (relations.length >= 40 && index < 0) return "This note already has 40 graph links. Remove one before adding another.";
    if (index >= 0) relations[index] = { relation, target };
    else relations.push({ relation, target });
    note.relations = relations;
    return `Linked "${note.title}" to "${target}" (${relation}). The note text was not changed.`;
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
    const serverName = String(args.name ?? args.server ?? "").trim() || "MCP server";
    return `Opened the authentication & connection card for "${serverName}" directly in chat. Ask the user to complete authentication in the card below — never ask them to paste secrets in chat messages.`;
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
