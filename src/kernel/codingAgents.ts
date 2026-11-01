export interface ModifiedFile {
  path: string;
  additions: number;
  deletions: number;
  staged: boolean;
  diff: string;
}

export function filesFromPayload(payload: unknown): ModifiedFile[] | null {
  if (!payload || typeof payload !== "object") return null;
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  return files.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<ModifiedFile>;
    if (typeof row.path !== "string" || row.path.length === 0) return [];
    return [{
      path: row.path,
      additions: Number(row.additions) || 0,
      deletions: Number(row.deletions) || 0,
      staged: Boolean(row.staged),
      diff: typeof row.diff === "string" ? row.diff : "",
    }];
  });
}

function payloadFlag(payload: unknown, key: "opened"): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>)[key] === true);
}

function payloadExit(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { exitCode?: unknown }).exitCode;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function dispatchOutput(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const output = (payload as { output?: unknown }).output;
  return typeof output === "string" ? output : "";
}

/**
 * A desktop build that only opens Cursor or VS Code used to return an empty
 * file list. Keep the tree already on screen in that case. A real status,
 * a finished program (exitCode), or an open that includes `opened` replaces it.
 */
export function filesAfterDispatch(previous: ModifiedFile[], payload: unknown): ModifiedFile[] {
  const next = filesFromPayload(payload);
  if (!next) return previous;
  if (next.length === 0 && payloadExit(payload) == null && !payloadFlag(payload, "opened")) return previous;
  return next;
}

export function clampFileIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

export function indexAfterRefresh(previous: ModifiedFile[], next: ModifiedFile[], current: number): number {
  const currentPath = previous[current]?.path;
  if (currentPath) {
    const found = next.findIndex((file) => file.path === currentPath);
    if (found >= 0) return found;
  }
  return clampFileIndex(current, next.length);
}

export function ideToOpen(active: string, ready: { cursor: boolean; vscode: boolean }): "cursor" | "vscode" {
  if (active === "vscode" && ready.vscode) return "vscode";
  if (active === "cursor" && ready.cursor) return "cursor";
  if (ready.cursor) return "cursor";
  if (ready.vscode) return "vscode";
  return active === "vscode" ? "vscode" : "cursor";
}
