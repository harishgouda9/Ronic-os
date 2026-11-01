import { anthropicHeaders, ollamaModel, PROVIDER_ROUTES, routeFor, secretFor, type ChatModel, type Effort } from "./liveChat";

const CUSTOM = "ronic.customModels.v1";
const EDITS = "ronic.modelEdits.v1";
const STARS = "ronic.modelStars.v1";
const EFFORTS = "ronic.modelEffort.v1";
const LIVE = "ronic.liveModels.v1";

export type ModelEdit = { label?: string; upstreamModel?: string; hidden?: boolean };

export const GROUP_ORDER = ["ChatGPT", "Claude", "Gemini", "Grok", "Meta AI", "Copilot", "Mistral", "Perplexity", "Groq", "Together", "Cohere", "OpenRouter", "DeepSeek", "Qwen", "TokenRouter", "Bedrock", "NVIDIA NIM", "Ollama", "Presets", "Custom"];

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function allowModel(model: ChatModel, keyed: ReadonlySet<string>, ollamaReady: boolean) {
  if (model.kind === "moa") return false;
  if (model.providerId === "prov_ollama") return ollamaReady;
  return keyed.has(model.providerId);
}

export function catalog(keyedIds: readonly string[], ollamaReady: boolean): ChatModel[] {
  const keyed = new Set(keyedIds);
  const live = read<ChatModel[]>(LIVE, []);
  const custom = read<ChatModel[]>(CUSTOM, []);
  const edits = read<Record<string, ModelEdit>>(EDITS, {});
  const seen = new Set<string>();
  const out: ChatModel[] = [];
  for (const model of [...live, ...custom]) {
    if (!allowModel(model, keyed, ollamaReady)) continue;
    const identity = `${model.providerId}:${model.upstreamModel}`;
    if (seen.has(model.id) || seen.has(identity)) continue;
    seen.add(model.id);
    seen.add(identity);
    const edit = edits[model.id];
    if (edit?.hidden) continue;
    out.push({
      ...model,
      label: edit?.label?.trim() || model.label,
      upstreamModel: edit?.upstreamModel?.trim() || model.upstreamModel,
    });
  }
  return out;
}

export function modelById(id: string) {
  const live = read<ChatModel[]>(LIVE, []);
  const custom = read<ChatModel[]>(CUSTOM, []);
  return [...live, ...custom].find((item) => item.id === id) ?? null;
}

export function groupsFor(models: ChatModel[], query: string) {
  const needle = query.trim().toLowerCase();
  const buckets = new Map<string, ChatModel[]>();
  for (const model of models) {
    if (needle && !`${model.label} ${model.upstreamModel} ${model.group}`.toLowerCase().includes(needle)) continue;
    const list = buckets.get(model.group) ?? [];
    list.push(model);
    buckets.set(model.group, list);
  }
  const titles = [...GROUP_ORDER.filter((title) => buckets.has(title)), ...[...buckets.keys()].filter((title) => !GROUP_ORDER.includes(title))];
  return titles.map((title) => ({ title, models: buckets.get(title) ?? [] }));
}

export function starIds() {
  return read<string[]>(STARS, []);
}

export function toggleStar(id: string) {
  const next = new Set(starIds());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  const list = [...next];
  write(STARS, list);
  return list;
}

export function effortFor(id: string): Effort {
  const value = read<Record<string, Effort>>(EFFORTS, {})[id];
  return value === "high" || value === "max" || value === "xhigh" ? value : "default";
}

export function setEffort(id: string, effort: Effort) {
  const map = read<Record<string, Effort>>(EFFORTS, {});
  map[id] = effort;
  write(EFFORTS, map);
}

export function addCustom(draft: { label: string; upstreamModel: string; providerId: string }) {
  const route = routeFor(draft.providerId);
  const model: ChatModel = {
    id: `custom:${Date.now().toString(16)}`,
    label: draft.label.trim(),
    providerId: draft.providerId,
    kind: route.kind,
    previewBase: route.previewBase,
    upstreamModel: draft.upstreamModel.trim(),
    group: "Custom",
    custom: true,
  };
  const all = read<ChatModel[]>(CUSTOM, []);
  all.unshift(model);
  write(CUSTOM, all);
  return model;
}

export function saveEdit(id: string, patch: { label: string; upstreamModel: string }) {
  const custom = read<ChatModel[]>(CUSTOM, []);
  const index = custom.findIndex((item) => item.id === id);
  if (index >= 0) {
    custom[index] = {
      ...custom[index],
      label: patch.label.trim() || custom[index].label,
      upstreamModel: patch.upstreamModel.trim() || custom[index].upstreamModel,
    };
    write(CUSTOM, custom);
    return;
  }
  const edits = read<Record<string, ModelEdit>>(EDITS, {});
  edits[id] = { ...edits[id], label: patch.label.trim(), upstreamModel: patch.upstreamModel.trim() };
  write(EDITS, edits);
}

export function hideModel(id: string) {
  write(CUSTOM, read<ChatModel[]>(CUSTOM, []).filter((item) => item.id !== id));
  const edits = read<Record<string, ModelEdit>>(EDITS, {});
  edits[id] = { ...edits[id], hidden: true };
  write(EDITS, edits);
}

const LIST_CAP = 200;

function skipModel(id: string) {
  return /embed|whisper|tts|audio|image|moderation|rerank|realtime|transcribe|dall-e|clip|bge-|voyage/.test(id.toLowerCase());
}

function listedModel(route: { providerId: string; kind: ChatModel["kind"]; previewBase: string; group: string }, upstream: string, label: string): ChatModel {
  return {
    id: `${route.providerId}:${upstream}`,
    label: label || upstream,
    providerId: route.providerId,
    kind: route.kind,
    previewBase: route.previewBase,
    upstreamModel: upstream,
    group: route.group,
    reasoning: /^o[134]/.test(upstream),
  };
}

function modelsFrom(route: (typeof PROVIDER_ROUTES)[number], data: unknown): ChatModel[] {
  if (route.kind === "ollama") {
    return arrayField<{ name?: string }>(data, "models")
      .map((item) => item.name?.trim() ?? "")
      .filter(Boolean)
      .slice(0, LIST_CAP)
      .map((name) => ollamaModel(name));
  }
  if (route.kind === "gemini") {
    const out: ChatModel[] = [];
    for (const row of arrayField<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>(data, "models")) {
      const methods = row.supportedGenerationMethods ?? [];
      if (methods.length && !methods.includes("generateContent")) continue;
      const upstream = (row.name ?? "").replace(/^models\//, "");
      if (!upstream || skipModel(upstream)) continue;
      out.push(listedModel(route, upstream, row.displayName || upstream));
      if (out.length >= LIST_CAP) break;
    }
    return out;
  }
  const out: ChatModel[] = [];
  for (const row of arrayField<{ id?: string; name?: string; display_name?: string }>(data, "data")) {
    const upstream = row.id?.trim() ?? "";
    if (!upstream || skipModel(upstream)) continue;
    out.push(listedModel(route, upstream, row.display_name || row.name || upstream));
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

function arrayField<T>(data: unknown, key: string): T[] {
  if (!data || typeof data !== "object") return [];
  const value = (data as Record<string, unknown>)[key];
  return Array.isArray(value) ? value as T[] : [];
}

export async function loadConnectedModels(keyedIds: readonly string[]) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { listProviderModels } = await import("../lib/tauriBridge");
    const listed = await listProviderModels();
    const models: ChatModel[] = listed.models.map((item) => ({
      id: item.id,
      label: item.label,
      providerId: item.providerId,
      kind: item.kind,
      previewBase: item.previewBase,
      upstreamModel: item.upstreamModel,
      group: item.group,
    }));
    write(LIVE, models);
    return { count: models.length, notes: listed.notes, ollama: models.some((item) => item.providerId === "prov_ollama") };
  }
  return refreshLiveModels(keyedIds);
}

export async function refreshLiveModels(keyedIds: readonly string[]) {
  const notes: string[] = [];
  const found: ChatModel[] = [];
  const keyed = new Set(keyedIds);
  const jobs: Promise<void>[] = [];
  if (keyed.size === 0) notes.push("No API keys are stored. Continue with ChatGPT, or open a provider and paste a key. Ollama models appear when it is running.");
  for (const route of PROVIDER_ROUTES) {
    if (route.providerId === "prov_ollama") {
      jobs.push(pull(route.listUrl, undefined, (data) => modelsFrom(route, data), route.name, notes, found));
      continue;
    }
    if (!keyed.has(route.providerId)) continue;
    const key = secretFor(route.providerId);
    if (!key) {
      notes.push(`${route.name}: the key is not in this session.`);
      continue;
    }
    if (!route.listUrl) {
      notes.push(`${route.name}: add the model id with Add custom model.`);
      continue;
    }
    const headers = route.auth === "anthropic"
      ? anthropicHeaders(key)
      : route.auth === "gemini"
        ? undefined
        : { Authorization: `Bearer ${key}` };
    const url = route.auth === "gemini" ? `${route.listUrl}?key=${encodeURIComponent(key)}` : route.listUrl;
    jobs.push(pull(url, headers, (data) => modelsFrom(route, data), route.name, notes, found));
  }
  await Promise.all(jobs);
  write(LIVE, found);
  return { count: found.length, notes, ollama: found.some((item) => item.providerId === "prov_ollama") };
}

async function pull(url: string, headers: Record<string, string> | undefined, parse: (data: unknown) => ChatModel[], name: string, notes: string[], found: ChatModel[]) {
  try {
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notes.push(`${name} HTTP ${res.status}.`);
      return;
    }
    const models = parse(data);
    found.push(...models);
    notes.push(`${name}: ${models.length} models.`);
  } catch {
    notes.push(`${name} did not answer.`);
  }
}
