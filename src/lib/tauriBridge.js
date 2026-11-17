import { invoke } from "@tauri-apps/api/core";
export const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const PREVIEW_HARNESSES = [
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
    category: category,
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
    category: "web",
    icon,
    installed: false,
    execution_mode: "webview",
    binary_or_url: url,
    version_info: "Not connected. This preview has no account.",
    connected: false,
})));
export async function scanAllHarnesses() {
    if (!isTauriRuntime())
        return PREVIEW_HARNESSES;
    return await invoke("scan_all_harnesses");
}
function safeHarnessUrl(url) {
    const next = url.includes("grok.x.ai") ? "https://grok.com" : url.trim() || "https://chatgpt.com";
    const allowed = next.startsWith("https://") || next.startsWith("http://127.0.0.1") || next.startsWith("http://localhost");
    return allowed ? next : "";
}
export async function openHarnessWindow(providerId, targetUrl) {
    if (!isTauriRuntime()) {
        const url = safeHarnessUrl(targetUrl);
        if (!url)
            return "Provider windows only open https, or localhost.";
        window.open(url, "_blank", "noopener,noreferrer");
        return `Opened ${url} in browser tab`;
    }
    return await invoke("open_harness_window", {
        providerId,
        targetUrl,
    });
}
export async function launchLocalApp(executablePath) {
    if (!isTauriRuntime()) {
        console.warn("Running in browser preview mode; cannot launch local executable.");
        return "This preview cannot launch a program on this computer.";
    }
    return await invoke("launch_local_app", { executablePath });
}
export async function runHarnessPrompt(binaryOrUrl, prompt) {
    if (!isTauriRuntime()) {
        return "This preview cannot send that prompt. Open the desktop app.";
    }
    return await invoke("run_harness_prompt", {
        binaryOrUrl,
        prompt,
    });
}
export async function listInstalledWebapps() {
    if (!isTauriRuntime())
        return [];
    return await invoke("installed_webapps");
}
export async function showWorkspaceWebapp(id, bounds, focus, extra) {
    const args = { id, bounds, focus };
    if (extra?.url)
        args.url = extra.url;
    if (extra?.name)
        args.name = extra.name;
    return await invoke("show_workspace_webapp", args);
}
export async function placeWorkspaceWebapp(id, bounds) {
    await invoke("place_workspace_webapp", { id, bounds });
}
export async function hideWorkspaceWebapps() {
    if (!isTauriRuntime())
        return;
    await invoke("hide_workspace_webapps");
}
export async function showPageBrowser(bounds, url, focus) {
    if (!isTauriRuntime())
        return { showing: false, refused: false };
    return await invoke("show_page_browser", { bounds, url, focus });
}
export async function placePageBrowser(bounds) {
    if (!isTauriRuntime())
        return;
    await invoke("place_page_browser", { bounds });
}
export async function hidePageBrowser() {
    if (!isTauriRuntime())
        return;
    await invoke("hide_page_browser");
}
export async function pageBrowserGo(action) {
    if (!isTauriRuntime())
        return;
    await invoke("page_browser_go", { action });
}
export async function revealBotScreen(botId, bounds, url) {
    if (!isTauriRuntime())
        return { showing: false, refused: false, url: "" };
    return await invoke("reveal_bot_screen", { botId, bounds, url });
}
export async function placeBotScreen(bounds) {
    if (!isTauriRuntime())
        return;
    await invoke("place_bot_screen", { bounds });
}
export async function hideBotScreens() {
    if (!isTauriRuntime())
        return;
    await invoke("hide_bot_screens");
}
export async function launchDesktopApp(id, kind, extra) {
    const args = { id };
    if (kind)
        args.kind = kind;
    if (extra?.path)
        args.path = extra.path;
    if (extra?.name)
        args.name = extra.name;
    return await invoke("launch_desktop_app", args);
}
export async function listProviderModels() {
    if (!isTauriRuntime())
        return { models: [], notes: ["No API keys are stored. Models show up after you paste a key on a provider card."] };
    return await invoke("list_provider_models");
}
export async function bridgeStatus() {
    if (!isTauriRuntime())
        return { port: 0, endpoint: "", clients: [], note: "" };
    return await invoke("workspace_bridge_status");
}
