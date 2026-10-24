import { invoke } from "@tauri-apps/api/core";
import type { ChatModel } from "../kernel/liveChat";
import type { CommandResult } from "../types";

export interface DetectedHarness {
  id: string;
  name: string;
  category: "cli" | "ide" | "web" | "external_bot";
  icon: string;
  installed: boolean;
  execution_mode: string;
  binary_or_url: string;
  version_info: string;
  connected: boolean;
}

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const PREVIEW_HARNESSES: DetectedHarness[] = [
  ["claude", "Claude Code", "cli", "CC"],
  ["gemini", "Gemini CLI", "cli", "GM"],
  ["codex", "Codex CLI", "cli", "CX"],
  ["aider", "Aider", "cli", "AI"],
  ["opencode", "OpenCode", "cli", "OC"],
  ["ollama", "Ollama", "cli", "OL"],
  ["cursor", "Cursor", "ide", "CU"],
  ["vscode", "VS Code", "ide", "VS"],
  ["obsidian", "Obsidian", "ide", "OB"],
].map(([id, name, category, icon]) => ({
  id,
  name,
  category: category as DetectedHarness["category"],
  icon,
  installed: false,
  execution_mode: "native_bin",
  binary_or_url: "",
  version_info: "Browser preview cannot see this computer.",
  connected: false,
})).concat([
  ["chatgpt_web", "ChatGPT Plus / Pro (Web)", "https://chatgpt.com", "GP"],
  ["claude_web", "Claude Pro / Max (Web)", "https://claude.ai", "CL"],
  ["gemini_web", "Gemini Pro / Ultra (Web)", "https://gemini.google.com", "GM"],
  ["grok_web", "Grok Pro (Web)", "https://grok.com", "GK"],
].map(([id, name, url, icon]) => ({
  id,
  name,
  category: "web" as const,
  icon,
  installed: false,
  execution_mode: "webview",
  binary_or_url: url,
  version_info: "Not connected. This preview has no account.",
  connected: false,
})));

export async function scanAllHarnesses(): Promise<DetectedHarness[]> {
  if (!isTauriRuntime()) return PREVIEW_HARNESSES;
  return await invoke<DetectedHarness[]>("scan_all_harnesses");
}

function safeHarnessUrl(url: string) {
  const next = url.includes("grok.x.ai") ? "https://grok.com" : url.trim() || "https://chatgpt.com";
  const allowed = next.startsWith("https://") || next.startsWith("http://127.0.0.1") || next.startsWith("http://localhost");
  return allowed ? next : "";
}

export async function openHarnessWindow(
  providerId: string,
  targetUrl: string
): Promise<string> {
  if (!isTauriRuntime()) {
    const url = safeHarnessUrl(targetUrl);
    if (!url) return "Provider windows only open https, or localhost.";
    window.open(url, "_blank", "noopener,noreferrer");
    return `Opened ${url} in browser tab`;
  }
  return await invoke<string>("open_harness_window", {
    providerId,
    targetUrl,
  });
}

export async function launchLocalApp(executablePath: string): Promise<string> {
  if (!isTauriRuntime()) {
    console.warn("Running in browser preview mode; cannot launch local executable.");
    return "This preview cannot launch a program on this computer.";
  }
  return await invoke<string>("launch_local_app", { executablePath });
}

export async function runHarnessPrompt(
  binaryOrUrl: string,
  prompt: string
): Promise<string> {
  if (!isTauriRuntime()) {
    return "This preview cannot send that prompt. Open the desktop app.";
  }
  return await invoke<string>("run_harness_prompt", {
    binaryOrUrl,
    prompt,
  });
}

export type WebAppBounds = { x: number; y: number; width: number; height: number };

export type WebAppStatus = { note: string; installed: string[]; signing_in?: string | null };

export async function listInstalledWebapps(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  return await invoke<string[]>("installed_webapps");
}

export async function showWorkspaceWebapp(
  id: string,
  bounds: WebAppBounds,
  focus: boolean,
  extra?: { url?: string; name?: string },
): Promise<WebAppStatus> {
  const args: Record<string, unknown> = { id, bounds, focus };
  if (extra?.url) args.url = extra.url;
  if (extra?.name) args.name = extra.name;
  return await invoke<WebAppStatus>("show_workspace_webapp", args);
}

export async function placeWorkspaceWebapp(id: string, bounds: WebAppBounds): Promise<void> {
  await invoke("place_workspace_webapp", { id, bounds });
}

export async function hideWorkspaceWebapps(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("hide_workspace_webapps");
}

export type PageView = { showing: boolean; refused: boolean };

export async function showPageBrowser(bounds: WebAppBounds, url: string, focus: boolean): Promise<PageView> {
  if (!isTauriRuntime()) return { showing: false, refused: false };
  return await invoke<PageView>("show_page_browser", { bounds, url, focus });
}

export async function placePageBrowser(bounds: WebAppBounds): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("place_page_browser", { bounds });
}

export async function hidePageBrowser(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("hide_page_browser");
}

export async function pageBrowserGo(action: "reload"): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("page_browser_go", { action });
}

export type BotScreenStatus = { showing: boolean; refused: boolean; url: string };

export async function revealBotScreen(botId: string, bounds: WebAppBounds, url: string): Promise<BotScreenStatus> {
  if (!isTauriRuntime()) return { showing: false, refused: false, url: "" };
  return await invoke<BotScreenStatus>("reveal_bot_screen", { botId, bounds, url });
}

export async function placeBotScreen(bounds: WebAppBounds): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("place_bot_screen", { bounds });
}

export async function hideBotScreens(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("hide_bot_screens");
}

export async function launchDesktopApp(
  id: string,
  kind?: "desktop" | "terminal",
  extra?: { path?: string; name?: string },
): Promise<CommandResult> {
  const args: Record<string, unknown> = { id };
  if (kind) args.kind = kind;
  if (extra?.path) args.path = extra.path;
  if (extra?.name) args.name = extra.name;
  return await invoke<CommandResult>("launch_desktop_app", args);
}

export type BridgeStatus = { port: number; endpoint: string; clients: string[]; note: string };

export type ListedModel = {
  id: string;
  label: string;
  providerId: string;
  kind: ChatModel["kind"];
  previewBase: string;
  upstreamModel: string;
  group: string;
};

export async function listProviderModels(): Promise<{ models: ListedModel[]; notes: string[] }> {
  if (!isTauriRuntime()) return { models: [], notes: ["No API keys are stored. Models show up after you paste a key on a provider card."] };
  return await invoke<{ models: ListedModel[]; notes: string[] }>("list_provider_models");
}

export async function bridgeStatus(): Promise<BridgeStatus> {
  if (!isTauriRuntime()) return { port: 0, endpoint: "", clients: [], note: "" };
  return await invoke<BridgeStatus>("workspace_bridge_status");
}

