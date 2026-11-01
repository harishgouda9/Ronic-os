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

// For computer-subsystem commands that answer with a direct payload instead
// of a workspace snapshot.
export async function invokeRaw<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  throw new Error("the computer-use subsystem needs the desktop kernel");
}

export async function saveExportedFile(filename: string, base64Data: string, openAfter = false): Promise<string> {
  if (isTauri()) {
    return invokeRaw<string>("save_exported_file", { filename, base64Data, openAfter });
  }
  const cleanB64 = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;
  const byteCharacters = atob(cleanB64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const mime = filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".doc") ? "application/msword" : "application/octet-stream";
  const blob = new Blob([byteArray], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
