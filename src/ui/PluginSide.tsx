import { X } from "lucide-react";
import { validWebUrl } from "../kernel/customApps";
import type { PluginPackage } from "../types";

export function PluginSide({ plugin, onClose }: { plugin: PluginPackage | null; onClose: () => void }) {
  if (!plugin) return null;
  const panes = plugin.desktop.filter((bit) => bit.kind === "pane");
  if (!panes.length) return null;
  const page = panes.map((bit) => validWebUrl(bit.target)).find(Boolean) || "";
  const title = panes[0]?.label || plugin.name;
  return (
    <aside className="jobs-panel" data-plugin-panel style={{ width: 320 }}>
      <div className="pane-h">
        <strong>{title}</strong>
        <button type="button" className="screen-x" aria-label={`Close ${plugin.name}`} onClick={onClose}><X size={16} /></button>
      </div>
      {page ? (
        <iframe className="plugin-page" title={title} src={page} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" />
      ) : (
        <div className="pane-b stack">
          <p className="muted">{plugin.name}</p>
          {panes.map((bit) => (
            <article key={`${bit.label}-${bit.target}`} className="tool-card stack">
              <strong>{bit.label}</strong>
              {bit.target ? <span className="muted">{bit.target}</span> : <span className="muted">Side screen</span>}
            </article>
          ))}
          <p className="muted">{plugin.tools.length ? `Tools: ${plugin.tools.map((tool) => tool.name).filter(Boolean).join(", ")}` : "No tools on this screen."}</p>
        </div>
      )}
    </aside>
  );
}
