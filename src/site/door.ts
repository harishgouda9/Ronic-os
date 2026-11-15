export const MCP_URL = "https://ronicos.vercel.app/mcp";

export type DoorStatus = { ok: boolean; detail: string };

function firstJson(text: string): Record<string, unknown> | null {
  const data = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
  for (const item of data.length ? data : [text.trim()]) {
    if (!item) continue;
    try {
      const value: unknown = JSON.parse(item);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // The next line may be the payload.
    }
  }
  return null;
}

function messageOf(error: unknown): string {
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

export function doorStatus(status: number, text: string): DoorStatus {
  const body = firstJson(text);
  if (body && typeof body.error === "string" && body.error.trim()) return { ok: false, detail: body.error.trim() };
  const rpc = messageOf(body?.error);
  if (rpc) return { ok: false, detail: rpc };
  const result = body?.result;
  const info = result && typeof result === "object" && !Array.isArray(result)
    ? (result as { serverInfo?: { name?: unknown; version?: unknown } }).serverInfo
    : undefined;
  if (status >= 200 && status < 300 && info && typeof info.name === "string") {
    const version = typeof info.version === "string" && info.version ? ` ${info.version}` : "";
    return { ok: true, detail: `${info.name}${version}` };
  }
  if (status >= 200 && status < 300 && result && typeof result === "object") return { ok: true, detail: "connected" };
  if (!text.trim() || text.trim().startsWith("<")) return { ok: false, detail: `The door answered HTTP ${status}.` };
  return { ok: false, detail: text.trim().slice(0, 180) };
}

export function toolNames(text: string): string[] {
  const result = firstJson(text)?.result;
  const tools = result && typeof result === "object" && !Array.isArray(result) ? (result as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => (tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string" ? (tool as { name: string }).name : ""))
    .filter((name) => name.length > 0)
    .slice(0, 8);
}
