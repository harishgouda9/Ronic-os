import type { DesktopBit, PluginPackage } from "../types";

const PANE = new Set(["pane", "webview", "screen", "side"]);

export function keepDesktop(bits: { kind: string; label: string; target: string }[]): DesktopBit[] {
  const out: DesktopBit[] = [];
  for (const bit of bits) {
    const label = String(bit.label || "").trim();
    if (!label) continue;
    const raw = String(bit.kind || "").trim().toLowerCase();
    const kind = PANE.has(raw) ? "pane" : raw;
    if (kind !== "status" && kind !== "command" && kind !== "pane") continue;
    out.push({ kind, label, target: String(bit.target || "") });
  }
  return out;
}

export function sidePlugins(plugins: PluginPackage[]): PluginPackage[] {
  return plugins.filter((plugin) => plugin.trust === "trusted" && plugin.desktopEnabled && plugin.desktop.some((bit) => bit.kind === "pane"));
}
