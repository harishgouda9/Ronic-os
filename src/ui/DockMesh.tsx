import { useEffect, useState } from "react";
import { invokeRaw, isTauri } from "../api";

type MeshLite = {
  codeModeOn: boolean;
  mcpEndpoint: string;
  note: string;
};

type TunnelLite = {
  running: boolean;
  publicMcpUrl: string;
  note: string;
};

const WEB_MCP = new Set(["chatgpt", "claude", "grok"]);
const DESK_MCP = new Set(["cursor", "vscode", "claude-code"]);

export function dockSpeaksMcp(kind: "web" | "desktop", id: string) {
  return kind === "web" ? WEB_MCP.has(id) : DESK_MCP.has(id);
}

export async function connectDockTile(id: string, kind: "web" | "desktop"): Promise<string> {
  if (!isTauri()) {
    throw new Error("MCP connect for Dock apps runs in the desktop app.");
  }
  return invokeRaw<string>("connect_dock_app", { id, kind });
}

export function DockMesh({ side }: { side: "web" | "desktop" }) {
  const desktop = isTauri();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeOn, setCodeOn] = useState(true);
  const [endpoint, setEndpoint] = useState("");

  useEffect(() => {
    const onNote = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) setNote(detail);
    };
    window.addEventListener("ronic-dock-mesh", onNote);
    return () => window.removeEventListener("ronic-dock-mesh", onNote);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let gone = false;
    invokeRaw<MeshLite>("mesh_status")
      .then((next) => {
        if (gone) return;
        setCodeOn(next.codeModeOn);
        setEndpoint(next.mcpEndpoint || "");
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [desktop, side]);

  async function connectSide() {
    if (!desktop) return;
    setBusy(true);
    try {
      if (side === "desktop") {
        const next = await invokeRaw<MeshLite>("mesh_connect_all");
        setCodeOn(next.codeModeOn);
        setEndpoint(next.mcpEndpoint || "");
        setNote(next.note || "Cursor, VS Code, and Claude Code now have the local Ronic OS MCP server. Restart one that was already open. Code Mode uses ronic.apps.desktop.");
      } else {
        const tunnel = await invokeRaw<TunnelLite>("mesh_tunnel_start");
        setNote(
          tunnel.publicMcpUrl
            ? `Web apps do not speak MCP on localhost. Paste this URL into ChatGPT, Claude, or Grok connector settings: ${tunnel.publicMcpUrl}`
            : tunnel.note || "The public tunnel did not start. Web apps cannot fetch MCP until it has a public URL.",
        );
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const where = endpoint ? endpoint.replace("http://127.0.0.1", "localhost") : "";
  const hint = side === "web"
    ? "MCP on ChatGPT, Claude, or Grok opens that site's connector. A login is not an MCP connection. Code Mode drives an open tile with ronic.apps.web."
    : "Connect MCP writes Cursor, VS Code, and Claude Code. Obsidian and Ollama do not speak MCP. Code Mode drives these apps with ronic.apps.desktop.";

  return (
    <div className="dock-mesh">
      <div className="between">
        <span className="muted" title={endpoint || "MCP bridge"}>{codeOn ? "Code Mode on" : "Code Mode off"}{where ? ` · ${where}` : ""}</span>
        <button type="button" className="btn ghost small" disabled={!desktop || busy} onClick={() => void connectSide()}>
          {busy ? "Working…" : side === "desktop" ? "Connect MCP" : "MCP URL"}
        </button>
      </div>
      <p className="muted">{note || hint}</p>
    </div>
  );
}
