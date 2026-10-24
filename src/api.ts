import type { CommandResult } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function pickPaths(kind: "files" | "program" | "folder"): Promise<string[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("pick_paths", { kind });
}

export async function call(cmd: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<CommandResult>(cmd, args);
  }
  // The whole browser-preview kernel loads only in the web preview; the
  // desktop bundle never pays for it.
  const { browserCall } = await import("./kernel/browser");
  return browserCall(cmd, args);
}
