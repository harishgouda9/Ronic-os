export type Effort = "default" | "high" | "max" | "xhigh";

export type ChatModel = {
  id: string;
  label: string;
  providerId: string;
  kind: "openai" | "anthropic" | "gemini" | "ollama" | "bedrock" | "moa";
  /** Browser preview calls this same-origin proxy. The desktop shell calls the provider directly. */
  previewBase: string;
  upstreamModel: string;
  group: string;
  reasoning?: boolean;
  custom?: boolean;
};

export type WebApp = {
  id: string;
  name: string;
  url: string;
  mark: string;
  providerId: string;
  path?: string;
  custom?: boolean;
};

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
};

export type Completion = { text: string; thinking: string; toolCalls: ToolCall[]; ms: number; providerId: string };

export type RouteAuth = "bearer" | "anthropic" | "gemini" | "none" | "custom";

/** How to call a provider. This is not a model list. Models come from the provider after a key is stored. */
export type ProviderRoute = {
  providerId: string;
  name: string;
  kind: ChatModel["kind"];
  previewBase: string;
  group: string;
  listUrl: string;
  auth: RouteAuth;
};

export const PROVIDER_ROUTES: ProviderRoute[] = [
  { providerId: "prov_chatgpt", name: "ChatGPT", kind: "openai", previewBase: "/proxy/openai/v1", group: "ChatGPT", listUrl: "/proxy/openai/v1/models", auth: "bearer" },
  { providerId: "prov_anthropic", name: "Anthropic", kind: "anthropic", previewBase: "/proxy/anthropic", group: "Claude", listUrl: "/proxy/anthropic/v1/models", auth: "anthropic" },
  { providerId: "prov_claude", name: "Claude", kind: "anthropic", previewBase: "/proxy/anthropic", group: "Claude", listUrl: "/proxy/anthropic/v1/models", auth: "anthropic" },
  { providerId: "prov_gemini", name: "Gemini", kind: "gemini", previewBase: "/proxy/gemini/v1beta", group: "Gemini", listUrl: "/proxy/gemini/v1beta/models", auth: "gemini" },
  { providerId: "prov_grok", name: "Grok", kind: "openai", previewBase: "/proxy/xai/v1", group: "Grok", listUrl: "/proxy/xai/v1/models", auth: "bearer" },
  { providerId: "prov_mistral", name: "Mistral", kind: "openai", previewBase: "/proxy/mistral/v1", group: "Mistral", listUrl: "/proxy/mistral/v1/models", auth: "bearer" },
  { providerId: "prov_perplexity", name: "Perplexity", kind: "openai", previewBase: "/proxy/perplexity", group: "Perplexity", listUrl: "/proxy/perplexity/models", auth: "bearer" },
  { providerId: "prov_groq", name: "Groq", kind: "openai", previewBase: "/proxy/groq/openai/v1", group: "Groq", listUrl: "/proxy/groq/openai/v1/models", auth: "bearer" },
  { providerId: "prov_together", name: "Together", kind: "openai", previewBase: "/proxy/together/v1", group: "Together", listUrl: "/proxy/together/v1/models", auth: "bearer" },
  { providerId: "prov_cohere", name: "Cohere", kind: "openai", previewBase: "/proxy/cohere/compatibility/v1", group: "Cohere", listUrl: "/proxy/cohere/compatibility/v1/models", auth: "bearer" },
  { providerId: "prov_openrouter", name: "OpenRouter", kind: "openai", previewBase: "/proxy/openrouter/api/v1", group: "OpenRouter", listUrl: "/proxy/openrouter/api/v1/models", auth: "bearer" },
  { providerId: "prov_deepseek", name: "DeepSeek", kind: "openai", previewBase: "/proxy/deepseek/v1", group: "DeepSeek", listUrl: "/proxy/deepseek/v1/models", auth: "bearer" },
  { providerId: "prov_qwen", name: "Qwen", kind: "openai", previewBase: "/proxy/qwen/compatible-mode/v1", group: "Qwen", listUrl: "/proxy/qwen/compatible-mode/v1/models", auth: "bearer" },
  { providerId: "prov_tokenrouter", name: "TokenRouter", kind: "openai", previewBase: "/proxy/tokenrouter/v1", group: "TokenRouter", listUrl: "/proxy/tokenrouter/v1/models", auth: "bearer" },
  { providerId: "prov_bedrock", name: "Bedrock", kind: "bedrock", previewBase: "/proxy/bedrock", group: "Bedrock", listUrl: "", auth: "custom" },
  { providerId: "prov_nvidia", name: "NVIDIA", kind: "openai", previewBase: "/proxy/nvidia/v1", group: "NVIDIA NIM", listUrl: "/proxy/nvidia/v1/models", auth: "bearer" },
  { providerId: "prov_ollama", name: "Ollama", kind: "ollama", previewBase: "/proxy/ollama", group: "Ollama", listUrl: "/proxy/ollama/api/tags", auth: "none" },
];

export const WEB_APPS: WebApp[] = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com", mark: "CH", providerId: "prov_chatgpt" },
  { id: "claude", name: "Claude", url: "https://claude.ai", mark: "CL", providerId: "prov_anthropic" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com", mark: "GE", providerId: "prov_gemini" },
  { id: "grok", name: "Grok", url: "https://grok.com", mark: "GR", providerId: "prov_grok" },
  { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/keys", mark: "OR", providerId: "prov_openrouter" },
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com", mark: "DS", providerId: "prov_deepseek" },
  { id: "qwen", name: "Qwen", url: "https://chat.qwen.ai", mark: "QW", providerId: "prov_qwen" },
  { id: "tokenrouter", name: "TokenRouter", url: "https://tokenrouter.io", mark: "TR", providerId: "prov_tokenrouter" },
  { id: "bedrock", name: "Bedrock", url: "https://console.aws.amazon.com/bedrock", mark: "BR", providerId: "prov_bedrock" },
  { id: "nvidia", name: "NVIDIA", url: "https://build.nvidia.com", mark: "NV", providerId: "prov_nvidia" },
  { id: "meta", name: "Meta AI", url: "https://meta.ai", mark: "ME", providerId: "" },
  { id: "mistral", name: "Mistral", url: "https://chat.mistral.ai", mark: "MI", providerId: "prov_mistral" },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai", mark: "PX", providerId: "prov_perplexity" },
  { id: "groq", name: "Groq", url: "https://console.groq.com/keys", mark: "GQ", providerId: "prov_groq" },
  { id: "together", name: "Together", url: "https://api.together.ai/settings/api-keys", mark: "TG", providerId: "prov_together" },
  { id: "cohere", name: "Cohere", url: "https://dashboard.cohere.com/api-keys", mark: "CO", providerId: "prov_cohere" },
  { id: "copilot", name: "Copilot", url: "https://copilot.microsoft.com", mark: "CP", providerId: "" },
];

export type ProviderConnect = "chatgpt" | "key" | "site" | "local";

export type ChatProviderLink = {
  id: string;
  name: string;
  group: string;
  siteId: string;
  detail: string;
  siteOnly: boolean;
  local: boolean;
  ready: boolean;
  connect: ProviderConnect;
  keyUrl: string;
};

const LINK_DETAIL: Record<string, string> = {
  prov_chatgpt: "Continue with ChatGPT connects a Plus, Pro, or other eligible plan to this chat. A chatgpt.com window does not. An OpenAI API key also works.",
  prov_anthropic: "A claude.ai sign-in stays in that browser. Paste an Anthropic API key to use Claude here. Max and Team plans can create that key in the Claude console.",
  prov_gemini: "A gemini.google.com sign-in stays in that browser. Paste a Google AI key from AI Studio to use Gemini here.",
  prov_grok: "A grok.com sign-in stays in that browser. Paste an xAI API key to use Grok here.",
  prov_mistral: "A chat.mistral.ai sign-in stays in that browser. Paste a Mistral API key to use those models here.",
  prov_perplexity: "A perplexity.ai sign-in stays in that browser. Paste a Perplexity API key to use those models here.",
  prov_groq: "Paste a Groq API key. Models from that account show up in this chat.",
  prov_together: "Paste a Together API key. Models from that account show up in this chat.",
  prov_cohere: "Paste a Cohere API key. Models from that account show up in this chat.",
  prov_openrouter: "Paste an OpenRouter key. One key reaches many models in this chat.",
  prov_deepseek: "Paste a DeepSeek API key. A chat.deepseek.com sign-in stays in that browser.",
  prov_qwen: "Paste a DashScope key. A chat.qwen.ai sign-in stays in that browser.",
  prov_tokenrouter: "Paste a TokenRouter key to use those models here.",
  prov_bedrock: "Paste a Bedrock API key, then add the model id. Bedrock does not publish a list.",
  prov_nvidia: "Paste an NVIDIA API key. NIM models show up in this chat.",
  prov_ollama: "Ollama runs on this computer. Models appear when it is running. No key.",
};

const KEY_URL: Record<string, string> = {
  prov_chatgpt: "https://platform.openai.com/api-keys",
  prov_anthropic: "https://console.anthropic.com/settings/keys",
  prov_gemini: "https://aistudio.google.com/apikey",
  prov_grok: "https://console.x.ai",
  prov_mistral: "https://console.mistral.ai/api-keys",
  prov_perplexity: "https://www.perplexity.ai/settings/api",
  prov_groq: "https://console.groq.com/keys",
  prov_together: "https://api.together.ai/settings/api-keys",
  prov_cohere: "https://dashboard.cohere.com/api-keys",
  prov_openrouter: "https://openrouter.ai/keys",
  prov_deepseek: "https://platform.deepseek.com/api_keys",
  prov_qwen: "https://dashscope.console.aliyun.com/apiKey",
  prov_tokenrouter: "https://tokenrouter.io",
  prov_bedrock: "https://console.aws.amazon.com/bedrock",
  prov_nvidia: "https://build.nvidia.com",
};

const SITE_ONLY: ChatProviderLink[] = [
  {
    id: "",
    name: "Meta AI",
    group: "Meta AI",
    siteId: "meta",
    detail: "Meta AI stays on meta.ai. Llama replies in this chat use an NVIDIA, Groq, or Together key.",
    siteOnly: true,
    local: false,
    ready: false,
    connect: "site",
    keyUrl: "",
  },
  {
    id: "",
    name: "Copilot",
    group: "Copilot",
    siteId: "copilot",
    detail: "Microsoft Copilot stays on its site. This chat cannot send through that subscription.",
    siteOnly: true,
    local: false,
    ready: false,
    connect: "site",
    keyUrl: "",
  },
];

/** Providers a bot chat can sign into or unlock with a key. A site login is not an API key. */
export function chatProviderLinks(ready: (id: string) => boolean): ChatProviderLink[] {
  const routed = PROVIDER_ROUTES.filter((route) => route.providerId !== "prov_claude").map((route) => {
    const connect: ProviderConnect = route.providerId === "prov_chatgpt" ? "chatgpt" : route.auth === "none" ? "local" : "key";
    return {
      id: route.providerId,
      name: route.group,
      group: route.group,
      siteId: WEB_APPS.find((app) => app.providerId === route.providerId)?.id ?? "",
      detail: LINK_DETAIL[route.providerId] ?? `Paste an API key to use ${route.name} models in this chat.`,
      siteOnly: false,
      local: route.auth === "none",
      ready: ready(route.providerId),
      connect,
      keyUrl: KEY_URL[route.providerId] ?? "",
    };
  });
  const first = routed.filter((link) => ["ChatGPT", "Claude", "Gemini", "Grok"].includes(link.group));
  const rest = routed.filter((link) => !["ChatGPT", "Claude", "Gemini", "Grok"].includes(link.group));
  return [...first, ...SITE_ONLY, ...rest];
}

export const DOWNLOADS: WebApp[] = [
  { id: "ollama", name: "Ollama", url: "https://ollama.com/download", mark: "OL", providerId: "prov_ollama" },
  { id: "claude-code", name: "Claude Code", url: "https://docs.anthropic.com/en/docs/claude-code/setup", mark: "CC", providerId: "prov_claude" },
  { id: "cursor", name: "Cursor", url: "https://cursor.com/download", mark: "CU", providerId: "" },
  { id: "vscode", name: "VS Code", url: "https://code.visualstudio.com/download", mark: "VS", providerId: "" },
  { id: "obsidian", name: "Obsidian", url: "https://obsidian.md/download", mark: "OB", providerId: "" },
];

const secrets = new Map<string, string>();

const TOOLS = [
  { type: "function", function: { name: "list_memory", description: "List workspace memories.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "search_memory", description: "Search memory titles and body text.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "save_memory", description: "Save a memory onto the Memory screen.", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] } } },
  { type: "function", function: { name: "list_skills", description: "List the skill index for this profile.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "load_skill", description: "Load one SKILL.md playbook for this turn.", parameters: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } } },
  { type: "function", function: { name: "load_skill_file", description: "Load one supporting reference or script as text.", parameters: { type: "object", properties: { slug: { type: "string" }, path: { type: "string" } }, required: ["slug", "path"] } } },
  { type: "function", function: { name: "skill_manage", description: "Propose a SKILL.md. A person approves the write.", parameters: { type: "object", properties: { slug: { type: "string" }, description: { type: "string" }, body: { type: "string" } }, required: ["slug", "body"] } } },
  { type: "function", function: { name: "list_providers", description: "List providers and their status.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "list_threads", description: "List chat tasks.", parameters: { type: "object", properties: {} } } },
];

export function rememberSecret(providerId: string, secret: string) {
  const value = secret.trim();
  if (!providerId || !value) return;
  secrets.set(providerId, value);
  try {
    sessionStorage.setItem(`ronic.secret.${providerId}`, value);
  } catch {
    /* private mode can reject storage; the in-memory copy still serves this page */
  }
}

export function secretFor(providerId: string) {
  const cached = secrets.get(providerId);
  if (cached) return cached;
  try {
    const saved = sessionStorage.getItem(`ronic.secret.${providerId}`) ?? "";
    if (saved) secrets.set(providerId, saved);
    return saved;
  } catch {
    return "";
  }
}

export function hasStoredSecret(providerId: string) {
  return secretFor(providerId).length > 0;
}

export function ollamaModel(name: string): ChatModel {
  return {
    id: `ollama:${name}`,
    label: `Ollama · ${name}`,
    providerId: "prov_ollama",
    kind: "ollama",
    previewBase: "/proxy/ollama",
    upstreamModel: name,
    group: "Ollama",
  };
}

export function routeFor(providerId: string) {
  const found = PROVIDER_ROUTES.find((item) => item.providerId === providerId);
  if (found) return { kind: found.kind, previewBase: found.previewBase, group: found.group, name: found.name };
  return { kind: "openai" as const, previewBase: "/proxy/openai/v1", group: "Custom", name: "Custom" };
}

export function probeModel(providerId: string, label: string): ChatModel | null {
  const route = PROVIDER_ROUTES.find((item) => item.providerId === providerId);
  if (!route) return null;
  return {
    id: `probe:${providerId}`,
    label: label || route.name,
    providerId,
    kind: route.kind,
    previewBase: route.previewBase,
    upstreamModel: "",
    group: route.group,
  };
}

export function openSite(url: string) {
  const next = url.includes("grok.x.ai") ? "https://grok.com" : url.trim();
  const allowed = next.startsWith("https://") || next.startsWith("http://127.0.0.1") || next.startsWith("http://localhost");
  if (!allowed) return "That address is not opened from here.";
  const popup = window.open(next, "_blank", "noopener,noreferrer");
  if (!popup) return "The browser blocked the window. Allow popups for 127.0.0.1, then click Open again.";
  return `Opened ${next}.`;
}

export async function completeChat(model: ChatModel, messages: ChatMessage[], effort: Effort = "default", withTools = true): Promise<Completion> {
  const started = performance.now();
  const result = await dispatch(model, messages, effort, withTools);
  return { ...result, ms: Math.max(1, Math.round(performance.now() - started)) };
}

export async function pingProvider(model: ChatModel) {
  const started = performance.now();
  if (model.kind === "moa") throw new Error("That entry is not a connected model.");
  if (model.kind === "ollama") {
    const res = await fetch(`${model.previewBase}/api/tags`);
    const data = await readJson(res);
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}. Start Ollama on this machine.`);
    const names = Array.isArray(data.models) ? data.models.map((item: { name?: string }) => item.name).filter(Boolean).slice(0, 4).join(", ") : "";
    return `Ollama responded in ${elapsed(started)}ms.${names ? ` Models: ${names}.` : ""}`;
  }
  const key = secretFor(model.providerId);
  if (!key) throw new Error(`${model.label} has no API key yet. Paste one on its card. The chat stays inside Ronic OS.`);
  if (model.kind === "anthropic") {
    const res = await fetch(`${model.previewBase}/v1/models`, { headers: anthropicHeaders(key) });
    const data = await readJson(res);
    if (!res.ok) throw new Error(apiError("Anthropic", res.status, data));
    return `Anthropic accepted the key in ${elapsed(started)}ms.`;
  }
  if (model.kind === "gemini") {
    const res = await fetch(`${model.previewBase}/models`, { headers: { "x-goog-api-key": key } });
    const data = await readJson(res);
    if (!res.ok) throw new Error(apiError("Gemini", res.status, data));
    return `Gemini accepted the key in ${elapsed(started)}ms.`;
  }
  if (model.kind === "bedrock") {
    const res = await fetch(`${model.previewBase}/model/${encodeURIComponent(model.upstreamModel)}/converse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "Reply with the single word pong." }] }] }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(apiError("Bedrock", res.status, data));
    return `Bedrock replied in ${elapsed(started)}ms.`;
  }
  const res = await fetch(`${model.previewBase}/models`, { headers: { Authorization: `Bearer ${key}` } });
  const data = await readJson(res);
  if (!res.ok) throw new Error(apiError(model.label, res.status, data));
  return `${model.label} accepted the key in ${elapsed(started)}ms.`;
}

async function dispatch(model: ChatModel, messages: ChatMessage[], effort: Effort, withTools: boolean): Promise<Omit<Completion, "ms">> {
  if (model.kind === "moa") throw new Error("That entry is not a connected model. Add an API key and refresh the list.");
  try {
    return await once(model, messages, effort, withTools);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/tool|function/i.test(message)) return once(model, messages, effort, false);
    throw error;
  }
}

async function once(model: ChatModel, messages: ChatMessage[], effort: Effort, withTools: boolean): Promise<Omit<Completion, "ms">> {
  if (model.kind === "ollama") return ollama(model, messages, withTools);
  const key = secretFor(model.providerId);
  if (!key) throw new Error(`${model.label} has no API key. Paste it on the provider card. The reply stays in this chat.`);
  if (model.kind === "anthropic") return anthropic(model, key, messages, effort, withTools);
  if (model.kind === "gemini") return gemini(model, key, messages, effort, withTools);
  if (model.kind === "bedrock") return bedrock(model, key, messages, effort);
  return openai(model, key, messages, effort, withTools);
}

async function openai(model: ChatModel, key: string, messages: ChatMessage[], effort: Effort, withTools: boolean) {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (model.providerId === "prov_openrouter") {
    headers["HTTP-Referer"] = "http://127.0.0.1:1420";
    headers["X-Title"] = "Ronic OS";
  }
  const body: Record<string, unknown> = {
    model: model.upstreamModel,
    messages: messages.map(wireMessage),
    ...openaiBudget(model, effort),
  };
  if (withTools) body.tools = TOOLS;
  const res = await fetch(`${model.previewBase}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await readJson(res);
  if (!res.ok) throw new Error(apiError(model.label, res.status, data));
  const message = data?.choices?.[0]?.message ?? {};
  let toolCalls = withTools ? toolCallsOf(message.tool_calls) : [];
  const rawText = textOf(message.content);
  let thinking = String(message.reasoning_content ?? message.reasoning ?? "").trim();
  let text = rawText;
  if (!thinking && rawText.includes("<think>")) {
    const match = rawText.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
    if (match) {
      thinking = match[1].trim();
      text = rawText.replace(/<think>[\s\S]*?(?:<\/think>|$)/, "").trim();
    }
  }
  if (withTools && toolCalls.length === 0) {
    const extracted = extractTextToolCalls(text);
    if (extracted.toolCalls.length > 0) {
      toolCalls = extracted.toolCalls;
      text = extracted.cleanText;
    }
  }
  if (!text && !toolCalls.length && !thinking) throw new Error(`${model.label} returned an empty reply.`);
  return { text, thinking, toolCalls, providerId: model.providerId };
}

async function anthropic(model: ChatModel, key: string, messages: ChatMessage[], effort: Effort, withTools: boolean) {
  const shaped = toAnthropic(messages);
  const body: Record<string, unknown> = {
    model: model.upstreamModel,
    max_tokens: tokenBudget(effort),
    system: shaped.system,
    messages: shaped.messages,
  };
  if (withTools) {
    body.tools = TOOLS.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }
  const res = await fetch(`${model.previewBase}/v1/messages`, {
    method: "POST",
    headers: { ...anthropicHeaders(key), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(apiError(model.label, res.status, data));
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "").join("").trim();
  const thinking = blocks.filter((part: { type?: string }) => part.type === "thinking").map((part: { thinking?: string }) => part.thinking ?? "").join("\n").trim();
  const toolCalls = withTools ? blocks.filter((part: { type?: string }) => part.type === "tool_use").map((part: { id?: string; name?: string; input?: unknown }) => ({
    id: part.id || `tool_${part.name}`,
    name: String(part.name ?? ""),
    arguments: JSON.stringify(part.input ?? {}),
  })) : [];
  if (!text && !toolCalls.length && !thinking) throw new Error(`${model.label} returned an empty reply.`);
  return { text, thinking, toolCalls, providerId: model.providerId };
}

async function gemini(model: ChatModel, key: string, messages: ChatMessage[], effort: Effort, withTools: boolean) {
  const shaped = toGemini(messages);
  const body: Record<string, unknown> = {
    contents: shaped.contents,
    generationConfig: { maxOutputTokens: tokenBudget(effort) },
  };
  if (shaped.system) body.systemInstruction = { parts: [{ text: shaped.system }] };
  if (withTools) {
    body.tools = [
      {
        functionDeclarations: TOOLS.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ];
  }
  const res = await fetch(`${model.previewBase}/models/${model.upstreamModel}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(apiError(model.label, res.status, data));
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((part: { text?: string; thought?: boolean }) => (part.thought ? "" : part.text ?? "")).join("").trim() : "";
  const thinking = Array.isArray(parts) ? parts.filter((part: { thought?: boolean }) => part.thought).map((part: { text?: string }) => part.text ?? "").join("\n").trim() : "";
  const toolCalls = withTools ? geminiToolCalls(parts) : [];
  if (!text && !toolCalls.length && !thinking) throw new Error(`${model.label} returned an empty reply.`);
  return { text, thinking, toolCalls, providerId: model.providerId };
}

function geminiToolCalls(parts: unknown): ToolCall[] {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part: { functionCall?: { name?: string; args?: unknown } }, index: number) => {
    const call = part?.functionCall;
    if (!call?.name) return [];
    return [{ id: `tool_${call.name}_${index}`, name: String(call.name), arguments: JSON.stringify(call.args ?? {}) }];
  });
}

function toGemini(messages: ChatMessage[]) {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const contents: { role: string; parts: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const part = { functionResponse: { name: message.name || "tool", response: { result: message.content } } };
      const last = contents[contents.length - 1];
      if (last?.role === "user") last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: unknown[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: call.name, args } });
      }
      if (!parts.length) parts.push({ text: "" });
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({ role: "user", parts: [{ text: message.content }] });
  }
  const merged: { role: string; parts: unknown[] }[] = [];
  for (const item of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === item.role) last.parts.push(...item.parts);
    else merged.push({ role: item.role, parts: [...item.parts] });
  }
  if (merged.length && merged[0].role !== "user") merged.unshift({ role: "user", parts: [{ text: "." }] });
  return { system, contents: merged };
}

async function bedrock(model: ChatModel, key: string, messages: ChatMessage[], effort: Effort) {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const talk = messages.filter((item) => item.role === "user" || item.role === "assistant");
  const res = await fetch(`${model.previewBase}/model/${encodeURIComponent(model.upstreamModel)}/converse`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      system: system ? [{ text: system }] : undefined,
      inferenceConfig: { maxTokens: tokenBudget(effort) },
      messages: talk.map((item) => ({ role: item.role, content: [{ text: item.content }] })),
    }),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(apiError(model.label, res.status, data));
  const parts = data?.output?.message?.content;
  const text = Array.isArray(parts) ? parts.map((part: { text?: string }) => part.text ?? "").join("").trim() : "";
  if (!text) throw new Error(`${model.label} returned an empty reply.`);
  return { text, thinking: "", toolCalls: [] as ToolCall[], providerId: model.providerId };
}

async function ollama(model: ChatModel, messages: ChatMessage[], withTools: boolean) {
  const body: Record<string, unknown> = {
    model: model.upstreamModel,
    stream: false,
    messages: messages.map(wireMessage),
  };
  if (withTools) body.tools = TOOLS;
  const res = await fetch(`${model.previewBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}. ${data?.error ?? "Start Ollama, then pull a model."}`);
  let text = textOf(data?.message?.content);
  let toolCalls = withTools ? toolCallsOf(data?.message?.tool_calls) : [];
  if (withTools && toolCalls.length === 0) {
    const extracted = extractTextToolCalls(text);
    if (extracted.toolCalls.length > 0) {
      toolCalls = extracted.toolCalls;
      text = extracted.cleanText;
    }
  }
  if (!text && !toolCalls.length) throw new Error("Ollama returned an empty reply.");
  return { text, thinking: "", toolCalls, providerId: model.providerId };
}

function wireMessage(message: ChatMessage) {
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  if (message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

function toAnthropic(messages: ChatMessage[]) {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const out: { role: string; content: unknown }[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
      const last = out[out.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        let input: unknown = {};
        try { input = JSON.parse(call.arguments || "{}"); } catch { input = {}; }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
  }
  return { system, messages: out };
}

function extractTextToolCalls(text: string): { cleanText: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  let cleanText = text;

  // 1. Tag parsing for <|tool_call|>name={...}>
  const tagRegex = /<\|?tool_call\|?>\s*([a-zA-Z0-9_-]+)\s*=\s*(\{[\s\S]*?\})\s*>?/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(cleanText)) !== null) {
    try {
      JSON.parse(match[2]);
      toolCalls.push({
        id: `call_txt_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
        name: match[1],
        arguments: match[2],
      });
    } catch {
      // not valid json
    }
  }

  // 2. Fence parsing ```ronic-tool, ```tool, ```json
  const fenceRegex = /```(?:ronic-tool|tool|json)?\s*(\{[\s\S]*?\})\s*```/g;
  while ((match = fenceRegex.exec(cleanText)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      const name = obj.name || obj.tool;
      if (name && typeof name === "string") {
        const args = obj.arguments || obj.parameters || obj;
        toolCalls.push({
          id: `call_fence_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
          name,
          arguments: typeof args === "string" ? args : JSON.stringify(args),
        });
      }
    } catch {
      // ignore
    }
  }

  // Sanitize text if any tool calls were extracted
  if (toolCalls.length > 0) {
    cleanText = cleanText
      .replace(/<\|?tool_call\|?>\s*[a-zA-Z0-9_-]+\s*=\s*\{[\s\S]*?\}\s*>?/g, "")
      .replace(/```(?:ronic-tool|tool|json)?\s*\{[\s\S]*?\}\s*```/g, "")
      .replace(/<\|?tool_call\|?>/gi, "")
      .replace(/<\|[^>]*\|>/g, "")
      .trim();
  }

  return { cleanText, toolCalls };
}

function toolCallsOf(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((call: { id?: string; name?: string; function?: { name?: string; arguments?: string }; arguments?: unknown }) => ({
    id: call.id || `tool_${call.function?.name || call.name || "call"}`,
    name: String(call.function?.name || call.name || ""),
    arguments: typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.arguments ?? call.function?.arguments ?? {}),
  })).filter((call) => call.name);
}

function textOf(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("").trim();
  return "";
}

function tokenBudget(effort: Effort) {
  if (effort === "high") return 8192;
  if (effort === "max") return 16384;
  if (effort === "xhigh") return 32768;
  return 4096;
}

function openaiBudget(model: ChatModel, effort: Effort) {
  const budget = tokenBudget(effort);
  if (model.reasoning) {
    const reasoning = effort === "xhigh" ? "high" : effort === "max" ? "medium" : "low";
    return { max_completion_tokens: budget, reasoning_effort: reasoning };
  }
  return { max_tokens: budget };
}

export function anthropicHeaders(key: string) {
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

async function readJson(res: Response) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 400) } };
  }
}

function apiError(name: string, status: number, data: { error?: { message?: string }; message?: string }) {
  const message = data?.error?.message || data?.message || "request failed";
  return `${name} HTTP ${status}: ${message}`;
}

function elapsed(started: number) {
  return Math.max(1, Math.round(performance.now() - started));
}
