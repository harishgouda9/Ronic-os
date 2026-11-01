import type { MiniFsEntry, MiniFsListing, MiniFsRead, ShellBoot, ShellState } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// In-memory mock state for browser preview mode
const browserShellState: Record<string, ShellBoot> = {};

function getBrowserBoot(botId?: string): ShellBoot {
  const id = botId?.trim() || "bot";
  if (!browserShellState[id]) {
    browserShellState[id] = {
      botId: id,
      botHandle: id.startsWith("@") ? id : `@${id}`,
      windowLabel: `ronic_mini_comp_${id}`,
      chromeLabel: `ronic_mini_comp_${id}_chrome`,
      workspacePath: `~/.ronicos/bots/${id}/workspace`,
      memoryPath: `~/.ronicos/bots/${id}/memory`,
      sessionId: `mini-${id}`,
      shell: {
        app: "desktop",
        tabs: [
          { id: "tab-1", url: "https://www.google.com", title: "Google" },
        ],
        activeTab: "tab-1",
        chromeVisible: false,
        content: [0, 111, 980, 505],
        dpr: 1,
        history: ["https://www.google.com"],
        windowOpen: true,
      },
    };
  }
  return browserShellState[id];
}

function broadcastBrowserShell(botId: string, shell: ShellState) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ronic-mini-computer", { detail: { botId, shell } }));
  }
}

// The standalone mini computer window calls these WITHOUT a botId (Rust
// derives the bot from the calling webview). The chat dock's embedded panel
// runs inside the MAIN webview, so it passes the inspected bot's id instead.
export const ipc = {
  boot: async (botId?: string): Promise<ShellBoot> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<ShellBoot>("mini_shell_boot", { botId: botId ?? null });
    }
    return getBrowserBoot(botId);
  },

  layout: async (x: number, y: number, w: number, h: number): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("mini_shell_layout", { x, y, w, h, dpr: window.devicePixelRatio });
    }
  },

  setApp: async (target: string, botId?: string): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("mini_shell_set_app", { target, botId: botId ?? null });
    }
    const boot = getBrowserBoot(botId);
    boot.shell.app = target as ShellState["app"];
    boot.shell.chromeVisible = target === "chrome" && boot.shell.tabs.length > 0;
    broadcastBrowserShell(boot.botId, { ...boot.shell });
  },

  openTab: async (url: string, botId?: string): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("mini_open_tab", { url, botId: botId ?? null });
    }
    const boot = getBrowserBoot(botId);
    const newTab = { id: `tab-${Date.now()}`, url, title: url.replace(/^https?:\/\//i, "").slice(0, 32) };
    boot.shell.tabs.push(newTab);
    boot.shell.activeTab = newTab.id;
    boot.shell.app = "chrome";
    boot.shell.chromeVisible = true;
    if (!boot.shell.history) boot.shell.history = [];
    boot.shell.history.unshift(url);
    broadcastBrowserShell(boot.botId, { ...boot.shell });
  },

  closeTab: async (tabId: string, botId?: string): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("mini_close_tab", { tabId, botId: botId ?? null });
    }
    const boot = getBrowserBoot(botId);
    boot.shell.tabs = boot.shell.tabs.filter((t) => t.id !== tabId);
    if (boot.shell.activeTab === tabId) {
      boot.shell.activeTab = boot.shell.tabs[0]?.id ?? "";
    }
    if (boot.shell.tabs.length === 0) {
      boot.shell.chromeVisible = false;
    }
    broadcastBrowserShell(boot.botId, { ...boot.shell });
  },

  focusTab: async (tabId: string, botId?: string): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("mini_focus_tab", { tabId, botId: botId ?? null });
    }
    const boot = getBrowserBoot(botId);
    boot.shell.activeTab = tabId;
    boot.shell.app = "chrome";
    boot.shell.chromeVisible = true;
    broadcastBrowserShell(boot.botId, { ...boot.shell });
  },

  chromeNav: async (kind: "back" | "forward" | "reload" | "address", url?: string, botId?: string): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("mini_chrome_nav", { kind, url: url ?? null, botId: botId ?? null });
    }
    const boot = getBrowserBoot(botId);
    const active = boot.shell.tabs.find((t) => t.id === boot.shell.activeTab);
    if (active && url && kind === "address") {
      active.url = url;
      active.title = url.replace(/^https?:\/\//i, "").slice(0, 32);
      if (!boot.shell.history) boot.shell.history = [];
      boot.shell.history.unshift(url);
    }
    broadcastBrowserShell(boot.botId, { ...boot.shell });
  },

  history: async (botId?: string): Promise<string[]> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string[]>("mini_history", { botId: botId ?? null });
    }
    const boot = getBrowserBoot(botId);
    return boot.shell.history ?? ["https://www.google.com"];
  },

  fsList: async (root: string, path: string, botId?: string): Promise<MiniFsListing> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<MiniFsListing>("mini_fs_list", { root, path, botId: botId ?? null });
    }
    const mockEntries: MiniFsEntry[] = root === "memory" ? [
      { name: "core-stack.md", kind: "file", size: 1048, modifiedMs: Date.now() - 3600000, ext: "md" },
      { name: "user-preferences.md", kind: "file", size: 512, modifiedMs: Date.now() - 7200000, ext: "md" },
    ] : [
      { name: "src", kind: "dir", size: 0, modifiedMs: Date.now() - 86400000, ext: "" },
      { name: "README.md", kind: "file", size: 1240, modifiedMs: Date.now() - 3600000, ext: "md" },
      { name: "workspace.config.json", kind: "file", size: 680, modifiedMs: Date.now() - 1800000, ext: "json" },
      { name: "task_plan.md", kind: "file", size: 2150, modifiedMs: Date.now() - 600000, ext: "md" },
    ];
    return {
      root,
      path: path || "",
      absolutePath: `~/.ronicos/bots/${botId || "bot"}/${root}${path ? `/${path}` : ""}`,
      entries: mockEntries,
    };
  },

  fsRead: async (root: string, path: string, maxBytes?: number, wantBody?: boolean, botId?: string): Promise<MiniFsRead> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<MiniFsRead>("mini_fs_read", { root, path, maxBytes: maxBytes ?? null, wantBody: wantBody ?? null, botId: botId ?? null });
    }
    const isMd = path.endsWith(".md");
    const isJson = path.endsWith(".json");
    const content = isMd
      ? `# ${path}\n\nWorkspace file managed by ${botId || "bot"}.\nIsolated execution and sandboxed memory library.`
      : isJson
      ? `{\n  "bot": "${botId || "bot"}",\n  "status": "active",\n  "updatedAt": "${new Date().toISOString()}"\n}`
      : "Ronic Mini Computer Workspace File";
    return {
      name: path.split("/").pop() || path,
      kind: "text",
      mime: isJson ? "application/json" : "text/markdown",
      size: content.length,
      truncated: false,
      text: content,
      base64: btoa(content),
    };
  },

  fsWrite: async (root: string, path: string, body: string, botId?: string): Promise<string> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("mini_fs_write", { root, path, body, botId: botId ?? null });
    }
    return `Wrote ${body.length} bytes to ${path}`;
  },

  fsWriteBytes: async (root: string, path: string, base64Body: string, botId?: string): Promise<string> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("mini_fs_write_bytes", { root, path, base64Body, botId: botId ?? null });
    }
    return `Wrote binary to ${path}`;
  },

  fsMkdir: async (root: string, path: string, botId?: string): Promise<string> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("mini_fs_mkdir", { root, path, botId: botId ?? null });
    }
    return `Created directory ${path}`;
  },

  fsRename: async (root: string, from: string, to: string, botId?: string): Promise<string> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("mini_fs_rename", { root, from, to, botId: botId ?? null });
    }
    return `Renamed ${from} to ${to}`;
  },

  fsDelete: async (root: string, path: string, botId?: string): Promise<string> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("mini_fs_delete", { root, path, botId: botId ?? null });
    }
    return `Deleted ${path}`;
  },

  spawnTerminal: async (sessionId: string, cols: number, rows: number, cwd: string): Promise<string> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string>("spawn_terminal", { sessionId, cols, rows, cwd });
    }
    return `Terminal spawned: ${sessionId}`;
  },

  writeTerminal: async (sessionId: string, data: string): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("write_terminal", { sessionId, data });
    }
  },

  resizeTerminal: async (sessionId: string, cols: number, rows: number): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("resize_terminal", { sessionId, cols, rows });
    }
  },

  closeTerminal: async (sessionId: string): Promise<void> => {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<void>("close_terminal", { sessionId });
    }
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatWhen(modifiedMs: number): string {
  if (!modifiedMs) return "—";
  const date = new Date(modifiedMs);
  const diff = Date.now() - modifiedMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
