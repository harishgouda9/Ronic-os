import { useEffect, useState } from "react";
import { enabledFor, mcpEnabledFor, skillTemplate } from "../kernel/skillIndex";
import { useRonic } from "../store";
import { Pill } from "./bits";
import { AppLogo } from "./appLogos";

type Part = "skills" | "plugins" | "mcp";

export function DockCapabilities({ onUseSkill }: { onUseSkill: (slash: string) => void }) {
  const snap = useRonic((s) => s.snap)!;
  const busy = useRonic((s) => s.busy);
  const [part, setPart] = useState<Part>("skills");
  const profile = snap.profiles.find((item) => item.id === snap.activeProfileId) ?? snap.profiles[0];
  const profileId = profile?.id ?? "";

  return (
    <div className="stack">
      <p className="muted">Skills, plugins, and MCP servers for {profile?.handle ?? "this profile"}. Turning one on does not run plugin code.</p>
      <div className="dock-tabs">
        <button type="button" className={part === "skills" ? "btn small" : "btn ghost small"} onClick={() => setPart("skills")}>Skills</button>
        <button type="button" className={part === "plugins" ? "btn small" : "btn ghost small"} onClick={() => setPart("plugins")}>Plugins</button>
        <button type="button" className={part === "mcp" ? "btn small" : "btn ghost small"} onClick={() => setPart("mcp")}>MCP</button>
      </div>
      {part === "skills" ? <SkillsPart profileId={profileId} busy={busy} onUseSkill={onUseSkill} /> : null}
      {part === "plugins" ? <PluginsPart profileId={profileId} busy={busy} /> : null}
      {part === "mcp" ? <McpPart profileId={profileId} busy={busy} /> : null}
    </div>
  );
}

function SkillsPart({ profileId, busy, onUseSkill }: { profileId: string; busy: boolean; onUseSkill: (slash: string) => void }) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const [slug, setSlug] = useState("");
  const [openId, setOpenId] = useState("");
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const rows = snap.skills.filter((skill) => !needle || `${skill.slug} ${skill.title} ${skill.slashCommand}`.toLowerCase().includes(needle));
  const open = rows.find((skill) => skill.id === openId) ?? null;
  const [body, setBody] = useState("");
  useEffect(() => setBody(open?.body ?? ""), [open?.id, open?.body]);

  return (
    <div className="stack">
      <input className="input" placeholder="Filter skills" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        const clean = slug.trim().replace(/^\//, "");
        if (!clean || !profileId) return;
        void run("save_skill", { draft: { id: "", profileId, slug: clean, title: clean, description: clean, slashCommand: `/${clean}`, requiresTools: [], platforms: ["windows", "macos", "linux"], body: skillTemplate(clean), files: [] } });
        setSlug("");
      }}>
        <input className="input" placeholder="New skill name" value={slug} onChange={(event) => setSlug(event.target.value)} />
        <button className="btn small" disabled={busy || !profileId || slug.trim().length === 0}>Create skill</button>
      </form>
      {rows.length === 0 ? <p className="muted">No skills yet.</p> : null}
      {rows.map((skill) => {
        const on = enabledFor(skill.enables, profileId);
        return (
          <article key={skill.id} className="dock-card stack">
            <button type="button" className="between" onClick={() => setOpenId((current) => current === skill.id ? "" : skill.id)}>
              <strong>{skill.slashCommand || skill.slug}</strong>
              <Pill kind={on ? "info" : "warn"}>{on ? "In index" : "Off"}</Pill>
            </button>
            {open?.id === skill.id ? (
              <>
                <p className="muted">{skill.description}</p>
                <textarea className="area" value={body} onChange={(event) => setBody(event.target.value)} />
                <div className="row-actions">
                  <button type="button" className={on ? "btn small" : "btn ghost small"} disabled={busy || !profileId} onClick={() => void run("toggle_skill", { id: skill.id, profileId, enabled: !on })}>{on ? "In index" : "Add to index"}</button>
                  <button type="button" className="btn ghost small" onClick={() => onUseSkill(skill.slashCommand || `/${skill.slug}`)}>Use in chat</button>
                  <button type="button" className="btn small" disabled={busy || !profileId} onClick={() => void run("save_skill", { draft: { id: skill.id, profileId, slug: skill.slug, title: skill.title, description: skill.description, slashCommand: skill.slashCommand, requiresTools: skill.requiresTools, platforms: skill.platforms, body, files: skill.files } })}>Save</button>
                  {skill.origin === "plugin" ? null : <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run("remove_skill", { id: skill.id })}>Delete</button>}
                </div>
              </>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function PluginsPart({ profileId, busy }: { profileId: string; busy: boolean }) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  return (
    <div className="stack">
      <form className="dock-card stack" onSubmit={(event) => {
        event.preventDefault();
        const clean = slug.trim();
        if (!clean) return;
        void run("save_plugin", { draft: { id: "", version: "1.0.0", slug: clean, name: name.trim() || clean, hasAgent: true, hasDesktop: false, tools: [], hooks: ["session_start"], skills: [], desktop: [] } });
        setSlug("");
        setName("");
      }}>
        <label className="field"><span>Folder name</span><input className="input" value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
        <label className="field"><span>Display name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="btn small" disabled={busy || slug.trim().length === 0}>Create plugin</button>
      </form>
      {snap.plugins.length === 0 ? <p className="muted">No plugins yet.</p> : null}
      {snap.plugins.map((plugin) => {
        const on = enabledFor(plugin.agentEnables, profileId);
        return (
          <article key={plugin.id} className="dock-card stack">
            <div className="between">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AppLogo id={plugin.id} name={plugin.name} size={22} />
                <strong>{plugin.name}</strong>
              </div>
              <Pill>{plugin.trust}</Pill>
            </div>
            <p className="muted">{plugin.tools.length} tools · {plugin.source}</p>
            <div className="row-actions">
              {plugin.hasAgent ? <button type="button" className={on ? "btn small" : "btn ghost small"} disabled={busy || !profileId} onClick={() => void run("toggle_plugin_agent", { id: plugin.id, profileId, enabled: !on })}>{on ? "Agent on" : "Agent off"}</button> : null}
              {plugin.trust === "trusted" ? null : <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run("trust_plugin", { id: plugin.id })}>Trust</button>}
              {plugin.source === "builtin" ? null : <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run("remove_plugin", { id: plugin.id })}>Remove</button>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function McpPart({ profileId, busy }: { profileId: string; busy: boolean }) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  return (
    <div className="stack">
      <form className="dock-card stack" onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        const remote = url.trim().startsWith("http");
        void run("save_mcp", { draft: { id: "", name: name.trim(), transport: remote ? "sse" : "stdio", command: remote ? "" : url.trim(), args: [], url: remote ? url.trim() : "", tools: [] } });
        setName("");
        setUrl("");
      }}>
        <label className="field"><span>Server name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field"><span>Command or URL</span><input className="input" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
        <button className="btn small" disabled={busy || name.trim().length === 0}>Add MCP server</button>
      </form>
      <p className="muted">A server can be enabled for this profile. Connecting a session stays off.</p>
      {snap.mcpServers.length === 0 ? <p className="muted">No MCP servers yet.</p> : null}
      {snap.mcpServers.map((server) => {
        const on = mcpEnabledFor(server.enables, profileId);
        return (
          <article key={server.id} className="dock-card stack">
            <div className="between">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AppLogo id={server.id} name={server.name} url={server.url} command={server.command} size={22} />
                <strong>{server.name}</strong>
              </div>
              <Pill>{server.transport}</Pill>
            </div>
            <p className="mono">{server.url || server.command || "No command yet"}</p>
            <div className="row-actions">
              <button type="button" className={on ? "btn small" : "btn ghost small"} disabled={busy || !profileId} onClick={() => void run("toggle_mcp", { id: server.id, profileId, enabled: !on })}>{on ? "On" : "Off"}</button>
              {server.trust === "trusted" ? null : <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run("trust_mcp", { id: server.id })}>Trust</button>}
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run("remove_mcp", { id: server.id })}>Remove</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
